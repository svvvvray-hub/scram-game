'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createApp } = require('../server');
const TS = require('../public/timesync.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };

test('NTP sample math: symmetric delay recovers the true offset', () => {
  // server is 1000 ms ahead, 40 ms each way
  const s = TS.sampleOf(5000, 5000 + 40 + 1000, 5080);
  assert.equal(s.offset, 1000); assert.equal(s.rtt, 80);
});
test('bestOffset prefers low-RTT samples and ignores an asymmetric slow one', () => {
  const samples = [TS.sampleOf(0, 1030, 60), TS.sampleOf(100, 1120, 140), TS.sampleOf(200, 1600, 1000), TS.sampleOf(300, 1325, 350)];
  const b = TS.bestOffset(samples); assert.ok(Math.abs(b.offset - 1000) <= 1, 'offset ' + b.offset); assert.equal(b.rtt, 40);
  assert.equal(TS.bestOffset([]), null);
});
test('timeline: beats in order, lead 5.5 s, phases map correctly', () => {
  const at = TS.BEATS.map(b => b.at); assert.deepEqual(at, at.slice().sort((a, b) => a - b));
  assert.equal(TS.BEATS[0].at, -TS.LEAD); assert.equal(TS.phaseAt(-6000), 'before'); assert.equal(TS.phaseAt(-5000), 'hold');
  assert.equal(TS.phaseAt(-4100), '3'); assert.equal(TS.phaseAt(-2000), '2'); assert.equal(TS.phaseAt(-1000), '1'); assert.equal(TS.phaseAt(-650), 'black');
  assert.equal(TS.phaseAt(-300), 'radar'); assert.equal(TS.phaseAt(0), 'reveal'); assert.equal(TS.phaseAt(5000), 'card');
  assert.ok(TS.BEATS.find(b => b.k === 'radar').at === -600, 'radar sweep 0.6 s');
});
test('server: time echo, revealAt = start + revealMs, hide timer starts at reveal', async () => {
  let fake = 1_000_000; const a = createApp({ tickMs: 20, minSec: 0.1, defaultMode: 'custom', revealMs: 5500, now: () => fake });
  await new Promise(r => a.server.listen(0, r)); const url = `ws://127.0.0.1:${a.server.address().port}/ws`;
  const mk = () => { const ws = new WebSocket(url), c = { ws, st: null, time: null }; ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'state') c.st = m; if (m.type === 'joined') c.j = m; if (m.type === 'time') c.time = m; }); c.send = m => ws.send(JSON.stringify(m)); c.open = new Promise(r => ws.on('open', r)); return c; };
  const h = mk(), p = mk(); await h.open; await p.open;
  h.send({ type: 'time', c: 123 }); await until(() => h.time); assert.equal(h.time.c, 123); assert.equal(h.time.s, fake);
  h.send({ type: 'create', agreed: true, name: 'H' }); await until(() => h.j);
  p.send({ type: 'join', agreed: true, code: h.j.code, name: 'P' }); await until(() => h.st && h.st.players.length === 2);
  h.send({ type: 'settings', settings: { hideSec: 60, gameSec: 600, pingSec: 60 } }); await until(() => h.st.settings.hideSec === 60);
  h.send({ type: 'start' }); await until(() => h.st.state === 'hiding');
  assert.equal(h.st.revealAt, fake + 5500); assert.equal(h.st.startedAt, h.st.revealAt);
  assert.equal(h.st.hideEndsAt, h.st.revealAt + 60000, 'reveal does not eat hide time');
  assert.equal(p.st.revealAt, h.st.revealAt, 'same revealAt for everyone');
  a.server.close(); h.ws.terminate(); p.ws.terminate();
});

test('server: no role data on the wire (lobby, host pick, countdown) until revealAt; visibility rules after', async () => {
  let fake = 2_000_000; const a = createApp({ tickMs: 20, minSec: 0.1, defaultMode: 'custom', revealMs: 5500, now: () => fake });
  await new Promise(r => a.server.listen(0, r)); const url = `ws://127.0.0.1:${a.server.address().port}/ws`;
  const mk = () => { const ws = new WebSocket(url), c = { ws, st: null, msgs: [] }; ws.on('message', d => { const m = JSON.parse(d); c.msgs.push({ at: fake, m }); if (m.type === 'state') c.st = m; if (m.type === 'joined') c.j = m; }); c.send = m => ws.send(JSON.stringify(m)); c.open = new Promise(r => ws.on('open', r)); return c; };
  const cs = [mk(), mk(), mk(), mk()]; for (const c of cs) await c.open;
  cs[0].send({ type: 'create', agreed: true, name: 'H' }); await until(() => cs[0].j);
  for (const c of cs.slice(1)) { c.send({ type: 'join', agreed: true, code: cs[0].j.code, name: 'P' }); await until(() => c.j); }
  await until(() => cs[0].st.players.length === 4);
  cs.forEach((c, i) => c.send({ type: 'loc', lat: 10 + i / 1000, lng: 20, acc: 5 }));
  cs[0].send({ type: 'settings', settings: { hideSec: 60, gameSec: 600, pingSec: 60, teammates: true } });
  cs[0].send({ type: 'pick', manual: false, hunters: 2 }); await until(() => cs[0].st.hostPick?.hunters === 2);
  cs[0].send({ type: 'start' }); await until(() => cs.every(c => c.st.state === 'hiding'));
  const revealAt = cs[0].st.revealAt; fake += 3000; cs.forEach(c => c.send({ type: 'loc', lat: 11, lng: 21, acc: 5 })); await sleep(150);
  const ROLE = /"role"|"startRole"|hunter"|hider"|"photos"|"last"|"decoys"|"drops"/;
  for (const c of cs) { const pre = c.msgs.filter(x => x.at < revealAt);
    assert.ok(pre.length > 3 && pre.every(x => !ROLE.test(JSON.stringify(x.m))), 'no role data before revealAt: ' + (pre.map(x => JSON.stringify(x.m)).find(j => ROLE.test(j)) || '')); }
  assert.ok(cs.slice(1).every(c => !c.msgs.some(x => 'hostPick' in x.m)), 'host pick never sent to players');
  fake = revealAt + 10; await until(() => cs.every(c => c.st.players.some(p => p.role)));
  const roles = Object.fromEntries(cs[0].st.players.map(p => [p.id, p.role])); assert.equal(Object.values(roles).filter(r => r === 'hunter').length, 2);
  for (const c of cs) { const me = roles[c.j.id], seen = c.st.players.filter(p => p.loc && p.id !== c.j.id);
    assert.ok(seen.every(p => roles[p.id] === me), `${me} only sees own side live`); }
  a.server.close(); cs.forEach(c => c.ws.terminate());
});
