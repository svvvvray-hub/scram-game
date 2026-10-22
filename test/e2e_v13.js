// E2E v13: synced countdown + dramatic role reveal. 3 phones (host hunter + 2 hiders), real defaults:
// PORT=3013 node server.js & node test/e2e_v13.js [URL]   (RECORD=1 also writes the phone-viewport demo videos + stills)
const { chromium, devices } = require('playwright');
const fs = require('fs'), path = require('path');
const URL = process.argv[2] || 'http://localhost:3013', REC = !!process.env.RECORD;
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
(async () => {
  fs.mkdirSync('shots', { recursive: true }); const vdir = '/tmp/v13vid'; fs.rmSync(vdir, { recursive: true, force: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe, args: ['--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  const phone = async (name, lat, rec) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: { latitude: lat, longitude: -0.0877, accuracy: 6 }, permissions: ['geolocation'],
      ...(rec ? { recordVideo: { dir: path.join(vdir, name), size: { width: 412, height: 915 } } } : {}) });
    await ctx.addInitScript(() => localStorage.setItem('scramTips', JSON.stringify({ decoy: 1, chime: 1, chimeHunter: 1, powerup: 1, infected: 1, hunt: 1, hide: 1, start: 1, field: 1, catch: 1 })));
    const page = await ctx.newPage(); page.on('pageerror', e => errs.push(name + ': ' + e.message)); page.on('dialog', d => d.accept());
    await page.goto(URL + '/'); await page.waitForSelector('body[data-ready]'); await page.fill('#name', name); await page.check('#agree');
    return { ctx, page, name };
  };
  const host = await phone('Hunter', 51.5079, REC), ana = await phone('Ana', 51.5080, REC), bo = await phone('Bo', 51.5081, false);
  await host.page.click('#btnCreate'); await host.page.waitForSelector('#lobbyCode:not(:empty)'); const code = (await host.page.textContent('#lobbyCode')).trim();
  for (const p of [ana, bo]) { await p.page.fill('#code', code); await p.page.click('#btnJoin'); await p.page.waitForSelector('#lobbyCode:not(:empty)'); }
  await host.page.waitForFunction(() => S.players.length === 3);
  const all = [host, ana, bo];
  for (const p of all) await p.page.waitForFunction(() => window.clockSync && window.clockSync.n >= 4);
  for (const p of all) { const cs = await p.page.evaluate(() => window.clockSync); check(Math.abs(cs.offset) < 50 && cs.rtt < 200, `${p.name} clock sync: offset ${cs.offset.toFixed(1)} ms, rtt ${cs.rtt.toFixed(1)} ms`); }
  // DOM watchers: record every role leak before revealAt (role text / #rvRole inside the overlay or role badge)
  for (const p of all) await p.page.evaluate(() => { window.leaks = []; const chk = () => { if (!S || !S.revealAt) return; const t = Date.now() + (window.clockSync?.offset || 0);
      if (t < S.revealAt - 20 && (document.getElementById('rvRole') || /HUNTER|HIDER/.test(document.getElementById('reveal').textContent) || /HUNTER|HIDER/.test(document.getElementById('roleBadge').textContent) || !document.getElementById('roleCard').classList.contains('hidden'))) window.leaks.push(t - S.revealAt); };
    new MutationObserver(chk).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }); setInterval(chk, 16); });
  await host.page.click('#btnStart');
  for (const p of all) await p.page.waitForFunction(() => S && S.state === 'hiding');
  const st = await host.page.evaluate(() => ({ revealAt: S.revealAt, hideEndsAt: S.hideEndsAt, hideSec: S.settings.hideSec, now: S.serverNow }));
  check(st.revealAt - st.now > 5000 && st.revealAt - st.now < 6000, `revealAt ≈ start + 5.5 s (${st.revealAt - st.now} ms)`);
  check(st.hideEndsAt === st.revealAt + st.hideSec * 1000, 'hide timer starts at reveal (no hide time lost)');
  for (const p of all) check(await p.page.isVisible('#reveal'), `${p.name}: countdown overlay up`);
  await host.page.waitForFunction(() => /Hold your phones out/.test(document.getElementById('rvStage').textContent));
  check(true, 'hold-your-phones-out beat shows');
  check(await ana.page.evaluate(() => !document.getElementById('rvRole') && !/HUNTER|HIDER/.test(document.getElementById('reveal').textContent)), 'role not in the DOM during countdown');
  // reconnect mid-countdown: Bo reloads, should jump straight into the right beat
  await ana.page.waitForFunction(() => document.getElementById('reveal').dataset.phase === '3');
  await ana.page.screenshot({ path: 'shots/v13_countdown.png' });
  await bo.page.reload(); await bo.page.waitForSelector('body[data-ready]');
  await bo.page.evaluate(() => { window.leaks = []; });
  await bo.page.waitForFunction(() => !document.getElementById('reveal').classList.contains('hidden'), null, { timeout: 4000 });
  const bph = await bo.page.evaluate(() => document.getElementById('reveal').dataset.phase);
  check(['3', '2', '1', 'black', 'radar'].includes(bph), `reconnecting phone jumps into the countdown (phase ${bph})`);
  await host.page.waitForFunction(() => document.getElementById('rvRole'), null, { timeout: 8000 }); await sleep(450);
  await host.page.screenshot({ path: 'shots/v13_hunter.png' });
  await ana.page.waitForFunction(() => document.getElementById('rvRole')); await sleep(250); await ana.page.screenshot({ path: 'shots/v13_hider.png' });
  const logs = {}; for (const p of all) logs[p.name] = await p.page.evaluate(() => window.revealLog || []);
  const at = (n, k) => (logs[n].find(x => x.ph === k) || {}).srv;
  for (const k of ['2', '1', 'radar', 'reveal']) { const ts = all.map(p => at(p.name, k)).filter(Boolean); const spread = Math.max(...ts) - Math.min(...ts);
    check(ts.length >= 2 && spread < 100, `beat "${k}" within 100 ms across ${ts.length} phones (spread ${spread.toFixed(0)} ms)`); }
  for (const p of [host, ana]) { const r = at(p.name, 'reveal'); check(r - st.revealAt >= -5 && r - st.revealAt < 80, `${p.name} reveal at revealAt (+${(r - st.revealAt).toFixed(0)} ms)`); }
  const hr = await host.page.evaluate(() => window.revealRole), ar = await ana.page.evaluate(() => window.revealRole);
  check(/HUNTER/.test(hr.text) && /Team Hunters/.test(hr.text) && hr.cross, 'hunter: HUNTER + team + crosshair');
  check(/HIDER/.test(ar.text) && /Team Hiders/.test(ar.text) && ar.fog, 'hider: HIDER + team + fog');
  for (const p of all) await p.page.waitForSelector('#roleCard:not(.hidden)', { timeout: 4000 });
  check(/HUNTER/.test(await host.page.textContent('#rcTitle')) && /HIDER/.test(await ana.page.textContent('#rcTitle')), 'role card follows the reveal');
  check(/Hide! 1:5\d|Hide! 2:00/.test(await ana.page.textContent('#rcCount')), 'hider role card timer ≈ full 2:00: ' + await ana.page.textContent('#rcCount'));
  check(await host.page.evaluate(() => !document.getElementById('rvRole') && document.getElementById('reveal').classList.contains('hidden')), 'overlay cleaned up');
  for (const p of all) { const l = await p.page.evaluate(() => window.leaks); check(!l.length, `${p.name}: no role in the DOM before revealAt (${l.length} leaks)`); }
  await host.page.click('#roleCard'); await host.page.evaluate(() => sendMsg({ type: 'end' }));
  check(errs.length === 0, 'no page errors ' + errs.join(' | '));
  if (REC) { const paths = { Hunter: await host.page.video().path(), Ana: await ana.page.video().path() }; await host.page.waitForTimeout(800);
    await host.ctx.close(); await ana.ctx.close();
    fs.copyFileSync(paths.Hunter, 'shots/v13_reveal_hunter.webm'); fs.copyFileSync(paths.Ana, 'shots/v13_reveal_hider.webm'); console.log('videos saved'); }
  await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
