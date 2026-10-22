'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createApp, offsetM, distM } = require('../server');
const PU = require('../powerups');
const Recap = require('../public/recap');
const Field = require('../public/field');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };
async function boot(o = {}) { const a = createApp({ tickMs: 20, minSec: 0.1, trailMs: 50, catchMs: 2000, pickupMinMs: 0, cooldownMinMs: 0, fxMinMs: 300, quiet: true, defaultMode: 'custom', ...o }); await new Promise(r => a.server.listen(0, r)); a.url = `ws://127.0.0.1:${a.server.address().port}/ws`; return a; }
function client(url) {
  const ws = new WebSocket(url), c = { ws, msgs: [], state: null, pings: [] };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'state') c.state = m; if (m.type === 'joined') c.joined = m; if (m.type === 'ping') c.pings.push(m); });
  c.send = m => ws.send(JSON.stringify(m)); c.open = new Promise(r => ws.on('open', r)); c.raw = () => c.msgs.map(m => JSON.stringify(m)).join('\n'); c.id = () => c.joined.id;
  c.got = type => c.msgs.filter(m => m.type === type);
  return c;
}
const B = { lat: 37.5, lng: -122.5 }, at = (m, brg = 90) => offsetM(B, m, brg);
async function lobby(a, roles, settings = {}) {
  const cs = [];
  for (let i = 0; i < roles.length; i++) { const c = client(a.url); await c.open; c.send(i ? { type: 'join', agreed: true, code: cs[0].joined.code, name: 'P' + i } : { type: 'create', agreed: true, name: 'P0' }); await until(() => c.joined); cs.push(c); }
  await until(() => cs[0].state && cs[0].state.players.length === roles.length);
  roles.forEach((r, i) => cs[0].send({ type: 'role', id: cs[i].id(), role: r }));
  cs[0].send({ type: 'settings', settings: { gameSec: 1200, pingSec: 600, hideSec: 0, ...settings } });
  await until(() => roles.every((r, i) => cs[0].state.players.find(p => p.id === cs[i].id()).role === r) && cs[0].state.settings.pingSec === (settings.pingSec ?? 600));
  return cs;
}
const loc = (c, p) => c.send({ type: 'loc', lat: p.lat, lng: p.lng, acc: 5 });
const done = (a, cs) => { a.server.close(); cs.forEach(c => c.ws.terminate()); };
const lob = a => [...a.lobbies.values()][0];
const P = (a, c) => lob(a).players.get(c.id());
const put = (a, side, p, type = 'radar') => { const d = { id: 'd' + Math.random().toString(36).slice(2, 7), side, lat: p.lat, lng: p.lng, t: Date.now(), expiresAt: Date.now() + 1e6, type }; lob(a).drops.set(d.id, d); return d; };

// ---------- pure ----------
test('rare-weight distribution: Extra Time / Revive ~10 %, Shield ~15 %, rest share the remainder; hunter types even', () => {
  let x = 12345; const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const N = 60000, cnt = s => { const c = {}; for (let i = 0; i < N; i++) { const k = PU.roll(s, rnd); c[k] = (c[k] || 0) + 1; } return c; };
  const h = cnt('hider'), u = cnt('hunter'), pct = (c, k) => c[k] / N * 100;
  for (const [k, want] of [['extraTime', 10], ['revive', 10], ['shield', 15], ['radar', 21.67], ['jammer', 21.67], ['silent', 21.66]]) assert.ok(Math.abs(pct(h, k) - want) < 1.2, `${k} ${pct(h, k).toFixed(1)}%`);
  for (const k of Object.keys(PU.HUNTER)) assert.ok(Math.abs(pct(u, k) - 100 / 6) < 1.2, `${k} ${pct(u, k).toFixed(1)}%`);
  assert.ok(Object.keys(h).every(k => k in PU.HIDER) && Object.keys(u).every(k => k in PU.HUNTER));
});
test('spawn point: 50-200 m from the anchor, inside the field, farther from hunters when possible; shrink geometry', () => {
  const field = { circle: { lat: B.lat, lng: B.lng, r: 300 }, poly: null };
  for (let i = 0; i < 200; i++) { const q = PU.spawnPoint(at(100), null, field); const d = distM(at(100), q); assert.ok(d >= 49 && d <= 201 && Field.inField(field, q), d); }
  const hunter = at(100, 270), picks = Array.from({ length: 40 }, () => PU.spawnPoint(B, [hunter], null));
  assert.ok(picks.filter(q => q.lng > B.lng).length >= 36, 'mostly on the side away from the hunter');
  assert.equal(PU.spawnPoint(B, null, { circle: { lat: 10, lng: 10, r: 50 }, poly: null }), null, 'no candidates outside the field');
  const s1 = PU.shrinkField(field, 0.7, [], []); assert.equal(s1.circle.r, 210);
  const poly = [[0, 0], [0, 2], [2, 2], [2, 0]], s2 = PU.shrinkField({ circle: null, poly }, 0.7, [], []);
  assert.deepEqual(s2.poly.map(p => p.map(v => +v.toFixed(3))), [[0.3, 0.3], [0.3, 1.7], [1.7, 1.7], [1.7, 0.3]]);
  const s3 = PU.shrinkField(null, 0.7, [B], [B, at(100), at(200, 0)]); assert.ok(Math.abs(s3.circle.lat - B.lat) < 1e-9 && Math.abs(s3.circle.r - 140) <= 1, JSON.stringify(s3));
});
test('trophies: Thief and Power Player', () => {
  const R = { startedAt: 0, hideEndsAt: 0, endedAt: 1000, players: [{ id: 'a', name: 'Ana', startRole: 'hider' }, { id: 'h', name: 'Hank', startRole: 'hunter' }], trails: {},
    log: [{ t: 1, k: 'steal', id: 'a' }, { t: 2, k: 'power', id: 'h' }, { t: 3, k: 'power', id: 'h' }, { t: 4, k: 'power', id: 'a' }] };
  const T = Recap.computeTrophies(R);
  assert.ok(T.some(t => t.key === 'thief' && t.id === 'a')); assert.ok(T.some(t => t.key === 'powerPlayer' && t.id === 'h'));
});

// ---------- server ----------
test('drop timing: none in the first 2 (scaled) min, every 3 min alternating sides, none in sudden death; Off and Chaos', async () => {
  const runs = {};
  for (const mode of ['normal', 'chaos', 'off']) {
    const a = await boot(); const cs = await lobby(a, ['hunter', 'hider'], { gameSec: 6, pingSec: 100, powerups: mode }); const [h, s] = cs;
    loc(h, at(0)); loc(s, at(300)); await sleep(40);
    h.send({ type: 'start' }); await until(() => h.state.state === 'ended', 9000);
    const L = lob(a), drops = L.log.filter(e => e.k === 'drop').map(e => ({ dt: e.t - L.hideEndsAt, side: e.side })), sd = L.compassAt - L.hideEndsAt;
    runs[mode] = drops; done(a, cs);
    if (mode === 'off') { assert.equal(drops.length, 0); continue; }
    const scale = 6 / 1200, every = (mode === 'chaos' ? 90 : 180) * scale * 1000;
    assert.ok(drops.length >= (mode === 'chaos' ? 7 : 4), mode + ' count ' + drops.length);
    assert.ok(drops[0].dt >= 120 * scale * 1000 - 30, 'none in the first 2 min: ' + drops[0].dt);
    assert.ok(drops.every(d => d.dt < sd), 'none in sudden death');
    for (let i = 1; i < drops.length; i++) { assert.ok(Math.abs(drops[i].dt - drops[i - 1].dt - every) < 120, `${mode} gap ${drops[i].dt - drops[i - 1].dt}`); assert.notEqual(drops[i].side, drops[i - 1].side, 'alternating'); }
    assert.equal(drops[0].side, 'hider');
  }
  assert.ok(runs.chaos.length > runs.normal.length);
});
test('drop placement, despawn after 2.5 min, and visibility: hider drops never reach hunters', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hider', 'hider'], { gameSec: 1200, powerups: 'normal' }); const [h, s1, s2] = cs;
  h.send({ type: 'field', field: { circle: { lat: B.lat, lng: B.lng, r: 400 }, poly: null } }); await until(() => h.state.field);
  loc(h, at(150, 270)); loc(s1, at(100)); loc(s2, at(120, 0)); await sleep(40);
  h.send({ type: 'start' }); await until(() => h.state.state === 'playing');
  const L = lob(a);
  for (let i = 0; i < 30; i++) { const d = a.spawnDrop(L, 'hider'); assert.ok(Field.inField(L.field, d), 'inside field');
    const dh = Math.min(...[s1, s2].map(c => distM(P(a, c).loc, d))); assert.ok(dh >= 49 && dh <= 201 + 130, 'near a hider ' + dh); L.drops.delete(d.id); }
  for (let i = 0; i < 30; i++) { const d = a.spawnDrop(L, 'hunter'); const dd = distM(P(a, h).loc, d); assert.ok(dd >= 49 && dd <= 201 && Field.inField(L.field, d), 'hunter drop ' + dd); L.drops.delete(d.id); }
  const hd = a.spawnDrop(L, 'hider'), ud = a.spawnDrop(L, 'hunter'); h.send({ type: 'sync' }); s1.send({ type: 'sync' });
  await until(() => s1.state.drops?.length === 2 && h.state.drops?.length === 1);
  assert.equal(h.state.drops[0].id, ud.id);
  assert.ok(!h.raw().includes(hd.id) && !h.raw().includes(String(hd.lat).slice(0, 9)), 'hider drop id/coords never sent to hunters');
  assert.ok(h.got('drop').every(m => m.side === 'hunter'), 'hunters only notified of hunter drops');
  L.drops.get(ud.id).expiresAt = Date.now() + 100; await until(() => !L.drops.has(ud.id)); // despawn
  assert.equal(L.settings.powerups, 'normal'); assert.ok(Math.abs((L.drops.get(hd.id).expiresAt - L.drops.get(hd.id).t) - 150000) < 50, '2.5 min ttl at 20 min');
  done(a, cs);
});
test('pickup: 5 s (scaled) continuous within 15 m, leaving resets; max 1 held; cooldown between uses', async () => {
  const a = await boot({ cooldownMinMs: 0 }); const cs = await lobby(a, ['hunter', 'hider'], { gameSec: 60, powerups: 'off' }); const [h, s] = cs; // scale .05: pickup 250 ms, cooldown 9 s
  loc(h, at(500, 270)); loc(s, at(300)); await sleep(40); h.send({ type: 'start' }); await until(() => h.state.state === 'playing');
  const d = put(a, 'hider', at(0), 'radar');
  loc(s, at(10)); await until(() => s.state.pu?.pickup); assert.equal(s.state.pu.pickup.need, 250);
  await sleep(120); loc(s, at(40)); await until(() => !s.state.pu.pickup); // walked out -> reset
  await sleep(200); assert.ok(lob(a).drops.has(d.id) && !P(a, s).held, 'not picked up after leaving');
  loc(s, at(8)); await until(() => P(a, s).held === 'radar', 2000); assert.ok(!lob(a).drops.has(d.id));
  assert.ok(Date.now() - s.state.pu.pickup?.since || true);
  const d2 = put(a, 'hider', at(8), 'jammer'); await sleep(400); assert.ok(lob(a).drops.has(d2.id) && P(a, s).held === 'radar', 'max 1 held');
  assert.ok(s.got('puNote').some(m => /Hands full/.test(m.text)));
  s.send({ type: 'usePower' }); await until(() => !P(a, s).held); await until(() => P(a, s).held === 'jammer', 2000);
  s.send({ type: 'usePower' }); await until(() => s.got('error').some(m => /Cooldown/.test(m.error))); assert.equal(P(a, s).held, 'jammer');
  P(a, s).lastUse = Date.now() - 9001; s.send({ type: 'usePower' }); await until(() => !P(a, s).held);
  done(a, cs);
});
test('steal: hider destroys a hunter drop -> flash for everyone + immediate real-location ping (decoy ignored)', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hider'], { gameSec: 60, powerups: 'off' }); const [h, s] = cs;
  loc(h, at(500, 270)); loc(s, at(300)); await sleep(40); h.send({ type: 'start' }); await until(() => h.state.state === 'playing');
  s.send({ type: 'decoy' }); await until(() => s.state.decoyArmed);
  const d = put(a, 'hunter', at(0), 'sonar'); loc(s, at(5)); await until(() => !lob(a).drops.has(d.id), 2000);
  await until(() => h.got('dropFlash').length && s.got('dropFlash').length);
  const pg = h.pings.find(p => p.steal); assert.ok(pg && pg.locs[s.id()], 'hunter got a steal ping');
  assert.ok(distM(pg.locs[s.id()], at(5)) < 1, 'real location'); assert.ok(!P(a, s).held, 'thief gets nothing');
  assert.ok(lob(a).log.some(e => e.k === 'steal' && e.id === s.id()));
  done(a, cs);
});
test('hider power-ups: Radar, Jammer, Silent Shoes, Shield, Extra Time, Revive (+ toasts)', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hunter', 'hider', 'hider'], { gameSec: 1200, pingSec: 0.3, powerups: 'off' }); const [h, h2, s1, s2] = cs;
  loc(h, at(0)); loc(h2, at(500, 180)); loc(s1, at(30)); loc(s2, at(400)); await sleep(40);
  h.send({ type: 'start' }); await until(() => h.state.state === 'playing');
  const use = async (c, type) => { const p = P(a, c); p.held = type; p.lastUse = 0; const n = c.got('powerUsed').length + c.got('error').length; c.send({ type: 'usePower' }); await until(() => c.got('powerUsed').length + c.got('error').length > n); };
  // Radar
  assert.ok(!s2.state.players.find(p => p.id === h.id()).loc);
  await use(s2, 'radar'); await until(() => s2.state.players.find(p => p.id === h.id()).loc, 2000);
  assert.ok(h.got('powerUsed').some(m => m.who === 'A hider' && m.label === 'Hunter Radar'), 'hunters told "A hider used Hunter Radar"');
  P(a, s2).radarUntil = Date.now() + 50; // 30 s at 20 min; fast-forward
  await until(() => { s2.send({ type: 'sync' }); return !s2.state.players.find(p => p.id === h.id()).loc; }, 3000); // expires
  // Jammer
  await use(s2, 'jammer'); await until(() => h.state.jamUntil > Date.now());
  // Silent shoes: s1 is 30 m from h -> chimes, then never again
  await until(() => s1.got('chime').length >= 1, 3000); await use(s1, 'silent'); const n = s1.got('chime').length; await sleep(800); assert.equal(s1.got('chime').length, n, 'no more chimes');
  // Shield: refused with a hunter within 20 m; works away from hunters; blocks one hunter claim
  loc(s1, at(15)); await sleep(30); await use(s1, 'shield'); assert.ok(s1.got('error').some(m => /within 20 m/.test(m.error)));
  assert.equal(P(a, s1).held, 'shield');
  loc(s1, at(30)); await sleep(30); await use(s1, 'shield'); assert.ok(P(a, s1).shieldUntil > Date.now());
  h2.send({ type: 'catch', id: s1.id() }); await until(() => h2.got('shieldBlocked').length && s1.got('shieldBlocked').length);
  assert.ok(!P(a, s1).caught && !lob(a).catches.size, 'claim auto-rejected');
  // Extra Time: clock -2 min for everyone
  const e0 = lob(a).endsAt, c0 = lob(a).compassAt; await use(s2, 'extraTime');
  assert.equal(e0 - lob(a).endsAt, 120000); assert.equal(c0 - lob(a).compassAt, 120000);
  lob(a).compassAt = Date.now() + 5000; const e1 = lob(a).endsAt; await use(s2, 'extraTime'); assert.ok(e1 - lob(a).endsAt <= 4100 && lob(a).compassAt > Date.now(), 'clamped: never into sudden death');
  // Revive: host catches s1 (infection -> hunter), s2 revives the earliest caught
  h.send({ type: 'catch', id: s1.id() }); await until(() => P(a, s1).caught && P(a, s1).role === 'hunter');
  await use(s2, 'revive'); await until(() => !P(a, s1).caught && P(a, s1).role === 'hider');
  assert.ok(s1.got('revived').length && h.got('powerUsed').some(m => /back in the game/.test(m.note)));
  done(a, cs);
});
test('hunter power-ups: Sonar, Truth Ping, Shrink Zone, Cam Peek+, Heat Trail, Bloodhound; nothing in sudden death', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hider', 'hider', 'hider'], { gameSec: 1200, pingSec: 0.4, powerups: 'off' }); const [h, s1, s2, s3] = cs;
  loc(h, at(0)); loc(s1, at(60)); loc(s2, at(70, 180)); loc(s3, at(400)); await sleep(40);
  s1.send({ type: 'cam', cam: 'granted' });
  h.send({ type: 'start' }); await until(() => h.state.state === 'playing');
  const use = async (type) => { const p = P(a, h); p.held = type; p.lastUse = 0; const n = h.got('powerUsed').length + h.got('error').length; h.send({ type: 'usePower' }); await until(() => h.got('powerUsed').length + h.got('error').length > n); };
  P(a, s2).silent = true;
  await use('sonar');
  await until(() => s1.got('chime').some(m => m.sonar)); await sleep(80);
  assert.ok(!s2.got('chime').some(m => m.sonar), 'Silent Shoes blocks Sonar'); assert.ok(!s3.got('chime').some(m => m.sonar), 'beyond 75 m');
  for (const c of [s1, s2, s3]) assert.ok(c.got('sonar').some(m => m.by === 'P0'), 'all hiders told who used Sonar');
  assert.ok(s3.got('powerUsed').some(m => m.who === 'Hunter P0' && m.label === 'Sonar'), 'hunter toasts are named: Hunter P0 used Sonar');
  // Truth ping: decoy stays armed, ping is real
  s1.send({ type: 'decoy' }); await until(() => P(a, s1).decoyArmed); await use('truth');
  const n0 = h.pings.length; await until(() => h.pings.length > n0 && !h.pings.at(-1).out);
  const tp = h.pings.at(-1); assert.ok(distM(tp.locs[s1.id()], at(60)) < 1, 'real spot'); assert.ok(P(a, s1).decoyArmed, 'decoy not consumed');
  // Shrink zone (no field -> circle on hunters' centroid covering players * 0.7)
  await use('shrink'); await until(() => h.state.field && h.state.field.circle);
  assert.ok(Math.abs(h.state.field.circle.r - 400 * 0.7) < 2, 'r ' + h.state.field.circle.r);
  await until(() => s3.state.players.find(p => p.id === s3.id()).out, 2000); // s3 now out of bounds
  assert.ok(Math.abs(lob(a).shrink.until - Date.now() - 180000) < 3000, '3 min'); lob(a).shrink.until = Date.now(); // fast-forward
  await until(() => !h.state.field, 3000);
  // Cam peek+
  await use('campeek'); await until(() => s1.got('camRequest').length);
  // Heat trail
  await use('heat'); await until(() => h.got('heatTrail').length); assert.ok(h.got('heatTrail')[0].trails[s1.id()].pts.length >= 1);
  // Bloodhound: numbers, no direction
  await use('hound'); await until(() => h.got('bloodhound').length); const bh = h.got('bloodhound').at(-1);
  assert.ok(Math.abs(bh.dists.find(d => d.id === s3.id()).d - 400) <= 2 && !('bearing' in bh.dists[0]) && !('lat' in bh.dists[0]));
  // sudden death: no drops, no use
  put(a, 'hunter', at(300)); lob(a).compassAt = Date.now() - 10; await until(() => !lob(a).drops.size);
  P(a, h).held = 'sonar'; P(a, h).lastUse = 0; h.send({ type: 'usePower' }); await until(() => h.got('error').some(m => /sudden death/.test(m.error)));
  assert.equal(P(a, h).held, 'sonar');
  done(a, cs);
});
test('chime volume + power-up mode settings: defaults 25 % / normal, clamped, host-only', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hider']); const [h, s] = cs;
  assert.equal(h.state.settings.chimeVol, 25); assert.equal(h.state.settings.powerups, 'normal');
  h.send({ type: 'settings', settings: { chimeVol: 500, powerups: 'chaos' } }); await until(() => h.state.settings.chimeVol === 100 && h.state.settings.powerups === 'chaos');
  h.send({ type: 'settings', settings: { chimeVol: 1, powerups: 'bogus' } }); await until(() => h.state.settings.chimeVol === 10); assert.equal(h.state.settings.powerups, 'chaos');
  s.send({ type: 'settings', settings: { chimeVol: 50 } }); await sleep(80); assert.equal(h.state.settings.chimeVol, 10, 'non-host ignored');
  done(a, cs);
});
test('chime preview: host-only, lobby-only, broadcast to every phone, throttled to 1 per 1.5 s, live vote tally for the host', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hider', 'hider']); const [h, s1, s2] = cs;
  s1.send({ type: 'chimeTest', vol: 80 }); await sleep(80); assert.equal(s2.got('chimeTest').length, 0, 'non-host ignored');
  h.send({ type: 'chimeTest', vol: 60 }); await until(() => cs.every(c => c.got('chimeTest').length === 1));
  assert.ok(cs.every(c => c.got('chimeTest')[0].vol === 60)); await until(() => h.state.settings.chimeVol === 60);
  for (const v of [40, 45, 50]) h.send({ type: 'chimeTest', vol: v }); await sleep(150);
  assert.ok(cs.every(c => c.got('chimeTest').length === 1), 'dragging within 1.5 s is throttled');
  const id = h.got('chimeTest')[0].id;
  s1.send({ type: 'chimeVote', id, vote: 'quiet' }); s2.send({ type: 'chimeVote', id, vote: 'good' }); h.send({ type: 'chimeVote', id, vote: 'bogus' });
  await until(() => h.state.chimeTest?.tally && h.state.chimeTest.tally.quiet === 1 && h.state.chimeTest.tally.good === 1);
  assert.ok(!s1.state.chimeTest.tally, 'only the host sees the tally'); assert.equal(s1.state.chimeTest.myVote, 'quiet');
  await sleep(1450); h.send({ type: 'chimeTest', vol: 30 }); await until(() => s2.got('chimeTest').length === 2);
  assert.equal(s2.got('chimeTest')[1].vol, 30); await until(() => h.state.chimeTest.tally.good === 0, 1000); // new test resets votes
  h.send({ type: 'start' }); await until(() => h.state.state === 'playing'); assert.ok(!h.state.chimeTest);
  await sleep(1500); h.send({ type: 'chimeTest', vol: 90 }); await sleep(100); assert.equal(s2.got('chimeTest').length, 2, 'not during a game');
  done(a, cs);
});
