// Client-only clip recorder (never uploaded). Exposes window.Rec.
(function () {
  const $ = id => document.getElementById(id);
  const clips = []; let sessions = [], facing = 'environment', dual = false, t0 = 0, tick = null, busy = false;
  const pickMime = () => { if (!window.MediaRecorder) return ''; for (const m of ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m; return ''; };
  const side = f => f === 'user' ? 'front' : 'back';
  const pad = n => String(n).padStart(2, '0');
  const hms = d => pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const ctx = () => { const s = typeof S !== 'undefined' ? S : null, m = s?.players?.find(p => p.id === s.you); return { code: (s?.code || 'nolobby').toString().replace(/\W/g, ''), role: m?.role || 'player' }; };
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
  function startRecorder(stream, f) {
    const mime = pickMime(), chunks = [], started = new Date();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const s = { rec, stream, facing: f, started };
    s.done = new Promise(res => {
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
        const blob = new Blob(chunks, { type }); if (blob.size) addClip(blob, f, started, type); res(); };
    });
    rec.start(1000); sessions.push(s); return s;
  }
  function addClip(blob, f, started, type) {
    const { code, role } = ctx(), ext = type.includes('mp4') ? 'mp4' : 'webm';
    const name = `scram_${code}_${role}_${side(f)}_${hms(started)}.${ext}`;
    const c = { name, blob, url: URL.createObjectURL(blob), size: blob.size, saved: false }; clips.push(c);
    const a = document.createElement('a'); a.href = c.url; a.download = name; document.body.appendChild(a);
    try { a.click(); c.saved = true; } catch {} a.remove();
    renderList(); say(`💾 Saved ${name}`);
  }
  async function gum(f, audio) { return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: f } }, audio }); }
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
      t0 = Date.now(); tick = setInterval(renderUi, 500); renderUi();
    } catch (e) { say('Could not start recording: ' + (e.message || e)); stopAll(); }
    finally { busy = false; }
  }
  async function stopAll() {
    const ss = sessions; sessions = []; clearInterval(tick);
    ss.forEach(s => { try { s.rec.state !== 'inactive' ? s.rec.stop() : s.stream.getTracks().forEach(t => t.stop()); } catch {} });
    renderUi(); await Promise.all(ss.map(s => s.done));
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
    clips.forEach(c => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="nm mono"></span><span class="note">${(c.size / 1024).toFixed(0)} KB</span>`;
      li.querySelector('.nm').textContent = c.name;
      const a = document.createElement('a'); a.href = c.url; a.download = c.name; a.textContent = '⬇ Download'; a.className = 'small dl'; a.onclick = () => { c.saved = true; };
      li.appendChild(a);
      const file = window.File ? new File([c.blob], c.name, { type: c.blob.type }) : null;
      if (file && navigator.canShare?.({ files: [file] })) { const b = document.createElement('button'); b.className = 'small'; b.textContent = '↗ Share';
        b.onclick = () => navigator.share({ files: [file], title: c.name }).then(() => { c.saved = true; }).catch(() => {}); li.appendChild(b); }
      $('clipList').appendChild(li);
    });
    renderUi();
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
    $('recBtn').onclick = start; $('recStop').onclick = stopAll; $('recFlip').onclick = flip;
    $('clipsBtn').onclick = () => { renderList(); $('clipSheet').classList.remove('hidden'); };
    bubbleDrag($('bubbleHit')); $('clipClose').onclick = () => $('clipSheet').classList.add('hidden'); renderUi(); setInterval(() => document.body.classList.toggle('inGame', !$('game').classList.contains('hidden')), 500);
  }
  window.Rec = { start, stop: stopAll, flip, backStream, clips, get recording() { return sessions.length > 0; }, get dual() { return dual; }, pickMime, swap, get camBig() { return camBig; } };
})();
