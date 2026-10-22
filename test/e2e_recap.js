// E2E: 2-hunter game with role assignment, catch confirmation, recording segments at the preset bitrate,
// recap (replay, heat map, awards, trophies, share image), automatic highlight reels, group reel, viral 9:16 clip.
// Usage: node test/e2e_recap.js [URL]   (server must be running, default http://localhost:3000)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const URL = process.argv[2] || 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exe = ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find(p => fs.existsSync(p));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
async function open(page, url) { await page.goto(url); await page.waitForSelector('body[data-ready]', { timeout: 30000 }); }
const T0 = Date.now();
(async () => {
  fs.mkdirSync('shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || exe, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  const mk = async (name, geo, ig) => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, geolocation: { ...geo, accuracy: 6 }, permissions: ['geolocation', 'camera', 'microphone'] }); await ctx.addInitScript(() => localStorage.setItem('scramQuiet', '1')); // legacy suites: no role card / coach tips (covered by e2e_v9)
    const page = await ctx.newPage(); const frames = [], downloads = [];
    await page.addInitScript(() => { window.SCRAM_SEG_MS = 3000; });
    page.on('pageerror', e => { errs.push(name + ': ' + e.message); console.log(name, 'PAGEERR', e.message); });
    page.on('websocket', w => w.on('framereceived', f => frames.push(String(f.payload))));
    page.on('download', d => downloads.push(d.suggestedFilename()));
    page.on('dialog', d => d.accept());
    await open(page, URL); await page.fill('#name', name); if (ig) await page.fill('#ig', ig);
    return { name, ctx, page, frames, downloads };
  };
  const base = { latitude: 51.5079, longitude: -0.0877 };
  const murray = await mk('Murray', base, 'https://www.instagram.com/murray.hunts/');
  const alice = await mk('Alice', { latitude: 51.5079, longitude: -0.0877 + 0.0045 }, '@alice_hides'); // ~310 m east; walks to 10 m from Murray mid-game
  const carl = await mk('Carl', { latitude: 51.5106, longitude: -0.0877 });
  const bob = await mk('Bob', { latitude: 51.5110, longitude: -0.0877 });
  await murray.page.check('#agree'); await murray.page.click('#btnCreate'); await murray.page.waitForSelector('#lobbyCode:not(:empty)');
  const code = (await murray.page.textContent('#lobbyCode')).trim();
  for (const p of [alice, carl, bob]) { await p.page.fill('#code', code); await p.page.check('#agree'); await p.page.click('#btnJoin'); await p.page.waitForSelector('#lobbyCode:not(:empty)'); }
  await murray.page.waitForFunction(() => S.players.length === 4 && S.players.every(p => p.perm === 'granted'), null, { timeout: 20000 });
  // roles: Carl -> hunter (2 hunters)
  await murray.page.click(`[data-role="${await murray.page.evaluate(() => S.players.find(p => p.name === 'Carl').id)}"]`);
  await murray.page.waitForFunction(() => S.players.filter(p => p.role === 'hunter').length === 2);
  check(/2 hunters · 🙈 2 hiders/.test(await murray.page.textContent('#roleCounts')), 'role counts: ' + await murray.page.textContent('#roleCounts'));
  check(await murray.page.isChecked('#sBecome'), 'infection toggle on by default');
  check(await murray.page.$$eval('#playerList a.ig', as => as.map(a => a.textContent + '|' + a.href + '|' + a.rel + '|' + a.target).join(',')).then(t => t.includes('@murray.hunts|https://www.instagram.com/murray.hunts/|noopener|_blank') && t.includes('@alice_hides')), 'instagram handles link in lobby');
  for (const [id, v] of [['#sGame', '1'], ['#sPing', '5'], ['#sHide', '0']]) { await murray.page.fill(id, v); await murray.page.dispatchEvent(id, 'change'); }
  await sleep(500); await murray.page.screenshot({ path: 'shots/roles.png', fullPage: true });
  // randomize with 2 hunters keeps 2, then restore Murray+Carl
  await murray.page.fill('#sHunters', '2'); await murray.page.click('#btnRandom'); await sleep(800);
  await murray.page.waitForFunction(() => S.players.filter(p => p.role === 'hunter').length === 2); check(true, 'randomize with 2 hunters -> 2 hunters');
  for (const n of ['Murray', 'Carl', 'Alice', 'Bob']) { const want = n === 'Murray' || n === 'Carl' ? 'hunter' : 'hider';
    const cur = await murray.page.evaluate(n => S.players.find(p => p.name === n), n); if (cur.role !== want) await murray.page.evaluate(([id, r]) => sendMsg({ type: 'role', id, role: r }), [cur.id, want]); }
  await murray.page.waitForFunction(() => ['Murray', 'Carl'].every(n => S.players.find(p => p.name === n).role === 'hunter') && S.players.filter(p => p.role === 'hunter').length === 2);
  // quality sheet + recording (Alice & Murray), 3 s segments for the test
  await alice.page.click('#recQBtn'); await sleep(300);
  check(/Standard/.test(await alice.page.textContent('#recQuality .on')) && /11\.7 MB\/min/.test(await alice.page.textContent('#recQuality')), 'quality presets with MB/min, Standard default');
  await alice.page.screenshot({ path: 'shots/record_quality.png' });
  await alice.page.click('#clipClose');
  await murray.page.click('#btnStart');
  await alice.page.waitForFunction(() => S.state === 'playing', null, { timeout: 15000 });
  for (const p of [alice, murray]) { await p.page.click('#recBtn'); await p.page.locator('#recOk:visible').click({ timeout: 1500 }).catch(() => {}); await p.page.waitForFunction(() => Rec.recording, null, { timeout: 10000 }); }
  const opts = await alice.page.evaluate(() => ({ o: Rec.lastOpts, c: Rec.lastConstraints }));
  check(opts.o.videoBitsPerSecond === 1500000 && opts.o.audioBitsPerSecond === 64000 && opts.c.video.width.ideal === 1280 && opts.c.video.height.ideal === 720 && opts.c.audio.channelCount.ideal === 1, 'preset: 720p, 1.5 Mbps video, 64 kbps mono audio ' + JSON.stringify(opts.o));
  await sleep(2500);
  await alice.ctx.setGeolocation({ latitude: 51.5079, longitude: -0.0877 + 0.000144, accuracy: 6 }); // sneaks 10 m past Murray
  await sleep(1500);
  const wl = await alice.page.evaluate(() => ({ sup: Wake.supported, held: Wake.held, warn: document.getElementById('warn').textContent }));
  check(wl.sup ? true : /wake lock/i.test(wl.warn), `wake lock: supported=${wl.sup} held=${wl.held}`);
  check(!murray.frames.some(f => f.includes('"trails"')) && !murray.frames.slice(-3).some(f => f.includes('alice_hides')), 'no trails / handles during play');
  // Carl (non-host hunter) claims Bob -> Bob confirms
  await carl.page.click('#abCatch'); await carl.page.waitForSelector('#hiderBtns [data-catch]');
  await carl.page.click('#hiderBtns button:has-text("Bob")');
  await bob.page.waitForSelector('#catchBox [data-cy]', { timeout: 10000 }); check(/Carl says they caught you/.test(await bob.page.textContent('#catchBox')), 'Bob gets the catch confirmation prompt');
  await bob.page.click('#catchBox [data-cy]');
  await bob.page.waitForFunction(() => S.players.find(p => p.id === S.you).role === 'hunter', null, { timeout: 10000 });
  check(/now a HUNTER/.test(await bob.page.textContent('#toast')), 'infection: Bob becomes hunter with a toast');
  await murray.page.waitForFunction(() => S.players.find(p => p.name === 'Bob').caught);
  await sleep(9000); // recording keeps rolling -> several 3 s segments
  const parts = await alice.page.evaluate(() => Rec.clips.map(c => c.name));
  check(parts.some(n => /_part2\.(webm|mp4)$/.test(n)) && parts.some(n => /_part3\./.test(n)), 'segments auto-saved: ' + parts.slice(0, 4).join(', '));
  check(alice.downloads.some(n => n.includes('_part2')), 'segment files downloaded');
  for (const p of [alice, murray]) { await p.page.click('#recStop'); await p.page.waitForFunction(() => !Rec.recording); }
  await sleep(800);
  await murray.page.click('#abMore'); await murray.page.click('#btnEnd');
  for (const p of [murray, alice, carl, bob]) await p.page.waitForSelector('#recap:not(.hidden)', { timeout: 15000 });
  const rc = await murray.page.evaluate(() => ({ n: Object.keys(RecapData.trails).length, aw: RecapData.awards.map(a => a.key), tr: RecapData.trophies.map(t => t.key + ':' + t.name), cc: RecapData.closeCalls.map(c => c.text), tl: document.querySelectorAll('#timeline li').length }));
  console.log(rc);
  check(rc.n === 4 && rc.aw.includes('survivor') && rc.aw.includes('closest') && rc.aw.includes('fastest'), 'recap: trails for all 4, awards');
  check(rc.cc.some(t => /walked right past Alice, 1\d m/.test(t)), 'close call detected: ' + rc.cc.join('; '));
  check(rc.tr.includes('closeShave:Alice') && rc.tr.includes('escapeArtist:Alice') && rc.tr.includes('firstBlood:Carl'), 'trophies: ' + rc.tr.join(', '));
  check(rc.tl > 5 && /walked right past/.test(await murray.page.textContent('#timeline')), 'timeline lists events incl. close call');
  check(/@alice_hides/.test(await murray.page.textContent('#timeline')), 'handles shown in recap');
  check(await murray.page.getAttribute('#btnFollow', 'href') === 'https://www.instagram.com/mmmmmray/', 'Follow the creator button');
  // replay
  await murray.page.click('#rPlay'); await sleep(1500);
  const rp = await murray.page.evaluate(() => ({ playing: RecapUI.playing, t: RecapUI.t - RecapData.startedAt, D: RecapData.endedAt - RecapData.startedAt, time: document.getElementById('rTime').textContent }));
  check(rp.playing && rp.t > 0 && rp.t < rp.D, 'replay animates: ' + rp.time);
  await murray.page.evaluate(() => document.getElementById('endMap').scrollIntoView()); await sleep(400);
  await murray.page.screenshot({ path: 'shots/recap.png' });
  await murray.page.evaluate(() => RecapUI.stop());
  await murray.page.evaluate(() => { const s = document.getElementById('rScrub'); s.value = s.max / 2; s.dispatchEvent(new Event('input')); });
  check(await murray.page.evaluate(() => Math.abs(RecapUI.t - (RecapData.startedAt + (RecapData.endedAt - RecapData.startedAt) / 2)) < 1000), 'scrubber seeks');
  await murray.page.check('#rHeat'); await sleep(500);
  const heat = await murray.page.evaluate(() => { const c = document.querySelector('.heatCanvas'); if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let r = 0, b = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 120 && d[i] > d[i + 2]) r++; if (d[i + 2] > 120 && d[i + 2] > d[i]) b++; } return { r, b, pts: RecapUI.heat.points }; });
  check(heat && heat.r > 50 && heat.b > 50, 'heat map draws hunter (red) and hider (blue) areas ' + JSON.stringify(heat));
  await murray.page.evaluate(() => document.getElementById('endMap').scrollIntoView()); await sleep(300);
  await murray.page.screenshot({ path: 'shots/heatmap.png' });
  await murray.page.evaluate(() => document.getElementById('awards').scrollIntoView()); await sleep(200);
  await murray.page.screenshot({ path: 'shots/trophies.png' });
  // share image
  await murray.page.click('#btnShareRecap'); await murray.page.waitForFunction(() => RecapUI.lastImage && RecapUI.lastImage.via, null, { timeout: 10000 });
  const li = await murray.page.evaluate(() => RecapUI.lastImage); console.log('share image', li);
  check(li.w === 1080 && li.h === 1350 && li.size > 20000 && (li.via === 'share' || murray.downloads !== null), 'recap image rendered ' + li.size + ' B via ' + li.via);
  await sleep(500); check(li.via === 'share' || murray.downloads.some(n => /^scram_recap_.*\.png$/.test(n)), 'share fallback downloads the png');
  await murray.page.screenshot({ path: 'shots/recap_share.png' });
  await murray.page.click('#sharePreview');
  // highlight reels (auto-built from each recording phone's own clips)
  for (const p of [alice, murray]) await p.page.waitForFunction(() => Reel.my, null, { timeout: 120000 });
  for (const p of [alice, murray]) { const r = await p.page.evaluate(() => ({ d: Reel.my.durMs, s: Reel.my.size, c: Reel.my.cuts, cuts: Reel.cuts.map(c => c.caption) }));
    check(r.d > 3000 && r.s > 10000 && r.c >= 1, `${p.name} reel: ${(r.d / 1000).toFixed(1)} s, ${r.s} B, cuts ${r.cuts.join(' / ')}`); }
  check(/No clips on this phone/.test(await bob.page.textContent('#reelStatus')), 'phone without clips is skipped gracefully');
  const vd = await alice.page.evaluate(async () => { const v = document.getElementById('reelVid'); if (v.readyState < 1) await new Promise(r => v.onloadedmetadata = r); return { w: v.videoWidth, h: v.videoHeight }; });
  check(vd.w === 1280 && vd.h === 720, 'reel is 720p: ' + JSON.stringify(vd));
  await alice.page.evaluate(() => document.getElementById('reelBox').scrollIntoView()); await alice.page.screenshot({ path: 'shots/highlight_reel.png' });
  // group reel: Alice opts in, host stitches
  await alice.page.click('#btnSendHl'); await alice.page.waitForFunction(() => /Sent \d+ cut/.test(document.getElementById('btnSendHl').textContent), null, { timeout: 20000 });
  await murray.page.waitForFunction(() => S.hlCount >= 1);
  await murray.page.click('#btnGroupReel'); await murray.page.waitForFunction(() => Reel.group, null, { timeout: 120000 });
  const gr = await murray.page.evaluate(() => ({ d: Reel.group.durMs, s: Reel.group.size, players: Reel.group.players, n: Reel.group.cuts }));
  check(gr.d > 3000 && gr.s > 10000 && gr.players.includes('Alice') && gr.players.includes('Murray'), 'group reel includes both: ' + JSON.stringify(gr));
  // viral clip (every player can) — Alice
  await alice.page.click('#btnViral'); await alice.page.waitForFunction(() => Reel.viralOut, null, { timeout: 120000 });
  const vo = await alice.page.evaluate(async () => { const v = document.getElementById('viralVid'); if (v.readyState < 1) await new Promise(r => v.onloadedmetadata = r); return { w: v.videoWidth, h: v.videoHeight, d: Reel.viralOut.durMs, s: Reel.viralOut.size, link: Reel.viralOut.link, first: Reel.viralOut.first, music: Reel.viralOut.music }; });
  check(vo.w === 720 && vo.h === 1280 && vo.d >= 14000 && vo.d <= 40000 && vo.s > 10000, 'viral clip 9:16 720x1280, nonzero duration: ' + JSON.stringify(vo));
  check(/\/play\?ref=alice_hides$/.test(vo.link) && /M AWAY/.test(vo.first), 'viral share link with ref, opens with the close call');
  check(await bob.page.isVisible('#btnViral'), 'Make it viral available to every player');
  await alice.page.evaluate(() => document.getElementById('viralBox').scrollIntoView()); await sleep(300);
  await alice.page.evaluate(() => { const v = document.getElementById('viralVid'); v.currentTime = 1.0; }); await sleep(800);
  await alice.page.screenshot({ path: 'shots/viral_preview.png' });
  // Play again clears the recap
  await murray.page.click('#btnHome'); await murray.page.waitForSelector('#lobby:not(.hidden)');
  check(await murray.page.evaluate(() => !window.RecapData && !Reel.group), 'Play again clears trails, recap and reels');
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await browser.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS', ((Date.now() - T0) / 1000).toFixed(0) + 's'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
