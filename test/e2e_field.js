// E2E for the playing field: host sets a 0.25 mi circle + draws a polygon by tapping (touch), other clients
// receive and render it; start-with-outside prompt; in-game boundary; out-of-bounds banner + auto-reveal.
// Usage: node test/e2e_field.js [URL]   (default http://localhost:3000). Writes shots/field_*.png etc.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const { offsetM } = require('../server');
const Field = require('../public/field');
const URL = process.argv[2] || 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
async function open(page, url) { await page.goto(url); const b = page.locator('button:has-text("Enter site")'); if (await b.count()) await b.first().click(); await page.waitForSelector('body[data-ready]', { timeout: 30000 }); }
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe });
  const base = { lat: 51.5079, lng: -0.0877 };
  const inside = offsetM(base, 120, 200), outside = offsetM(base, 900, 45);
  const dialogs = [];
  const mk = async (name, p) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: { latitude: p.lat, longitude: p.lng, accuracy: 8 }, permissions: ['geolocation'] }); await ctx.addInitScript(() => localStorage.setItem('scramQuiet', '1')); // legacy suites: no role card / coach tips (covered by e2e_v9)
    const page = await ctx.newPage(); const frames = [];
    page.on('pageerror', e => { console.log(name, 'PAGEERR', e.message); fails++; });
    page.on('websocket', w => w.on('framereceived', f => { try { frames.push(JSON.parse(f.payload)); } catch {} }));
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
    return { name, ctx, page, frames };
  };
  const host = await mk('Murray', base), alice = await mk('Alice', inside), bob = await mk('Bob', outside);
  await open(host.page, URL); await host.page.fill('#name', 'Murray'); await host.page.check('#agree'); await host.page.click('#btnCreate');
  await host.page.waitForSelector('#lobbyCode:not(:empty)'); const code = await host.page.textContent('#lobbyCode');
  for (const p of [alice, bob]) { await open(p.page, URL + '/j/' + code); await p.page.fill('#name', p.name); await p.page.check('#agree'); await p.page.click('#btnJoin'); await p.page.waitForSelector('#lobbyCode:not(:empty)'); }
  await host.page.waitForFunction(() => document.querySelectorAll('#playerList li').length === 3 && document.querySelectorAll('.pill.ok').length >= 3, null, { timeout: 20000 });
  check(await host.page.evaluate(() => S.field === null && document.querySelector('#fieldRadius [data-r="0"]').classList.contains('on')), 'default is No boundary');
  check(await alice.page.isHidden('#fieldPanel'), 'non-host sees no field panel while there is no boundary');
  await host.page.click('#btnQuick'); await sleep(300);
  // (a) radius preset
  await host.page.locator('#fieldPanel').scrollIntoViewIfNeeded();
  await host.page.tap('#fieldRadius [data-r="402"]');
  await alice.page.waitForFunction(() => S.field && S.field.circle, null, { timeout: 5000 });
  const c = await alice.page.evaluate(() => S.field.circle);
  check(c.r === 402 && Math.abs(c.lat - base.lat) < 1e-4 && Math.abs(c.lng - base.lng) < 1e-4, `0.25 mi circle centered on host GPS (r=${c.r})`);
  for (const p of [alice, bob]) {
    await p.page.waitForFunction(() => document.querySelectorAll('#fieldMap path.leaflet-interactive, #fieldMap path').length >= 2, null, { timeout: 5000 });
    check(await p.page.isVisible('#fieldMap'), `${p.name} renders the circle on the lobby map`);
  }
  await host.page.waitForFunction(() => [...document.querySelectorAll('#playerList .pill.out')].length === 1, null, { timeout: 5000 });
  check(true, 'lobby marks Bob as outside the field');
  await sleep(1200); await host.page.locator('#fieldMap').scrollIntoViewIfNeeded(); await host.page.screenshot({ path: 'shots/field_radius.png' });
  // drag-free recenter check via "Center on me" (host is already the center) — just must keep center
  await host.page.tap('#btnCenterMe'); await sleep(300);
  // (b) draw: tap 5 corners with touch
  await host.page.tap('#btnDraw');
  const corners = [[-250, -300], [-250, 300], [150, 350], [300, 0], [150, -350]].map(([n, e]) => offsetM(offsetM(base, Math.abs(n), n < 0 ? 180 : 0), Math.abs(e), e < 0 ? 270 : 90));
  await host.page.evaluate(() => fieldMap.setView([S.field.circle.lat, S.field.circle.lng], 15));
  await sleep(500);
  const box = await host.page.locator('#fieldMap').boundingBox();
  for (const q of corners) {
    const pt = await host.page.evaluate(([la, ln]) => { const p = fieldMap.latLngToContainerPoint([la, ln]); return { x: p.x, y: p.y }; }, [q.lat, q.lng]);
    await host.page.touchscreen.tap(box.x + pt.x, box.y + pt.y); await sleep(350);
  }
  check((await host.page.textContent('#drawCount')).startsWith('5 pts'), 'touch taps added 5 points');
  await host.page.tap('#btnUndoPt'); check((await host.page.textContent('#drawCount')).startsWith('4 pts'), 'Undo point removes one');
  { const q = corners[4]; const pt = await host.page.evaluate(([la, ln]) => { const p = fieldMap.latLngToContainerPoint([la, ln]); return { x: p.x, y: p.y }; }, [q.lat, q.lng]); await host.page.touchscreen.tap(box.x + pt.x, box.y + pt.y); await sleep(350); }
  await sleep(300); await host.page.screenshot({ path: 'shots/field_draw.png' });
  await host.page.tap('#btnFinishDraw');
  await bob.page.waitForFunction(() => S.field && S.field.poly && S.field.circle, null, { timeout: 5000 });
  const f = await bob.page.evaluate(() => S.field);
  check(f.poly.length === 5 && f.circle.r === 402, 'others receive circle + 5-point polygon');
  check(f.poly.every((p, i) => Field.distM({ lat: p[0], lng: p[1] }, corners[i]) < 15), 'polygon points match the tapped spots (<15 m)');
  for (const p of [alice, bob]) {
    const n = await p.page.evaluate(() => document.querySelectorAll('#fieldMap path').length);
    check(n >= 4, `${p.name} renders circle + shape + shading (${n} paths)`);
    check((await p.page.textContent('#fieldSummary')).includes('inside both'), `${p.name} sees intersection summary`);
  }
  await sleep(1000); await host.page.locator('#fieldMap').scrollIntoViewIfNeeded(); await host.page.screenshot({ path: 'shots/field_draw.png' });
  // start: Bob outside -> prompt listing Bob, accepted -> start anyway
  for (const [id, v] of [['#sGame', '1'], ['#sPing', '5'], ['#sHide', '0']]) { await host.page.fill(id, v); await host.page.dispatchEvent(id, 'change'); }
  await sleep(500);
  await host.page.click('#btnStart');
  await host.page.waitForFunction(() => S.state === 'playing', null, { timeout: 10000 });
  check(dialogs.some(d => /Outside the playing field: Bob/.test(d) && !/Alice/.test(d)), 'start prompt lists only Bob as outside; start anyway works');
  await alice.page.waitForSelector('#game:not(.hidden)');
  check(await alice.page.evaluate(() => document.querySelectorAll('#map path').length >= 4), 'boundary rendered on the in-game map');
  await sleep(1500); await host.page.screenshot({ path: 'shots/ingame_boundary.png' });
  await bob.page.waitForSelector('#oob:not(.hidden)', { timeout: 5000 });
  check(/OUT OF BOUNDS/.test(await bob.page.textContent('#oob')), 'Bob sees out-of-bounds banner');
  check(await alice.page.isHidden('#oob'), 'Alice (inside) has no banner');
  const bobId = await bob.page.evaluate(() => S.you);
  await host.page.waitForFunction(() => S.events.some(e => /Bob stayed out of bounds/.test(e.text)), null, { timeout: 10000 });
  check(true, 'grace (30 s scaled; 2 s min) elapsed -> Bob flagged for reveal');
  const n0 = host.frames.filter(x => x.type === 'ping').length;
  for (let i = 0; i < 160 && host.frames.filter(x => x.type === 'ping').length <= n0; i++) await sleep(100);
  const pg = host.frames.filter(x => x.type === 'ping')[n0];
  check(pg && pg.locs[bobId] && Field.distM(pg.locs[bobId], outside) < 1, 'next ping reveals Bob to hunters');
  // walk back in -> banner clears
  await bob.ctx.setGeolocation({ latitude: inside.lat, longitude: inside.lng, accuracy: 8 });
  await bob.page.waitForSelector('#oob.hidden', { state: 'attached', timeout: 20000 });
  check(true, 'banner clears when Bob returns inside');
  await host.page.click('#abMore'); await host.page.click('#btnEnd');
  for (const p of [host, alice, bob]) { await p.page.waitForSelector('#end:not(.hidden)'); await p.page.click('#btnHome'); }
  await host.page.waitForSelector('#lobby:not(.hidden)');
  check(await host.page.evaluate(() => S.field && S.field.poly.length === 5), 'field persists across Play again');
  await host.page.tap('#btnRemoveShape'); await alice.page.waitForFunction(() => S.field && !S.field.poly && S.field.circle);
  check(true, 'host can edit the field between rounds');
  await host.page.tap('#fieldRadius [data-r="0"]'); await alice.page.waitForFunction(() => S.field === null);
  check(await alice.page.isHidden('#fieldPanel'), 'No boundary restores the default');
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL E2E FIELD CHECKS PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
