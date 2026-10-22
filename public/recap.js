// End-of-game recap math, shared by server (require) and browser (window.Recap).
// recap = { startedAt, hideEndsAt, endedAt, players:[{id,name,startRole,role,caught,caughtAt,caughtBy}],
//           trails:{id:[[t,lat,lng,r]]} (r: 'h' hunter, 's' uncaught hider, 'c' caught), log:[{t,k,...}] }
(function (root, f) { if (typeof module === 'object' && module.exports) module.exports = f(); else root.Recap = f(); })(this, function () {
  'use strict';
  const rad = d => d * Math.PI / 180;
  function distM(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const P = q => ({ lat: q[1], lng: q[2] });
  const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  // position of a trail at time t (linear between samples <= 20 s apart, or nearest sample within 7.5 s); role filter optional
  function posAt(tr, t, role) {
    if (!tr || !tr.length) return null;
    let prev = null, next = null;
    for (const q of tr) { if (role && q[3] !== role) continue; if (q[0] <= t) prev = q; else { next = q; break; } }
    if (prev && next && next[0] - prev[0] <= 20000) { const k = (t - prev[0]) / ((next[0] - prev[0]) || 1); return { lat: prev[1] + (next[1] - prev[1]) * k, lng: prev[2] + (next[2] - prev[2]) * k }; }
    const near = [prev, next].filter(Boolean).filter(q => Math.abs(q[0] - t) <= 7500).sort((a, b) => Math.abs(a[0] - t) - Math.abs(b[0] - t))[0];
    return near ? P(near) : null;
  }
  // every (uncaught hider sample, hunter) distance
  function pairs(R) {
    const out = [];
    for (const [hid, tr] of Object.entries(R.trails || {})) for (const q of tr) {
      if (q[3] !== 's') continue;
      for (const [uid, ut] of Object.entries(R.trails || {})) { if (uid === hid) continue; const u = posAt(ut, q[0], 'h'); if (u) out.push({ t: q[0], hider: hid, hunter: uid, d: distM(P(q), u), lat: q[1], lng: q[2] }); }
    }
    return out;
  }
  const catches = R => (R.log || []).filter(e => e.k === 'catch');
  const caughtAt = (R, id) => { const c = catches(R).find(e => e.id === id); return c ? c.t : Infinity; };
  const nameOf = (R, id) => (R.players.find(p => p.id === id) || {}).name || '?';
  // Close calls: a hunter within `within` m of an uncaught hider who was NOT caught in the next `graceMs`.
  function closeCalls(R, within = 20, graceMs = 60000) {
    const eps = [];
    for (const x of pairs(R).filter(x => x.d <= within).sort((a, b) => a.t - b.t)) {
      const e = eps.find(e => e.hider === x.hider && e.hunter === x.hunter && x.t - e.last <= 30000);
      if (e) { e.last = x.t; if (x.d < e.d) Object.assign(e, { d: x.d, t: x.t, lat: x.lat, lng: x.lng }); } else eps.push({ ...x, last: x.t });
    }
    const t0 = R.startedAt || 0;
    return eps.filter(e => caughtAt(R, e.hider) > e.t + graceMs).map(e => ({ t: e.t, hider: e.hider, hunter: e.hunter, d: Math.round(e.d), lat: e.lat, lng: e.lng,
      text: `${nameOf(R, e.hunter)} walked right past ${nameOf(R, e.hider)}, ${Math.round(e.d)} m, at ${clock(e.t - t0)}` }));
  }
  function distanceWalked(tr) { let s = 0; for (let i = 1; i < (tr || []).length; i++) { const dt = (tr[i][0] - tr[i - 1][0]) / 1000, d = distM(P(tr[i - 1]), P(tr[i])); if (dt > 0 && d / dt <= 10) s += d; } return s; }
  function oobTime(R) {
    const out = {}, open = {};
    for (const e of (R.log || []).filter(e => e.k === 'oob')) { if (e.on) open[e.id] = open[e.id] ?? e.t; else if (open[e.id] != null) { out[e.id] = (out[e.id] || 0) + e.t - open[e.id]; delete open[e.id]; } }
    for (const [id, t] of Object.entries(open)) out[id] = (out[id] || 0) + (R.endedAt || t) - t;
    return out;
  }
  const count = (R, k) => { const c = {}; for (const e of R.log || []) if (e.k === k && e.id) c[e.id] = (c[e.id] || 0) + 1; return c; };
  const top = obj => { let b = null; for (const [id, v] of Object.entries(obj)) if (v > 0 && (!b || v > b[1])) b = [id, v]; return b; };
  function stats(R) {
    const huntStart = R.hideEndsAt || R.startedAt, end = R.endedAt;
    const hiders = R.players.filter(p => p.startRole === 'hider');
    const survival = Object.fromEntries(hiders.map(p => [p.id, Math.max(0, Math.min(end, caughtAt(R, p.id)) - huntStart)]));
    const all = pairs(R);
    const safe = all.filter(x => x.t < caughtAt(R, x.hider) - 15000); // ignore the moment of the actual catch
    const closest = (safe.length ? safe : all).reduce((b, x) => !b || x.d < b.d ? x : b, null);
    const dist = Object.fromEntries(Object.entries(R.trails || {}).map(([id, tr]) => [id, distanceWalked(tr)]));
    const cs = catches(R), byCount = {}; for (const c of cs) if (c.by) byCount[c.by] = (byCount[c.by] || 0) + 1;
    const fastest = cs.filter(c => c.by).reduce((b, c) => !b || c.t < b.t ? c : b, null);
    return { huntStart, survival, closest, dist, decoys: count(R, 'decoy'), bounties: count(R, 'bounty'), catchCount: byCount, fastest, oob: oobTime(R), first: cs[0] || null, pairs: all };
  }
  function computeAwards(R) {
    const s = stats(R), A = [], n = id => nameOf(R, id), mmss = ms => clock(ms);
    const surv = top(Object.fromEntries(Object.entries(s.survival).map(([k, v]) => [k, v + 1])));
    if (surv) { const p = R.players.find(x => x.id === surv[0]); A.push({ key: 'survivor', icon: '🏆', title: 'Longest survivor', id: surv[0], value: surv[1] - 1, text: `${n(surv[0])} — ${caughtAt(R, surv[0]) === Infinity ? 'never caught' : 'lasted ' + mmss(surv[1] - 1)}` }); }
    if (s.closest) A.push({ key: 'closest', icon: '😱', title: 'Closest call', id: s.closest.hider, by: s.closest.hunter, value: Math.round(s.closest.d), text: `${n(s.closest.hider)} — ${n(s.closest.hunter)} was ${Math.round(s.closest.d)} m away` });
    const d = top(s.dist); if (d) A.push({ key: 'distance', icon: '👟', title: 'Most distance walked', id: d[0], value: Math.round(d[1]), text: `${n(d[0])} — ${d[1] >= 1000 ? (d[1] / 1000).toFixed(2) + ' km' : Math.round(d[1]) + ' m'}` });
    const dc = top(s.decoys); if (dc) A.push({ key: 'decoy', icon: '👻', title: 'Decoy master', id: dc[0], value: dc[1], text: `${n(dc[0])} — ${dc[1]} decoy${dc[1] > 1 ? 's' : ''}` });
    const b = top(s.bounties); if (b) A.push({ key: 'bounty', icon: '💰', title: 'Bounty hunter', id: b[0], value: b[1], text: `${n(b[0])} — ${b[1]} bount${b[1] > 1 ? 'ies' : 'y'}` });
    if (s.fastest) A.push({ key: 'fastest', icon: '⚡', title: 'Fastest catch', id: s.fastest.by, value: Math.max(0, s.fastest.t - s.huntStart), text: `${n(s.fastest.by)} caught ${n(s.fastest.id)} at ${mmss(s.fastest.t - s.huntStart)}` });
    const o = top(s.oob); if (o) A.push({ key: 'oob', icon: '🚧', title: 'Most out of bounds', id: o[0], value: o[1], text: `${n(o[0])} — ${mmss(o[1])} outside` });
    return A;
  }
  const TROPHIES = { ghost: ['👻', 'Ghost', 'Never within 50 m of a hunter'], bloodhound: ['🐕', 'Bloodhound', '3+ catches'], closeShave: ['🪒', 'Close Shave', 'Closest call of the game'],
    decoyMaster: ['🎭', 'Decoy Master', 'Most decoys used'], bountyHunter: ['💰', 'Bounty Hunter', 'Most bounties claimed'], marathoner: ['🏃', 'Marathoner', 'Most distance walked'],
    escapeArtist: ['🪄', 'Escape Artist', 'Survived a close call'], firstBlood: ['🩸', 'First Blood', 'First catch'], zombie: ['🧟', 'Zombie', 'Infected hider who caught someone'], ruleBender: ['🚧', 'Rule Bender', 'Most time out of bounds'] };
  function computeTrophies(R, cc) {
    const s = stats(R), out = [], add = (key, id) => { if (id && !out.some(x => x.key === key && x.id === id)) { const [icon, title, desc] = TROPHIES[key]; out.push({ key, id, name: nameOf(R, id), icon, title, desc }); } };
    for (const p of R.players.filter(p => p.startRole === 'hider')) {
      const mine = s.pairs.filter(x => x.hider === p.id);
      if (caughtAt(R, p.id) === Infinity && (R.trails[p.id] || []).some(q => q[3] === 's') && !mine.some(x => x.d < 50)) add('ghost', p.id);
    }
    for (const [id, c] of Object.entries(s.catchCount)) if (c >= 3) add('bloodhound', id);
    if (s.closest) add('closeShave', s.closest.hider);
    const dc = top(s.decoys); if (dc) add('decoyMaster', dc[0]);
    const b = top(s.bounties); if (b) add('bountyHunter', b[0]);
    const d = top(s.dist); if (d) add('marathoner', d[0]);
    for (const c of cc || closeCalls(R)) add('escapeArtist', c.hider);
    if (s.first && s.first.by) add('firstBlood', s.first.by);
    for (const c of catches(R)) { const p = R.players.find(x => x.id === c.by); if (p && p.startRole === 'hider' && caughtAt(R, p.id) < c.t) add('zombie', p.id); }
    const o = top(s.oob); if (o) add('ruleBender', o[0]);
    return out;
  }
  // Instagram handle: strip @ / parse instagram.com URLs; letters, digits, . and _, max 30. Returns '' if invalid.
  function igHandle(v) {
    let s = String(v == null ? '' : v).trim();
    const m = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/([^/?#\s]+)/i); if (m) s = m[1];
    s = s.replace(/^@/, '');
    return /^[A-Za-z0-9._]{1,30}$/.test(s) && !/^\.|\.$|\.\./.test(s) && !/^(p|reel|reels|stories|explore|accounts)$/i.test(s) ? s.toLowerCase() : '';
  }
  return { igHandle, distM, posAt, closeCalls, computeAwards, computeTrophies, distanceWalked, oobTime, stats, clock, TROPHIES };
});
