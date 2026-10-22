// E2E v11: /admin growth dashboard + brake switch. Server must run with ADMIN_KEY (default 'e2e-admin-key'):
// ADMIN_KEY=e2e-admin-key STATS_FILE=/tmp/lp_e2e_stats.json PORT=3010 node server.js & node test/e2e_v11.js [URL]
const { chromium, devices } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://localhost:3010', KEY = process.env.ADMIN_KEY || 'e2e-admin-key';
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const BUSY = 'Last Ping is busy right now. Try again in a few minutes!';
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe });
  const errs = [];
  const phone = async (name, lat, path = '/', ig = '') => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: { latitude: lat, longitude: -0.0877, accuracy: 6 }, permissions: ['geolocation'] });
    await ctx.addInitScript(() => localStorage.setItem('scramQuiet', '1'));
    const page = await ctx.newPage(); page.on('pageerror', e => errs.push(name + ': ' + e.message));
    await page.goto(URL + path); await page.waitForSelector('body[data-ready]'); await page.fill('#name', name); if (ig) await page.fill('#ig', ig); await page.check('#agree');
    return { ctx, page };
  };
  // admin (desktop)
  const actx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const A = await actx.newPage();
  let r = await A.goto(URL + '/admin'); check(r.status() === 401, 'no key -> 401 login form');
  await A.fill('input[name=key]', 'wrong'); await A.click('button'); check((await A.textContent('body')).includes('Wrong key'), 'wrong key rejected');
  await A.fill('input[name=key]', KEY); await A.click('button'); await A.waitForSelector('#kpis');
  check(!(await A.content()).includes(KEY), 'dashboard HTML never contains the key');
  check((await actx.cookies()).some(c => c.name === 'lp_admin' && c.httpOnly && c.value !== KEY), 'HttpOnly cookie set (not the key)');
  const reset = async () => { await A.goto(URL + '/admin'); if (await A.isChecked('#paused')) await A.uncheck('#paused'); await A.fill('#maxGames', '50'); await A.fill('#maxPerHour', '0'); await A.click('#saveBrake'); await A.waitForSelector('.ok'); };
  await reset();
  // sample data: referred players create and join games
  const host = await phone('Host', 51.5079, '/?ref=murray', '@Sunny.Seeker');
  check((await host.page.textContent('.igNote')).trim() === 'Optional. Saved so the host can find you.', 'note under handle field'); await host.page.click('#btnCreate'); await host.page.waitForSelector('#lobbyCode:not(:empty)');
  const code = (await host.page.textContent('#lobbyCode')).trim();
  const p2 = await phone('Ana', 51.508, `/p/${code}?ref=murray`, 'https://instagram.com/ana_hides'); await p2.page.click('#btnJoin'); await p2.page.waitForSelector('#lobbyCode:not(:empty)');
  const h2 = await phone('Ben', 51.509, '/?ref=lena', 'ben.runs_fast'); await h2.page.click('#btnCreate'); await h2.page.waitForSelector('#lobbyCode:not(:empty)');
  const h3 = await phone('Cy', 51.51); await h3.page.click('#btnCreate'); await h3.page.waitForSelector('#lobbyCode:not(:empty)');
  await A.request.get(URL + '/play?ref=murray', { maxRedirects: 0 }); await A.request.get(URL + '/play', { maxRedirects: 0 });
  await host.page.evaluate(() => { trackShare('viral'); trackShare('reel'); trackShare('viral'); });
  await new Promise(r => setTimeout(r, 300));
  // pause new games
  await A.goto(URL + '/admin'); await A.check('#paused'); await A.click('#saveBrake'); await A.waitForSelector('.ok');
  check(/NEW GAMES PAUSED/.test(await A.textContent('body')), 'admin shows paused');
  const busy = await phone('Dee', 51.511); await busy.page.click('#btnCreate');
  await busy.page.waitForSelector('#busyMsg:not(.hidden)');
  check((await busy.page.textContent('#busyMsg')).trim() === BUSY, 'create blocked with friendly busy message');
  check(await busy.page.isVisible('#home'), 'stays on create/join screen');
  await busy.page.screenshot({ path: 'shots/v11_busy.png' });
  // joining an existing game still works while paused (same phone)
  await busy.page.fill('#code', code); await busy.page.click('#btnJoin'); await busy.page.waitForSelector('#lobbyCode:not(:empty)');
  check((await busy.page.textContent('#lobbyCode')).trim() === code && !(await busy.page.isVisible('#busyMsg')), 'join works while paused, busy message cleared');
  // max concurrent: unpause, cap at current count
  await A.goto(URL + '/admin'); await A.uncheck('#paused'); await A.fill('#maxGames', '3'); await A.click('#saveBrake'); await A.waitForSelector('.ok');
  const e = await phone('Eve', 51.512); await e.page.click('#btnCreate'); await e.page.waitForSelector('#busyMsg:not(.hidden)');
  check((await e.page.textContent('#busyMsg')).trim() === BUSY, 'max concurrent games blocks create');
  await e.page.fill('#code', code); await e.page.click('#btnJoin'); await e.page.waitForSelector('#lobbyCode:not(:empty)'); check(true, 'join works at max concurrent');
  // settings can't change via GET or without key
  const g = await (await fetch(URL + '/admin/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }) })).status; check(g === 401, 'POST without key -> 401');
  // dashboard numbers
  await A.goto(URL + '/admin'); await A.fill('#maxGames', '50'); await A.click('#saveBrake'); await A.waitForSelector('.ok');
  const s = await (await A.request.get(URL + '/admin/stats.json')).json();
  check(s.totals.games >= 3 && s.days.at(-1).players >= 5, `counts games=${s.totals.games} players today=${s.days.at(-1).players}`);
  const m = s.refs.find(x => x.ref === 'murray'); check(m && m.players >= 2 && m.games >= 1, 'referrer murray: ' + JSON.stringify(m));
  check(s.playClicks >= 2 && s.shares.viral >= 2 && s.shares.reel >= 1, 'play clicks + shares tracked');
  check(s.live.games >= 3 && s.live.online >= 5, 'live games/players: ' + JSON.stringify(s.live));
  // social handles (admin only)
  check(s.handleCount === 3 && s.handles.some(h => h.handle === 'sunny.seeker' && h.ref === 'murray') && s.handles.some(h => h.handle === 'ben.runs_fast' && h.ref === 'lena'), 'handles in stats.json: ' + JSON.stringify(s.handles));
  check((await fetch(URL + '/admin/handles.csv')).status === 401 && (await fetch(URL + '/admin/stats.json')).status === 401, 'csv/stats.json require auth');
  const pub = (await Promise.all(['/', '/privacy', '/api/rules'].map(p => fetch(URL + p).then(r => r.text())))).join(''); check(!/sunny\.seeker|ben\.runs_fast/.test(pub), 'handles never on public endpoints');
  check(/social media handle[^<]*saved[\s\S]*may be viewed by the game creator/.test(await (await fetch(URL + '/privacy')).text()), 'privacy page discloses saved handles');
  await A.goto(URL + '/admin');
  check(/Players' socials/.test(await A.textContent('#handles')) && (await A.textContent('#handleCount')).trim() === '3', "Players' socials table + count");
  check(await A.getAttribute('#handleTable a[href*="instagram.com/sunny.seeker"]', 'href') === 'https://www.instagram.com/sunny.seeker/', 'handle links to instagram');
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('#csvBtn button')]); const csv = fs.readFileSync(await dl.path(), 'utf8');
  check(csv.startsWith('handle,platform,profile_url,first_seen,last_seen,games,ref') && /sunny\.seeker/.test(csv) && /ana_hides/.test(csv), 'Download CSV works');
  await A.click('#sortGames'); check(/Games ▼/.test(await A.textContent('#handleTable')), 'sortable by games');
  await A.click('#sortLast'); check(/Last seen ▼/.test(await A.textContent('#handleTable')), 'sortable by last seen');
  await A.goto(URL + '/admin'); await A.screenshot({ path: 'shots/v11_admin.png', fullPage: true });
  await reset();
  check(!errs.length, 'no page errors ' + errs.join('; '));
  await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
