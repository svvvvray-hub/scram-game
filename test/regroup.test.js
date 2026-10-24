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

const last = (c, t) => [...c.msgs].reverse().find(m => m.type === t);
const at = (c, dm, lat0 = 52) => c.send({ type: 'loc', lat: lat0 + dm / 111320, lng: 4, acc: 5 });
async function ended(o = {}, n = 4) {
  const a = await boot({ regroupMs: 100, hostHandoffMs: 100000, ...o }); const L0 = await lobby(a, n); const { host, ps } = L0;
  host.send({ type: 'settings', settings: { hideSec: 0 } }); host.send({ type: 'role', id: host.joined.id, role: 'hunter' });
  at(host, 0); ps.forEach((p, i) => at(p, 100 + i * 50)); host.send({ type: 'start' }); await until(() => host.state.state === 'playing');
  await sleep(300); host.send({ type: 'end' }); await until(() => host.state.state === 'ended');
  return { a, ...L0, L: [...a.lobbies.values()][0] };
}

test('regroup: nothing during a game; after the end everyone sees the creator + own distance; only host gets the panel', async () => {
  const a = await boot({ regroupMs: 100 }); const { host, ps } = await lobby(a, 3);
  host.send({ type: 'settings', settings: { hideSec: 0 } }); host.send({ type: 'role', id: host.joined.id, role: 'hunter' });
  at(host, 0); at(ps[0], 100); at(ps[1], 200); host.send({ type: 'start' }); await until(() => host.state.state === 'playing'); await sleep(400);
  assert.ok(![host, ...ps].some(c => c.msgs.some(m => m.type === 'regroup')), 'no regroup data during play');
  host.send({ type: 'end' }); await until(() => last(ps[0], 'regroup') && last(host, 'regroup'));
  const r = last(ps[0], 'regroup'); assert.equal(r.anchor.id, host.joined.id); assert.ok(r.anchor.isCreator); assert.ok(Math.abs(r.anchor.loc.lat - 52) < 1e-9);
  assert.ok(Math.abs(r.me.dist - 100) < 2); assert.equal(r.panel, undefined);
  const hp = last(host, 'regroup').panel; assert.equal(hp.total, 2); assert.equal(hp.waiting, 2);
  assert.ok(!JSON.stringify(hp).includes('"lat"'), 'panel has distances, not positions');
  done(a, [host, ...ps]);
});

test('regroup: choices, waiting count, trend closer / away / stopped, offline + closed-browser flags', async () => {
  const { a, host, ps } = await ended();
  const [p1, p2, p3] = ps;
  p1.send({ type: 'regroup', choice: 'in' }); p2.send({ type: 'regroup', choice: 'done' }); p2.send({ type: 'regroup', choice: 'bogus' });
  await until(() => last(host, 'regroup').panel.waiting === 1);
  const P = () => last(host, 'regroup').panel, row = c => P().rows.find(r => r.id === c.joined.id);
  assert.equal(row(p1).status, 'in'); assert.equal(row(p2).status, 'done'); assert.equal(row(p3).status, 'none');
  for (let i = 0; i < 4; i++) { at(p1, 100 - i * 20); at(p2, 150 + i * 20); at(p3, 200); await sleep(1600); }
  assert.equal(row(p1).trend, 'closer'); assert.equal(row(p2).trend, 'away'); assert.equal(row(p3).trend, 'stopped');
  p3.send({ type: 'regroupBye' }); await until(() => row(p3).conn === 'closed');
  p2.ws.terminate(); await until(() => row(p2).conn === 'offline');
  done(a, [host, p1, p3]);
});

test('regroup: tracks the original creator after a host handoff; falls back to the current host when the creator leaves', async () => {
  const { a, host, ps, L } = await ended();
  L.hostId = ps[0].joined.id; // handed over mid-game
  await until(() => last(ps[1], 'regroup').anchor.id === host.joined.id && last(ps[0], 'regroup').panel);
  host.send({ type: 'leave' }); await until(() => last(ps[1], 'regroup').anchor.id === ps[0].joined.id);
  assert.ok(!last(ps[1], 'regroup').anchor.isCreator);
  done(a, [host, ...ps]);
});

test('regroup: feedback is sanitized, capped, relayed live to the host, stored without names; skip stores nothing; once per round', async () => {
  const { a, host, ps } = await ended();
  const [p1, p2] = ps;
  p1.send({ type: 'regroup', choice: 'done' });
  p1.send({ type: 'feedback', rating: 4, liked: 'The <b>chime</b>\u202e!\u0000 ' + 'x'.repeat(900), improve: 'More maps, because   fun' });
  p1.send({ type: 'feedback', rating: 1, liked: 'again' }); // ignored
  p2.send({ type: 'feedback', skip: true }); p2.send({ type: 'feedback', rating: 9, liked: 7 });
  await until(() => last(host, 'feedbackIn'));
  const fi = last(host, 'feedbackIn'); assert.equal(fi.name, 'P0'); assert.equal(fi.rating, 4); assert.ok(fi.liked.length <= 500 && !/[\u202e\u0000]/.test(fi.liked));
  assert.equal(fi.improve, 'More maps, because fun');
  await until(() => last(host, 'regroup').panel.fb.length === 1);
  const list = a.stats.feedbackList(); assert.equal(list.length, 1); assert.equal(list[0].rating, 4); assert.ok(!JSON.stringify(list).includes('P0'));
  assert.ok(last(p1, 'regroup').me.fbDone);
  done(a, [host, ...ps]);
});

test('regroup: "Ping me for the next game" (@ or email), validated + deduped', async () => {
  const { a, host, ps } = await ended();
  const [p1, p2, p3] = ps;
  p1.send({ type: 'notifyMe', platform: 'tiktok', handle: '@Dancer.One' });
  p2.send({ type: 'notifyMe', email: 'not an email<script>' });
  p3.send({ type: 'notifyMe', email: '  Me@Example.COM ' });
  await until(() => last(p1, 'notifyRes') && last(p2, 'notifyRes') && last(p3, 'notifyRes'));
  assert.ok(last(p1, 'notifyRes').ok); assert.ok(!last(p2, 'notifyRes').ok); assert.ok(last(p3, 'notifyRes').ok);
  p2.send({ type: 'notifyMe', platform: 'evil', handle: '<img>' }); await sleep(100);
  const nl = a.stats.notifyList(); assert.equal(nl.length, 2);
  assert.ok(nl.some(n => n.kind === 'social' && n.platform === 'tiktok' && n.handle === 'dancer.one')); assert.ok(nl.some(n => n.email === 'me@example.com'));
  a.stats.notify({ kind: 'email', email: 'me@example.com' }); assert.equal(a.stats.notifyList().length, 2, 'dedup');
  assert.ok(a.stats.deleteNotify(nl[0].id)); assert.equal(a.stats.notifyList().length, 1);
  done(a, [host, ...ps]);
});

test('regroup: "Start next round" keeps only players who are in (same room)', async () => {
  const { a, host, ps } = await ended();
  const [p1, p2, p3] = ps;
  p1.send({ type: 'regroup', choice: 'in' }); p2.send({ type: 'regroup', choice: 'done' });
  await until(() => last(host, 'regroup').panel.waiting === 1);
  p1.send({ type: 'nextRound' }); await sleep(100); assert.equal(host.state.state, 'ended', 'host only');
  host.send({ type: 'nextRound' }); await until(() => host.state.state === 'lobby');
  assert.deepEqual(host.state.players.map(p => p.id).sort(), [host.joined.id, p1.joined.id].sort());
  assert.ok(p2.msgs.some(m => m.type === 'regroupOut') && p3.msgs.some(m => m.type === 'regroupOut'));
  assert.equal(host.joined.code, [...a.lobbies.keys()][0]);
  done(a, [host, ...ps]);
});

test('regroup: /admin feedback + ping-me lists, CSV export (formula-safe) and delete', async () => {
  const { a, host, ps } = await ended({ env: { ADMIN_KEY: 'k1' } });
  ps[0].send({ type: 'feedback', rating: 5, liked: '=HYPERLINK("x")', improve: 'ok, "quotes"' });
  ps[1].send({ type: 'notifyMe', email: 'a@b.co' });
  await until(() => a.stats.feedbackList().length === 1 && a.stats.notifyList().length === 1);
  const auth = await fetch(a.base + '/admin?key=k1', { redirect: 'manual' }); const ck = auth.headers.get('set-cookie').split(';')[0];
  const get = p => fetch(a.base + p, { headers: { cookie: ck } });
  const page = await (await get('/admin')).text(); assert.ok(page.includes('id="fbTable"') && page.includes('id="ntTable"') && page.includes('a@b.co'));
  const csv = await (await get('/admin/feedback.csv')).text(); assert.ok(csv.startsWith('id,created_utc,rating')); assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`)); assert.ok(csv.includes('"ok, ""quotes"""'));
  const ncsv = await (await get('/admin/notify.csv')).text(); assert.ok(ncsv.includes('a@b.co'));
  assert.equal((await fetch(a.base + '/admin/feedback.csv')).status, 401);
  const del = (p, id) => fetch(a.base + p, { method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  assert.equal((await del('/admin/feedback/delete', a.stats.feedbackList()[0].id)).status, 200); assert.equal(a.stats.feedbackList().length, 0);
  assert.equal((await del('/admin/notify/delete', a.stats.notifyList()[0].id)).status, 200); assert.equal(a.stats.notifyList().length, 0);
  assert.equal((await del('/admin/notify/delete', 'nope')).status, 404);
  done(a, [host, ...ps]);
});
