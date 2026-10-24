// E2E v18: post-round Regroup. Murray creates (stays at the park), Ana (200 m) and Ben (300 m) play a quick round.
// After the end: Meet-here pin + distance + directions, Ana in (walks closer), Ben done -> feedback -> host sees it live,
// Ben opts in to "Ping me", host panel (waiting count, trend, closed flag), Start next round -> same room with Ana only.
// Real defaults: ADMIN_KEY=e2e-admin-key PORT=3018 node server.js & node test/e2e_v18.js [URL]
const { chromium, devices } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://localhost:3018', KEY = process.env.ADMIN_KEY || 'e2e-admin-key';
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const LAT = 37.7596, LNG = -122.4269, M = 1 / 111320;
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe });
  const errs = [];
  const join = async (name, dm, code) => { const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-US', geolocation: { latitude: LAT + dm * M, longitude: LNG, accuracy: 5 }, permissions: ['geolocation'] });
    await ctx.addInitScript(() => { localStorage.setItem('scramQuiet', '1'); const ws = window.WebSocket; window.__msgs = []; window.WebSocket = function (...a) { const s = new ws(...a); s.addEventListener('message', e => { try { window.__msgs.push(JSON.parse(e.data)); } catch {} }); return s; }; window.WebSocket.prototype = ws.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }); });
    const p = await ctx.newPage(); p.ctx = ctx; p.on('pageerror', e => errs.push(name + ': ' + e.message)); p.on('dialog', d => d.accept());
    await p.goto(URL + '/'); await p.waitForSelector('body[data-ready]'); await p.fill('#name', name); await p.check('#agree');
    if (code) { await p.fill('#code', code); await p.click('#btnJoin'); } else await p.click('#btnCreate');
    await p.waitForSelector('#lobbyCode:not(:empty)'); return p; };
  const go = async (p, dm) => { await p.ctx.setGeolocation({ latitude: LAT + dm * M, longitude: LNG, accuracy: 5 }); await p.evaluate(() => typeof freshFix === 'function' && freshFix()); };
  const H = await join('Murray', 0); const code = (await H.textContent('#lobbyCode')).trim();
  const A = await join('Ana', 200, code), B = await join('Ben', 300, code);
  await H.waitForFunction(() => S.players.length === 3);
  await H.evaluate(() => sendMsg({ type: 'settings', settings: { hideSec: 0 } })); await H.waitForFunction(() => S.settings.hideSec === 0);
  await H.evaluate(() => sendMsg({ type: 'role', id: S.you, role: 'hunter' })); await sleep(200);
  await H.evaluate(() => sendMsg({ type: 'start', force: true })); await A.waitForFunction(() => S.state === 'playing', null, { timeout: 15000 });
  await sleep(2500);
  check(!(await A.evaluate(() => window.__msgs.some(m => m.type === 'regroup'))), 'no regroup data during the game');
  await H.evaluate(() => sendMsg({ type: 'end' }));
  for (const p of [H, A, B]) await p.waitForSelector('#end:not(.hidden) #regroup:not(.hidden)', { timeout: 20000 });
  check(await A.isVisible('#recap') || await A.isVisible('#winner'), 'recap still there (regroup added, not replacing it)');
  await A.waitForFunction(() => /You’re \d+ m away/.test(document.getElementById('rgDist').textContent));
  const dist = await A.textContent('#rgDist'); check(/You’re (19\d|20\d) m away/.test(dist), 'player sees own distance to the creator: ' + dist);
  check(/Murray/.test(await A.textContent('#rgAnchor')) && await A.isVisible('.rgPin'), '"Meet here" pin at the room creator');
  const href = await A.getAttribute('#rgDirections', 'href'); check(/destination=37\.7596/.test(href), 'Head back to host -> maps directions: ' + href.slice(0, 70));
  await A.evaluate(() => document.getElementById('regroup').scrollIntoView()); await sleep(700);
  await A.screenshot({ path: 'shots/v18_player_regroup.png' });
  // choices
  await A.click('#rgIn'); await B.click('#rgDone');
  await B.waitForSelector('#rgFeedback:not(.hidden)');
  await B.click('#rgStars [data-r="4"]'); await B.fill('#rgLiked', 'The chime when hunters got close <3'); await B.fill('#rgImprove', 'Longer hide time, because we needed more time to reach the good spots');
  await B.evaluate(() => document.getElementById('rgFeedback').scrollIntoView({ block: 'center' })); await sleep(300);
  await B.screenshot({ path: 'shots/v18_feedback.png' });
  await B.click('#rgSend'); await B.waitForSelector('#rgThanks:not(.hidden)'); check(true, 'Done -> optional feedback form -> thank-you');
  await H.waitForFunction(() => window.__msgs.some(m => m.type === 'feedbackIn'));
  // ping me (reuses the platform picker)
  await B.click('#rgNotify summary'); check((await B.$$eval('#rgNPlatform option', o => o.length)) >= 5, 'Ping-me reuses the platform picker');
  await B.selectOption('#rgNPlatform', 'tiktok'); await B.fill('#rgNHandle', '@ben.runs'); await B.click('#rgNSave');
  await B.waitForFunction(() => /on the list/.test(document.getElementById('rgNMsg').textContent));
  await B.evaluate(() => document.getElementById('rgNotify').scrollIntoView({ block: 'center' })); await sleep(300);
  await B.screenshot({ path: 'shots/v18_ping_me.png' }); check(true, '"Ping me for the next game" saved');
  // Ana walks back
  for (const d of [170, 140, 110, 80]) { await go(A, d); await sleep(1600); }
  await H.waitForFunction(() => /getting closer/.test(document.querySelector('#rgList').textContent), null, { timeout: 15000 });
  check(true, 'host sees Ana "getting closer"');
  check(/Waiting on 0 of 2|Everyone answered/.test(await H.textContent('#rgWaiting')), 'host count: ' + await H.textContent('#rgWaiting'));
  check(/Longer hide time/.test(await H.textContent('#rgFbList')), 'feedback relayed live to the host');
  await B.close(); await H.waitForFunction(() => /closed the browser|connection dropped/.test(document.querySelector('#rgList').textContent), null, { timeout: 15000 });
  check(true, 'host sees Ben closed the browser / dropped');
  await H.evaluate(() => document.getElementById('regroup').scrollIntoView()); await sleep(500);
  await H.screenshot({ path: 'shots/v18_host_panel.png', fullPage: false });
  // admin
  const auth = await fetch(URL + '/admin?key=' + KEY, { redirect: 'manual' }); const ck = auth.headers.get('set-cookie').split(';')[0];
  const adm = await (await fetch(URL + '/admin', { headers: { cookie: ck } })).text();
  check(/Longer hide time/.test(adm) && /ben\.runs/.test(adm), '/admin lists feedback and ping-me contacts');
  check(/ben\.runs/.test(await (await fetch(URL + '/admin/notify.csv', { headers: { cookie: ck } })).text()), 'ping-me CSV');
  // next round
  await H.click('#rgNext'); await A.waitForSelector('#lobby:not(.hidden)', { timeout: 10000 });
  const ids = await H.evaluate(() => S.players.map(p => p.name).sort().join()); check(ids === 'Ana,Murray' && (await A.textContent('#lobbyCode')).trim() === code, 'next round: same room, only players who are in: ' + ids);
  const pub = await (await fetch(URL + '/privacy')).text(); check(/Regroup/.test(pub) && /Ping me for the next game/.test(pub) && /Post-round feedback/.test(pub), 'privacy policy mentions regroup, feedback, ping-me');
  check(errs.length === 0, 'no page errors ' + errs.join(' | '));
  await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
