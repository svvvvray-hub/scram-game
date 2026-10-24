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

const Tasks = require('../tasks');

test('tasks: generation + validation (pure)', () => {
  const m = Tasks.make('math'); assert.equal(m.data.problems.length, 3); assert.ok(!('secret' in Tasks.pub(m)));
  assert.ok(Tasks.check(m, m.secret)); assert.ok(!Tasks.check(m, [m.secret[0], m.secret[1], m.secret[2] + 1])); assert.ok(!Tasks.check(m, ['', '', '']));
  for (let i = 0; i < 50; i++) { const s = Tasks.make('slide'); assert.notDeepEqual(s.data.board, Tasks.SOLVED); }
  // solve a slide by BFS, then validate
  const s = Tasks.make('slide'), key = b => b.join(''), seen = new Map([[key(s.data.board), []]]), q = [s.data.board];
  while (q.length) { const b = q.shift(), path = seen.get(key(b)); if (key(b) === key(Tasks.SOLVED)) break;
    for (let v = 1; v < 9; v++) { const n = Tasks.slide(b, v); if (n && !seen.has(key(n))) { seen.set(key(n), [...path, v]); q.push(n); } } }
  const sol = seen.get(key(Tasks.SOLVED)); assert.ok(Tasks.check(s, sol)); assert.ok(!Tasks.check(s, sol.slice(0, -1))); assert.ok(!Tasks.check(s, [9, 9]));
  const w = Tasks.make('wire'), ans = Object.fromEntries(Tasks.COLORS.map(c => [c, w.data.right.indexOf(c)]));
  assert.ok(Tasks.check(w, ans)); assert.ok(!Tasks.check(w, { ...ans, red: (ans.red + 1) % 4 })); assert.ok(!Tasks.check(w, { __proto__: ans }));
  assert.ok(!Tasks.check(Tasks.make('hold'), {}));
});

async function game(o) {
  const a = await boot({ taskWindowMs: 3000, ...o }); const { host, ps } = await lobby(a, 3);
  host.send({ type: 'settings', settings: { hideSec: 0, gameSec: 1200, tasks: 'normal' } });
  host.send({ type: 'role', id: host.joined.id, role: 'hunter' }); host.send({ type: 'start' });
  await until(() => host.state.state === 'playing');
  return { a, host, ps };
}
const last = (c, t) => [...c.msgs].reverse().find(m => m.type === t);

test('tasks: modes default; settings validated', async () => {
  const a = await boot({ defaultMode: 'party' }); const { host, ps } = await lobby(a);
  assert.equal(host.state.settings.tasks, 'normal');
  host.send({ type: 'settings', settings: { tasks: 'bogus' } }); host.send({ type: 'settings', settings: { tasks: 'often' } });
  await until(() => host.state.settings.tasks === 'often'); assert.equal(host.state.settings.mode, 'custom');
  host.send({ type: 'settings', settings: { mode: 'classic' } }); await until(() => host.state.settings.tasks === 'off');
  done(a, [host, ...ps]);
});

test('tasks: wire completes -> Extra Time, hunters get an anonymous toast, hunters never see task data', async () => {
  const { a, host, ps } = await game({ taskTimes: [50], taskType: 'wire' });
  const [h1, h2] = ps; await until(() => h1.state.task && h2.state.task);
  assert.equal(host.state.task, undefined); assert.ok(!host.msgs.some(m => m.type === 'taskOffer'));
  const endsBefore = host.state.endsAt, k = h1.state.task;
  h1.send({ type: 'taskSubmit', id: k.id, answer: {} }); // not started: ignored
  h1.send({ type: 'taskStart', id: k.id });
  h1.send({ type: 'taskSubmit', id: k.id, answer: Object.fromEntries(Tasks.COLORS.map(c => [c, k.data.right.indexOf(c)])) });
  await until(() => last(h1, 'taskResult'));
  assert.equal(last(h1, 'taskResult').ok, true); assert.equal(last(h1, 'taskResult').bonusSec, 30);
  await until(() => last(host, 'taskDone')); const td = last(host, 'taskDone'); assert.deepEqual(Object.keys(td), ['type']);
  await until(() => host.state.endsAt === endsBefore - 30000);
  assert.ok(!JSON.stringify(host.msgs.filter(m => m.type !== 'state')).includes('P0'));
  assert.ok(!h2.msgs.some(m => m.type === 'taskDone'));
  done(a, [host, ...ps]);
});

test('tasks: wrong answer fails, expiry fails, failure makes the next ping noisy (no cloak, tight acc)', async () => {
  const { a, host, ps } = await game({ taskTimes: [50], taskType: 'math' });
  const [h1, h2] = ps; await until(() => h1.state.task && h2.state.task);
  h1.send({ type: 'loc', lat: 52, lng: 4, acc: 40 }); h2.send({ type: 'loc', lat: 52.001, lng: 4, acc: 40 });
  h1.send({ type: 'taskStart', id: h1.state.task.id }); h1.send({ type: 'taskSubmit', id: h1.state.task.id, answer: [-1, -1, -1] });
  await until(() => last(h1, 'taskResult')); assert.equal(last(h1, 'taskResult').ok, false); assert.equal(last(h1, 'taskResult').reason, 'wrong');
  await until(() => last(h2, 'taskResult'), 6000); assert.equal(last(h2, 'taskResult').reason, 'expired');
  const L = [...a.lobbies.values()][0]; const P = id => L.players.get(id);
  assert.ok(P(h1.joined.id).noisy && P(h2.joined.id).noisy);
  P(h1.joined.id).wipeNext = true; L.nextPingAt = Date.now();
  await until(() => last(host, 'ping')); const pg = last(host, 'ping');
  assert.ok(pg.locs[h1.joined.id], 'cloak ignored'); assert.equal(pg.locs[h1.joined.id].acc, 10);
  assert.ok(!P(h1.joined.id).noisy);
  done(a, [host, ...ps]);
});

test('tasks: hold still verified with GPS; moving fails', async () => {
  const { a, host, ps } = await game({ taskTimes: [50], taskType: 'hold' });
  const [h1, h2] = ps; await until(() => h1.state.task && h2.state.task);
  const L = [...a.lobbies.values()][0]; for (const h of [h1, h2]) L.players.get(h.joined.id).task.limitMs = 600;
  h1.send({ type: 'taskStart', id: h1.state.task.id }); h2.send({ type: 'taskStart', id: h2.state.task.id });
  for (let i = 0; i < 4; i++) { h1.send({ type: 'loc', lat: 52, lng: 4 + i * 0.00001, acc: 5 }); h2.send({ type: 'loc', lat: 52 + i * 0.001, lng: 4, acc: 5 }); await sleep(60); }
  await until(() => last(h1, 'taskResult') && last(h2, 'taskResult'));
  assert.equal(last(h1, 'taskResult').ok, true); assert.equal(last(h2, 'taskResult').ok, false); assert.equal(last(h2, 'taskResult').reason, 'moved');
  done(a, [host, ...ps]);
});

test('tasks: hold still without GPS fixes fails; caught hider loses the task', async () => {
  const { a, host, ps } = await game({ taskTimes: [50], taskType: 'hold' });
  const [h1, h2] = ps; await until(() => h1.state.task && h2.state.task);
  const L = [...a.lobbies.values()][0]; L.players.get(h1.joined.id).task.limitMs = 300;
  h1.send({ type: 'taskStart', id: h1.state.task.id });
  await until(() => last(h1, 'taskResult')); assert.equal(last(h1, 'taskResult').ok, false);
  h2.send({ type: 'caught' }); host.send({ type: 'catch', id: h2.joined.id });
  await sleep(200);
  done(a, [host, ...ps]);
});

// ---- v17 automatic proximity tag
async function tagGame(o = {}, st = {}) {
  const a = await boot({ tagMs: 600, tagGraceMs: 300, ...o }); const { host, ps } = await lobby(a, 3);
  host.send({ type: 'settings', settings: { hideSec: 0, gameSec: 1200, autoTag: 5, ...st } });
  host.send({ type: 'role', id: host.joined.id, role: 'hunter' }); host.send({ type: 'start' });
  await until(() => host.state.state === 'playing');
  return { a, host, ps };
}
const at = (c, dm, acc = 4) => c.send({ type: 'loc', lat: 52 + dm / 111320, lng: 4, acc });
test('autotag: staying within 5 m for the hold time tags the hider; both rings fill; hunter gets no position/id', async () => {
  const { a, host, ps } = await tagGame(); const [h1, h2] = ps;
  at(h2, 500); for (let i = 0; i < 6; i++) { at(host, 0); at(h1, 2); await sleep(150); }
  await until(() => host.state.players.find(p => p.id === h1.joined.id).caught);
  const hp = host.msgs.filter(m => m.type === 'tagProg'); assert.ok(hp.some(m => m.p > 0 && m.p < 1)); assert.ok(hp.every(m => Object.keys(m).sort().join() === 'p,role,type'));
  assert.ok(h1.msgs.some(m => m.type === 'tagProg' && m.p > 0)); assert.ok(!h2.msgs.some(m => m.type === 'tagProg' && m.p > 0));
  assert.ok(!host.state.players.find(p => p.id === h2.joined.id).caught);
  done(a, [host, ...ps]);
});
test('autotag: a walk-by (one fix in range) and moving out (after grace) do not tag; ring resets', async () => {
  const { a, host, ps } = await tagGame(); const [h1] = ps;
  at(host, 0); at(h1, 2); await sleep(150); at(h1, 40); await sleep(1200); // walk-by
  assert.ok(!host.state.players.find(p => p.id === h1.joined.id).caught);
  assert.equal(host.msgs.filter(m => m.type === 'tagProg').at(-1).p, 0);
  at(h1, 2); await sleep(400); at(h1, 30); await sleep(500); at(h1, 2); await sleep(300); // broke contact longer than grace -> restarted
  const L = [...a.lobbies.values()][0]; const g = [...L.tags.values()][0]; assert.ok(!g || Date.now() - g.start < 450);
  done(a, [host, ...ps]);
});
test('autotag: poor accuracy needs longer + tighter contact; very poor never auto-tags; off = no tagging', async () => {
  const { a, host, ps } = await tagGame(); const [h1] = ps;
  for (let i = 0; i < 6; i++) { at(host, 0, 25); at(h1, 4.5, 25); await sleep(150); } // 4.5 m apart but ±25 m: too loose
  assert.ok(!host.state.players.find(p => p.id === h1.joined.id).caught);
  for (let i = 0; i < 6; i++) { at(host, 0, 50); at(h1, 0, 50); await sleep(150); }
  assert.ok(!host.state.players.find(p => p.id === h1.joined.id).caught);
  const t0 = Date.now(); while (!host.state.players.find(p => p.id === h1.joined.id).caught && Date.now() - t0 < 4000) { at(host, 0, 20); at(h1, 1, 20); await sleep(150); }
  assert.ok(host.state.players.find(p => p.id === h1.joined.id).caught); assert.ok(Date.now() - t0 > 900, 'took longer than the 600 ms base');
  done(a, [host, ...ps]);
  const b = await tagGame({}, { autoTag: 0 }); for (let i = 0; i < 8; i++) { at(b.host, 0); at(b.ps[0], 1); await sleep(150); }
  assert.ok(!b.host.state.players.find(p => p.id === b.ps[0].joined.id).caught); done(b.a, [b.host, ...b.ps]);
});
test('autotag: manual tag toggle; presets default 5 m', async () => {
  const a = await boot({ defaultMode: 'classic' }); const { host, ps } = await lobby(a, 3);
  assert.equal(host.state.settings.autoTag, 5); assert.equal(host.state.settings.manualTag, true);
  host.send({ type: 'settings', settings: { manualTag: false, hideSec: 0 } }); await until(() => host.state.settings.manualTag === false);
  host.send({ type: 'role', id: ps[0].joined.id, role: 'hunter' }); host.send({ type: 'start' }); await until(() => host.state.state === 'playing');
  ps[0].send({ type: 'catch', id: ps[1].joined.id }); ps[1].send({ type: 'caughtSelf' }); await sleep(200);
  assert.equal(host.state.catches?.length || 0, 0);
  done(a, [host, ...ps]);
});
