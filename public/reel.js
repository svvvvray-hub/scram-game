// Automatic highlight reel, built entirely in the browser (no server video processing).
// Picks moments from THIS phone's own clips (recording timestamps vs game event times), cuts ~4 s around each,
// and re-records them through a canvas + MediaRecorder at 720p / ~2 Mbps with title card, captions, crossfades and a trophy card.
// Optional group reel: opted-in players upload only their short cuts; the host's phone stitches them in event-time order.
(function () {
  const $ = id => document.getElementById(id);
  const W = 1280, H = 720, BPS = 2000000, FPS = 30, PRE = 2500, POST = 1500, XF = 300;
  let my = null, group = null, building = false, myCuts = [], builtRound = -1;
  const st = () => (typeof S !== 'undefined' ? S : null);
  const off = () => (typeof offset !== 'undefined' ? offset : 0); // server clock - local clock
  const say = (t, ms) => window.toast ? window.toast(t, ms || 4000) : console.log(t);
  const pickMime = () => { for (const m of ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; return ''; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(r));

  // clips (still in memory) whose recording time overlaps this round
  const roundClips = R => (window.Rec?.clips || []).filter(c => c.blob && c.endMs >= R.startedAt - off() && c.startMs <= R.endedAt - off());
  // ---- moment picking ----
  function moments(R, meId) {
    const out = [], me = R.players.find(p => p.id === meId); if (!me) return out;
    const nm = id => (R.players.find(p => p.id === id) || {}).name || '?';
    for (const e of R.log) {
      if (e.k === 'catch' && e.id === meId) out.push({ t: e.t, caption: 'CAUGHT!', sub: e.by ? `by ${nm(e.by)}` : '' });
      else if (e.k === 'catch' && e.by === meId) out.push({ t: e.t, caption: 'GOTCHA!', sub: `caught ${nm(e.id)}` });
      else if (e.k === 'close' && (e.hider === meId || e.hunter === meId)) out.push({ t: e.t, caption: `CLOSE CALL - ${e.d} m`, sub: e.hider === meId ? `${nm(e.hunter)} walked right past` : `just missed ${nm(e.hider)}` });
      else if (e.k === 'decoy' && e.id === meId) out.push({ t: e.t, caption: 'DECOY!', sub: 'fake ping armed' });
      else if (e.k === 'bounty' && e.id === meId) out.push({ t: e.t, caption: 'BOUNTY!', sub: 'claimed the 💰' });
      else if (e.k === 'chime' && (e.ids || []).includes(meId)) out.push({ t: e.t, caption: 'CHIME!', sub: 'a hunter was within 40 m' });
    }
    out.push({ t: R.endedAt - 2000, caption: 'FINAL 30 s', sub: R.winner === 'hiders' ? 'hiders win' : 'hunters win', final: true });
    return out.sort((a, b) => a.t - b.t);
  }
  // map server-time moments onto local clips; merge overlaps; ~4 s windows
  function cutsFor(R, meId, clips) {
    const cs = [];
    for (const m of moments(R, meId)) {
      const lt = m.t - off();
      let c = clips.find(c => c.blob && c.startMs <= lt - 500 && c.endMs >= lt);
      if (!c && m.final) c = clips.filter(c => c.blob && c.endMs >= R.endedAt - off() - 30000 && c.endMs <= R.endedAt - off() + 60000).at(-1); // any footage in the final 30 s
      if (!c) continue;
      const center = Math.min(lt, c.endMs - POST), a = Math.max(c.startMs, center - PRE), b = Math.min(c.endMs, a + PRE + POST);
      if (b - a < 800) continue;
      const prev = cs.at(-1);
      if (prev && prev.clip === c && a <= prev.b + 300) { prev.b = Math.max(prev.b, b); prev.caption += ' + ' + m.caption; continue; }
      cs.push({ clip: c, a, b, t: m.t, caption: m.caption, sub: m.sub });
    }
    return cs.slice(0, 10);
  }
  // ---- drawing ----
  function cover(g, v, zoom = 1, fx = .5, fy = .5) { const W = g.canvas.width, H = g.canvas.height, vw = v.videoWidth || W, vh = v.videoHeight || H, k = Math.max(W / vw, H / vh) * zoom, w = vw * k, h = vh * k; g.drawImage(v, (W - w) * fx, (H - h) * fy, w, h); }
  function card(g, lines, sub) {
    const W = g.canvas.width, H = g.canvas.height;
    const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#111827'); gr.addColorStop(1, '#4c1d95'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = '800 92px system-ui, sans-serif'; g.fillText(lines[0], W / 2, 270);
    g.font = '40px system-ui, sans-serif'; lines.slice(1).forEach((l, i) => { g.fillStyle = i ? '#d1d5db' : '#fbbf24'; g.fillText(l, W / 2, 360 + i * 56); });
    if (sub) { g.font = '600 30px system-ui, sans-serif'; g.fillStyle = '#f472b6'; g.textAlign = 'right'; g.fillText(sub, W - 36, H - 36); }
    g.textAlign = 'left';
  }
  function overlay(g, cut, who) {
    const W = g.canvas.width, H = g.canvas.height;
    g.fillStyle = '#0009'; g.fillRect(0, 0, W, 70); g.fillStyle = '#fff'; g.font = '600 34px system-ui, sans-serif'; g.fillText(who, 24, 47);
    if (cut.caption) { g.font = '900 80px system-ui, sans-serif'; g.textAlign = 'center'; g.lineWidth = 8; g.strokeStyle = '#000'; g.strokeText(cut.caption, W / 2, H - 120); g.fillStyle = /CAUGHT|GOTCHA/.test(cut.caption) ? '#f87171' : '#fde047'; g.fillText(cut.caption, W / 2, H - 120);
      if (cut.sub) { g.font = '600 36px system-ui, sans-serif'; g.lineWidth = 6; g.strokeText(cut.sub, W / 2, H - 64); g.fillStyle = '#fff'; g.fillText(cut.sub, W / 2, H - 64); } g.textAlign = 'left'; }
  }
  // ---- builder: one canvas stream, one recorder for the full reel (+ optional per-cut recorders for upload) ----
  function makeStudio(audio, W = 1280, H = 720, bps = BPS) {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const stream = c.captureStream(FPS), v = document.createElement('video'); v.playsInline = true; v.muted = !audio; v.crossOrigin = 'anonymous';
    let actx = null;
    let dst = null, clipGain = null;
    if (audio) try { actx = new (window.AudioContext || window.webkitAudioContext)(); const src = actx.createMediaElementSource(v); dst = actx.createMediaStreamDestination(); clipGain = actx.createGain(); src.connect(clipGain).connect(dst); dst.stream.getAudioTracks().forEach(t => stream.addTrack(t)); } catch { actx = null; v.muted = true; }
    const snap = document.createElement('canvas'); snap.width = W; snap.height = H;
    const mime = pickMime();
    const rec = (opts = {}) => { const chunks = [], r = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: bps, audioBitsPerSecond: 64000, ...opts });
      r.ondataavailable = e => e.data.size && chunks.push(e.data); const done = new Promise(res => r.onstop = () => res(new Blob(chunks, { type: (r.mimeType || mime || 'video/webm').split(';')[0] })));
      r.start(500); r.t0 = performance.now(); return { r, done, stop: () => { r.stop(); return done; } }; };
    async function hold(ms, drawFn) { const t0 = performance.now(); while (performance.now() - t0 < ms) { drawFn((performance.now() - t0) / ms); await frame(); } g.globalAlpha = 1; snap.getContext('2d').drawImage(c, 0, 0); }
    async function loadAt(url, sec) {
      v.src = url; await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('video load failed')); setTimeout(res, 4000); });
      if (sec > 0.05) { v.currentTime = sec; await new Promise(res => { v.onseeked = res; setTimeout(res, 3000); }); }
      if (v.currentTime < sec - 0.6) { v.muted = true; await v.play().catch(() => {}); while (v.currentTime < sec - 0.1 && !v.ended) await frame(); v.pause(); v.muted = !audio || !actx; } // un-seekable webm: play forward
    }
    async function playSeg(url, fromSec, durSec, drawOver, zoomFn) {
      await loadAt(url, fromSec); const startCT = v.currentTime; actx?.resume?.(); await v.play().catch(() => {});
      const t0 = performance.now();
      while (!v.ended && v.currentTime - startCT < durSec && performance.now() - t0 < durSec * 1000 + 2500) {
        const el = performance.now() - t0; g.globalAlpha = 1; cover(g, v, zoomFn ? zoomFn(el / 1000 / durSec) : 1); drawOver && drawOver(el / 1000 / durSec);
        if (el < XF) { g.globalAlpha = 1 - el / XF; g.drawImage(snap, 0, 0); g.globalAlpha = 1; } // quick crossfade from the previous shot
        await frame();
      }
      v.pause(); snap.getContext('2d').drawImage(c, 0, 0); return (performance.now() - t0) / 1000;
    }
    const fadeCard = (ms, lines, sub) => hold(ms, k => { card(g, lines, sub); if (k < XF / ms) { g.globalAlpha = 1 - k * ms / XF; g.drawImage(snap, 0, 0); g.globalAlpha = 1; } });
    return { c, g, stream, v, rec, hold, playSeg, fadeCard, get actx() { return actx; }, get dst() { return dst; }, get clipGain() { return clipGain; }, close() { stream.getTracks().forEach(t => t.stop()); try { actx?.close(); } catch {} v.removeAttribute('src'); v.load?.(); } };
  }
  const dateStr = R => new Date(R.startedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const credit = () => `Game by @${window.CREATOR_IG || 'mmmmmray'}`;
  function finalLines(R) {
    const tro = R.trophies.slice(0, 4).map(t => `${t.icon} ${t.title} · ${t.name}`), igs = R.players.filter(p => p.ig).map(p => '@' + p.ig).join('  ');
    return ['🏆 Trophies', ...(tro.length ? tro : ['GG!']), ...(igs ? [igs] : [])];
  }
  async function buildMine(auto) {
    const R = window.RecapData, s = st(); if (!R || building) return;
    const meP = R.players.find(p => p.id === s?.you), clips = roundClips(R);
    if (!clips.length) { $('reelStatus').textContent = '📵 No clips on this phone for this round — record during the game (⏺ Record) to get a highlight reel.'; return; }
    const cuts = cutsFor(R, s.you, clips);
    if (!cuts.length) { $('reelStatus').textContent = 'No highlight moments overlap your recordings this round.'; return; }
    if (document.visibilityState !== 'visible') { $('reelStatus').textContent = 'Keep this page in the foreground to build your reel.'; return; }
    building = true; const t0 = performance.now(); $('btnReel').disabled = true;
    $('reelStatus').textContent = `🎬 Building your reel from ${cuts.length} moment${cuts.length > 1 ? 's' : ''} (takes about real time — keep this page open)…`;
    const who = `${meP.name} · ${meP.startRole === 'hunter' ? '🔦 hunter' : '🙈 hider'}`;
    const studio = makeStudio(true), full = studio.rec(); myCuts = [];
    try {
      await studio.fadeCard(1600, ['🏃 SCRAM', `Lobby ${R.code} · ${dateStr(R)}`, who], credit());
      for (const [i, cut] of cuts.entries()) {
        $('reelStatus').textContent = `🎬 Cut ${i + 1}/${cuts.length}: ${cut.caption}…`;
        const part = studio.rec({ audioBitsPerSecond: 48000 }), dur = (cut.b - cut.a) / 1000;
        const played = await studio.playSeg(cut.clip.url, (cut.a - cut.clip.startMs) / 1000, dur, () => overlay(studio.g, cut, who));
        const blob = await part.stop(); myCuts.push({ blob, t: cut.t, dur: Math.min(10, played), caption: cut.caption, name: meP.name, src: cut });
      }
      await studio.fadeCard(2600, finalLines(R), credit());
      const blob = await full.stop(); studio.close();
      my = { blob, url: URL.createObjectURL(blob), durMs: performance.now() - t0, cuts: cuts.length, size: blob.size, name: `scram_reel_${R.code}_${meP.name.replace(/\W/g, '')}.webm`, round: R.round };
      $('reelVid').src = my.url; $('reelVid').classList.remove('hidden'); ['btnReelSave', 'btnReelShare'].forEach(id => $(id).classList.remove('hidden'));
      $('reelStatus').textContent = `✅ Reel ready · ${cuts.length} moment${cuts.length > 1 ? 's' : ''} · ${(my.durMs / 1000).toFixed(1)} s · ${(blob.size / 1048576).toFixed(1)} MB`;
      $('hlConsent').classList.remove('hidden'); $('btnSendHl').classList.toggle('hidden', !myCuts.length); builtRound = R.round;
    } catch (e) { studio.close(); $('reelStatus').textContent = '⚠️ Could not build the reel: ' + (e.message || e); }
    finally { building = false; $('btnReel').disabled = false; renderGroup(); }
  }
  async function sendHighlights() {
    if (!myCuts.length) return say('Build your reel first');
    if (!confirm('Send ONLY your short highlight cuts (each under 10 s, max ~15 MB total) to the host for a group reel? They are kept in server memory for this lobby only and deleted after 30 min or at Play again.')) return;
    const toData = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
    let tot = 0; const cuts = [];
    for (const c of myCuts) { if (c.blob.size > 3 * 1048576 || tot + c.blob.size > 15 * 1048576) continue; tot += c.blob.size; cuts.push({ data: await toData(c.blob), t: c.t, dur: c.dur, caption: c.caption }); }
    if (!cuts.length) return say('Cuts are too large to send');
    sendMsg({ type: 'hlUpload', cuts }); $('btnSendHl').disabled = true; $('btnSendHl').textContent = '📨 Sending…';
  }
  async function buildGroup() { if (building) return; $('groupStatus').textContent = 'Fetching everyone\'s cuts…'; sendMsg({ type: 'hlFetch' }); }
  async function stitch(players) {
    const R = window.RecapData; if (!R) return;
    const s = st(), all = [];
    for (const p of players) for (const c of p.cuts) all.push({ ...c, name: p.name, url: c.data });
    if (!players.some(p => p.id === s.you)) for (const c of myCuts) all.push({ ...c, url: null, blob: c.blob }); // host's own cuts stay local
    if (!all.length) { $('groupStatus').textContent = 'No highlight cuts yet — players can tap “Send my highlights to host”.'; return; }
    all.sort((a, b) => a.t - b.t);
    building = true; const t0 = performance.now(); $('btnGroupReel').disabled = true;
    const studio = makeStudio(true), full = studio.rec(), urls = [];
    try {
      const names = [...new Set(all.map(c => c.name))];
      await studio.fadeCard(1600, ['👥 SCRAM group reel', `Lobby ${R.code} · ${dateStr(R)}`, names.join(' · ')], credit());
      for (const [i, c] of all.entries()) {
        $('groupStatus').textContent = `🎞 ${i + 1}/${all.length}: ${c.name} — ${c.caption}`;
        const url = c.blob ? URL.createObjectURL(c.blob) : URL.createObjectURL(await (await fetch(c.url)).blob()); urls.push(url);
        await studio.playSeg(url, 0, Math.min(10, c.dur + 0.5), null); // captions are already burned into each cut
      }
      await studio.fadeCard(2600, finalLines(R), credit());
      const blob = await full.stop(); studio.close(); urls.forEach(u => URL.revokeObjectURL(u));
      group = { blob, url: URL.createObjectURL(blob), durMs: performance.now() - t0, cuts: all.length, players: names, size: blob.size, name: `scram_group_reel_${R.code}.webm` };
      $('groupVid').src = group.url; $('groupVid').classList.remove('hidden'); ['btnGroupSave', 'btnGroupShare'].forEach(id => $(id).classList.remove('hidden'));
      $('groupStatus').textContent = `✅ Group reel · ${all.length} cuts from ${names.join(', ')} · ${(group.durMs / 1000).toFixed(1)} s`;
    } catch (e) { studio.close(); $('groupStatus').textContent = '⚠️ Group reel failed: ' + (e.message || e); }
    finally { building = false; $('btnGroupReel').disabled = false; }
  }
  function renderGroup() { const s = st(); const host = s && s.you === s.host && s.state === 'ended'; $('groupBox').classList.toggle('hidden', !host);
    if (host && !building && !group) $('groupStatus').textContent = `${s.hlCount || 0} player${s.hlCount === 1 ? '' : 's'} sent highlights`; }
  async function saveOrShare(o, share) {
    if (!o) return; const file = new File([o.blob], o.name, { type: o.blob.type });
    if (share && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: o.name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = document.createElement('a'); a.href = o.url; a.download = o.name; document.body.appendChild(a); a.click(); a.remove(); say('⬇ ' + o.name);
  }
  function onMsg(m) {
    if (m.type === 'hlAck') { $('btnSendHl').disabled = !m.ok; $('btnSendHl').textContent = m.ok ? `✅ Sent ${m.n} cut${m.n === 1 ? '' : 's'} to host` : '📨 Send my highlights to host'; if (!m.ok) say(m.error || 'Upload failed'); }
    else if (m.type === 'hlAll') stitch(m.players);
  }
  function clear() { if (viralOut) { URL.revokeObjectURL(viralOut.url); viralOut = null; $('viralVid').removeAttribute('src'); $('viralVid').classList.add('hidden'); $('btnViralSave').classList.add('hidden'); $('btnViralShare').classList.add('hidden'); $('viralStatus').textContent = ''; }
    for (const o of [my, group]) if (o) URL.revokeObjectURL(o.url); my = group = null; myCuts = []; builtRound = -1;
    for (const id of ['reelVid', 'groupVid']) { $(id).removeAttribute('src'); $(id).classList.add('hidden'); }
    for (const id of ['btnReelSave', 'btnReelShare', 'btnGroupSave', 'btnGroupShare', 'btnSendHl', 'hlConsent']) $(id).classList.add('hidden');
    $('btnSendHl').disabled = false; $('btnSendHl').textContent = '📨 Send my highlights to host'; $('reelStatus').textContent = ''; }
  // auto-build when the recap arrives and this phone has clips from the round
  setInterval(() => { const R = window.RecapData, s = st();
    if (s && s.state === 'ended' && !$('end').classList.contains('hidden')) renderGroup();
    if (!R || building || builtRound === R.round || window.Rec?.recording || document.visibilityState !== 'visible' || $('end').classList.contains('hidden')) return;
    builtRound = R.round; if (roundClips(R).length) buildMine(true); else $('reelStatus').textContent = '📵 No clips on this phone for this round — record during the game to get an automatic highlight reel.'; }, 1000);

  // ---------- "Make it viral": vertical 9:16 720x1280, 15-30 s, ~2.5 Mbps, best moment first ----------
  const VW = 720, VH = 1280, VBPS = 2500000, BPM = 120, BEAT = 60 / BPM;
  const rank = m => /CAUGHT|GOTCHA/.test(m.caption) ? 5 : m.close && m.d < 15 ? 4 : m.close ? 3.5 : /DECOY/.test(m.caption) ? 3 : /BOUNTY/.test(m.caption) ? 2 : 1;
  function viralCaption(R, m, meId) {
    const e = m.ev || {}, nm = id => ((R.players.find(p => p.id === id) || {}).name || '?').toUpperCase();
    if (e.k === 'catch') return e.id === meId ? `CAUGHT AT ${Recap.clock(e.t - R.startedAt)}` : `GOT ${nm(e.id)} 🎯`;
    if (e.k === 'close') return e.hider === meId ? `HE WAS ${e.d} M AWAY 😳` : `${nm(e.hider)} WAS ${e.d} M AWAY 😳`;
    if (e.k === 'decoy') return 'DECOY WORKED 👻';
    if (e.k === 'bounty') return 'BOUNTY GRABBED 💰';
    if (e.k === 'chime') return 'THEY WERE RIGHT THERE 🔔';
    return 'FINAL SECONDS ⏱';
  }
  function music(actx, dst, beats) { // procedural synth + drum loop (no samples, no copyrighted music)
    const out = actx.createGain(); out.gain.value = 0.55; out.connect(dst); const t0 = actx.currentTime + 0.05;
    const noise = actx.createBuffer(1, actx.sampleRate * 0.2, actx.sampleRate); const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const bass = [55, 55, 65.4, 49];
    for (let b = 0; b < beats; b++) { const t = t0 + b * BEAT;
      const k = actx.createOscillator(), kg = actx.createGain(); k.frequency.setValueAtTime(150, t); k.frequency.exponentialRampToValueAtTime(40, t + 0.12); kg.gain.setValueAtTime(0.9, t); kg.gain.exponentialRampToValueAtTime(0.001, t + 0.25); k.connect(kg).connect(out); k.start(t); k.stop(t + 0.3);
      for (const h of [0, 0.5]) { const n = actx.createBufferSource(), hg = actx.createGain(), f = actx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000; n.buffer = noise; hg.gain.setValueAtTime(b % 2 && !h ? 0.35 : 0.15, t + h * BEAT); hg.gain.exponentialRampToValueAtTime(0.001, t + h * BEAT + 0.06); n.connect(f).connect(hg).connect(out); n.start(t + h * BEAT); n.stop(t + h * BEAT + 0.08); }
      const o = actx.createOscillator(), og = actx.createGain(); o.type = 'sawtooth'; o.frequency.value = bass[Math.floor(b / 4) % 4]; og.gain.setValueAtTime(0.12, t); og.gain.exponentialRampToValueAtTime(0.001, t + BEAT * 0.9); o.connect(og).connect(out); o.start(t); o.stop(t + BEAT);
    }
    return out;
  }
  function miniMap(g, R, t, meId, x, y, r) {
    g.save(); g.beginPath(); g.arc(x, y, r, 0, 7); g.closePath(); g.fillStyle = '#0b1220e6'; g.fill(); g.lineWidth = 6; g.strokeStyle = '#fff'; g.stroke(); g.clip();
    const pts = []; for (const tr of Object.values(R.trails)) for (const q of tr) pts.push(q);
    if (pts.length) { let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity; for (const q of pts) { s = Math.min(s, q[1]); n = Math.max(n, q[1]); w = Math.min(w, q[2]); e = Math.max(e, q[2]); }
      const k = Math.cos((s + n) / 2 * Math.PI / 180), sc = Math.min(1.5 * r / (((e - w) * k) || 1e-4), 1.5 * r / ((n - s) || 1e-4)), P = (la, lo) => [x + (lo - (w + e) / 2) * k * sc, y - (la - (s + n) / 2) * sc];
      for (const [id, tr] of Object.entries(R.trails)) { const col = window.RecapUI?.colors?.[id] || '#fff', past = tr.filter(q => q[0] <= t); if (!past.length) continue;
        g.strokeStyle = col; g.globalAlpha = .6; g.lineWidth = 4; g.beginPath(); past.forEach((q, i) => { const [a, b] = P(q[1], q[2]); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke(); g.globalAlpha = 1;
        const p = Recap.posAt(tr, t) || { lat: past.at(-1)[1], lng: past.at(-1)[2] }, [a, b] = P(p.lat, p.lng); g.fillStyle = col; g.beginPath(); g.arc(a, b, id === meId ? 13 : 10, 0, 7); g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke(); } }
    g.restore();
  }
  function bigCaption(g, text, k) { // pop-in animated caption
    const W = g.canvas.width, sc = k < .15 ? 0.6 + k / .15 * 0.5 : k < .25 ? 1.1 - (k - .15) : 1;
    g.save(); g.translate(W / 2, 520); g.rotate(-0.04); g.scale(sc, sc); g.textAlign = 'center'; g.font = '900 76px system-ui, sans-serif';
    const words = text.split(' '), lines = []; let cur = ''; for (const w of words) { if (g.measureText(cur + ' ' + w).width > W - 80 && cur) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; } lines.push(cur);
    lines.forEach((l, i) => { const y = i * 86; g.lineWidth = 14; g.strokeStyle = '#000'; g.strokeText(l, 0, y); g.fillStyle = i % 2 ? '#fde047' : '#fff'; g.fillText(l, 0, y); });
    g.restore();
  }
  async function viral() {
    const R = window.RecapData, s = st(); if (!R || building) return;
    const meP = R.players.find(p => p.id === s?.you) || R.players[0];
    // sources: my own clips (raw, best for a vertical crop) -> my captioned cuts -> the group reel
    const clips = roundClips(R);
    const PRI = { catch: 5, close: 4, decoy: 3, bounty: 2, chime: 1 }, mine = e => [e.id, e.by, e.hider, e.hunter, ...(e.ids || [])].includes(s.you);
    const evOf = m => R.log.filter(e => PRI[e.k] && mine(e) && Math.abs(e.t - m.t) < 4000).sort((x, y) => PRI[y.k] - PRI[x.k])[0] || { k: 'final', t: m.t };
    let shots = [];
    if (clips.length) shots = cutsFor(R, s.you, clips).map(c => ({ url: c.clip.url, from: (c.a - c.clip.startMs) / 1000, len: (c.b - c.a) / 1000, t: c.t, caption: c.caption }));
    else if (myCuts.length) shots = myCuts.map(c => ({ blob: c.blob, from: 0, len: c.dur, t: c.t, caption: c.caption }));
    else if (group) shots = [{ blob: group.blob, from: 1.6, len: Math.max(3, group.durMs / 1000 - 5), t: R.endedAt - 2000, caption: 'FINAL' }];
    if (!shots.length) { $('viralStatus').textContent = '📵 No clips or highlight cuts on this phone — record during the game to make a viral clip.'; return; }
    for (const sh of shots) { sh.ev = evOf(sh); sh.close = sh.ev.k === 'close'; sh.d = sh.ev.d; sh.caption = viralCaption(R, sh, s.you); sh.score = rank({ ...sh, caption: sh.ev.k === 'catch' ? 'CAUGHT' : sh.ev.k === 'decoy' ? 'DECOY' : sh.ev.k === 'bounty' ? 'BOUNTY' : '' }); }
    shots.sort((a, b) => b.score - a.score || a.t - b.t);
    // beat-synced quick cuts: best moment first (4 beats = 2 s), then 3-6 beat cuts until 15-27 s of footage
    const plan = []; let total = 0, i = 0, guard = 0;
    while ((total < 15 - 3 || i < shots.length) && total < 27 && guard++ < 40) {
      const sh = shots[i % shots.length], beats = plan.length === 0 ? 4 : [3, 4, 6, 4][plan.length % 4], dur = Math.min(beats * BEAT, sh.len);
      const rep = Math.floor(i / shots.length), from = sh.from + Math.min(Math.max(0, sh.len - dur), rep * 0.7);
      plan.push({ ...sh, from, dur: Math.max(1, dur), key: plan.length === 0 }); total += Math.max(1, dur); i++;
      if (i >= shots.length && total >= 15 - 3) break;
    }
    building = true; $('btnViral').disabled = true; const t0 = performance.now();
    $('viralStatus').textContent = `🔥 Making your vertical clip (${plan.length} cuts, ~${Math.round(total + 3)} s, takes about real time)…`;
    const studio = makeStudio(true, VW, VH, VBPS), g = studio.g; let mus = null, urls = [];
    const useMusic = $('vMusic').checked;
    if (useMusic && studio.actx) { try { await studio.actx.resume(); mus = music(studio.actx, studio.dst, Math.ceil((total + 4) / BEAT)); studio.clipGain.gain.value = 1; } catch {} }
    const duck = (lvl) => { if (mus) mus.gain.setTargetAtTime(lvl, studio.actx.currentTime, 0.08); };
    const full = studio.rec({ videoBitsPerSecond: VBPS });
    try {
      for (const [n, sh] of plan.entries()) {
        const url = sh.url || (urls[urls.length] = URL.createObjectURL(sh.blob));
        duck(sh.key ? 0.18 : 0.4); // duck the soundtrack under the clip audio, hardest on the key moment
        const evT = sh.ev.t;
        await studio.playSeg(url, sh.from, sh.dur, k => {
          if (sh.key || n % 2 === 0) bigCaption(g, sh.caption, k);
          miniMap(g, R, evT, s.you, VW - 150, 230, 120);
          const left = Math.max(0, (R.endsAt || R.endedAt) - evT); g.font = '800 44px ui-monospace, monospace'; g.textAlign = 'left'; g.lineWidth = 8; g.strokeStyle = '#000';
          g.strokeText('⏱ ' + Recap.clock(left), 30, 90); g.fillStyle = left < 30000 ? '#f87171' : '#fff'; g.fillText('⏱ ' + Recap.clock(left), 30, 90);
          g.font = '600 32px system-ui, sans-serif'; g.strokeText(`${meP.name} · ${meP.startRole === 'hunter' ? '🔦' : '🙈'}`, 30, VH - 60); g.fillStyle = '#fff'; g.fillText(`${meP.name} · ${meP.startRole === 'hunter' ? '🔦' : '🙈'}`, 30, VH - 60);
        }, sh.key ? k => 1 + 0.45 * Math.min(1, k * 1.6) : k => 1.05 + 0.08 * k); // punch-in zoom on the key moment
      }
      duck(0.7);
      const link = shareLink(meP.ig);
      await studio.hold(3000, k => { const gr = g.createLinearGradient(0, 0, 0, VH); gr.addColorStop(0, '#111827'); gr.addColorStop(1, '#7c3aed'); g.fillStyle = gr; g.fillRect(0, 0, VW, VH);
        g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = '900 96px system-ui, sans-serif'; g.fillText('SCRAM', VW / 2, 430); g.font = '700 54px system-ui, sans-serif'; g.fillStyle = '#fde047'; g.fillText('Play free →', VW / 2, 560);
        g.font = '600 34px system-ui, sans-serif'; g.fillStyle = '#fff'; g.fillText(link.replace(/^https?:\/\//, ''), VW / 2, 625);
        g.font = '600 36px system-ui, sans-serif'; g.fillStyle = '#f472b6'; g.fillText(`Game by @${window.CREATOR_IG || 'mmmmmray'}`, VW / 2, 820); if (meP.ig) { g.fillStyle = '#fff'; g.fillText('@' + meP.ig, VW / 2, 880); } g.textAlign = 'left'; });
      const blob = await full.stop(); studio.close(); urls.forEach(u => u && URL.revokeObjectURL(u));
      if (viralOut) URL.revokeObjectURL(viralOut.url);
      viralOut = { blob, url: URL.createObjectURL(blob), durMs: performance.now() - t0, w: VW, h: VH, cuts: plan.length, size: blob.size, name: `scram_viral_${R.code}_${meP.name.replace(/\W/g, '')}.webm`, link, music: !!mus, first: plan[0].caption };
      $('viralVid').src = viralOut.url; $('viralVid').classList.remove('hidden'); ['btnViralSave', 'btnViralShare'].forEach(id => $(id).classList.remove('hidden'));
      $('viralStatus').textContent = `✅ ${VW}×${VH} · ${(viralOut.durMs / 1000).toFixed(1)} s · ${plan.length} cuts · opens with “${plan[0].caption}”`;
    } catch (e) { studio.close(); $('viralStatus').textContent = '⚠️ Could not make the clip: ' + (e.message || e); }
    finally { building = false; $('btnViral').disabled = false; }
  }
  let viralOut = null;
  const shareLink = ig => (window.SHARE_LINK || location.origin + '/play') + (ig ? '?ref=' + encodeURIComponent(ig) : '');
  async function shareViral() {
    const o = viralOut; if (!o) return; const file = new File([o.blob], o.name, { type: o.blob.type });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Scram', text: `Play free at ${o.link}` }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    saveOrShare(o, false);
  }
  function init() {
    $('btnViral').onclick = viral; $('btnViralSave').onclick = () => saveOrShare(viralOut, false); $('btnViralShare').onclick = shareViral;
    $('btnReel').onclick = () => buildMine(false); $('btnSendHl').onclick = sendHighlights; $('btnGroupReel').onclick = buildGroup;
    $('btnReelSave').onclick = () => saveOrShare(my, false); $('btnReelShare').onclick = () => saveOrShare(my, true);
    $('btnGroupSave').onclick = () => saveOrShare(group, false); $('btnGroupShare').onclick = () => saveOrShare(group, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.Reel = { viral, get viralOut() { return viralOut; }, shareLink, buildMine, buildGroup, onMsg, clear, moments, cutsFor, get my() { return my; }, get group() { return group; }, get cuts() { return myCuts; }, get building() { return building; } };
})();
