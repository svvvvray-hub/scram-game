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
