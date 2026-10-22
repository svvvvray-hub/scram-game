// E2E v9 (Pixel 7): game modes (Classic default), invite QR/share, role card, bottom action bar, ping ripple + haptic + ring,
// coach tips (one-time, localStorage, reset), SVG markers + dark basemap, battery saver (need_fix, saver pill, paused render), reduced motion.
// Needs a server with the REAL defaults (no SCRAM_DEFAULT_MODE).  Usage: node test/e2e_v9.js [URL]   (default http://localhost:3002)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const QRCode = require('qrcode');
const URL = process.argv[2] || 'http://localhost:3002';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe });
  const errs = [];
  const mk = async (name, geo, url = URL) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: { ...geo, accuracy: 6 }, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(() => { window._vib = []; navigator.vibrate = p => { window._vib.push(p); return true; }; window._share = null; navigator.share = d => { window._share = d; return Promise.resolve(); }; });
    const page = await ctx.newPage(), frames = [];
    page.on('pageerror', e => { errs.push(name + ': ' + e.message); console.log(name, 'PAGEERR', e.message); });
    page.on('websocket', w => w.on('framereceived', f => { try { frames.push(JSON.parse(f.payload)); } catch {} }));
    page.on('dialog', d => d.accept()); const sent = [];
    page.on('websocket', w => w.on('framesent', f => { try { const m = JSON.parse(f.payload); if (m.type === 'loc') sent.push(Date.now()); } catch {} }));
    page.on('websocket', w => w.on('framereceived', f => { try { if (JSON.parse(f.payload).type === 'need_fix') frames.nfAt = frames.nfAt || Date.now(); } catch {} }));
    await page.goto(url); await page.waitForSelector('body[data-ready]'); await page.fill('#name', name); await page.check('#agree');
    return { name, ctx, page, frames, sent };
  };
  const murray = await mk('Murray', { latitude: 51.5079, longitude: -0.0877 });
  await murray.page.click('#btnCreate'); await murray.page.waitForSelector('#lobbyCode:not(:empty)');
  const code = (await murray.page.textContent('#lobbyCode')).trim(), M = murray.page;
  // ---- invites: QR encodes /p/<code>; scanning (opening it) prefills the join screen
  const svg = await (await fetch(`${URL}/qr/${code}.svg`)).text();
  check(svg === await QRCode.toString(`${URL.replace('localhost', 'localhost')}/p/${code}`, { type: 'svg', margin: 1 }), 'QR encodes the join URL /p/' + code);
  check(await M.evaluate(() => document.getElementById('qr').complete && document.getElementById('qr').naturalWidth > 0), 'QR image rendered in the lobby');
  const ana = await mk('Ana', { latitude: 51.5100, longitude: -0.0840 }, `${URL}/p/${code}`);
  check(await ana.page.inputValue('#code') === code && /Join game/.test(await ana.page.textContent('#btnJoin')), 'opening the QR link prefills the join code');
  await ana.page.click('#btnJoin'); await ana.page.waitForSelector('#lobbyCode:not(:empty)');
  const bo = await mk('Bo', { latitude: 51.5104, longitude: -0.0846 }, `${URL}/p/${code}`);
  await bo.page.click('#btnJoin'); await bo.page.waitForSelector('#lobbyCode:not(:empty)');
  await M.waitForFunction(() => S.players.length === 3 && S.players.every(p => p.perm === 'granted'), null, { timeout: 20000 });
  await M.click('#btnShare'); await sleep(200);
  const sh = await M.evaluate(() => window._share);
  check(sh && sh.url.endsWith('/p/' + code) && sh.text.includes(code), 'Share invite uses navigator.share with /p/<code>');
  await M.click('#lobbyCode'); await sleep(200);
  check(await M.evaluate(() => navigator.clipboard.readText()) === code, 'tapping the big code copies it');
  check(/Players 3\/20/.test(await M.textContent('#roleCounts')), 'Players 3/20 shown');
  // ---- modes: Classic by default, one-line description, Custom reveals the toggles
  check(await M.evaluate(() => S.settings.mode) === 'classic' && await M.isVisible('[data-mode="classic"].on') && /Pure hide & seek/.test(await M.textContent('#modeDesc')), 'new lobby defaults to Classic with a description');
  check(!(await M.isVisible('#features')) && !(await M.isVisible('#sPower')), 'Classic hides the individual toggles');
  await M.click('[data-mode="custom"]'); await M.waitForFunction(() => S.settings.mode === 'custom');
  check(await M.isVisible('#features') && await M.isVisible('#sPower'), 'Custom reveals the toggles');
  await M.click('[data-mode="party"]'); await M.waitForFunction(() => S.settings.mode === 'party');
  check(/decoys, bounties, power-ups/.test(await M.textContent('#modeDesc')) && await ana.page.evaluate(() => /Party/.test(document.getElementById('modeLine').textContent)), 'Party selected; everyone sees the mode line');
  const m2 = await M.evaluate(() => S.settings); check(m2.powerups === 'normal' && m2.features.decoy && m2.features.bounty && m2.features.compass && !m2.features.cam, 'Party preset applied');
  await M.click('#btnQuick'); await M.waitForFunction(() => S.settings.pingSec === 10); await M.waitForFunction(() => S.settings.mode === 'party');
  await M.evaluate(() => scrollTo(0, 0)); await sleep(3200);
  await M.screenshot({ path: 'shots/v9_lobby_modes_qr.png' });
  // ---- start: role cards
  await M.click('#btnStart'); await M.waitForFunction(() => S.state === 'hiding');
  await ana.page.waitForSelector('#roleCard:not(.hidden)');
  check(/You're a HIDER/.test(await ana.page.textContent('#rcTitle')) && /^Hide! \d:\d\d/.test(await ana.page.textContent('#rcCount')) && await ana.page.locator('#rcBullets li').count() === 3, 'hider role card: title, Hide! countdown, 3 bullets');
  check(/You're a HUNTER/.test(await M.textContent('#rcTitle')) && /Wait\.\.\. hunters release in \d:\d\d/.test(await M.textContent('#rcCount')), 'hunter role card: wait countdown');
  check(await ana.page.evaluate(() => getComputedStyle(document.getElementById('roleCard')).backgroundImage.includes('14, 116, 144')), 'hider card uses the hider color');
  await sleep(700); await ana.page.screenshot({ path: 'shots/v9_role_card.png' });
  await M.waitForFunction(() => S.state === 'playing', null, { timeout: 20000 }); await sleep(600);
  check(await M.isHidden('#roleCard'), 'hunter role card auto-dismisses at release');
  check(await ana.page.isVisible('#roleCard'), 'hider card stays until tapped'); await ana.page.click('#roleCard'); await sleep(300);
  // ---- coach tip (decoy available) on first sight, one at a time, dismissible, stored per device
  await ana.page.waitForFunction(() => document.getElementById('coach').classList.contains('show'), null, { timeout: 5000 });
  check(/Decoy ready/.test(await ana.page.textContent('#coachTxt')), 'coach tip: decoy available');
  await sleep(500); await ana.page.screenshot({ path: 'shots/v9_coach_tip.png' });
  await ana.page.click('#coachX'); await sleep(600);
  check(!(await ana.page.evaluate(() => document.getElementById('coach').classList.contains('show'))) && await ana.page.evaluate(() => JSON.parse(localStorage.scramTips).decoy === 1), 'tip dismissed and remembered in localStorage');
  // ---- bottom action bar
  const bar = await ana.page.evaluate(() => { const ids = ['btnPower', 'btnDecoy', 'btnCaughtSelf', 'recBtn', 'abMore'], r = id => document.getElementById(id).getBoundingClientRect();
    const vis = ids.filter(id => r(id).width > 0), rs = vis.map(r);
    return { vis, minH: Math.min(...rs.map(x => x.height)), minW: Math.min(...rs.map(x => x.width)), inView: rs.every(x => x.bottom <= innerHeight && x.left >= 0 && x.right <= innerWidth),
      overlap: rs.some((a, i) => rs.some((b, j) => i < j && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top))),
      badge: document.getElementById('decoyBadge').textContent, inBar: document.getElementById('recBtn').closest('#actionBar') != null, empty: document.getElementById('btnPower').classList.contains('empty') }; });
  check(bar.vis.length === 5 && bar.minH >= 56 && bar.minW >= 56 && bar.inView && !bar.overlap, 'action bar: power slot, decoy, I got caught, Record, More; 56px+ targets, no overlap ' + JSON.stringify(bar));
  check(bar.badge === '2' && bar.inBar && bar.empty, 'decoy charges badge 2, Record lives in the bar, empty power-up slot');
  check(/2\/2/.test(await ana.page.textContent('#decoyCount')), 'decoy charges text kept for screen readers');
  await ana.page.click('#abMore'); await ana.page.waitForSelector('#moreSheet:not(.hidden)');
  check(await ana.page.isVisible('#btnSoundGame') && await ana.page.isVisible('#moreSheet [data-rules]') && await ana.page.isVisible('#btnLeaveGame'), 'More menu: sound check, rules, leave');
  await ana.page.click('#moreClose');
  await M.click('#abCatch'); await M.waitForSelector('#catchSheet:not(.hidden)');
  check(await M.locator('#hiderBtns [data-catch]').count() === 2, 'hunter Catch opens the catch sheet'); await M.click('#catchClose');
  await sleep(700); await ana.page.screenshot({ path: 'shots/v9_ingame_actionbar.png' });
  // ---- teammate marker + SVG markers + dark basemap
  check(await ana.page.locator('.mk.mate').count() >= 1 && await ana.page.locator('.mk.you').count() === 1, 'SVG markers: you + purple teammate');
  const tiles = await ana.page.evaluate(() => ({ t: map._tiles, a: document.querySelector('#map .leaflet-control-attribution').textContent }));
  check(tiles.t === 'osm' && /OpenStreetMap/.test(tiles.a) && await ana.page.locator('#map .leaflet-tile-pane .osmDark').count() === 1, 'dark basemap (OSM + dark filter) with attribution: ' + JSON.stringify(tiles));
  // ---- battery saver: still + nobody near -> saver pill; need_fix before each ping triggers an upload
  await ana.page.waitForFunction(() => window.gpsSaver === true, null, { timeout: 8000 }).catch(() => {});
  check(await ana.page.isVisible('#saverPill'), 'battery-saver indicator shown while still');
  const sends0 = await ana.page.evaluate(() => window.gpsSends || 0);
  // ---- ping moment (hunter): ripple + 40 ms haptic + ring
  const ring0 = await M.evaluate(() => +document.getElementById('pingArc').style.strokeDashoffset);
  await M.waitForFunction(() => window.lastRipple, null, { timeout: 15000 });
  await sleep(350);
  check(await M.locator('.ripple').count() >= 1, 'ping ripple drawn at the pinged spots');
  await M.screenshot({ path: 'shots/v9_ping_ripple.png' });
  check((await M.evaluate(() => window._vib)).includes(40), 'hunter haptic: navigator.vibrate(40) on ping');
  check(ring0 >= 0 && ring0 <= 132, 'ping countdown ring progresses (' + ring0 + ')');
  const nfIdx = ana.frames.findIndex(f => f.type === 'need_fix'), pIdx = ana.frames.findIndex(f => f.type === 'ping');
  check(nfIdx >= 0 && nfIdx < pIdx, 'need_fix arrives before the ping');
  check(ana.frames.nfAt && ana.sent.some(t => t >= ana.frames.nfAt && t - ana.frames.nfAt < 1500), 'need_fix forced a fresh upload despite battery saver');
  check(ana.sent.filter(t => t > ana.frames.nfAt - 9000 && t < ana.frames.nfAt - 100).length <= 2, 'saver: at most ~1 upload per 15 s while still (' + ana.sent.length + ' total)');
  await M.waitForFunction(() => document.querySelectorAll('.mk.hider').length >= 2, null, { timeout: 5000 }).catch(() => {});
  check(await M.locator('.mk.hider').count() >= 2, 'hunter sees cyan SVG hider badges after the ping');
  check(await M.evaluate(() => window.lastTip) === 'pingHunter', 'first-ping coach tip for the hunter');
  // ---- paused rendering while hidden
  const paused = await M.evaluate(async () => { let n = 0; const o = window.renderGame; window.renderGame = (...a) => { n++; return o(...a); };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); sendMsg({ type: 'sync' }); await new Promise(r => setTimeout(r, 600)); const whileHidden = n;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); await new Promise(r => setTimeout(r, 600)); return { whileHidden, after: n }; });
  check(paused.whileHidden === 0 && paused.after > 0, 'map rendering paused while the page is hidden ' + JSON.stringify(paused));
  // ---- infection: role card + coach
  if (await bo.page.isVisible('#roleCard')) await bo.page.click('#roleCard');
  await M.click('#abCatch'); await M.click('#hiderBtns button:has-text("Bo")'); await sleep(800);
  // host claims are instant (no confirmation step)
  await bo.page.waitForSelector('#roleCard:not(.hidden)', { timeout: 10000 });
  check(/infected/.test(await bo.page.textContent('#rcTitle')) && /HUNTER/.test(await bo.page.textContent('#rcTitle')), "infected role card: You've been infected, you're a HUNTER now");
  // ---- tips: not shown again after reload; Reset tips clears
  await ana.page.reload(); await ana.page.waitForFunction(() => window.S && S.state === 'playing', null, { timeout: 15000 }); await sleep(1500);
  check(await ana.page.evaluate(() => window.lastTip !== 'decoy'), 'decoy tip not repeated after reload');
  await ana.page.click('#abMore'); await ana.page.click('#btnResetTips2');
  check(await ana.page.evaluate(() => localStorage.getItem('scramTips') === null), 'Reset tips clears the stored tips');
  // ---- reduced motion respected
  await ana.page.emulateMedia({ reducedMotion: 'reduce' });
  check(await ana.page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('toast')).transitionDuration) < 0.01 && RM.matches), 'prefers-reduced-motion disables transitions and marker gliding');
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); await browser.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
