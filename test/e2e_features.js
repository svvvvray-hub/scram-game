// E2E for the 5 power-ups: 3 Pixel-7-emulated Chromium players, fake GPS + fake camera. Writes shots/*.png.
// Usage: node test/e2e_features.js [URL]   (default http://localhost:3000)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const { distM, offsetM } = require('../server');
const URL = process.argv[2] || 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
async function open(page, url) { await page.goto(url); const b = page.locator('button:has-text("Enter site")'); if (await b.count()) await b.first().click(); await page.waitForSelector('body[data-ready]', { timeout: 30000 }); }
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const base = { latitude: 51.5079, longitude: -0.0877 };
  const nearA = offsetM({ lat: base.latitude, lng: base.longitude }, 30, 90); // Alice 30 m from hunter -> chimes
  const mk = async (name, geo) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: { ...geo, accuracy: 8 }, permissions: ['geolocation', 'camera'] }); await ctx.addInitScript(() => localStorage.setItem('scramQuiet', '1')); // legacy suites: no role card / coach tips (covered by e2e_v9)
    const page = await ctx.newPage(); const frames = [];
    page.on('pageerror', e => console.log(name, 'PAGEERR', e.message));
    page.on('websocket', w => w.on('framereceived', f => { try { frames.push(JSON.parse(f.payload)); } catch {} }));
    page.on('dialog', d => d.accept());
    return { name, ctx, page, frames, geo };
  };
  const hunter = await mk('Murray', base);
  const alice = await mk('Alice', { latitude: nearA.lat, longitude: nearA.lng });
  const bob = await mk('Bob', { latitude: 51.5110, longitude: -0.0830 });
  await open(hunter.page, URL); await hunter.page.fill('#name', 'Murray'); await hunter.page.check('#agree'); await hunter.page.click('#btnCreate');
  await hunter.page.waitForSelector('#lobbyCode:not(:empty)'); const code = await hunter.page.textContent('#lobbyCode');
  for (const p of [alice, bob]) { await open(p.page, URL + '/j/' + code); await p.page.fill('#name', p.name); await p.page.check('#agree'); await p.page.click('#btnJoin'); await p.page.waitForSelector('#lobbyCode:not(:empty)'); }
  await hunter.page.waitForFunction(() => document.querySelectorAll('#playerList li').length === 3 && document.querySelectorAll('.pill.ok').length >= 3, null, { timeout: 20000 });
  // consent: Alice allows camera, Bob readies without
  await alice.page.waitForSelector('#camPanel:not(.hidden)'); await alice.page.click('#btnReadyCam');
  await bob.page.click('#btnReadyNoCam');
  await hunter.page.waitForFunction(() => S.players.some(p => p.cam === 'granted') && S.players.some(p => p.cam === 'denied'), null, { timeout: 10000 });
  check(await hunter.page.evaluate(() => ['fDecoy', 'fChime', 'fBounty', 'fCam', 'fCompass'].every(id => document.getElementById(id).checked)), 'all 5 feature toggles on by default');
  await hunter.page.click('#btnQuick'); await sleep(2800);
  check(await hunter.page.evaluate(() => S.settings.gameSec === 120), 'quick-test button sets 2-min game');
  await hunter.page.locator('#features').scrollIntoViewIfNeeded(); await sleep(300);
  await hunter.page.screenshot({ path: 'shots/lobby_toggles.png' });
  await alice.page.locator('#camPanel').scrollIntoViewIfNeeded(); await alice.page.screenshot({ path: 'shots/hider_lobby_camera_notice.png' });
  // toggle round-trip: off then on
  await hunter.page.click('#fChime'); await hunter.page.waitForFunction(() => !S.settings.features.chime); await hunter.page.click('#fChime'); await hunter.page.waitForFunction(() => S.settings.features.chime);
  check(true, 'host toggle round-trips through the server');
  // 1-min game for speed: bounty @ +15 s, cam @ +30 s, compass @ +54 s
  for (const [id, v] of [['#sGame', '1'], ['#sPing', '5'], ['#sHide', '3']]) { await hunter.page.fill(id, v); await hunter.page.dispatchEvent(id, 'change'); }
  await sleep(600);
  await hunter.page.click('#btnStart');
  await hunter.page.waitForFunction(() => S.state === 'playing' && S.pingCount >= 1, null, { timeout: 20000 });
  const aliceId = await alice.page.evaluate(() => S.you), bobId = await bob.page.evaluate(() => S.you);
  // ---- decoy
  await alice.page.waitForSelector('#btnDecoy:not([disabled])');
  check((await alice.page.textContent('#decoyCount')).includes('2/2'), 'hider UI shows 2/2 decoy charges');
  await alice.page.click('#btnDecoy');
  await alice.page.waitForFunction(() => S.decoyArmed && S.decoys === 1);
  await sleep(300); await alice.page.screenshot({ path: 'shots/hider_decoy.png' });
  const nPing = hunter.frames.filter(f => f.type === 'ping').length;
  while (hunter.frames.filter(f => f.type === 'ping').length <= nPing) await sleep(100);
  const dp = hunter.frames.filter(f => f.type === 'ping')[nPing];
  const dd = distM(nearA, dp.locs[aliceId]);
  check(dd >= 29.5 && dd <= 150.5, `decoy ping offset ${dd.toFixed(1)} m (30-150)`);
  await alice.page.waitForFunction(() => !S.decoyArmed);
  check((await alice.page.textContent('#decoyCount')).includes('1/2'), 'hider UI shows 1/2 after use');
  await alice.page.screenshot({ path: 'shots/hider_decoy_used.png' });
  // ---- chime
  check(alice.frames.some(f => f.type === 'chime'), 'Alice (30 m from hunter) chimed');
  check(!bob.frames.some(f => f.type === 'chime'), 'Bob (far) did not chime');
  check(hunter.frames.some(f => f.type === 'chimeNearby' && !('lat' in f)), 'hunter told "a hider chimed nearby" without location');
  // ---- bounty
  await hunter.page.waitForFunction(() => S.bounty, null, { timeout: 25000 });
  check(await alice.page.evaluate(() => !!S.bounty), 'bounty visible to hiders too');
  await sleep(1200); await hunter.page.screenshot({ path: 'shots/hunter_bounty.png' });
  const b = await hunter.page.evaluate(() => S.bounty);
  const pBefore = hunter.frames.filter(f => f.type === 'ping').length;
  await hunter.ctx.setGeolocation({ latitude: b.lat, longitude: b.lng, accuracy: 5 });
  await hunter.page.waitForFunction(() => !S.bounty, null, { timeout: 10000 });
  await sleep(300);
  const outPing = hunter.frames.filter(f => f.type === 'ping').slice(pBefore).find(f => f.out);
  check(outPing && outPing.locs[aliceId] && outPing.locs[bobId], 'hunter claim -> immediate out-of-cycle ping of all hiders');
  await hunter.ctx.setGeolocation(base);
  // ---- cam
  await hunter.page.waitForFunction(() => document.querySelector('#camStrip img'), null, { timeout: 30000 });
  await hunter.page.waitForFunction(() => /unavailable/.test(document.getElementById('camStrip').textContent), null, { timeout: 20000 });
  const peeks = hunter.frames.filter(f => f.type === 'camPeek');
  const pa = peeks.find(f => f.id === aliceId && f.data);
  check(pa && /^data:image\/jpeg;base64,/.test(pa.data) && pa.data.length < 200000, `hunter got Alice's JPEG (${pa && pa.data.length} chars)`);
  check(peeks.some(f => f.id === bobId && f.unavailable), 'Bob (no consent) -> photo unavailable');
  check(peeks.every(f => !('lat' in f) && !('lng' in f)), 'photo relay carries no GPS');
  check(![...alice.frames, ...bob.frames].some(f => f.type === 'camPeek' || JSON.stringify(f).includes('data:image')), 'hiders never receive photos');
  await hunter.page.locator('#camStrip').scrollIntoViewIfNeeded(); await sleep(300);
  await hunter.page.screenshot({ path: 'shots/hunter_cam_peek.png' });
  await hunter.page.click('#camStrip img'); await sleep(400);
  await hunter.page.screenshot({ path: 'shots/hunter_cam_peek_open.png' });
  await hunter.page.click('#photoView');
  // ---- compass
  await hunter.page.waitForSelector('#compass:not(.hidden)', { timeout: 40000 });
  const cIdx = hunter.frames.length;
  await sleep(4500);
  const comp = hunter.frames.slice(cIdx).filter(f => f.type === 'compass');
  check(comp.length >= 2, `compass updates every ~2 s (${comp.length} in 4.5 s)`);
  check(comp.every(f => Object.keys(f).sort().join() === 'band,bearing,type'), 'compass messages have only bearing + band');
  check(!hunter.frames.slice(cIdx).some(f => f.type === 'ping'), 'no map pings during sudden death');
  check(Math.abs(comp[comp.length - 1].bearing - 90) <= 2 && ['scorching', 'hot'].includes(comp[comp.length - 1].band), `arrow at nearest hider Alice: ${comp[comp.length - 1].bearing}° ${comp[comp.length - 1].band}`);
  check(!alice.frames.some(f => f.type === 'compass'), 'hiders get no compass');
  await hunter.page.screenshot({ path: 'shots/compass.png' });
  await hunter.page.waitForSelector('#end:not(.hidden)', { timeout: 20000 });
  check(true, 'game ended: ' + await hunter.page.textContent('#winner'));
  // play again keeps lobby, features reset
  for (const p of [hunter, alice, bob]) await p.page.click('#btnHome');
  await hunter.page.waitForSelector('#lobby:not(.hidden)');
  check((await hunter.page.textContent('#lobbyCode')) === code, 'play again keeps same lobby');
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL E2E FEATURE CHECKS PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
