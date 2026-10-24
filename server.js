'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const Field = require('./public/field');
const Recap = require('./public/recap');
const Socials = require('./public/socials');
const PU = require('./powerups');
const Tasks = require('./tasks');
const Walk = require('./walk');
const TagCore = require('./tagcore');
const { createStats, normHandle } = require('./stats');
const { createSupabaseStore } = require('./supabase');
const Admin = require('./admin');
const { createPolls, ics: pollIcs, CODE_RE: POLL_RE, clean: cleanText } = require('./polls');

const IDLE_TTL_MS = 60 * 60 * 1000;       // lobby deleted after 1 h with no game running (or as soon as it's empty)
const MAX_GAME_MS = 6 * 3600 * 1000;
const DISCONNECT_GRACE_MS = 10 * 60 * 1000; // a dropped player's slot (role/team/caught state) is kept at least this long; in practice until the lobby ends
      // safety cap for a single running round
const STALE_MS = 45 * 1000;
const CHIME_THROTTLE = 1500;
const HL_TTL = 30 * 60 * 1000;           // uploaded highlight cuts live 30 min max (memory only)
const HL_MAX = 15 * 1024 * 1024, HL_CUT_MAX = 3 * 1024 * 1024;
const PRE_JOIN_MAX = 64 * 1024;          // bug audit: any message before create/join is tiny; reject big ones before parsing
const JOINED_MAX = 1024 * 1024;          // in-game messages (cam photo <= 600 kB); only highlight uploads after the game may be bigger
const MSG_BURST = 60, MSG_RATE = 30;     // per-socket token bucket: 60 burst, 30 msg/s sustained (excess dropped, floods closed)
const LOOPBACK = /^(::1|127\.|::ffff:127\.)/;

const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BUSY_MSG = 'Last Ping is busy right now. Try again in a few minutes!';
function makeCode(lobbies) {
  let c;
  do { c = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (lobbies.has(c));
  return c;
}
const FEATURES = ['decoy', 'chime', 'bounty', 'cam', 'compass'];
// Game modes: presets over the individual toggles. Pings, the field and catch confirmation are always on.
const MODES = {
  classic: { label: 'Classic', desc: 'Pure hide & seek: pings, the field, the chime and catch confirmation. No extras.', features: { decoy: false, chime: true, bounty: false, cam: false, compass: false }, powerups: 'off', tasks: 'off', autoTag: 3 },
  party: { label: 'Party', desc: 'Classic plus decoys, bounties, power-ups (every 3 min) and the sudden-death compass.', features: { decoy: true, chime: true, bounty: true, cam: false, compass: true }, powerups: 'normal', tasks: 'normal', autoTag: 3 },
  chaos: { label: 'Chaos', desc: 'Everything on: cam peek too, and power-ups drop every 90 s.', features: { decoy: true, chime: true, bounty: true, cam: true, compass: true }, powerups: 'chaos', tasks: 'normal', autoTag: 3 },
  custom: { label: 'Custom', desc: 'Pick every toggle yourself.' },
};
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
// client IP for per-IP limits: Cloudflare's header, else the leftmost X-Forwarded-For (Render's proxy), else the socket.
// `local` = a direct loopback connection with no proxy headers (local dev / tests): not rate limited.
function clientIp(req) {
  const h = req.headers || {}, fwd = String(h['cf-connecting-ip'] || String(h['x-forwarded-for'] || '').split(',')[0]).trim(), sock = req.socket?.remoteAddress || '';
  return { ip: fwd || sock, local: !fwd && LOOPBACK.test(sock) };
}
// sliding-window counter: true when `key` already had `max` hits in the last `winMs`
function makeLimiter() {
  const hits = new Map();
  const hit = (key, max, winMs, t = Date.now()) => { let a = hits.get(key); if (!a) { if (hits.size > 20000) hits.clear(); hits.set(key, a = []); }
    while (a.length && a[0] <= t - winMs) a.shift(); if (a.length >= max) return true; a.push(t); return false; };
  const sweep = (winMs, t = Date.now()) => { for (const [k, a] of hits) if (!a.length || a[a.length - 1] <= t - winMs) hits.delete(k); };
  return { hit, sweep, size: () => hits.size };
}
const band = m => m < 25 ? 'scorching' : m < 75 ? 'hot' : m < 150 ? 'warm' : m < 300 ? 'cool' : 'cold';
// player names: strip control / bidi-override / zero-width characters (display spoofing), collapse spaces, max 20
const cleanName = n => cleanText(String(n ?? ''), 20) || 'Player';
const clampNum = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };

function createApp(opts = {}) {
  const now = opts.now || (() => Date.now());
  const revealMs = Math.max(0, Number(opts.revealMs ?? 0) || 0); // v13 synced countdown: timers start at revealAt (no hide time lost)
  const minSec = opts.minSec ?? 1; // tests can use fractional seconds
  const lobbies = new Map();
  const app = express();
  app.set('trust proxy', true);
  // Share links: /play is a controllable 302 (point it at a custom domain with PLAY_REDIRECT_URL); /p/<code> deep-links a lobby.
  // ?ref=<handle> visits are counted in memory and logged.
  const refs = new Map(), env = opts.env || process.env;
  const DEFAULT_MODE = MODES[opts.defaultMode ?? env.SCRAM_DEFAULT_MODE] ? (opts.defaultMode ?? env.SCRAM_DEFAULT_MODE) : 'classic'; // test hook: legacy suites use 'custom' (everything on)
  const MAX_PLAYERS = Math.round(clampNum0(opts.maxPlayers ?? env.MAX_PLAYERS, 2, 500, 20)); // per lobby
  // bug audit: per-IP limits on create / join (10-min window; generous because a whole group can share one carrier NAT IP)
  const CREATE_PER_IP = Math.round(clampNum0(opts.createPerIp ?? env.CREATE_PER_IP, 1, 100000, 20)), JOIN_PER_IP = Math.round(clampNum0(opts.joinPerIp ?? env.JOIN_PER_IP, 1, 100000, 120));
  const HOST_HANDOFF_MS = opts.hostHandoffMs ?? 90 * 1000; // a host offline this long hands the crown to a connected player
  const HL_TOTAL_MAX = clampNum0(opts.hlTotalMb ?? env.HL_TOTAL_MB, 1, 4096, 120) * 1024 * 1024; // all lobbies' highlight cuts together (512 MB box)
  const ipLimit = makeLimiter();
  // Persistence: Supabase (SUPABASE_URL + SUPABASE_SERVICE_KEY, server-only) when set, else the STATS_FILE JSON (local runs / tests)
  const persist = opts.stats ? null : opts.persist !== undefined ? opts.persist : (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY)
    ? createSupabaseStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY, now, throttleMs: opts.statsThrottleMs ?? 5000, log: opts.quiet ? { error() {}, log() {} } : console, ...(opts.supabase || {}) }) : null;
  const stats = opts.stats || createStats({ file: opts.statsFile !== undefined ? opts.statsFile : process.env.NODE_TEST_CONTEXT ? null : (env.STATS_FILE || path.join(__dirname, 'data', 'stats.json')),
    now, throttleMs: opts.statsThrottleMs ?? 5000, maxGames: Math.round(clampNum0(env.MAX_GAMES, 0, 100000, 50)), persist });
  const ready = stats.ready || (stats.ready = stats.persist ? stats.persist.start({ waitMs: opts.storageWaitMs ?? 10000 }) : Promise.resolve(true));
  const liveCounts = () => { let games = 0, playing = 0, players = 0, online = 0; for (const L of lobbies.values()) { if (L.state === 'ended') continue; games++; if (L.state === 'playing' || L.state === 'hiding') playing++;
    for (const p of L.players.values()) { players++; if (p.ws) online++; } } return { games, playing, players, online }; };
  app.use((req, res, next) => { if (req.method === 'GET' && req.query.ref) { const h = normHandle(String(req.query.ref || '')); if (h && (refs.has(h) || refs.size < 2000)) { refs.set(h, (refs.get(h) || 0) + 1); stats.visit(h); if (!opts.quiet) console.log(`[ref] ${h} visits=${refs.get(h)} ${req.path}`); } } next(); });
  const playTarget = (extra = {}) => { const base = env.PLAY_REDIRECT_URL || '/', u = new URL(base, 'http://x'); for (const [k, v] of Object.entries(extra)) if (v) u.searchParams.set(k, v);
    return /^https?:/i.test(base) ? u.toString() : u.pathname + u.search; };
  app.get('/play', (req, res) => { stats.playClick(); res.redirect(302, playTarget({ ref: normHandle(String(req.query.ref || '')) })); });
  // "Plan the next game" polls: 6-char codes (lobby codes are 5) are served by the app itself at /p/CODE, on any host
  // (so they also work from the PLAY_REDIRECT_URL domain when it points at this app); 5-char lobby codes keep the redirect.
  const polls = opts.polls || createPolls({ stats, now });
  const pollSubs = new Map(); // code -> Set<ws>
  const pollPush = code => { const v = polls.view(code), subs = pollSubs.get(code); if (!subs) return; for (const w of subs) send(w, v ? { type: 'poll', poll: v } : { type: 'poll', code, gone: true }); };
  app.get('/p/:code', (req, res, next) => { const c = String(req.params.code).toUpperCase(); if (!POLL_RE.test(c)) return next();
    res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'plan.html')); });
  const pj = express.json({ limit: '8kb' });
  const pollErr = (res, e) => { if (e && e.status) return res.status(e.status).json({ error: e.message }); console.error('[poll]', e); res.status(500).json({ error: 'Server error' }); };
  const pollUrl = (req, code) => `${req.protocol}://${req.get('host')}/p/${code}`;
  // polls survive restarts: if a poll is not in memory, look it up in Supabase before handling the request
  app.use('/api/polls/:code', (req, res, next) => { polls.ensure(req.params.code).then(() => next(), () => next()); });
  app.post('/api/polls', pj, (req, res) => { try { const r = polls.create(req.body || {}, { ip: req.ip }); res.status(201).json(r); } catch (e) { pollErr(res, e); } });
  app.get('/api/polls/:code', (req, res) => { const v = polls.view(req.params.code); if (!v) return res.status(404).json({ error: 'Poll not found or expired' });
    res.set('Cache-Control', 'no-store').json({ ...v, mine: polls.mine(req.params.code, String(req.query.v || '')), creator: req.query.k ? polls.isCreator(req.params.code, String(req.query.k)) : undefined }); });
  app.post('/api/polls/:code/vote', pj, (req, res) => { try { const v = polls.vote(req.params.code, req.body || {}); res.json(v); pollPush(v.code); } catch (e) { pollErr(res, e); } });
  app.post('/api/polls/:code/lock', pj, (req, res) => { try { const v = polls.lock(req.params.code, req.body || {}); res.json(v); pollPush(v.code); } catch (e) { pollErr(res, e); } });
  app.get('/api/polls/:code/ics', (req, res) => { const p = polls.get(req.params.code); if (!p) return res.status(404).type('text').send('Poll not found or expired');
    const body = pollIcs(p, { url: pollUrl(req, p.code), now: now() }); if (!body) return res.status(409).type('text').send('Not locked yet');
    res.set('Content-Disposition', `attachment; filename="last-ping-${p.code}.ics"`).type('text/calendar; charset=utf-8').send(body); });
  const pollSweep = setInterval(() => polls.sweep(), 3600e3); pollSweep.unref?.();
  app.get('/p/:code', (req, res) => res.redirect(302, playTarget({ code: String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8), ref: normHandle(String(req.query.ref || '')) })));
  // creator credit: CREATOR_HANDLE + CREATOR_PLATFORM (legacy CREATOR_IG = an Instagram handle); default @mmmmmray on Instagram
  const CREATOR = Socials.norm({ handle: env.CREATOR_HANDLE || env.CREATOR_IG || 'mmmmmray', platform: env.CREATOR_HANDLE ? (env.CREATOR_PLATFORM || 'instagram').toLowerCase() : 'instagram' })
    || { handle: 'mmmmmray', platform: 'instagram' };
  app.get('/config.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(`window.CREATOR=${JSON.stringify({ ...CREATOR, url: Socials.url(CREATOR) })};`));
  Admin.mount(app, { env, stats, liveCounts, polls });
  app.post('/api/share', express.json({ limit: '1kb' }), (req, res) => { stats.share(String(req.body?.k || '')); res.status(204).end(); });
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
  app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
  app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
  app.get('/rules', (req, res) => res.sendFile(path.join(__dirname, 'public', 'rules.html')));
  // exact rule values for /rules (rendered from the same constants the game uses)
  app.get('/api/rules', (req, res) => res.json({ gameMin: DEFAULT_GAME_SEC / 60, pingSec: 60, hideSec: 120, oobGraceSec: 30, catchConfirmSec: 20, catchRadiusM: 30,
    decoys: 2, decoyMinM: 30, decoyMaxM: 150, chimeM: 40, chimeVolDefault: 25, bountyEveryMin: 5, bountyRadiusM: 15, camMin: 10, compassFromMin: 18,
    dropEveryMin: 3, chaosEverySec: 90, noDropsFirstMin: 2, dropTtlMin: 2.5, pickupM: 15, pickupSec: 5, cooldownMin: 3, dropMinM: 50, dropMaxM: 200,
    hiderWeights: PU.HIDER, hunterWeights: PU.HUNTER, info: PU.INFO, hlMaxMB: HL_MAX / 1048576, hlTtlMin: HL_TTL / 60000, closeCallM: 20, closeCallSec: 60, maxPlayers: MAX_PLAYERS, planAnyone: env.PLAN_ANYONE === '1', defaultMode: 'classic', modes: MODES, tiles: env.DARK_TILES_URL ? { url: env.DARK_TILES_URL, attr: env.DARK_TILES_ATTR || '© OpenStreetMap contributors' } : null, needFixLeadSec: 5, gpsFastSec: 4, gpsSlowSec: 15, gpsStillM: 5, gpsEnemyM: 150 }));
  app.get('/healthz', (req, res) => res.json({ ok: true, lobbies: lobbies.size }));
  app.get('/j/:code', (req, res) => res.redirect('/?code=' + encodeURIComponent(req.params.code.toUpperCase())));
  app.get('/qr/:code.svg', async (req, res) => {
    const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); if (!code) return res.status(404).end();
    const url = `${req.protocol}://${req.get('host')}/p/${code}`;
    res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1 }));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 24 * 1024 * 1024 });

  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  function newLobby() {
    const code = makeCode(lobbies);
    const L = {
      code, createdAt: now(), hostId: null, players: new Map(), state: 'lobby',
      settings: { gameSec: opts.gameSec || DEFAULT_GAME_SEC, pingSec: 60, hideSec: 120, caughtBecomeHunter: true, showRevealed: true, teammates: true, powerups: 'normal', tasks: 'off', autoTag: 0, manualTag: true, chimeVol: 25,
        features: Object.fromEntries(FEATURES.map(f => [f, true])), mode: 'custom' },
      field: null, bounty: null, photos: {}, camAt: 0, compassAt: 0, nextBountyAt: 0, nextCompassAt: 0,
      startedAt: 0, hideEndsAt: 0, endsAt: 0, nextPingAt: 0, pings: [], winner: null, endedAt: 0, events: [], idleSince: now(), round: 0,
      trails: {}, log: [], catches: new Map(), drops: new Map(), nextDropAt: 0, dropSide: 'hider', jamUntil: 0, truthNext: false, shrink: null, nextHoundAt: 0, recapCache: null, highlights: new Map(),
      pick: { manual: false, hunters: 1, ids: new Set() }, // v13.1 host-only hunter choice; roles are dealt at start and stay secret until revealAt
    };
    applyMode(L.settings, DEFAULT_MODE);
    lobbies.set(code, L);
    return L;
  }

  function applyMode(st, mode) { const M = MODES[mode]; if (!M) return; st.mode = mode; if (M.features) { st.features = { ...M.features }; st.powerups = M.powerups; st.tasks = M.tasks; st.autoTag = M.autoTag; } }
  // {social:{handle,platform}} or legacy {ig, platform?} -> normalized social or null
  const socialIn = m => Socials.norm(m.social && typeof m.social === 'object' ? m.social : { handle: m.ig, platform: m.platform });
  function addPlayer(L, name, social) {
    const p = { id: rid(6), token: rid(16), name: cleanName(name),
      role: 'hider', caught: false, caughtAt: 0, ws: null, loc: null, perm: 'unknown', connected: false, revealedAt: 0,
      cam: 'unknown', decoys: 2, decoyArmed: false, wipeNext: false, outSince: 0, oobReveal: false, held: null, lastUse: 0, pickup: null, silent: false, shieldUntil: 0, radarUntil: 0, houndUntil: 0, used: 0, social: social || null };
    if (!L.hostId) L.hostId = p.id; // no lobby roles: dealt at start (random by default)
    L.players.set(p.id, p);
    return p;
  }

  const isHunter = p => p.role === 'hunter';
  // a new host must not inherit the old host's secret manual hunter pick (it would reveal roles before revealAt)
  function setHost(L, p) { if (L.hostId === p.id) return; L.hostId = p.id; if (L.state === 'lobby') { L.pick.manual = false; L.pick.ids = new Set(); } }
  const activeHiders = L => [...L.players.values()].filter(p => p.role === 'hider' && !p.caught);

  // ---- The privacy core: build a view for ONE player. Hider coordinates are only ever
  // included for hunters via L.pings (snapshots taken at ping time), never p.loc.
  function viewFor(L, me) {
    const t = now();
    const ended = L.state === 'ended';
    const pre = L.state === 'lobby' || t < (L.revealAt || 0); // before the reveal NO role data (own or others') leaves the server
    if (pre) return preView(L, me, t);
    const players = [...L.players.values()].map(p => {
      const o = { id: p.id, name: p.name, role: p.role, caught: p.caught, caughtAt: p.caughtAt, connected: p.connected, perm: p.perm,
        host: p.id === L.hostId, cam: p.cam, acc: p.loc ? Math.round(p.loc.acc) : null,
        stale: !p.loc || (t - p.loc.recvAt) > STALE_MS, out: outFlag(L, p) };
      if (p.social && (L.state === 'lobby' || ended)) o.social = p.social; // handles: lobby + recap only, never during a game // in/out flag only, never coords
      const canSeeLive = p.id === me.id ||
        (isHunter(me) && isHunter(p) && L.state !== 'lobby') ||
        (L.settings.teammates && me.role === 'hider' && !me.caught && p.role === 'hider' && !p.caught && running(L)) || // hider teammates: uncaught hiders only, never hunters/spectators
        (me.role === 'hider' && !me.caught && me.radarUntil > t && isHunter(p) && L.state === 'playing'); // Hunter Radar
      if (canSeeLive && p.loc) o.loc = { lat: p.loc.lat, lng: p.loc.lng, acc: p.loc.acc, ts: p.loc.ts };
      return o;
    });
    const v = { type: 'state', code: L.code, you: me.id, host: L.hostId, state: L.state, settings: L.settings,
      serverNow: t, revealAt: L.revealAt || 0, startedAt: L.startedAt, hideEndsAt: L.hideEndsAt, endsAt: L.endsAt, nextPingAt: L.nextPingAt,
      winner: L.winner, maxPlayers: MAX_PLAYERS, players, pingCount: L.pings.length, events: L.events.slice(-8) };
    v.field = curField(L); v.baseField = L.field; v.shrinkUntil = L.shrink ? L.shrink.until : 0; v.oobGraceMs = oobGrace(L);
    if (me.outSince) v.outSince = me.outSince;
    v.round = L.round; v.camAt = L.camAt; v.compassAt = L.compassAt;
    v.compass = inCompass(L);
    if (L.state === 'lobby' && L.chimeTest) { const tally = { good: 0, quiet: 0, loud: 0 }; for (const x of L.chimeTest.votes.values()) tally[x]++;
      v.chimeTest = { id: L.chimeTest.id, vol: L.chimeTest.vol, myVote: L.chimeTest.votes.get(me.id) || null, ...(me.id === L.hostId ? { tally, n: L.players.size } : {}) }; }
    v.catches = catchView(L, me);
    if (L.state === 'playing') { // hider drops ONLY to uncaught hiders; hunter drops to everyone
      const hiderView = me.role === 'hider' && !me.caught;
      // v19: hunters see hider-drop LOCATIONS too (dimmed, not pickable, no type); never hider positions
      v.drops = [...L.drops.values()].map(d => ({ id: d.id, side: d.side, lat: d.lat, lng: d.lng, expiresAt: d.expiresAt, ...(d.side === 'hunter' || hiderView ? { ptype: d.type } : { locked: true }) }));
      v.pu = { held: me.held, cooldownMs: puCooldown(L), cooldownUntil: me.lastUse ? me.lastUse + puCooldown(L) : 0, silent: me.silent, shieldUntil: me.shieldUntil, radarUntil: me.radarUntil, houndUntil: me.houndUntil,
        pickup: me.pickup ? { dropId: me.pickup.dropId, since: me.pickup.since, need: pickupMs(L) } : null };
      if (isHunter(me)) v.jamUntil = L.jamUntil;
    } v.hlCount = L.highlights.size; v.hlMine = L.highlights.has(me.id);
    if (L.bounty && L.settings.features.bounty) v.bounty = { id: L.bounty.id, lat: L.bounty.lat, lng: L.bounty.lng, t: L.bounty.t, radius: 15 };
    if (me.role === 'hider' && !me.caught && me.task) v.task = Tasks.pub(me.task); // only ever to the hider it belongs to
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

  // Lobby / countdown view: names, GPS & presence only. No role, no role-gated data (pings, photos, drops, decoys, teammates).
  function preView(L, me, t) {
    const players = [...L.players.values()].map(p => {
      const o = { id: p.id, name: p.name, connected: p.connected, perm: p.perm, host: p.id === L.hostId, cam: p.cam, acc: p.loc ? Math.round(p.loc.acc) : null,
        stale: !p.loc || (t - p.loc.recvAt) > STALE_MS, out: outFlag(L, p) };
      if (p.social && L.state === 'lobby') o.social = p.social;
      if (p.id === me.id && p.loc) o.loc = { lat: p.loc.lat, lng: p.loc.lng, acc: p.loc.acc, ts: p.loc.ts };
      return o;
    });
    const v = { type: 'state', code: L.code, you: me.id, host: L.hostId, state: L.state, settings: L.settings,
      serverNow: t, revealAt: L.revealAt || 0, startedAt: L.startedAt, hideEndsAt: L.hideEndsAt, endsAt: L.endsAt, nextPingAt: L.nextPingAt,
      winner: null, maxPlayers: MAX_PLAYERS, players, pingCount: 0, events: L.state === 'lobby' ? L.events.slice(-8) : [] };
    v.field = curField(L); v.baseField = L.field; v.shrinkUntil = 0; v.oobGraceMs = oobGrace(L); v.round = L.round; v.camAt = L.camAt; v.compassAt = L.compassAt; v.compass = false;
    if (L.state === 'lobby' && L.chimeTest) { const tally = { good: 0, quiet: 0, loud: 0 }; for (const x of L.chimeTest.votes.values()) tally[x]++;
      v.chimeTest = { id: L.chimeTest.id, vol: L.chimeTest.vol, myVote: L.chimeTest.votes.get(me.id) || null, ...(me.id === L.hostId ? { tally, n: L.players.size } : {}) }; }
    v.catches = []; v.hlCount = L.highlights.size; v.hlMine = L.highlights.has(me.id);
    if (me.id === L.hostId && L.state === 'lobby') v.hostPick = { manual: L.pick.manual, hunters: L.pick.hunters, ids: L.pick.manual ? [...L.pick.ids].filter(id => L.players.has(id)) : [] }; // host-only, never sent to players
    return v;
  }
  const preReveal = L => L.state === 'lobby' || now() < (L.revealAt || 0);
  function dealRoles(L, ps) { // returns error string or null
    if (ps.length < 2) return 'Need at least 1 hunter and 1 hider';
    let hunters;
    if (L.pick.manual) { hunters = new Set([...L.pick.ids].filter(id => L.players.has(id)));
      if (!hunters.size || hunters.size >= ps.length) return 'Need at least 1 hunter and 1 hider'; }
    else { const n = Math.max(1, Math.min(ps.length - 1, L.pick.hunters | 0 || 1)), sh = [...ps];
      for (let i = sh.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [sh[i], sh[j]] = [sh[j], sh[i]]; }
      hunters = new Set(sh.slice(0, n).map(p => p.id)); }
    for (const p of ps) p.role = hunters.has(p.id) ? 'hunter' : 'hider';
    return null;
  }
  const curField = L => (L.shrink && L.shrink.field) || L.field;
  const outFlag = (L, p) => (L.state === 'playing' || L.state === 'hiding') ? !!p.outSince : !!(L.field && p.loc && !Field.inField(L.field, p.loc));
  function broadcast(L) { for (const p of L.players.values()) if (p.ws) send(p.ws, viewFor(L, p)); }
  function event(L, text) { L.events.push({ t: now(), text }); }
  // ---- recap recording (memory only; exposed ONLY after the round ends) ----
  const TRAIL_MS = opts.trailMs ?? 5000, CATCH_MS = opts.catchMs ?? 20000;
  const running = L => L.state === 'playing' || L.state === 'hiding';
  const rc = p => isHunter(p) ? 'h' : p.caught ? 'c' : 's';
  function trail(L, p, force) {
    if (!running(L) || !p.loc) return;
    const tr = L.trails[p.id] || (L.trails[p.id] = []), t = now(), last = tr[tr.length - 1];
    if (force || !last || t - last[0] >= TRAIL_MS) tr.push([t, +p.loc.lat.toFixed(6), +p.loc.lng.toFixed(6), rc(p)]);
  }
  function logEv(L, k, data, text) { if (L.state !== 'lobby') L.log.push({ t: now(), k, ...data, text }); }
  const hunterList = L => [...L.players.values()].filter(isHunter);
  function nearestHunter(L, h, maxM = Infinity) { let best = null, bd = maxM;
    if (h.loc) for (const x of hunterList(L)) if (x.loc) { const d = distM(x.loc, h.loc); if (d <= bd) { bd = d; best = x; } } return best; }
  function nearestHider(L, hu) { let best = null, bd = Infinity;
    if (hu.loc) for (const h of activeHiders(L)) if (h.loc) { const d = distM(hu.loc, h.loc); if (d < bd) { bd = d; best = h; } } return best; }
  function buildRecap(L) {
    if (L.state !== 'ended') return null;
    if (L.recapCache) return L.recapCache;
    const players = [...L.players.values()].map(p => ({ id: p.id, name: p.name, startRole: p.startRole || p.role, role: p.role, caught: p.caught, caughtAt: p.caughtAt, caughtBy: p.caughtBy || null, social: p.social || null }));
    const photos = Object.fromEntries(Object.entries(L.photos).filter(([, ph]) => ph.data).map(([id, ph]) => [id, { name: ph.name, data: ph.data, t: ph.t }]));
    const R0 = { code: L.code, round: L.round, startedAt: L.startedAt, hideEndsAt: L.hideEndsAt, endsAt: L.endsAt, endedAt: L.endedAt, winner: L.winner,
      players, trails: L.trails, log: [...L.log], photos, field: L.field };
    R0.closeCalls = Recap.closeCalls(R0); R0.awards = Recap.computeAwards(R0); R0.trophies = Recap.computeTrophies(R0, R0.closeCalls);
    for (const c of R0.closeCalls) R0.log.push({ t: c.t, k: 'close', hider: c.hider, hunter: c.hunter, d: c.d, lat: c.lat, lng: c.lng, text: '😱 ' + c.text });
    R0.log.sort((a, b) => a.t - b.t);
    return (L.recapCache = R0);
  }

  const scale = L => L.settings.gameSec / 1200; // feature timings scale with game length (20 min = 1.0)
  // Out-of-bounds: a hider outside the field for oobGrace (30 s at 20 min, scaled) is flagged; the next ping
  // (scheduled or bounty) reveals their TRUE position, ignoring decoys and wipes.
  const oobGrace = L => Math.max(opts.oobMinMs ?? 2000, 30000 * scale(L));
  function checkBounds(L) {
    const t = now(), running = (L.state === 'playing' || L.state === 'hiding') && t >= (L.revealAt || 0); // grace starts at the reveal
    for (const p of L.players.values()) {
      const out = running && !!curField(L) && !(p.role === 'hider' && p.caught) && !!p.loc && !Field.inField(curField(L), p.loc);
      if (out && !p.outSince) { p.outSince = t; event(L, `⚠️ ${p.name} is out of bounds`); logEv(L, 'oob', { id: p.id, on: true }, `⚠️ ${p.name} left the field`); broadcast(L); }
      else if (!out && p.outSince) { p.outSince = 0; p.oobReveal = false; logEv(L, 'oob', { id: p.id, on: false }, `✅ ${p.name} back inside`); broadcast(L); }
      if (out && p.role === 'hider' && L.state === 'playing' && !p.oobReveal && t - p.outSince >= oobGrace(L)) {
        p.oobReveal = true; event(L, `🚨 ${p.name} stayed out of bounds — revealed at the next ping`); broadcast(L);
      }
    }
  }
  const inCompass = L => L.state === 'playing' && L.settings.features.compass && L.compassAt > 0 && now() >= L.compassAt;

  // scheduled: a regular cycle ping (decoys / wipes / chimes apply). Out-of-cycle (bounty) pings are always real.
  function doPing(L, { scheduled = true, final = false } = {}) {
    const t = now(), F = L.settings.features;
    const locs = {}, decoys = [], hidden = [], chimed = [];
    const hunters = [...L.players.values()].filter(p => isHunter(p) && p.loc);
    const truth = scheduled && L.truthNext; if (truth) L.truthNext = false; // Truth Ping: ignore decoys and wipes this ping
    for (const h of activeHiders(L)) {
      const noisy = scheduled && h.noisy; if (noisy) h.noisy = false; // failed/ignored task: this ping ignores cloak/decoy and is tight
      if (scheduled && !final && !truth && !noisy && h.wipeNext && !h.oobReveal) { h.wipeNext = false; locs[h.id] = null; hidden.push(h.id); continue; }
      if (!h.loc) { locs[h.id] = null; continue; }
      let pos = { lat: h.loc.lat, lng: h.loc.lng };
      if (scheduled && !final && !truth && !noisy && h.decoyArmed && !h.oobReveal) { h.decoyArmed = false; pos = offsetM(pos, rnd(30, 150), rnd(0, 360)); decoys.push(h.id); }
      locs[h.id] = { lat: pos.lat, lng: pos.lng, acc: noisy ? Math.min(h.loc.acc, 10) : h.loc.acc, ts: h.loc.ts, age: t - h.loc.recvAt }; h.revealedAt = t;
      if (scheduled && !final && F.chime && !h.silent && hunters.some(x => distM(x.loc, h.loc) <= 40)) chimed.push(h);
    }
    L.pings.push({ t, locs, out: !scheduled, decoys, hidden, truth });
    logEv(L, 'ping', { locs, decoys, hidden, out: !scheduled }, `📡 Ping #${L.pings.length}${!scheduled ? ' (bounty)' : ''}${truth ? ' (Truth Ping)' : ''}${decoys.length ? ` · ${decoys.length} decoy` : ''}`);
    if (chimed.length) logEv(L, 'chime', { ids: chimed.map(h => h.id) }, `🔔 ${chimed.map(h => h.name).join(', ')} chimed`);
    if (scheduled) L.nextPingAt = t + L.settings.pingSec * 1000;
    for (const p of L.players.values()) send(p.ws, { type: 'ping', t, n: L.pings.length, out: !scheduled, ...(isHunter(p) ? { locs, hidden, nearest: nearestHider(L, p)?.id || null } : {}) });
    for (const h of chimed) send(h.ws, { type: 'chime' });
    if (chimed.length) for (const p of L.players.values()) if (isHunter(p)) send(p.ws, { type: 'chimeNearby', n: chimed.length });
  }

  function spawnBounty(L, at) {
    const pts = [...L.players.values()].filter(p => p.loc && !(p.role === 'hider' && p.caught)).map(p => p.loc);
    if (!at && !pts.length && !L.field) { L.bounty = null; return; }
    let pos = at;
    if (!pos && pts.length) { // 50-250 m from the players' centroid, re-rolled until inside the field
      const c = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
      for (let i = 0; i < 60 && !pos; i++) { const q = offsetM(c, rnd(50, 250), rnd(0, 360)); if (Field.inField(L.field, q)) pos = q; }
    }
    if (!pos) pos = Field.randomPoint(L.field); // fallback: anywhere inside the field
    if (!pos) { L.bounty = null; return; }
    L.bounty = { id: rid(4), lat: pos.lat, lng: pos.lng, t: now() };
    event(L, '💰 A bounty appeared on the map!');
  }
  function tryClaim(L, p) {
    const b = L.bounty;
    if (!b || !p.loc || L.state !== 'playing' || !L.settings.features.bounty || (p.role === 'hider' && p.caught)) return false;
    if (distM(p.loc, b) > 15) return false;
    L.bounty = null;
    logEv(L, 'bounty', { id: p.id, lat: b.lat, lng: b.lng, effect: isHunter(p) ? 'ping' : 'wipe' }, `💰 ${p.name} claimed a bounty`);
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
    for (const p of L.players.values()) trail(L, p, true);
    logEv(L, 'end', { winner }, winner === 'hiders' ? '⏱ Time up — hiders win' : '🔦 Everyone caught — hunters win');
    L.catches.clear();
    L.state = 'ended'; L.winner = winner; L.endedAt = now(); L.idleSince = now(); L.nextPingAt = 0;
    event(L, winner === 'hiders' ? 'Time up — hiders win!' : 'Everyone caught — hunters win!');
    broadcast(L);
    const rcp = buildRecap(L); for (const p of L.players.values()) send(p.ws, { type: 'recap', recap: rcp });
    L.rg = { round: L.round, fb: [] }; for (const p of L.players.values()) { p.rgChoice = null; p.rgHist = []; p.fbDone = false; p.notifyDone = false; } sendRegroup(L);
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
      if (running && !L.revealSent && t >= L.revealAt) { L.revealSent = true; broadcast(L); } // the reveal: first state that carries roles
      { const hp = L.players.get(L.hostId); // host offline too long: hand over to a connected player (they can start / end / confirm catches)
        if (hp && !hp.connected && hp.discAt && t - hp.discAt > HOST_HANDOFF_MS) { const next = [...L.players.values()].find(x => x.connected);
          if (next) { setHost(L, next); event(L, `👑 ${next.name} is now host (${hp.name} is offline)`); broadcast(L); } } }
      if (L.state === 'hiding' && t >= L.hideEndsAt) { L.state = 'playing'; L.nextPingAt = t + L.settings.pingSec * 1000; event(L, 'Hunt is on!'); logEv(L, 'hunt', {}, '🔦 Hunt is on'); broadcast(L); }
      if (running) checkBounds(L);
      for (const [pid, c] of L.catches) if (t >= c.expiresAt) { L.catches.delete(pid); const h = L.players.get(c.hiderId); event(L, `⌛ Catch claim for ${h ? h.name : '?'} expired`); broadcast(L); }
      for (const [id, hl] of L.highlights) if (t - hl.t > HL_TTL) L.highlights.delete(id);
      if (L.state === 'playing') {
        if (t >= L.endsAt) { endGame(L, 'hiders'); continue; }
        const F = L.settings.features;
        if (inCompass(L)) {
          if (L.bounty) L.bounty = null;
          if (!L.compassAnnounced) { L.compassAnnounced = true; L.nextPingAt = 0; event(L, '🧭 SUDDEN DEATH — map pings stop, hunters get a compass!'); logEv(L, 'compass', {}, '🧭 Sudden-death compass phase'); broadcast(L); }
          if (t >= L.nextCompassAt) { L.nextCompassAt = t + Math.max(100, Math.min(2000, 2000 * scale(L) * 4)); sendCompass(L); }
        } else if (t >= L.nextPingAt) { doPing(L); broadcast(L); }
        else if (L.nextPingAt && L.fixFor !== L.nextPingAt && L.nextPingAt - t <= Math.min(5000, L.settings.pingSec * 500)) { // ask every phone for a fresh GPS fix ~5 s before the ping (battery saver stays accurate)
          L.fixFor = L.nextPingAt; for (const p of L.players.values()) send(p.ws, { type: 'need_fix', at: L.nextPingAt });
        }
        if (F.bounty && !inCompass(L) && L.nextBountyAt && t >= L.nextBountyAt) {
          L.nextBountyAt = t + 300 * scale(L) * 1000; spawnBounty(L);
          for (const p of L.players.values()) tryClaim(L, p);
          broadcast(L);
        }
        tickPowerups(L); tickTasks(L); tickTags(L);
        if (F.cam && L.camAt && t >= L.camAt) { L.camAt = 0; requestPhotos(L); broadcast(L); }
        if (L.camDeadline && t >= L.camDeadline) { expirePhotos(L); broadcast(L); }
      }
      if (L.state === 'ended' && L.rg && t - (L.rg.at || 0) >= RG_EVERY) sendRegroup(L);
    }
  }
  const timer = setInterval(tick, opts.tickMs || 200);

  function catchHider(L, h, by, self) {
    if (!h || h.role !== 'hider' || h.caught || !(L.state === 'playing' || L.state === 'hiding')) return;
    if (!self && shieldBlocks(L, h, by)) return;
    trail(L, h, true);
    h.caught = true; h.caughtAt = now(); h.caughtBy = by ? by.id : null;
    for (const [pid, c] of L.catches) if (c.hiderId === h.id) L.catches.delete(pid);
    event(L, `${h.name} was caught${by ? ' by ' + by.name : ''}`);
    logEv(L, 'catch', { id: h.id, by: by ? by.id : null }, `🎯 ${by ? by.name + ' caught ' + h.name : h.name + ' was caught'}`);
    h.task = null; h.noisy = false;
    if (L.settings.caughtBecomeHunter) { h.role = 'hunter'; send(h.ws, { type: 'infected' }); }
    trail(L, h, true);
    if (activeHiders(L).length === 0) endGame(L, 'hunters'); else broadcast(L);
  }

  // Catch confirmation: one side claims, the other side (or the host) confirms within CATCH_MS.
  function claimCatch(L, h, hunter, by) {
    if (!h || h.role !== 'hider' || h.caught || !running(L)) return;
    if (by === 'hunter' && shieldBlocks(L, h, hunter)) return; // Shield: the claim is auto-rejected once
    const ex = [...L.catches.values()].find(c => c.hiderId === h.id);
    if (ex) { if (ex.by !== by && (by === 'hider' || !ex.hunterId || ex.hunterId === hunter.id)) return finalizeCatch(L, ex, hunter); return; }
    let target = by === 'hunter' ? hunter : nearestHunter(L, h, 30); // hider claim: nearest hunter within ~30 m, else any hunter
    const c = { pid: rid(4), hiderId: h.id, hunterId: target ? target.id : null, by, t: now(), expiresAt: now() + CATCH_MS };
    L.catches.set(c.pid, c);
    const prompt = { type: 'catchPrompt', pid: c.pid, by, hider: h.name, hunter: target ? target.name : null, expiresAt: c.expiresAt };
    if (by === 'hider') for (const x of hunterList(L)) { if (!c.hunterId || x.id === c.hunterId) send(x.ws, prompt); }
    else send(h.ws, prompt);
    broadcast(L);
  }
  function finalizeCatch(L, c, who) {
    L.catches.delete(c.pid);
    const h = L.players.get(c.hiderId), hunter = c.hunterId ? L.players.get(c.hunterId) : (who && isHunter(who) ? who : null);
    catchHider(L, h, hunter, c.by === 'hider');
  }
  function answerCatch(L, me, pid, yes) {
    const c = L.catches.get(pid); if (!c) return;
    const host = me.id === L.hostId;
    const party = c.by === 'hider' ? (isHunter(me) && (!c.hunterId || c.hunterId === me.id)) : me.id === c.hiderId;
    if (!host && !party) return;
    if (yes) return finalizeCatch(L, c, me);
    L.catches.delete(pid); const h = L.players.get(c.hiderId); event(L, `❌ Catch of ${h ? h.name : '?'} was rejected`); broadcast(L);
  }
  const catchView = (L, me) => [...L.catches.values()].filter(c => me.id === L.hostId || c.hiderId === me.id || c.hunterId === me.id || (!c.hunterId && isHunter(me)))
    .map(c => ({ pid: c.pid, by: c.by, hiderId: c.hiderId, hider: L.players.get(c.hiderId)?.name, hunterId: c.hunterId, hunter: c.hunterId ? L.players.get(c.hunterId)?.name : null, expiresAt: c.expiresAt,
      canAnswer: me.id === L.hostId || (c.by === 'hider' ? isHunter(me) && (!c.hunterId || c.hunterId === me.id) : me.id === c.hiderId) }));
  function clearRound(L) { L.trails = {}; L.log = []; L.catches.clear(); L.recapCache = null; L.highlights.clear(); }

  // ---------- random power-up drops (server-authoritative; timings scale with game length) ----------
  const sc = L => scale(L) * 1000;
  const dropEvery = L => (L.settings.powerups === 'chaos' ? 90 : 180) * sc(L);
  const dropTtl = L => 150 * sc(L);
  const pickupMs = L => Math.max(opts.pickupMinMs ?? 1000, 5000 * scale(L));
  const puCooldown = L => Math.max(opts.cooldownMinMs ?? 3000, 180 * sc(L));
  const fxDur = (L, sec) => Math.max(opts.fxMinMs ?? 5000, sec * sc(L));
  const PICK_M = 15;
  // test hook only: SCRAM_TEST_PU=hider:radar,hunter:sonar forces drop types (e2e)
  const forcedPU = Object.fromEntries(String(opts.forcePU ?? env.SCRAM_TEST_PU ?? '').split(',').map(x => x.split(':')).filter(([k, v]) => (k === 'hider' && v in PU.HIDER) || (k === 'hunter' && v in PU.HUNTER)));
  function scheduleDrops(L) { L.drops.clear(); L.dropSide = 'hider'; L.nextDropAt = L.settings.powerups === 'off' ? 0 : L.hideEndsAt + Math.max(120 * sc(L), dropEvery(L)); }
  // v19 walkable ground: Overpass, server-side, cached per game; null = disabled (unit tests run quiet unless they pass opts.overpass)
  const OVERPASS = env.SCRAM_OVERPASS === 'off' ? null : opts.overpass !== undefined ? opts.overpass : opts.quiet ? null : { url: env.OVERPASS_URL || Walk.DEFAULT_URL };
  function loadWalk(L) {
    L.walk = null; if (!OVERPASS || L.settings.powerups === 'off') return null;
    const bbox = Walk.bboxOf(L.field, [...L.players.values()].filter(p => p.loc).map(p => p.loc)); if (!bbox) return null;
    const round = L.round; L.walk = { status: 'loading' };
    return L.walkP = Walk.fetchWalk(bbox, { fetch: OVERPASS.fetch, url: OVERPASS.url, timeoutMs: OVERPASS.timeoutMs || 9000 })
      .then(w => { if (L.round === round) L.walk = { status: 'ok', ...w }; }, e => { if (L.round === round) L.walk = { status: 'fail', error: String(e.message || e) }; });
  }
  function spawnDrop(L, side, rand = Math.random) {
    const f = curField(L), hs = activeHiders(L).filter(h => h.loc), hu = hunterList(L).filter(h => h.loc);
    let pos = null; const W = L.walk && L.walk.status === 'ok' ? L.walk : null;
    if (W) { // on walkable ways first; same distance / avoid rules as before
      if (side === 'hider' && hs.length) { const h = hs[Math.floor(rand() * hs.length)]; pos = Walk.spawnOnWalk(W, h.loc, hu.map(x => x.loc), f, rand); }
      else if (side === 'hunter' && hu.length) { const h = hu[Math.floor(rand() * hu.length)]; pos = Walk.spawnOnWalk(W, h.loc, null, f, rand); }
      if (!pos && f) pos = Walk.spawnOnWalk(W, null, null, f, rand);
    }
    if (!pos && side === 'hider' && hs.length) { const h = hs[Math.floor(rand() * hs.length)]; pos = PU.spawnPoint(h.loc, hu.map(x => x.loc), f, rand); }
    else if (!pos && side === 'hunter' && hu.length) { const h = hu[Math.floor(rand() * hu.length)]; pos = PU.spawnPoint(h.loc, null, f, rand); }
    if (!pos && f) pos = Field.randomPoint(f, rand);
    if (!pos) return null;
    const d = { id: rid(4), side, lat: pos.lat, lng: pos.lng, onWay: !!W && Walk.onWalk(W, pos), t: now(), expiresAt: now() + dropTtl(L), type: forcedPU[side] || PU.roll(side, rand) };
    L.drops.set(d.id, d); logEv(L, 'drop', { side, lat: d.lat, lng: d.lng, dropId: d.id }, side === 'hider' ? '🎁 A hider power-up dropped' : '⚡ A hunter power-up dropped');
    for (const p of L.players.values()) if (side === 'hunter' || (p.role === 'hider' && !p.caught)) send(p.ws, { type: 'drop', side });
    return d;
  }
  function revealPing(L, h) { // steal penalty: immediate real-location ping of one hider
    const t = now(), locs = { [h.id]: h.loc ? { lat: h.loc.lat, lng: h.loc.lng, acc: h.loc.acc, ts: h.loc.ts, age: t - h.loc.recvAt } : null };
    L.pings.push({ t, locs, out: true, decoys: [], hidden: [] }); h.revealedAt = t;
    logEv(L, 'ping', { locs, decoys: [], hidden: [], out: true }, `📡 ${h.name} revealed (stole a drop)`);
    for (const p of L.players.values()) send(p.ws, { type: 'ping', t, n: L.pings.length, out: true, steal: true, ...(isHunter(p) ? { locs, hidden: [] } : {}) });
  }
  function checkPickups(L) {
    const t = now();
    for (const p of L.players.values()) {
      const eligible = isHunter(p) || (p.role === 'hider' && !p.caught);
      const d = eligible && p.loc ? [...L.drops.values()].find(d => (d.side === 'hunter' || p.role === 'hider') && distM(p.loc, d) <= PICK_M) : null;
      if (!d) { if (p.pickup) { p.pickup = null; send(p.ws, viewFor(L, p)); } continue; }
      const steal = d.side === 'hunter' && p.role === 'hider';
      if (!steal && p.held) { if (!p.fullWarned) { p.fullWarned = true; send(p.ws, { type: 'puNote', text: '🎒 Hands full — use your power-up first' }); } continue; }
      if (!p.pickup || p.pickup.dropId !== d.id) { p.pickup = { dropId: d.id, since: t }; send(p.ws, viewFor(L, p)); continue; }
      if (t - p.pickup.since < pickupMs(L)) continue;
      p.pickup = null; L.drops.delete(d.id); p.fullWarned = false;
      if (steal) {
        logEv(L, 'steal', { id: p.id, lat: d.lat, lng: d.lng }, `🦝 ${p.name} destroyed a hunter drop`);
        event(L, '🦝 A hider destroyed a hunter drop!');
        for (const x of L.players.values()) send(x.ws, { type: 'dropFlash', lat: d.lat, lng: d.lng, name: p.name });
        revealPing(L, p);
      } else {
        p.held = d.type; logEv(L, 'pickup', { id: p.id, ptype: d.type, lat: d.lat, lng: d.lng }, `${PU.INFO[d.type][0]} ${p.name} picked up ${PU.INFO[d.type][1]}`);
        send(p.ws, { type: 'puGot', ptype: d.type });
      }
      broadcast(L);
    }
  }
  function tickPowerups(L) {
    const t = now();
    if (inCompass(L)) { if (L.drops.size) { L.drops.clear(); broadcast(L); } return; } // nothing in sudden death
    for (const [id, d] of L.drops) if (t >= d.expiresAt) { L.drops.delete(id); broadcast(L); }
    if (L.nextDropAt && t >= L.nextDropAt) {
      L.nextDropAt = t + dropEvery(L);
      if (spawnDrop(L, L.dropSide)) broadcast(L);
      L.dropSide = L.dropSide === 'hider' ? 'hunter' : 'hider';
    }
    if (L.shrink && t >= L.shrink.until) { L.shrink = null; event(L, '🎯 Shrink Zone ended — field back to normal'); broadcast(L); }
    checkPickups(L);
    if (t >= L.nextHoundAt) { L.nextHoundAt = t + Math.max(200, 1000 * Math.min(1, scale(L) * 4));
      for (const p of L.players.values()) if (isHunter(p) && p.houndUntil > t) send(p.ws, { type: 'bloodhound', until: p.houndUntil,
        dists: activeHiders(L).map(h => ({ id: h.id, name: h.name, d: p.loc && h.loc ? Math.round(distM(p.loc, h.loc)) : null })) }); }
  }
  function usePower(L, me) {
    const t = now(), type = me.held, fail = e => send(me.ws, { type: 'error', error: e });
    if (!type || L.state !== 'playing') return fail('No power-up to use');
    if (inCompass(L)) return fail('No power-ups in sudden death');
    if (me.lastUse && t - me.lastUse < puCooldown(L)) return fail(`Cooldown: ${Math.ceil((me.lastUse + puCooldown(L) - t) / 1000)} s`);
    const hiderSide = type in PU.HIDER;
    if (hiderSide !== (me.role === 'hider') || (me.role === 'hider' && me.caught)) return fail('You can no longer use this power-up');
    let note = '';
    switch (type) {
      case 'radar': me.radarUntil = t + fxDur(L, 30); break;
      case 'jammer': L.jamUntil = t + fxDur(L, 60); break;
      case 'silent': me.silent = true; break;
      case 'shield': if (nearestHunter(L, me, 20)) return fail('🛡️ A hunter is within 20 m — get clear first'); me.shieldUntil = t + fxDur(L, 300); break;
      case 'extraTime': { const d = Math.max(0, Math.min(120 * sc(L), L.compassAt - t - 1000)); L.endsAt -= d; L.compassAt -= d; note = ` (−${Math.round(d / 1000)} s)`; break; }
      case 'revive': {
        const c = [...L.players.values()].filter(p => p.caught && (p.startRole || 'hider') === 'hider').sort((a, b) => a.caughtAt - b.caughtAt)[0];
        if (!c) return fail('Nobody to revive');
        c.caught = false; c.caughtAt = 0; c.caughtBy = null; c.role = 'hider'; c.held = null; c.houndUntil = 0; trail(L, c, true);
        note = ` — ${c.name} is back in the game!`; send(c.ws, { type: 'revived' }); break; }
      case 'sonar': { let n = 0;
        for (const h of activeHiders(L)) if (me.loc && h.loc && !h.silent && distM(me.loc, h.loc) <= 75) { send(h.ws, { type: 'chime', sonar: true }); n++; }
        for (const h of activeHiders(L)) send(h.ws, { type: 'sonar', by: me.name });
        if (n) for (const p of hunterList(L)) send(p.ws, { type: 'chimeNearby', n });
        send(me.ws, { type: 'puNote', text: `🔊 Sonar: ${n} hider${n === 1 ? '' : 's'} chimed within 75 m` }); break; }
      case 'truth': L.truthNext = true; break;
      case 'shrink': { const f = PU.shrinkField(L.field, 0.7, hunterList(L).filter(p => p.loc).map(p => p.loc), [...L.players.values()].filter(p => p.loc && !(p.role === 'hider' && p.caught)).map(p => p.loc));
        if (!f) return fail('Shrink Zone needs GPS fixes'); L.shrink = { until: t + fxDur(L, 180), field: f }; break; }
      case 'campeek': requestPhotos(L); break;
      case 'heat': { const since = t - Math.max(10000, 120 * sc(L)), until = t + fxDur(L, 30);
        send(me.ws, { type: 'heatTrail', until, trails: Object.fromEntries(activeHiders(L).map(h => [h.id, { name: h.name, pts: (L.trails[h.id] || []).filter(q => q[0] >= since).map(q => [q[1], q[2]]) }])) }); break; }
      case 'hound': me.houndUntil = t + fxDur(L, 60); L.nextHoundAt = 0; break;
    }
    me.held = null; me.lastUse = t; me.used++;
    const [icon, label] = PU.INFO[type], who = hiderSide ? 'A hider' : `Hunter ${me.name}`;
    logEv(L, 'power', { id: me.id, ptype: type, side: hiderSide ? 'hider' : 'hunter' }, `${icon} ${me.name} used ${label}${note}`);
    event(L, `${icon} ${who} used ${label}!${note}`);
    for (const p of L.players.values()) send(p.ws, { type: 'powerUsed', ptype: type, side: hiderSide ? 'hider' : 'hunter', who, icon, label, note, mine: p === me });
    broadcast(L);
  }
  function shieldBlocks(L, h, by) {
    if (!(h.shieldUntil > now())) return false;
    h.shieldUntil = 0; logEv(L, 'power', { id: h.id, ptype: 'shieldBlock', side: 'hider' }, `🛡️ ${h.name}'s shield blocked a catch`);
    event(L, '🛡️ Shield blocked a catch!');
    for (const x of [h, by].filter(Boolean)) send(x.ws, { type: 'shieldBlocked', hider: h.name, by: by ? by.name : null });
    broadcast(L); return true;
  }

  // ---- v16 hider mini-tasks ----
  const TASKS_PER_GAME = { off: 0, normal: 3, often: 5 };
  const taskWindow = L => opts.taskWindowMs ?? Math.max(25000, 60000 * scale(L)); // time to open it before it expires
  const taskBonus = L => 30 * sc(L);
  function scheduleTasks(L) { // spaced out over the hunt, before sudden death
    const n = TASKS_PER_GAME[L.settings.tasks] || 0, g = L.settings.gameSec * 1000; L.taskTimes = []; L.taskIdx = 0;
    const last = (L.settings.features.compass ? L.compassAt : L.endsAt) - taskWindow(L) - 25000;
    for (let k = 0; k < n; k++) { const at = L.hideEndsAt + g * (0.1 + 0.7 * (k + 0.2 + 0.6 * Math.random()) / n); if (at < last) L.taskTimes.push(Math.round(at)); }
    const tt = opts.taskTimes || (env.SCRAM_TEST_TASK_AT ? env.SCRAM_TEST_TASK_AT.split(',').map(Number) : null);
    if (tt) L.taskTimes = tt.map(d => L.hideEndsAt + d); // test hook
  }
  function offerTask(L, h, type) {
    const k = Tasks.make(type || opts.taskType || (env.SCRAM_TEST_TASK ? env.SCRAM_TEST_TASK.split(',')[(L.taskIdx - 1) % env.SCRAM_TEST_TASK.split(',').length] : undefined)); k.offeredAt = now(); k.expiresAt = k.offeredAt + taskWindow(L); h.task = k;
    send(h.ws, { type: 'taskOffer', task: Tasks.pub(k) }); send(h.ws, viewFor(L, h));
  }
  function finishTask(L, h, ok, reason) {
    const k = h.task; if (!k) return; h.task = null;
    if (ok) {
      const d = Math.max(0, Math.min(taskBonus(L), (L.settings.features.compass ? L.compassAt : L.endsAt) - now() - 1000)); L.endsAt -= d; if (L.compassAt) L.compassAt -= d;
      logEv(L, 'task', { id: h.id, ok: true, kind: k.type }, `🧩 ${h.name} completed a task (−${Math.round(d / 1000)} s)`);
      send(h.ws, { type: 'taskResult', ok: true, kind: k.type, bonusSec: Math.round(d / 1000) });
      broadcast(L);
    } else {
      h.noisy = true; logEv(L, 'task', { id: h.id, ok: false, kind: k.type }, `🧩 ${h.name} ${reason === 'expired' ? 'ignored' : 'failed'} a task`);
      send(h.ws, { type: 'taskResult', ok: false, kind: k.type, reason }); send(h.ws, viewFor(L, h));
    }
  }
  function holdFix(L, h) { const k = h.task; if (!k || k.type !== 'hold' || !k.startedAt || h.role !== 'hider') return;
    const pt = { lat: h.loc.lat, lng: h.loc.lng };
    if (!k.start) { k.start = pt; k.fixes = 1; return; }
    k.fixes++; k.maxD = Math.max(k.maxD, distM(k.start, pt));
    if (k.maxD > Tasks.HOLD_R + Math.min(10, (h.loc.acc || 0) / 4)) finishTask(L, h, false, 'moved'); }
  function tickTasks(L) {
    const t = now();
    if (L.taskIdx < (L.taskTimes || []).length && t >= L.taskTimes[L.taskIdx] && !inCompass(L)) { L.taskIdx++;
      for (const h of activeHiders(L)) if (!h.task) offerTask(L, h); }
    for (const h of activeHiders(L)) { const k = h.task; if (!k) continue;
      if (k.type === 'hold' && k.startedAt) { if (t >= k.startedAt + k.limitMs) finishTask(L, h, k.start && k.fixes >= 3 && k.maxD <= Tasks.HOLD_R + 10, 'moved'); else if (t > k.startedAt + k.limitMs + Tasks.GRACE) finishTask(L, h, false, 'timeout'); continue; }
      if (k.startedAt && t > k.startedAt + k.limitMs + Tasks.GRACE) finishTask(L, h, false, 'timeout');
      else if (!k.startedAt && t > k.expiresAt) finishTask(L, h, false, 'expired'); }
  }
  // ---- v17 automatic proximity tag (server-only; positions never leave the server) ----
  const GPS_CFG_EVERY = opts.gpsCfgEveryMs ?? 20000, NEAR_HOLD = opts.tagNearHoldMs ?? 15000, TAG_MS = opts.tagMs ?? 10000, TAG_GRACE = opts.tagGraceMs ?? 1500, TAG_FRESH = 8000, TAG_MAX_ACC = 30;
  // v19: GPS gaps (no fresh fix from a phone) PAUSE the ring; only confirmed out-of-range positions reset it (after the grace).
  const TAG_LIVE = opts.tagLiveMs ?? 4500, TAG_GAP = opts.tagGapMs ?? 8000, TAG_FB_MIN = 0.3, FB_CLAIM_MS = opts.tagClaimMs ?? 30000, FB_HIDER_MS = opts.tagHiderMs ?? 15000, FB_HOST_MS = 60000;
  function tagFallback(L, h, x) { // hider's GPS went quiet mid-tag: hunter may claim, hider confirms, else the host decides
    L.tagFb ||= new Map(); for (const f of L.tagFb.values()) if (f.hiderId === h.id) return;
    const key = rid(6), f = { key, hunterId: x.id, hiderId: h.id, phase: 'hunter', at: now() }; L.tagFb.set(key, f);
    send(x.ws, { type: 'tagFallback', key, expiresAt: f.at + FB_CLAIM_MS }); // no position, no name
    logEv(L, 'tagfb', { id: h.id, by: x.id }, `📶 ${h.name}'s GPS went quiet during a tag by ${x.name}`);
  }
  function fbDone(L, f, ok, why) {
    L.tagFb.delete(f.key); const h = L.players.get(f.hiderId), x = L.players.get(f.hunterId), host = L.players.get(L.hostId);
    for (const p of [h, x, host]) if (p) send(p.ws, { type: 'tagFbEnd', key: f.key, ok, why });
    if (ok && h && x && h.role === 'hider' && !h.caught) { logEv(L, 'autotag', { id: h.id, by: x.id, fallback: why }, `📍 Tag confirmed (${why}): ${x.name} tagged ${h.name}`); catchHider(L, h, x, true); }
  }
  function tickTagFb(L) {
    if (!L.tagFb || !L.tagFb.size) return; const t = now();
    for (const f of [...L.tagFb.values()]) {
      const h = L.players.get(f.hiderId), x = L.players.get(f.hunterId);
      if (!h || !x || h.caught || h.role !== 'hider' || !isHunter(x)) { fbDone(L, f, false, 'gone'); continue; }
      if (f.phase === 'hunter' && t > f.at + FB_CLAIM_MS) fbDone(L, f, false, 'unclaimed');
      else if (f.phase === 'hider' && t > f.askedAt + FB_HIDER_MS) { f.phase = 'host'; f.hostAt = t; send(h.ws, { type: 'tagFbEnd', key: f.key, ok: null, why: 'host' });
        const host = L.players.get(L.hostId); send(host?.ws, { type: 'tagHost', key: f.key, hunter: x.name, hider: h.name }); }
      else if (f.phase === 'host' && t > f.hostAt + FB_HOST_MS) fbDone(L, f, false, 'timeout');
    }
  }
  function tickTags(L) {
    const R = L.settings.autoTag, t = now(); if (!L.tags) L.tags = new Map();
    tickTagFb(L);
    if (!R) return;
    const o = { ...TagCore.DEF, R, tagMs: TAG_MS, farMs: Math.min(TagCore.DEF.farMs, TAG_GRACE * 2), windowMs: opts.tagWindowMs ?? TagCore.DEF.windowMs, minSamples: opts.tagMinSamples ?? TagCore.DEF.minSamples, zoneMs: opts.tagZoneMs ?? TagCore.DEF.zoneMs };
    const hunters = [...L.players.values()].filter(p => isHunter(p) && p.loc);
    const prog = new Map(), paused = new Set(), boost = new Set(), dbg = new Map();
    const bump = (id, v, pz, d) => { if (v >= (prog.get(id) || 0)) { prog.set(id, v); if (pz) paused.add(id); else paused.delete(id); if (d) dbg.set(id, d); } };
    for (const h of activeHiders(L)) {
      if (!h.loc) continue;
      for (const x of hunters) {
        const key = x.id + '>' + h.id; let g = L.tags.get(key); if (!g) { g = TagCore.newPair(t); L.tags.set(key, g); } // every hunter x hider pair is tracked (history matters)
        const hAge = t - h.loc.recvAt, xAge = t - x.loc.recvAt, live = hAge <= TAG_LIVE && xAge <= TAG_LIVE;
        // v20 approach phase: a hunter may be within ~40 m (generous: minus both accuracies + walking since the fixes) ->
        // fast GPS on both phones now, before any ring progress (Saver's 15 s uploads would starve the tag of samples)
        if (TagCore.near(h.loc, x.loc, t, o)) g.nearUntil = t + NEAR_HOLD;
        if (t < (g.nearUntil || 0)) { boost.add(h.id); boost.add(x.id); }
        if (!live) { // GPS gap: pause, don't reset
          g.lastT = t; if (g.acc <= 0) continue; const p = Math.min(0.99, g.acc / o.tagMs);
          if (t - (g.lastSampleT || t) > TAG_GAP) { g.acc = 0; g.samples = []; if (hAge > TAG_LIVE && p >= TAG_FB_MIN) tagFallback(L, h, x); continue; }
          bump(h.id, p, true, g.dbg); bump(x.id, p, true, g.dbg); boost.add(h.id); boost.add(x.id); continue;
        }
        const fx = h.loc.recvAt + ':' + x.loc.recvAt; let sample = null;
        if (fx !== g.fx) { g.fx = fx; g.lastSampleT = t; sample = { a: TagCore.smooth(h.fixHist, t, o) || h.loc, b: TagCore.smooth(x.fixHist, t, o) || x.loc }; }
        const res = TagCore.step(g, t, sample, o);
        if (res === 'tag') {
          for (const k of [...L.tags.keys()]) if (k.endsWith('>' + h.id)) L.tags.delete(k);
          h.tagP = x.tagP = 0; send(h.ws, { type: 'tagProg', p: 0, paused: false, role: 'hider' }); send(x.ws, { type: 'tagProg', p: 0, paused: false, role: 'hunter' });
          logEv(L, 'autotag', { id: h.id, by: x.id }, `📍 Auto-tag: ${x.name} stayed next to ${h.name}`);
          catchHider(L, h, x); if (L.state !== 'playing') return; break;
        }
        if (g.ratio > 0) { boost.add(h.id); boost.add(x.id); } // anything close in the window: fast GPS on both phones
        if (g.acc > 0) { const p = Math.min(0.99, g.acc / o.tagMs); bump(h.id, p, res === 'pause', g.dbg); bump(x.id, p, res === 'pause', g.dbg); }
        else if (g.dbg && (g.ratio > 0 || L.settings.tagDebug)) { for (const id of [h.id, x.id]) if (!dbg.has(id) || (dbg.get(id).d ?? 1e9) > g.dbg.d) dbg.set(id, g.dbg); }
      }
    }
    for (const k of [...L.tags.keys()]) { const [a, b] = k.split('>'); const x = L.players.get(a), h = L.players.get(b); if (!x || !h || !isHunter(x) || h.caught || h.role !== 'hider') L.tags.delete(k); }
    const dbgOn = !!L.settings.tagDebug;
    for (const p of L.players.values()) { // send only on change; hunters get a bare number (no id, no direction, no distance)
      const v = Math.round((prog.get(p.id) || 0) * 20) / 20, pz = v > 0 && paused.has(p.id), isHost = p.id === L.hostId;
      const d = dbgOn && isHost ? dbg.get(p.id) || null : null, dj = d ? JSON.stringify(d) : '';
      if (v !== (p.tagP || 0) || pz !== !!p.tagPz || dj !== (p.tagDbg || '')) { p.tagP = v; p.tagPz = pz; p.tagDbg = dj;
        if (L.state === 'playing') send(p.ws, { type: 'tagProg', p: v, paused: pz, role: isHunter(p) ? 'hunter' : 'hider', ...(d ? { dbg: d } : {}) }); } // dbg: host's own phone only, when the host turned it on
      const b = boost.has(p.id) && L.state === 'playing'; // v20.1: one routine-looking GPS setting for everyone (same type + shape on/off, also re-sent every 20 s):
      if (L.state === 'playing' && (b !== !!p.boost || t - (p.cfgAt || 0) >= GPS_CFG_EVERY)) { p.boost = b; p.cfgAt = t; send(p.ws, { type: 'gpsCfg', intervalMs: b ? 1000 : 4000, maxAgeMs: b ? 0 : 3000, highAcc: true }); }
    }
  }
  // ---- v18 post-round Regroup: only while L.state === 'ended' (all in-game secrecy rules are untouched) ----
  const RG_EVERY = opts.regroupMs ?? 2000, RG_FRESH = 120000, FB_MAX = 500;
  const rgAnchor = L => L.players.get(L.creatorId) || L.players.get(L.hostId) || null;
  function rgTrend(p) { const h = p.rgHist || []; if (h.length < 2) return null; const a = h[0], b = h[h.length - 1]; if (b.t - a.t < 4000) return null;
    const dd = b.d - a.d; return dd < -4 ? 'closer' : dd > 4 ? 'away' : 'stopped'; }
  function sendRegroup(L, only) {
    if (L.state !== 'ended' || !L.rg) return; const t = now(), A = rgAnchor(L); if (!only) L.rg.at = t;
    const aLoc = A && A.loc && t - A.loc.recvAt < RG_FRESH ? A.loc : null;
    const ps = [...L.players.values()];
    const distOf = p => aLoc && p.loc && t - p.loc.recvAt < RG_FRESH ? Math.round(distM(aLoc, p.loc)) : null;
    if (!only) for (const p of ps) { const d = distOf(p); if (d == null || p === A) { p.rgHist = []; continue; }
      p.rgHist = (p.rgHist || []).filter(x => t - x.t < 20000); if (!p.rgHist.length || t - p.rgHist[p.rgHist.length - 1].t >= 1500) p.rgHist.push({ t, d }); }
    const others = ps.filter(p => p !== A && p.id !== L.hostId);
    const rows = ps.filter(p => p.id !== L.hostId).map(p => ({ id: p.id, name: p.name, status: p.rgChoice || 'none', dist: p === A ? 0 : distOf(p), trend: p === A ? null : rgTrend(p), anchor: p === A,
      conn: p.byeAt ? 'closed' : p.connected ? 'ok' : 'offline', fb: !!p.fbDone }));
    const panel = { rows, waiting: rows.filter(r => r.status === 'none').length, total: rows.length, inCount: rows.filter(r => r.status === 'in').length + 1, fb: L.rg.fb };
    for (const p of only ? [only] : ps) {
      if (!p.ws) continue;
      const msg = { type: 'regroup', round: L.rg.round, anchor: A ? { id: A.id, name: A.name, isCreator: A.id === L.creatorId, loc: aLoc ? { lat: aLoc.lat, lng: aLoc.lng, acc: aLoc.acc, age: t - aLoc.recvAt } : null } : null,
        me: { choice: p.rgChoice || null, dist: p === A ? 0 : distOf(p), fbDone: !!p.fbDone } };
      if (p.id === L.hostId || p.id === L.creatorId) msg.panel = panel; // only the host / creator get everyone's status and distance
      send(p.ws, msg);
    }
  }
  function resetFeatures(L, ps) {
    L.bounty = null; L.photos = {}; L.camAt = L.compassAt = L.nextBountyAt = L.nextCompassAt = L.camDeadline = 0; L.compassAnnounced = false;
    for (const p of ps) { p.decoys = 2; p.decoyArmed = false; p.wipeNext = false; p.outSince = 0; p.oobReveal = false; p.held = null; p.lastUse = 0; p.pickup = null; p.silent = false; p.shieldUntil = p.radarUntil = p.houndUntil = 0; p.used = 0; p.fullWarned = false; p.task = null; p.noisy = false; p.tagP = 0; p.tagPz = false; p.boost = false; p.tagDbg = ""; }
    L.drops.clear(); L.nextDropAt = 0; L.jamUntil = 0; L.truthNext = false; L.shrink = null; L.taskTimes = []; L.taskIdx = 0; L.tags = new Map(); L.tagFb = new Map();
  }
  function rematch(L) {
    if (L.state !== 'ended') return;
    L.rg = null; L.state = 'lobby'; L.pings = []; L.winner = null; L.events = []; L.startedAt = L.hideEndsAt = L.endsAt = L.nextPingAt = L.endedAt = 0;
    L.idleSince = now(); resetFeatures(L, [...L.players.values()]); clearRound(L);
    for (const p of L.players.values()) { p.caughtBy = null; p.caught = false; p.caughtAt = 0; p.revealedAt = 0; if (p.startRole) p.role = p.startRole; }
    broadcast(L);
  }

  function leave(L, p) {
    if (!L.players.has(p.id)) return;
    L.players.delete(p.id); L.pick.ids.delete(p.id);
    send(p.ws, { type: 'left' }); p.ws = null;
    if (L.players.size === 0) { lobbies.delete(L.code); return; }
    if (L.hostId === p.id) {
      const next = [...L.players.values()].find(x => x.connected) || L.players.values().next().value;
      setHost(L, next); event(L, `${p.name} left — ${next.name} is now host`);
    } else event(L, `${p.name} left`);
    if (L.state === 'playing' || L.state === 'hiding') {
      const ps = [...L.players.values()];
      if (!activeHiders(L).length) return endGame(L, 'hunters');
      if (!ps.some(isHunter)) return endGame(L, 'hiders');
    }
    broadcast(L);
  }

  wss.on('connection', (ws, req) => {
    let L = null, me = null;
    const who = clientIp(req || {}); let tokens = MSG_BURST, tokAt = Date.now(), dropped = 0;
    ws.on('message', raw => {
      { const t = Date.now(); tokens = Math.min(MSG_BURST, tokens + (t - tokAt) / 1000 * MSG_RATE); tokAt = t; } // per-socket flood guard
      if (tokens < 1) { if (++dropped > 300) ws.close(1008, 'Too many messages'); return; } tokens--;
      const len = raw.length || 0;
      if (len > PRE_JOIN_MAX && (!me || (len > JOINED_MAX && L.state !== 'ended'))) return ws.close(1009, 'Message too large');
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') return; // JSON null / numbers / arrays used to crash the server
      try { onMsg(m); } catch (e) { console.error('[ws] message error', m.type, e && e.message); }
    });
    function onMsg(m) {
      // kicked / lobby deleted / left: this socket is no longer a player, so it may create or join again
      if (me && (lobbies.get(L.code) !== L || L.players.get(me.id) !== me)) { me = null; L = null; }
      if (m.type === 'time') return send(ws, { type: 'time', c: Number(m.c) || 0, s: now() }); // NTP-style clock sync round trip
      if (m.type === 'pollSub') { const c = String(m.code || '').toUpperCase(); if (!POLL_RE.test(c)) return;
        if (ws.pollCode) { const o = pollSubs.get(ws.pollCode); o?.delete(ws); if (o && !o.size) pollSubs.delete(ws.pollCode); } ws.pollCode = c; if (!pollSubs.has(c)) pollSubs.set(c, new Set()); if (pollSubs.get(c).size < 200) pollSubs.get(c).add(ws);
        return void polls.ensure(c).catch(() => {}).then(() => { const v = polls.view(c); send(ws, v ? { type: 'poll', poll: v } : { type: 'poll', code: c, gone: true }); }); }
      if (!me) {
        if ((m.type === 'create' || m.type === 'join') && m.agreed !== true) return send(ws, { type: 'error', error: 'Please confirm you are 18+ and agree to the Terms and Privacy Policy', consent: true });
        const dev = typeof m.dev === 'string' ? m.dev : null, ref = normHandle(String(m.ref || '')) || null, social = socialIn(m);
        if ((m.type === 'create' || m.type === 'join') && !who.local && ipLimit.hit((m.type === 'create' ? 'c:' : 'j:') + who.ip, m.type === 'create' ? CREATE_PER_IP : JOIN_PER_IP, 600e3))
          return send(ws, { type: 'error', error: 'Too many tries from your network. Wait a few minutes and try again.', rate: true });
        if (m.type === 'create') {
          if (stats.canCreate(liveCounts().games)) return send(ws, { type: 'error', error: BUSY_MSG, busy: true });
          L = newLobby(); me = addPlayer(L, m.name, social); L.creatorId = me.id; /* v18: the original creator is the regroup point, even after a host handoff */ stats.gameCreated(dev, ref); if (me.social) stats.handle(me.social, { ref });
        }
        else if (m.type === 'join') {
          L = lobbies.get(String(m.code || '').toUpperCase());
          if (!L) return send(ws, { type: 'error', error: 'Lobby not found' });
          if (L.players.size >= MAX_PLAYERS) { const n = L.players.size; L = null; return send(ws, { type: 'error', error: `Lobby is full (${n}/${MAX_PLAYERS})`, full: true }); }
          me = addPlayer(L, m.name, social); stats.player(dev, ref); if (me.social) stats.handle(me.social, { ref });
          if (L.state === 'playing' || L.state === 'hiding') me.role = 'hunter'; // late joiners hunt (can't be fairly hidden)
        } else if (m.type === 'rejoin') {
          L = lobbies.get(String(m.code || '').toUpperCase());
          me = L && [...L.players.values()].find(p => p.token === m.token);
          if (!me) { L = null; return send(ws, { type: 'error', error: 'Session expired', reset: true }); }
          if (me.ws && me.ws !== ws) { send(me.ws, { type: 'replaced' }); try { me.ws.close(4001, 'replaced'); } catch {} } // the old tab stops auto-reconnecting (no tab ping-pong)
        } else if (m.type === 'peek') { // pre-rejoin check: is my saved session still alive? (token-gated, no locations)
          const PL = lobbies.get(String(m.code || '').toUpperCase()), p = PL && [...PL.players.values()].find(x => x.token === m.token);
          return send(ws, p ? { type: 'session', ok: true, code: PL.code, state: PL.state, name: p.name, ...(preReveal(PL) ? {} : { role: p.role, caught: p.caught }) } : { type: 'session', ok: false });
        } else return;
        me.ws = ws; me.connected = true; me.discAt = 0; me.byeAt = 0; if (!running(L)) L.idleSince = now();
        send(ws, { type: 'joined', code: L.code, id: me.id, token: me.token });
        broadcast(L);
        if (L.state === 'ended') send(ws, { type: 'recap', recap: buildRecap(L) });
        if (L.plan && polls.get(L.plan.code)) send(ws, { type: 'plan', ...L.plan });
        if (L.state === 'ended') sendRegroup(L, me);
        if (isHunter(me) && !preReveal(L)) for (const [id, ph] of Object.entries(L.photos)) send(ws, { type: 'camPeek', id, ...ph });
        return;
      }
      const host = me.id === L.hostId;
      if (!running(L) && m.type !== 'loc' && m.type !== 'sync') L.idleSince = now(); // an active lobby / recap is not idle
      switch (m.type) {
        case 'loc': {
          const lat = Number(m.lat), lng = Number(m.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return; // (0,0) = "null island" bogus fix
          const first = !me.loc, ts = Number(m.ts), tn = now();
          me.loc = { lat, lng, acc: clampNum(m.acc, 0, 1e5, 999), ts: Number.isFinite(ts) && Math.abs(ts - tn) < 864e5 ? ts : tn, recvAt: tn };
          me.fixHist ||= []; TagCore.pushFix(me.fixHist, { lat, lng, acc: me.loc.acc, t: tn }); trail(L, me); holdFix(L, me);
          if (L.state === 'playing' && L.drops.size) checkPickups(L);
          // Only hunters' live positions are pushed; hider updates trigger no broadcast with coords.
          const of = outFlag(L, me), ofChanged = of !== me.lastOut; me.lastOut = of;
          const permNew = first || me.perm !== 'granted'; me.perm = 'granted';
          if (tryClaim(L, me) || permNew || (L.state === 'lobby' && ofChanged)) broadcast(L);
          else if (isHunter(me) && !preReveal(L)) broadcast(L);
          else if (L.settings.teammates && me.role === 'hider' && !me.caught && running(L)) { for (const p of activeHiders(L)) if (p.ws) send(p.ws, viewFor(L, p)); } // only uncaught hiders get this update
          else send(ws, viewFor(L, me));
          break;
        }
        case 'plan': { const c = String(m.code || '').toUpperCase(); // a poll for the next game, shown on everyone's recap
          if ((host || env.PLAN_ANYONE === '1') && polls.get(c)) { L.plan = { code: c, by: me.name }; for (const p of L.players.values()) send(p.ws, { type: 'plan', ...L.plan }); } break; }
        case 'ig': case 'social': me.social = socialIn(m); L.recapCache = null; if (me.social && (me.socialN = (me.socialN || 0) + 1) <= 10) stats.handle(me.social); // cap stored handles per player if (L.state === 'lobby' || L.state === 'ended') broadcast(L); break;
        case 'perm': me.perm = ['granted', 'denied', 'prompt', 'unsupported', 'error'].includes(m.perm) ? m.perm : 'unknown'; broadcast(L); break;
        case 'taskStart': { const k = me.task; if (!k || k.id !== m.id || me.role !== 'hider' || me.caught || L.state !== 'playing') break;
          if (!k.startedAt) { k.startedAt = now(); if (k.type === 'hold') { k.start = null; k.fixes = 0; k.maxD = 0; send(ws, { type: 'need_fix', at: now() }); } }
          send(ws, viewFor(L, me)); break; }
        case 'taskSubmit': { const k = me.task; if (!k || k.id !== m.id || !k.startedAt || k.type === 'hold') break;
          finishTask(L, me, Tasks.check(k, m.answer) && now() <= k.startedAt + k.limitMs + Tasks.GRACE, 'wrong'); break; }
        case 'settings': if (host && L.state === 'lobby') {
          const s = m.settings || {};
          L.settings.gameSec = clampNum(s.gameSec, minSec * 2, 6 * 3600, L.settings.gameSec);
          L.settings.pingSec = clampNum(s.pingSec, minSec, 3600, L.settings.pingSec);
          L.settings.hideSec = clampNum(s.hideSec, 0, 3600, L.settings.hideSec);
          if ('caughtBecomeHunter' in s) L.settings.caughtBecomeHunter = !!s.caughtBecomeHunter;
          if ('showRevealed' in s) L.settings.showRevealed = !!s.showRevealed;
          if ('teammates' in s) L.settings.teammates = !!s.teammates;
          if (['off', 'normal', 'chaos'].includes(s.powerups)) L.settings.powerups = s.powerups;
          if (['off', 'normal', 'often'].includes(s.tasks)) L.settings.tasks = s.tasks;
          if ([0, 2, 3, 5].includes(s.autoTag)) L.settings.autoTag = s.autoTag;
          if ('manualTag' in s) L.settings.manualTag = !!s.manualTag;
          if ('tagDebug' in s) L.settings.tagDebug = !!s.tagDebug;
          if ('chimeVol' in s) L.settings.chimeVol = Math.round(clampNum(s.chimeVol, 10, 100, L.settings.chimeVol));
          if (s.features && typeof s.features === 'object') for (const f of FEATURES) if (f in s.features) L.settings.features[f] = !!s.features[f];
          if (s.mode && MODES[s.mode] && s.mode !== 'custom') applyMode(L.settings, s.mode); // a preset wins over the individual toggles
          else { const M = MODES[L.settings.mode]; if (s.mode === 'custom' || (M?.features && (L.settings.powerups !== M.powerups || L.settings.tasks !== M.tasks || L.settings.autoTag !== M.autoTag || FEATURES.some(f => L.settings.features[f] !== M.features[f])))) L.settings.mode = 'custom'; }
          broadcast(L);
        } break;
        case 'field': if (host && (L.state === 'lobby' || L.state === 'ended')) {
          const res = Field.validate(m.field);
          if (res.error) return send(ws, { type: 'error', error: res.error });
          L.field = res.field; broadcast(L);
        } break;
        case 'role': if (host && L.state === 'lobby') { // host-only manual pick (switches to manual mode); stays secret until the reveal
          const p = L.players.get(m.id); if (!p || !['hunter', 'hider'].includes(m.role)) break;
          if (!L.pick.manual) { L.pick.manual = true; L.pick.ids = new Set(); }
          if (m.role === 'hunter') L.pick.ids.add(p.id); else L.pick.ids.delete(p.id); send(ws, viewFor(L, me));
        } break;
        case 'randomize': case 'pick': if (host && L.state === 'lobby') { // random deal at start with N hunters (default), or toggle manual mode
          if (m.hunters != null) L.pick.hunters = Math.max(1, Math.min(MAX_PLAYERS - 1, Number(m.hunters) || 1));
          L.pick.manual = m.type === 'pick' ? !!m.manual : false; if (!L.pick.manual) L.pick.ids = new Set(); send(ws, viewFor(L, me));
        } break;
        case 'kick': if (host && L.state === 'lobby' && m.id !== me.id) { const p = L.players.get(m.id); if (p) { send(p.ws, { type: 'gone', kicked: true }); p.ws = null; p.connected = false; L.players.delete(m.id); L.pick.ids.delete(m.id); broadcast(L); } } break;
        case 'start': if (host && L.state === 'lobby') {
          const ps = [...L.players.values()];
          if (L.field && !m.force) {
            const outside = ps.filter(p => !p.loc || !Field.inField(L.field, p.loc)).map(p => ({ id: p.id, name: p.name, noGps: !p.loc }));
            if (outside.length) return send(ws, { type: 'startBlocked', outside });
          }
          { const err = dealRoles(L, ps); if (err) return send(ws, { type: 'error', error: err }); }
          const t = now() + revealMs; L.revealAt = t; L.startedAt = t; stats.gameStarted(); for (const p of L.players.values()) if (p.social) stats.handle(p.social, { played: true }); L.hideEndsAt = t + L.settings.hideSec * 1000;
          L.endsAt = L.hideEndsAt + L.settings.gameSec * 1000;
          L.chimeTest = null;
          L.state = L.settings.hideSec > 0 ? 'hiding' : 'playing'; L.round++; L.pings = []; L.events = [];
          for (const p of ps) { p.startRole = p.role; p.caught = false; p.caughtAt = 0; p.caughtBy = null; p.revealedAt = 0; }
          resetFeatures(L, ps); clearRound(L);
          { const sc = scale(L) * 1000, h = L.hideEndsAt;
            L.nextBountyAt = h + 300 * sc; L.camAt = h + 600 * sc; L.compassAt = h + 1080 * sc; L.nextCompassAt = 0; }
          scheduleDrops(L); scheduleTasks(L); loadWalk(L);
          if (L.state === 'playing') L.nextPingAt = t + L.settings.pingSec * 1000;
          else L.nextPingAt = L.hideEndsAt + L.settings.pingSec * 1000;
          event(L, L.state === 'hiding' ? 'Hiders, go hide!' : 'Hunt is on!'); logEv(L, 'start', {}, L.state === 'hiding' ? '🙈 Head start — hiders go hide' : '🔦 Hunt is on');
          for (const p of ps) trail(L, p, true);
          broadcast(L); L.revealSent = L.revealAt <= now(); // roles go out at revealAt (timer, with the tick as a fallback)
          if (!L.revealSent) { const r = L.round; setTimeout(() => { if (!L.revealSent && L.round === r && (L.state === 'playing' || L.state === 'hiding') && now() >= L.revealAt) { L.revealSent = true; broadcast(L); } }, L.revealAt - now() + 1); }
        } break;
        case 'cam': me.cam = ['granted', 'denied'].includes(m.cam) ? m.cam : 'unknown'; broadcast(L); break;
        case 'decoy': if (me.role === 'hider' && !me.caught && L.settings.features.decoy && (L.state === 'playing' || L.state === 'hiding') && !inCompass(L) && me.decoys > 0 && !me.decoyArmed) {
          me.decoys--; me.decoyArmed = true; logEv(L, 'decoy', { id: me.id }, `👻 ${me.name} armed a decoy`); send(ws, viewFor(L, me)); } break;
        case 'claim': if (tryClaim(L, me)) broadcast(L); break;
        case 'camPhoto': { const ph = L.photos[me.id];
          if (!ph || !ph.pending || me.role !== 'hider') break;
          const ok = typeof m.data === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(m.data) && m.data.length < 600000;
          L.photos[me.id] = ok && !m.unavailable ? { name: me.name, data: m.data, t: now() } : { name: me.name, unavailable: true, t: now() }; // memory only
          if (ok && !m.unavailable) logEv(L, 'photo', { id: me.id }, `📷 Sneak-peek photo of ${me.name}`);
          relayPhoto(L, me.id); broadcast(L); } break;
        case 'catch': { const h = L.players.get(m.id);
          if (host && isHunter(me)) catchHider(L, h, me); // host override: immediate (always, even with manual tags off)
          else if (isHunter(me) && L.settings.manualTag !== false) claimCatch(L, h, me, 'hunter'); break; }
        case 'tagDebug': if (host) { L.settings.tagDebug = !!m.on; me.tagDbg = ''; broadcast(L); } break; // host can flip it mid-game too
        case 'tagClaim': { const f = L.tagFb?.get(String(m.key || '')); if (!f || f.phase !== 'hunter' || f.hunterId !== me.id) break;
          f.phase = 'hider'; f.askedAt = now(); const h = L.players.get(f.hiderId); send(h?.ws, { type: 'tagAsk', key: f.key, by: me.name, expiresAt: f.askedAt + FB_HIDER_MS }); send(ws, { type: 'tagFbWait', key: f.key }); break; }
        case 'tagAnswer': { const f = L.tagFb?.get(String(m.key || '')); if (!f || f.phase !== 'hider' || f.hiderId !== me.id) break; fbDone(L, f, !!m.yes, m.yes ? 'hider' : 'denied'); break; }
        case 'tagHostAnswer': { const f = L.tagFb?.get(String(m.key || '')); if (!f || f.phase !== 'host' || !host) break; fbDone(L, f, !!m.yes, m.yes ? 'host' : 'host-denied'); break; }
        case 'caughtSelf': if (me.role === 'hider' && L.settings.manualTag !== false) claimCatch(L, me, null, 'hider'); break;
        case 'usePower': usePower(L, me); break;
        case 'chimeTest': if (host && L.state === 'lobby') { // preview on every phone; throttled to once per 1.5 s
          const t = now(); if (t - (L.chimeTestAt || 0) < CHIME_THROTTLE) break;
          if ('vol' in m) L.settings.chimeVol = Math.round(clampNum(m.vol, 10, 100, L.settings.chimeVol));
          L.chimeTestAt = t; L.chimeTest = { id: rid(3), vol: L.settings.chimeVol, votes: new Map() };
          for (const p of L.players.values()) send(p.ws, { type: 'chimeTest', id: L.chimeTest.id, vol: L.settings.chimeVol });
          broadcast(L);
        } break;
        case 'chimeVote': if (L.state === 'lobby' && L.chimeTest && m.id === L.chimeTest.id && ['good', 'quiet', 'loud'].includes(m.vote)) { L.chimeTest.votes.set(me.id, m.vote); broadcast(L); } break;
        case 'catchAnswer': answerCatch(L, me, m.pid, !!m.yes); break;
        case 'recap': { const r = buildRecap(L); if (r) send(ws, { type: 'recap', recap: r }); break; }
        case 'hlUpload': { // opt-in highlight cuts for the host's group reel (memory only, 30 min / Play again)
          if (L.state !== 'ended' || !Array.isArray(m.cuts)) return send(ws, { type: 'hlAck', ok: false, error: 'Only after the game' });
          const cuts = []; let tot = 0;
          for (const c of m.cuts.slice(0, 12)) {
            if (!c || typeof c !== 'object' || typeof c.data !== 'string' || !/^data:video\/(webm|mp4)[^,]*;base64,[A-Za-z0-9+/=]+$/.test(c.data) || c.data.length > HL_CUT_MAX * 1.37) continue;
            const dur = Number(c.dur); if (!(dur > 0 && dur <= 10.5)) continue;
            tot += c.data.length * 0.75; if (tot > HL_MAX) break;
            cuts.push({ data: c.data, t: Number(c.t) || 0, dur, caption: cleanText(String(c.caption || ''), 40) });
          }
          { let used = 0; for (const X of lobbies.values()) for (const [id, h] of X.highlights) if (!(X === L && id === me.id)) used += h.bytes || 0;
            if (used + tot > HL_TOTAL_MAX) return send(ws, { type: 'hlAck', ok: false, error: 'The server is busy with other reels. Try again in a few minutes.' }); }
          L.highlights.set(me.id, { name: me.name, role: me.startRole || me.role, cuts, t: now(), bytes: Math.min(tot, HL_MAX) });
          send(ws, { type: 'hlAck', ok: true, n: cuts.length }); broadcast(L); break; }
        case 'hlFetch': if (host && L.state === 'ended') send(ws, { type: 'hlAll', players: [...L.highlights.entries()].map(([id, h]) => ({ id, ...h })) }); break;
        case 'end': if (host && L.state !== 'ended' && L.state !== 'lobby') endGame(L, activeHiders(L).length ? 'hiders' : 'hunters'); break;
        case 'sync': send(ws, viewFor(L, me)); break;
        case 'rematch': rematch(L); send(ws, viewFor(L, me)); break;
        case 'regroup': if (L.state === 'ended' && L.rg && ['in', 'done'].includes(m.choice)) { me.rgChoice = m.choice; sendRegroup(L); } break;
        case 'regroupBye': if (L.state === 'ended') { me.byeAt = now(); sendRegroup(L); } break; // tab is closing (pagehide)
        case 'feedback': if (L.state === 'ended' && L.rg && !me.fbDone) { me.fbDone = true;
          const rating = Number.isInteger(m.rating) && m.rating >= 1 && m.rating <= 5 ? m.rating : null, liked = cleanText(m.liked, FB_MAX), improve = cleanText(m.improve, FB_MAX);
          if (m.skip || (!rating && !liked && !improve)) { sendRegroup(L); break; }
          const row = { rating, liked, improve, mode: L.settings.mode, players: L.players.size, round: L.round };
          stats.feedback?.(row);
          L.rg.fb.push({ id: me.id, name: me.name, rating, liked, improve, t: now() }); if (L.rg.fb.length > 40) L.rg.fb.shift();
          for (const id of new Set([L.hostId, L.creatorId])) { const h = L.players.get(id); if (h && h !== me) send(h.ws, { type: 'feedbackIn', name: me.name, rating, liked, improve }); }
          sendRegroup(L); } break;
        case 'notifyMe': if (L.state === 'ended' && !me.notifyDone) { // opt-in: "Ping me for the next game" (@ or email)
          const em = typeof m.email === 'string' ? m.email.trim().toLowerCase() : '';
          let c = null;
          if (em) { if (em.length <= 254 && /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/.test(em) && !/\.\./.test(em)) c = { kind: 'email', email: em }; }
          else { const so = Socials.norm({ handle: String(m.handle || '').slice(0, 120), platform: m.platform }); if (so) c = { kind: 'social', platform: so.platform, handle: so.handle }; }
          if (!c) { send(ws, { type: 'notifyRes', ok: false, error: em ? 'That email doesn’t look right.' : 'That handle doesn’t look right.' }); break; }
          me.notifyDone = !!stats.notify?.(c); send(ws, { type: 'notifyRes', ok: me.notifyDone }); } break;
        case 'nextRound': if (host && L.state === 'ended') { // same room, only the players who are in (host always stays)
          for (const p of [...L.players.values()]) if (p.id !== me.id && p.rgChoice !== 'in') { send(p.ws, { type: 'regroupOut' }); leave(L, p); }
          rematch(L); } break;
        case 'leave': leave(L, me); me = null; L = null; break;
      }
    }
    ws.on('close', () => { if (me && L && me.ws === ws) { me.ws = null; me.connected = false; me.discAt = now(); if (lobbies.has(L.code)) broadcast(L); /* slot kept: never removed or marked caught for disconnecting */ } });
  });

  // keepalive so tunnels don't drop idle sockets
  wss.on('connection', ws => { ws.alive = true; ws.on('pong', () => ws.alive = true); ws.on('close', () => { if (ws.pollCode) { const s = pollSubs.get(ws.pollCode); s?.delete(ws); if (s && !s.size) pollSubs.delete(ws.pollCode); } }); });
  const hb = setInterval(() => { ipLimit.sweep(600e3); wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; try { c.ping(); } catch {} }); }, 20000);
  server.on('close', () => { clearInterval(timer); clearInterval(hb); clearInterval(pollSweep); Promise.resolve(stats.flush()).catch(() => {}); });
  return { ready, stats, polls, liveCounts, DISCONNECT_GRACE_MS, HOST_HANDOFF_MS, app, server, wss, lobbies, refs, spawnDrop, tick, spawnBounty, distM, oobGrace, buildRecap };
}

module.exports = { BUSY_MSG, createApp, distM, bearingDeg, offsetM };
if (require.main === module) {
  const { server, stats, ready } = createApp({ revealMs: process.env.SCRAM_REVEAL_MS ?? 5500 });
  const port = process.env.PORT || 3000;
  const st = stats.storageStatus();
  console.log(st.mode === 'supabase' ? `[storage] Supabase (${st.host})` : `[storage] ${st.mode === 'file' ? 'file fallback (' + st.file + ')' : 'memory only'}: set SUPABASE_URL + SUPABASE_SERVICE_KEY to persist in Supabase`);
  // load from Supabase first (at most ~10 s; if it is down we start anyway, serve from memory and keep retrying)
  ready.then(ok => { if (st.mode === 'supabase' && !ok) console.error('[storage] Supabase not reachable yet; starting from memory, retrying in the background');
    server.listen(port, () => console.log('Scram listening on :' + port)); });
  let stopping = false;
  const shutdown = sig => { if (stopping) return; stopping = true; console.log(`[${sig}] flushing data and exiting`);
    const force = setTimeout(() => process.exit(0), 15000); force.unref();
    Promise.resolve(stats.close()).catch(e => console.error('[storage] final flush failed', e.message)).finally(() => process.exit(0)); };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
}
