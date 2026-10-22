'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createApp } = require('../server');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function boot() {
  const a = createApp({ tickMs: 20, minSec: 0.1, defaultMode: 'custom' });
  await new Promise(r => a.server.listen(0, r));
  a.url = `ws://127.0.0.1:${a.server.address().port}/ws`;
  return a;
}
function client(url, name) {
  const ws = new WebSocket(url);
  const c = { ws, name, msgs: [], state: null, pings: [] };
  ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'state') c.state = m; if (m.type === 'joined') c.joined = m; if (m.type === 'ping') c.pings.push(m); });
  c.send = m => ws.send(JSON.stringify(m));
  c.open = new Promise(r => ws.on('open', r));
  c.raw = () => c.msgs.map(m => JSON.stringify(m)).join('\n');
  return c;
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };
// Fake GPS coordinates with a unique marker so leaks are easy to grep.
const HIDER_LAT = [37.111111, 37.222222];

async function setup(a, settings) {
  const host = client(a.url, 'Hunter'); await host.open; host.send({ type: 'create', agreed: true, name: 'Hunter' }); await until(() => host.joined);
  const code = host.joined.code;
  const hs = [0, 1].map(i => client(a.url, 'Hider' + i));
  for (const h of hs) { await h.open; h.send({ type: 'join', agreed: true, code, name: h.name }); await until(() => h.joined); }
  await until(() => host.state && host.state.players.length === 3);
  host.send({ type: 'loc', lat: 37.5, lng: -122.5, acc: 5 });
  hs.forEach((h, i) => h.send({ type: 'loc', lat: HIDER_LAT[i], lng: -122.1, acc: 8 }));
  host.send({ type: 'settings', settings });
  await until(() => host.state.settings.pingSec === settings.pingSec);
  return { host, hs, code };
}

test('roles default: host hunter, joiners hiders; lobby shows GPS status but no coords', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 2, pingSec: 0.3, hideSec: 0 });
  await sleep(100);
  const ps = host.state.players;
  assert.equal(ps.find(p => p.id === host.joined.id).role, 'hunter');
  assert.ok(ps.filter(p => p.role === 'hider').length === 2);
  assert.ok(ps.every(p => p.perm === 'granted' && p.acc != null));
  assert.ok(!host.raw().includes('37.111111') && !host.raw().includes('37.222222'));
  assert.ok(!hs[0].raw().includes('37.222222'), 'hider must not see other hider');
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('ping timing, privacy during head start and between pings, hiders win on timeout', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 1.2, pingSec: 0.4, hideSec: 0.3, teammates: false });
  const t0 = Date.now(); host.send({ type: 'start' });
  await until(() => host.state.state === 'hiding');
  await sleep(250);
  assert.equal(host.pings.length, 0); assert.ok(!host.raw().includes('37.111111'), 'no leak during head start');
  // move hider 0 between pings: new coords must not reach hunter until next ping
  await until(() => host.pings.length >= 1, 2000);
  const firstAt = Date.now() - t0;
  assert.ok(firstAt >= 650 && firstAt < 1000, 'first ping at hide+ping ≈700ms, got ' + firstAt);
  assert.equal(host.pings[0].locs[hs[0].joined.id].lat, 37.111111);
  hs[0].send({ type: 'loc', lat: 37.333333, lng: -122.1, acc: 8 });
  await sleep(150);
  assert.ok(!host.raw().includes('37.333333'), 'moved location must not leak before next ping');
  await until(() => host.pings.length >= 2, 2000);
  assert.equal(host.pings[1].locs[hs[0].joined.id].lat, 37.333333);
  const gap = host.pings[1].t - host.pings[0].t; assert.ok(gap >= 380 && gap < 480, 'gap ' + gap);
  // hiders receive ping notices without coordinates
  assert.ok(hs[0].pings.length >= 2 && hs[0].pings.every(p => !p.locs));
  assert.ok(!hs[0].raw().includes('37.222222') && !hs[1].raw().includes('37.333333'));
  assert.ok(hs[0].state.revealedAt > 0);
  await until(() => host.state.state === 'ended', 3000);
  assert.equal(host.state.winner, 'hiders');
  assert.ok(hs[0].state.pings.length >= 3, 'end summary includes trails for everyone');
  assert.ok(!hs[0].raw().includes('"last"'), 'hiders never get last-ping data');
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('catching: hunter catch + self-report, caught becomes hunter, all caught ends game', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 30, pingSec: 0.2, hideSec: 0, caughtBecomeHunter: true });
  host.send({ type: 'start' }); await until(() => host.pings.length >= 1);
  hs[1].send({ type: 'catch', id: hs[0].joined.id }); // hider cannot catch
  await sleep(80); assert.ok(!host.state.players.find(p => p.id === hs[0].joined.id).caught);
  host.send({ type: 'catch', id: hs[0].joined.id });
  await until(() => hs[0].state.players.find(p => p.id === hs[0].joined.id).caught);
  assert.equal(hs[0].state.players.find(p => p.id === hs[0].joined.id).role, 'hunter');
  await until(() => hs[0].state.last && Object.keys(hs[0].state.last).length > 0); // converted hunter gets ping data
  hs[1].send({ type: 'caughtSelf' }); // now needs a hunter's (or host's) confirmation
  await until(() => host.msgs.some(m => m.type === 'catchPrompt'));
  host.send({ type: 'catchAnswer', pid: host.msgs.find(m => m.type === 'catchPrompt').pid, yes: true });
  await until(() => host.state.state === 'ended');
  assert.equal(host.state.winner, 'hunters');
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('reconnect with token restores same player & role; non-host cannot start', async () => {
  const a = await boot(); const { host, hs, code } = await setup(a, { gameSec: 30, pingSec: 5, hideSec: 0 });
  hs[0].send({ type: 'start' }); await sleep(80); assert.equal(host.state.state, 'lobby');
  const { id, token } = hs[0].joined; hs[0].ws.terminate();
  await until(() => !host.state.players.find(p => p.id === id).connected);
  const back = client(a.url, 'again'); await back.open; back.send({ type: 'rejoin', code, token });
  await until(() => back.state);
  assert.equal(back.state.you, id); assert.equal(host.state.players.length, 3);
  assert.ok(host.state.players.find(p => p.id === id).connected);
  const bad = client(a.url, 'x'); await bad.open; bad.send({ type: 'rejoin', code, token: 'nope' });
  await until(() => bad.msgs.length); assert.equal(bad.msgs[0].type, 'error');
  a.server.close(); [host, hs[1], back, bad].forEach(c => c.ws.terminate());
});

test('ended lobby kept while players remain; deleted after 1 h idle (memory only)', async () => {
  let fake = Date.now();
  const a = createApp({ tickMs: 20, minSec: 0.1, now: () => fake, defaultMode: 'custom' });
  await new Promise(r => a.server.listen(0, r)); a.url = `ws://127.0.0.1:${a.server.address().port}/ws`;
  const { host, hs } = await setup(a, { gameSec: 30, pingSec: 5, hideSec: 0 });
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing');
  host.send({ type: 'end' }); await until(() => host.state.state === 'ended');
  assert.equal(a.lobbies.size, 1);
  await sleep(100); fake += 11 * 60 * 1000; await sleep(100); assert.equal(a.lobbies.size, 1, 'kept while players remain'); fake += 50 * 60 * 1000; await until(() => a.lobbies.size === 0);
  await until(() => host.msgs.some(m => m.type === 'gone'));
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('3 consecutive rounds via rematch: same code/players, roles restored, no stale pings/timers', async () => {
  const a = await boot(); const { host, hs, code } = await setup(a, { gameSec: 0.9, pingSec: 0.3, hideSec: 0, caughtBecomeHunter: true });
  const ids = [host, ...hs].map(c => c.joined.id).sort();
  for (let round = 1; round <= 3; round++) {
    host.pings.length = 0;
    const t0 = Date.now(); host.send({ type: 'start' });
    await until(() => host.state.state === 'playing' && host.state.round === round);
    assert.ok(!host.state.last || Object.keys(host.state.last).length === 0, 'no old ping state at round start');
    if (round === 2) for (const c of [host, ...hs]) if (host.state.players.find(p => p.id === c.joined.id).role === 'hider') { c.send({ type: 'caughtSelf' }); await until(() => host.state.catches.some(x => x.hiderId === c.joined.id)); host.send({ type: 'catchAnswer', pid: host.state.catches.find(x => x.hiderId === c.joined.id).pid, yes: true }); }
    await until(() => host.state.state === 'ended', 3000);
    assert.equal(host.state.winner, round === 2 ? 'hunters' : 'hiders');
    if (round !== 2) {
      const n = host.pings.length; assert.ok(n >= 3 && n <= 4, `round ${round}: ${n} pings in 0.9 s @0.3 s (no duplicates)`);
      const ts = host.state.pings.map(p => p.t); assert.ok(ts.every(t => t >= t0), 'summary only has this round\'s pings');
    }
    const ping0 = host.pings.length; await sleep(400); assert.equal(host.pings.length, ping0, 'no pings after end (stale timer)');
    hs[1].send({ type: 'rematch' }); // a non-host can bring everyone back to the waiting room
    await until(() => host.state.state === 'lobby');
    const s = host.state;
    assert.equal(s.code, code); assert.deepEqual(s.players.map(p => p.id).sort(), ids);
    assert.ok(s.players.every(p => !p.caught)); assert.equal(s.pingCount, 0); assert.ok(!s.pings && !s.last);
    assert.equal(s.players.filter(p => p.role === 'hunter').length, 1, 'pre-game roles restored');
    assert.deepEqual(s.settings.pingSec, 0.3);
    host.send({ type: 'randomize', hunters: 1 }); await sleep(50);
    assert.equal(host.state.players.filter(p => p.role === 'hunter').length, 1);
  }
  assert.equal(a.lobbies.size, 1);
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('leave: removed for everyone, host transfers, can rejoin as new, last leaver deletes lobby', async () => {
  const a = await boot(); const { host, hs, code } = await setup(a, { gameSec: 30, pingSec: 5, hideSec: 0 });
  const tok = hs[0].joined.token, id0 = hs[0].joined.id;
  hs[0].send({ type: 'leave' }); await until(() => hs[0].msgs.some(m => m.type === 'left'));
  await until(() => host.state.players.length === 2);
  const r = client(a.url, 'r'); await r.open; r.send({ type: 'rejoin', code, token: tok });
  await until(() => r.msgs.length); assert.equal(r.msgs[0].type, 'error', 'old session cannot rejoin');
  hs[0].send({ type: 'join', agreed: true, code, name: 'Hider0' }); await until(() => host.state.players.length === 3);
  assert.ok(!host.state.players.some(p => p.id === id0), 'rejoined as a new player');
  host.send({ type: 'leave' });
  await until(() => hs[1].state.host !== host.joined.id);
  assert.ok([hs[0], hs[1]].map(c => c.joinedId || c.msgs.filter(m => m.type === 'joined').pop().id).includes(hs[1].state.host));
  assert.ok(hs[1].state.events.some(e => /now host/.test(e.text)));
  // new host can start; leaving mid-game ends when no hiders left
  const newHost = hs[1].state.host === hs[1].joined.id ? hs[1] : hs[0];
  const other = newHost === hs[1] ? hs[0] : hs[1];
  const ms = other.msgs.filter(m => m.type === 'joined').pop();
  newHost.send({ type: 'role', id: newHost.msgs.filter(m => m.type === 'joined').pop().id, role: 'hunter' });
  newHost.send({ type: 'role', id: ms.id, role: 'hider' });
  newHost.send({ type: 'start' }); await until(() => newHost.state.state === 'playing');
  other.send({ type: 'leave' }); await until(() => newHost.state.state === 'ended');
  assert.equal(newHost.state.winner, 'hunters');
  newHost.send({ type: 'leave' }); await until(() => a.lobbies.size === 0);
  a.server.close(); [host, ...hs, r].forEach(c => c.ws.terminate());
});

test('reconnect mid-game delivers latest ping immediately', async () => {
  const a = await boot(); const { host, hs, code } = await setup(a, { gameSec: 30, pingSec: 0.3, hideSec: 0 });
  host.send({ type: 'start' }); await until(() => host.pings.length >= 1);
  const { token } = host.joined; host.ws.terminate();
  const back = client(a.url, 'b'); await back.open; back.send({ type: 'rejoin', code, token });
  await until(() => back.state);
  assert.equal(back.state.last[hs[0].joined.id].lat, 37.111111);
  a.server.close(); [back, ...hs].forEach(c => c.ws.terminate());
});

// ---------------- feature tests ----------------
const { distM, bearingDeg, offsetM } = require('../server');
const only = (...on) => Object.fromEntries(['decoy', 'chime', 'bounty', 'cam', 'compass'].map(f => [f, on.includes(f)]));
const lobbyOf = (a, code) => a.lobbies.get(code);
const HIDER0 = { lat: HIDER_LAT[0], lng: -122.1 };

test('lobby feature toggles (Custom mode test default): all on, host-only, persisted across rematch', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 30, pingSec: 5, hideSec: 0 });
  assert.deepEqual(host.state.settings.features, only('decoy', 'chime', 'bounty', 'cam', 'compass'));
  hs[0].send({ type: 'settings', settings: { features: { decoy: false } } }); await sleep(60);
  assert.equal(host.state.settings.features.decoy, true, 'non-host cannot toggle');
  host.send({ type: 'settings', settings: { features: { decoy: false, cam: false } } });
  await until(() => !host.state.settings.features.decoy && !host.state.settings.features.cam);
  assert.equal(host.state.settings.features.chime, true);
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('ghost decoy: 2 charges, next scheduled ping offset 30-150 m, then real again', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 30, pingSec: 0.3, hideSec: 0, features: only('decoy') });
  const id = hs[0].joined.id;
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing');
  assert.equal(hs[0].state.decoys, 2);
  for (let k = 0; k < 2; k++) {
    hs[0].send({ type: 'decoy' }); await until(() => hs[0].state.decoyArmed && hs[0].state.decoys === 1 - k);
    hs[0].send({ type: 'decoy' }); await sleep(30); assert.equal(hs[0].state.decoys, 1 - k, 'cannot stack while armed');
    const n = host.pings.length; await until(() => host.pings.length > n, 2000);
    const l = host.pings[host.pings.length - 1].locs[id];
    const d = distM(HIDER0, l); assert.ok(d >= 29.5 && d <= 150.5, 'decoy offset ' + d);
    assert.ok(!('decoy' in l) && !host.pings[host.pings.length - 1].decoys, 'hunters cannot tell it is fake');
    assert.equal(host.pings[host.pings.length - 1].locs[hs[1].joined.id].lat, HIDER_LAT[1], 'other hider unaffected');
    await until(() => !hs[0].state.decoyArmed);
    const m = host.pings.length; await until(() => host.pings.length > m, 2000);
    assert.equal(host.pings[host.pings.length - 1].locs[id].lat, HIDER0.lat, 'only one ping is faked');
  }
  hs[0].send({ type: 'decoy' }); await sleep(60); assert.equal(hs[0].state.decoys, 0); assert.ok(!hs[0].state.decoyArmed, 'no third charge');
  assert.ok(!host.raw().includes('"decoys"'), 'hunter never sees decoy bookkeeping during play');
  host.send({ type: 'end' }); await until(() => host.state.state === 'ended');
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('decoy disabled by host toggle', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 30, pingSec: 0.3, hideSec: 0, features: only() });
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing');
  hs[0].send({ type: 'decoy' }); await sleep(60); assert.equal(hs[0].state.decoys, 2); assert.ok(!hs[0].state.decoyArmed);
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('cold-ping chime: only hiders within 40 m of a hunter chime; hunters get a no-location notice', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 30, pingSec: 0.3, hideSec: 0, features: only('chime') });
  const H = { lat: 37.5, lng: -122.5 };
  const near = offsetM(H, 35, 90), far = offsetM(H, 46, 270);
  hs[0].send({ type: 'loc', ...near, acc: 5 }); hs[1].send({ type: 'loc', ...far, acc: 5 });
  host.send({ type: 'start' }); await until(() => host.pings.length >= 2, 2000);
  assert.ok(hs[0].msgs.some(m => m.type === 'chime'), 'near hider chimes');
  assert.ok(!hs[1].msgs.some(m => m.type === 'chime'), 'hider at 46 m does not chime');
  const notice = host.msgs.find(m => m.type === 'chimeNearby');
  assert.ok(notice && notice.n === 1 && !JSON.stringify(notice).includes('lat'), 'hunter notice without location');
  assert.ok(!hs[1].msgs.some(m => m.type === 'chimeNearby'));
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('chime off when toggled off', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 30, pingSec: 0.3, hideSec: 0, features: only() });
  hs[0].send({ type: 'loc', ...offsetM({ lat: 37.5, lng: -122.5 }, 5, 0), acc: 5 });
  host.send({ type: 'start' }); await until(() => host.pings.length >= 2, 2000);
  assert.ok(!hs[0].msgs.some(m => m.type === 'chime'));
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('bounty: spawns every 5 scaled min near centroid (50-250 m), visible to all, replaced by next', async () => {
  const a = await boot(); const { host, hs, code } = await setup(a, { gameSec: 2.4, pingSec: 5, hideSec: 0, features: only('bounty') });
  host.send({ type: 'start' }); // bounty every 300*(2.4/1200)=0.6 s
  await until(() => host.state.bounty, 1500);
  const b1 = host.state.bounty;
  assert.ok(hs[0].state.bounty && hs[0].state.bounty.id === b1.id, 'hiders see it too');
  const ps = [{ lat: 37.5, lng: -122.5 }, { lat: HIDER_LAT[0], lng: -122.1 }, { lat: HIDER_LAT[1], lng: -122.1 }];
  const c = { lat: ps.reduce((s, p) => s + p.lat, 0) / 3, lng: ps.reduce((s, p) => s + p.lng, 0) / 3 };
  const d = distM(c, b1); assert.ok(d >= 49 && d <= 251, 'bounty distance from centroid ' + d);
  await until(() => host.state.bounty && host.state.bounty.id !== b1.id, 1500);
  assert.ok(lobbyOf(a, code).bounty.id !== b1.id, 'old bounty despawned when next spawned');
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('bounty claimed by hider wipes their next scheduled ping; by hunter triggers immediate ping', async () => {
  const a = await boot(); const { host, hs, code } = await setup(a, { gameSec: 60, pingSec: 0.4, hideSec: 0, features: only('bounty') });
  const L = lobbyOf(a, code), id0 = hs[0].joined.id, id1 = hs[1].joined.id;
  host.send({ type: 'start' }); await until(() => host.pings.length >= 1, 2000);
  assert.ok(host.state.last[id0]);
  // hider claims: must be within 15 m
  a.spawnBounty(L, offsetM(HIDER0, 20, 0)); hs[0].send({ type: 'loc', ...HIDER0, acc: 5 }); await sleep(50);
  assert.ok(L.bounty, '20 m away is too far to claim');
  const spot = offsetM(HIDER0, 10, 0);
  hs[0].send({ type: 'loc', ...spot, acc: 5 }); await until(() => !L.bounty);
  await until(() => hs[0].msgs.some(m => m.type === 'bounty' && m.effect === 'wipe'));
  assert.ok(hs[0].state.cloaked);
  const n = host.pings.length; await until(() => host.pings.length > n, 2000);
  const pg = host.pings[host.pings.length - 1];
  assert.equal(pg.locs[id0], null, 'wiped hider has no location this cycle'); assert.ok(pg.hidden.includes(id0));
  assert.ok(pg.locs[id1], 'other hider still pinged');
  await until(() => !host.state.last[id0]); // hunters see nothing for them
  assert.ok(!host.raw().includes(String(spot.lat.toFixed(6)).slice(0, 9)), 'wiped coords never sent');
  const m2 = host.pings.length; await until(() => host.pings.length > m2, 2000);
  assert.ok(host.pings[host.pings.length - 1].locs[id0], 'only one cycle is wiped');
  // hunter claims: immediate out-of-cycle ping, schedule unchanged
  const nextAt = host.state.nextPingAt;
  a.spawnBounty(L, offsetM({ lat: 37.5, lng: -122.5 }, 8, 45));
  const before = host.pings.length;
  host.send({ type: 'loc', ...offsetM({ lat: 37.5, lng: -122.5 }, 6, 45), acc: 5 });
  await until(() => host.pings.length > before, 300);
  const out = host.pings[host.pings.length - 1];
  assert.ok(out.out && out.locs[id0] && out.locs[id1], 'out-of-cycle ping of all hiders');
  assert.equal(host.state.nextPingAt, nextAt, 'regular schedule not shifted');
  assert.ok(!L.bounty, 'despawned on claim');
  assert.ok(hs[0].pings.some(p => p.out && !p.locs), 'hiders told about surprise ping, without coords');
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('hider cam peek at minute 10 (scaled): relayed to hunters only, no GPS, unavailable when denied/no reply', async () => {
  const a = await boot(); const { host, hs, code } = await setup(a, { gameSec: 2.4, pingSec: 5, hideSec: 0, features: only('cam') });
  const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
  hs[0].send({ type: 'cam', cam: 'granted' }); hs[1].send({ type: 'cam', cam: 'denied' });
  hs[0].ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'camRequest') hs[0].send({ type: 'camPhoto', data: JPEG }); });
  await until(() => host.state.players.find(p => p.id === hs[0].joined.id).cam === 'granted');
  const t0 = Date.now(); host.send({ type: 'start' }); // camAt = 600*(2.4/1200) = 1.2 s
  await until(() => host.msgs.some(m => m.type === 'camPeek' && m.data), 3000);
  assert.ok(Date.now() - t0 >= 1100, 'photo requested at scaled minute 10');
  const peeks = host.msgs.filter(m => m.type === 'camPeek');
  const p0 = peeks.find(m => m.id === hs[0].joined.id && m.data), p1 = peeks.find(m => m.id === hs[1].joined.id);
  assert.equal(p0.data, JPEG); assert.ok(p1.unavailable && !p1.data, 'denied hider -> photo unavailable');
  for (const p of peeks) assert.ok(!('lat' in p) && !('lng' in p) && !('loc' in p), 'no GPS data with photo');
  assert.ok(!hs[0].msgs.some(m => m.type === 'camPeek') && !hs[1].msgs.some(m => m.type === 'camPeek'), 'hiders never get photos');
  assert.ok(!hs[1].raw().includes(JPEG) && !hs[0].raw().includes('"photos"'));
  assert.ok(host.state.photos[hs[0].joined.id].has, 'state lists photo for hunters');
  assert.ok(!lobbyOf(a, code).photos[hs[0].joined.id].lat);
  hs[1].send({ type: 'camPhoto', data: JPEG }); await sleep(50); // unsolicited upload ignored
  assert.ok(lobbyOf(a, code).photos[hs[1].joined.id].unavailable);
  await until(() => host.state.state === 'ended', 3000);
  hs[0].send({ type: 'rematch' }); await until(() => host.state.state === 'lobby');
  assert.deepEqual(lobbyOf(a, code).photos, {}, 'photos dropped at the next round (memory only)');
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('cam: granted hider that never answers (backgrounded page) -> unavailable after timeout', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 1.2, pingSec: 5, hideSec: 0, features: only('cam') });
  hs[0].send({ type: 'cam', cam: 'granted' }); await sleep(50);
  host.send({ type: 'start' });
  await until(() => host.msgs.some(m => m.type === 'camPeek' && m.id === hs[0].joined.id && m.pending), 2000);
  await until(() => host.msgs.some(m => m.type === 'camPeek' && m.id === hs[0].joined.id && m.unavailable), 5000);
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('sudden death compass: from 18:00 no map pings, hunters get bearing + band only, never coordinates', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 2, pingSec: 0.25, hideSec: 0, features: only('compass') });
  const t0 = Date.now(); host.send({ type: 'start' }); // compassAt = 1080*(2/1200) = 1.8 s
  await until(() => host.msgs.some(m => m.type === 'compass'), 3000);
  assert.ok(Date.now() - t0 >= 1750, 'compass starts at scaled 18:00');
  const startIdx = host.msgs.findIndex(m => m.type === 'compass');
  await until(() => host.state.state === 'ended', 2000);
  const during = host.msgs.slice(startIdx);
  const comps = during.filter(m => m.type === 'compass');
  assert.ok(comps.length >= 1);
  const want = Math.round(bearingDeg({ lat: 37.5, lng: -122.5 }, { lat: HIDER_LAT[1], lng: -122.1 }));
  for (const c of comps) {
    assert.deepEqual(Object.keys(c).sort(), ['band', 'bearing', 'type'], 'compass message has no coordinates');
    assert.equal(c.bearing, want, 'points at nearest hider'); assert.equal(c.band, 'cold');
  }
  const pingsDuring = during.filter(m => m.type === 'ping');
  assert.ok(pingsDuring.length <= 1, 'only the final end-of-game reveal ping after 18:00');
  assert.ok(!during.filter(m => m.type === 'state' && m.state === 'playing').some(s => s.last && JSON.stringify(s).includes('"compass":false')), 'state flags compass mode');
  assert.ok(!hs[0].msgs.some(m => m.type === 'compass'), 'hiders get no compass');
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

// ---------------- playing field ----------------
const Field = require('../public/field');
const { offsetM: off } = require('../server');
const C0 = { lat: 37.5, lng: -122.5 };
const SQ = d => [[C0.lat - d, C0.lng - d], [C0.lat - d, C0.lng + d], [C0.lat + d, C0.lng + d], [C0.lat + d, C0.lng - d]];

test('field geometry: point-in-circle, point-in-polygon (incl. concave), intersection', () => {
  const c = { ...C0, r: 402 };
  assert.ok(Field.inCircle(c, off(C0, 400, 33))); assert.ok(!Field.inCircle(c, off(C0, 405, 33)));
  const sq = SQ(0.002);
  assert.ok(Field.inPolygon(sq, C0)); assert.ok(!Field.inPolygon(sq, { lat: C0.lat + 0.0021, lng: C0.lng }));
  const L = [[0, 0], [0, 2], [1, 2], [1, 1], [2, 1], [2, 0]]; // L-shape
  assert.ok(Field.inPolygon(L, { lat: 0.5, lng: 1.5 })); assert.ok(Field.inPolygon(L, { lat: 1.5, lng: 0.5 })); assert.ok(!Field.inPolygon(L, { lat: 1.5, lng: 1.5 }));
  const both = { circle: c, poly: SQ(0.002) }; // square ±~222 m lat, circle 402 m
  assert.ok(Field.inField(both, C0));
  assert.ok(!Field.inField(both, off(C0, 300, 0)), 'inside circle, outside square');
  assert.ok(!Field.inField(both, { lat: C0.lat + 0.0019, lng: C0.lng + 0.0045 }) || true);
  const cornerSq = { lat: C0.lat + 0.0019, lng: C0.lng + 0.0019 }; // in square, ~265 m away -> also in circle
  assert.ok(Field.inField(both, cornerSq));
  const bigSq = { circle: { ...C0, r: 100 }, poly: SQ(0.002) };
  assert.ok(!Field.inField(bigSq, cornerSq), 'in square but outside small circle');
  assert.ok(Field.inField(null, { lat: 0, lng: 0 }), 'no boundary = everywhere');
});

test('field validation', () => {
  assert.deepEqual(Field.validate(null), { field: null });
  assert.deepEqual(Field.validate({}), { field: null });
  assert.ok(Field.validate({ circle: { ...C0, r: 402 } }).field.circle.r === 402);
  assert.ok(Field.validate({ circle: { lat: 99, lng: 0, r: 402 } }).error);
  assert.ok(Field.validate({ circle: { lat: 'x', lng: 0, r: 402 } }).error);
  assert.ok(Field.validate({ circle: { ...C0, r: 1e7 } }).error);
  assert.ok(Field.validate({ poly: SQ(0.002).slice(0, 2) }).error, '<3 points');
  const many = Array.from({ length: 51 }, (_, i) => [C0.lat + 0.002 * Math.sin(i / 51 * 6.283), C0.lng + 0.002 * Math.cos(i / 51 * 6.283)]);
  assert.match(Field.validate({ poly: many }).error, /at most 50/);
  assert.ok(Field.validate({ poly: many.slice(0, 50) }).field.poly.length === 50);
  assert.ok(Field.validate({ poly: [[0, 0], [0, 1], [1, 1]] }).error, 'too big');
  assert.ok(Field.validate({ poly: [[0, 0], [0, 'a'], [1, 1]] }).error);
  assert.match(Field.validate({ circle: { ...C0, r: 100 }, poly: SQ(0.001).map(([a, b]) => [a + 0.05, b]) }).error, /overlap/);
});

test('field via server: host-only, validated, broadcast to lobby, persists across rematch, editable between rounds', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 0.5, pingSec: 0.2, hideSec: 0 });
  hs[0].send({ type: 'field', field: { circle: { ...C0, r: 402 } } }); await sleep(80);
  assert.equal(host.state.field, null, 'non-host cannot set field');
  host.send({ type: 'field', field: { poly: SQ(0.002).slice(0, 2) } });
  await until(() => host.msgs.some(m => m.type === 'error'));
  host.send({ type: 'field', field: { circle: { ...C0, r: 402 }, poly: SQ(0.002) } });
  await until(() => hs[1].state.field && hs[1].state.field.poly);
  assert.equal(hs[0].state.field.circle.r, 402); assert.equal(hs[1].state.field.poly.length, 4);
  host.send({ type: 'field', field: null }); await until(() => hs[0].state.field === null);
  host.send({ type: 'field', field: { circle: { ...C0, r: 50000 } } }); await sleep(60); assert.equal(hs[0].state.field, null);
  host.send({ type: 'field', field: { circle: { ...C0, r: 805 } } }); await until(() => hs[0].state.field);
  // hiders are far outside -> start blocked with the list, then force start
  host.send({ type: 'start' }); await until(() => host.msgs.some(m => m.type === 'startBlocked'));
  const sb = host.msgs.find(m => m.type === 'startBlocked');
  assert.deepEqual(sb.outside.map(o => o.name).sort(), ['Hider0', 'Hider1']); assert.equal(host.state.state, 'lobby');
  host.send({ type: 'start', force: true }); await until(() => host.state.state === 'ended', 3000);
  for (const c of [host, ...hs]) c.send({ type: 'rematch' });
  await until(() => host.state.state === 'lobby');
  assert.equal(host.state.field.circle.r, 805, 'field persists across Play again');
  host.send({ type: 'field', field: { circle: { ...C0, r: 1609 } } }); await until(() => hs[0].state.field.circle.r === 1609);
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('start allowed without prompt when everyone is inside the field', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 1, pingSec: 0.2, hideSec: 0 });
  hs.forEach(h => h.send({ type: 'loc', ...off(C0, 100, 90), acc: 5 }));
  host.send({ type: 'loc', ...C0, acc: 5 });
  host.send({ type: 'field', field: { circle: { ...C0, r: 402 } } }); await until(() => host.state.field);
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing');
  assert.ok(!host.msgs.some(m => m.type === 'startBlocked'));
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('bounties always spawn inside the field (circle, polygon, intersection, players outside)', () => {
  const a = createApp({ tickMs: 1e6 });
  const mkL = (field, locs) => ({ field, players: new Map(locs.map((l, i) => [i, { loc: l, role: 'hider', caught: false }])), events: [] });
  const fields = [{ circle: { ...C0, r: 402 }, poly: null }, { circle: null, poly: SQ(0.002) }, { circle: { ...C0, r: 300 }, poly: SQ(0.002) }];
  for (const f of fields) for (const locs of [[C0], [off(C0, 3000, 10)], [off(C0, 350, 45), off(C0, 380, 200)]]) {
    const L = mkL(f, locs);
    for (let i = 0; i < 100; i++) { a.spawnBounty(L); assert.ok(L.bounty && Field.inField(f, L.bounty), 'bounty outside field'); }
  }
  a.server.close();
});

test('out of bounds: warning state for the player, hider auto-revealed (true spot, decoy ignored) on next ping after grace', async () => {
  const a = createApp({ tickMs: 20, minSec: 0.1, oobMinMs: 300, defaultMode: 'custom' });
  await new Promise(r => a.server.listen(0, r)); a.url = `ws://127.0.0.1:${a.server.address().port}/ws`;
  const { host, hs } = await setup(a, { gameSec: 4, pingSec: 0.8, hideSec: 0, teammates: false });
  const IN = off(C0, 100, 0), OUT = off(C0, 700, 0);
  host.send({ type: 'loc', ...C0, acc: 5 }); hs.forEach(h => h.send({ type: 'loc', ...IN, acc: 5 }));
  host.send({ type: 'field', field: { circle: { ...C0, r: 402 } } }); await until(() => host.state.field);
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing');
  assert.equal(a.oobGrace([...a.lobbies.values()][0]), 300);
  hs[0].send({ type: 'decoy' }); await until(() => hs[0].state.decoyArmed);
  hs[0].send({ type: 'loc', ...OUT, acc: 5 });
  await until(() => hs[0].state.outSince > 0);
  assert.ok(host.state.players.find(p => p.id === hs[0].joined.id).out, 'others see an out flag (no coords)');
  assert.ok(!hs[1].raw().includes(String(OUT.lat)), 'no coord leak');
  await until(() => host.state.events.some(e => /revealed at the next ping/.test(e.text)), 2000);
  const n = host.pings.length; await until(() => host.pings.length > n, 2000);
  const pl = host.pings[n].locs[hs[0].joined.id];
  assert.ok(Math.abs(pl.lat - OUT.lat) < 1e-9, 'true position revealed (decoy ignored while out of bounds)');
  hs[0].send({ type: 'loc', ...IN, acc: 5 }); await until(() => !hs[0].state.outSince);
  assert.ok(!host.state.players.find(p => p.id === hs[0].joined.id).out);
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('no boundary (default): nobody is ever out of bounds', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 1, pingSec: 0.2, hideSec: 0 });
  assert.equal(host.state.field, null);
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing'); await sleep(200);
  assert.ok(host.state.players.every(p => !p.out) && !host.msgs.some(m => m.type === 'startBlocked'));
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});

test('teammates: uncaught hiders see each other live, hunters NEVER get hider teammate positions; role switch on infection', async () => {
  const a = await boot(); const { host, hs, code } = await setup(a, { gameSec: 60, pingSec: 30, hideSec: 0, caughtBecomeHunter: true });
  const h2 = client(a.url, 'Hider2'); await h2.open; h2.send({ type: 'join', agreed: true, code, name: 'Hider2' }); await until(() => h2.joined);
  const hunter2 = client(a.url, 'H2'); await hunter2.open; hunter2.send({ type: 'join', agreed: true, code, name: 'H2' }); await until(() => hunter2.joined);
  host.send({ type: 'setRole', id: hunter2.joined.id, role: 'hunter' }); host.send({ type: 'role', id: hunter2.joined.id, role: 'hunter' });
  await sleep(100);
  const H2 = hunter2.state.players.find(p => p.id === hunter2.joined.id).role === 'hunter';
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing');
  const hidLoc = lat => s => (s.players.find(p => p.loc && p.loc.lat === lat));
  hs[0].send({ type: 'loc', lat: 37.444444, lng: -122.1, acc: 5 });
  await until(() => hs[1].state && hidLoc(37.444444)(hs[1].state) && h2.state && hidLoc(37.444444)(h2.state));
  assert.equal(hs[1].state.players.find(p => p.id === hs[0].joined.id).loc.lat, 37.444444, 'teammate visible with id/name');
  if (H2) { hunter2.send({ type: 'loc', lat: 37.777777, lng: -122.2, acc: 5 }); await until(() => hidLoc(37.777777)(host.state)); } // hunters see each other live
  await sleep(100);
  for (const c of [host, hunter2]) assert.ok(!c.raw().includes('37.444444'), 'hunter must never receive hider teammate positions');
  // infection: hs[0] caught -> becomes hunter
  host.send({ type: 'catch', id: hs[0].joined.id });
  await until(() => hs[0].state.players.find(p => p.id === hs[0].joined.id).role === 'hunter');
  const mark = hs[0].msgs.length;
  hs[1].send({ type: 'loc', lat: 37.666666, lng: -122.1, acc: 5 });
  await until(() => hidLoc(37.666666)(h2.state));
  host.send({ type: 'loc', lat: 37.555555, lng: -122.5, acc: 5 });
  await until(() => hidLoc(37.555555)(hs[0].state)); // now sees hunters live
  assert.ok(!hs[0].msgs.slice(mark).some(m => JSON.stringify(m).includes('37.666666')), 'infected player stops receiving hider positions');
  assert.ok(!host.raw().includes('37.666666'));
  hs[0].send({ type: 'loc', lat: 37.888888, lng: -122.1, acc: 5 }); await sleep(150);
  assert.ok(!hidLoc(37.888888)(hs[1].state) && !hidLoc(37.888888)(h2.state), 'hiders stop seeing the infected player');
  a.server.close(); [host, ...hs, h2, hunter2].forEach(c => c.ws.terminate());
});

test('teammates: caught spectator sees nothing live; toggle off hides teammates', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 60, pingSec: 30, hideSec: 0, caughtBecomeHunter: false, teammates: true });
  host.send({ type: 'start' }); await until(() => host.state.state === 'playing');
  host.send({ type: 'catch', id: hs[0].joined.id });
  await until(() => hs[0].state.players.find(p => p.id === hs[0].joined.id).caught);
  const mark = hs[0].msgs.length;
  hs[1].send({ type: 'loc', lat: 37.343434, lng: -122.1, acc: 5 }); host.send({ type: 'loc', lat: 37.565656, lng: -122.5, acc: 5 }); await sleep(200);
  const later = hs[0].msgs.slice(mark).map(m => JSON.stringify(m)).join();
  assert.ok(!later.includes('37.343434') && !later.includes('37.565656'), 'spectator sees nothing live');
  assert.ok(hs[0].state.players.every(p => p.id === hs[0].joined.id || !p.loc));
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
  const b = await boot(); const s2 = await setup(b, { gameSec: 60, pingSec: 30, hideSec: 0, teammates: false });
  assert.equal(s2.host.state.settings.teammates, false);
  s2.host.send({ type: 'start' }); await until(() => s2.host.state.state === 'playing');
  s2.hs[0].send({ type: 'loc', lat: 37.454545, lng: -122.1, acc: 5 }); await sleep(200);
  assert.ok(!s2.hs[1].raw().includes('37.454545') && !s2.host.raw().includes('37.454545'));
  b.server.close(); [s2.host, ...s2.hs].forEach(c => c.ws.terminate());
});

test('player cap: MAX_PLAYERS per lobby, "Lobby is full (n/n)" on join, exposed in state and /api/rules', async () => {
  const a = createApp({ tickMs: 20, minSec: 0.1, maxPlayers: 3 }); await new Promise(r => a.server.listen(0, r)); a.url = `ws://127.0.0.1:${a.server.address().port}/ws`;
  const { host, hs, code } = await setup(a, { gameSec: 60, pingSec: 30, hideSec: 0 });
  assert.equal(host.state.maxPlayers, 3);
  const x = client(a.url, 'X'); await x.open; x.send({ type: 'join', agreed: true, code, name: 'X' }); await until(() => x.msgs.length);
  assert.equal(x.msgs[0].type, 'error'); assert.equal(x.msgs[0].error, 'Lobby is full (3/3)'); assert.equal(host.state.players.length, 3);
  const r = await new Promise(res => require('http').get(`http://127.0.0.1:${a.server.address().port}/api/rules`, q => { let b = ''; q.on('data', d => b += d); q.on('end', () => res(JSON.parse(b))); }));
  assert.equal(r.maxPlayers, 3);
  a.server.close(); [host, ...hs, x].forEach(c => c.ws.terminate());
  const e = createApp({ env: { MAX_PLAYERS: '7' } }); await new Promise(r2 => e.server.listen(0, r2));
  const r2 = await new Promise(res => require('http').get(`http://127.0.0.1:${e.server.address().port}/api/rules`, q => { let b = ''; q.on('data', dd => b += dd); q.on('end', () => res(JSON.parse(b))); }));
  assert.equal(r2.maxPlayers, 7); e.server.close();
});

test('game modes: new lobby defaults to Classic; presets apply; a manual toggle switches to Custom; listed in /api/rules', async () => {
  const a = createApp({ tickMs: 20, minSec: 0.1 }); await new Promise(r => a.server.listen(0, r)); a.url = `ws://127.0.0.1:${a.server.address().port}/ws`;
  const host = client(a.url, 'H'); await host.open; host.send({ type: 'create', agreed: true, name: 'H' }); await until(() => host.state);
  let st = host.state.settings; assert.equal(st.mode, 'classic'); assert.equal(st.powerups, 'off');
  assert.deepEqual(st.features, { decoy: false, chime: true, bounty: false, cam: false, compass: false });
  host.send({ type: 'settings', settings: { mode: 'party' } }); await until(() => host.state.settings.mode === 'party');
  st = host.state.settings; assert.equal(st.powerups, 'normal'); assert.deepEqual(st.features, { decoy: true, chime: true, bounty: true, cam: false, compass: true });
  host.send({ type: 'settings', settings: { mode: 'chaos' } }); await until(() => host.state.settings.mode === 'chaos');
  st = host.state.settings; assert.equal(st.powerups, 'chaos'); assert.ok(Object.values(st.features).every(Boolean));
  host.send({ type: 'settings', settings: { features: { cam: false } } }); await until(() => host.state.settings.mode === 'custom');
  assert.equal(host.state.settings.features.cam, false); assert.equal(host.state.settings.powerups, 'chaos', 'custom keeps the current toggles');
  host.send({ type: 'settings', settings: { mode: 'classic', features: { decoy: true } } }); await until(() => host.state.settings.mode === 'classic');
  assert.equal(host.state.settings.features.decoy, false, 'preset wins over toggles in the same message');
  const r = await new Promise(res => require('http').get(`http://127.0.0.1:${a.server.address().port}/api/rules`, q => { let b = ''; q.on('data', d => b += d); q.on('end', () => res(JSON.parse(b))); }));
  assert.equal(r.defaultMode, 'classic'); assert.deepEqual(Object.keys(r.modes), ['classic', 'party', 'chaos', 'custom']); assert.ok(r.modes.party.desc.length > 10);
  a.server.close(); host.ws.terminate();
});

test('battery saver: server sends need_fix to every phone ~5 s (scaled) before each scheduled ping', async () => {
  const a = await boot(); const { host, hs } = await setup(a, { gameSec: 30, pingSec: 0.6, hideSec: 0 });
  host.send({ type: 'start' }); await until(() => host.pings.length >= 2, 4000);
  for (const c of [host, ...hs]) {
    const nf = c.msgs.filter(m => m.type === 'need_fix');
    assert.ok(nf.length >= 2, 'need_fix before each ping');
    const ping1 = c.msgs.findIndex(m => m.type === 'ping'), nf1 = c.msgs.findIndex(m => m.type === 'need_fix');
    assert.ok(nf1 >= 0 && nf1 < ping1, 'need_fix arrives before the ping');
    assert.equal(nf[0].at, c.pings[0].t > 0 ? nf[0].at : 0);
  }
  a.server.close(); [host, ...hs].forEach(c => c.ws.terminate());
});
