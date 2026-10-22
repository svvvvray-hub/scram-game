// End-to-end through the public URL: 3 mobile-emulated Chromium players with fake GPS.
const { chromium, devices } = require('playwright');
const URL = process.argv[2] || 'http://localhost:3000';
async function open(page, url) { await page.goto(url); const b = page.locator('button:has-text("Enter site")'); if (await b.count()) { await b.first().click(); } await page.waitForSelector('body[data-ready]', { timeout: 30000 }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => require('fs').existsSync(p)), args: process.env.NOH2 ? ['--disable-http2'] : [] });
  const mk = async (name, geo) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: { ...geo, accuracy: 12 }, permissions: ['geolocation'] }); await ctx.addInitScript(() => localStorage.setItem('scramQuiet', '1')); // legacy suites: no role card / coach tips (covered by e2e_v9)
    const page = await ctx.newPage(); page.on('console', m => process.env.DBG && console.log(name, 'CONSOLE', m.text())); page.on('pageerror', e => console.log(name, 'ERR', e.message)); page.on('framenavigated', f => f === page.mainFrame() && process.env.DBG && console.log(name, 'NAV', f.url())); page.on('websocket', w => { process.env.DBG && console.log(name, 'WS open'); w.on('close', () => process.env.DBG && console.log(name, 'WS close')); w.on('socketerror', e => console.log(name, 'WSERR', e)); w.on('framesent', f => process.env.DBG && console.log(name, 'SENT', String(f.payload).slice(0, 60))); }); page.on('websocket', w => w.on('framereceived', f => process.env.DBG && console.log(name, 'F', String(f.payload).slice(0, 50))));
    return { name, ctx, page };
  };
  const base = { latitude: 51.5079, longitude: -0.0877 };
  const hunter = await mk('Murray', base);
  const h1 = await mk('Alice', { latitude: 51.5105, longitude: -0.0830 });
  const h2 = await mk('Bob', { latitude: 51.5050, longitude: -0.0920 });
  await open(hunter.page, URL); await hunter.page.fill('#name', 'Murray'); await hunter.page.check('#agree'); await hunter.page.click('#btnCreate');
  await hunter.page.waitForSelector('#lobbyCode:not(:empty)'); const code = await hunter.page.textContent('#lobbyCode');
  console.log('code', code);
  for (const p of [h1, h2]) { await open(p.page, URL + '/j/' + code); await p.page.fill('#name', p.name); console.log('filled', await p.page.inputValue('#name')); await p.page.check('#agree'); await p.page.click('#btnJoin'); await sleep(500); console.log('toast', await p.page.textContent('#toast')); await p.page.waitForSelector('#lobbyCode:not(:empty)', { timeout: 15000 }).catch(async e => { console.log('join fail', p.page.url(), await p.page.textContent('#toast'), await p.page.inputValue('#code')); await p.page.screenshot({ path: '/tmp/fail.png' }); throw e; }); }
  await hunter.page.waitForFunction(() => document.querySelectorAll('#playerList li').length === 3 && document.querySelectorAll('.pill.ok').length === 3, null, { timeout: 20000 });
  await hunter.page.fill('#sGame', '2'); await hunter.page.dispatchEvent('#sGame', 'change');
  await hunter.page.fill('#sPing', '10'); await hunter.page.dispatchEvent('#sPing', 'change');
  await hunter.page.fill('#sHide', '5'); await hunter.page.dispatchEvent('#sHide', 'change');
  await sleep(800);
  await hunter.page.screenshot({ path: 'shots/lobby.png', fullPage: true });
  hunter.page.on('dialog', d => d.accept()); h1.page.on('dialog', d => d.accept()); h2.page.on('dialog', d => d.accept());
  await hunter.page.click('#btnStart');
  await hunter.page.waitForSelector('#hideCover:not(.hidden)'); console.log('head start shown to hunter');
  // privacy probe: watch hunter websocket frames for Alice's moved coord before ping
  const frames = []; hunter.page.on('websocket', () => {});
  const cdp = await hunter.ctx.newCDPSession(hunter.page); await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', f => frames.push({ t: Date.now(), d: f.response.payloadData }));
  const t0 = Date.now();
  await hunter.page.waitForFunction(() => document.querySelectorAll('.leaflet-tooltip').length >= 3, null, { timeout: 30000 }).catch(async e => { console.log('DIAG', await hunter.page.evaluate(() => JSON.stringify({ st: S.state, pc: S.pingCount, pl: S.players.map(p => [p.name, p.role, p.connected, !!p.loc, p.stale]), tt: document.querySelectorAll('.leaflet-tooltip').length, rs: ws.readyState }))); await hunter.page.screenshot({ path: '/tmp/diag.png' }); throw e; });
  console.log('first ping after start ms', Date.now() - t0 + 'ish');
  await sleep(1500);
  await hunter.page.screenshot({ path: 'shots/hunter_map.png' });
  // Alice moves; must not reach hunter until next ping
  await h1.ctx.setGeolocation({ latitude: 51.5120, longitude: -0.0790, accuracy: 10 });
  await sleep(3000);
  const leakedEarly = frames.some(f => f.d.includes('51.512'));
  await h1.page.screenshot({ path: 'shots/hider_view.png' });
  await hunter.page.waitForFunction(() => [...document.querySelectorAll('.leaflet-tooltip')].length >= 3 && window.S && S.pingCount >= 2, null, { timeout: 15000 }).catch(() => {});
  const pingTimes = frames.map(f => { try { return JSON.parse(f.d); } catch { return {}; } }).filter(m => m.type === 'ping').map(m => m.t);
  console.log('ping gaps ms', pingTimes.slice(1).map((t, i) => t - pingTimes[i]));
  console.log('moved location leaked before ping?', leakedEarly, '| after ping present?', frames.some(f => f.d.includes('51.512')));
  // catch Alice, Bob self-reports -> hunters win
  await hunter.page.click('#abCatch'); await hunter.page.click(`#hiderBtns button:has-text("Alice")`);
  await sleep(1000);
  await h2.page.click('#btnCaughtSelf');
  await hunter.page.waitForSelector('#catchBox [data-cy]', { timeout: 10000 }); console.log('hunter got catch confirm prompt');
  await hunter.page.click('#catchBox [data-cy]');
  await hunter.page.waitForSelector('#end:not(.hidden)', { timeout: 10000 });
  await sleep(1500);
  await hunter.page.screenshot({ path: 'shots/end.png', fullPage: true });
  console.log('winner:', await hunter.page.textContent('#winner'));
  // reconnect check: reload Bob's page, should come back to end screen of same lobby
  await h2.page.reload(); await h2.page.waitForSelector('#end:not(.hidden)', { timeout: 10000 }); console.log('Bob rejoined after refresh OK');
  // ---- v2: rematch / leave ----
  await hunter.page.screenshot({ path: 'shots/end_v2.png', fullPage: true });
  const setShort = async () => { for (const [id, v] of [['#sGame', '0.25'], ['#sPing', '5'], ['#sHide', '0']]) { await hunter.page.fill(id, v); await hunter.page.dispatchEvent(id, 'change'); } await sleep(800); };
  const playAgain = async () => {
    for (const p of [hunter, h1, h2]) { await p.page.waitForSelector('#end:not(.hidden)', { timeout: 30000 }); await p.page.click('#btnHome'); }
    for (const p of [hunter, h1, h2]) await p.page.waitForSelector('#lobby:not(.hidden)', { timeout: 30000 }).catch(async e => { console.log('DIAG lobby', p.name, await p.page.evaluate(() => JSON.stringify({ st: S && S.state, rs: ws.readyState, toast: document.getElementById('toast').textContent, vis: [...document.querySelectorAll('.screen')].filter(x => !x.classList.contains('hidden')).map(x => x.id) }))); throw e; });
    await hunter.page.waitForFunction(() => document.querySelectorAll('#playerList li').length === 3);
    const sameCode = (await Promise.all([hunter, h1, h2].map(p => p.page.textContent('#lobbyCode')))).every(c => c === code);
    console.log('rematch: same code for all 3?', sameCode, '| non-host sees waiting:', await h1.page.isVisible('#waitHost'));
  };
  await playAgain();
  await hunter.page.screenshot({ path: 'shots/lobby_after_rematch.png', fullPage: true });
  for (let round = 2; round <= 3; round++) {
    await setShort(); await hunter.page.click('#btnStart');
    await hunter.page.waitForSelector('#game:not(.hidden)');
    const pings0 = frames.length;
    if (round === 2) {
      await hunter.page.waitForFunction(() => S && S.pingCount >= 1, null, { timeout: 20000 });
      console.log('round 2 hunter sees', await hunter.page.locator('.leaflet-tooltip').count(), 'map labels after first ping');
      for (const n of ['Alice', 'Bob']) { await hunter.page.click('#abCatch'); await hunter.page.click(`#hiderBtns button:has-text("${n}")`); await sleep(700); }
    }
    await hunter.page.waitForSelector('#end:not(.hidden)', { timeout: 40000 });
    const w = await hunter.page.textContent('#winner');
    const pingMsgs = frames.slice(pings0).map(f => { try { return JSON.parse(f.d); } catch { return {}; } }).filter(m => m.type === 'ping');
    console.log(`round ${round}: ${w} | pings this round:`, pingMsgs.map(m => m.n).join(','));
    await playAgain();
  }
  // Alice leaves
  await h1.page.click('#btnLeaveLobby'); await h1.page.waitForSelector('#home:not(.hidden)');
  await hunter.page.waitForFunction(() => document.querySelectorAll('#playerList li').length === 2);
  await h1.page.reload(); await sleep(3000); console.log('Alice left; after refresh on home?', await h1.page.isVisible('#home'));
  // host leaves -> Bob becomes host
  await hunter.page.click('#btnLeaveLobby'); await hunter.page.waitForSelector('#home:not(.hidden)');
  await h2.page.waitForFunction(() => /Host: Bob/.test(document.getElementById('hostName').textContent) && !document.getElementById('hostPanel').classList.contains('hidden'));
  console.log('host transferred to Bob:', await h2.page.textContent('#hostName'));
  // Alice rejoins with code as a new player
  await h1.page.fill('#name', 'Alice'); await h1.page.fill('#code', code); await h1.page.check('#agree'); await h1.page.click('#btnJoin');
  await h2.page.waitForFunction(() => document.querySelectorAll('#playerList li').length === 2);
  console.log('Alice rejoined as new: players =', await h2.page.locator('#playerList li .nm').allTextContents());
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
