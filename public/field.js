// Playing-field geometry, shared by server (require) and browser (window.Field).
// field = null (no boundary) | { circle: {lat,lng,r} | null, poly: [[lat,lng],...] | null }
// With both set the field is the INTERSECTION (inside the circle AND inside the polygon).
(function (root, f) { if (typeof module === 'object' && module.exports) module.exports = f(); else root.Field = f(); })(this, function () {
  'use strict';
  const R = 6371000, rad = d => d * Math.PI / 180;
  const MILE = 1609.344, PRESETS = [0.25, 0.5, 1].map(m => Math.round(m * MILE)); // 402, 805, 1609 m
  const MAX_POINTS = 50;
  function distM(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const inCircle = (c, p) => distM(c, p) <= c.r;
  function inPolygon(poly, p) { // ray casting in lat/lng (fine for fields a few km wide)
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > p.lat) !== (yj > p.lat) && p.lng < (xj - xi) * (p.lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inField(field, p) {
    if (!field) return true;
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
    if (field.circle && !inCircle(field.circle, p)) return false;
    if (field.poly && !inPolygon(field.poly, p)) return false;
    return true;
  }
  function bbox(field) {
    let s = -90, n = 90, w = -180, e = 180;
    if (field.circle) { const c = field.circle, dLat = c.r / 111320, dLng = c.r / (111320 * Math.max(0.01, Math.cos(rad(c.lat))));
      s = c.lat - dLat; n = c.lat + dLat; w = c.lng - dLng; e = c.lng + dLng; }
    if (field.poly) { const la = field.poly.map(p => p[0]), lo = field.poly.map(p => p[1]);
      s = Math.max(s, Math.min(...la)); n = Math.min(n, Math.max(...la)); w = Math.max(w, Math.min(...lo)); e = Math.min(e, Math.max(...lo)); }
    return { s, n, w, e };
  }
  function randomPoint(field, rnd = Math.random, tries = 3000) {
    const b = bbox(field); if (b.s > b.n || b.w > b.e) return null;
    for (let i = 0; i < tries; i++) { const p = { lat: b.s + rnd() * (b.n - b.s), lng: b.w + rnd() * (b.e - b.w) }; if (inField(field, p)) return p; }
    return null;
  }
  const okLat = v => Number.isFinite(v) && Math.abs(v) <= 85, okLng = v => Number.isFinite(v) && Math.abs(v) <= 180;
  // Returns { field } (normalized; null = no boundary) or { error }.
  function validate(f) {
    if (f == null || (!f.circle && !f.poly)) return { field: null };
    if (typeof f !== 'object') return { error: 'Bad field' };
    const out = { circle: null, poly: null };
    if (f.circle) {
      const lat = Number(f.circle.lat), lng = Number(f.circle.lng), r = Number(f.circle.r);
      if (!okLat(lat) || !okLng(lng)) return { error: 'Bad circle center' };
      if (!Number.isFinite(r) || r < 50 || r > 5000) return { error: 'Circle radius must be 50-5000 m' };
      out.circle = { lat, lng, r: Math.round(r) };
    }
    if (f.poly) {
      if (!Array.isArray(f.poly) || f.poly.length < 3) return { error: 'Shape needs at least 3 points' };
      if (f.poly.length > MAX_POINTS) return { error: `Shape can have at most ${MAX_POINTS} points` };
      const pts = [];
      for (const q of f.poly) { const lat = Number(q && q[0]), lng = Number(q && q[1]); if (!okLat(lat) || !okLng(lng)) return { error: 'Bad shape point' }; pts.push([lat, lng]); }
      const la = pts.map(p => p[0]), lo = pts.map(p => p[1]);
      const span = distM({ lat: Math.min(...la), lng: Math.min(...lo) }, { lat: Math.max(...la), lng: Math.max(...lo) });
      if (span > 20000) return { error: 'Shape is too big (max ~20 km across)' };
      if (span < 20) return { error: 'Shape is too small' };
      out.poly = pts;
    }
    if (!randomPoint(out, Math.random, 5000)) return { error: 'Circle and shape do not overlap' };
    return { field: out };
  }
  return { distM, inCircle, inPolygon, inField, randomPoint, validate, bbox, PRESETS, MAX_POINTS, MILE };
});
