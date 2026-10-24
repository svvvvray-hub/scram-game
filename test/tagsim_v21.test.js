'use strict';
// v21: tighter range, fast release, drain-instead-of-hold. Field-like GPS noise model in test/tagsim21.js (common-mode + own error,
// time-correlated). Prints the per-case table (P(tag within 60 s), median, p95).
const test = require('node:test');
const assert = require('node:assert');
const T = require('../tagcore');
const S = require('./tagsim21');
const rows = S.table(200);
const R = n => rows.find(r => r.name.startsWith(n));
test('v21 sim table', () => { for (const r of rows) console.log(`# ${r.name}: P ${(r.p * 100).toFixed(0)}% median ${r.med == null ? '-' : (r.med / 1000).toFixed(1) + ' s'} p95 ${r.p95 == null ? '-' : (r.p95 / 1000).toFixed(1) + ' s'}`); });
test('v21 sim: side by side tags reliably with a median <= 15 s', () => { const r = R('side by side (0.5 m)'); assert.ok(r.p >= 0.97 && r.med <= 15000, JSON.stringify(r)); });
test('v21 sim: range is tight: 3 m usually tags, 6 m rarely (and far less than 3 m)', () => {
  assert.ok(R('3 m static, good').p >= 0.9); assert.ok(R('6 m static, good').p <= 0.4); assert.ok(R('4.5 m static, good').p < R('3 m static, good').p);
});
test('v21 sim: walk-bys at 10/12/15 m and a 3 m/s jog-by never tag; a slow walk past at 3 m almost never', () => {
  for (const n of ['walk-by 10', 'walk-by 12', 'walk-by 15', 'jog-by 3']) assert.equal(R(n).p, 0, n); assert.ok(R('walk-by 3 m').p <= 0.05);
});
test('v21 sim: body shield (±28 m for 10 s) holds the ring instead of resetting; re-registers at 3 m', () => {
  const r = R('body shield'); assert.ok(r.p >= 0.85, JSON.stringify(r));
});
test('v21 sim: oscillation 6 -> 4.5 -> 6 m: the ring stops rising after stepping back (median <= 3 s)', () => {
  const os = []; for (let s = 1; s <= 200; s++) os.push(S.oscillation(s * 31)); const f = os.filter(x => !x.taggedBefore && x.a40 > 0);
  const med = S.q(f.map(x => x.stopMs), 0.5); console.log(`# oscillation: n ${f.length}, stop median ${med / 1000}s, p75 ${S.q(f.map(x => x.stopMs), 0.75) / 1000}s`); assert.ok(med <= 3000);
});
test('v21 core: "not close" drains at 2x the fill rate; weak accuracy holds; only a clear far reading drains when weak', () => {
  const g = T.newPair(0), O = { lat: 52, lng: 4 }, P = (dm, acc = 4) => ({ lat: 52 + dm / 111320, lng: 4, acc, sd: 1 });
  let t = 0; for (let i = 0; i < 40; i++) { t += 200; T.step(g, t, i % 5 === 0 ? { a: P(0), b: P(1) } : null); }
  const full = g.acc; assert.ok(full > 4000);
  for (let i = 0; i < 5; i++) { t += 200; T.step(g, t, i === 0 ? { a: P(0), b: P(10) } : null); } assert.ok(Math.abs(full - g.acc - 2000) < 1, 'drained 2x for 1 s');
  const h = g.acc; t += 200; T.step(g, t, { a: P(0, 28), b: P(5) }); t += 800; T.step(g, t, null); assert.equal(g.acc, h, 'weak + not clearly far: hold');
  t += 200; T.step(g, t, { a: P(0, 28), b: P(20) }); t += 500; T.step(g, t, null); assert.ok(g.acc < h, 'weak but clearly far: drains');
});
