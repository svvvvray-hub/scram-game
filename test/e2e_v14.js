// E2E v14: "Plan the next game" poll from the recap. Host creates (chips + custom time, field + past area + map pin),
// 3 voters in separate browser contexts (in-lobby player, new person via ?ref link, returning player with a saved name),
// live tally over WS, best combo glow, creator-only lock, .ics + Google Calendar + map links, 9:16 share card, XSS, admin polls.
// Real defaults + admin key + fresh stats file:
// ADMIN_KEY=e2e-admin-key STATS_FILE=/tmp/lp_e2e14.json PORT=3014 node server.js & node test/e2e_v14.js [URL]
const { chromium, devices } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://localhost:3014', KEY = process.env.ADMIN_KEY || 'e2e-admin-key';
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const LAT = 37.7596, LNG = -122.4269;
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe });
  const errs = [];
  const ctxFor = async (tz = 'America/Los_Angeles', init = {}) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], timezoneId: tz, locale: 'en-US', geolocation: { latitude: LAT, longitude: LNG, accuracy: 6 }, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(o => { localStorage.setItem('scramQuiet', '1'); for (const [k, v] of Object.entries(o)) if (localStorage.getItem(k) == null) localStorage.setItem(k, v);
      navigator.share = async d => { window.__shared = d; }; }, init);
    return ctx;
  };
  const page = async (ctx, name, url = URL + '/') => { const p = await ctx.newPage(); p.on('pageerror', e => errs.push(name + ': ' + e.message)); p.on('dialog', d => d.accept()); await p.goto(url); return p; };
  // ---- lobby: host (handle murray.hunts, one past play area) + Ana; a field; quick game -> recap
  const hostCtx = await ctxFor('America/Los_Angeles', { scramAreas: JSON.stringify([{ lat: 37.7694, lng: -122.4862, at: Date.now() - 864e5 }]) });
  const H = await page(hostCtx, 'host'); await H.waitForSelector('body[data-ready]');
  await H.fill('#name', 'Murray'); await H.fill('#ig', '@murray.hunts'); await H.check('#agree'); await H.click('#btnCreate'); await H.waitForSelector('#lobbyCode:not(:empty)');
  const lobby = (await H.textContent('#lobbyCode')).trim();
  const anaCtx = await ctxFor(); const A = await page(anaCtx, 'ana'); await A.waitForSelector('body[data-ready]');
  await A.fill('#name', 'Ana'); await A.check('#agree'); await A.fill('#code', lobby); await A.click('#btnJoin'); await A.waitForSelector('#lobbyCode:not(:empty)');
  await H.waitForFunction(() => S.players.length === 2);
  await H.evaluate(([lat, lng]) => sendMsg({ type: 'field', field: { circle: { lat, lng, r: 402 }, poly: null } }), [LAT, LNG]); await H.waitForFunction(() => !!S.field);
  await H.evaluate(() => sendMsg({ type: 'start', force: true })); await H.waitForFunction(() => S.state !== 'lobby', null, { timeout: 15000 });
  await sleep(7000); await H.evaluate(() => sendMsg({ type: 'end' }));
  await H.waitForSelector('#end:not(.hidden)', { timeout: 20000 }); await A.waitForSelector('#end:not(.hidden)', { timeout: 20000 });
  check(await H.isVisible('#btnPlan') && (await H.textContent('#btnPlan')).includes('Plan the next game'), 'host sees "📅 Plan the next game" on the recap');
  check(!(await A.isVisible('#btnPlan')), 'players do not (host-only by default)');
  check((await H.evaluate(() => JSON.parse(localStorage.getItem('scramAreas')).length)) === 2, 'this game\'s field center saved as a past play area (localStorage)');
  // ---- create
  await H.click('#btnPlan'); await H.waitForSelector('#planCreate');
  check(await H.isDisabled('#pCreate'), 'Create disabled until 2 times + 1 place');
  const chips = await H.$$eval('#pChips .chip', bs => bs.map(b => b.textContent));
  check(chips.length === 8 && chips.some(c => /^Sat 4pm/.test(c)) && chips.some(c => /^Sun 2pm/.test(c)), 'quick chips for this Sat/Sun: ' + chips.join(' | '));
  await H.click('#pChips .chip:has-text("Sat 4pm")'); await H.click('#pChips .chip:has-text("Sun 2pm")');
  const cust = await H.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7)); /* the Friday before this weekend's chips (was: next week's Friday on Fridays, which broke the sort order) */ d.setHours(19, 30, 0, 0); if (d < new Date()) { d.setDate(d.getDate() + 1); d.setHours(9, 30, 0, 0); } /* Friday evening: 7:30pm already gone -> Sat 9:30am, still before the Sat 4pm chip */ const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:30`; });
  await H.fill('#pCustom', cust); await H.click('#pAddTime');
  check((await H.$$('#pTimes .pick')).length === 3 && /(7:30pm|9:30am) PDT/.test(await H.textContent('#pTimes')), 'custom date-time added, shown with zone label: ' + (await H.textContent('#pTimes')).slice(0, 120));
  const sug = await H.$$eval('#pSuggest .chip', bs => bs.map(b => b.textContent));
  check(sug.includes("🟨 This game's field") && sug.some(s => /Past area/.test(s)), 'place suggestions: current field + past area: ' + sug.join(', '));
  await H.click('#pSuggest .chip:has-text("This game\'s field")');
  await H.fill('#pPlaces input[data-li="0"]', 'Dolores Park');
  const box = await H.locator('#pMap').boundingBox(); await H.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3); await H.waitForSelector('.planPin.pending');
  await H.fill('#pLabel', 'Mission Rec Center'); await H.click('#pAddPlace');
  check((await H.$$('#pPlaces .pick')).length === 2 && (await H.$$('#pMap .planPin')).length === 2, 'two places (field + map pin with label), pins on the mini map');
  await H.evaluate(() => document.querySelector('#planSheet').scrollTo(0, 0)); await sleep(800);
  await H.screenshot({ path: 'shots/v14_plan_create.png' });
  await H.click('#pCreate'); await H.waitForSelector('.pollView #pvTimes .opt');
  const code = await H.evaluate(() => document.querySelector('.pollView').dataset.code);
  check(/^[A-HJ-NP-Z2-9]{6}$/.test(code), 'poll created: /p/' + code);
  check(!!(await H.evaluate(c => JSON.parse(localStorage.getItem('scramPolls'))[c], code)), 'creator token kept in localStorage');
  await H.click('#pvShare'); await H.waitForFunction(() => window.__shared);
  const shared = await H.evaluate(() => window.__shared.text);
  check(shared === `Who's down for another round of Last Ping? Vote here: ${URL}/p/${code}?ref=murray.hunts`, 'share text + ?ref of the sharer: ' + shared);
  // Ana: lobby message -> "Vote on the next game"
  await A.waitForSelector('#btnPlanOpen:not(.hidden)', { timeout: 5000 }); check(true, 'players get "🗳 Vote on the next game" live on the recap');
  // ---- 3 voters in separate contexts
  await A.click('#btnPlanOpen'); await A.waitForSelector('.pollView #pvTimes .opt');
  check(await A.inputValue('#pvName') === 'Ana', 'name prefilled from the saved player name (Ana)');
  const benCtx = await ctxFor('Europe/London'); const B = await page(benCtx, 'ben', `${URL}/p/${code}?ref=murray.hunts`); await B.waitForSelector('#pvTimes .opt');
  check(await B.inputValue('#pvName') === '', 'new person: empty name (no sign-up)');
  const benT = await B.textContent('#pvTimes'); check(/GMT\+1|BST/.test(benT) && !/PDT/.test(benT), 'London viewer sees their local time + zone: ' + benT.slice(0, 60));
  check(await B.evaluate(() => localStorage.getItem('scramRef')) === 'murray.hunts', 'poll link ?ref saved for later referral stats');
  const cyCtx = await ctxFor('America/Los_Angeles', { scramName: 'Cy', scramIg: 'cy.runs', scramPlatform: 'tiktok' }); const C = await page(cyCtx, 'cy', `${URL}/p/${code}`); await C.waitForSelector('#pvTimes .opt');
  check(await C.inputValue('#pvName') === 'Cy' && await C.inputValue('#pvHandle') === '@cy.runs' && await C.inputValue('#pvPlat') === 'tiktok', 'returning player: name + handle prefilled');
  check(!(await B.isVisible('#pvLock')) && !(await C.isVisible('#pvLock')), 'no lock controls for non-creators');
  const opt = (P, k, i) => P.locator(`#pv${k === 't' ? 'Times' : 'Places'} .opt[data-i="${i}"]`);
  // times (sorted): 0 Fri 7:30pm, 1 Sat 4pm, 2 Sun 2pm ; places: 0 Dolores Park, 1 Mission Rec Center
  // Ana: Sat yes, Sun yes, Dolores yes
  await opt(A, 't', 1).click(); await opt(A, 't', 2).click(); await opt(A, 'p', 0).click();
  check(await opt(A, 't', 1).getAttribute('class') === 'opt y', 'tap = yes');
  await A.click('#pvSubmit'); await A.waitForFunction(() => window.lastPoll && window.lastPoll.voters.length === 1);
  await B.waitForFunction(() => window.lastPoll && window.lastPoll.voters.length === 1, null, { timeout: 5000 });
  check(/1 voter/.test(await B.textContent('#pvCount')) && /Ana/.test(await B.textContent('#pvGrid')), 'live update: Ben sees Ana\'s vote without reloading');
  // Ben: Sat yes, Sun maybe (long-press), Dolores yes, Mission maybe (second tap)
  await B.fill('#pvName', 'Ben');
  await opt(B, 't', 1).click();
  const bb = await opt(B, 't', 2).boundingBox(); await B.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await B.mouse.down(); await sleep(750); await B.mouse.up(); await sleep(100);
  check(await opt(B, 't', 2).getAttribute('class') === 'opt m', 'long-press = maybe');
  await opt(B, 'p', 0).click(); await opt(B, 'p', 1).click(); await opt(B, 'p', 1).click();
  check(await opt(B, 'p', 1).getAttribute('class') === 'opt m', 'second tap = maybe');
  await B.click('#pvSubmit'); await B.waitForFunction(() => window.lastPoll.voters.length === 2);
  // Cy: Fri yes, Sun yes, Mission yes, Dolores maybe
  await opt(C, 't', 0).click(); await opt(C, 't', 2).click(); await opt(C, 'p', 1).click(); await opt(C, 'p', 0).click(); await opt(C, 'p', 0).click();
  await C.click('#pvSubmit'); await C.waitForFunction(() => window.lastPoll.voters.length === 3);
  for (const [P, n] of [[H, 'host'], [A, 'Ana'], [B, 'Ben']]) await P.waitForFunction(() => window.lastPoll && window.lastPoll.voters.length === 3, null, { timeout: 5000 }).then(() => check(true, `live tally reached ${n} (3 voters)`), () => check(false, `live tally reached ${n}`));
  // best: Sat 4pm x Dolores: yes Ana, Ben = 2; Sun 2pm x Dolores: yes Ana, maybe Ben, Cy -> 1 yes. => Sat 4pm @ Dolores (1-0)
  const best = await B.evaluate(() => [...document.querySelectorAll('#pvCombo td.best')].map(td => td.dataset.combo));
  check(best.length === 1 && best[0] === '1-0', 'best combination glows: ' + best.join(','));
  check(/Best so far: Sat 4pm at Dolores Park/.test(await C.textContent('#pvBest')), 'best line (LA viewer): ' + (await C.textContent('#pvBest')).trim());
  const who = await C.textContent('#pvWho'); check(['Ana', 'Ben', 'Cy'].every(n => who.includes(n)), 'shows who voted: ' + who.trim());
  check(/@cy\.runs/.test(await A.textContent('#pvGrid')), 'optional handle shown in the grid');
  // re-vote: Ana updates her vote (no duplicate)
  await opt(A, 't', 0).click(); await A.click('#pvSubmit'); await sleep(400);
  check((await A.evaluate(() => window.lastPoll.voters.length)) === 3, 're-voting updates instead of adding a voter');
  // XSS: hostile name via the API
  const xs = await B.evaluate(async c => (await fetch(`/api/polls/${c}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: 'xss-voter-0001', name: '<img src=x onerror=window.__x=1>', t: [0, 0, 0], p: [0, 0] }) })).status, code);
  await C.waitForFunction(() => window.lastPoll.voters.length === 4);
  check(xs === 200 && !(await C.$('#pvGrid img, #pvWho img')) && (await C.evaluate(() => window.__x)) === undefined && (await C.textContent('#pvWho')).includes('<img src=x'), 'hostile names render as text (escaped), no script ran');
  await B.evaluate(() => document.getElementById('pvBest').scrollIntoView({ block: 'start' })); await sleep(300);
  // vote screenshot: an LA viewer mid-vote (tally + glow)
  await C.evaluate(() => document.getElementById('pvPlaces').scrollIntoView({ block: 'start' })); await sleep(500);
  await C.screenshot({ path: 'shots/v14_plan_vote.png' });
  // ---- lock (creator only)
  const forged = await B.evaluate(async c => (await fetch(`/api/polls/${c}/lock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'guess', time: 0, place: 0 }) })).status, code);
  check(forged === 403, 'lock without the creator token is rejected');
  await H.waitForSelector('#pvLock:not(.hidden)'); check(await H.inputValue('#pvLockT') === '1' && await H.inputValue('#pvLockP') === '0', 'lock defaults to the best combination');
  await H.click('#pvLockBtn');
  for (const [P, n] of [[H, 'host'], [A, 'Ana'], [B, 'Ben'], [C, 'Cy']]) await P.waitForSelector('#pvNext', { timeout: 5000 }).then(() => check(true, `${n} sees the locked plan live`), () => check(false, `${n} sees the locked plan`));
  const next = (await C.textContent('#pvNext .nextLine')).trim();
  check(next === 'Next Last Ping: Sat 4pm at Dolores Park', 'headline: ' + next);
  check(/Sat 5pm at Dolores Park/.test(await B.textContent('#pvNext .nextLine')) === false && /Sun 12am|Sun 12/.test(await B.textContent('#pvNext .nextLine')), 'London viewer sees it in their zone: ' + (await B.textContent('#pvNext .nextLine')).trim());
  check(await C.isHidden('#pvVote'), 'voting closed once locked');
  const icsHref = await C.getAttribute('#pvIcs', 'href'); const ics = await C.evaluate(async h => { const r = await fetch(h); return { ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition'), body: await r.text() }; }, icsHref);
  const satUtc = await C.evaluate(() => window.lastPoll.times[1]); const z = new Date(satUtc).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  check(/text\/calendar/.test(ics.ct) && /attachment/.test(ics.cd) && ics.body.includes('DTSTART:' + z) && /LOCATION:Dolores Park/.test(ics.body) && ics.body.includes('BEGIN:VEVENT') && ics.body.includes('\r\n'), '.ics download: ' + z + ' at Dolores Park');
  const gcal = await C.getAttribute('#pvGcal', 'href'); check(gcal.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE') && gcal.includes('dates=' + z) && /location=Dolores\+Park/.test(gcal), 'Google Calendar template link');
  check((await C.getAttribute('#pvMapLink', 'href')) === `https://www.google.com/maps/search/?api=1&query=${LAT},${LNG}`, 'map link');
  await C.evaluate(() => window.scrollTo(0, 0)); await sleep(400);
  await C.screenshot({ path: 'shots/v14_plan_locked.png' });
  // ---- 9:16 card
  await C.click('#pvNext [data-card]'); await C.waitForSelector('#planCardImg', { timeout: 8000 });
  const dims = await C.evaluate(() => new Promise(r => { const im = document.getElementById('planCardImg'); const f = () => r([im.naturalWidth, im.naturalHeight]); im.complete ? f() : im.onload = f; }));
  check(dims[0] === 1080 && dims[1] === 1920, 'share card is 9:16 (1080x1920)');
  const qrDark = await C.evaluate(() => new Promise(r => { const im = document.getElementById('planCardImg'), c = document.createElement('canvas'); c.width = 1080; c.height = 1920; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const y0 = 1050, d = x.getImageData(300, y0, 480, 480).data; let dark = 0, light = 0; for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; if (v < 150) dark++; else if (v > 600) light++; } r({ dark, light }); }));
  check(qrDark.dark > 20000 && qrDark.light > 20000, 'QR code drawn on the card (dark/light modules): ' + JSON.stringify(qrDark));
  await sleep(300); await C.screenshot({ path: 'shots/v14_next_card.png' });
  // ---- admin + referral
  const adm = await browser.newContext(); const AD = await adm.newPage(); await AD.goto(`${URL}/admin?key=${KEY}`);
  const sj = await AD.evaluate(async () => (await fetch('/admin/stats.json')).json());
  check(sj.polls && sj.polls.active >= 1 && sj.polls.recent.some(p => p.code === code && p.voters === 4 && p.locked), 'admin: polls count + recent poll with 4 voters, locked');
  check(sj.refs.some(r => r.ref === 'murray.hunts' && r.visits >= 1), 'referral visit counted for the poll link');
  await AD.waitForSelector('#polls'); check(/Next-game polls/.test(await AD.textContent('#polls')) && !(await AD.$('#polls img')), 'admin polls section renders (escaped)');
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
