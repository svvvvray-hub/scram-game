// End-of-game recap screen: animated replay, heat map, awards, trophies, timeline, share image. Exposes window.RecapUI.
// Trails only arrive from the server after the round has ended.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const HID = ['#3b82f6', '#a855f7', '#14b8a6', '#eab308', '#ec4899', '#22c55e', '#06b6d4', '#8b5cf6'], HUN = ['#f97316', '#ef4444', '#fb923c', '#dc2626', '#f59e0b'];
  let R = null, layer = null, heat = null, t = 0, playing = false, raf = 0, lastDraw = 0, lastImage = null, fitted = -1;
  const col = {};
  const clk = ms => Recap.clock(ms);
  const pname = id => (R.players.find(p => p.id === id) || {}).name || '?';
  function set(r) {
    R = r; window.RecapData = r; if (!r) return;
    let a = 0, b = 0; for (const p of r.players) col[p.id] = p.startRole === 'hunter' ? HUN[a++ % HUN.length] : HID[b++ % HID.length];
    t = r.endedAt; fitted = -1;
    if (!$('end').classList.contains('hidden')) render();
  }
  function clear() { stop(); R = null; window.RecapData = null; if (layer) { layer.remove(); layer = null; } heatOff(); $('rHeat').checked = false; $('recap').classList.add('hidden'); lastImage = null; }
  const map = () => (typeof endMap !== 'undefined' ? endMap : null);
  function render() {
    if (!R || !map()) return;
    $('recap').classList.remove('hidden');
    try { if (typeof endLayer !== 'undefined' && endLayer) endLayer.remove(); } catch {}
    const D = R.endedAt - R.startedAt;
    $('rScrub').max = D; $('rScrub').value = t - R.startedAt;
    $('awards').innerHTML = R.awards.map(a => `<div class="award" data-award="${a.key}"><span style="font-size:1.6em">${a.icon}</span><div><b>${esc(a.title)}</b>${esc(a.text)}</div></div>`).join('') || '<p class="note">No awards this round.</p>';
    $('trophies').innerHTML = R.trophies.map(x => `<span class="trophy" title="${esc(x.desc)}" data-trophy="${x.key}">${x.icon} ${esc(x.title)} · ${esc(x.name)}</span>`).join('') || '<p class="note">No trophies this round.</p>';
    const ig = p => p.social && window.igLink ? ' ' + window.igLink(p.social) : '';
    $('timeline').innerHTML = `<li class="note">${R.players.map(p => `<span style="color:${col[p.id]}">●</span> ${esc(p.name)}${ig(p)}`).join(' · ')}</li>` +
      R.log.map(e => `<li class="${e.k}" data-t="${e.t}"><span class="mono">${clk(e.t - R.startedAt)}</span>${esc(e.text)}</li>`).join('');
    for (const li of document.querySelectorAll('#timeline li[data-t]')) li.onclick = () => { stop(); seek(+li.dataset.t); };
    $('recapPhoto').innerHTML = Object.entries(R.photos || {}).map(([id, ph]) => `<div class="recapPh"><b>📷 Sneak peek: ${esc(ph.name)}</b> <span class="note">${clk(ph.t - R.startedAt)}</span><br><img src="${ph.data}" alt=""></div>`).join('');
    draw(true);
    if (fitted !== R.round) { fitted = R.round; setTimeout(fit, 80); }
  }
  function allPts() { const pts = []; for (const tr of Object.values(R.trails)) for (const q of tr) pts.push([q[1], q[2]]); for (const e of R.log) if (e.k === 'ping') for (const l of Object.values(e.locs || {})) if (l) pts.push([l.lat, l.lng]); return pts; }
  function fit() { const m = map(); if (!m || !R) return; m.invalidateSize(); const pts = allPts(); if (pts.length) m.fitBounds(L.latLngBounds(pts).pad(.15), { maxZoom: 18 }); }
  const roleIcon = r => r === 'h' ? '🔦' : r === 'c' ? '😵' : '🙈';
  function draw(force) {
    const m = map(); if (!m || !R) return;
    if (!force && performance.now() - lastDraw < 60) return; lastDraw = performance.now();
    if (layer) layer.remove(); layer = L.layerGroup().addTo(m);
    if (typeof drawFieldLayers === 'function' && R.field) drawFieldLayers(L.layerGroup().addTo(layer), R.field);
    for (const p of R.players) {
      const tr = (R.trails[p.id] || []).filter(q => q[0] <= t); if (!tr.length) continue;
      L.polyline(tr.map(q => [q[1], q[2]]), { color: col[p.id], weight: 4, opacity: .85, dashArray: p.startRole === 'hunter' ? '6 5' : null, interactive: false }).addTo(layer);
      const cur = Recap.posAt(R.trails[p.id], t) || { lat: tr.at(-1)[1], lng: tr.at(-1)[2] };
      L.circleMarker([cur.lat, cur.lng], { radius: 8, color: '#fff', weight: 2, fillColor: col[p.id], fillOpacity: 1 }).bindTooltip(`${roleIcon(tr.at(-1)[3])} ${esc(p.name)}`, { permanent: true, direction: 'top', offset: [0, -8], className: 'rtip' }).addTo(layer);
    }
    const mk = (ll, html, tip) => L.marker(ll, { icon: L.divIcon({ className: 'bountyIcon', html, iconSize: [24, 24], iconAnchor: [12, 12] }) }).bindTooltip(tip).addTo(layer);
    for (const e of R.log) {
      if (e.t > t) break;
      if (e.k === 'ping') for (const [id, l] of Object.entries(e.locs || {})) { if (!l) continue; const dec = (e.decoys || []).includes(id);
        if (dec) mk([l.lat, l.lng], window.Icons ? Icons.badge('decoy', Icons.COL.decoy, { size: 26 }) : '👻', `${esc(pname(id))}: DECOY (fake point) · ${clk(e.t - R.startedAt)}`);
        else L.circleMarker([l.lat, l.lng], { radius: 4, color: col[id], weight: 2, fillOpacity: .3 }).bindTooltip(`📡 ${esc(pname(id))} seen · ${clk(e.t - R.startedAt)}`).addTo(layer); }
      else if (e.k === 'bounty') mk([e.lat, e.lng], window.Icons ? Icons.badge('bounty', Icons.COL.drop, { size: 26 }) : '💰', `💰 ${esc(pname(e.id))} · ${clk(e.t - R.startedAt)}`);
      else if (e.k === 'catch') { const p = Recap.posAt(R.trails[e.id], e.t); if (p) mk([p.lat, p.lng], '🎯', esc(e.text)); }
      else if (e.k === 'close') mk([e.lat, e.lng], '😱', `${esc(e.text)}`).getElement?.()?.classList.add('closeMk');
      else if (e.k === 'chime') for (const id of e.ids || []) { const p = Recap.posAt(R.trails[id], e.t); if (p) mk([p.lat, p.lng], '🔔', `🔔 ${esc(pname(id))} chimed`); }
      else if (e.k === 'steal') mk([e.lat, e.lng], '🦝', esc(e.text));
      else if (e.k === 'pickup') mk([e.lat, e.lng], window.Icons ? Icons.badge(Icons.has(e.ptype) ? e.ptype : 'gift', Icons.COL.drop, { size: 26 }) : '🎁', esc(e.text));
      else if (e.k === 'power') { const p = Recap.posAt(R.trails[e.id], e.t); if (p) mk([p.lat, p.lng], '⚡', esc(e.text)); }
      else if (e.k === 'oob' && e.on) { const p = Recap.posAt(R.trails[e.id], e.t); if (p) mk([p.lat, p.lng], '🚧', esc(e.text)); }
    }
    const D = R.endedAt - R.startedAt; if (document.activeElement !== $('rScrub')) $('rScrub').value = t - R.startedAt;
    $('rTime').textContent = `${clk(t - R.startedAt)} / ${clk(D)}${playing ? ` · ×${Math.round(speed())}` : ''}`;
  }
  const replayMs = () => Math.max(8000, Math.min(30000, (R.endedAt - R.startedAt) / 40)); // 20 min -> 30 s
  const speed = () => (R.endedAt - R.startedAt) / replayMs();
  function play() {
    if (!R) return; if (playing) return stop();
    if (t >= R.endedAt) t = R.startedAt;
    playing = true; $('rPlay').textContent = '⏸ Pause'; let prev = performance.now();
    const step = now => { if (!playing) return; t = Math.min(R.endedAt, t + (now - prev) * speed()); prev = now; draw(); if (t >= R.endedAt) { stop(); draw(true); return; } raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  }
  function stop() { playing = false; cancelAnimationFrame(raf); if ($('rPlay')) $('rPlay').textContent = '▶ Replay'; }
  function seek(abs) { if (!R) return; t = Math.max(R.startedAt, Math.min(R.endedAt, abs)); draw(true); }
  // ---- heat map: canvas overlay, two colours (hiders' time vs hunters' search), from the 5 s trail samples ----
  const HeatLayer = window.L && L.Layer.extend({
    onAdd(m) { this._m = m; this._c = L.DomUtil.create('canvas', 'heatCanvas'); this._c.style.pointerEvents = 'none'; m.getPanes().overlayPane.appendChild(this._c); m.on('moveend zoomend resize', this._draw, this); this._draw(); },
    onRemove(m) { m.off('moveend zoomend resize', this._draw, this); this._c.remove(); },
    _draw() {
      const m = this._m, c = this._c, sz = m.getSize(); c.width = sz.x; c.height = sz.y; L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
      const g = c.getContext('2d'), mpp = 40075016 * Math.cos(m.getCenter().lat * Math.PI / 180) / Math.pow(2, m.getZoom() + 8), rad = Math.max(10, Math.min(60, 30 / mpp));
      const layerFor = (role, rgb) => { const o = document.createElement('canvas'); o.width = sz.x; o.height = sz.y; const x = o.getContext('2d');
        for (const tr of Object.values(R.trails)) for (const q of tr) { if (q[3] !== role) continue; const p = m.latLngToContainerPoint([q[1], q[2]]);
          const gr = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad); gr.addColorStop(0, `rgba(${rgb},0.35)`); gr.addColorStop(1, `rgba(${rgb},0)`); x.fillStyle = gr; x.fillRect(p.x - rad, p.y - rad, rad * 2, rad * 2); }
        return o; };
      g.globalCompositeOperation = 'source-over'; g.drawImage(layerFor('s', '59,130,246'), 0, 0); g.globalCompositeOperation = 'lighter'; g.drawImage(layerFor('h', '239,68,68'), 0, 0);
      this.points = Object.values(R.trails).reduce((n, tr) => n + tr.length, 0);
    } });
  function heatOn() { const m = map(); if (!m || !R || heat) return; heat = new HeatLayer().addTo(m); $('heatLegend').classList.remove('hidden'); }
  function heatOff() { if (heat) { heat.remove(); heat = null; } $('heatLegend')?.classList.add('hidden'); }
  // ---- share image ----
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function image() {
    const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    g.fillStyle = '#0b1220'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff'; g.font = '800 64px system-ui, sans-serif'; g.fillText('🏃 SCRAM recap', 48, 100);
    g.font = '32px system-ui, sans-serif'; g.fillStyle = '#9ca3af';
    g.fillText(`Lobby ${R.code} · ${new Date(R.startedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} · ${clk(R.endedAt - R.startedAt)} · ${R.winner === 'hiders' ? '🙈 Hiders win' : '🔦 Hunters win'}`, 48, 150);
    // map snapshot: projected paths on a dark grid
    const bx = 40, by = 180, bw = W - 80, bh = 640; g.save(); roundRect(g, bx, by, bw, bh, 24); g.fillStyle = '#172033'; g.fill(); g.clip();
    g.strokeStyle = '#ffffff10'; g.lineWidth = 1; for (let x = bx; x < bx + bw; x += 60) { g.beginPath(); g.moveTo(x, by); g.lineTo(x, by + bh); g.stroke(); } for (let y = by; y < by + bh; y += 60) { g.beginPath(); g.moveTo(bx, y); g.lineTo(bx + bw, y); g.stroke(); }
    const pts = allPts(); if (R.field && window.Field) { const b = Field.bbox(R.field); pts.push([b.s, b.w], [b.n, b.e]); }
    if (pts.length) {
      let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity; for (const [la, lo] of pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
      const k = Math.cos((s + n) / 2 * Math.PI / 180), sx = (e - w) * k || 1e-4, sy = (n - s) || 1e-4, sc = Math.min((bw - 80) / sx, (bh - 80) / sy);
      const P = (la, lo) => [bx + bw / 2 + ((lo - (w + e) / 2) * k) * sc, by + bh / 2 - (la - (s + n) / 2) * sc];
      if (R.field?.circle) { const f = R.field.circle, [cx, cy] = P(f.lat, f.lng); g.strokeStyle = '#facc15'; g.lineWidth = 4; g.beginPath(); g.arc(cx, cy, f.r / 111320 * sc, 0, 7); g.stroke(); }
      if (R.field?.poly) { g.strokeStyle = '#facc15'; g.lineWidth = 4; g.beginPath(); R.field.poly.forEach(([la, lo], i) => { const [x, y] = P(la, lo); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); g.stroke(); }
      for (const p of R.players) { const tr = R.trails[p.id] || []; if (!tr.length) continue; g.strokeStyle = col[p.id]; g.lineWidth = 7; g.lineJoin = g.lineCap = 'round'; g.setLineDash(p.startRole === 'hunter' ? [16, 12] : []);
        g.beginPath(); tr.forEach((q, i) => { const [x, y] = P(q[1], q[2]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.setLineDash([]);
        const [x, y] = P(tr.at(-1)[1], tr.at(-1)[2]); g.fillStyle = col[p.id]; g.beginPath(); g.arc(x, y, 12, 0, 7); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke(); }
      g.font = '36px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const ev of R.log) { let p = null, ic = null;
        if (ev.k === 'catch') { p = Recap.posAt(R.trails[ev.id], ev.t); ic = '🎯'; } else if (ev.k === 'close') { p = ev; ic = '😱'; } else if (ev.k === 'bounty') { p = ev; ic = '💰'; }
        if (p) { const [x, y] = P(p.lat, p.lng); g.fillText(ic, x, y); } }
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    }
    g.restore();
    // legend (names + opted-in social handles, with the platform name)
    let y = 870; g.font = '28px system-ui, sans-serif'; let x = 48;
    for (const p of R.players) { const label = `${p.name}${p.social ? ` @${p.social.handle} (${Socials.label(p.social.platform)})` : ''}`, w = g.measureText(label).width + 50; if (x + w > W - 40) { x = 48; y += 40; }
      g.fillStyle = col[p.id]; g.beginPath(); g.arc(x + 12, y - 9, 11, 0, 7); g.fill(); g.fillStyle = '#e5e7eb'; g.fillText(label, x + 30, y); x += w; }
    y += 56; g.fillStyle = '#fff'; g.font = '700 34px system-ui, sans-serif'; g.fillText('🏅 Awards', 48, y); y += 10; g.font = '28px system-ui, sans-serif';
    for (const a of R.awards.slice(0, 7)) { y += 40; g.fillStyle = '#fbbf24'; g.fillText(`${a.icon} ${a.title}`, 48, y); g.fillStyle = '#e5e7eb'; g.fillText(a.text.slice(0, 46), 430, y); }
    y += 58; x = 48; g.font = '26px system-ui, sans-serif';
    for (const tr of R.trophies.slice(0, 10)) { const label = `${tr.icon} ${tr.title} · ${tr.name}`, w = g.measureText(label).width + 28; if (x + w > W - 40) { x = 48; y += 48; } if (y > H - 70) break;
      g.fillStyle = '#312e81'; roundRect(g, x, y - 30, w, 42, 21); g.fill(); g.fillStyle = '#fff'; g.fillText(label, x + 14, y); x += w + 10; }
    g.font = '600 26px system-ui, sans-serif'; g.fillStyle = '#f472b6'; g.textAlign = 'right'; g.fillText(window.Reel?.credit?.() || 'Game by @mmmmmray', W - 32, H - 28); g.textAlign = 'left';
    g.fillStyle = '#6b7280'; g.font = '22px system-ui, sans-serif'; g.fillText('scram · GPS hide & seek', 48, H - 28);
    return c;
  }
  async function share() {
    if (!R) return;
    const c = image(), blob = await new Promise(r => c.toBlob(r, 'image/png')), name = `scram_recap_${R.code}_${new Date(R.startedAt).toISOString().slice(0, 10)}.png`;
    lastImage = { w: c.width, h: c.height, size: blob.size, name, via: null };
    const url = URL.createObjectURL(blob); $('shareImg').src = url; $('sharePreview').classList.remove('hidden');
    const file = window.File ? new File([blob], name, { type: 'image/png' }) : null;
    try { if (file && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Scram recap ' + R.code, text: `Scram ${R.code} — ${R.winner === 'hiders' ? 'hiders' : 'hunters'} win!` }); lastImage.via = 'share'; return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); lastImage.via = 'download';
    window.toast?.('⬇ Recap image downloaded');
  }
  function init() {
    $('rPlay').onclick = play;
    $('rScrub').oninput = () => { stop(); seek(R.startedAt + +$('rScrub').value); };
    $('rHeat').onchange = () => $('rHeat').checked ? heatOn() : heatOff();
    $('btnShareRecap').onclick = share;
    $('sharePreview').onclick = () => $('sharePreview').classList.add('hidden');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.RecapUI = { set, clear, render, play, stop, seek, share, image, heatOn, heatOff, get data() { return R; }, get t() { return t; }, get playing() { return playing; }, get lastImage() { return lastImage; }, get heat() { return heat; }, colors: col };
})();
