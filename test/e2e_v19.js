// E2E v19: field-test fixes. (1) boundary "Tap corners" (default) + freehand, undo, close shape; (2) power-up drops on walkable
// ways from a mocked Overpass; (3) auto-tag: a hider GPS gap pauses the ring, then the "Tap to confirm tag" fallback -> hider confirms.
// Real defaults + mock Overpass (started by this script on :3099):
// OVERPASS_URL=http://localhost:3099/api/interpreter PORT=3019 node server.js & node test/e2e_v19.js [URL]
const { chromium, devices } = require('playwright');
const fs = require('fs'), http = require('http');
const Walk = require('../walk');
const URL = process.argv[2] || 'http://localhost:3019';
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const LAT = 37.7596, LNG = -122.4269, M = 1 / 111320, ML = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
const P = (n, e) => ({ lat: LAT + n * M, lon: LNG + e * ML });
// a little street grid around Dolores Park (+ a motorway that must never get drops)
const FIX = { elements: [
  ...[-240, -80, 80, 240].map((n, i) => ({ type: 'way', id: 10 + i, tags: { highway: 'residential' }, geometry: [P(n, -420), P(n, 420)] })),
  ...[-300, 0, 300].map((e, i) => ({ type: 'way', id: 20 + i, tags: { highway: i === 1 ? 'footway' : 'tertiary' }, geometry: [P(-420, e), P(420, e)] })),
  { type: 'way', id: 30, tags: { highway: 'motorway' }, geometry: [P(160, -420), P(160, 420)] },
  { type: 'way', id: 31, tags: { building: 'yes' }, geometry: [P(-250, 100), P(-250, 140), P(-230, 140), P(-230, 100), P(-250, 100)] },
] };
(async () => {
  let opCalls = 0; const op = http.createServer((q, r) => { opCalls++; q.resume(); q.on('end', () => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(FIX)); }); }).listen(3099);
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe });
  const errs = [];
  const join = async (name, n, code) => { const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-US', geolocation: { latitude: LAT + n * M, longitude: LNG, accuracy: 5 }, permissions: ['geolocation'] });
    await ctx.addInitScript(() => { localStorage.setItem('scramQuiet', '1'); const ws = window.WebSocket; window.__msgs = []; window.WebSocket = function (...a) { const s = new ws(...a); s.addEventListener('message', e => { try { window.__msgs.push(JSON.parse(e.data)); } catch {} }); return s; }; window.WebSocket.prototype = ws.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }); });
    const p = await ctx.newPage(); p.ctx = ctx; p.on('pageerror', e => errs.push(name + ': ' + e.message)); p.on('dialog', d => d.accept());
    await p.goto(URL + '/'); await p.waitForSelector('body[data-ready]'); await p.fill('#name', name); await p.check('#agree');
    if (code) { await p.fill('#code', code); await p.click('#btnJoin'); } else await p.click('#btnCreate');
    await p.waitForSelector('#lobbyCode:not(:empty)'); return p; };
  const go = async (p, n) => { await p.ctx.setGeolocation({ latitude: LAT + n * M, longitude: LNG, accuracy: 5 }); await p.evaluate(() => typeof freshFix === 'function' && freshFix()); };
  const H = await join('Hunter', 0); const code = (await H.textContent('#lobbyCode')).trim();
  const A = await join('Ana', 60, code), B = await join('Ben', -150, code);
  await H.waitForFunction(() => S.players.length === 3);
  // ---- boundary drawing
  await H.evaluate(() => sendMsg({ type: 'settings', settings: { mode: 'party' } })); await H.waitForFunction(() => S.settings.mode === 'party');
  await H.evaluate(() => document.getElementById('fieldMap').scrollIntoView()); await H.waitForSelector('#btnDraw');
  await H.tap('#btnDraw'); check(await H.evaluate(() => document.getElementById('modeCorners').classList.contains('on')), '"Tap corners" is the default drawing mode');
  await H.evaluate(([la, ln]) => fieldMap.setView([la, ln], 15), [LAT, LNG]); await sleep(500);
  const box = await H.locator('#fieldMap').boundingBox();
  const px = async (n, e) => H.evaluate(([la, ln]) => { const p = fieldMap.latLngToContainerPoint([la, ln]); return { x: p.x, y: p.y }; }, [LAT + n * M, LNG + e * ML]);
  // freehand: drag a rough loop, gets simplified to <= 50 points
  await H.tap('#modeFree'); { const s = await px(200, -200); await H.mouse.move(box.x + s.x, box.y + s.y); await H.mouse.down();
    for (let k = 0; k <= 80; k++) { const a = k / 80 * 2 * Math.PI, q = await px(200 * Math.cos(a), -200 * Math.sin(a) * 1.2); await H.mouse.move(box.x + q.x, box.y + q.y); } await H.mouse.up(); }
  const nFree = await H.evaluate(() => drawing.length); check(nFree >= 4 && nFree <= 50, `freehand loop simplified to ${nFree} points (<= 50)`);
  await H.tap('#btnClearPts'); await H.tap('#modeCorners');
  const corners = [[-280, -330], [-280, 330], [280, 330], [280, -330]];
  for (const [n, e] of corners) { const q = await px(n, e); await H.touchscreen.tap(box.x + q.x, box.y + q.y); await sleep(300); }
  { const q = await px(120, 150); await H.touchscreen.tap(box.x + q.x, box.y + q.y); await sleep(300); }
  check((await H.textContent('#drawCount')).startsWith('5 pts'), 'tapped 5 points: ' + await H.textContent('#drawCount')); await H.tap('#btnUndoPt');
  check((await H.textContent('#drawCount')).startsWith('4 pts'), 'Undo last point');
  await sleep(300); await H.screenshot({ path: 'shots/v19_corners.png' });
  await H.tap('#btnFinishDraw'); await A.waitForFunction(() => S.field && S.field.poly && S.field.poly.length === 4, null, { timeout: 5000 });
  check(true, 'Close shape -> 4-corner polygon with straight edges');
  // ---- game: power-ups every ~18 s (2 min game), drops on walkable ways
  await H.evaluate(() => sendMsg({ type: 'settings', settings: { hideSec: 0, gameSec: 120, pingSec: 3600 } })); await H.waitForFunction(() => S.settings.gameSec === 120);
  await H.evaluate(() => sendMsg({ type: 'role', id: S.you, role: 'hunter' })); await sleep(200);
  await H.evaluate(() => sendMsg({ type: 'start', force: true })); await A.waitForFunction(() => S.state === 'playing', null, { timeout: 15000 });
  const seen = new Map(); const t0 = Date.now(); let shot = false, hshot = false;
  while (Date.now() - t0 < 60000 && seen.size < 2) { for (const d of await A.evaluate(() => S.drops || [])) seen.set(d.id, d);
    if (seen.size && !shot) { shot = true; await A.evaluate(([la, ln]) => map && map.setView([la, ln], 16), [LAT, LNG]); await sleep(1200); await A.screenshot({ path: 'shots/v19_drops_on_roads.png' }); }
    if (!hshot) { const lk = await H.evaluate(() => (S.drops || []).filter(d => d.locked).length); if (lk) { hshot = true; await H.evaluate(([la, ln]) => map && map.setView([la, ln], 16), [LAT, LNG]); await sleep(1200); await H.screenshot({ path: 'shots/v19_hunter_sees_hider_drop.png' }); } }
    await sleep(500); }
  check(hshot, 'hunter sees a hider drop as a dimmed, locked icon');
  check(opCalls === 1, 'Overpass fetched once for the game');
  const w = Walk.parse(FIX), drops = [...seen.values()].map(d => ({ lat: d.lat, lng: d.lng }));
  check(drops.length >= 2 && drops.every(d => Walk.onWalk(w, d, 0.6)) && drops.every(d => Math.abs(d.lat - (LAT + 160 * M)) > 1e-6), `${drops.length} drops all on walkable ways (never the motorway)`);
  // ---- auto-tag gap -> paused ring -> fallback confirm
  await go(A, 1); await go(H, 0);
  await H.waitForFunction(() => +getComputedStyle(document.getElementById('tagRing')).getPropertyValue('--p') >= 0.35, null, { timeout: 20000 });
  check(await H.evaluate(() => window.gpsBoost === true) && await A.evaluate(() => window.gpsBoost === true), 'both phones in fast-GPS boost while tagging');
  await A.evaluate(() => { window.sendLoc = () => {}; }); // Ana's GPS uploads stop (like the field test)
  await H.waitForSelector('#tagRing.paused', { timeout: 8000 }); check(/Paused/.test(await H.textContent('#tagTxt')), 'ring pauses (does not reset) during the GPS gap');
  await H.screenshot({ path: 'shots/v19_tag_paused.png' });
  await H.waitForSelector('#tagFbBtn:not(.hidden)', { timeout: 12000 }); check(true, 'hunter gets "Tap to confirm tag" after the gap (>= 30%)');
  await H.screenshot({ path: 'shots/v19_confirm_fallback.png' });
  const hm = await H.evaluate(() => window.__msgs.filter(m => /^tag/.test(m.type)).map(JSON.stringify).join(''));
  check(!/lat|lng|Ana/.test(hm), 'tag messages to the hunter carry no position / name');
  await H.tap('#tagFbBtn'); await A.waitForSelector('#tagAsk:not(.hidden)'); check(/Hunter says they tagged you/.test(await A.textContent('#tagAskBy')), 'hider asked "Were you tagged?"');
  await A.screenshot({ path: 'shots/v19_confirm_ask.png' });
  await A.tap('#tagAskYes'); await H.waitForFunction(() => S.players.find(p => p.name === 'Ana').caught, null, { timeout: 5000 }); check(true, 'hider confirms -> tagged');
  check(errs.length === 0, 'no page errors ' + errs.join(' | '));
  op.close(); await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
