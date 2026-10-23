'use strict';
// v14 "Plan the next game" polls: create / validate / limits / vote / best combo / lock / .ics / expiry / persistence / XSS / WS live update.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const WebSocket = require('ws');
const { createApp } = require('../server');
const { createStats } = require('../stats');
const { createPolls, ics, LIMITS } = require('../polls');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const H = 3600e3, D = 864e5;
const T0 = Date.UTC(2026, 9, 22, 20, 0); // Thu Oct 22 2026 13:00 PDT
async function boot(extra = {}, env = {}) {
  const clock = { t: T0 };
  const a = createApp({ tickMs: 50, quiet: true, statsFile: null, now: () => clock.t, env: { ADMIN_KEY: 'k-123', ...env }, ...extra });
  await new Promise(r => a.server.listen(0, r));
  a.clock = clock; a.base = `http://127.0.0.1:${a.server.address().port}`; a.wsUrl = a.base.replace('http', 'ws') + '/ws';
  return a;
}
const post = (a, p, body) => fetch(a.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sat4 = Date.UTC(2026, 9, 24, 23, 0), sun2 = Date.UTC(2026, 9, 25, 21, 0), sat6 = Date.UTC(2026, 9, 25, 1, 0);
const goodPoll = (o = {}) => ({ times: [sat4, sun2, sat6], places: [{ lat: 37.7596, lng: -122.4269, label: 'Dolores Park' }, { lat: 37.7694, lng: -122.4862, label: 'GG Park' }], name: 'Murray', ...o });
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };

test('unit: create validates times (2-8, future, sorted, deduped), places (1-3, ranges), labels/names trimmed + capped', () => {
  const st = createStats({ file: null, now: () => T0 }), P = createPolls({ stats: st, now: () => T0 });
  const r = P.create(goodPoll({ name: '  Murray   the   Great hunter of things  ', times: [sun2, sat4, sat4 + 10e3, sat6] }));
  assert.match(r.code, /^[A-HJ-NP-Z2-9]{6}$/); assert.ok(r.token.length >= 20);
  assert.deepStrictEqual(r.poll.times, [sat4, sat6, sun2], 'sorted, deduped to the minute');
  assert.strictEqual(r.poll.by.length, 20); assert.strictEqual(r.poll.expiresAt, sun2 + 14 * D);
  assert.ok(!('tok' in r.poll) && !JSON.stringify(r.poll).includes(r.token), 'creator token never in the public view');
  const bad = [[{ times: [sat4] }, /2-8 times/], [{ times: Array.from({ length: 9 }, (_, i) => sat4 + i * H) }, /2-8 times/], [{ times: [T0 - 2 * H, sat4] }, /future/],
    [{ times: [sat4, T0 + 200 * D] }, /180 days/], [{ times: [sat4, 'nope'] }, /Invalid time/], [{ times: 'x' }, /2-8 times/],
    [{ places: [] }, /1-3 places/], [{ places: [1, 2, 3, 4].map(() => ({ lat: 1, lng: 1 })) }, /1-3 places/], [{ places: [{ lat: 91, lng: 0 }] }, /Invalid place/], [{ places: [{ lat: 'a', lng: 0 }] }, /Invalid place/]];
  for (const [o, re] of bad) assert.throws(() => P.create(goodPoll(o)), re, JSON.stringify(o).slice(0, 60));
  const lab = P.create(goodPoll({ places: [{ lat: 1, lng: 2, label: 'x'.repeat(100) + '\u202e\n' }] })).poll.places[0].label;
  assert.strictEqual(lab.length, 40);
  assert.ok(Object.keys(st.data().polls).length === 2 && st.data().pollTotals.created === 2, 'stored in the stats JSON');
});

test('unit: votes (yes/maybe), re-vote replaces, 30-voter cap, best combo = most yes, then maybe, then earliest', () => {
  const st = createStats({ file: null, now: () => T0 }), P = createPolls({ stats: st, now: () => T0 });
  const { code } = P.create(goodPoll()); // times sorted: sat4(0) sat6(1) sun2(2); places: Dolores(0) GG(1)
  let v = P.view(code); assert.deepStrictEqual([v.best.time, v.best.place, v.best.yes], [0, 0, 0], 'no votes: earliest + first place');
  P.vote(code, { voter: 'voter-aaaa1', name: 'Ann', t: [0, 2, 2], p: [2, 0] });
  P.vote(code, { voter: 'voter-bbbb1', name: 'Bo', t: [0, 2, 1], p: [2, 2] });
  v = P.vote(code, { voter: 'voter-cccc1', name: 'Cy', social: { handle: '@cy.runs', platform: 'tiktok' }, t: [1, 1, 2], p: [2, 1] });
  // sat6/Dolores: yes Ann, Bo = 2; maybe Cy = 1.  sun2/Dolores: yes Ann, Cy = 2; maybe Bo = 1 -> tie on yes+maybe, earliest (sat6) wins
  assert.deepStrictEqual([v.best.time, v.best.place, v.best.yes, v.best.maybe], [1, 0, 2, 1]);
  assert.deepStrictEqual(v.combos[2][0], { yes: 2, maybe: 1 });
  assert.deepStrictEqual(v.timeTally[2], { yes: 2, maybe: 1 }); assert.deepStrictEqual(v.placeTally[1], { yes: 1, maybe: 1 });
  assert.deepStrictEqual(v.voters.map(x => x.name), ['Ann', 'Bo', 'Cy']); assert.deepStrictEqual(v.voters[2].social, { handle: 'cy.runs', platform: 'tiktok' });
  assert.ok(!JSON.stringify(v).includes('voter-'), 'voter ids are not exposed');
  // Bo changes to a firm yes on sun2 -> sun2/Dolores has 3 yes and wins
  v = P.vote(code, { voter: 'voter-bbbb1', name: 'Bo', t: [0, 2, 2], p: [2, 2] });
  assert.strictEqual(v.voters.length, 3, 're-vote replaces'); assert.deepStrictEqual([v.best.time, v.best.place, v.best.yes], [2, 0, 3]);
  assert.deepStrictEqual(P.mine(code, 'voter-bbbb1').t, [0, 2, 2]);
  assert.throws(() => P.vote(code, { voter: 'voter-dddd1', name: '   ', t: [2, 0, 0], p: [2, 0] }), /name/);
  assert.throws(() => P.vote(code, { voter: 'x', name: 'Z', t: [2], p: [2] }), /voter/);
  for (let i = 3; i < LIMITS.maxVoters; i++) P.vote(code, { voter: 'voter-fill-' + i, name: 'V' + i, t: [2, 0, 0], p: [0, 2] });
  assert.strictEqual(P.view(code).voters.length, 30);
  assert.throws(() => P.vote(code, { voter: 'voter-31st-one', name: 'Late', t: [2, 0, 0], p: [2, 0] }), e => e.status === 409 && /30 voters/.test(e.message));
  assert.doesNotThrow(() => P.vote(code, { voter: 'voter-aaaa1', name: 'Ann', t: [2, 2, 2], p: [2, 2] }), 'existing voters can still update at the cap');
});

test('unit: lock is creator-only, .ics content (UTC, escaped, folded, CRLF), voting closed after lock', () => {
  const st = createStats({ file: null, now: () => T0 }), P = createPolls({ stats: st, now: () => T0 });
  const { code, token } = P.create(goodPoll({ name: 'Murray', places: [{ lat: 37.7596, lng: -122.4269, label: 'Dolores; north, by "tennis" court\\' }] }));
  assert.throws(() => P.lock(code, { token: 'nope', time: 0, place: 0 }), e => e.status === 403);
  assert.throws(() => P.lock(code, { token, time: 7, place: 0 }), /Pick a time/);
  const v = P.lock(code, { token, time: 0, place: 0 }); assert.deepStrictEqual([v.locked.time, v.locked.place], [0, 0]);
  assert.throws(() => P.vote(code, { voter: 'voter-aaaa1', name: 'Ann', t: [2, 2, 2], p: [2] }), /locked/);
  const body = ics(P.get(code), { url: 'https://lastping.example/p/' + code, now: T0 });
  assert.ok(body.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && body.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(body), 'CRLF line endings only');
  assert.match(body, /\r\nDTSTART:20261024T230000Z\r\n/); assert.match(body, /\r\nDTEND:20261025T000000Z\r\n/); assert.match(body, /\r\nDTSTAMP:20261022T200000Z\r\n/);
  assert.match(body, /\r\nUID:[A-Z0-9]{6}-\d+@lastping\r\n/); assert.match(body, /\r\nGEO:37\.7596;-122\.4269\r\n/);
  const unfolded = body.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('LOCATION:Dolores\\; north\\, by "tennis" court\\\\\r\n'), 'text escaped per RFC 5545');
  assert.ok(unfolded.includes('planned by Murray') && unfolded.includes('\\nPoll: https://lastping.example/p/' + code));
  for (const l of body.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, 'folded at 75 octets: ' + l);
  assert.strictEqual(ics({ ...P.get(code), locked: null }), null);
  const u = P.lock(code, { token, unlock: true }); assert.strictEqual(u.locked, null, 'creator can reopen voting');
});

test('unit: expiry 14 days after the latest option, 200 active polls cap, per-IP rate limit', () => {
  const clock = { t: T0 }, st = createStats({ file: null, now: () => clock.t }), P = createPolls({ stats: st, now: () => clock.t, limits: { perIpHour: 1000 } });
  const { code } = P.create(goodPoll());
  clock.t = sun2 + 14 * D - 1000; assert.ok(P.view(code), 'alive just before expiry');
  clock.t = sun2 + 14 * D + 1; assert.strictEqual(P.view(code), null, 'gone after 14 days'); assert.strictEqual(st.data().polls[code], undefined, 'deleted from the stats file data');
  clock.t = T0;
  for (let i = 0; i < 200; i++) P.create(goodPoll());
  assert.strictEqual(P.activeCount(), 200);
  assert.throws(() => P.create(goodPoll()), e => e.status === 503 && /Too many active polls/.test(e.message));
  clock.t = sun2 + 15 * D; // all expire -> room again
  assert.doesNotThrow(() => P.create(goodPoll({ times: [clock.t + D, clock.t + 2 * D] })));
  const P2 = createPolls({ stats: createStats({ file: null, now: () => T0 }), now: () => T0, limits: { perIpHour: 2 } });
  P2.create(goodPoll(), { ip: '1.2.3.4' }); P2.create(goodPoll(), { ip: '1.2.3.4' });
  assert.throws(() => P2.create(goodPoll(), { ip: '1.2.3.4' }), e => e.status === 429);
  assert.doesNotThrow(() => P2.create(goodPoll(), { ip: '5.6.7.8' }));
});

test('unit: polls persist in STATS_FILE and survive a reload', async () => {
  const f = path.join(os.tmpdir(), `lp_plan_${process.pid}.json`); try { fs.unlinkSync(f); } catch {}
  const s1 = createStats({ file: f, now: () => T0, throttleMs: 10 }), P1 = createPolls({ stats: s1, now: () => T0 });
  const { code, token } = P1.create(goodPoll()); P1.vote(code, { voter: 'voter-aaaa1', name: 'Ann', t: [2, 0, 0], p: [2, 0] }); s1.flush();
  const s2 = createStats({ file: f, now: () => T0 }), P2 = createPolls({ stats: s2, now: () => T0 });
  assert.strictEqual(P2.view(code).voters[0].name, 'Ann'); assert.ok(P2.isCreator(code, token)); assert.ok(!fs.readFileSync(f, 'utf8').includes(token), 'only a hash of the token is stored');
  fs.unlinkSync(f);
});

test('http: /p/CODE serves the poll page (lobby codes still redirect), API create/vote/lock/ics, XSS stays escaped, admin polls section', async () => {
  const a = await boot({}, { PLAY_REDIRECT_URL: 'https://lastping.example/' });
  try {
    let r = await post(a, '/api/polls', goodPoll({ name: '<img src=x onerror=alert(1)>', places: [{ lat: 37.76, lng: -122.42, label: '<script>alert(1)</script>' }] }));
    assert.strictEqual(r.status, 201); const { code, token } = await r.json();
    r = await fetch(a.base + '/p/' + code.toLowerCase(), { redirect: 'manual' }); assert.strictEqual(r.status, 200, 'served, not redirected, even with PLAY_REDIRECT_URL');
    const html = await r.text(); assert.match(html, /plan\.js/); assert.match(html, /\/vendor\/leaflet\.js/);
    r = await fetch(a.base + '/p/ABCDE', { redirect: 'manual' }); assert.strictEqual(r.status, 302); assert.match(r.headers.get('location'), /lastping\.example\/\?code=ABCDE/);
    r = await fetch(a.base + '/p/ZZZZZZ'); assert.strictEqual(r.status, 200, 'unknown poll code: page renders its own "not found"');
    assert.strictEqual((await fetch(a.base + '/api/polls/ZZZZZZ')).status, 404);
    r = await post(a, `/api/polls/${code}/vote`, { voter: 'voter-xss-0001', name: '"><svg onload=alert(2)>', t: [2, 0, 0], p: [2] }); assert.strictEqual(r.status, 200);
    r = await post(a, `/api/polls/${code}/vote`, { voter: 'voter-x', name: 'A', t: [2], p: [2] }); assert.strictEqual(r.status, 400);
    r = await post(a, `/api/polls/${code}/vote`, { voter: 'voter-big-0001', name: 'B', t: [2, 0, 0], p: [2], pad: 'x'.repeat(9000) }); assert.strictEqual(r.status, 413, 'body size limit');
    const j = await (await fetch(`${a.base}/api/polls/${code}?v=voter-xss-0001`)).json();
    assert.strictEqual(j.mine.name, '"><svg onload=alert(2)>'.slice(0, 20), 'stored as typed (capped), escaped only on output'); assert.strictEqual(j.voters.length, 1);
    assert.strictEqual((await fetch(`${a.base}/api/polls/${code}/ics`)).status, 409, 'no .ics before lock');
    assert.strictEqual((await post(a, `/api/polls/${code}/lock`, { token: 'bad', time: 0, place: 0 })).status, 403);
    assert.strictEqual((await post(a, `/api/polls/${code}/lock`, { token, time: 1, place: 0 })).status, 200);
    r = await fetch(`${a.base}/api/polls/${code}/ics`); assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-type'), /text\/calendar/);
    assert.match(r.headers.get('content-disposition'), new RegExp(`attachment; filename="last-ping-${code}.ics"`));
    const icsBody = await r.text(); assert.match(icsBody, /DTSTART:20261025T010000Z/); assert.match(icsBody.replace(/\r\n /g, ''), new RegExp(`URL:http://127\\.0\\.0\\.1:\\d+/p/${code}`));
    // admin: polls section, count + voters, every user string escaped
    r = await fetch(a.base + '/admin?key=k-123', { redirect: 'manual' }); const ck = r.headers.get('set-cookie').split(';')[0];
    const adm = await (await fetch(a.base + '/admin', { headers: { cookie: ck } })).text();
    assert.match(adm, /Next-game polls/); assert.match(adm, /id="pollActive">1</); assert.match(adm, /id="pollVoters">1</);
    assert.ok(adm.includes(`data-poll="${code}"`) && adm.includes('🔒 locked'));
    assert.ok(!adm.includes('<img src=x') && adm.includes('&lt;img src=x onerror=a'), 'creator name escaped on /admin');
    const sj = await (await fetch(a.base + '/admin/stats.json', { headers: { cookie: ck } })).json(); assert.strictEqual(sj.polls.active, 1); assert.strictEqual(sj.polls.voters, 1);
    // QR for the poll (reuses the lobby QR generator)
    r = await fetch(`${a.base}/qr/${code}.svg`); assert.match(await r.text(), /<svg/);
    // ?ref on the poll link counts as a referral visit
    await fetch(`${a.base}/p/${code}?ref=Murray.Hunts`); assert.strictEqual(a.stats.data().refs['murray.hunts'].visits, 1);
  } finally { a.server.close(); }
});

test('ws: pollSub gets live updates on vote/lock; lobby "plan" message reaches every player (host-only by default)', async () => {
  const a = await boot();
  try {
    const { code, token } = await (await post(a, '/api/polls', goodPoll())).json();
    const sub = new WebSocket(a.wsUrl), got = []; sub.on('message', d => got.push(JSON.parse(d))); await new Promise(r => sub.on('open', r));
    sub.send(JSON.stringify({ type: 'pollSub', code })); await until(() => got.length === 1); assert.strictEqual(got[0].poll.code, code);
    await post(a, `/api/polls/${code}/vote`, { voter: 'voter-live-001', name: 'Live', t: [2, 2, 0], p: [2, 0] });
    await until(() => got.length === 2); assert.strictEqual(got[1].poll.voters[0].name, 'Live');
    await post(a, `/api/polls/${code}/lock`, { token, time: 0, place: 0 }); await until(() => got.length === 3); assert.deepStrictEqual(got[2].poll.locked.time, 0);
    sub.send(JSON.stringify({ type: 'pollSub', code: 'QQQQQQ' })); await until(() => got.length === 4); assert.ok(got[3].gone);
    sub.close();
    // lobby integration
    const mk = () => { const ws = new WebSocket(a.wsUrl), c = { ws, msgs: [] }; ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'joined') c.joined = m; }); c.open = new Promise(r => ws.on('open', r)); c.send = m => ws.send(JSON.stringify(m)); return c; };
    const h = mk(); await h.open; h.send({ type: 'create', agreed: true, name: 'Host' }); await until(() => h.joined);
    const p = mk(); await p.open; p.send({ type: 'join', agreed: true, name: 'Pat', code: h.joined.code }); await until(() => p.joined);
    p.send({ type: 'plan', code }); await sleep(150); assert.ok(!h.msgs.some(m => m.type === 'plan'), 'non-host cannot attach a poll by default');
    h.send({ type: 'plan', code: 'NOPE22' }); await sleep(100); assert.ok(!p.msgs.some(m => m.type === 'plan'), 'unknown poll ignored');
    h.send({ type: 'plan', code }); await until(() => p.msgs.some(m => m.type === 'plan'));
    assert.deepStrictEqual(p.msgs.find(m => m.type === 'plan'), { type: 'plan', code, by: 'Host' });
    const late = mk(); await late.open; late.send({ type: 'join', agreed: true, name: 'Late', code: h.joined.code }); await until(() => late.msgs.some(m => m.type === 'plan'));
    h.ws.close(); p.ws.close(); late.ws.close();
  } finally { a.server.close(); }
});

test('/api/rules exposes planAnyone (PLAN_ANYONE=1 lets any player propose); config.js unchanged', async () => {
  const a = await boot({}, { PLAN_ANYONE: '1' });
  try { assert.strictEqual((await (await fetch(a.base + '/api/rules')).json()).planAnyone, true); assert.match(await (await fetch(a.base + '/config.js')).text(), /^window\.CREATOR=\{.*\};$/); } finally { a.server.close(); }
  const b = await boot();
  try { assert.strictEqual((await (await fetch(b.base + '/api/rules')).json()).planAnyone, false); } finally { b.server.close(); }
});
