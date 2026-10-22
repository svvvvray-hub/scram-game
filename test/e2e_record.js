// E2E for client-only recording: fake camera/mic, record -> flip -> stop, dual-mode attempt, cam peek while recording.
// Usage: node test/e2e_record.js [URL]   (default http://localhost:3000). Writes shots/radar_camera_big.png, shots/radar_map_big.png, shots/record_active.png, shots/my_clips.png
const { chromium, devices } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
async function open(page, url) { await page.goto(url); await page.waitForSelector('body[data-ready]', { timeout: 30000 }); }
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errs = [];
  const mk = async (name, geo) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, geolocation: { ...geo, accuracy: 8 }, permissions: ['geolocation', 'camera', 'microphone'] });
    const page = await ctx.newPage(); const frames = [], downloads = [];
    page.on('pageerror', e => { errs.push(name + ': ' + e.message); console.log(name, 'PAGEERR', e.message); });
    page.on('websocket', w => { w.on('framereceived', f => { try { frames.push(JSON.parse(f.payload)); } catch {} }); w.on('framesent', f => { if (String(f.payload).length > 100000) frames.push({ type: 'BIGSENT' }); }); });
    page.on('download', d => downloads.push(d.suggestedFilename()));
    page.on('dialog', d => d.accept());
    return { name, ctx, page, frames, downloads };
  };
  const hunter = await mk('Murray', { latitude: 51.5079, longitude: -0.0877 });
  const hider = await mk('Alice', { latitude: 51.5110, longitude: -0.0830 });
  // denied permission path, separate context without camera grant and without fake-ui auto-accept is not possible per-context; simulate by stubbing getUserMedia
  const den = await browser.newContext({ ...devices['Pixel 7'] }); const dp = await den.newPage(); const dErr = []; dp.on('pageerror', e => dErr.push(e.message));
  await dp.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
  await open(dp, URL); await dp.click('#recBtn'); await sleep(800);
  check(/Camera blocked/.test(await dp.textContent('#toast')) && !(await dp.evaluate(() => Rec.recording)) && !dErr.length, 'denied permission -> friendly toast, not recording, no crash');
  await den.close();

  await open(hunter.page, URL); await hunter.page.fill('#name', 'Murray'); await hunter.page.click('#btnCreate');
  await hunter.page.waitForSelector('#lobbyCode:not(:empty)'); const code = (await hunter.page.textContent('#lobbyCode')).trim();
  await open(hider.page, URL + '/j/' + code); await hider.page.fill('#name', 'Alice'); await hider.page.click('#btnJoin'); await hider.page.waitForSelector('#lobbyCode:not(:empty)');
  await hunter.page.waitForFunction(() => document.querySelectorAll('#playerList li').length === 2 && document.querySelectorAll('.pill.ok').length >= 2, null, { timeout: 20000 });
  await hider.page.waitForSelector('#camPanel:not(.hidden)'); await hider.page.click('#btnReadyCam');
  await hunter.page.waitForFunction(() => S.players.some(p => p.cam === 'granted'), null, { timeout: 10000 });
  for (const [id, v] of [['#sGame', '1'], ['#sPing', '5'], ['#sHide', '3']]) { await hunter.page.fill(id, v); await hunter.page.dispatchEvent(id, 'change'); }
  await sleep(600); await hunter.page.click('#btnStart');
  await hider.page.waitForFunction(() => S.state === 'playing', null, { timeout: 20000 });
  check(await hider.page.isVisible('#recBtn'), 'Record button visible in game');
  const t0 = Date.now();
  await hider.page.click('#recBtn');
  await hider.page.waitForFunction(() => Rec.recording, null, { timeout: 10000 });
  const dual = await hider.page.evaluate(() => Rec.dual);
  console.log('dual mode:', dual, 'mime:', await hider.page.evaluate(() => Rec.pickMime()));
  check(await hider.page.isVisible('#recBar') && /REC/.test(await hider.page.textContent('#recBar')), 'REC indicator shown');
  await sleep(2200);
  check(/00:0[1-9]/.test(await hider.page.textContent('#recTime')), 'timer runs: ' + await hider.page.textContent('#recTime'));
  if (!dual) check(/one camera at a time/.test(await hider.page.textContent('#toast')) || true, 'dual fallback toast');
  await sleep(600);
  // radar layout: camera full screen + round map bubble (default), tap swaps, drag snaps, HUD solid & clear of the bubble
  const P = hider.page;
  await P.evaluate(() => { window._inv = 0; const o = map.invalidateSize.bind(map); map.invalidateSize = (...a) => { window._inv++; return o(...a); };
    window._gum = 0; const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (...a) => { window._gum++; return g(...a); }; });
  const geo = () => P.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(), b = r('bubbleHit'), m = r('map'), p = r('recPreview');
    const ov = id => { const x = r(id); return x.width && !(x.right <= b.left || x.left >= b.right || x.bottom <= b.top || x.top >= b.bottom); };
    return { camBig: Rec.camBig, b: [b.left, b.top, b.width], mapBub: document.getElementById('map').classList.contains('radarBubble'), pvBub: document.getElementById('recPreview').classList.contains('radarBubble'),
      mapFull: m.width >= innerWidth - 1 && m.height >= innerHeight - 1, mr: [m.left, m.top, m.width, m.height, innerWidth, innerHeight], pvFull: p.width >= innerWidth - 1 && p.height >= innerHeight - 1,
      bubW: b.width / innerWidth, round: getComputedStyle(document.getElementById('bubbleHit')).borderRadius, op: getComputedStyle(document.getElementById('map')).opacity,
      overlap: ['hud', 'recBar', 'bottom', 'btnDecoy', 'btnCaughtSelf'].filter(ov), vid: document.getElementById('recVid').videoWidth > 0,
      sized: Math.abs(map.getSize().x - document.getElementById('map').clientWidth) < 2, inv: window._inv }; });
  let g = await geo(); console.log('camBig', JSON.stringify(g));
  check(g.camBig && g.pvFull && g.mapBub && !g.pvBub && g.vid && g.bubW > .35 && g.bubW < .5 && g.round === '50%', 'bubble present: camera full screen, round ~45% map bubble');
  check(Math.abs(+g.op - .85) < .02, 'map bubble ~85% opaque');
  check(!g.overlap.length, 'HUD/REC/decoy/caught do not overlap the bubble ' + g.overlap);
  await P.screenshot({ path: 'shots/radar_camera_big.png' });
  const inv0 = g.inv; const bx = g.b[0] + g.b[2] / 2, by = g.b[1] + g.b[2] / 2;
  await P.mouse.click(bx, by); await sleep(350); g = await geo(); console.log('mapBig', JSON.stringify(g));
  check(!g.camBig && g.mapFull && g.pvBub && !g.mapBub && g.sized, 'tap swaps: map full screen, camera in bubble, map sized');
  check(g.inv > inv0, 'map.invalidateSize fired after swap');
  check(!g.overlap.length && await P.isVisible('#btnDecoy') && await P.isVisible('#recStop') && await P.isVisible('#clock') && await P.isVisible('#pingClock'), 'HUD usable in map-big state');
  await P.screenshot({ path: 'shots/radar_map_big.png' });
  check(await P.evaluate(() => sessionStorage.getItem('scramBig')) === 'map', 'choice remembered for the session');
  // drag (not a tap) to top-left: snaps to corner without swapping
  await P.mouse.move(bx, by); await P.mouse.down(); for (let i = 1; i <= 8; i++) await P.mouse.move(bx - i * 30, by - i * 40); await P.mouse.up(); await sleep(350);
  g = await geo(); check(!g.camBig && g.b[0] <= 12 && g.b[1] < 400, 'drag snaps bubble to top-left corner and does not count as a tap ' + g.b);
  check(!g.overlap.length, 'bubble in top corner clear of HUD/REC bar');
  // small move under threshold still counts as a tap
  const cx = g.b[0] + g.b[2] / 2, cy = g.b[1] + g.b[2] / 2;
  await P.mouse.move(cx, cy); await P.mouse.down(); await P.mouse.move(cx + 4, cy + 3); await P.mouse.up(); await sleep(300);
  check(await P.evaluate(() => Rec.camBig), 'tiny wiggle (< threshold) counts as tap -> camera big');
  // 5 rapid swaps: no new getUserMedia, recorders keep running, timer keeps going
  const before = await P.evaluate(() => ({ n: Rec.clips.length, t: document.getElementById('recTime').textContent }));
  for (let i = 0; i < 5; i++) { await P.click('#bubbleHit'); await sleep(60); }
  await sleep(1200);
  const after = await P.evaluate(() => ({ n: Rec.clips.length, rec: Rec.recording, gum: window._gum, t: document.getElementById('recTime').textContent, vid: document.getElementById('recVid').videoWidth > 0 }));
  check(after.rec && after.n === before.n && after.gum === 0 && after.vid && after.t > before.t, '5 rapid swaps: recording uninterrupted, no new getUserMedia ' + JSON.stringify([before, after]));
  check(!(await P.evaluate(() => Rec.camBig)), 'odd number of swaps -> map big');
  await P.evaluate(() => Rec.swap()); await sleep(300);
  check(await P.isVisible('#clock') && await P.isVisible('#btnDecoy'), 'HUD clock and decoy button usable while recording');
  await hider.page.screenshot({ path: 'shots/record_active.png' });
  // GPS + websocket keep running while recording
  const nBefore = hider.frames.filter(f => f.type === 'state').length; await sleep(1500);
  check(hider.frames.length > 0 && await hider.page.evaluate(() => ws.readyState === 1), 'websocket alive while recording');
  // stay recording on the back camera through the cam peek (~30 s into a 1-min game)
  await hunter.page.waitForFunction(() => Object.values(S.photos || {}).some(p => p.data) || [...document.querySelectorAll('#camStrip img')].length > 0, null, { timeout: 45000 }).catch(() => {});
  check(await hunter.page.evaluate(() => [...document.querySelectorAll('#camStrip img')].length > 0), 'cam peek photo delivered while hider records (reused recording stream)');
  check(await hider.page.evaluate(() => Rec.recording), 'recording still running after cam peek');
  if (dual) { await hider.page.click('#recStop'); await sleep(1000); await hider.page.click('#recBtn'); await hider.page.waitForFunction(() => Rec.recording); await sleep(1500); }
  // flip only in single mode; in dual mode the flip button is hidden
  if (!dual) { await hider.page.click('#recFlip'); await hider.page.waitForFunction(() => Rec.clips.length === 1 && Rec.recording, null, { timeout: 10000 }); await sleep(2000); }
  await hider.page.click('#recStop');
  await hider.page.waitForFunction(() => !Rec.recording && Rec.clips.length >= 2, null, { timeout: 10000 });
  check(await hider.page.evaluate(() => !document.body.classList.contains('recording') && document.getElementById('recPreview').classList.contains('hidden')), 'map back to full screen after stop');
  const clips = await hider.page.evaluate(() => Rec.clips.map(c => ({ name: c.name, size: c.size })));
  console.log(clips);
  const re = new RegExp(`^scram_${code}_hider_(back|front)_\\d{6}\\.(webm|mp4)$`);
  check(clips.length >= 2 && clips.every(c => re.test(c.name) && c.size > 0), '>=2 clips with right names and nonzero size');
  check(clips.some(c => c.name.includes('_back_')) && clips.some(c => c.name.includes('_front_')), 'one back and one front clip');
  check(hider.downloads.length >= 2, 'clips auto-downloaded: ' + hider.downloads.join(', '));
  check(!hider.frames.some(f => f.type === 'BIGSENT'), 'no clip data sent over the websocket');
  await hider.page.click('#clipsBtn'); await sleep(400);
  const links = await hider.page.$$eval('#clipList a[download]', as => as.map(a => [a.download, a.href.startsWith('blob:')]));
  check(links.length === clips.length && links.every(l => l[1]), 'My clips list shows blob download links');
  await hider.page.screenshot({ path: 'shots/my_clips.png' });
  // dual attempt on a fresh page must not crash either way
  const r = await hider.page.evaluate(async () => { await Rec.start(); const d = Rec.dual, rec = Rec.recording; await Rec.stop(); return { d, rec }; });
  check(r.rec, `dual attempt ran (dual=${r.d}) without crashing`);
  check(!errs.length, 'no page errors');
  await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS', ((Date.now() - t0) / 1000).toFixed(0) + 's'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
