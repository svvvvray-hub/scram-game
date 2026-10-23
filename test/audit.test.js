'use strict';
// Regression tests for the fixes from docs/bug_audit.md
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createApp } = require('../server');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };
async function boot(o = {}) {
  const a = createApp({ tickMs: 20, minSec: 0.1, defaultMode: 'custom', quiet: true, statsFile: null, ...o });
  await new Promise(r => a.server.listen(0, r));
  a.base = `http://127.0.0.1:${a.server.address().port}`; a.url = a.base.replace('http', 'ws') + '/ws';
  return a;
}
function client(url, headers) {
  const ws = new WebSocket(url, headers ? { headers } : undefined), c = { ws, msgs: [], state: null };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'state') c.state = m; if (m.type === 'joined') c.joined = m; if (m.type === 'error') c.error = m; });
  ws.on('close', code => { c.closed = code; });
  c.send = m => ws.send(typeof m === 'string' ? m : JSON.stringify(m)); c.open = new Promise(r => ws.on('open', r));
  return c;
}
async function lobby(a, n = 2) {
  const host = client(a.url); await host.open; host.send({ type: 'create', agreed: true, name: 'Host' }); await until(() => host.joined);
  const ps = [];
  for (let i = 0; i < n - 1; i++) { const p = client(a.url); await p.open; p.send({ type: 'join', agreed: true, code: host.joined.code, name: 'P' + i }); await until(() => p.joined); ps.push(p); }
  await until(() => host.state && host.state.players.length === n);
  return { host, ps, code: host.joined.code };
}
const done = (a, cs) => { a.server.close(); cs.forEach(c => c.ws.terminate()); };

test('audit: JSON null / numbers / arrays / bad cuts do not crash the server', async () => {
  const a = await boot(); const { host, ps } = await lobby(a);
  for (const raw of ['null', '1', '"x"', '[]', '[1,2]', '{"type":5}', 'true']) host.send(raw);
  host.send({ type: 'hlUpload', cuts: [null, 5, { data: 1 }] }); // before the end: rejected, no throw
  host.send({ type: 'time', c: 1 }); await until(() => host.msgs.some(m => m.type === 'time'));
  const x = client(a.url); await x.open; x.send('null'); x.send({ type: 'create', agreed: true, name: 'Z' }); await until(() => x.joined);
  done(a, [host, ...ps, x]);
});

test('audit: oversized message before join closes the socket (1009)', async () => {
  const a = await boot(); const c = client(a.url); await c.open;
  c.send(JSON.stringify({ type: 'create', agreed: true, name: 'x'.repeat(70 * 1024) }));
  await until(() => c.closed); assert.equal(c.closed, 1009); assert.ok(!c.joined);
  done(a, [c]);
});

test('audit: per-socket flood guard drops excess messages and closes a flooding socket', async () => {
  const a = await boot(); const c = client(a.url); await c.open;
  for (let i = 0; i < 450; i++) c.send({ type: 'time', c: i });
  await until(() => c.closed); assert.equal(c.closed, 1008);
  assert.ok(c.msgs.filter(m => m.type === 'time').length <= 80, 'only the burst is answered');
  done(a, [c]);
});

test('audit: per-IP limit on create and join (proxied clients), loopback dev not limited', async () => {
  const a = await boot({ createPerIp: 2, joinPerIp: 2 }); const cs = [], H = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' };
  const act = async (type, extra = {}, h = H) => { const c = client(a.url, h); cs.push(c); await c.open; c.send({ type, agreed: true, name: 'P', ...extra }); await until(() => c.joined || c.error); return c; };
  const c1 = await act('create'), c2 = await act('create'), c3 = await act('create');
  assert.ok(c1.joined && c2.joined); assert.ok(c3.error && c3.error.rate, 'third create from the same IP is limited');
  assert.ok((await act('create', {}, { 'x-forwarded-for': '198.51.100.9' })).joined, 'another IP is fine');
  const code = c1.joined.code;
  assert.ok((await act('join', { code })).joined); assert.ok((await act('join', { code })).joined);
  assert.ok((await act('join', { code })).error.rate, 'third join from the same IP is limited');
  for (let i = 0; i < 4; i++) assert.ok((await act('create', {}, null)).joined, 'direct loopback (dev/tests) is not limited');
  done(a, cs);
});

test('audit: a kicked player can create a new game on the same socket', async () => {
  const a = await boot(); const { host, ps } = await lobby(a);
  host.send({ type: 'kick', id: ps[0].joined.id }); await until(() => ps[0].msgs.some(m => m.type === 'gone'));
  ps[0].joined = null; ps[0].send({ type: 'create', agreed: true, name: 'Again' }); await until(() => ps[0].joined);
  assert.notEqual(ps[0].joined.code, host.joined.code);
  ps[0].send({ type: 'start' }); await sleep(50); assert.equal(host.state.state, 'lobby', 'old lobby untouched by the kicked socket');
  done(a, [host, ...ps]);
});

test('audit: rejoin from a second tab tells the old tab it was replaced', async () => {
  const a = await boot(); const { host, ps, code } = await lobby(a);
  const t2 = client(a.url); await t2.open; t2.send({ type: 'rejoin', code, token: ps[0].joined.token }); await until(() => t2.joined);
  await until(() => ps[0].msgs.some(m => m.type === 'replaced') && ps[0].closed); assert.equal(ps[0].closed, 4001);
  assert.ok(host.state.players.find(p => p.id === ps[0].joined.id).connected);
  done(a, [host, ...ps, t2]);
});

test('audit: offline host hands over to a connected player; the secret manual pick is not inherited', async () => {
  const a = await boot({ hostHandoffMs: 150 }); const { host, ps, code } = await lobby(a, 3);
  host.send({ type: 'role', id: ps[0].joined.id, role: 'hunter' }); await until(() => host.state.hostPick?.ids.length === 1);
  host.ws.terminate(); await until(() => ps[1].state.host !== host.joined.id, 3000);
  const newHost = ps.find(p => p.joined.id === ps[1].state.host); assert.ok(newHost);
  await until(() => newHost.state.hostPick); assert.equal(newHost.state.hostPick.manual, false); assert.deepEqual(newHost.state.hostPick.ids, []);
  assert.ok(a.lobbies.get(code).events.some(e => /is now host/.test(e.text)));
  done(a, [host, ...ps]);
});

test('audit: names lose bidi / control / zero-width chars; (0,0) and NaN fixes are ignored', async () => {
  const a = await boot(); const c = client(a.url); await c.open;
  c.send({ type: 'create', agreed: true, name: '\u202Eevil\u200B\nname\u0007' }); await until(() => c.joined && c.state);
  assert.equal(c.state.players[0].name, 'evil name');
  c.send({ type: 'loc', lat: 0, lng: 0, acc: 5 }); c.send({ type: 'loc', lat: 'x', lng: 1 }); await sleep(60);
  const L = a.lobbies.get(c.joined.code); assert.equal(L.players.get(c.joined.id).loc, null);
  c.send({ type: 'loc', lat: 37.5, lng: -122.5, acc: 5, ts: 1e300 }); await until(() => L.players.get(c.joined.id).loc);
  assert.ok(Math.abs(L.players.get(c.joined.id).loc.ts - Date.now()) < 5000, 'absurd client timestamps are replaced');
  done(a, [c]);
});

test('audit: an active lobby is not deleted 1 h after creation; an idle one still is', async () => {
  let fake = Date.now(); const a = await boot({ now: () => fake });
  const { host, ps, code } = await lobby(a);
  const idle = client(a.url); await idle.open; idle.send({ type: 'create', agreed: true, name: 'Idle' }); await until(() => idle.joined);
  fake += 50 * 60e3; host.send({ type: 'settings', settings: { pingSec: 30 } }); await sleep(60);
  fake += 20 * 60e3; await sleep(80);
  assert.ok(a.lobbies.has(code), 'lobby used 20 min ago is kept'); assert.ok(!a.lobbies.has(idle.joined.code), 'idle lobby removed after 1 h');
  done(a, [host, ...ps, idle]);
});

test('audit: ?ref=__proto__ cannot pollute Object.prototype; ref and share keys are capped', async () => {
  const a = await boot();
  for (const r of ['__proto__', 'constructor', 'prototype']) await fetch(a.base + '/?ref=' + r);
  await fetch(a.base + '/api/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: 'constructor' }) });
  assert.equal(({}).visits, undefined); assert.equal(({}).players, undefined);
  for (let i = 0; i < 40; i++) a.stats.share('kind' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)));
  assert.ok(Object.keys(a.stats.data().shares).length <= 30);
  done(a, []);
});

test('audit: highlight uploads respect a server-wide memory cap', async () => {
  const a = await boot({ hlTotalMb: 1 }); const { host, ps } = await lobby(a);
  host.send({ type: 'loc', lat: 37.5, lng: -122.5, acc: 5 }); ps[0].send({ type: 'loc', lat: 37.5001, lng: -122.5, acc: 5 });
  host.send({ type: 'settings', settings: { gameSec: 0.3, pingSec: 0.2, hideSec: 0 } }); await sleep(50);
  host.send({ type: 'start' }); await until(() => host.state.state === 'ended', 5000);
  const cut = () => ({ data: 'data:video/webm;base64,' + 'A'.repeat(800 * 1024), dur: 3, t: 0, caption: 'hi\u202E' });
  host.send({ type: 'hlUpload', cuts: [cut()] }); await until(() => host.msgs.some(m => m.type === 'hlAck'));
  assert.equal(host.msgs.find(m => m.type === 'hlAck').ok, true);
  ps[0].send({ type: 'hlUpload', cuts: [cut()] }); await until(() => ps[0].msgs.some(m => m.type === 'hlAck'));
  const ack = ps[0].msgs.find(m => m.type === 'hlAck'); assert.equal(ack.ok, false); assert.match(ack.error, /busy/);
  done(a, [host, ...ps]);
});

test('audit: admin key brute force is locked out per IP', async () => {
  const a = await boot({ env: { ADMIN_KEY: 'sekret-123' } });
  for (let i = 0; i < 10; i++) assert.equal((await fetch(a.base + '/admin?key=wrong' + i, { redirect: 'manual' })).status, 401);
  assert.equal((await fetch(a.base + '/admin?key=sekret-123', { redirect: 'manual' })).status, 401, 'locked out even with the right key');
  const b = await boot({ env: { ADMIN_KEY: 'sekret-123' } });
  const ok = await fetch(b.base + '/admin?key=sekret-123', { redirect: 'manual' }); assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('x-frame-options'), 'DENY'); assert.match(ok.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  done(a, []); done(b, []);
});
