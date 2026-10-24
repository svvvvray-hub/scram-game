'use strict';
// v19: simulate realistic GPS noise (independent +-8 m jitter per fix, 1 Hz) against the proximity-tag core.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../tagcore');
const O = { lat: 37.7596, lng: -122.4269 }, M = 1 / 111320, ML = 1 / (111320 * Math.cos(O.lat * Math.PI / 180));
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
// truth(t) -> {n, e} metres; returns time to tag in ms, or null
function run(truthA, truthB, { seed = 1, jitter = 8, acc = 8, maxMs = 60000, R = 3 } = {}) {
  const r = rng(seed), o = { ...T.DEF, R }, ha = [], hb = []; let g = null; const fix = (tr, t) => ({ lat: O.lat + (tr.n + (r() * 2 - 1) * jitter) * M, lng: O.lng + (tr.e + (r() * 2 - 1) * jitter) * ML, acc: acc * (0.8 + r() * 0.4), t });
  for (let t = 0; t <= maxMs; t += 200) {
    let sample = null;
    if (t % 1000 === 0) { T.pushFix(ha, fix(truthA(t), t)); T.pushFix(hb, fix(truthB(t + 500), t)); const a = T.smooth(ha, t, o), b = T.smooth(hb, t, o); sample = { a, b }; }
    if (!g) { if (!sample) continue; g = T.newPair(t); }
    const res = T.step(g, t, sample, o);
    if (res === 'tag') return t;
  }
  return null;
}
test('tag sim: phones side by side (+-8 m jitter, 1 Hz) all tag within 20 s (20 trials)', () => {
  const times = [];
  for (let s = 1; s <= 20; s++) { const t = run(() => ({ n: 0, e: 0 }), () => ({ n: 0.5, e: 0 }), { seed: s * 7919 }); assert.ok(t != null && t <= 20000, `trial ${s}: ${t}`); times.push(t); }
  const avg = times.reduce((a, b) => a + b, 0) / times.length; console.log(`# time-to-tag side by side: min ${Math.min(...times) / 1000}s avg ${(avg / 1000).toFixed(1)}s max ${Math.max(...times) / 1000}s`);
});
test('tag sim: noisier phones (+-12 m, acc 15) side by side still tag within 30 s', () => {
  for (let s = 1; s <= 20; s++) { const t = run(() => ({ n: 0, e: 0 }), () => ({ n: 1, e: 0 }), { seed: s * 31, jitter: 12, acc: 15 }); assert.ok(t != null && t <= 30000, `trial ${s}: ${t}`); }
});
test('tag sim: a hunter jogging past at 3 m/s (3 m away) never tags', () => {
  for (let s = 1; s <= 20; s++) assert.equal(run(() => ({ n: 0, e: 0 }), t => ({ n: 3, e: -90 + 3 * t / 1000 }), { seed: s * 101 }), null, `trial ${s}`);
});
test('tag sim: walk-bys at 10 m+ (1.4 m/s) never tag', () => {
  for (const off of [10, 12, 15]) for (let s = 1; s <= 20; s++) assert.equal(run(() => ({ n: 0, e: 0 }), t => ({ n: off, e: -60 + 1.4 * t / 1000 }), { seed: s * 13 + off }), null, `off ${off} trial ${s}`);
});
test('tag sim: standing 20 m apart never tags; very poor accuracy (> 25 m) pauses', () => {
  for (let s = 1; s <= 10; s++) assert.equal(run(() => ({ n: 0, e: 0 }), () => ({ n: 20, e: 0 }), { seed: s }), null);
  for (let s = 1; s <= 5; s++) assert.equal(run(() => ({ n: 0, e: 0 }), () => ({ n: 0.5, e: 0 }), { seed: s, acc: 40, maxMs: 30000 }), null);
});
