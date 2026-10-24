'use strict';
// v20: field-realistic simulation of the whole server loop (approach -> fast GPS -> tag), not just the core:
//  hider still, accuracy ~20 m, +-12 m jitter, Saver uploads every 5-10 s until the server switches both phones to fast GPS;
//  hunter accuracy ~5 m (+-4 m jitter), uploads every 3 s while walking / 15 s still, 1 Hz once fast. Server tick 200 ms,
//  a sample needs both fixes fresher than 4.5 s (TAG_LIVE), fast mode reaches the phone 1.5 s after the server decides.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../tagcore');
const O = { lat: 37.7596, lng: -122.4269 }, M = 1 / 111320, ML = 1 / (111320 * Math.cos(O.lat * Math.PI / 180));
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const LIVE = 4500;
// hunterPath(t) -> {n,e,moving}; returns {tagAt, fastAt} (ms) or tagAt null
function sim(hunterPath, { seed = 1, hAcc = 20, hJit = 12, xAcc = 5, xJit = 4, hBias = 0, maxMs = 150000, R = 3 } = {}) {
  const r = rng(seed), o = { ...T.DEF, R }, hist = { h: [], x: [] }, loc = {}, next = { h: r() * 8000, x: 0 }, fastAt = { h: Infinity, x: Infinity };
  const g = T.newPair(0); let fx = '', boost = false, boostOn = 0, firstFast = null;
  const fix = (tr, acc, jit, t) => ({ lat: O.lat + (tr.n + (r() * 2 - 1) * jit) * M, lng: O.lng + (tr.e + (r() * 2 - 1) * jit) * ML, acc: acc * (0.8 + r() * 0.4), t, recvAt: t });
  for (let t = 0; t <= maxMs; t += 200) {
    const xp = hunterPath(t);
    for (const [k, tr, acc, jit] of [['h', { n: hBias, e: 0 }, hAcc, hJit], ['x', xp, xAcc, xJit]]) {
      if (t >= next[k]) { const f = fix(tr, acc, jit, t); loc[k] = f; T.pushFix(hist[k], f);
        next[k] = t + (t >= fastAt[k] ? 1000 : k === 'h' ? 5000 + r() * 5000 : xp.moving ? 3000 : 15000); }
    }
    if (!loc.h || !loc.x) continue;
    const near = T.near(loc.h, loc.x, t);
    if (near || g.ratio > 0) { if (!boost) { boost = true; boostOn = t; fastAt.h = Math.min(fastAt.h, t + 1500); fastAt.x = Math.min(fastAt.x, t + 1500); next.h = Math.min(next.h, t + 1500); next.x = Math.min(next.x, t + 1500); firstFast ??= t; } }
    const live = t - loc.h.recvAt <= LIVE && t - loc.x.recvAt <= LIVE;
    if (!live) { g.lastT = t; continue; }
    const k = loc.h.t + ':' + loc.x.t; let sample = null;
    if (k !== fx) { fx = k; sample = { a: T.smooth(hist.h, t, o), b: T.smooth(hist.x, t, o) }; }
    if (T.step(g, t, sample, o) === 'tag') return { tagAt: t, fastAt: firstFast };
  }
  return { tagAt: null, fastAt: firstFast };
}
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
// hunter walks in from 80 m at 1.4 m/s and stops 1 m from the hider (arrives at ~56 s)
const ARRIVE = (80 - 1) / 1.4 * 1000;
const approach = (stopN = 1) => t => { const e = Math.max(stopN, 80 - 1.4 * t / 1000); return { n: 0, e, moving: e > stopN }; };
test('v20 sim: side by side, hider ±20 m accuracy / ±12 m jitter / Saver uploads: median < 20 s, p95 < 35 s after arrival', () => {
  const ts = [], fasts = [];
  for (let s = 1; s <= 200; s++) { const { tagAt, fastAt } = sim(approach(1), { seed: s * 7919 }); assert.ok(tagAt != null, `seed ${s} never tagged`); ts.push(tagAt - ARRIVE); fasts.push(fastAt); }
  const med = q(ts, 0.5), p95 = q(ts, 0.95);
  console.log(`# v20 time-to-tag after arrival (n=200): min ${(Math.min(...ts) / 1000).toFixed(1)}s median ${(med / 1000).toFixed(1)}s p95 ${(p95 / 1000).toFixed(1)}s max ${(Math.max(...ts) / 1000).toFixed(1)}s; fast GPS on median ${((ARRIVE - q(fasts, 0.5)) / 1000).toFixed(0)}s before arrival`);
  assert.ok(med < 20000 && p95 < 35000, `median ${med} p95 ${p95}`);
});
test('v20 sim: both phones fast already (±8 m, ±8 m acc) side by side tag in ~10-15 s', () => {
  const ts = []; for (let s = 1; s <= 100; s++) { const { tagAt } = sim(() => ({ n: 1, e: 0, moving: false }), { seed: s, hAcc: 8, hJit: 8, xAcc: 8, xJit: 8 }); ts.push(tagAt); }
  console.log(`# v20 good GPS side by side: median ${(q(ts, 0.5) / 1000).toFixed(1)}s p95 ${(q(ts, 0.95) / 1000).toFixed(1)}s`); assert.ok(q(ts, 0.95) < 25000);
});
test('v20 sim: walk-bys at 12/15/20 m (1.4 m/s) and a 3 m/s jog-by at 3 m never tag, even with a ±20 m hider', () => {
  for (const off of [12, 15, 20]) for (let s = 1; s <= 100; s++) assert.equal(sim(t => ({ n: off, e: -80 + 1.4 * t / 1000, moving: true }), { seed: s * 13 + off, maxMs: 120000 }).tagAt, null, `walk-by ${off} m seed ${s}`);
  for (let s = 1; s <= 100; s++) assert.equal(sim(t => ({ n: 3, e: -90 + 3 * t / 1000, moving: true }), { seed: s * 101, maxMs: 70000 }).tagAt, null, `jog seed ${s}`);
});
