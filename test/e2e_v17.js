// E2E v17: automatic proximity tag. Party mode (auto-tag 5 m). Host = hunter, Ana + Ben hide 300 m away.
// The hunter walks up to Ana: walk-by (no tag) -> out of range resets -> stays 5 s -> tagged. Ben is never revealed.
// Real defaults: PORT=3017 node server.js & node test/e2e_v17.js [URL]
const { chromium, devices } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://localhost:3017';
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const LAT = 37.7596, LNG = -122.4269, M = 1 / 111320;
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe });
  const errs = [];
  const join = async (name, lat, code) => { const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-US', geolocation: { latitude: lat, longitude: LNG, accuracy: 4 }, permissions: ['geolocation'] });
    await ctx.addInitScript(() => { localStorage.setItem('scramQuiet', '1'); const ws = window.WebSocket; window.__msgs = []; window.WebSocket = function (...a) { const s = new ws(...a); s.addEventListener('message', e => { try { window.__msgs.push(JSON.parse(e.data)); } catch {} }); return s; }; window.WebSocket.prototype = ws.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }); });
    const p = await ctx.newPage(); p.ctx = ctx; p.on('pageerror', e => errs.push(name + ': ' + e.message)); p.on('dialog', d => d.accept());
    await p.goto(URL + '/'); await p.waitForSelector('body[data-ready]'); await p.fill('#name', name); await p.check('#agree');
    if (code) { await p.fill('#code', code); await p.click('#btnJoin'); } else await p.click('#btnCreate');
    await p.waitForSelector('#lobbyCode:not(:empty)'); return p; };
  const go = async (p, dm, lat0 = LAT) => { await p.ctx.setGeolocation({ latitude: lat0 + dm * M, longitude: LNG, accuracy: 4 }); await p.evaluate(() => typeof freshFix === 'function' && freshFix()); };
  const H = await join('Hunter', LAT - 300 * M); const code = (await H.textContent('#lobbyCode')).trim();
  const A = await join('Ana', LAT, code), B = await join('Ben', LAT + 400 * M, code);
  await H.waitForFunction(() => S.players.length === 3);
  await H.evaluate(() => sendMsg({ type: 'settings', settings: { mode: 'party' } })); await H.waitForFunction(() => S.settings.autoTag === 5);
  check(true, 'Party preset: auto-tag 5 m'); check(await H.isChecked('#sManualTag'), 'manual tag fallback on by default (host toggle)');
  await H.evaluate(() => sendMsg({ type: 'settings', settings: { hideSec: 0 } })); await H.waitForFunction(() => S.settings.hideSec === 0);
  await H.evaluate(() => sendMsg({ type: 'role', id: S.you, role: 'hunter' })); await sleep(200);
  await H.evaluate(() => sendMsg({ type: 'start', force: true })); await A.waitForFunction(() => S.state === 'playing', null, { timeout: 15000 });
  await sleep(1000);
  // walk-by: one fix next to Ana, then gone
  await go(H, 2); await sleep(1200); await go(H, -60); await sleep(2500);
  check(!(await H.evaluate(() => S.players.find(p => p.name === 'Ana').caught)), 'walk-by does not tag');
  check(await H.isHidden('#tagRing'), 'ring reset after moving away');
  // stay close -> rings fill on both phones
  await go(H, 2); for (let i = 0; i < 6; i++) { await sleep(700); await go(H, 2 + (i % 2) * 0.5); await go(A, 0); const v = await H.evaluate(() => getComputedStyle(document.getElementById('tagRing')).getPropertyValue('--p')); if (+v >= 0.4) break; }
  await A.waitForSelector('#tagRing.hider:not(.hidden)', { timeout: 5000 }); await H.waitForSelector('#tagRing.hunter:not(.hidden)', { timeout: 5000 });
  check((await H.textContent('#tagTxt')).includes('Closing in'), 'hunter sees only "Closing in…"');
  await A.screenshot({ path: 'shots/v17_hider_ring.png' }); await H.screenshot({ path: 'shots/v17_hunter_ring.png' });
  await A.waitForFunction(() => S.players.find(p => p.id === S.you).caught, null, { timeout: 15000 });
  check(true, 'staying within 5 m for ~5 s tags Ana (server)');
  await sleep(800); await H.screenshot({ path: 'shots/v17_tagged.png' });
  const hm = await H.evaluate(() => window.__msgs.filter(m => m.type === 'tagProg'));
  check(hm.length > 0 && hm.every(m => Object.keys(m).sort().join() === 'p,role,type'), 'hunter tagProg messages carry only a number');
  const leak = await H.evaluate(() => window.__msgs.filter(m => m.type !== 'state' && m.type !== 'ping' && m.type !== 'recap').map(JSON.stringify).join('')); 
  check(!leak.includes(String((LAT + 400 * M).toFixed(4))), 'Ben\'s position never sent to the hunter');
  check(!(await H.evaluate(() => S.players.find(p => p.name === 'Ben').caught)), 'Ben (far away) untouched');
  // lobby screenshot of the settings
  check(errs.length === 0, 'no page errors ' + errs.join(' | '));
  await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
