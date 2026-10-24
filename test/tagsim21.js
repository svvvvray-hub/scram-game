'use strict';
// v21 tag simulator (shared by test/tagsim_v21.test.js and the report table). 1 Hz fixes on both phones (fast GPS already on),
// server tick 200 ms. GPS error per axis = a common-mode part shared by both phones (same sky, same multipath area; share of the
// variance = common) + each phone's own part; both time-correlated (AR(1), rho per second), sd = noiseK * reported accuracy.
const T = require(process.env.TAGCORE || '../tagcore');
const O = { lat: 37.7596, lng: -122.4269 }, M = 1 / 111320, ML = 1 / (111320 * Math.cos(O.lat * Math.PI / 180));
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); }
// hider: f(t)->{n,e,acc}; hunter: f(t)->{n,e,acc}. Returns {tagAt, trace:[{t,acc}]}
function sim(hider, hunter, { seed = 1, maxMs = 60000, rho = 0.6, noiseK = 0.5, common = 0.7, o: oo = {}, trace = false } = {}) {
  const r = rng(seed), o = { ...T.DEF, ...oo }, H = { h: [], x: [] }, E = { h: [0, 0], x: [0, 0] }, g = T.newPair(0), tr = []; let Cm = [0, 0];
  for (let t = 0; t <= maxMs; t += 200) {
    let sample = null;
    if (t % 1000 === 0) {
      const c0 = Math.sqrt(1 - rho * rho); Cm = [rho * Cm[0] + c0 * gauss(r), rho * Cm[1] + c0 * gauss(r)]; // unit common-mode error
      for (const [k, f] of [['h', hider], ['x', hunter]]) { const p = f(t), sd = noiseK * p.acc, c = Math.sqrt(1 - rho * rho), own = Math.sqrt(1 - common), cm = Math.sqrt(common) * sd;
        E[k] = [rho * E[k][0] + c * own * sd * gauss(r), rho * E[k][1] + c * own * sd * gauss(r)];
        T.pushFix(H[k], { lat: O.lat + (p.n + E[k][0] + cm * Cm[0]) * M, lng: O.lng + (p.e + E[k][1] + cm * Cm[1]) * ML, acc: p.acc * (0.85 + r() * 0.3), t }); }
      sample = { a: T.smooth(H.h, t, o), b: T.smooth(H.x, t, o) };
    }
    const res = T.step(g, t, sample, o); if (trace) tr.push({ t, acc: g.acc, d: g.dbg?.d });
    if (res === 'tag') return { tagAt: t, trace: tr };
  }
  return { tagAt: null, trace: tr };
}
const at = (n, acc, e = 0) => () => ({ n, e, acc });
const q = (xs, p) => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
// the report cases
function cases() {
  const good = 8, hunt = 5;
  return [
    ['side by side (0.5 m), good GPS ±8/±5', at(0, good), at(0.5, hunt)],
    ['side by side, weak hider GPS ±20', at(0, 20), at(0.5, hunt)],
    ['3 m static, good GPS', at(0, good), at(3, hunt)],
    ['4.5 m static, good GPS', at(0, good), at(4.5, hunt)],
    ['6 m static, good GPS', at(0, good), at(6, hunt)],
    ['3 m static, weak hider ±20', at(0, 20), at(3, hunt)],
    ['6 m static, weak hider ±20', at(0, 20), at(6, hunt)],
    ['body shield: 3 m, hider ±28 for 10 s (t=8-18 s)', t => ({ n: 0, e: 0, acc: t >= 8000 && t < 18000 ? 28 : good }), at(3, hunt)],
    ['walk-by 10 m (1.4 m/s)', at(0, good), t => ({ n: 10, e: -60 + 1.4 * t / 1000, acc: hunt })],
    ['walk-by 12 m (1.4 m/s)', at(0, good), t => ({ n: 12, e: -60 + 1.4 * t / 1000, acc: hunt })],
    ['walk-by 15 m (1.4 m/s)', at(0, good), t => ({ n: 15, e: -60 + 1.4 * t / 1000, acc: hunt })],
    ['jog-by 3 m (3 m/s)', at(0, good), t => ({ n: 3, e: -90 + 3 * t / 1000, acc: hunt })],
    ['walk-by 3 m (1.4 m/s)', at(0, good), t => ({ n: 3, e: -60 + 1.4 * t / 1000, acc: hunt })],
  ];
}
function table(N = 300, maxMs = 60000) {
  return cases().map(([name, h, x], i) => { const ts = []; for (let s = 1; s <= N; s++) ts.push(sim(h, x, { seed: s * 7919 + i * 13, maxMs }).tagAt);
    const ok = ts.filter(v => v != null); return { name, p: ok.length / N, med: q(ok, 0.5), p95: q(ok, 0.95) }; });
}
// oscillation 6 m -> 4.5 m (t=20..40 s) -> 6 m: how long after stepping back out until the ring stops rising / is empty
function oscillation(seed, o) {
  const { trace } = sim(at(0, 8), t => ({ n: t >= 20000 && t < 40000 ? 4.5 : 6, e: 0, acc: 5 }), { seed, maxMs: 60000, trace: true, o });
  const a40 = (trace.find(p => p.t === 40000) || { acc: 0 }).acc, after = trace.filter(p => p.t > 40000);
  const down = a40 === 0 ? after[0] : after.find(p => p.acc < a40); // ring below its step-back level (no longer rising) -> draining
  const empty = after.find(p => p.acc === 0), peakT = down ? down.t : 60000, peak = a40;
  const lastT = trace.length ? trace[trace.length - 1].t : 0;
  return { taggedBefore: lastT < 40000, stopMs: peakT - 40000, peak, a40, emptyMs: empty ? empty.t - 40000 : null, tagged: trace.length && trace[trace.length - 1].t < 60000 };
}
module.exports = { sim, at, q, cases, table, oscillation };
if (require.main === module) {
  const rows = table(+process.argv[2] || 200);
  for (const r of rows) console.log(`${r.name.padEnd(48)} P(tag in 60 s) ${(r.p * 100).toFixed(0).padStart(3)}%  median ${r.med == null ? '  -  ' : (r.med / 1000).toFixed(1) + ' s'}  p95 ${r.p95 == null ? '-' : (r.p95 / 1000).toFixed(1) + ' s'}`);
  const os = []; for (let s = 1; s <= 200; s++) os.push(oscillation(s * 31));
  console.log(`oscillation 6->4.5->6 m: ring stops rising after step-back median ${(q(os.map(x => x.stopMs), .5) / 1000).toFixed(1)} s p95 ${(q(os.map(x => x.stopMs), .95) / 1000).toFixed(1)} s; empty median ${(q(os.map(x => x.emptyMs), .5) / 1000).toFixed(1)} s; tagged ${os.filter(x => x.tagged).length}/200`);
}
