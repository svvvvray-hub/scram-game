// E2E power-ups: hider picks up + uses Hunter Radar, hunter uses Sonar (hiders alerted), a hider steals a hunter drop and is pinged.
// Also: sound check + "Test chime on all phones" vote tally. Needs a server started with SCRAM_TEST_PU=hider:radar,hunter:sonar
// (forces drop types).  Usage: node test/e2e_powerups.js [URL]   (default http://localhost:3001)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://localhost:3001';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const T0 = Date.now();
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe, args: ['--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  const mk = async (name, geo) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: { ...geo, accuracy: 5 }, permissions: ['geolocation'] });
    const page = await ctx.newPage(), frames = [];
    page.on('pageerror', e => { errs.push(name + ': ' + e.message); console.log(name, 'PAGEERR', e.message); });
    page.on('websocket', w => w.on('framereceived', f => { try { frames.push(JSON.parse(f.payload)); } catch {} }));
    page.on('dialog', d => d.accept());
    await page.goto(URL); await page.waitForSelector('body[data-ready]'); await page.fill('#name', name);
    return { name, ctx, page, frames, geo };
  };
  const murray = await mk('Murray', { latitude: 51.5079, longitude: -0.0877 });
  const ana = await mk('Ana', { latitude: 51.5100, longitude: -0.0840 });
  const bob = await mk('Bob', { latitude: 51.5060, longitude: -0.0920 });
  await murray.page.check('#agree'); await murray.page.click('#btnCreate'); await murray.page.waitForSelector('#lobbyCode:not(:empty)');
  const code = (await murray.page.textContent('#lobbyCode')).trim();
  for (const p of [ana, bob]) { await p.page.fill('#code', code); await p.page.check('#agree'); await p.page.click('#btnJoin'); await p.page.waitForSelector('#lobbyCode:not(:empty)'); }
  await murray.page.waitForFunction(() => S.players.length === 3 && S.players.every(p => p.perm === 'granted'), null, { timeout: 20000 });
  // How to play: in-app sheet, player stays in the lobby with the socket open
  const sentBefore = murray.frames.length;
  await ana.page.click('#lobby [data-rules]'); await ana.page.waitForSelector('#rulesSheet:not(.hidden)');
  const rf = ana.page.frameLocator('#rulesFrame'); await rf.locator('h1').waitFor();
  check(/How to play/.test(await rf.locator('h1').textContent()) && await rf.locator('nav.toc a').count() >= 10, 'rules open in an in-app sheet with a table of contents');
  await rf.locator('nav.toc a[href="#power"]').click(); await sleep(600);
  check(/Hunter Radar/.test(await rf.locator('#power').textContent()) && await rf.locator('#power').evaluate(d => d.open), 'collapsible power-up section opens from the TOC');
  check(await rf.locator('[data-v="pingSec"]').textContent() === '60' && /Extra Time 10%/.test(await rf.locator('#oddsNote').textContent()), 'values rendered from the game config');
  await ana.page.screenshot({ path: 'shots/rules.png' });
  check(await ana.page.evaluate(() => S.state === 'lobby' && ws.readyState === 1 && !document.getElementById('lobby').classList.contains('hidden')), 'player stays in the lobby, WebSocket open');
  await rf.locator('a.back').first().click(); await ana.page.waitForSelector('#rulesSheet.hidden', { state: 'attached' });
  check(ana.page.url().includes('code='), '← Back closes the sheet without leaving the lobby');
  // sound check
  await murray.page.click('#btnSound'); check(await murray.page.isVisible('#soundAsk'), 'sound check asks "Did you hear it?"');
  check(await murray.page.evaluate(() => Math.abs(window.lastChime.gain - 0.25) < 1e-9), 'chime gain defaults to 0.25 (25 %)');
  await murray.page.click('#soundNo'); check(/silent/.test(await murray.page.textContent('#soundTips')), 'No -> silent-mode / volume tips');
  await murray.page.evaluate(() => document.getElementById('btnSound').scrollIntoView({ block: 'center' }));
  await sleep(1200); await murray.page.screenshot({ path: 'shots/sound_check.png' });
  // test chime on all phones + vote tally
  await murray.page.click('#btnChimeAll');
  for (const p of [ana, bob]) await p.page.waitForFunction(() => window.lastChimeTest && !document.getElementById('chimeVoteBox').classList.contains('hidden'), null, { timeout: 5000 });
  const unl = await bob.page.evaluate(() => window.lastChimeTest.unlocked ? 'played' : (!document.getElementById('soundUnlock').classList.contains('hidden') ? 'prompt' : 'none'));
  check(unl === 'played' || unl === 'prompt', 'every phone plays the preview (or shows "Tap to enable sound"): ' + unl);
  await ana.page.click('[data-vote="good"]'); await bob.page.click('[data-vote="loud"]');
  await murray.page.waitForFunction(() => /👍 1 · 🔉 0 · 🔊 1/.test(document.getElementById('chimeTally').textContent), null, { timeout: 5000 });
  check(true, 'host sees the live tally: ' + await murray.page.textContent('#chimeTally'));
  // game: chaos drops, quick timings (2-min game: drops every 9 s from 0:12)
  await murray.page.selectOption('#sPower', 'chaos');
  for (const [id, v] of [['#sGame', '2'], ['#sPing', '30'], ['#sHide', '0']]) { await murray.page.fill(id, v); await murray.page.dispatchEvent(id, 'change'); }
  await murray.page.waitForFunction(() => S.settings.powerups === 'chaos' && S.settings.pingSec === 30);
  await murray.page.click('#btnStart'); await ana.page.waitForFunction(() => S.state === 'playing');
  // 1) hider drop -> only hiders see it; Ana picks it up (5 s scaled = 1 s) and uses Hunter Radar
  await ana.page.waitForFunction(() => (S.drops || []).some(d => d.side === 'hider'), null, { timeout: 30000 });
  const hd = await ana.page.evaluate(() => S.drops.find(d => d.side === 'hider'));
  check(!murray.frames.some(f => JSON.stringify(f).includes(hd.id)), 'hider drop never sent to the hunter');
  check(await bob.page.evaluate(id => S.drops.some(d => d.id === id), hd.id), 'other hider sees it too');
  await sleep(500); await ana.page.screenshot({ path: 'shots/powerup_drop_hider.png' });
  await ana.ctx.setGeolocation({ latitude: hd.lat + 0.00003, longitude: hd.lng, accuracy: 5 });
  await ana.page.waitForFunction(() => S.pu && S.pu.pickup, null, { timeout: 5000 }); check(true, 'pickup progress ring shown');
  await ana.page.waitForFunction(() => S.pu && S.pu.held === 'radar', null, { timeout: 8000 });
  await sleep(300); await ana.page.screenshot({ path: 'shots/powerup_held.png' });
  check(/Hunter Radar/.test(await ana.page.textContent('#btnPower')), 'held power-up button: ' + await ana.page.textContent('#btnPower'));
  check(!(await ana.page.evaluate(() => !!S.players.find(p => p.name === 'Murray').loc)), 'no hunter positions before radar');
  await ana.page.click('#btnPower');
  await ana.page.waitForFunction(() => !!S.players.find(p => p.name === 'Murray').loc, null, { timeout: 5000 }); check(true, 'Hunter Radar: Ana sees Murray live');
  await murray.page.waitForFunction(() => /A hider used Hunter Radar/.test(document.getElementById('toast').textContent), null, { timeout: 5000 }); check(true, 'hunter toast: A hider used Hunter Radar!');
  // 2) hunter drop (visible to everyone) -> Murray picks up Sonar and uses it -> hiders alerted
  await murray.page.waitForFunction(() => (S.drops || []).some(d => d.side === 'hunter'), null, { timeout: 30000 });
  const ud = await murray.page.evaluate(() => S.drops.find(d => d.side === 'hunter'));
  check(await bob.page.evaluate(id => (S.drops || []).some(d => d.id === id), ud.id), 'hunter drop visible to hiders');
  await ana.ctx.setGeolocation({ latitude: ud.lat + 0.0002, longitude: ud.lng, accuracy: 5 }); // Ana ~22 m from it: within Sonar range, outside the pickup radius
  await murray.ctx.setGeolocation({ latitude: ud.lat, longitude: ud.lng + 0.00003, accuracy: 5 });
  await murray.page.waitForFunction(() => S.pu && S.pu.held === 'sonar', null, { timeout: 8000 }); check(true, 'Murray picked up Sonar');
  await murray.page.click('#btnPower');
  for (const p of [ana, bob]) await p.page.waitForFunction(() => !document.getElementById('sonarAlert').classList.contains('hidden') && /Sonar/.test(document.getElementById('sonarAlert').textContent), null, { timeout: 5000 });
  check(/Hunter Murray used Sonar!/.test(await bob.page.textContent('#sonarAlert')), 'all hiders alerted with the hunter name: ' + await bob.page.textContent('#sonarAlert'));
  check(ana.frames.some(f => f.type === 'chime' && f.sonar), 'Ana (within 75 m) was forced to chime');
  await sleep(1000); await ana.page.screenshot({ path: 'shots/sonar_alert.png' });
  // 3) steal: Bob destroys the next hunter drop -> flash + Murray gets Bob's real location
  await murray.ctx.setGeolocation(murray.geo);
  await bob.page.waitForFunction(() => (S.drops || []).some(d => d.side === 'hunter'), null, { timeout: 30000 });
  const sd = await bob.page.evaluate(() => S.drops.find(d => d.side === 'hunter'));
  await bob.ctx.setGeolocation({ latitude: sd.lat, longitude: sd.lng + 0.00004, accuracy: 5 });
  for (let i = 0; i < 100 && !murray.frames.some(f => f.type === 'ping' && f.steal); i++) await sleep(100);
  const sp = murray.frames.find(f => f.type === 'ping' && f.steal);
  const bobId = await bob.page.evaluate(() => S.you);
  check(sp && sp.locs[bobId] && Math.abs(sp.locs[bobId].lat - sd.lat) < 0.0002, 'steal pings Bob\'s real location to the hunter');
  check(bob.frames.some(f => f.type === 'dropFlash') && ana.frames.some(f => f.type === 'dropFlash'), 'everyone sees the drop spot flash');
  await murray.page.click('#btnEnd'); await murray.page.waitForSelector('#recap:not(.hidden)', { timeout: 15000 });
  const tl = await murray.page.textContent('#timeline');
  check(/used Hunter Radar/.test(tl) && /used Sonar/.test(tl) && /destroyed a hunter drop/.test(tl), 'power-up events in the recap timeline');
  const tr = await murray.page.evaluate(() => RecapData.trophies.map(t => t.key + ':' + t.name));
  check(tr.includes('thief:Bob') && tr.some(t => t.startsWith('powerPlayer:')), 'Thief + Power Player trophies: ' + tr.join(', '));
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS', ((Date.now() - T0) / 1000).toFixed(0) + 's'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
