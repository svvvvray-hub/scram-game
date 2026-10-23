'use strict';
// Growth stats + brake settings, persisted to a JSON file with throttled writes. Players are counted by an
// anonymous random device id (hashed before storage). Exception: social handles players chose to enter
// ({handle, platform}) are kept in `handles`, keyed "platform:handle" (admin-only; disclosed in the privacy policy).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const Socials = require('./public/socials');
const day = t => new Date(t).toISOString().slice(0, 10);
const HANDLE_RE = /^[a-z0-9._-]{1,30}$/;
// generic handle (refs): strip @, lowercase, [a-z0-9._-]{1,30}
const normHandle = v => { if (typeof v !== 'string') return null; const h = v.trim().replace(/^@/, '').toLowerCase(); return HANDLE_RE.test(h) ? h : null; };
// saved entries from before platforms existed are keyed by the bare handle: they were Instagram
function migrateHandles(hs) { const out = {};
  for (const [k, r] of Object.entries(hs || {})) { if (!r || typeof r !== 'object') continue;
    const platform = Socials.isPlatform(r.platform) ? r.platform : k.includes(':') && Socials.isPlatform(k.split(':')[0]) ? k.split(':')[0] : 'instagram';
    const handle = r.handle || (k.includes(':') ? k.slice(k.indexOf(':') + 1) : k), nk = platform + ':' + String(handle).toLowerCase();
    const prev = out[nk]; out[nk] = prev ? { ...prev, first: prev.first < r.first ? prev.first : r.first, last: prev.last > r.last ? prev.last : r.last, games: (prev.games || 0) + (r.games || 0), ref: prev.ref || r.ref || null }
      : { handle, platform, first: r.first, last: r.last, games: r.games || 0, ref: r.ref || null }; }
  return out; }
const hashId = s => crypto.createHash('sha256').update('lastping:' + s).digest('hex').slice(0, 16);

function createStats({ file, now = () => Date.now(), throttleMs = 5000, maxGames = 50, persist = null } = {}) {
  const blank = () => ({ v: 1, days: {}, devices: {}, refs: {}, handles: {}, playClicks: 0, shares: {}, totals: { games: 0, started: 0, players: 0, blocked: 0 },
    settings: { paused: false, maxGames, maxPerHour: 0 }, recentCreates: [], polls: {}, pollTotals: { created: 0, votes: 0, locked: 0 } });
  const shape = j => { const b = blank(); return { ...b, ...j, totals: { ...b.totals, ...j.totals }, settings: { ...b.settings, ...j.settings }, pollTotals: { ...b.pollTotals, ...j.pollTotals } }; };
  const readFile = () => { try { return shape(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; } };
  // with a remote store (Supabase) the data is loaded asynchronously by persist.start() -> adopt(); the file is only a one-time import source
  let d = (!persist && file && readFile()) || blank();
  d.handles = migrateHandles(d.handles); d.v = 2;
  let timer = null, dirty = false, settingsChanged = false, lastSaveAt = 0, lastError = null;
  function flush() { timer = null; if (persist) return persist.flush(); if (!file || !dirty) return; dirty = false;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, file); lastSaveAt = now(); lastError = null; }
    catch (e) { lastError = e.message; console.error('[stats] write failed', e.message); } }
  function touch() { dirty = true; if (persist) return persist.schedule(); if (!timer && file) { timer = setTimeout(flush, throttleMs); timer.unref?.(); } }
  // Merge data loaded from the remote store into memory. Normally memory is still blank (load finishes before listen), so this
  // just adopts the remote data; if the load was late (Supabase was down at startup) local activity is added on top, not lost.
  function adopt(remote, { skipHandles = new Set() } = {}) {
    const L = d, hasRemote = !!remote.kv.stats;
    const R = shape(hasRemote ? remote.kv.stats : (file && readFile()) || {}); // first run on an empty project: import STATS_FILE once if present
    if (!hasRemote && file && R.handles) for (const [k, v] of Object.entries(migrateHandles(R.handles))) remote.handles[k] ||= v;
    if (!hasRemote && file && R.polls) for (const [k, v] of Object.entries(R.polls)) remote.polls[k] ||= v;
    const sum = (a = {}, b = {}) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = (Number(o[k]) || 0) + (Number(v) || 0); return o; };
    const out = { ...R, v: 2 };
    out.playClicks = (R.playClicks || 0) + (L.playClicks || 0);
    out.totals = sum(R.totals, L.totals); out.shares = sum(R.shares, L.shares); out.pollTotals = sum(R.pollTotals, L.pollTotals);
    out.refs = { ...R.refs }; for (const [k, v] of Object.entries(L.refs)) out.refs[k] = sum(out.refs[k], v);
    out.days = { ...R.days }; for (const [k, v] of Object.entries(L.days)) { const r = out.days[k];
      out.days[k] = r ? { games: r.games + v.games, started: r.started + v.started, newPlayers: r.newPlayers + v.newPlayers, players: [...new Set([...(r.players || []), ...v.players])] } : v; }
    out.devices = { ...R.devices }; for (const [k, v] of Object.entries(L.devices)) { if (out.devices[k]) out.totals.players = Math.max(0, out.totals.players - 1); else out.devices[k] = v; }
    out.recentCreates = [...(R.recentCreates || []), ...L.recentCreates];
    out.settings = settingsChanged ? L.settings : shape({ settings: remote.kv.settings || R.settings }).settings;
    const H = migrateHandles(remote.handles); for (const k of skipHandles) delete H[k];
    for (const [k, r] of Object.entries(L.handles)) { const p = H[k];
      H[k] = p ? { ...p, first: p.first < r.first ? p.first : r.first, last: p.last > r.last ? p.last : r.last, handle: r.handle, games: (p.games || 0) + (r.games || 0), ref: p.ref || r.ref || null } : r; }
    out.handles = H; out.polls = { ...remote.polls, ...L.polls };
    for (const k of Object.keys(d)) delete d[k]; Object.assign(d, out); // keep the same object (polls/admin hold stats.data())
  }
  if (persist) persist.attach({ data: () => d, adopt });
  const today = () => { const k = day(now()); return d.days[k] ||= { games: 0, started: 0, players: [], newPlayers: 0 }; };
  const refRow = r => d.refs[r] ||= { players: 0, games: 0, visits: 0 };
  function player(dev, ref) { // returns hashed id; counts unique/day and first-seen referrer
    if (!dev || typeof dev !== 'string') return null;
    const h = hashId(dev.slice(0, 64)), D = today();
    if (!D.players.includes(h)) D.players.push(h);
    if (!d.devices[h]) { d.devices[h] = { first: day(now()), ref: ref || null }; d.totals.players++; D.newPlayers++; if (ref) refRow(ref).players++; }
    touch(); return h;
  }
  // Social handle seen (join/create/edit). raw: {handle, platform} or a legacy string (= Instagram). played=true counts a game.
  // Dedup by platform + case-insensitive handle. Returns the handle or null.
  function handle(raw, { ref = null, played = false } = {}) {
    const so = Socials.norm(raw); if (!so) return null; const t = new Date(now()).toISOString(), k = Socials.key(so);
    const r = d.handles[k] ||= { handle: so.handle, platform: so.platform, first: t, last: t, games: 0, ref: normHandle(ref || '') };
    r.last = t; r.handle = so.handle; if (!r.ref && ref) r.ref = normHandle(ref); if (played) r.games++; touch(); return so.handle;
  }
  function deleteHandle(platform, h) { const so = Socials.norm({ handle: h, platform }), k = so ? Socials.key(so) : String(platform) + ':' + String(h).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(d.handles, k)) return false; delete d.handles[k]; persist?.forgetHandle(k); touch(); flush(); return true; }
  const handleList = (sort = 'last', platform = null) => Object.values(d.handles).filter(r => !platform || r.platform === platform).map(r => ({ ...r, url: Socials.url(r) }))
    .sort(sort === 'games' ? (a, b) => b.games - a.games || b.last.localeCompare(a.last) : (a, b) => b.last.localeCompare(a.last) || b.games - a.games);
  const platformCounts = () => { const c = {}; for (const r of Object.values(d.handles)) c[r.platform] = (c[r.platform] || 0) + 1; return c; };
  return {
    data: () => d, flush, touch, persist,
    ready: persist ? null : Promise.resolve(true),
    fetchPoll: persist ? code => persist.fetchPoll(code) : null,
    close: () => persist ? persist.close() : flush(),
    // storage status line for /admin (never includes keys)
    storageStatus: () => persist ? persist.status() : { mode: file ? 'file' : 'memory', file: file ? path.basename(file) : null, connected: false, lastSaveAt: lastSaveAt || null, lastError }, handle, handleList, deleteHandle, platformCounts,
    player,
    gameCreated(dev, ref) { const h = player(dev, ref); d.totals.games++; today().games++; const r = (h && d.devices[h].ref) || ref; if (r) refRow(r).games++; d.recentCreates.push(now()); touch(); },
    gameStarted() { d.totals.started++; today().started++; touch(); },
    visit(ref) { refRow(ref).visits++; touch(); },
    playClick() { d.playClicks++; touch(); },
    share(kind) { if (!/^[a-z]{2,16}$/.test(kind)) return false; d.shares[kind] = (d.shares[kind] || 0) + 1; touch(); return true; },
    // brake: returns null if a new game may be created, else a reason
    canCreate(live) { const s = d.settings, t = now(); d.recentCreates = d.recentCreates.filter(x => x > t - 3600e3);
      const why = s.paused ? 'paused' : (s.maxGames > 0 && live >= s.maxGames) ? 'max' : (s.maxPerHour > 0 && d.recentCreates.length >= s.maxPerHour) ? 'hourly' : null;
      if (why) { d.totals.blocked++; touch(); } return why; },
    setSettings(p) { const s = d.settings, n = (v, dv) => { v = Math.round(Number(v)); return Number.isFinite(v) && v >= 0 ? Math.min(v, 100000) : dv; };
      if ('paused' in p) s.paused = p.paused === true || p.paused === 'true' || p.paused === 'on' || p.paused === '1';
      if ('maxGames' in p) s.maxGames = n(p.maxGames, s.maxGames);
      if ('maxPerHour' in p) s.maxPerHour = n(p.maxPerHour, s.maxPerHour);
      settingsChanged = true; touch(); flush(); return s; },
    summary(live) { const t = now(), days = [];
      for (let i = 29; i >= 0; i--) { const k = day(t - i * 864e5), D = d.days[k]; days.push({ day: k, games: D?.games || 0, started: D?.started || 0, players: D?.players.length || 0, newPlayers: D?.newPlayers || 0 }); }
      const refs = Object.entries(d.refs).map(([ref, r]) => ({ ref, ...r })).sort((a, b) => b.players - a.players || b.games - a.games || b.visits - a.visits).slice(0, 20);
      return { days, refs, handles: handleList(), handleCount: Object.keys(d.handles).length, platformCounts: platformCounts(), totals: d.totals, playClicks: d.playClicks, shares: d.shares, settings: d.settings, live,
        lastHour: d.recentCreates.filter(x => x > t - 3600e3).length };
    },
  };
}
module.exports = { createStats, hashId, normHandle, migrateHandles };
