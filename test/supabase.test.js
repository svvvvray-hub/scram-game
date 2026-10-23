'use strict';
// Supabase persistence (PostgREST over fetch) against an in-process mock PostgREST server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const WebSocket = require('ws');
const { createApp, BUSY_MSG } = require('../server');
const { createSupabaseStore } = require('../supabase');
const { createStats } = require('../stats');
const { createMock, parseIn } = require('./mock_postgrest');

const KEY = 'sb_secret_TESTKEY_x9QzL2vB7mN4kP1w';
const ADMIN = 'adm-key-42';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(15); } };
const FAST = { throttleMs: 60, backoffMs: 40, maxBackoffMs: 200, timeoutMs: 2000, pollTimeoutMs: 1000 };

async function boot(mock, { env = {}, supabase = {}, wait = true, ...extra } = {}) {
  const a = createApp({ tickMs: 50, quiet: true, statsFile: null, statsThrottleMs: 60, storageWaitMs: 300,
    env: { ADMIN_KEY: ADMIN, ...(mock ? { SUPABASE_URL: mock.url, SUPABASE_SERVICE_KEY: KEY } : {}), ...env }, supabase: { ...FAST, ...supabase }, ...extra });
  a.loaded = wait ? await a.ready : null;
  await new Promise(r => a.server.listen(0, r));
  a.base = `http://127.0.0.1:${a.server.address().port}`; a.wsUrl = a.base.replace('http', 'ws') + '/ws';
  return a;
}
async function stop(a) { await a.stats.close(); a.server.close(); for (const c of a.wss.clients) c.terminate(); }
function client(url) {
  const ws = new WebSocket(url), c = { ws, msgs: [], raw: [] };
  ws.on('message', d => { c.raw.push(String(d)); const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'joined') c.joined = m; if (m.type === 'error') c.error = m; });
  c.send = m => ws.send(JSON.stringify(m)); c.open = new Promise(r => ws.on('open', r));
  return c;
}
async function act(a, type, extra = {}) { const c = client(a.wsUrl); await c.open; c.send({ type, agreed: true, name: 'P', ...extra }); await until(() => c.joined || c.error); return c; }
const post = (a, p, body) => fetch(a.base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const adminGet = (a, p) => fetch(a.base + p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN, { redirect: 'manual' }).then(async r => r.status === 303 ? fetch(a.base + p, { headers: { cookie: r.headers.get('set-cookie').split(';')[0] } }) : r);
const H = 3600e3, day = 864e5;
const pollBody = (o = {}) => ({ times: [Date.now() + 2 * day, Date.now() + 3 * day], places: [{ lat: 37.7596, lng: -122.4269, label: 'Dolores Park' }], name: 'Murray', ...o });
let mock;
test.beforeEach(async () => { mock = await createMock({ key: KEY }).start(); });
test.afterEach(async () => { await mock.stop(); });

test('mock PostgREST: in() parsing, auth, upsert vs insert conflict, delete needs a filter', async () => {
  assert.deepStrictEqual(parseIn('("a.b","c,d",e)'), ['a.b', 'c,d', 'e']);
  const h = { apikey: KEY, 'content-type': 'application/json' }, u = mock.url + '/rest/v1/lastping_kv';
  assert.strictEqual((await fetch(u, { headers: { apikey: 'nope' } })).status, 401);
  assert.strictEqual((await fetch(u, { method: 'POST', headers: h, body: JSON.stringify([{ key: 'a', value: 1 }]) })).status, 201);
  assert.strictEqual((await fetch(u, { method: 'POST', headers: h, body: JSON.stringify([{ key: 'a', value: 2 }]) })).status, 409);
  assert.strictEqual((await fetch(u, { method: 'POST', headers: { ...h, prefer: 'resolution=merge-duplicates' }, body: JSON.stringify([{ key: 'a', value: 3 }]) })).status, 201);
  assert.deepStrictEqual(await (await fetch(u + '?select=key,value&key=eq.a', { headers: h })).json(), [{ key: 'a', value: 3 }]);
  assert.strictEqual((await fetch(u, { method: 'DELETE', headers: h })).status, 400);
});

test('file fallback when SUPABASE_URL / SUPABASE_SERVICE_KEY are unset (and /admin says so)', async () => {
  const f = path.join(os.tmpdir(), `lp_sb_fallback_${process.pid}.json`); try { fs.unlinkSync(f); } catch {}
  const a = await boot(null, { statsFile: f });
  try {
    assert.strictEqual(a.stats.storageStatus().mode, 'file'); assert.strictEqual(a.stats.persist, null);
    a.stats.playClick(); a.stats.flush(); assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).playClicks, 1);
    const html = await (await adminGet(a, '/admin')).text(); assert.match(html, /id="storage" data-mode="file"/); assert.match(html, /file fallback/);
    assert.strictEqual(mock.log.length, 0);
    // only one of the two vars -> still file storage
    const b = await boot(null, { statsFile: null, env: { SUPABASE_URL: mock.url } }); assert.strictEqual(b.stats.storageStatus().mode, 'memory'); await stop(b);
  } finally { await stop(a); try { fs.unlinkSync(f); fs.unlinkSync(f + '.tmp'); } catch {} }
});

test('load on startup: stats, brake settings, socials and polls come from Supabase; expired polls are cleaned up', async () => {
  const exp = Date.now() + 5 * day;
  const poll = { code: 'ABCDEF', tok: 'x', by: 'Seed', bySocial: null, lobby: null, createdAt: Date.now(), times: [Date.now() + day, Date.now() + 2 * day], places: [{ lat: 1, lng: 2, label: 'Park' }], voters: [{ id: 'v1', name: 'Ann', social: null, t: [2, 1], p: [2], at: 1 }], locked: null, expiresAt: exp };
  const old = { ...poll, code: 'OLDPLL', expiresAt: Date.now() - day };
  mock.tables.lastping_kv.set('stats', { key: 'stats', value: { v: 2, totals: { games: 41, started: 30, players: 77, blocked: 2 }, playClicks: 9, shares: { reel: 3 }, refs: { pal: { players: 4, games: 2, visits: 7 } }, days: {}, devices: {}, recentCreates: [], pollTotals: { created: 5, votes: 9, locked: 1 } } });
  mock.tables.lastping_kv.set('settings', { key: 'settings', value: { paused: true, maxGames: 7, maxPerHour: 3 } });
  mock.tables.lastping_socials.set('instagram\u0000seed.one', { platform: 'instagram', handle: 'seed.one', data: { handle: 'Seed.One', platform: 'instagram', first: '2026-01-01T00:00:00.000Z', last: '2026-02-01T00:00:00.000Z', games: 4, ref: null } });
  mock.tables.lastping_polls.set('ABCDEF', { code: 'ABCDEF', data: poll, expires_at: new Date(exp).toISOString() });
  mock.tables.lastping_polls.set('OLDPLL', { code: 'OLDPLL', data: old, expires_at: new Date(old.expiresAt).toISOString() });
  const a = await boot(mock);
  try {
    assert.strictEqual(a.loaded, true);
    const s = a.stats.summary({ games: 0 }); assert.strictEqual(s.totals.games, 41); assert.strictEqual(s.playClicks, 9); assert.strictEqual(s.shares.reel, 3);
    assert.deepStrictEqual(s.settings, { paused: true, maxGames: 7, maxPerHour: 3 });
    assert.deepStrictEqual(s.handles.map(h => h.handle), ['Seed.One']);
    const r = await fetch(a.base + '/api/polls/ABCDEF'); assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).voters[0].name, 'Ann');
    assert.strictEqual((await fetch(a.base + '/api/polls/OLDPLL')).status, 404);
    await until(() => !mock.tables.lastping_polls.has('OLDPLL')); // server-side cleanup of expired rows
    const c = await act(a, 'create', { dev: 'd1' }); assert.strictEqual(c.error?.error, BUSY_MSG); // paused brake survived
    assert.ok(mock.log.every(e => e.auth === null), 'sb_secret keys go in the apikey header only (not Authorization: Bearer)');
  } finally { await stop(a); }
});

test('write-through: throttled saves, then a restart keeps stats, brake settings, socials and polls (with votes)', async () => {
  const a = await boot(mock, { supabase: { throttleMs: 250 } });
  let code, token;
  try {
    await until(() => !a.stats.storageStatus().pending); const base = mock.count('POST', 'lastping_kv'); // initial sync of the (empty) project
    const h = await act(a, 'create', { dev: 'dev-1', ref: 'pal', social: { handle: '@Host.Person', platform: 'instagram' } });
    await act(a, 'join', { code: h.joined.code, dev: 'dev-2', social: { handle: 'tok.friend', platform: 'tiktok' } });
    for (let i = 0; i < 5; i++) a.stats.playClick();
    const r = await post(a, '/api/polls', pollBody()); assert.strictEqual(r.status, 201); ({ code, token } = await r.json());
    assert.strictEqual((await post(a, `/api/polls/${code}/vote`, { voter: 'voter-aaaa-1', name: 'Bo', t: [2, 1], p: [2] })).status, 200);
    assert.strictEqual(mock.count('POST', 'lastping_kv'), base, 'nothing written before the throttle window');
    await until(() => mock.tables.lastping_polls.has(code) && mock.tables.lastping_socials.size === 2);
    await sleep(350); assert.strictEqual(mock.count('POST', 'lastping_kv'), base + 1, 'many changes inside one window -> one batched upsert');
    assert.match(mock.log.find(e => e.method === 'POST').prefer, /resolution=merge-duplicates/);
    assert.ok(mock.rows('lastping_socials').some(r => r.platform === 'instagram' && r.handle === 'host.person'));
    assert.strictEqual(mock.tables.lastping_polls.get(code).expires_at, new Date(a.polls.get(code).expiresAt).toISOString());
    // brake settings are saved immediately
    const before = mock.count('POST', 'lastping_kv');
    assert.strictEqual((await post(a, '/admin/settings', { key: ADMIN, paused: true, maxGames: 9, maxPerHour: 4 })).status, 200);
    await until(() => mock.count('POST', 'lastping_kv') > before);
    assert.deepStrictEqual(mock.tables.lastping_kv.get('settings').value, { paused: true, maxGames: 9, maxPerHour: 4 });
    assert.strictEqual(a.stats.storageStatus().connected, true); assert.ok(a.stats.storageStatus().lastSaveAt);
  } finally { await stop(a); }
  // "restart": a brand-new process state, same Supabase project
  const b = await boot(mock);
  try {
    const s = b.stats.summary({ games: 0 });
    assert.strictEqual(s.totals.games, 1); assert.strictEqual(s.totals.players, 2); assert.strictEqual(s.playClicks, 5); assert.strictEqual(s.refs.find(x => x.ref === 'pal').games, 1);
    assert.deepStrictEqual(s.handles.map(x => x.platform + ':' + x.handle).sort(), ['instagram:host.person', 'tiktok:tok.friend']);
    assert.deepStrictEqual(s.settings, { paused: true, maxGames: 9, maxPerHour: 4 });
    const v = await (await fetch(`${b.base}/api/polls/${code}?k=${token}&v=voter-aaaa-1`)).json();
    assert.strictEqual(v.voters[0].name, 'Bo'); assert.strictEqual(v.creator, true); assert.strictEqual(v.mine.name, 'Bo');
    assert.strictEqual((await post(b, `/api/polls/${code}/lock`, { token, time: 0, place: 0 })).status, 200); // creator token still works after restart
    assert.strictEqual((await fetch(`${b.base}/api/polls/${code}/ics`)).status, 200);
    assert.strictEqual(b.polls.summary().created, 1);
  } finally { await stop(b); }
});

test('polls survive a restart even when created after this instance loaded: fetched on demand (HTTP + WS), misses cached', async () => {
  const b = await boot(mock); // loads an empty project
  const a = await boot(mock);
  try {
    const { code } = await (await post(a, '/api/polls', pollBody())).json(); await a.stats.flush();
    assert.ok(mock.tables.lastping_polls.has(code)); assert.strictEqual(b.polls.get(code), null);
    const r = await fetch(`${b.base}/api/polls/${code}`); assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).code, code);
    // vote on b (now in memory) is written back
    assert.strictEqual((await post(b, `/api/polls/${code}/vote`, { voter: 'voter-bbbb-2', name: 'Cy', t: [2, 2], p: [1] })).status, 200);
    await b.stats.flush(); assert.strictEqual(mock.tables.lastping_polls.get(code).data.voters.length, 1);
    // WS subscription path
    const { code: c2 } = await (await post(a, '/api/polls', pollBody())).json(); await a.stats.flush();
    const w = client(b.wsUrl); await w.open; w.send({ type: 'pollSub', code: c2 }); await until(() => w.msgs.some(m => m.type === 'poll'));
    assert.strictEqual(w.msgs.find(m => m.type === 'poll').poll.code, c2); w.ws.close();
    // unknown codes: 404 and the miss is cached (one lookup)
    const n = mock.count('GET', 'lastping_polls');
    assert.strictEqual((await fetch(`${b.base}/api/polls/ZZZZZZ`)).status, 404); assert.strictEqual((await fetch(`${b.base}/api/polls/ZZZZZZ`)).status, 404);
    assert.strictEqual(mock.count('GET', 'lastping_polls'), n + 1);
  } finally { await stop(a); await stop(b); }
});

test('poll expiry: swept polls are deleted in Supabase and not resurrected on restart', async () => {
  let T = Date.now(); const now = () => T;
  const a = await boot(mock, { now });
  let code;
  try {
    ({ code } = await (await post(a, '/api/polls', pollBody())).json()); await a.stats.flush(); assert.ok(mock.tables.lastping_polls.has(code));
    T += 40 * day; assert.strictEqual(a.polls.sweep(), 1); await a.stats.flush();
    assert.ok(!mock.tables.lastping_polls.has(code));
    assert.ok(mock.log.some(e => e.method === 'DELETE' && e.table === 'lastping_polls' && /^in\./.test(e.query.code || '')));
  } finally { await stop(a); }
  const b = await boot(mock, { now }); try { assert.strictEqual((await fetch(`${b.base}/api/polls/${code}`)).status, 404); } finally { await stop(b); }
});

test('admin delete of a handle deletes the Supabase row (and it stays deleted after a restart)', async () => {
  const a = await boot(mock);
  try {
    await act(a, 'create', { dev: 'd1', social: { handle: 'gone.soon', platform: 'instagram' } });
    await act(a, 'create', { dev: 'd2', social: { handle: 'keep.me', platform: 'snapchat' } });
    await a.stats.flush(); assert.strictEqual(mock.tables.lastping_socials.size, 2);
    const r = await post(a, '/admin/handles/delete', { key: ADMIN, platform: 'instagram', handle: 'gone.soon' }); assert.strictEqual(r.status, 200);
    await until(() => mock.tables.lastping_socials.size === 1); // deleteHandle flushes immediately
    const del = mock.log.find(e => e.method === 'DELETE' && e.table === 'lastping_socials'); assert.strictEqual(del.query.platform, 'eq.instagram'); assert.deepStrictEqual(parseIn(del.query.handle.slice(3)), ['gone.soon']);
  } finally { await stop(a); }
  const b = await boot(mock);
  try { assert.deepStrictEqual(b.stats.handleList().map(h => h.handle), ['keep.me']); } finally { await stop(b); }
});

test('Supabase errors: keep serving from memory, retry with backoff, recover; never clobber remote data before it loaded', async () => {
  mock.tables.lastping_kv.set('stats', { key: 'stats', value: { totals: { games: 5, started: 0, players: 3, blocked: 0 }, playClicks: 2 } });
  mock.tables.lastping_socials.set('x', { platform: 'instagram', handle: 'old.friend', data: { handle: 'old.friend', platform: 'instagram', first: '2026-01-01T00:00:00.000Z', last: '2026-01-01T00:00:00.000Z', games: 1, ref: null } });
  mock.failing = true;
  const t0 = Date.now(); const a = await boot(mock); // storageWaitMs 300: starts anyway
  try {
    assert.strictEqual(a.loaded, false); assert.ok(Date.now() - t0 < 2000);
    let t = Date.now(); assert.strictEqual((await fetch(a.base + '/healthz')).status, 200); assert.ok(Date.now() - t < 200, '/healthz does not touch Supabase');
    const getsBefore = mock.count('GET', 'lastping_polls'); await fetch(a.base + '/healthz'); assert.ok(mock.count('GET', 'lastping_polls') - getsBefore <= 1);
    await act(a, 'create', { dev: 'new-dev', social: { handle: 'fresh.face', platform: 'instagram' } });
    const r = await post(a, '/api/polls', pollBody()); assert.strictEqual(r.status, 201); const { code } = await r.json();
    assert.strictEqual((await fetch(`${a.base}/api/polls/${code}`)).status, 200);
    const st = a.stats.storageStatus(); assert.strictEqual(st.connected, false); assert.strictEqual(st.loaded, false); assert.match(st.lastError, /503/);
    let html = await (await adminGet(a, '/admin')).text(); assert.match(html, /data-connected="0"/); assert.match(html, /serving from memory and retrying/);
    await sleep(150); assert.strictEqual(mock.count('POST', 'lastping_kv'), 0, 'no writes before the remote data was loaded');
    assert.ok(mock.count('GET', 'lastping_kv') >= 2, 'load retried');
    mock.failing = false;
    await until(() => a.stats.storageStatus().loaded && mock.tables.lastping_polls.has(code) && mock.tables.lastping_kv.get('stats').value.totals.games === 6);
    const s = a.stats.summary({ games: 0 }); assert.strictEqual(s.totals.games, 6); assert.strictEqual(s.playClicks, 2); assert.strictEqual(s.totals.players, 4);
    assert.deepStrictEqual(s.handles.map(h => h.handle).sort(), ['fresh.face', 'old.friend']);
    // errors after loading: saves retried with backoff until they succeed
    mock.failing = true; a.stats.playClick();
    await until(() => a.stats.storageStatus().failures >= 2);
    assert.strictEqual(a.stats.storageStatus().connected, false); assert.strictEqual(a.stats.playClick() ?? 0, 0);
    mock.failing = false;
    await until(() => mock.tables.lastping_kv.get('stats').value.playClicks === 4 && a.stats.storageStatus().connected);
    html = await (await adminGet(a, '/admin')).text(); assert.match(html, /Supabase connected/); assert.match(html, /last successful save \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/);
  } finally { await stop(a); }
});

test('wrong key / missing tables: logged, app still serves; final flush on close', async () => {
  const errs = []; const log = { error: m => errs.push(m), log() {} };
  const a = await boot(mock, { env: { SUPABASE_SERVICE_KEY: 'sb_secret_WRONG' }, supabase: { log } });
  try {
    assert.strictEqual(a.loaded, false); assert.ok(errs.some(e => /HTTP 401/.test(e))); assert.ok(errs.every(e => !e.includes('sb_secret_WRONG')));
    assert.strictEqual((await post(a, '/api/polls', pollBody())).status, 201);
  } finally { await stop(a); }
  // close() flushes pending (throttled) changes
  const b = await boot(mock, { supabase: { throttleMs: 60000 } });
  b.stats.playClick(); assert.strictEqual(mock.count('POST', 'lastping_kv'), 0);
  await stop(b); assert.strictEqual(mock.tables.lastping_kv.get('stats').value.playClicks, 1);
});

test('the service key never reaches clients (pages, API, admin, WS, errors) and is redacted from status/logs', async () => {
  mock.echoKeyInErrors = true;
  const errs = []; const a = await boot(mock, { env: { PLAN_ANYONE: '1' }, supabase: { log: { error: m => errs.push(m), log() {} } } });
  try {
    const { code } = await (await post(a, '/api/polls', pollBody())).json();
    const h = await act(a, 'create', { dev: 'd1', social: { handle: 'some.one', platform: 'instagram' } });
    const w = client(a.wsUrl); await w.open; w.send({ type: 'pollSub', code }); await until(() => w.msgs.some(m => m.type === 'poll'));
    const bodies = [];
    for (const p of ['/', '/healthz', '/config.js', '/api/rules', '/app.js', '/plan.js', '/plan.html', '/privacy', `/api/polls/${code}`, '/api/polls/QQQQQQ', '/admin', '/nope'])
      bodies.push(p + ' ' + await (await fetch(a.base + p)).text());
    bodies.push(await (await adminGet(a, '/admin')).text(), await (await adminGet(a, '/admin/stats.json')).text(), await (await adminGet(a, '/admin/socials.csv')).text());
    mock.failing = true; a.stats.playClick(); await until(() => a.stats.storageStatus().failures >= 1);
    bodies.push(await (await adminGet(a, '/admin')).text(), JSON.stringify(a.stats.storageStatus()));
    bodies.push(...h.raw, ...w.raw); w.ws.close();
    for (const b of bodies) { assert.ok(!b.includes(KEY), 'key leaked in: ' + b.slice(0, 80)); assert.ok(!b.includes('sb_secret'), 'key prefix leaked in: ' + b.slice(0, 80)); }
    assert.ok(errs.length && errs.every(e => !e.includes(KEY)));
    assert.match(bodies.join('\n'), /Supabase/); // the admin status line is there
    const sj = JSON.parse(bodies.find(b => b.startsWith('{') && b.includes('"storage"'))); assert.deepStrictEqual(Object.keys(sj.storage).sort(), ['connected', 'failures', 'host', 'lastError', 'lastErrorAt', 'lastLoadAt', 'lastSaveAt', 'loaded', 'mode', 'pending', 'retryInMs']);
    mock.failing = false;
  } finally { await stop(a); }
});

test('legacy service_role JWT keys are also sent as Authorization: Bearer; socials > 1000 rows are paged', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.e30.sig';
  const m2 = await createMock({ key: jwt }).start();
  try {
    for (let i = 0; i < 1203; i++) m2.tables.lastping_socials.set('k' + i, { platform: 'instagram', handle: 'h' + i, data: { handle: 'h' + i, platform: 'instagram', first: '2026-01-01T00:00:00.000Z', last: '2026-01-01T00:00:00.000Z', games: 0, ref: null } });
    const st = createSupabaseStore({ url: m2.url + '/', key: jwt, ...FAST, log: { error() {}, log() {} } });
    const s = createStats({ persist: st }); assert.strictEqual(await st.start({ waitMs: 2000 }), true);
    assert.strictEqual(s.handleList().length, 1203);
    assert.ok(m2.log.every(e => e.auth === 'Bearer ' + jwt));
    await st.close();
  } finally { await m2.stop(); }
});

test('node server.js: loads from Supabase before listening and flushes on SIGTERM (within the 5 s throttle)', async () => {
  const { spawn } = require('child_process');
  mock.tables.lastping_kv.set('stats', { key: 'stats', value: { playClicks: 10 } });
  const port = 30000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), SUPABASE_URL: mock.url, SUPABASE_SERVICE_KEY: KEY, STATS_FILE: '', ADMIN_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  try {
    await until(() => /listening/.test(out), 8000);
    assert.match(out, /\[storage\] Supabase \(127\.0\.0\.1:\d+\)/); assert.ok(!out.includes(KEY));
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/play`, { redirect: 'manual' })).status, 302);
    const exited = new Promise(r => p.on('exit', r)); p.kill('SIGTERM'); await exited;
    assert.strictEqual(mock.tables.lastping_kv.get('stats').value.playClicks, 11); assert.match(out, /SIGTERM/);
  } finally { p.kill('SIGKILL'); }
});
