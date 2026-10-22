'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createApp, offsetM } = require('../server');
const Recap = require('../public/recap');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };
async function boot(o = {}) { const a = createApp({ tickMs: 20, minSec: 0.1, trailMs: 50, catchMs: 400, ...o }); await new Promise(r => a.server.listen(0, r)); a.url = `ws://127.0.0.1:${a.server.address().port}/ws`; return a; }
function client(url) {
  const ws = new WebSocket(url), c = { ws, msgs: [], state: null, pings: [] };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'state') c.state = m; if (m.type === 'joined') c.joined = m; if (m.type === 'ping') c.pings.push(m); if (m.type === 'recap') c.recap = m.recap; });
  c.send = m => ws.send(JSON.stringify(m)); c.open = new Promise(r => ws.on('open', r)); c.raw = () => c.msgs.map(m => JSON.stringify(m)).join('\n'); c.id = () => c.joined.id;
  return c;
}
const B = { lat: 37.5, lng: -122.5 };
const at = (m, brg = 90) => offsetM(B, m, brg);
// n players; roles[i] in 'hunter'|'hider'; host = player 0
async function lobby(a, roles, settings = {}) {
  const cs = [];
  for (let i = 0; i < roles.length; i++) { const c = client(a.url); await c.open; c.send(i ? { type: 'join', agreed: true, code: cs[0].joined.code, name: 'P' + i } : { type: 'create', agreed: true, name: 'P0' }); await until(() => c.joined); cs.push(c); }
  await until(() => cs[0].state && cs[0].state.players.length === roles.length);
  roles.forEach((r, i) => cs[0].send({ type: 'role', id: cs[i].id(), role: r }));
  cs[0].send({ type: 'settings', settings: { gameSec: 30, pingSec: 0.2, hideSec: 0, ...settings } });
  await until(() => roles.every((r, i) => cs[0].state.players.find(p => p.id === cs[i].id()).role === r) && cs[0].state.settings.pingSec === (settings.pingSec ?? 0.2));
  return cs;
}
const loc = (c, p) => c.send({ type: 'loc', lat: p.lat, lng: p.lng, acc: 5 });
const done = (a, cs) => { a.server.close(); cs.forEach(c => c.ws.terminate()); };

// ---------- pure math ----------
function fakeRecap() {
  const t0 = 1e6, s = 1000, H = 'h1', A = 'a', Bb = 'b', p = (t, m, r, brg = 90) => { const q = at(m, brg); return [t0 + t * s, q.lat, q.lng, r]; };
  return { startedAt: t0, hideEndsAt: t0, endedAt: t0 + 300 * s, players: [
      { id: H, name: 'Hank', startRole: 'hunter' }, { id: A, name: 'Ana', startRole: 'hider' }, { id: Bb, name: 'Bob', startRole: 'hider' }],
    trails: {
      [H]: [p(0, 0, 'h'), p(100, 0, 'h'), p(120, 100, 'h'), p(200, 100, 'h'), p(240, 300, 'h')],   // walks 300 m east
      [A]: [p(0, 12, 's'), p(100, 60, 's'), p(150, 60, 's'), p(300, 60, 's')],                       // 12 m from hunter at t<=100 then never caught
      [Bb]: [p(0, 305, 's'), p(150, 305, 's'), p(205, 305, 's'), p(210, 305, 'c'), p(215, 305, 'h'), p(290, 320, 'h')] },
    log: [{ t: t0 + 20 * s, k: 'decoy', id: A }, { t: t0 + 30 * s, k: 'decoy', id: A }, { t: t0 + 40 * s, k: 'bounty', id: H }, { t: t0 + 50 * s, k: 'oob', id: Bb, on: true }, { t: t0 + 80 * s, k: 'oob', id: Bb, on: false },
      { t: t0 + 208 * s, k: 'catch', id: Bb, by: H }] };
}
test('awards math: survivor, closest call, distance, decoy, bounty, fastest catch, out of bounds', () => {
  const R = fakeRecap(), A = Object.fromEntries(Recap.computeAwards(R).map(a => [a.key, a]));
  assert.equal(A.survivor.id, 'a'); assert.match(A.survivor.text, /never caught/);
  assert.equal(A.closest.id, 'a'); assert.equal(A.closest.by, 'h1'); assert.ok(Math.abs(A.closest.value - 12) <= 1);
  assert.equal(A.distance.id, 'h1'); assert.ok(Math.abs(A.distance.value - 300) < 3, 'distance ' + A.distance.value);
  assert.equal(A.decoy.id, 'a'); assert.equal(A.decoy.value, 2);
  assert.equal(A.bounty.id, 'h1'); assert.equal(A.fastest.id, 'h1'); assert.equal(A.fastest.value, 208000);
  assert.equal(A.oob.id, 'b'); assert.equal(A.oob.value, 30000);
  assert.equal(Recap.distanceWalked([[0, 0, 0], [1000, 1, 1]]), 0, 'GPS jumps (>10 m/s) are ignored');
});
test('close calls: within 20 m and not caught within 60 s; trophies', () => {
  const R = fakeRecap(), cc = Recap.closeCalls(R);
  assert.equal(cc.length, 1); assert.equal(cc[0].hider, 'a'); assert.equal(cc[0].d, 12);
  assert.match(cc[0].text, /^Hank walked right past Ana, 12 m, at 00:00$/);
  // Bob was 5 m from Hank at 205 s but got caught 3 s later -> not a close call
  assert.ok(!cc.some(c => c.hider === 'b'));
  const T = Recap.computeTrophies(R, cc), has = (k, id) => T.some(t => t.key === k && t.id === id);
  assert.ok(has('closeShave', 'a') && has('escapeArtist', 'a') && has('decoyMaster', 'a'));
  assert.ok(has('firstBlood', 'h1') && has('bountyHunter', 'h1') && has('marathoner', 'h1'));
  assert.ok(has('ruleBender', 'b')); assert.ok(!has('ghost', 'a') && !has('ghost', 'b'));
  assert.ok(!T.some(t => t.key === 'bloodhound' || t.key === 'zombie'));
  // zombie + bloodhound + ghost
  const R2 = fakeRecap(); R2.trails.a = [[R2.startedAt, at(900).lat, at(900).lng, 's']];
  R2.log.push({ t: R2.startedAt + 250000, k: 'catch', id: 'x1', by: 'b' }, ...[1, 2].map(i => ({ t: R2.startedAt + 260000 + i, k: 'catch', id: 'y' + i, by: 'h1' })));
  const T2 = Recap.computeTrophies(R2);
  assert.ok(T2.some(t => t.key === 'zombie' && t.id === 'b'), 'infected Bob caught someone');
  assert.ok(T2.some(t => t.key === 'bloodhound' && t.id === 'h1'), '3 catches');
  assert.ok(T2.some(t => t.key === 'ghost' && t.id === 'a'), 'Ana never within 50 m');
});

// ---------- server ----------
test('trail recording ~every trailMs, roles tagged, hidden until the game ends, cleared at Play again', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hider']); const [h, s] = cs;
  loc(h, at(0)); loc(s, at(500)); await sleep(50); h.send({ type: 'start' }); await until(() => h.state.state === 'playing');
  for (let i = 1; i <= 6; i++) { loc(s, at(500 + i * 10)); loc(h, at(i * 10)); await sleep(30); }
  const L = [...a.lobbies.values()][0], tr = L.trails[s.id()];
  assert.ok(tr.length >= 3 && tr.length <= 7, 'throttled trail: ' + tr.length); assert.ok(tr.every(q => q[3] === 's'));
  for (let i = 1; i < tr.length; i++) assert.ok(tr[i][0] - tr[i - 1][0] >= 50 || i === 1);
  assert.ok(!h.raw().includes('"trails"') && !s.raw().includes('"trails"'), 'no trails during play');
  h.send({ type: 'recap' }); await sleep(80); assert.ok(!h.recap, 'recap refused during play');
  h.send({ type: 'end' }); await until(() => h.recap && s.recap);
  assert.ok(h.recap.trails[s.id()].length >= 3 && h.recap.awards.length && Array.isArray(h.recap.trophies));
  assert.ok(h.recap.log.some(e => e.k === 'start') && h.recap.log.some(e => e.k === 'ping') && h.recap.log.some(e => e.k === 'end'));
  h.send({ type: 'rematch' }); await until(() => h.state.state === 'lobby');
  assert.deepEqual(L.trails, {}); assert.equal(L.log.length, 0); assert.equal(L.recapCache, null);
  done(a, cs);
});
test('infection: caught hider becomes a hunter, gets a toast message and pings', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hider', 'hider']); const [h, s1, s2] = cs;
  loc(h, at(0)); loc(s1, at(100)); loc(s2, at(300)); await sleep(50);
  h.send({ type: 'start' }); await until(() => h.pings.length >= 1);
  h.send({ type: 'catch', id: s1.id() }); // host hunter = immediate
  await until(() => s1.msgs.some(m => m.type === 'infected'));
  await until(() => s1.state.players.find(p => p.id === s1.id()).role === 'hunter');
  const n = s1.pings.length; await until(() => s1.pings.length > n && s1.pings.at(-1).locs);
  assert.ok(s1.pings.at(-1).locs[s2.id()], 'infected player sees remaining hider at pings');
  done(a, cs);
});
test('infection off: caught hider stays a (caught) hider', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hider', 'hider'], { caughtBecomeHunter: false }); const [h, s1] = cs;
  h.send({ type: 'start' }); await until(() => h.state.state === 'playing');
  h.send({ type: 'catch', id: s1.id() }); await until(() => h.state.players.find(p => p.id === s1.id()).caught);
  assert.equal(h.state.players.find(p => p.id === s1.id()).role, 'hider'); done(a, cs);
});
test('multiple hunters: each ping and compass points to that hunter\'s nearest uncaught hider', async () => {
  const a = await boot({ gameSec: 30 }); const cs = await lobby(a, ['hunter', 'hunter', 'hider', 'hider'], { gameSec: 2.5, pingSec: 0.15 }); const [h1, h2, sA, sB] = cs;
  loc(h1, at(0)); loc(h2, at(1000)); loc(sA, at(100)); loc(sB, at(900)); await sleep(60);
  h1.send({ type: 'start' }); await until(() => h1.pings.length >= 1 && h2.pings.length >= 1);
  assert.equal(h1.pings.at(-1).nearest, sA.id()); assert.equal(h2.pings.at(-1).nearest, sB.id());
  assert.ok(!sA.pings.at(-1).nearest && !sA.pings.at(-1).locs, 'hiders get no targets');
  await until(() => h1.msgs.some(m => m.type === 'compass') && h2.msgs.some(m => m.type === 'compass'), 4000);
  const c1 = h1.msgs.filter(m => m.type === 'compass').at(-1), c2 = h2.msgs.filter(m => m.type === 'compass').at(-1);
  assert.ok(Math.abs(c1.bearing - 90) <= 2 && c1.band === 'warm', JSON.stringify(c1)); // sA 100 m east of h1
  assert.ok(Math.abs(c2.bearing - 270) <= 2 && c2.band === 'warm', JSON.stringify(c2)); // sB 100 m west of h2
  // nearest skips caught hiders
  h1.send({ type: 'catch', id: sA.id() }); await until(() => h1.state.players.find(p => p.id === sA.id()).caught);
  await until(() => { const c = h1.msgs.filter(m => m.type === 'compass').at(-1); return Math.abs(c.bearing - 90) <= 2 && c.band === 'cold'; }); // now sB, 900 m east
  done(a, cs);
});
test('game ends only when ALL hiders are caught (2 hunters, 2 hiders)', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hunter', 'hider', 'hider']); const [h1, , sA, sB] = cs;
  h1.send({ type: 'start' }); await until(() => h1.state.state === 'playing');
  h1.send({ type: 'catch', id: sA.id() }); await until(() => h1.state.players.find(p => p.id === sA.id()).caught);
  assert.equal(h1.state.state, 'playing');
  h1.send({ type: 'catch', id: sB.id() }); await until(() => h1.state.state === 'ended'); assert.equal(h1.state.winner, 'hunters');
  done(a, cs);
});
test('catch confirmation: hider claim -> nearest hunter within 30 m is prompted; confirm/reject/expire/host override', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hunter', 'hunter', 'hider', 'hider', 'hider']); const [host, near, far, s1, s2, s3] = cs;
  loc(host, at(500)); loc(near, at(10)); loc(far, at(200)); loc(s1, at(0)); loc(s2, at(2000)); await sleep(60);
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing');
  // 1) hider says "I got caught": only the hunter within 30 m is prompted
  s1.send({ type: 'caughtSelf' }); await until(() => near.msgs.some(m => m.type === 'catchPrompt'));
  await sleep(60); assert.ok(!far.msgs.some(m => m.type === 'catchPrompt'), 'far hunter not prompted');
  const pr = near.msgs.find(m => m.type === 'catchPrompt'); assert.equal(pr.by, 'hider'); assert.equal(pr.hider, 'P3');
  far.send({ type: 'catchAnswer', pid: pr.pid, yes: true }); await sleep(60);
  assert.ok(!host.state.players.find(p => p.id === s1.id()).caught, 'non-target hunter cannot confirm');
  near.send({ type: 'catchAnswer', pid: pr.pid, yes: true });
  await until(() => host.state.players.find(p => p.id === s1.id()).caught);
  // 2) hunter claims (non-host): the hider must confirm; reject cancels
  far.send({ type: 'catch', id: s2.id() }); await until(() => s2.msgs.some(m => m.type === 'catchPrompt'));
  const p2 = s2.msgs.find(m => m.type === 'catchPrompt'); assert.equal(p2.by, 'hunter'); assert.equal(p2.hunter, 'P2');
  s2.send({ type: 'catchAnswer', pid: p2.pid, yes: false }); await until(() => !host.state.catches.length);
  assert.ok(!host.state.players.find(p => p.id === s2.id()).caught);
  // 3) unanswered claim expires (catchMs = 400 ms here, 20 s in production)
  far.send({ type: 'catch', id: s2.id() }); await until(() => host.state.catches.length === 1);
  await until(() => !host.state.catches.length, 2000); assert.ok(!host.state.players.find(p => p.id === s2.id()).caught);
  // 4) the other side also claiming = confirmation
  far.send({ type: 'catch', id: s2.id() }); await until(() => s2.state.catches.length === 1);
  s2.send({ type: 'caughtSelf' }); await until(() => host.state.players.find(p => p.id === s2.id()).caught);
  // 5) hider without GPS -> any hunter can confirm; host can override
  s3.send({ type: 'caughtSelf' }); await until(() => far.msgs.filter(m => m.type === 'catchPrompt').length >= 1 && host.state.catches.length === 1);
  assert.ok(host.state.catches[0].canAnswer && host.state.catches[0].hunterId === null);
  host.send({ type: 'catchAnswer', pid: host.state.catches[0].pid, yes: true });
  await until(() => host.state.state === 'ended'); assert.equal(host.state.winner, 'hunters');
  const rc = host.recap; assert.equal(rc.players.find(p => p.id === s1.id()).caughtBy, near.id());
  done(a, cs);
});
test('highlight uploads: only after the game, size-capped, host-only fetch, cleared at Play again', async () => {
  const a = await boot(); const cs = await lobby(a, ['hunter', 'hider']); const [h, s] = cs;
  const cut = { data: 'data:video/webm;base64,' + Buffer.alloc(3000).toString('base64'), t: 1, dur: 4, caption: 'CAUGHT!' };
  h.send({ type: 'start' }); await until(() => h.state.state === 'playing');
  s.send({ type: 'hlUpload', cuts: [cut] }); await until(() => s.msgs.some(m => m.type === 'hlAck')); assert.equal(s.msgs.find(m => m.type === 'hlAck').ok, false);
  h.send({ type: 'end' }); await until(() => h.state.state === 'ended');
  s.send({ type: 'hlUpload', cuts: [cut, { ...cut, dur: 30 }, { ...cut, data: 'javascript:alert(1)' }] }); await until(() => s.msgs.filter(m => m.type === 'hlAck').length === 2);
  assert.equal(s.msgs.filter(m => m.type === 'hlAck')[1].n, 1, 'invalid / >10 s cuts dropped');
  s.send({ type: 'hlFetch' }); await sleep(80); assert.ok(!s.msgs.some(m => m.type === 'hlAll'), 'non-host cannot fetch');
  h.send({ type: 'hlFetch' }); await until(() => h.msgs.some(m => m.type === 'hlAll'));
  const all = h.msgs.find(m => m.type === 'hlAll').players; assert.equal(all.length, 1); assert.equal(all[0].cuts[0].caption, 'CAUGHT!');
  assert.equal(h.state.hlCount, 1);
  h.send({ type: 'rematch' }); await until(() => h.state.state === 'lobby'); assert.equal([...a.lobbies.values()][0].highlights.size, 0);
  done(a, cs);
});
test('instagram handle validation', () => {
  const h = Recap.igHandle;
  assert.equal(h('@mmmmmray'), 'mmmmmray'); assert.equal(h('  Some.User_1 '), 'some.user_1');
  assert.equal(h('https://www.instagram.com/mmmmmray/'), 'mmmmmray'); assert.equal(h('instagram.com/a_b?igsh=xyz'), 'a_b'); assert.equal(h('http://m.instagram.com/x.y#top'), 'x.y');
  for (const bad of ['', '@', 'has space', 'bad-dash', 'a'.repeat(31), '<script>', '.lead', 'trail.', 'a..b', 'https://instagram.com/p/abc', 'https://evil.com/user', null]) assert.equal(h(bad), '', String(bad));
  assert.equal(h('a'.repeat(30)), 'a'.repeat(30));
});
test('instagram handles: shown in lobby + recap, never during the game', async () => {
  const a = await boot(); const h = client(a.url); await h.open; h.send({ type: 'create', agreed: true, name: 'H', ig: '@Host.Ig' }); await until(() => h.joined);
  const s = client(a.url); await s.open; s.send({ type: 'join', agreed: true, code: h.joined.code, name: 'S', ig: 'not valid!' }); await until(() => s.joined);
  await until(() => h.state.players.length === 2);
  assert.equal(h.state.players[0].ig, 'host.ig'); assert.ok(!('ig' in h.state.players[1]));
  s.send({ type: 'ig', ig: 'https://instagram.com/sam_s' }); await until(() => h.state.players[1].ig === 'sam_s');
  h.send({ type: 'start' }); await until(() => h.state.state !== 'lobby'); const mark = h.msgs.length;
  await sleep(100); assert.ok(!h.msgs.slice(mark).some(m => JSON.stringify(m).includes('host.ig') || JSON.stringify(m).includes('sam_s')), 'no handles during play');
  h.send({ type: 'end' }); await until(() => h.recap);
  assert.equal(h.state.players[1].ig, 'sam_s'); assert.equal(h.recap.players.find(p => p.name === 'S').ig, 'sam_s');
  done(a, [h, s]);
});
test('/play redirect (302 to / by default, PLAY_REDIRECT_URL override), /p/<code>, ?ref counting', async () => {
  const get = (a, p) => new Promise((res, rej) => require('http').get(`http://127.0.0.1:${a.server.address().port}${p}`, r => { r.resume(); res(r); }).on('error', rej));
  const a = await boot({ env: {}, quiet: true });
  let r = await get(a, '/play'); assert.equal(r.statusCode, 302); assert.equal(r.headers.location, '/');
  r = await get(a, '/play?ref=@Ana.B'); assert.equal(r.headers.location, '/?ref=ana.b');
  await get(a, '/play?ref=ana.b'); await get(a, '/?ref=bad%20handle'); assert.equal(a.refs.get('ana.b'), 2); assert.equal(a.refs.size, 1);
  r = await get(a, '/p/abc12'); assert.equal(r.headers.location, '/?code=ABC12');
  a.server.close();
  const b = await boot({ env: { PLAY_REDIRECT_URL: 'https://lastping.example/' }, quiet: true });
  r = await get(b, '/play?ref=ana'); assert.equal(r.statusCode, 302); assert.equal(r.headers.location, 'https://lastping.example/?ref=ana');
  b.server.close();
});
test('server rejects create/join without the 18+/Terms consent flag', async () => {
  const a = await boot();
  const c = client(a.url); await c.open; c.send({ type: 'create', name: 'X' }); await until(() => c.msgs.length);
  assert.equal(c.msgs[0].type, 'error'); assert.ok(c.msgs[0].consent); assert.equal(a.lobbies.size, 0);
  c.send({ type: 'create', name: 'X', agreed: 'yes' }); await until(() => c.msgs.length === 2); assert.equal(c.msgs[1].type, 'error');
  c.send({ type: 'create', name: 'X', agreed: true }); await until(() => c.joined);
  const j = client(a.url); await j.open; j.send({ type: 'join', code: c.joined.code, name: 'Y' }); await until(() => j.msgs.length);
  assert.equal(j.msgs[0].type, 'error'); assert.equal([...a.lobbies.values()][0].players.size, 1);
  const r = await new Promise(res => require('http').get(`http://127.0.0.1:${a.server.address().port}/terms`, x => { let b = ''; x.on('data', d => b += d); x.on('end', () => res({ s: x.statusCode, b })); }));
  assert.equal(r.s, 200); assert.match(r.b, /Last Ping/);
  const g = p => new Promise(res => require('http').get(`http://127.0.0.1:${a.server.address().port}${p}`, x => { let b = ''; x.on('data', d => b += d); x.on('end', () => res({ s: x.statusCode, b })); }));
  const ru = await g('/rules'); assert.equal(ru.s, 200); assert.match(ru.b, /How to play/);
  const cfg = JSON.parse((await g('/api/rules')).b); assert.equal(cfg.pingSec, 60); assert.equal(cfg.pickupSec, 5); assert.equal(cfg.hiderWeights.extraTime, 10);
  done(a, [c, j]);
});
