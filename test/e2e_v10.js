// E2E v10: in-app browser escape hatch (Zalo Android -> Open in Chrome intent; Zalo iOS -> Safari banner + copy link)
// and rejoin after closing the page (auto-rejoin from the invite link + "Rejoin game" button from another link).
// Usage: PORT=3010 node server.js & node test/e2e_v10.js [URL]   (default http://localhost:3010)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://localhost:3010';
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const ZALO_ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A536E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Zalo android/12100658 ZaloTheme/light ZaloLanguage/vn';
const ZALO_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/514 ZaloTheme/light ZaloLanguage/vn';
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe });
  const errs = [];
  const mk = async (name, geo, opt = {}) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ...opt, geolocation: { ...geo, accuracy: 6 }, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(() => localStorage.setItem('scramQuiet', '1'));
    const page = await ctx.newPage(); page.on('pageerror', e => errs.push(name + ': ' + e.message));
    return { ctx, page };
  };
  const join = async (page, url, name) => { await page.goto(url); await page.waitForSelector('body[data-ready]'); await page.fill('#name', name); await page.check('#agree'); };
  // host
  const host = await mk('Host', { latitude: 51.5079, longitude: -0.0877 }); const H = host.page;
  await join(H, URL, 'Host'); await H.click('#btnCreate'); await H.waitForSelector('#lobbyCode:not(:empty)');
  const code = (await H.textContent('#lobbyCode')).trim();
  check(!(await H.isVisible('#inapp')), 'no in-app banner in regular Chrome');
  // ---- Zalo Android
  const za = await mk('ZaloA', { latitude: 51.51, longitude: -0.084 }, { userAgent: ZALO_ANDROID });
  await za.page.goto(`${URL}/p/${code}?ref=murray`); await za.page.waitForSelector('body[data-ready]');
  check(await za.page.isVisible('#inapp') && await za.page.isVisible('#btnChrome'), 'Zalo Android: banner + Open in Chrome button visible');
  const href = await za.page.getAttribute('#btnChrome', 'href'), host_ = new globalThis.URL(URL).host;
  check(href.startsWith(`intent://${host_}/?`) && href.includes(`code=${code}`) && href.includes('ref=murray') && href.includes('#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=') && href.endsWith(';end'), 'intent URL keeps code + ref: ' + href);
  check(decodeURIComponent(href.split('S.browser_fallback_url=')[1].replace(/;end$/, '')).includes(`code=${code}`), 'fallback URL decodes to the invite link');
  check(!(await za.page.isVisible('#inappIos')), 'Android does not show the iOS instructions');
  const zaTxt = await za.page.innerText('#inapp'); check(!/Zalo|Facebook|Messenger|Instagram|TikTok|WeChat|Line|Snapchat|WebView/.test(zaTxt) && /not in your main browser/.test(zaTxt) && /Open in Chrome so the game doesn't close when you switch apps\./.test(zaTxt), 'Android banner copy is generic: ' + JSON.stringify(zaTxt));
  await za.page.screenshot({ path: 'shots/v10_android_inapp.png' });
  // ---- Zalo iOS
  const zi = await mk('ZaloI', { latitude: 51.511, longitude: -0.085 }, { ...devices['iPhone 13'], userAgent: ZALO_IOS });
  await zi.page.goto(`${URL}/p/${code}`); await zi.page.waitForSelector('body[data-ready]');
  check(await zi.page.isVisible('#inappIos') && await zi.page.isVisible('#inappArrow') && /Open in Safari/.test(await zi.page.textContent('#inappIos')), 'Zalo iOS: Safari banner + arrow');
  check(!(await zi.page.isVisible('#btnChrome')), 'iOS: no Chrome intent button');
  const ziTxt = await zi.page.innerText('#inapp'); check(!/Zalo|Facebook|Messenger|Instagram|TikTok|WeChat|Line|Snapchat|WebView/.test(ziTxt) && /not in your main browser/.test(ziTxt) && /Tap ⋯ and choose Open in Safari so the game keeps running\./.test(ziTxt), 'iOS banner copy is generic: ' + JSON.stringify(ziTxt));
  await zi.page.screenshot({ path: 'shots/v10_ios_inapp.png' });
  await zi.page.click('#btnCopyLink'); const clip = await zi.page.evaluate(() => navigator.clipboard.readText());
  check(clip.includes(`code=${code}`), 'Copy link copies the invite URL: ' + clip);
  await zi.page.click('#inappClose');
  check(await zi.page.isVisible('#inapp') && await zi.page.isVisible('#btnCopyLink') && !(await zi.page.isVisible('#inappArrow')), 'dismiss minimizes but banner stays on join screen');
  // ---- rejoin after closing the page
  const pl = await mk('Lan', { latitude: 51.5101, longitude: -0.0841 }); let P = pl.page;
  await join(P, `${URL}/p/${code}`, 'Lan'); await P.click('#btnJoin'); await P.waitForSelector('#lobbyCode:not(:empty)');
  const myId = await P.evaluate(() => JSON.parse(localStorage.scram).id);
  check(!!myId && await P.evaluate(() => !!JSON.parse(localStorage.scram).token), 'session (id + token + code) persisted');
  await H.waitForFunction(n => S.players.length >= 2, null, { timeout: 10000 });
  await H.evaluate(() => sendMsg({ type: 'settings', settings: { hideSec: 0 } }));
  await H.waitForTimeout(300); await H.evaluate(() => sendMsg({ type: 'start' }));
  await H.waitForFunction(() => S.state === 'playing' || S.state === 'hiding', null, { timeout: 10000 });
  const role0 = await P.evaluate(id => { const p = S.players.find(x => x.id === id); return p && p.role; }, myId);
  await P.close();
  await H.waitForFunction(id => S.players.find(p => p.id === id).connected === false, myId, { timeout: 10000 });
  check(true, 'host sees Lan disconnected (slot kept)');
  // open the root page (another invite): Rejoin button is offered
  P = await pl.ctx.newPage(); await P.goto(`${URL}/?code=ZZZZZ`); await P.waitForSelector('#btnRejoin:not(.hidden)', { timeout: 10000 });
  check(/Rejoin game .*Lan/.test(await P.textContent('#btnRejoin')), 'Rejoin button: ' + await P.textContent('#btnRejoin'));
  await P.screenshot({ path: 'shots/v10_rejoin.png' });
  await P.click('#btnRejoin'); await P.waitForFunction(() => window.S && S.state !== 'lobby', null, { timeout: 10000 });
  const r = await P.evaluate(id => { const p = S.players.find(x => x.id === id); return p && { role: p.role, caught: p.caught }; }, myId);
  check(r && r.role === role0 && !r.caught, `rejoined as same player, role ${r && r.role}, not caught`);
  await H.waitForFunction(id => S.players.find(p => p.id === id).connected, myId, { timeout: 10000 });
  check((await H.evaluate(() => S.players.length)) === 2, 'no duplicate player created');
  // close again, reopen the invite link -> automatic rejoin
  await P.close(); P = await pl.ctx.newPage(); await P.goto(`${URL}/p/${code}`);
  await P.waitForFunction(() => window.S && S.state !== 'lobby', null, { timeout: 10000 });
  check(await P.evaluate(id => S.players.some(p => p.id === id && p.connected), myId), 'reopening the invite link auto-rejoins');
  // socket drop + page visible again -> reconnects to same slot
  await P.evaluate(() => ws.close()); await P.waitForTimeout(200);
  await P.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await H.waitForFunction(id => S.players.find(p => p.id === id).connected, myId, { timeout: 10000 });
  check(await P.evaluate(id => JSON.parse(localStorage.scram).id === id, myId), 'socket reconnect keeps same player id');
  check(!errs.length, 'no page errors ' + errs.join('; '));
  await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
