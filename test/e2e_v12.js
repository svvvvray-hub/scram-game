// E2E v12: platform-neutral social handles. Picker + localStorage, pasted-URL detection, per-platform validation,
// TikTok handle on the recap with a platform icon + Follow button, admin "Players' socials" (filter, counts, CSV, delete).
// Server must run with ADMIN_KEY (default 'e2e-admin-key') and a fresh STATS_FILE, real defaults:
// ADMIN_KEY=e2e-admin-key STATS_FILE=/tmp/lp_e2e12.json PORT=3012 node server.js & node test/e2e_v12.js [URL]
const { chromium, devices } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://localhost:3012', KEY = process.env.ADMIN_KEY || 'e2e-admin-key';
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe });
  const errs = [];
  const phone = async (name, lat, ctxIn) => {
    const ctx = ctxIn || await browser.newContext({ ...devices['Pixel 7'], geolocation: { latitude: lat, longitude: -0.0877, accuracy: 6 }, permissions: ['geolocation'] });
    if (!ctxIn) await ctx.addInitScript(() => localStorage.setItem('scramQuiet', '1'));
    const page = await ctx.newPage(); page.on('pageerror', e => errs.push(name + ': ' + e.message)); page.on('dialog', d => d.accept());
    await page.goto(URL + '/'); await page.waitForSelector('body[data-ready]'); await page.fill('#name', name); await page.check('#agree');
    return { ctx, page };
  };
  // ---- join field: label, picker, note, remembered choice, URL detection, validation
  const host = await phone('Murray', 51.5079); const P = host.page;
  check((await P.textContent('label[for=ig]')).trim() === 'Your @ (optional)', 'label "Your @ (optional)"');
  check((await P.$$eval('#platform option', os => os.map(o => o.textContent).join(','))) === 'Instagram,TikTok,X,Snapchat,YouTube,Threads,Facebook', 'platform picker options');
  check(await P.inputValue('#platform') === 'instagram', 'Instagram is the default');
  check((await P.textContent('.igNote')).trim() === 'Optional. Saved so the host can find you.', 'note kept');
  check(!/Instagram/.test(await P.evaluate(() => [...document.querySelectorAll('#home label, #home .note')].map(e => e.textContent).join(' '))), 'no Instagram wording in the field label/note');
  await P.selectOption('#platform', 'x'); check(await P.evaluate(() => localStorage.getItem('scramPlatform')) === 'x', 'choice saved in localStorage');
  await P.fill('#ig', 'not-valid-on-x'); await P.click('#btnCreate'); await P.waitForSelector('#toast.show');
  check(/X handle: letters, numbers and _/.test(await P.textContent('#toast')), 'per-platform validation message: ' + await P.textContent('#toast'));
  await P.fill('#ig', 'https://www.tiktok.com/@Murray.Hunts?lang=en'); await P.dispatchEvent('#ig', 'input');
  check(await P.inputValue('#platform') === 'tiktok', 'pasted TikTok URL switches the picker to TikTok');
  await P.selectOption('#platform', 'instagram'); await P.fill('#ig', '@murray.hunts'); await P.waitForSelector('#toast:not(.show)', { state: 'attached', timeout: 6000 }); await sleep(400);
  await P.screenshot({ path: 'shots/v12_handle_picker.png' });
  await P.selectOption('#platform', 'tiktok');
  await P.click('#btnCreate'); await P.waitForSelector('#lobbyCode:not(:empty)'); const code = (await P.textContent('#lobbyCode')).trim();
  // reload: platform + handle remembered
  const again = await host.ctx.newPage(); await again.goto(URL + '/?x=1'); await again.waitForSelector('body[data-ready]');
  check(await again.inputValue('#platform') === 'tiktok' && await again.inputValue('#ig') === '@murray.hunts', 'platform + handle remembered on reload'); await again.close();
  // joiners on other platforms
  const ana = await phone('Ana', 51.5082); await ana.page.selectOption('#platform', 'snapchat'); await ana.page.fill('#ig', 'ana.snaps');
  await ana.page.fill('#code', code); await ana.page.click('#btnJoin'); await ana.page.waitForSelector('#lobbyCode:not(:empty)');
  const ben = await phone('Ben', 51.5085); await ben.page.fill('#ig', 'https://x.com/Ben_Runs'); await ben.page.fill('#code', code); await ben.page.click('#btnJoin'); await ben.page.waitForSelector('#lobbyCode:not(:empty)');
  await P.waitForFunction(() => S.players.length === 3);
  const links = await P.$$eval('#playerList a.ig', as => as.map(a => a.dataset.platform + '|' + a.href + '|' + a.textContent));
  check(links.includes('tiktok|https://www.tiktok.com/@murray.hunts|TT@murray.hunts') && links.includes('snapchat|https://www.snapchat.com/add/ana.snaps|SC@ana.snaps') && links.includes('x|https://x.com/Ben_Runs|X@Ben_Runs'), 'lobby links per platform with icon: ' + links.join(', '));
  const wire = await P.evaluate(() => S.players.map(p => p.social));
  check(wire.some(s => s && s.handle === 'murray.hunts' && s.platform === 'tiktok'), 'wire carries {handle, platform}');
  // quick game -> recap
  await P.evaluate(() => sendMsg({ type: 'start', force: true })); await P.waitForFunction(() => S.state !== 'lobby', null, { timeout: 15000 });
  await sleep(1500); await P.evaluate(() => sendMsg({ type: 'end' }));
  await P.waitForSelector('#timeline li', { timeout: 20000 }); await sleep(1500);
  const tl = await P.$('#timeline a.ig[data-platform="tiktok"] svg[aria-label="TikTok"]');
  check(!!tl && /@murray\.hunts/.test(await P.textContent('#timeline')), 'recap shows TikTok handle with TikTok icon');
  check(await P.getAttribute('#btnFollow', 'href') === 'https://www.instagram.com/mmmmmray/' && /Follow @mmmmmray on Instagram/.test(await P.textContent('#btnFollow')) && !!(await P.$('#btnFollow svg[aria-label="Instagram"]')), 'Follow button with platform icon');
  await P.evaluate(() => document.getElementById('timeline').scrollIntoView({ block: 'center' })); await sleep(300);
  await P.evaluate(() => { const tlEl = document.getElementById('timeline'); const f = document.getElementById('btnFollow'); window.scrollTo(0, tlEl.getBoundingClientRect().top + scrollY - 40 - Math.max(0, (tlEl.offsetHeight + f.offsetHeight + 60) - innerHeight)); }); await sleep(300);
  await P.screenshot({ path: 'shots/v12_recap_follow.png' });
  // ---- admin
  const actx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const A = await actx.newPage(); A.on('pageerror', e => errs.push('admin: ' + e.message));
  await A.goto(URL + '/admin?key=' + KEY); await A.waitForSelector('#handles');
  check(/Players' socials/.test(await A.textContent('#handles')) && (await A.textContent('#handleCount')).trim() === '3', "Players' socials table + count");
  check(/<th>Platform<\/th>/.test(await A.innerHTML('#handleTable')), 'Platform column');
  check(await A.getAttribute('#handleTable a[href*="tiktok.com"]', 'href') === 'https://www.tiktok.com/@murray.hunts' && await A.getAttribute('#handleTable a[href*="x.com"]', 'href') === 'https://x.com/Ben_Runs', 'handles link to the right platform');
  check((await A.textContent('#platformCounts [data-platform="tiktok"] .pc')).trim() === '1' && (await A.textContent('#platformCounts [data-platform="instagram"] .pc')).trim() === '0', 'per-platform counts');
  await A.selectOption('#platformFilter', 'snapchat'); await A.waitForURL(/platform=snapchat/);
  check((await A.$$('#handleTable tr[data-platform]')).length === 1 && /ana\.snaps/.test(await A.textContent('#handleTable')), 'platform filter');
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('#csvBtn button')]); const csv = fs.readFileSync(await dl.path(), 'utf8');
  check(csv.startsWith('handle,platform,profile_url,') && /ana\.snaps,snapchat,https:\/\/www\.snapchat\.com\/add\/ana\.snaps/.test(csv) && !/murray/.test(csv), 'CSV with platform column (filtered)');
  const all = await (await A.request.get(URL + '/admin/handles.csv')).text(); check(all.trim().split('\r\n').length === 4, '/admin/handles.csv still works');
  await A.goto(URL + '/admin#handles'); await A.evaluate(() => document.getElementById('handles').scrollIntoView()); await sleep(200);
  await A.screenshot({ path: 'shots/v12_admin_socials.png', fullPage: true });
  // delete: confirmation prompt; dismiss keeps the row, accept removes it
  let msg = ''; A.once('dialog', d => { msg = d.message(); d.dismiss(); });
  await A.click('#handleTable tr[data-platform="x"] .delBtn'); await sleep(300);
  check(/Delete @Ben_Runs \(X\)\?/.test(msg) && (await A.$$('#handleTable tr[data-platform]')).length === 3, 'delete asks for confirmation; cancel keeps the row');
  A.once('dialog', d => d.accept()); await Promise.all([A.waitForNavigation(), A.click('#handleTable tr[data-platform="x"] .delBtn')]);
  check(await A.isVisible('#deletedMsg') && (await A.$$('#handleTable tr[data-platform]')).length === 2 && (await A.textContent('#handleCount')).trim() === '2', 'delete removes the handle');
  const anon = await (await fetch(URL + '/admin/handles/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'tiktok', handle: 'murray.hunts' }) })).status;
  check(anon === 401, 'delete without auth -> 401');
  const priv = await (await fetch(URL + '/privacy')).text(), terms = await (await fetch(URL + '/terms')).text();
  check(/social media handle \(e\.g\., Instagram, TikTok, X\)/.test(priv) && /ask us to delete/.test(priv) && /social media handle \(e\.g\., Instagram, TikTok, X\)/.test(terms) && /ask us to delete it/.test(terms), 'privacy + terms are platform-neutral and mention deletion');
  check(!errs.length, 'no page errors ' + errs.join('; '));
  await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
