// Client-only clip recorder (never uploaded). Exposes window.Rec.
(function () {
  const $ = id => document.getElementById(id);
  const clips = []; let sessions = [], facing = 'environment', dual = false, t0 = 0, tick = null, busy = false;
  const pickMime = () => { if (!window.MediaRecorder) return ''; for (const m of ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m; return ''; };
  const side = f => f === 'user' ? 'front' : 'back';
  const pad = n => String(n).padStart(2, '0');
  const hms = d => pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const ctx = () => { const s = typeof S !== 'undefined' ? S : null, m = s?.players?.find(p => p.id === s.you); return { code: (s?.code || 'nolobby').toString().replace(/\W/g, ''), role: m?.role || 'player' }; };
  // Quality presets (low-memory default). Bitrates are what MediaRecorder is asked for; MB/min is the estimate shown.
  const QUALITY = { saver: { label: 'Saver', w: 854, h: 480, fps: 24, v: 800000 }, standard: { label: 'Standard', w: 1280, h: 720, fps: 30, v: 1500000 }, high: { label: 'High', w: 1920, h: 1080, fps: 30, v: 4000000 } };
  const AUDIO_BPS = 64000;
  const mbPerMin = q => ((QUALITY[q].v + AUDIO_BPS) * 60 / 8 / 1e6);
  let quality = (window.localStorage && localStorage.getItem('scramQ')) || 'standard'; if (!QUALITY[quality]) quality = 'standard';
  const segMs = () => window.SCRAM_SEG_MS || 180000; // auto-save a new file segment every 3 min
  let lastOpts = null, lastConstraints = null;
  const say = t => window.toast ? window.toast(t, 4000) : console.log(t);
  function framesArrive(track, ms = 1500) {
    return new Promise(res => {
      if (track.readyState !== 'live') return res(false);
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = new MediaStream([track]);
      let done = false; const fin = ok => { if (done) return; done = true; v.srcObject = null; res(ok && track.readyState === 'live'); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => fin(true)); else v.onloadeddata = () => fin(true);
      v.play().catch(() => {}); setTimeout(() => fin(v.readyState >= 2), ms);
    });
  }
  // One session per camera; it owns the stream. Segments rotate seamlessly: the next MediaRecorder starts on the
  // same stream BEFORE the previous one is stopped, so there is no gap. Data streams in 1 s chunks (timeslice).
  function startRecorder(stream, f) {
    const s = { stream, facing: f, started: new Date(), part: 0, ctx: ctx() };
    let fin; s.done = new Promise(r => fin = r); s.open = 0;
    s.segEnd = () => { if (--s.open <= 0 && s.stopping) { stream.getTracks().forEach(t => t.stop()); fin(); } };
    newSegment(s); s.timer = setInterval(() => { if (!s.stopping) { const old = s.rec; newSegment(s); try { old.stop(); } catch {} } }, segMs());
    sessions.push(s); return s;
  }
  function newSegment(s) {
    const mime = pickMime(), chunks = [], part = ++s.part, startMs = Date.now(), Q = QUALITY[quality];
    const o = { videoBitsPerSecond: Q.v, audioBitsPerSecond: AUDIO_BPS }; if (mime) o.mimeType = mime;
    let rec; try { rec = new MediaRecorder(s.stream, o); } catch { rec = new MediaRecorder(s.stream, mime ? { mimeType: mime } : undefined); }
    lastOpts = { ...o, quality };
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => { const type = (rec.mimeType || mime || 'video/webm').split(';')[0], blob = new Blob(chunks, { type }); chunks.length = 0;
      if (blob.size) addClip(blob, s, part, startMs, Date.now(), type); s.segEnd(); };
    s.open++; rec.start(1000); s.rec = rec;
  }
  function addClip(blob, s, part, startMs, endMs, type) {
    const { code, role } = s.ctx, ext = type.includes('mp4') ? 'mp4' : 'webm';
    const name = `scram_${code}_${role}_${side(s.facing)}_${hms(s.started)}${part > 1 ? '_part' + part : ''}.${ext}`;
    const st = typeof S !== 'undefined' && S ? S : null;
    const c = { name, blob, url: URL.createObjectURL(blob), size: blob.size, saved: false, startMs, endMs, facing: s.facing, part, round: st?.round ?? -1, code }; clips.push(c);
    const a = document.createElement('a'); a.href = c.url; a.download = name; document.body.appendChild(a);
    try { a.click(); c.saved = true; } catch {} a.remove();
    // Already saved to the phone: drop our copy unless a game round may still want it for the highlight reel.
    if (c.saved && !(st && st.state !== 'lobby')) setTimeout(() => free(c), 30000);
    renderList(); say(`💾 Saved ${name}`);
  }
  // Free blob memory once a clip has been downloaded/shared (the reel calls releaseSaved() when it is done with them).
  function free(c) { if (!c.blob || !c.saved) return; try { URL.revokeObjectURL(c.url); } catch {} c.blob = null; c.url = null; c.freed = true; if ($('clipSheet') && !$('clipSheet').classList.contains('hidden')) renderList(); }
  function releaseSaved() { clips.forEach(free); }
  function gum(f, audio) {
    const Q = QUALITY[quality];
    const c = { video: { facingMode: { ideal: f }, width: { ideal: Q.w }, height: { ideal: Q.h }, frameRate: { ideal: Q.fps, max: 30 } },
      audio: audio ? { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true } : false };
    if (audio || !lastConstraints) lastConstraints = c; return navigator.mediaDevices.getUserMedia(c);
  }
  async function start() {
    if (busy || sessions.length) return; busy = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { say('Recording is not supported in this browser'); return; }
      let main;
      try { main = await gum(facing, true); }
      catch (e) { try { main = await gum(facing, false); say('Mic blocked — recording video only'); } catch (e2) { say('Camera blocked — allow camera access in browser settings to record'); return; } }
      dual = false;
      // dual attempt: second camera while the first is live
      let other = null; const of = facing === 'user' ? 'environment' : 'user';
      try { other = await gum(of, false); } catch {}
      if (other) {
        const mt = main.getVideoTracks()[0], ot = other.getVideoTracks()[0];
        const same = mt.getSettings().deviceId && mt.getSettings().deviceId === ot.getSettings().deviceId;
        const [a, b] = await Promise.all([framesArrive(mt), framesArrive(ot)]);
        if (!same && a && b && mt.readyState === 'live' && ot.readyState === 'live') dual = true;
        else { other.getTracks().forEach(t => t.stop()); other = null; }
      }
      if (main.getVideoTracks()[0].readyState !== 'live') { main.getTracks().forEach(t => t.stop()); main = await gum(facing, true).catch(() => gum(facing, false)); }
      if (!dual) say('This phone allows one camera at a time; use Flip');
      startRecorder(main, facing); if (dual) startRecorder(other, of);
      t0 = Date.now(); tick = setInterval(renderUi, 500); renderUi(); window.Wake?.sync();
    } catch (e) { say('Could not start recording: ' + (e.message || e)); stopAll(); }
    finally { busy = false; }
  }
  async function stopAll() {
    const ss = sessions; sessions = []; clearInterval(tick);
    ss.forEach(s => { s.stopping = true; clearInterval(s.timer); try { if (s.rec.state !== 'inactive') s.rec.stop(); else { s.open = 0; s.segEnd(); } } catch { s.open = 0; s.segEnd(); } });
    renderUi(); await Promise.all(ss.map(s => s.done)); window.Wake?.sync();
  }
  async function flip() {
    if (busy || !sessions.length) return; busy = true;
    try {
      const nf = facing === 'user' ? 'environment' : 'user';
      if (dual) { await stopAll(); facing = nf; busy = false; return start(); }
      await stopAll(); facing = nf;
      let st; try { st = await gum(facing, true); } catch { st = await gum(facing, false); }
      startRecorder(st, facing); t0 = Date.now(); tick = setInterval(renderUi, 500);
    } catch { say('Could not switch camera'); }
    finally { busy = false; renderUi(); }
  }
  function renderUi() {
    const on = sessions.length > 0; $('recBtn').classList.toggle('hidden', on); $('recBar').classList.toggle('hidden', !on);
    if (on) { const s = Math.floor((Date.now() - t0) / 1000); $('recTime').textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
      $('recMode').textContent = dual ? 'DUAL' : side(facing).toUpperCase(); $('recFlip').classList.toggle('hidden', dual); }
    document.body.classList.toggle('inGame', !$('game').classList.contains('hidden'));
    if (document.body.classList.contains('recording') !== on) { document.body.classList.toggle('recording', on); $('recPreview').classList.toggle('hidden', !on); layout(); setTimeout(fixMap, 50); }
    $('recPreview').classList.toggle('hidden', !on); setPreview(); if (on) { layout(); centerBubble(); }
    $('clipsBtn').classList.toggle('hidden', !clips.length); $('clipsBtn').textContent = `🎞 ${clips.length}`;
  }
  function renderList() {
    $('clipList').innerHTML = clips.length ? '' : '<li class="note">No clips yet</li>';
    renderQuality();
    clips.forEach(c => {
      const li = document.createElement('li');
      if (c.freed) { li.innerHTML = `<span class="nm mono"></span><span class="note">✓ saved · memory freed</span>`; li.querySelector('.nm').textContent = c.name; $('clipList').appendChild(li); return; }
      li.innerHTML = `<span class="nm mono"></span><span class="note">${(c.size / 1024).toFixed(0)} KB</span>`;
      li.querySelector('.nm').textContent = c.name;
      const a = document.createElement('a'); a.href = c.url; a.download = c.name; a.textContent = '⬇ Download'; a.className = 'small dl'; a.onclick = () => { c.saved = true; setTimeout(() => { if (!(typeof S !== 'undefined' && S && S.state !== 'lobby')) free(c); }, 30000); };
      li.appendChild(a);
      const file = window.File ? new File([c.blob], c.name, { type: c.blob.type }) : null;
      if (file && navigator.canShare?.({ files: [file] })) { const b = document.createElement('button'); b.className = 'small'; b.textContent = '↗ Share';
        b.onclick = () => navigator.share({ files: [file], title: c.name }).then(() => { c.saved = true; if (!(typeof S !== 'undefined' && S && S.state !== 'lobby')) free(c); }).catch(() => {}); li.appendChild(b); }
      $('clipList').appendChild(li);
    });
    renderUi();
  }
  function renderQuality() {
    const box = $('recQuality'); if (!box) return;
    box.innerHTML = Object.entries(QUALITY).map(([k, q]) => `<button class="small ${k === quality ? 'on' : ''}" data-q="${k}">${q.label}<br><span class="note">${q.h}p · ${(q.v / 1e6).toFixed(1)} Mbps · ≈${mbPerMin(k).toFixed(1)} MB/min</span></button>`).join('');
    for (const b of box.querySelectorAll('[data-q]')) b.onclick = () => { quality = b.dataset.q; try { localStorage.setItem('scramQ', quality); } catch {} renderQuality(); say(`🎚 ${QUALITY[quality].label}: ${QUALITY[quality].h}p, ≈${mbPerMin(quality).toFixed(1)} MB/min${sessions.length ? ' (applies to the next recording)' : ''}`); };
    $('qEst').textContent = `Audio 64 kbps mono. New file every ${Math.round(segMs() / 60000) || '<1'} min (…_part2, _part3). ${sessions.length ? 'Change applies to the next recording.' : ''}`;
  }
  // radar layout: camBig (default) = camera full screen + map bubble; else map full + camera bubble. Remembered per session.
  const ss = window.sessionStorage; let camBig = ss?.getItem('scramBig') !== 'map', corner = ss?.getItem('scramCorner') || 'br';
  function layout() {
    const on = document.body.classList.contains('recording'), map_ = $('map'), pv = $('recPreview'), hit = $('bubbleHit');
    map_.classList.toggle('radarBubble', on && camBig); pv.classList.toggle('radarBubble', on && !camBig); const inG = !$('game').classList.contains('hidden'); hit.classList.toggle('hidden', !on || !inG);
    if (!on || document.body.classList.contains('dragging')) return;
    const st = document.body.style, vw = innerWidth, vh = innerHeight, hud = $('hud').getBoundingClientRect(), bot = $('bottom').getBoundingClientRect();
    const hudB = $('game').classList.contains('hidden') ? 0 : Math.max(hud.bottom, $('banner').getBoundingClientRect().bottom, $('oob').getBoundingClientRect().bottom);
    st.setProperty('--dockTop', (hudB + 6) + 'px');
    const top = $('recDock').getBoundingClientRect().bottom + 8, bottom = ($('game').classList.contains('hidden') || !bot.height ? vh : bot.top) - 8;
    const size = Math.max(90, Math.min(vw * .45, bottom - top)), r = corner[1] === 'r';
    st.setProperty('--top', top + 'px'); st.setProperty('--bs', size + 'px');
    st.setProperty('--bx', (r ? vw - size - 10 : 10) + 'px'); st.setProperty('--by', (corner[0] === 'b' ? bottom - size : top) + 'px');
  }
  function centerBubble() { try { if (camBig && map && typeof myLoc !== 'undefined' && myLoc) map.setView([myLoc.lat, myLoc.lng], Math.max(map.getZoom(), 16), { animate: false }); } catch {} }
  function swap() {
    camBig = !camBig; try { ss?.setItem('scramBig', camBig ? 'cam' : 'map'); } catch {}
    document.body.classList.add('swapAnim'); layout(); fixMap(); centerBubble();
    clearTimeout(swap.t); swap.t = setTimeout(() => { document.body.classList.remove('swapAnim'); fixMap(); centerBubble(); }, 200);
  }
  function bubbleDrag(hit) {
    let d = null; const TH = 10;
    hit.addEventListener('pointerdown', e => { d = { x: e.clientX, y: e.clientY, moved: false, bx: parseFloat(document.body.style.getPropertyValue('--bx')), by: parseFloat(document.body.style.getPropertyValue('--by')) }; hit.setPointerCapture?.(e.pointerId); e.preventDefault(); });
    hit.addEventListener('pointermove', e => { if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < TH) return; d.moved = true; document.body.classList.add('dragging');
      document.body.style.setProperty('--bx', (d.bx + dx) + 'px'); document.body.style.setProperty('--by', (d.by + dy) + 'px'); });
    const up = e => { if (!d) return; const m = d.moved, x = e.clientX, y = e.clientY; d = null; document.body.classList.remove('dragging');
      if (!m) return swap();
      corner = (y < innerHeight / 2 ? 't' : 'b') + (x < innerWidth / 2 ? 'l' : 'r'); try { ss?.setItem('scramCorner', corner); } catch {}
      document.body.classList.add('swapAnim'); layout(); setTimeout(() => { document.body.classList.remove('swapAnim'); fixMap(); }, 200); };
    hit.addEventListener('pointerup', up); hit.addEventListener('pointercancel', e => { d && (d.moved = true); up(e); });
  }
  addEventListener('resize', () => { layout(); fixMap(); });
  function fixMap() { try { if (typeof map !== 'undefined' && map) map.invalidateSize(); if (typeof fieldMap !== 'undefined' && fieldMap) fieldMap.invalidateSize(); } catch {} }
  function setPreview() {
    const back = sessions.find(x => x.facing === 'environment'), front = sessions.find(x => x.facing === 'user');
    const big = dual ? (back || front) : sessions[0], small = dual ? (big === back ? front : back) : null;
    const set = (el, s) => { const st = s ? new MediaStream(s.stream.getVideoTracks()) : null; if (el._s !== s) { el._s = s; el.srcObject = st; if (st) el.play().catch(() => {}); } };
    set($('recVid'), big); set($('recPip'), small); $('recPip').classList.toggle('hidden', !small);
    $('recVid').style.transform = big?.facing === 'user' ? 'scaleX(-1)' : '';
  }
  // grab a frame from the live back camera (for the minute-10 cam peek)
  function backStream() { const s = sessions.find(x => x.facing === 'environment' && x.stream.getVideoTracks()[0]?.readyState === 'live'); return s ? s.stream : null; }
  window.addEventListener('beforeunload', e => { if (sessions.length || clips.some(c => !c.saved)) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('DOMContentLoaded', init); if (document.readyState !== 'loading') init();
  function init() {
    if (init.done || !$('recBtn')) return; init.done = true;
    // one-time (per session) recording-consent notice before the first recording
    $('recBtn').onclick = () => { if (ss?.getItem('scramRecOk')) return start(); $('recNotice').classList.remove('hidden'); };
    $('recOk').onclick = () => { try { ss?.setItem('scramRecOk', '1'); } catch {} $('recNotice').classList.add('hidden'); start(); };
    $('recCancel').onclick = () => $('recNotice').classList.add('hidden'); $('recStop').onclick = stopAll; $('recFlip').onclick = flip;
    $('clipsBtn').onclick = $('recQBtn').onclick = () => { renderList(); $('clipSheet').classList.remove('hidden'); };
    bubbleDrag($('bubbleHit')); $('clipClose').onclick = () => $('clipSheet').classList.add('hidden'); renderUi(); setInterval(() => document.body.classList.toggle('inGame', !$('game').classList.contains('hidden')), 500);
  }
  window.Rec = { start, stop: stopAll, flip, backStream, clips, releaseSaved, free, QUALITY, mbPerMin, get quality() { return quality; }, set quality(q) { if (QUALITY[q]) quality = q; }, get lastOpts() { return lastOpts; }, get lastConstraints() { return lastConstraints; }, get segments() { return sessions.map(s => s.part); }, get recording() { return sessions.length > 0; }, get dual() { return dual; }, pickMime, swap, get camBig() { return camBig; } };
})();
