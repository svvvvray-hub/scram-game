'use strict';
// Regression tests for the fixes from docs/bug_audit.md
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createApp } = require('../server');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };
async function boot(o = {}) {
  const a = createApp({ tickMs: 20, minSec: 0.1, defaultMode: 'custom', quiet: true, statsFile: null, ...o });
  await new Promise(r => a.server.listen(0, r));
  a.base = `http://127.0.0.1:${a.server.address().port}`; a.url = a.base.replace('http', 'ws') + '/ws';
  return a;
}
function client(url, headers) {
  const ws = new WebSocket(url, headers ? { headers } : undefined), c = { ws, msgs: [], state: null };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'state') c.state = m; if (m.type === 'joined') c.joined = m; if (m.type === 'error') c.error = m; });
  ws.on('close', code => { c.closed = code; });
  c.send = m => ws.send(typeof m === 'string' ? m : JSON.stringify(m)); c.open = new Promise(r => ws.on('open', r));
  return c;
}
async function lobby(a, n = 2) {
  const host = client(a.url); await host.open; host.send({ type: 'create', agreed: true, name: 'Host' }); await until(() => host.joined);
  const ps = [];
  for (let i = 0; i < n - 1; i++) { const p = client(a.url); await p.open; p.send({ type: 'join', agreed: true, code: host.joined.code, name: 'P' + i }); await until(() => p.joined); ps.push(p); }
  await until(() => host.state && host.state.players.length === n);
  return { host, ps, code: host.joined.code };
}
const done = (a, cs) => { a.server.close(); cs.forEach(c => c.ws.terminate()); };

const Walk = require('../walk');
const Field = require('../public/field');
const last = (c, t) => [...c.msgs].reverse().find(m => m.type === t);
const at = (c, dm, acc = 4) => c.send({ type: 'loc', lat: 52 + dm / 111320, lng: 4, acc });
const T = { tagWindowMs: 2000, tagMinSamples: 3, tagZoneMs: 0, tagMs: 1000, tagLiveMs: 400, tagGapMs: 1200, tagGraceMs: 300, tagHiderMs: 400, tagClaimMs: 3000 };
async function tagGame(o = {}) {
  const a = await boot({ ...T, ...o }); const { host, ps } = await lobby(a, 3);
  host.send({ type: 'settings', settings: { hideSec: 0, gameSec: 1200, autoTag: 5 } });
  host.send({ type: 'role', id: ps[0].joined.id, role: 'hunter' }); host.send({ type: 'start' });
  await until(() => host.state.state === 'playing');
  return { a, host, hunter: ps[0], hider: ps[1], L: [...a.lobbies.values()][0] };
}
const caught = (c, id) => c.state.players.find(p => p.id === id).caught;
async function close(n, hunter, hider, ms, step = 100) { for (let i = 0; i < ms / step; i++) { at(hunter, 0); if (hider) at(hider, 1); await sleep(step); } }

test('v19 autotag: a GPS gap pauses the ring (no reset), progress resumes; boost on while tagging', async () => {
  const { a, host, hunter, hider, L } = await tagGame({ tagMs: 3000 });
  at(host, 900); await close(0, hunter, hider, 900);
  const G = () => L.tags.get(hunter.joined.id + '>' + hider.joined.id); const a0 = G().acc; assert.ok(a0 > 300, 'progress ' + a0);
  assert.ok(last(hunter, 'gpsBoost')?.on && last(hider, 'gpsBoost')?.on, 'both phones boosted');
  await close(0, hunter, null, 900); // hider silent 0.9 s (> live, < gap)
  assert.ok(G().acc >= a0, 'not reset');
  assert.ok(hunter.msgs.some(m => m.type === 'tagProg' && m.paused && m.p > 0), 'hunter told: paused');
  await close(0, hunter, hider, 2600); await until(() => caught(host, hider.joined.id));
  await until(() => last(hunter, 'gpsBoost')?.on === false || last(hider, 'gpsBoost')?.on === false);
  done(a, [host, hunter, hider]);
});

test('v19 autotag: confirmed out-of-range resets after grace; walk-by never tags', async () => {
  const { a, host, hunter, hider, L } = await tagGame();
  at(host, 900); await close(0, hunter, hider, 300);
  for (let i = 0; i < 10; i++) { at(hunter, 0); at(hider, 60); await sleep(100); }
  assert.ok([...L.tags.values()].every(g => g.acc === 0)); assert.ok(!caught(host, hider.joined.id));
  done(a, [host, hunter, hider]);
});

test('v19 fallback: hider GPS stale at >=30% -> hunter "Tap to confirm" -> hider accepts -> caught (no position to hunter)', async () => {
  const { a, host, hunter, hider } = await tagGame();
  at(host, 900); await close(0, hunter, hider, 500);
  await close(0, hunter, null, 1700); await until(() => last(hunter, 'tagFallback'));
  const fb = last(hunter, 'tagFallback'); assert.deepEqual(Object.keys(fb).sort(), ['expiresAt', 'key', 'type']);
  hider.send({ type: 'tagClaim', key: fb.key }); // only the hunter may claim
  hunter.send({ type: 'tagClaim', key: fb.key }); await until(() => last(hider, 'tagAsk'));
  assert.equal(last(hider, 'tagAsk').by, 'P0');
  hider.send({ type: 'tagAnswer', key: fb.key, yes: true }); await until(() => caught(host, hider.joined.id));
  assert.ok(!JSON.stringify(hunter.msgs.filter(m => m.type !== 'state')).includes('"lat":52.00000'), 'hunter never got the hider position');
  done(a, [host, hunter, hider]);
});

test('v19 fallback: hider denies -> not caught; no answer in time -> host decides', async () => {
  let { a, host, hunter, hider } = await tagGame();
  at(host, 900); await close(0, hunter, hider, 500); await close(0, hunter, null, 1700); await until(() => last(hunter, 'tagFallback'));
  hunter.send({ type: 'tagClaim', key: last(hunter, 'tagFallback').key }); await until(() => last(hider, 'tagAsk'));
  hider.send({ type: 'tagAnswer', key: last(hider, 'tagAsk').key, yes: false }); await until(() => last(hunter, 'tagFbEnd'));
  assert.equal(last(hunter, 'tagFbEnd').ok, false); assert.ok(!caught(host, hider.joined.id));
  done(a, [host, hunter, hider]);
  ({ a, host, hunter, hider } = await tagGame());
  at(host, 900); await close(0, hunter, hider, 500); await close(0, hunter, null, 1700); await until(() => last(hunter, 'tagFallback'));
  hunter.send({ type: 'tagClaim', key: last(hunter, 'tagFallback').key }); await until(() => last(host, 'tagHost'), 3000);
  const th = last(host, 'tagHost'); assert.equal(th.hider, 'P1');
  hunter.send({ type: 'tagHostAnswer', key: th.key, yes: true }); await sleep(100); assert.ok(!caught(host, hider.joined.id), 'only the host');
  host.send({ type: 'tagHostAnswer', key: th.key, yes: true }); await until(() => caught(host, hider.joined.id));
  done(a, [host, hunter, hider]);
});

test('v19 fallback: a gap below 30% just resets (no confirm button)', async () => {
  const { a, host, hunter, hider, L } = await tagGame({ tagMs: 5000 });
  at(host, 900); await close(0, hunter, hider, 300); await close(0, hunter, null, 1700);
  assert.ok([...L.tags.values()].every(g => g.acc === 0)); assert.ok(!last(hunter, 'tagFallback'));
  done(a, [host, hunter, hider]);
});

// ---- walkable drops (mocked Overpass)
const C = { lat: 37.7596, lng: -122.4269 };
const off = (dn, de) => ({ lat: C.lat + dn / 111320, lon: C.lng + de / (111320 * Math.cos(C.lat * Math.PI / 180)) });
const FIX = { elements: [
  { type: 'way', id: 1, tags: { highway: 'residential', name: 'A St' }, geometry: [off(-150, -300), off(-150, 300)] },
  { type: 'way', id: 2, tags: { highway: 'footway' }, geometry: [off(-300, 80), off(300, 80)] },
  { type: 'way', id: 3, tags: { highway: 'motorway' }, geometry: [off(120, -300), off(120, 300)] },
  { type: 'way', id: 4, tags: { highway: 'trunk' }, geometry: [off(-60, -300), off(-60, 300)] },
  { type: 'way', id: 5, tags: { highway: 'service', access: 'private' }, geometry: [off(200, -300), off(200, 300)] },
  { type: 'way', id: 6, tags: { building: 'yes' }, geometry: [off(-160, 0), off(-160, 40), off(-140, 40), off(-140, 0), off(-160, 0)] },
] };
test('walk: parse keeps walkable ways only (no motorway / trunk / private); samples stay on ways, in the field, off buildings', () => {
  const w = Walk.parse(FIX); assert.equal(w.segs.length, 2); assert.equal(w.buildings.length, 1);
  assert.ok(!Walk.query([1, 2, 3, 4]).includes('motorway') && !Walk.query([1, 2, 3, 4]).includes('trunk'));
  const field = { circle: { lat: C.lat, lng: C.lng, r: 250 }, poly: null };
  let n = 0; for (let i = 0; i < 200; i++) { const q = Walk.spawnOnWalk(w, null, null, field); if (!q) continue; n++;
    assert.ok(Walk.onWalk(w, q, 0.5)); assert.ok(Field.inField(field, q)); assert.ok(!Walk.nearBuilding(w.buildings, q)); }
  assert.ok(n > 150);
  const q = Walk.spawnOnWalk(w, C, null, field); const d = Field.distM(C, q); assert.ok(d >= 50 && d <= 200);
  assert.equal(Walk.spawnOnWalk({ segs: [], buildings: [] }, C, null, field), null);
  assert.equal(Walk.bboxOf(null, []), null); assert.equal(Walk.bboxOf({ circle: { lat: 0, lng: 0, r: 9000 } }), null, 'huge areas skipped');
});
test('walk: server fetches Overpass once per game (bbox of the field) and drops land on ways; Overpass failure -> random fallback', async () => {
  let calls = 0, body = '';
  const fetch = async (url, o) => { calls++; body = decodeURIComponent(o.body); return { ok: true, json: async () => FIX }; };
  const a = await boot({ overpass: { fetch, url: 'http://mock' } }); const { host, ps } = await lobby(a, 3);
  host.send({ type: 'field', field: { circle: { lat: C.lat, lng: C.lng, r: 250 }, poly: null } });
  host.send({ type: 'settings', settings: { hideSec: 0, powerups: 'normal' } });
  host.send({ type: 'loc', lat: C.lat, lng: C.lng, acc: 5 }); ps.forEach(p => p.send({ type: 'loc', lat: C.lat + 0.0003, lng: C.lng, acc: 5 }));
  host.send({ type: 'role', id: host.joined.id, role: 'hunter' }); await sleep(100); host.send({ type: 'start', force: true });
  await until(() => host.state.state === 'playing'); const L = [...a.lobbies.values()][0]; await until(() => L.walk?.status === 'ok');
  assert.equal(calls, 1); assert.ok(/\(37\.75\d+,-122\.4[23]\d+,37\.76\d+,-122\.42\d+\)/.test(body), body.slice(0, 120));
  const w = Walk.parse(FIX); for (let i = 0; i < 20; i++) { const d = a.spawnDrop(L, i % 2 ? 'hider' : 'hunter'); assert.ok(Walk.onWalk(w, d, 0.5), 'drop on a way'); assert.ok(d.onWay); }
  done(a, [host, ...ps]);
  const b = await boot({ overpass: { fetch: async () => { throw new Error('down'); }, url: 'http://mock' } }); const B = await lobby(b, 2);
  B.host.send({ type: 'field', field: { circle: { lat: C.lat, lng: C.lng, r: 250 }, poly: null } }); B.host.send({ type: 'settings', settings: { hideSec: 0 } });
  B.host.send({ type: 'loc', lat: C.lat, lng: C.lng, acc: 5 }); B.ps[0].send({ type: 'loc', lat: C.lat, lng: C.lng, acc: 5 }); await sleep(100);
  B.host.send({ type: 'start', force: true }); await until(() => B.host.state.state === 'playing'); const L2 = [...b.lobbies.values()][0];
  await until(() => L2.walk?.status === 'fail'); const d = b.spawnDrop(L2, 'hunter'); assert.ok(d && !d.onWay && Field.inField(L2.field, d));
  done(b, [B.host, ...B.ps]);
});

test('v19 drops: hunters see hider-drop locations (locked, no type) but can never pick them up; hider positions still never sent', async () => {
  const a = await boot(); const { host, ps } = await lobby(a, 2); const hider = ps[0];
  host.send({ type: 'settings', settings: { hideSec: 0, powerups: 'normal' } }); host.send({ type: 'role', id: host.joined.id, role: 'hunter' });
  host.send({ type: 'loc', lat: 52, lng: 4, acc: 5 }); hider.send({ type: 'loc', lat: 52.0021, lng: 4.0013, acc: 5 }); await sleep(50);
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing'); const L = [...a.lobbies.values()][0];
  const d = a.spawnDrop(L, 'hider'); d.lat = 52; d.lng = 4; host.send({ type: 'sync' });
  await until(() => (host.state.drops || []).some(x => x.id === d.id));
  const hv = host.state.drops.find(x => x.id === d.id); assert.ok(hv.locked && !hv.ptype);
  for (let i = 0; i < 10; i++) { host.send({ type: 'loc', lat: 52, lng: 4, acc: 5 }); await sleep(60); }
  assert.ok(L.drops.has(d.id) && !L.players.get(host.joined.id).pickup && !L.players.get(host.joined.id).held, 'hunter cannot pick it up');
  assert.ok(!host.msgs.some(m => JSON.stringify(m).includes('52.0021')), 'hider position never sent to the hunter');
  done(a, [host, ...ps]);
});

test('v19 tag debug overlay: host-only (dist / accuracies / close%), never to other players', async () => {
  const a = await boot({ ...T }); const { host, ps } = await lobby(a, 3); const [hider, other] = ps;
  host.send({ type: 'settings', settings: { hideSec: 0, autoTag: 5, tagDebug: true } }); host.send({ type: 'role', id: host.joined.id, role: 'hunter' });
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing'); at(other, 900);
  for (let i = 0; i < 8; i++) { at(host, 0); at(hider, 1); await sleep(100); }
  await until(() => host.msgs.some(m => m.type === 'tagProg' && m.dbg));
  const d = host.msgs.find(m => m.type === 'tagProg' && m.dbg).dbg; assert.ok('d' in d && 'accA' in d && 'accB' in d && 'pct' in d && 'lim' in d);
  assert.ok(!hider.msgs.some(m => m.dbg) && !other.msgs.some(m => m.dbg));
  hider.send({ type: 'tagDebug', on: false }); await sleep(50); assert.equal([...a.lobbies.values()][0].settings.tagDebug, true, 'host only');
  done(a, [host, ...ps]);
});

test('v20 approach: one Saver-rate fix each within ~40 m (accuracy-inflated) -> fast GPS on both phones before any ring progress; far players stay normal', async () => {
  const { a, host, hunter, hider, L } = await tagGame();
  at(host, 900); at(hider, 0, 20); at(hunter, 50, 5); // single stale-ish fixes, 50 m apart, hider ±20 m: 50-25 <= 40
  await until(() => last(hunter, 'gpsBoost')?.on && last(hider, 'gpsBoost')?.on);
  assert.ok(!hunter.msgs.some(m => m.type === 'tagProg' && m.p > 0), 'no ring progress yet');
  assert.ok(!last(host, 'gpsBoost')?.on, 'the far player is not boosted');
  assert.ok(!hunter.msgs.some(m => m.type === 'gpsBoost' && (m.lat || m.d || m.id)), 'boost carries no position / distance / id');
  done(a, [host, hunter, hider]);
});
test('v20 approach: 200 m apart -> no fast GPS', async () => {
  const { a, host, hunter, hider } = await tagGame();
  at(host, 900); at(hider, 0, 10); at(hunter, 200, 5); await sleep(600);
  assert.ok(!last(hunter, 'gpsBoost')?.on && !last(hider, 'gpsBoost')?.on);
  done(a, [host, hunter, hider]);
});
