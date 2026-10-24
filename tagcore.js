'use strict';
// v21 proximity-tag core (pure, simulation-tested). Server-only: positions never leave the server.
//  smoothing = per-player 2D Kalman filter (random-walk motion). Each fix is weighted by its accuracy, recent fixes count
//              most, and a fix that jumps further than the noise explains ("you moved") snaps the estimate -> fast release.
//  close     = smoothed distance <= R + min(maxTolM, k*(sdA+sdB))  (sd = the filter's own uncertainty, much smaller than raw accuracy)
//  ring      = fills 1x while the evidence says close, DRAINS 2x while it says not close, holds in a 1 m hysteresis band.
//  weak fix  = accuracy worse than maxAcc (body shield, indoors): no new "close" evidence; only a clearly-far reading drains.
//  gaps      = stale fixes are handled by the caller (pause, then the confirm fallback).
const DEF = { R: 3, k: 0.6, maxTolM: 2, poorAcc: 12, maxTolPoorM: 5, tagMs: 10000, drainX: 2, hystM: 0, farPadM: 4, maxAcc: 25, minSamples: 3, evidenceMs: 2500,
  accelMps2: 0.4, v0Var: 1, accSd: 0.6, gateSd: 3, histN: 30, histMs: 60000,
  // approach phase (v20): fast GPS on both phones once a hunter may be within nearM (generous)
  nearM: 40, nearStaleMs: 30000, walkMps: 2 };
const rad = d => d * Math.PI / 180;
function distM(a, b) { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))); }
// Constant-velocity Kalman filter per axis over the fix history (recomputed each time: deterministic, history is short).
// Tracks walking without lag (velocity is part of the state), averages jitter when still, and weights each fix by its accuracy
// (acc ~ 68% radius -> sd = acc*accSd per axis). A jump the noise can't explain inflates the uncertainty -> it snaps to the new fix.
function kf1(zs, o) { // zs: [{z, t, Rm}] -> {p, v, P00}
  let p = zs[0].z, v = 0, a = zs[0].Rm, b = 0, d = o.v0Var, lt = zs[0].t; const qa = o.accelMps2 ** 2;
  for (let i = 1; i < zs.length; i++) {
    const { z, t, Rm } = zs[i], dt = Math.max(0.05, (t - lt) / 1000); lt = t;
    p += v * dt; const a1 = a + 2 * dt * b + dt * dt * d + qa * dt ** 4 / 4, b1 = b + dt * d + qa * dt ** 3 / 2, d1 = d + qa * dt * dt; a = a1; b = b1; d = d1;
    let y = z - p; if (Math.abs(y) > o.gateSd * Math.sqrt(a + Rm)) { a += y * y / 2; d += y * y / (2 * dt * dt); } // unexplained jump = real move
    const S = a + Rm, k0 = a / S, k1 = b / S; p += k0 * y; v += k1 * y;
    const na = (1 - k0) * a, nb = (1 - k0) * b, nd = d - k1 * b; a = na; b = nb; d = nd;
  }
  return { p, v, a, lt };
}
function smooth(hist, t, o = DEF) {
  const xs = (hist || []).filter(f => t - f.t <= o.histMs); if (!xs.length) return null;
  const f0 = xs[0], mLat = 111320, mLng = 111320 * Math.cos(rad(f0.lat)), Rm = f => Math.max(1, ((f.acc || 10) * o.accSd) ** 2);
  const X = kf1(xs.map(f => ({ z: (f.lng - f0.lng) * mLng, t: f.t, Rm: Rm(f) })), o), Y = kf1(xs.map(f => ({ z: (f.lat - f0.lat) * mLat, t: f.t, Rm: Rm(f) })), o);
  const last = xs[xs.length - 1], sd = Math.sqrt((X.a + Y.a) / 2), speed = Math.hypot(X.v, Y.v);
  return { lat: f0.lat + Y.p / mLat, lng: f0.lng + X.p / mLng, sd, acc: last.acc || 0, n: xs.length, speed };
}
function pushFix(hist, f, o = DEF) { hist.push(f); while (hist.length > o.histN) hist.shift(); return hist; }
function newPair(t) { return { acc: 0, lastT: t, ev: 'none', evT: 0, fixes: 0, dbg: null, ratio: 0 }; }
// sample: {a, b} smoothed positions when a NEW fix arrived (else null). Returns 'tag' | 'run' | 'drain' | 'pause' | 'idle'
function step(g, t, sample, o = DEF) {
  const dt = Math.max(0, Math.min(1000, t - g.lastT)); g.lastT = t;
  if (sample) {
    const { a, b } = sample, d = distM(a, b), sdA = a.sd ?? (a.acc || 0) * o.accSd, sdB = b.sd ?? (b.acc || 0) * o.accSd;
    const poor = Math.max(a.acc || 0, b.acc || 0) > o.poorAcc, lim = o.R + Math.min(poor ? o.maxTolPoorM : o.maxTolM, o.k * (sdA + sdB)), weak = Math.max(a.acc || 0, b.acc || 0) > o.maxAcc;
    g.fixes++; g.evT = t;
    g.ev = weak ? (d > lim + o.farPadM ? 'far' : 'none') : d <= lim ? (g.fixes >= o.minSamples ? 'close' : 'none') : d <= lim + o.hystM ? 'none' : 'far';
    g.weak = weak;
    g.dbg = { d: Math.round(d * 10) / 10, accA: Math.round(a.acc || 0), accB: Math.round(b.acc || 0), lim: Math.round(lim * 10) / 10, sd: Math.round((sdA + sdB) * 10) / 10, ev: g.ev };
  }
  if (t - g.evT > o.evidenceMs) g.ev = 'none';
  g.ratio = g.ev === 'close' ? 1 : g.acc > 0 ? 0.5 : 0; // > 0 = "something going on" (keeps fast GPS on)
  if (g.dbg) g.dbg.pct = Math.round(Math.min(1, g.acc / o.tagMs) * 100);
  if (g.ev === 'close') { g.acc += dt; return g.acc >= o.tagMs ? 'tag' : 'run'; }
  if (g.ev === 'far') { if (g.acc <= 0) return 'idle'; g.acc = Math.max(0, g.acc - o.drainX * dt); return g.acc ? 'drain' : 'reset'; }
  return g.acc > 0 ? 'pause' : 'idle';
}
// generous "a hunter may be close" check on the latest raw fixes (ages in ms): drives fast GPS before any ring progress exists
function near(a, b, t, o = DEF) {
  if (!a || !b) return false; const ageA = t - (a.recvAt ?? a.t ?? t), ageB = t - (b.recvAt ?? b.t ?? t);
  if (ageA > o.nearStaleMs || ageB > o.nearStaleMs) return false;
  return distM(a, b) - (a.acc || 0) - (b.acc || 0) - o.walkMps * (ageA + ageB) / 1000 <= o.nearM;
}
module.exports = { DEF, near, smooth, pushFix, newPair, step, distM };
