'use strict';
// v19 proximity-tag core (pure, unit-tested with simulated GPS noise). Server-only: positions never leave the server.
//  close  = smoothed distance <= R + k*(accA+accB)   (overlap of the two accuracy circles, tolerance capped)
//  progress runs while > 60% of the samples in the last 10 s are close (one far sample doesn't reset it)
//  reset  = clearly far (> 15 m) for 3 s in a row, or no close sample for a whole window
//  pause  = accuracy worse than 25 m (or no fresh fixes; handled by the caller)
const DEF = { R: 3, k: 0.5, maxTolM: 7, tagMs: 10000, windowMs: 10000, ratio: 0.6, minSamples: 5, farM: 15, farMs: 3000, maxAcc: 25, smoothN: 4, smoothMs: 6000,
  // v20: poor accuracy -> average more fixes; a pair that has stayed inside zoneM for zoneMs earns a wider tolerance
  poorAcc: 12, smoothNPoor: 8, smoothMsPoor: 10000, zoneM: 14, zoneMs: 10000, maxTolZoneM: 12, zoneGate: true,
  // v20 approach phase: fast GPS on both phones once a hunter may be within nearM (generous: minus both accuracies + possible walking since the fix)
  nearM: 40, nearStaleMs: 30000, walkMps: 2 };
const rad = d => d * Math.PI / 180;
function distM(a, b) { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))); }
// mean of the last N fixes (within smoothMs) -> damps independent GPS wander
function smooth(hist, t, o = DEF) {
  const last = (hist || [])[(hist || []).length - 1], poor = last && (last.acc || 0) > o.poorAcc;
  const xs = (hist || []).filter(f => t - f.t <= (poor ? o.smoothMsPoor : o.smoothMs)).slice(-(poor ? o.smoothNPoor : o.smoothN)); if (!xs.length) return null;
  const n = xs.length; return { lat: xs.reduce((s, f) => s + f.lat, 0) / n, lng: xs.reduce((s, f) => s + f.lng, 0) / n, acc: xs.reduce((s, f) => s + (f.acc || 0), 0) / n, n };
}
function pushFix(hist, f, o = DEF) { hist.push(f); while (hist.length > Math.max(o.smoothN, o.smoothNPoor || 0) + 2) hist.shift(); return hist; }
function newPair(t) { return { acc: 0, lastT: t, samples: [], farSince: 0, lastClose: t, fixes: 0, dbg: null }; }
// sample: {a, b} smoothed positions when a NEW fix arrived (else null). Returns 'tag' | 'reset' | 'run' | 'pause'
function step(g, t, sample, o = DEF) {
  const dt = Math.max(0, Math.min(1000, t - g.lastT)); g.lastT = t;
  if (sample) {
    const { a, b } = sample, d = distM(a, b);
    if (d <= o.zoneM) { g.zoneSince ||= t; } else g.zoneSince = 0; // time-in-zone (not a tight distance) is what keeps walk-bys out
    const cap = g.zoneSince && t - g.zoneSince >= o.zoneMs ? o.maxTolZoneM : o.maxTolM;
    const tol = Math.min(cap, o.k * ((a.acc || 0) + (b.acc || 0))), close = d <= o.R + tol;
    const bad = Math.max(a.acc || 0, b.acc || 0) > o.maxAcc;
    g.samples.push({ t, close, d }); g.fixes++; if (close) g.lastClose = t;
    if (d > o.farM) { g.farSince ||= t; } else g.farSince = 0;
    g.bad = bad; g.dbg = { d: Math.round(d * 10) / 10, accA: Math.round(a.acc || 0), accB: Math.round(b.acc || 0), lim: Math.round((o.R + tol) * 10) / 10, zone: g.zoneSince ? Math.round((t - g.zoneSince) / 1000) : 0 };
  }
  g.samples = g.samples.filter(s => t - s.t <= o.windowMs);
  const n = g.samples.length, ratio = n ? g.samples.filter(s => s.close).length / n : 0; g.ratio = ratio; if (g.dbg) g.dbg.pct = Math.round(ratio * 100);
  // pairs are tracked continuously (history kept), so a jog-by arrives with its far samples still in the window
  if ((g.farSince && t - g.farSince >= o.farMs) || t - g.lastClose > o.windowMs) { const had = g.acc > 0; g.acc = 0; return had ? 'reset' : 'idle'; }
  if (g.bad) return 'pause';
  const dwell = !o.zoneGate || (g.zoneSince && t - g.zoneSince >= o.zoneMs); // a tag also needs zoneMs continuously inside zoneM (runs alongside progress): walk-bys leave the zone first
  if (n >= o.minSamples && ratio > o.ratio) { g.acc += dt; if (g.acc >= o.tagMs && dwell) return 'tag'; if (g.acc >= o.tagMs) g.acc = o.tagMs - 1; return 'run'; }
  return 'pause';
}
// generous "a hunter may be close" check on the latest raw fixes (ages in ms): drives fast GPS before any ring progress exists
function near(a, b, t, o = DEF) {
  if (!a || !b) return false; const ageA = t - (a.recvAt ?? a.t ?? t), ageB = t - (b.recvAt ?? b.t ?? t);
  if (ageA > o.nearStaleMs || ageB > o.nearStaleMs) return false;
  return distM(a, b) - (a.acc || 0) - (b.acc || 0) - o.walkMps * (ageA + ageB) / 1000 <= o.nearM;
}
module.exports = { DEF, near, smooth, pushFix, newPair, step, distM };
