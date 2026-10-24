// E2E v16: hider mini-tasks. Party mode (tasks on by default), host = hunter, Ana + Ben hide.
// Ana gets math, slide, wire, hold (in that order) and solves each in the real card UI; Ben ignores his task (expires -> noisy).
// Real defaults + test schedule:
// SCRAM_TEST_TASK=math,slide,wire,hold SCRAM_TEST_TASK_AT=1500,14000,27000,40000 PORT=3016 node server.js & node test/e2e_v16.js [URL]
const { chromium, devices } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://localhost:3016';
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const LAT = 37.7596, LNG = -122.4269;
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe });
  const errs = [];
  const ctxFor = async () => { const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-US', geolocation: { latitude: LAT, longitude: LNG, accuracy: 6 }, permissions: ['geolocation'] });
    await ctx.addInitScript(() => { localStorage.setItem('scramQuiet', '1'); window.__vib = []; navigator.vibrate = p => { window.__vib.push(p); return true; };
      const ws = window.WebSocket; window.__msgs = []; window.WebSocket = function (...a) { const s = new ws(...a); s.addEventListener('message', e => { try { window.__msgs.push(JSON.parse(e.data)); } catch {} }); return s; }; window.WebSocket.prototype = ws.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }); });
    return ctx; };
  const join = async (name, code) => { const p = await (await ctxFor()).newPage(); p.on('pageerror', e => errs.push(name + ': ' + e.message)); p.on('dialog', d => d.accept());
    await p.goto(URL + '/'); await p.waitForSelector('body[data-ready]'); await p.fill('#name', name); await p.check('#agree');
    if (code) { await p.fill('#code', code); await p.click('#btnJoin'); } else await p.click('#btnCreate');
    await p.waitForSelector('#lobbyCode:not(:empty)'); return p; };
  const H = await join('Hunter'); const code = (await H.textContent('#lobbyCode')).trim();
  const A = await join('Ana', code), B = await join('Ben', code);
  await H.waitForFunction(() => S.players.length === 3);
  check(await H.evaluate(() => S.settings.tasks) === 'off', 'Classic (real default): tasks off');
  await H.evaluate(() => sendMsg({ type: 'settings', settings: { mode: 'party' } })); await H.waitForFunction(() => S.settings.tasks === 'normal');
  check(true, 'Party: tasks default to Normal');
  await H.evaluate(() => sendMsg({ type: 'settings', settings: { hideSec: 0, mode: 'custom', autoTag: 0 } })); await H.waitForFunction(() => S.settings.hideSec === 0 && S.settings.autoTag === 0); // everyone shares one test GPS spot: keep v17 auto-tag out of this suite
  await H.evaluate(() => sendMsg({ type: 'role', id: S.you, role: 'hunter' })); await sleep(200);
  await H.evaluate(() => sendMsg({ type: 'start', force: true })); await A.waitForFunction(() => S.state === 'playing', null, { timeout: 15000 });
  await sleep(1500);
  const endsAt0 = await H.evaluate(() => S.endsAt);
  // ---- 1. math
  await A.waitForSelector('#taskPill:not(.hidden)', { timeout: 10000 });
  check((await A.evaluate(() => window.__vib.length)) > 0, 'offer gives a short vibrate');
  check(!(await H.evaluate(() => !!S.task || window.__msgs.some(m => m.type === 'taskOffer'))), 'hunter never receives task offers / data');
  await A.screenshot({ path: 'shots/v16_offer.png' });
  await A.click('#taskPill'); await A.waitForSelector('#tkM2');
  await A.screenshot({ path: 'shots/v16_math.png' });
  const probs = await A.evaluate(() => S.task.data.problems);
  for (let i = 0; i < 3; i++) { const p = probs[i]; await A.fill('#tkM' + i, String(p.op === '+' ? p.a + p.b : p.op === '×' ? p.a * p.b : p.a - p.b)); }
  await A.click('#tkSubmit'); await A.waitForFunction(() => window.__msgs.some(m => m.type === 'taskResult'));
  check(await A.evaluate(() => window.__msgs.filter(m => m.type === 'taskResult')[0].ok), 'math solved -> server accepts');
  await H.waitForFunction(e => S.endsAt <= e - 29000, endsAt0); check(true, 'Extra Time: game clock −30 s');
  // ---- 2. slide (dismiss + reopen)
  await A.waitForFunction(() => S.task && S.task.type === 'slide', null, { timeout: 20000 });
  await A.click('#taskPill'); await A.waitForSelector('#tkSlide .tile');
  await A.click('#taskClose'); check(await A.isVisible('#taskPill') && !(await A.isVisible('#taskCard')), 'card can be dismissed (map free), pill stays');
  await A.click('#taskPill'); await A.waitForSelector('#tkSlide .tile');
  await A.screenshot({ path: 'shots/v16_slide.png' });
  const sol = await A.evaluate(() => { const S0 = [1, 2, 3, 4, 5, 6, 7, 8, 0], k = b => b.join(), st = [...document.querySelectorAll('#tkSlide .tile')].map(t => +t.dataset.v);
    const nb = i => [i - 3, i + 3, i % 3 ? i - 1 : -1, i % 3 < 2 ? i + 1 : -1].filter(j => j >= 0 && j < 9); const seen = new Map([[k(st), []]]), q = [st];
    while (q.length) { const b = q.shift(), p = seen.get(k(b)); if (k(b) === k(S0)) return p; const z = b.indexOf(0); for (const j of nb(z)) { const n = b.slice(); n[z] = b[j]; n[j] = 0; if (!seen.has(k(n))) { seen.set(k(n), [...p, b[j]]); q.push(n); } } } });
  for (const v of sol) await A.click(`#tkSlide .tile[data-v="${v}"]`);
  await A.waitForFunction(() => window.__msgs.filter(m => m.type === 'taskResult').length === 2);
  check(await A.evaluate(() => window.__msgs.filter(m => m.type === 'taskResult')[1].ok), `slide solved in ${sol.length} taps -> accepted`);
  // ---- 3. wire (drag)
  await A.waitForFunction(() => S.task && S.task.type === 'wire', null, { timeout: 20000 });
  await A.click('#taskPill'); await A.waitForSelector('#tkWire .plug'); await sleep(200);
  const right = await A.evaluate(() => S.task.data.right);
  const colors = await A.evaluate(() => S.task.data.left);
  for (const [n, c] of colors.entries()) { const a = await A.locator(`#tkWire .L .plug[data-c="${c}"]`).boundingBox(), b = await A.locator(`#tkWire .sock[data-i="${right.indexOf(c)}"]`).boundingBox();
    await A.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await A.mouse.down(); await A.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    if (n === 2) await A.screenshot({ path: 'shots/v16_wire.png' });
    await A.mouse.up(); }
  await A.waitForFunction(() => window.__msgs.filter(m => m.type === 'taskResult').length === 3);
  check(await A.evaluate(() => window.__msgs.filter(m => m.type === 'taskResult')[2].ok), 'wires dragged to matches -> accepted');
  // ---- 4. hold still (server checks GPS)
  await A.waitForFunction(() => S.task && S.task.type === 'hold', null, { timeout: 20000 });
  await A.click('#taskPill'); await A.waitForSelector('#tkHold'); await sleep(1500);
  await A.screenshot({ path: 'shots/v16_hold.png' });
  await A.waitForFunction(() => window.__msgs.filter(m => m.type === 'taskResult').length === 4, null, { timeout: 30000 });
  check(await A.evaluate(() => window.__msgs.filter(m => m.type === 'taskResult')[3].ok), 'held still 20 s -> accepted (server GPS check)');
  // ---- Ben ignored his first task: expired -> noisy
  await B.waitForFunction(() => window.__msgs.some(m => m.type === 'taskResult'), null, { timeout: 30000 });
  const br = await B.evaluate(() => window.__msgs.find(m => m.type === 'taskResult'));
  check(!br.ok && br.reason === 'expired', 'ignored task expires -> failure (next ping noisy)');
  check(!(await H.evaluate(() => window.__msgs.some(m => m.type === 'taskDone') || JSON.stringify(window.__msgs).includes('completed a task'))), 'hunter got no task-completed notification');
  check(errs.length === 0, 'no page errors ' + errs.join(' | '));
  await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
