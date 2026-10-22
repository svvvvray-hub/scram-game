// Adaptive GPS upload throttle (battery saver). UMD: browser global `GpsThrottle`, Node require() for unit tests.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.GpsThrottle = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const C = { FAST_MS: 4000, MIN_MS: 3000, SLOW_MS: 15000, STILL_M: 5, ENEMY_M: 150 };
  const dist = (a, b) => { const R = 6371000, r = d => d * Math.PI / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); };
  // loc: newest fix; last: {lat,lng,t} of the last upload; enemies/hot: [{lat,lng}] (known enemy positions, drops, bounty);
  // urgent: compass phase / pickup in progress; force: server asked for a fresh fix (need_fix) or a catch claim.
  function decide({ now, loc, last, enemies = [], hot = [], urgent = false, force = false }) {
    if (!loc) return { send: false, saver: false, interval: C.FAST_MS };
    if (!last || force) return { send: true, saver: false, interval: C.FAST_MS, reason: force ? 'force' : 'first' };
    const moved = dist(loc, last), near = [...enemies, ...hot].some(p => p && dist(loc, p) <= C.ENEMY_M);
    const saver = !urgent && moved < C.STILL_M && !near;
    const interval = saver ? C.SLOW_MS : (moved >= C.STILL_M ? C.MIN_MS : C.FAST_MS);
    return { send: now - last.t >= interval, saver, interval, moved, near };
  }
  return { decide, dist, C };
});
