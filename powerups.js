'use strict';
// Random power-up drops: pure helpers (server-only). Effects live in server.js.
const Field = require('./public/field');
const HIDER = { radar: 21.67, jammer: 21.67, silent: 21.66, shield: 15, extraTime: 10, revive: 10 }; // rare: Extra Time / Revive ~10 %, Shield ~15 %
const HUNTER = { sonar: 1, truth: 1, shrink: 1, campeek: 1, heat: 1, hound: 1 };
const INFO = {
  radar: ['📡', 'Hunter Radar'], jammer: ['📵', 'Jammer'], silent: ['🤫', 'Silent Shoes'], shield: ['🛡️', 'Shield'], extraTime: ['⏩', 'Extra Time'], revive: ['💖', 'Revive'],
  sonar: ['🔊', 'Sonar'], truth: ['🔍', 'Truth Ping'], shrink: ['🎯', 'Shrink Zone'], campeek: ['📷', 'Cam Peek+'], heat: ['🔥', 'Heat Trail'], hound: ['🐕', 'Bloodhound'],
};
function roll(side, rnd = Math.random) {
  const w = side === 'hider' ? HIDER : HUNTER, tot = Object.values(w).reduce((a, b) => a + b, 0);
  let x = rnd() * tot; for (const [k, v] of Object.entries(w)) { if ((x -= v) < 0) return k; } return Object.keys(w).at(-1);
}
const R_E = 6371000, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function offsetM(p, dist, brg) {
  const d = dist / R_E, th = rad(brg), la1 = rad(p.lat), lo1 = rad(p.lng);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(th));
  const lo2 = lo1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: deg(la2), lng: ((deg(lo2) + 540) % 360) - 180 };
}
// 50-200 m from `center`, inside `field`; among candidates prefer the one farthest from `avoid` points.
function spawnPoint(center, avoid, field, rnd = Math.random, lo = 50, hi = 200) {
  const cands = [];
  for (let i = 0; i < 200 && cands.length < 24; i++) { const q = offsetM(center, lo + rnd() * (hi - lo), rnd() * 360); if (Field.inField(field, q)) cands.push(q); }
  if (!cands.length) return null;
  if (!avoid || !avoid.length) return cands[0];
  const score = q => Math.min(...avoid.map(a => Field.distM(a, q)));
  return cands.reduce((b, q) => score(q) > score(b) ? q : b);
}
// shrink the field 30 % (k = 0.7): circle radius, polygon toward its centroid. No field -> circle on the hunters' centroid.
function shrinkField(field, k, hunters, players) {
  if (field && (field.circle || field.poly)) {
    const out = { circle: null, poly: null };
    if (field.circle) out.circle = { ...field.circle, r: Math.max(10, Math.round(field.circle.r * k)) };
    if (field.poly) { const c = field.poly.reduce((a, [la, lo]) => [a[0] + la / field.poly.length, a[1] + lo / field.poly.length], [0, 0]);
      out.poly = field.poly.map(([la, lo]) => [c[0] + (la - c[0]) * k, c[1] + (lo - c[1]) * k]); }
    return out;
  }
  const hs = hunters.length ? hunters : players; if (!hs.length) return null;
  const c = { lat: hs.reduce((s, p) => s + p.lat, 0) / hs.length, lng: hs.reduce((s, p) => s + p.lng, 0) / hs.length };
  const r = Math.max(30, ...players.map(p => Field.distM(c, p))) * k;
  return { circle: { lat: c.lat, lng: c.lng, r: Math.round(r) }, poly: null };
}
module.exports = { HIDER, HUNTER, INFO, roll, spawnPoint, shrinkField, offsetM };
