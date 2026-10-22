'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const WebSocket = require('ws');
const { createApp, BUSY_MSG } = require('../server');
const { createStats } = require('../stats');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function boot(env = {}, extra = {}) {
  const a = createApp({ tickMs: 50, quiet: true, statsFile: null, env: { ADMIN_KEY: 'sekret-123', ...env }, ...extra });
  await new Promise(r => a.server.listen(0, r));
  a.base = `http://127.0.0.1:${a.server.address().port}`; a.ws = a.base.replace('http', 'ws') + '/ws';
  return a;
}
function client(url) {
  const ws = new WebSocket(url), c = { ws, msgs: [] };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'joined') c.joined = m; if (m.type === 'error') c.error = m; });
  c.send = m => ws.send(JSON.stringify(m)); c.open = new Promise(r => ws.on('open', r));
  return c;
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };
async function act(a, type, extra = {}) { const c = client(a.ws); await c.open; c.send({ type, agreed: true, name: 'P', ...extra }); await until(() => c.joined || c.error); return c; }
const post = (a, p, body, headers = {}) => fetch(a.base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('admin is 404 when ADMIN_KEY is unset', async () => {
  const a = await boot({ ADMIN_KEY: '' });
  try {
    assert.strictEqual((await fetch(a.base + '/admin')).status, 404);
    assert.strictEqual((await fetch(a.base + '/admin?key=anything')).status, 404);
    assert.strictEqual((await post(a, '/admin/settings', { key: '', paused: true })).status, 404);
  } finally { a.server.close(); }
});

test('admin auth: wrong key 401, ?key sets cookie (not the key) and redirects, login form works', async () => {
  const a = await boot();
  try {
    let r = await fetch(a.base + '/admin'); assert.strictEqual(r.status, 401); const html = await r.text();
    assert.match(html, /Admin key/); assert.ok(!html.includes('sekret-123'));
    assert.strictEqual((await fetch(a.base + '/admin?key=nope')).status, 401);
    r = await fetch(a.base + '/admin?key=sekret-123', { redirect: 'manual' }); assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.get('location'), '/admin');
    const ck = r.headers.get('set-cookie'); assert.match(ck, /lp_admin=/); assert.match(ck, /HttpOnly/i); assert.ok(!ck.includes('sekret-123'));
    r = await fetch(a.base + '/admin', { headers: { cookie: ck.split(';')[0] } }); assert.strictEqual(r.status, 200);
    const page = await r.text(); assert.match(page, /Brake switch/); assert.match(page, /<svg/); assert.ok(!page.includes('sekret-123'));
    r = await fetch(a.base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'key=bad' }); assert.strictEqual(r.status, 401);
    r = await fetch(a.base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'key=sekret-123' }); assert.strictEqual(r.status, 303); assert.match(r.headers.get('set-cookie'), /lp_admin=/);
    assert.strictEqual((await fetch(a.base + '/admin', { headers: { cookie: 'lp_admin=forged' } })).status, 401);
    assert.strictEqual((await fetch(a.base + '/admin/stats.json')).status, 401);
    // settings only change with the key, only via POST
    assert.strictEqual((await post(a, '/admin/settings', { paused: true })).status, 401);
    assert.strictEqual((await post(a, '/admin/settings', { key: 'wrong', paused: true })).status, 401);
    assert.strictEqual(a.stats.data().settings.paused, false);
    assert.strictEqual((await fetch(a.base + '/admin/settings?key=sekret-123&paused=true')).status, 404);
    assert.strictEqual(a.stats.data().settings.paused, false);
  } finally { a.server.close(); }
});

test('counting: games, unique players/day, refs, /play clicks, shares', async () => {
  const a = await boot();
  try {
    await fetch(a.base + '/?ref=alice'); await fetch(a.base + '/play?ref=alice', { redirect: 'manual' }); await fetch(a.base + '/play', { redirect: 'manual' });
    const h = await act(a, 'create', { dev: 'dev-A', ref: 'alice' });
    await act(a, 'join', { code: h.joined.code, dev: 'dev-B', ref: 'alice' });
    await act(a, 'join', { code: h.joined.code, dev: 'dev-B' }); // same device: not a new unique
    await act(a, 'create', { dev: 'dev-C', ref: 'bob' });
    await act(a, 'create', { dev: 'dev-A' }); // returning alice-referred device: game credited to alice
    await post(a, '/api/share', { k: 'viral' }); await post(a, '/api/share', { k: 'reel' }); await post(a, '/api/share', { k: 'viral' });
    const s = await (await fetch(a.base + '/admin/stats.json?key=sekret-123')).json();
    assert.strictEqual(s.totals.games, 3); assert.strictEqual(s.totals.players, 3);
    const t = s.days.at(-1); assert.strictEqual(t.games, 3); assert.strictEqual(t.players, 3);
    const alice = s.refs.find(r => r.ref === 'alice'), bob = s.refs.find(r => r.ref === 'bob');
    assert.deepStrictEqual([alice.players, alice.games, alice.visits], [2, 2, 2]); assert.deepStrictEqual([bob.players, bob.games], [1, 1]);
    assert.strictEqual(s.playClicks, 2); assert.deepStrictEqual(s.shares, { viral: 2, reel: 1 });
    assert.strictEqual(s.live.games, 3); assert.strictEqual(s.live.online, 5);
    assert.ok(!JSON.stringify(a.stats.data()).includes('dev-A'), 'raw device ids are hashed');
  } finally { a.server.close(); }
});

test('brake: pause / max concurrent / per hour block create but never join', async () => {
  const a = await boot({ MAX_GAMES: '2' });
  try {
    assert.strictEqual(a.stats.data().settings.maxGames, 2);
    const h = await act(a, 'create');
    let r = await post(a, '/admin/settings', { key: 'sekret-123', paused: true }); assert.strictEqual(r.status, 200);
    let c = await act(a, 'create'); assert.ok(c.error?.busy); assert.strictEqual(c.error.error, BUSY_MSG); assert.strictEqual(BUSY_MSG, 'Last Ping is busy right now. Try again in a few minutes!');
    c = await act(a, 'join', { code: h.joined.code }); assert.ok(c.joined, 'join works while paused');
    await post(a, '/admin/settings', { key: 'sekret-123', paused: false });
    assert.ok((await act(a, 'create')).joined);
    c = await act(a, 'create'); assert.ok(c.error?.busy, 'max concurrent 2 reached');
    c = await act(a, 'join', { code: h.joined.code }); assert.ok(c.joined, 'join works at max');
    await post(a, '/admin/settings', { key: 'sekret-123', maxGames: 0, maxPerHour: 3 });
    assert.ok((await act(a, 'create')).joined);
    c = await act(a, 'create'); assert.ok(c.error?.busy, 'hourly limit reached');
    assert.strictEqual(a.stats.data().totals.blocked, 3);
    // form POST with cookie: unchecked box = unpause
    const ck = (await fetch(a.base + '/admin?key=sekret-123', { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
    await post(a, '/admin/settings', { key: 'sekret-123', paused: true });
    r = await fetch(a.base + '/admin/settings', { method: 'POST', redirect: 'manual', headers: { cookie: ck, 'content-type': 'application/x-www-form-urlencoded' }, body: 'form=1&maxGames=50&maxPerHour=0' });
    assert.strictEqual(r.status, 303); assert.deepStrictEqual(a.stats.data().settings, { paused: false, maxGames: 50, maxPerHour: 0 });
  } finally { a.server.close(); }
});

test('stats persist to STATS_FILE with throttled writes, settings survive restart', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lp-')), 'sub', 'stats.json');
  const s = createStats({ file: f, throttleMs: 60 });
  s.gameCreated('d1', 'x'); s.gameCreated('d2'); s.share('viral');
  assert.ok(!fs.existsSync(f), 'not written synchronously');
  await sleep(150); assert.ok(fs.existsSync(f));
  s.setSettings({ paused: true, maxGames: 7, maxPerHour: 4 });
  const s2 = createStats({ file: f });
  assert.strictEqual(s2.data().totals.games, 2); assert.deepStrictEqual(s2.data().settings, { paused: true, maxGames: 7, maxPerHour: 4 });
  assert.strictEqual(s2.canCreate(0), 'paused');
});
