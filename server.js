'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const IDLE_TTL_MS = 60 * 60 * 1000;       // lobby deleted after 1 h with no game running (or as soon as it's empty)
const MAX_GAME_MS = 6 * 3600 * 1000;      // safety cap for a single running round
const STALE_MS = 45 * 1000;

const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(lobbies) {
  let c;
  do { c = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (lobbies.has(c));
  return c;
}
const FEATURES = ['decoy', 'chime', 'bounty', 'cam', 'compass'];
const DEFAULT_GAME_SEC = clampNum0(process.env.GAME_MIN, 0.5, 360, 20) * 60; // dev/test: GAME_MIN=2 node server.js
function clampNum0(v, lo, hi, d) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
// ---- geo helpers (metres) ----
const R_EARTH = 6371000, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function distM(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearingDeg(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function offsetM(p, dist, brg) {
  const d = dist / R_EARTH, th = rad(brg), la1 = rad(p.lat), lo1 = rad(p.lng);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(th));
  const lo2 = lo1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: deg(la2), lng: ((deg(lo2) + 540) % 360) - 180 };
}
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const band = m => m < 25 ? 'scorching' : m < 75 ? 'hot' : m < 150 ? 'warm' : m < 300 ? 'cool' : 'cold';
const clampNum = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };

function createApp(opts = {}) {
  const now = opts.now || (() => Date.now());
  const minSec = opts.minSec ?? 1; // tests can use fractional seconds
  const lobbies = new Map();
  const app = express();
  app.set('trust proxy', true);
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
  app.get('/healthz', (req, res) => res.json({ ok: true, lobbies: lobbies.size }));
  app.get('/j/:code', (req, res) => res.redirect('/?code=' + encodeURIComponent(req.params.code.toUpperCase())));
  app.get('/qr/:code.svg', async (req, res) => {
    const url = `${req.protocol}://${req.get('host')}/j/${encodeURIComponent(req.params.code.toUpperCase())}`;
    res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1 }));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  function newLobby() {
    const code = makeCode(lobbies);
    const L = {
      code, createdAt: now(), hostId: null, players: new Map(), state: 'lobby',
      settings: { gameSec: opts.gameSec || DEFAULT_GAME_SEC, pingSec: 60, hideSec: 120, caughtBecomeHunter: true, showRevealed: true,
        features: Object.fromEntries(FEATURES.map(f => [f, true])) },
      bounty: null, photos: {}, camAt: 0, compassAt: 0, nextBountyAt: 0, nextCompassAt: 0,
      startedAt: 0, hideEndsAt: 0, endsAt: 0, nextPingAt: 0, pings: [], winner: null, endedAt: 0, events: [], idleSince: now(), round: 0,
    };
    lobbies.set(code, L);
    return L;
  }

  function addPlayer(L, name) {
    const p = { id: rid(6), token: rid(16), name: String(name || 'Player').trim().slice(0, 20) || 'Player',
      role: 'hider', caught: false, caughtAt: 0, ws: null, loc: null, perm: 'unknown', connected: false, revealedAt: 0,
      cam: 'unknown', decoys: 2, decoyArmed: false, wipeNext: false };
    if (!L.hostId) { L.hostId = p.id; p.role = 'hunter'; }
    L.players.set(p.id, p);
    return p;
  }

  const isHunter = p => p.role === 'hunter';
  const activeHiders = L => [...L.players.values()].filter(p => p.role === 'hider' && !p.caught);

  // ---- The privacy core: build a view for ONE player. Hider coordinates are only ever
  // included for hunters via L.pings (snapshots taken at ping time), never p.loc.
  function viewFor(L, me) {
    const t = now();
    const ended = L.state === 'ended';
    const players = [...L.players.values()].map(p => {
      const o = { id: p.id, name: p.name, role: p.role, caught: p.caught, caughtAt: p.caughtAt, connected: p.connected, perm: p.perm,
        host: p.id === L.hostId, cam: p.cam, acc: p.loc ? Math.round(p.loc.acc) : null,
        stale: !p.loc || (t - p.loc.recvAt) > STALE_MS };
      const canSeeLive = p.id === me.id ||
        (isHunter(me) && isHunter(p) && L.state !== 'lobby') ;
      if (canSeeLive && p.loc) o.loc = { lat: p.loc.lat, lng: p.loc.lng, acc: p.loc.acc, ts: p.loc.ts };
      return o;
    });
    const v = { type: 'state', code: L.code, you: me.id, host: L.hostId, state: L.state, settings: L.settings,
      serverNow: t, startedAt: L.startedAt, hideEndsAt: L.hideEndsAt, endsAt: L.endsAt, nextPingAt: L.nextPingAt,
      winner: L.winner, players, pingCount: L.pings.length, events: L.events.slice(-8) };
    v.round = L.round; v.camAt = L.camAt; v.compassAt = L.compassAt;
    v.compass = inCompass(L);
    if (L.bounty && L.settings.features.bounty) v.bounty = { id: L.bounty.id, lat: L.bounty.lat, lng: L.bounty.lng, t: L.bounty.t, radius: 15 };
    if (me.role === 'hider') { v.decoys = me.decoys; v.decoyArmed = me.decoyArmed; v.cloaked = me.wipeNext; }
    if (isHunter(me) && L.state !== 'lobby') v.photos = Object.fromEntries(Object.entries(L.photos).map(([id, ph]) => [id, { name: ph.name, pending: ph.pending, unavailable: ph.unavailable, has: !!ph.data }])); // hunters only; image bytes go via camPeek
    if (isHunter(me) && L.state === 'playing' || ended) {
      if (ended) v.pings = L.pings.map(pg => ({ t: pg.t, locs: pg.locs, out: pg.out, decoys: pg.decoys, hidden: pg.hidden })); // full trails only in the end summary
      else { // during play: just each hider's most recent ping snapshot (small payload)
        const last = {};
        for (const pg of L.pings) { for (const [id, l] of Object.entries(pg.locs)) if (l) last[id] = { ...l, t: pg.t }; for (const id of pg.hidden || []) delete last[id]; }
        v.last = last;
      }
    } else if (me.role === 'hider' && L.settings.showRevealed) {
      v.revealedAt = me.revealedAt;
    }
    return v;
  }

  function broadcast(L) { for (const p of L.players.values()) if (p.ws) send(p.ws, viewFor(L, p)); }
  function event(L, text) { L.events.push({ t: now(), text }); }

  const scale = L => L.settings.gameSec / 1200; // feature timings scale with game length (20 min = 1.0)
  const inCompass = L => L.state === 'playing' && L.settings.features.compass && L.compassAt > 0 && now() >= L.compassAt;

  // scheduled: a regular cycle ping (decoys / wipes / chimes apply). Out-of-cycle (bounty) pings are always real.
  function doPing(L, { scheduled = true, final = false } = {}) {
    const t = now(), F = L.settings.features;
    const locs = {}, decoys = [], hidden = [], chimed = [];
    const hunters = [...L.players.values()].filter(p => isHunter(p) && p.loc);
    for (const h of activeHiders(L)) {
      if (scheduled && !final && h.wipeNext) { h.wipeNext = false; locs[h.id] = null; hidden.push(h.id); continue; }
      if (!h.loc) { locs[h.id] = null; continue; }
      let pos = { lat: h.loc.lat, lng: h.loc.lng };
      if (scheduled && !final && h.decoyArmed) { h.decoyArmed = false; pos = offsetM(pos, rnd(30, 150), rnd(0, 360)); decoys.push(h.id); }
      locs[h.id] = { lat: pos.lat, lng: pos.lng, acc: h.loc.acc, ts: h.loc.ts, age: t - h.loc.recvAt }; h.revealedAt = t;
      if (scheduled && !final && F.chime && hunters.some(x => distM(x.loc, h.loc) <= 40)) chimed.push(h);
    }
    L.pings.push({ t, locs, out: !scheduled, decoys, hidden });
    if (scheduled) L.nextPingAt = t + L.settings.pingSec * 1000;
    for (const p of L.players.values()) send(p.ws, { type: 'ping', t, n: L.pings.length, out: !scheduled, ...(isHunter(p) ? { locs, hidden } : {}) });
    for (const h of chimed) send(h.ws, { type: 'chime' });
    if (chimed.length) for (const p of L.players.values()) if (isHunter(p)) send(p.ws, { type: 'chimeNearby', n: chimed.length });
  }

  function spawnBounty(L, at) {
    const pts = [...L.players.values()].filter(p => p.loc && !(p.role === 'hider' && p.caught)).map(p => p.loc);
    if (!at && !pts.length) { L.bounty = null; return; }
    const c = at || { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
    const pos = at || offsetM(c, rnd(50, 250), rnd(0, 360));
    L.bounty = { id: rid(4), lat: pos.lat, lng: pos.lng, t: now() };
    event(L, '💰 A bounty appeared on the map!');
  }
  function tryClaim(L, p) {
    const b = L.bounty;
    if (!b || !p.loc || L.state !== 'playing' || !L.settings.features.bounty || (p.role === 'hider' && p.caught)) return false;
    if (distM(p.loc, b) > 15) return false;
    L.bounty = null;
    if (isHunter(p)) {
      event(L, `💰 ${p.name} grabbed the bounty — surprise ping!`);
      send(p.ws, { type: 'bounty', effect: 'ping' });
      if (!inCompass(L)) doPing(L, { scheduled: false });
    } else {
      p.wipeNext = true; event(L, '💰 The bounty was claimed');
      send(p.ws, { type: 'bounty', effect: 'wipe' });
    }
    return true;
  }
  function requestPhotos(L) {
    for (const h of activeHiders(L)) {
      if (h.cam === 'granted' && h.ws && h.connected) { L.photos[h.id] = { name: h.name, pending: true, t: now() }; send(h.ws, { type: 'camRequest' }); }
      else L.photos[h.id] = { name: h.name, unavailable: true, t: now() };
      relayPhoto(L, h.id);
    }
    L.camDeadline = now() + Math.max(3000, 15000 * Math.min(1, scale(L) * 4));
  }
  function expirePhotos(L) {
    L.camDeadline = 0;
    for (const [id, ph] of Object.entries(L.photos)) if (ph.pending) { L.photos[id] = { name: ph.name, unavailable: true, t: now() }; relayPhoto(L, id); }
  }
  function relayPhoto(L, id) { for (const p of L.players.values()) if (isHunter(p)) send(p.ws, { type: 'camPeek', id, ...L.photos[id] }); }
  function sendCompass(L) {
    const hs = activeHiders(L).filter(h => h.loc);
    for (const p of L.players.values()) {
      if (!isHunter(p) || !p.ws) continue;
      if (!p.loc || !hs.length) { send(p.ws, { type: 'compass', none: true }); continue; }
      let best = null, bd = Infinity;
      for (const h of hs) { const d = distM(p.loc, h.loc); if (d < bd) { bd = d; best = h; } }
      send(p.ws, { type: 'compass', bearing: Math.round(bearingDeg(p.loc, best.loc)), band: band(bd) }); // never coordinates
    }
  }

  function endGame(L, winner) {
    if (L.state === 'ended') return;
    if (L.state === 'playing' && winner === 'hiders') doPing(L, { final: true }); // final reveal
    expirePhotos(L);
    L.state = 'ended'; L.winner = winner; L.endedAt = now(); L.idleSince = now(); L.nextPingAt = 0;
    event(L, winner === 'hiders' ? 'Time up — hiders win!' : 'Everyone caught — hunters win!');
    broadcast(L);
  }

  function tick() {
    const t = now();
    for (const L of lobbies.values()) {
      const running = L.state === 'playing' || L.state === 'hiding';
      if (L.players.size === 0 || (!running && t - L.idleSince > IDLE_TTL_MS) || (running && t - L.startedAt > MAX_GAME_MS)) {
        for (const p of L.players.values()) { send(p.ws, { type: 'gone' }); }
        lobbies.delete(L.code); // all locations dropped with it
        continue;
      }
      if (L.state === 'hiding' && t >= L.hideEndsAt) { L.state = 'playing'; L.nextPingAt = t + L.settings.pingSec * 1000; event(L, 'Hunt is on!'); broadcast(L); }
      if (L.state === 'playing') {
        if (t >= L.endsAt) { endGame(L, 'hiders'); continue; }
        const F = L.settings.features;
        if (inCompass(L)) {
          if (L.bounty) L.bounty = null;
          if (!L.compassAnnounced) { L.compassAnnounced = true; L.nextPingAt = 0; event(L, '🧭 SUDDEN DEATH — map pings stop, hunters get a compass!'); broadcast(L); }
          if (t >= L.nextCompassAt) { L.nextCompassAt = t + Math.max(100, Math.min(2000, 2000 * scale(L) * 4)); sendCompass(L); }
        } else if (t >= L.nextPingAt) { doPing(L); broadcast(L); }
        if (F.bounty && !inCompass(L) && L.nextBountyAt && t >= L.nextBountyAt) {
          L.nextBountyAt = t + 300 * scale(L) * 1000; spawnBounty(L);
          for (const p of L.players.values()) tryClaim(L, p);
          broadcast(L);
        }
        if (F.cam && L.camAt && t >= L.camAt) { L.camAt = 0; requestPhotos(L); broadcast(L); }
        if (L.camDeadline && t >= L.camDeadline) { expirePhotos(L); broadcast(L); }
      }
    }
  }
  const timer = setInterval(tick, opts.tickMs || 200);

  function catchHider(L, h, by) {
    if (!h || h.role !== 'hider' || h.caught || !(L.state === 'playing' || L.state === 'hiding')) return;
    h.caught = true; h.caughtAt = now();
    event(L, `${h.name} was caught${by ? ' by ' + by.name : ''}`);
    if (L.settings.caughtBecomeHunter) h.role = 'hunter';
    if (activeHiders(L).length === 0) endGame(L, 'hunters'); else broadcast(L);
  }

  function resetFeatures(L, ps) {
    L.bounty = null; L.photos = {}; L.camAt = L.compassAt = L.nextBountyAt = L.nextCompassAt = L.camDeadline = 0; L.compassAnnounced = false;
    for (const p of ps) { p.decoys = 2; p.decoyArmed = false; p.wipeNext = false; }
  }
  function rematch(L) {
    if (L.state !== 'ended') return;
    L.state = 'lobby'; L.pings = []; L.winner = null; L.events = []; L.startedAt = L.hideEndsAt = L.endsAt = L.nextPingAt = L.endedAt = 0;
    L.idleSince = now(); resetFeatures(L, [...L.players.values()]);
    for (const p of L.players.values()) { p.caught = false; p.caughtAt = 0; p.revealedAt = 0; if (p.startRole) p.role = p.startRole; }
    broadcast(L);
  }

  function leave(L, p) {
    if (!L.players.has(p.id)) return;
    L.players.delete(p.id);
    send(p.ws, { type: 'left' }); p.ws = null;
    if (L.players.size === 0) { lobbies.delete(L.code); return; }
    if (L.hostId === p.id) {
      const next = [...L.players.values()].find(x => x.connected) || L.players.values().next().value;
      L.hostId = next.id; event(L, `${p.name} left — ${next.name} is now host`);
    } else event(L, `${p.name} left`);
    if (L.state === 'playing' || L.state === 'hiding') {
      const ps = [...L.players.values()];
      if (!activeHiders(L).length) return endGame(L, 'hunters');
      if (!ps.some(isHunter)) return endGame(L, 'hiders');
    }
    broadcast(L);
  }

  wss.on('connection', ws => {
    let L = null, me = null;
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!me) {
        if (m.type === 'create') { L = newLobby(); me = addPlayer(L, m.name); }
        else if (m.type === 'join') {
          L = lobbies.get(String(m.code || '').toUpperCase());
          if (!L) return send(ws, { type: 'error', error: 'Lobby not found' });
          me = addPlayer(L, m.name);
          if (L.state === 'playing' || L.state === 'hiding') me.role = 'hunter'; // late joiners hunt (can't be fairly hidden)
        } else if (m.type === 'rejoin') {
          L = lobbies.get(String(m.code || '').toUpperCase());
          me = L && [...L.players.values()].find(p => p.token === m.token);
          if (!me) { L = null; return send(ws, { type: 'error', error: 'Session expired', reset: true }); }
          if (me.ws && me.ws !== ws) try { me.ws.close(); } catch {}
        } else return;
        me.ws = ws; me.connected = true;
        send(ws, { type: 'joined', code: L.code, id: me.id, token: me.token });
        broadcast(L);
        if (isHunter(me) && L.state !== 'lobby') for (const [id, ph] of Object.entries(L.photos)) send(ws, { type: 'camPeek', id, ...ph });
        return;
      }
      const host = me.id === L.hostId;
      switch (m.type) {
        case 'loc': {
          const lat = Number(m.lat), lng = Number(m.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
          const first = !me.loc;
          me.loc = { lat, lng, acc: clampNum(m.acc, 0, 1e5, 999), ts: Number(m.ts) || now(), recvAt: now() };
          if (me.ws) {}
          // Only hunters' live positions are pushed; hider updates trigger no broadcast with coords.
          if (tryClaim(L, me)) broadcast(L);
          else if (first || me.perm !== 'granted') { me.perm = 'granted'; broadcast(L); }
          else if (isHunter(me) && L.state !== 'lobby') broadcast(L);
          else send(ws, viewFor(L, me));
          break;
        }
        case 'perm': me.perm = ['granted', 'denied', 'prompt', 'unsupported', 'error'].includes(m.perm) ? m.perm : 'unknown'; broadcast(L); break;
        case 'settings': if (host && L.state === 'lobby') {
          const s = m.settings || {};
          L.settings.gameSec = clampNum(s.gameSec, minSec * 2, 6 * 3600, L.settings.gameSec);
          L.settings.pingSec = clampNum(s.pingSec, minSec, 3600, L.settings.pingSec);
          L.settings.hideSec = clampNum(s.hideSec, 0, 3600, L.settings.hideSec);
          if ('caughtBecomeHunter' in s) L.settings.caughtBecomeHunter = !!s.caughtBecomeHunter;
          if ('showRevealed' in s) L.settings.showRevealed = !!s.showRevealed;
          if (s.features && typeof s.features === 'object') for (const f of FEATURES) if (f in s.features) L.settings.features[f] = !!s.features[f];
          broadcast(L);
        } break;
        case 'role': if (host && L.state === 'lobby') { const p = L.players.get(m.id); if (p && ['hunter', 'hider'].includes(m.role)) p.role = m.role; broadcast(L); } break;
        case 'randomize': if (host && L.state === 'lobby') {
          const ps = [...L.players.values()]; const n = Math.max(1, Math.min(ps.length - 1, Number(m.hunters) || 1));
          for (let i = ps.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ps[i], ps[j]] = [ps[j], ps[i]]; }
          ps.forEach((p, i) => p.role = i < n ? 'hunter' : 'hider'); broadcast(L);
        } break;
        case 'kick': if (host && L.state === 'lobby' && m.id !== me.id) { const p = L.players.get(m.id); if (p) { send(p.ws, { type: 'gone', kicked: true }); L.players.delete(m.id); broadcast(L); } } break;
        case 'start': if (host && L.state === 'lobby') {
          const ps = [...L.players.values()];
          if (!ps.some(isHunter) || !ps.some(p => p.role === 'hider')) return send(ws, { type: 'error', error: 'Need at least 1 hunter and 1 hider' });
          const t = now(); L.startedAt = t; L.hideEndsAt = t + L.settings.hideSec * 1000;
          L.endsAt = L.hideEndsAt + L.settings.gameSec * 1000;
          L.state = L.settings.hideSec > 0 ? 'hiding' : 'playing'; L.round++; L.pings = []; L.events = [];
          for (const p of ps) { p.startRole = p.role; p.caught = false; p.caughtAt = 0; p.revealedAt = 0; }
          resetFeatures(L, ps);
          { const sc = scale(L) * 1000, h = L.hideEndsAt;
            L.nextBountyAt = h + 300 * sc; L.camAt = h + 600 * sc; L.compassAt = h + 1080 * sc; L.nextCompassAt = 0; }
          if (L.state === 'playing') L.nextPingAt = t + L.settings.pingSec * 1000;
          else L.nextPingAt = L.hideEndsAt + L.settings.pingSec * 1000;
          event(L, L.state === 'hiding' ? 'Hiders, go hide!' : 'Hunt is on!');
          broadcast(L);
        } break;
        case 'cam': me.cam = ['granted', 'denied'].includes(m.cam) ? m.cam : 'unknown'; broadcast(L); break;
        case 'decoy': if (me.role === 'hider' && !me.caught && L.settings.features.decoy && (L.state === 'playing' || L.state === 'hiding') && !inCompass(L) && me.decoys > 0 && !me.decoyArmed) {
          me.decoys--; me.decoyArmed = true; send(ws, viewFor(L, me)); } break;
        case 'claim': if (tryClaim(L, me)) broadcast(L); break;
        case 'camPhoto': { const ph = L.photos[me.id];
          if (!ph || !ph.pending || me.role !== 'hider') break;
          const ok = typeof m.data === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(m.data) && m.data.length < 600000;
          L.photos[me.id] = ok && !m.unavailable ? { name: me.name, data: m.data, t: now() } : { name: me.name, unavailable: true, t: now() }; // memory only
          relayPhoto(L, me.id); broadcast(L); } break;
        case 'catch': if (isHunter(me)) catchHider(L, L.players.get(m.id), me); break;
        case 'caughtSelf': if (me.role === 'hider') catchHider(L, me, null); break;
        case 'end': if (host && L.state !== 'ended' && L.state !== 'lobby') endGame(L, activeHiders(L).length ? 'hiders' : 'hunters'); break;
        case 'sync': send(ws, viewFor(L, me)); break;
        case 'rematch': rematch(L); send(ws, viewFor(L, me)); break;
        case 'leave': leave(L, me); me = null; L = null; break;
      }
    });
    ws.on('close', () => { if (me && L && me.ws === ws) { me.ws = null; me.connected = false; if (lobbies.has(L.code)) broadcast(L); } });
  });

  // keepalive so tunnels don't drop idle sockets
  wss.on('connection', ws => { ws.alive = true; ws.on('pong', () => ws.alive = true); });
  const hb = setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; try { c.ping(); } catch {} }), 20000);
  server.on('close', () => { clearInterval(timer); clearInterval(hb); });
  return { app, server, wss, lobbies, tick, spawnBounty, distM };
}

module.exports = { createApp, distM, bearingDeg, offsetM };
if (require.main === module) {
  const { server } = createApp();
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log('Scram listening on :' + port));
}
