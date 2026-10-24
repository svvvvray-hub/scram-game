'use strict';
// v19: power-up drops on walkable ground. Server-side Overpass fetch (timeout, cached per game), then drop points are
// sampled along walkable OSM ways, inside the field and outside buildings. Any failure -> caller falls back to random placement.
const Field = require('./public/field');
const WALK = ['residential', 'footway', 'path', 'pedestrian', 'living_street', 'service', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link',
  'primary', 'primary_link', 'track', 'steps', 'cycleway', 'bridleway', 'corridor', 'road']; // never motorway / trunk
const DEFAULT_URL = 'https://overpass-api.de/api/interpreter';
const MAX_SPAN_M = 6000; // don't ask Overpass for huge areas
function query([s, w, n, e], timeoutS = 8) {
  const bb = `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;
  return `[out:json][timeout:${timeoutS}];(way["highway"~"^(${WALK.join('|')})$"](${bb});way["building"](${bb}););out geom;`;
}
function bboxOf(field, pts = [], padM = 300) {
  let la = [], lo = [];
  if (field?.poly) for (const [a, b] of field.poly) { la.push(a); lo.push(b); }
  if (field?.circle) { const c = field.circle, dLa = c.r / 111320, dLo = c.r / (111320 * Math.cos(c.lat * Math.PI / 180)); la.push(c.lat - dLa, c.lat + dLa); lo.push(c.lng - dLo, c.lng + dLo); }
  if (!la.length) { for (const p of pts) { la.push(p.lat); lo.push(p.lng); } if (!la.length) return null; }
  const s = Math.min(...la), n = Math.max(...la), w = Math.min(...lo), e = Math.max(...lo), mid = (s + n) / 2, pLa = (field ? 20 : padM) / 111320, pLo = (field ? 20 : padM) / (111320 * Math.cos(mid * Math.PI / 180));
  const b = [s - pLa, w - pLo, n + pLa, e + pLo];
  if (Field.distM({ lat: b[0], lng: b[1] }, { lat: b[2], lng: b[3] }) > MAX_SPAN_M) return null;
  return b;
}
// parse an Overpass JSON response into walkable segments + building rings
function parse(json) {
  const segs = [], buildings = [];
  for (const el of (json && Array.isArray(json.elements) ? json.elements : [])) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const g = el.geometry.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map(p => [p.lat, p.lon]); if (g.length < 2) continue;
    const t = el.tags || {};
    if (t.building && t.building !== 'no') { if (g.length >= 3) buildings.push(g); continue; }
    if (!WALK.includes(t.highway) || t.access === 'private' || t.foot === 'no') continue;
    for (let i = 1; i < g.length; i++) { const a = { lat: g[i - 1][0], lng: g[i - 1][1] }, b = { lat: g[i][0], lng: g[i][1] }, len = Field.distM(a, b); if (len > 0.5) segs.push({ a, b, len }); }
  }
  return { segs, buildings };
}
async function fetchWalk(bbox, { fetch: f = globalThis.fetch, url = DEFAULT_URL, timeoutMs = 9000 } = {}) {
  const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'LastPing/1 (hide-and-seek game)' },
    body: 'data=' + encodeURIComponent(query(bbox, Math.ceil(timeoutMs / 1000))), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('overpass HTTP ' + r.status);
  const w = parse(await r.json()); if (!w.segs.length) throw new Error('no walkable ways');
  return w;
}
const inRing = (ring, q) => { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [yi, xi] = ring[i], [yj, xj] = ring[j];
  if ((yi > q.lat) !== (yj > q.lat) && q.lng < (xj - xi) * (q.lat - yi) / (yj - yi) + xi) ins = !ins; } return ins; };
function nearBuilding(buildings, q, m = 4) {
  for (const b of buildings) { if (Math.abs(b[0][0] - q.lat) > 0.003) continue; if (inRing(b, q)) return true; if (b.some(([la, lo]) => Field.distM({ lat: la, lng: lo }, q) < m)) return true; }
  return false;
}
// length-weighted random point on the walkable network
function samplePoint(walk, rand) {
  if (!walk._cum) { let c = 0; walk._cum = walk.segs.map(s => (c += s.len)); walk._total = c; }
  const x = rand() * walk._total; let lo = 0, hi = walk._cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (walk._cum[m] < x) lo = m + 1; else hi = m; }
  const s = walk.segs[lo], k = rand(); return { lat: s.a.lat + (s.b.lat - s.a.lat) * k, lng: s.a.lng + (s.b.lng - s.a.lng) * k };
}
// like PU.spawnPoint but only on walkable ways: lo..hi metres from center (if given), inside the field, not in/next to a building
function spawnOnWalk(walk, center, avoid, field, rand = Math.random, lo = 50, hi = 200) {
  if (!walk || !walk.segs || !walk.segs.length) return null;
  const cands = [];
  for (let i = 0; i < 600 && cands.length < 24; i++) { const q = samplePoint(walk, rand);
    if (center) { const d = Field.distM(center, q); if (d < lo || d > hi) continue; }
    if (field && !Field.inField(field, q)) continue; if (nearBuilding(walk.buildings, q)) continue; cands.push(q); }
  if (!cands.length) return null;
  if (!avoid || !avoid.length) return cands[0];
  const score = q => Math.min(...avoid.map(a => Field.distM(a, q)));
  return cands.reduce((b, q) => score(q) > score(b) ? q : b);
}
const onWalk = (walk, q, tolM = 3) => walk.segs.some(s => { // distance point -> segment (local flat approx)
  const k = Math.cos(q.lat * Math.PI / 180) * 111320, ax = (s.a.lng - q.lng) * k, ay = (s.a.lat - q.lat) * 111320, bx = (s.b.lng - q.lng) * k, by = (s.b.lat - q.lat) * 111320;
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(ax + t * dx, ay + t * dy) <= tolM; });
module.exports = { WALK, DEFAULT_URL, query, bboxOf, parse, fetchWalk, spawnOnWalk, samplePoint, nearBuilding, onWalk };
