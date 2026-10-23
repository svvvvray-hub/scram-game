// "Plan the next game" (whenisgood-style): create a poll (2-8 times, 1-3 places) from the recap, vote without sign-up,
// live tally over WebSocket (polling fallback), best combination, creator-only lock, .ics / Google Calendar, 9:16 card.
// Used by index.html (sheet on the recap screen) and plan.html (/p/CODE). Exposes window.Plan.
(function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = { get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } } };
  const LIM = { minTimes: 2, maxTimes: 8, minPlaces: 1, maxPlaces: 3, nameLen: 20, labelLen: 40 };
  const SHARE_TEXT = link => `Who's down for another round of Last Ping? Vote here: ${link}`;
  const say = (t, ms) => { if (typeof window.toast === 'function') return window.toast(t, ms); let e = document.getElementById('toast');
    if (!e) { e = document.createElement('div'); e.id = 'toast'; e.className = 'toast'; document.body.appendChild(e); }
    e.textContent = t; e.classList.add('show'); clearTimeout(say.t); say.t = setTimeout(() => e.classList.remove('show'), ms || 2500); };
  const rand = () => { const a = new Uint8Array(16); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c])); };
  const voterId = () => { let v = LS.get('scramPollVoter'); if (!v || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) { v = rand(); LS.set('scramPollVoter', v); } return v; };
  const tokenFor = code => (LS.json('scramPolls', {}) || {})[code] || null;
  const saveToken = (code, token) => { const m = LS.json('scramPolls', {}) || {}; m[code] = token; const ks = Object.keys(m); if (ks.length > 30) delete m[ks[0]]; LS.set('scramPolls', JSON.stringify(m)); };
  const myRef = () => { const h = String(LS.get('scramIg', '') || '').trim().replace(/^@/, '').toLowerCase(); return /^[a-z0-9._-]{1,30}$/.test(h) ? h : ''; };
  const savedSocial = () => { const h = LS.get('scramIg'), p = LS.get('scramPlatform'); return h && window.Socials ? Socials.norm({ handle: h, platform: Socials.isPlatform(p) ? p : 'instagram' }) : null; };
  const creator = () => (window.CREATOR && window.Socials && Socials.norm(window.CREATOR)) || { handle: 'mmmmmray', platform: 'instagram' };

  // ---- time formatting: stored in UTC ms, shown in the viewer's zone with a short label (e.g. "PDT") ----
  const zone = ms => { try { return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName')?.value || ''; } catch { return ''; } };
  const wd = ms => new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });
  const md = ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const hm = ms => { const d = new Date(ms), h = d.getHours(), m = d.getMinutes(); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`; };
  const short = ms => `${wd(ms)} ${hm(ms)}`;                                  // "Sat 4pm"
  const full = ms => `${wd(ms)}, ${md(ms)} · ${hm(ms)} ${zone(ms)}`.trim();     // "Sat, Oct 24 · 4pm PDT"
  const placeName = pl => pl.label || `Pin ${pl.lat.toFixed(4)}, ${pl.lng.toFixed(4)}`;
  const mapUrl = pl => `https://www.google.com/maps/search/?api=1&query=${pl.lat},${pl.lng}`;
  const gDate = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const gcalUrl = (poll, link) => { const L = poll.locked, t = poll.times[L.time], pl = poll.places[L.place];
    return 'https://calendar.google.com/calendar/render?' + new URLSearchParams({ action: 'TEMPLATE', text: 'Last Ping 🏃 GPS hide & seek', dates: `${gDate(t)}/${gDate(t + 3600e3)}`,
      details: `Next round of Last Ping${poll.by ? ' (planned by ' + poll.by + ')' : ''}.\nMap: ${mapUrl(pl)}\nPoll: ${link}`, location: placeName(pl) }).toString(); };
  const pollLink = code => location.origin + '/p/' + code;
  const shareLink = code => pollLink(code) + (myRef() ? '?ref=' + encodeURIComponent(myRef()) : '');
  async function sharePoll(code) {
    const text = SHARE_TEXT(shareLink(code));
    try { navigator.sendBeacon?.('/api/share', new Blob([JSON.stringify({ k: 'poll' })], { type: 'application/json' })); } catch {}
    try { if (navigator.share) { await navigator.share({ text }); return 'shared'; } } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
    try { await navigator.clipboard.writeText(text); say('🔗 Poll link copied'); return 'copied'; } catch { prompt('Copy this:', text); return 'prompt'; }
  }

  // ---- past play areas: field centers from games this device hosted (localStorage only) ----
  function fieldCenter(f) { if (!f) return null; if (f.circle) return { lat: f.circle.lat, lng: f.circle.lng };
    if (f.poly && f.poly.length) { const n = f.poly.length; return { lat: f.poly.reduce((s, p) => s + p[0], 0) / n, lng: f.poly.reduce((s, p) => s + p[1], 0) / n }; } return null; }
  const near = (a, b) => Math.abs(a.lat - b.lat) < 0.0015 && Math.abs(a.lng - b.lng) < 0.0015 / Math.max(.2, Math.cos(a.lat * Math.PI / 180));
  function rememberArea(field) { const c = fieldCenter(field); if (!c) return; const list = (LS.json('scramAreas', []) || []).filter(a => a && Number.isFinite(a.lat) && !near(a, c));
    list.unshift({ lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), at: Date.now() }); LS.set('scramAreas', JSON.stringify(list.slice(0, 6))); }
  const areas = () => (LS.json('scramAreas', []) || []).filter(a => a && Number.isFinite(a.lat) && Number.isFinite(a.lng));

  // ---- quick time chips: this Sat/Sun at preset hours (next occurrence in the viewer's zone) ----
  const HOURS = [11, 14, 16, 18];
  function chipTimes(now = new Date()) { const out = [];
    for (const dow of [6, 0]) { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7));
      for (const h of HOURS) { let t = new Date(d); t.setHours(h, 0, 0, 0); if (t <= now) { t = new Date(d); t.setDate(t.getDate() + 7); t.setHours(h, 0, 0, 0); } out.push(t.getTime()); } }
    return out; }

  // ---- maps (local Leaflet) ----
  const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const baseMap = (el, o = {}) => { const m = L.map(el, { zoomControl: true, attributionControl: true, ...o }); L.tileLayer(TILES, { maxZoom: 19, attribution: ATTR, className: 'osmDark' }).addTo(m); return m; };
  const pinIcon = (n, cls = '') => L.divIcon({ className: 'planPinWrap', html: `<div class="planPin ${cls}">${esc(n)}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });

  // ---- overlay sheet ----
  function sheet() { let o = document.getElementById('planSheet'); if (!o) { o = document.createElement('div'); o.id = 'planSheet'; o.className = 'planSheet hidden'; o.setAttribute('role', 'dialog'); document.body.appendChild(o); } return o; }
  let live = null; // current poll view controller
  function close() { const o = sheet(); o.classList.add('hidden'); o.innerHTML = ''; if (live) { live.stop(); live = null; } document.body.classList.remove('planOpen'); }

  // ================= create =================
  function openCreate(ctx = {}) {
    if (live) { live.stop(); live = null; }
    const o = sheet(); o.classList.remove('hidden'); document.body.classList.add('planOpen');
    const st = { times: [], places: [], pending: null };
    const chips = chipTimes();
    o.innerHTML = `<div class="planInner" id="planCreate">
      <div class="sheetHead"><b>📅 Plan the next game</b><button class="small" data-close>✕</button></div>
      <p class="note">Pick a few times and places. Friends vote with just a name, no sign-up.</p>
      <h3>🕑 When? <span class="note" id="pTimesN"></span></h3>
      <div class="chips" id="pChips">${chips.map(t => `<button class="chip" data-t="${t}"><b>${esc(short(t))}</b><small>${esc(md(t))}</small></button>`).join('')}</div>
      <div class="planRow"><input id="pCustom" type="datetime-local" aria-label="Custom date and time"><button id="pAddTime" class="small">+ Add time</button></div>
      <div id="pTimes" class="picked"></div>
      <h3>📍 Where? <span class="note" id="pPlacesN"></span></h3>
      <div class="chips" id="pSuggest"></div>
      <div id="pMap" class="planMap"></div>
      <p class="note">Tap the map to drop a pin, then add it.</p>
      <div class="planRow"><input id="pLabel" maxlength="${LIM.labelLen}" placeholder="Label (optional), e.g. Dolores Park"><button id="pAddPlace" class="small">+ Add place</button></div>
      <div id="pPlaces" class="picked"></div>
      <div id="pErr" class="planErr" role="alert"></div>
      <button id="pCreate" class="big primary">Create poll</button>
    </div>`;
    const $ = s => o.querySelector(s);
    $('[data-close]').onclick = close;
    const sugg = [];
    const cf = fieldCenter(ctx.field); if (cf) sugg.push({ ...cf, label: '', tag: "🟨 This game's field" });
    areas().filter(a => !cf || !near(a, cf)).forEach((a, i) => sugg.push({ lat: a.lat, lng: a.lng, label: '', tag: `🕘 Past area ${i + 1}` }));
    $('#pSuggest').innerHTML = sugg.length ? sugg.slice(0, 6).map((s, i) => `<button class="chip" data-s="${i}">${esc(s.tag)}</button>`).join('') : '<span class="note">Past play areas from games you host show up here.</span>';
    let map = null, pendingMk = null, layer = null;
    if (window.L) { const c = cf || sugg[0] || ctx.loc || null; map = baseMap($('#pMap')); map.setView(c ? [c.lat, c.lng] : [37.7749, -122.4194], c ? 15 : 11); layer = L.layerGroup().addTo(map);
      map.on('click', e => { st.pending = { lat: e.latlng.lat, lng: e.latlng.lng }; if (pendingMk) pendingMk.remove(); pendingMk = L.marker(e.latlng, { icon: pinIcon('+', 'pending') }).addTo(map); $('#pLabel').focus({ preventScroll: true }); });
      setTimeout(() => map.invalidateSize(), 60); }
    const draw = () => {
      $('#pTimesN').textContent = `${st.times.length} picked · ${LIM.minTimes}-${LIM.maxTimes}`;
      $('#pPlacesN').textContent = `${st.places.length} picked · ${LIM.minPlaces}-${LIM.maxPlaces}`;
      st.times.sort((a, b) => a - b);
      $('#pTimes').innerHTML = st.times.map(t => `<span class="pick">${esc(full(t))}<button class="x" data-rt="${t}" aria-label="Remove">✕</button></span>`).join('');
      $('#pPlaces').innerHTML = st.places.map((p, i) => `<span class="pick"><b>${i + 1}</b> <input class="plabel" data-li="${i}" maxlength="${LIM.labelLen}" value="${esc(p.label)}" placeholder="${esc(placeName({ ...p, label: '' }))}"><button class="x" data-rp="${i}" aria-label="Remove">✕</button></span>`).join('');
      for (const b of o.querySelectorAll('#pChips .chip')) b.classList.toggle('on', st.times.includes(+b.dataset.t));
      if (layer) { layer.clearLayers(); st.places.forEach((p, i) => L.marker([p.lat, p.lng], { icon: pinIcon(i + 1) }).addTo(layer)); }
      $('#pCreate').disabled = st.times.length < LIM.minTimes || !st.places.length;
    };
    const addTime = t => { if (!Number.isFinite(t)) return; if (t < Date.now()) return err('Pick a time in the future'); if (st.times.includes(t)) return;
      if (st.times.length >= LIM.maxTimes) return err(`Up to ${LIM.maxTimes} times`); err(''); st.times.push(t); draw(); };
    const addPlace = p => { if (st.places.length >= LIM.maxPlaces) return err(`Up to ${LIM.maxPlaces} places`); if (st.places.some(q => near(q, p))) return err('That place is already in the list');
      err(''); st.places.push({ lat: p.lat, lng: p.lng, label: String(p.label || '').slice(0, LIM.labelLen) }); draw(); };
    const err = t => { $('#pErr').textContent = t; };
    o.querySelector('#pChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const t = +b.dataset.t; if (st.times.includes(t)) { st.times = st.times.filter(x => x !== t); draw(); } else addTime(t); };
    $('#pAddTime').onclick = () => { const v = $('#pCustom').value; if (!v) return err('Pick a date and time first'); addTime(new Date(v).getTime()); $('#pCustom').value = ''; };
    $('#pSuggest').onclick = e => { const b = e.target.closest('[data-s]'); if (!b) return; const s = sugg[+b.dataset.s]; addPlace(s); if (map) map.setView([s.lat, s.lng], 15); };
    $('#pAddPlace').onclick = () => { const p = st.pending; if (!p) return err('Tap the map to drop a pin first');
      addPlace({ ...p, label: $('#pLabel').value.trim() }); st.pending = null; $('#pLabel').value = ''; if (pendingMk) { pendingMk.remove(); pendingMk = null; } };
    o.addEventListener('click', e => { const rt = e.target.closest('[data-rt]'), rp = e.target.closest('[data-rp]');
      if (rt) { st.times = st.times.filter(x => x !== +rt.dataset.rt); draw(); } if (rp) { st.places.splice(+rp.dataset.rp, 1); draw(); } });
    o.addEventListener('input', e => { const li = e.target.closest('[data-li]'); if (li) st.places[+li.dataset.li].label = li.value.slice(0, LIM.labelLen); });
    $('#pCreate').onclick = async () => {
      if (st.times.length < LIM.minTimes) return err(`Pick at least ${LIM.minTimes} times`); if (!st.places.length) return err('Add at least one place');
      $('#pCreate').disabled = true; $('#pCreate').textContent = 'Creating…';
      try { const r = await fetch('/api/polls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ times: st.times, places: st.places, name: ctx.name || LS.get('scramName', ''), social: ctx.social || savedSocial(), lobby: ctx.lobby || null }) });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not create the poll');
        saveToken(j.code, j.token); if (map) map.remove(); ctx.onCreated?.(j.code); openPoll(j.code, { created: true });
      } catch (e) { err(e.message); $('#pCreate').disabled = false; $('#pCreate').textContent = 'Create poll'; }
    };
    draw();
    return { state: st, addTime, addPlace };
  }

  // ================= poll view (sheet or full page) =================
  function openPoll(code, o2 = {}) { const o = sheet(); o.classList.remove('hidden'); document.body.classList.add('planOpen'); o.innerHTML = '<div class="planInner" id="planHost"></div>';
    return render(o.querySelector('#planHost'), code, { ...o2, sheet: true }); }

  function render(root, code, opt = {}) {
    if (live && opt.sheet) live.stop();
    code = String(code || '').toUpperCase();
    const st = { poll: null, sel: { t: [], p: [] }, dirty: false, voted: false, lockSel: null, ws: null, timer: 0, stopped: false, map: null, mapKey: '', retry: 0 };
    const token = tokenFor(code);
    const so = savedSocial();
    root.innerHTML = `<div class="pollView" data-code="${esc(code)}">
      <div class="sheetHead"><b>📅 Next Last Ping</b>${opt.sheet ? '<button class="small" data-close>✕</button>' : ''}</div>
      <p class="note" id="pvBy"></p>
      <div id="pvLocked"></div>
      <div class="shareRow"><button id="pvShare" class="big primary">📤 Share poll</button><div class="note mono" id="pvLink">${esc(pollLink(code))}</div></div>
      <div id="pvVote">
        <label>Your name<input id="pvName" maxlength="${LIM.nameLen}" autocomplete="nickname" placeholder="e.g. Murray" value="${esc(LS.get('scramName', ''))}"></label>
        <label for="pvHandle">Your @ (optional)</label>
        <div class="socialRow"><select id="pvPlat" aria-label="Platform">${(window.Socials ? Socials.LIST : ['instagram']).map(k => `<option value="${k}"${(so ? so.platform : LS.get('scramPlatform', 'instagram')) === k ? ' selected' : ''}>${esc(window.Socials ? Socials.label(k) : k)}</option>`).join('')}</select><input id="pvHandle" maxlength="60" autocapitalize="none" placeholder="@handle" value="${so ? '@' + esc(so.handle) : ''}"></div>
        <p class="note">Tap what works: once = ✅ yes, tap again (or long-press) = 🤷 maybe, again = clear.</p>
        <h3>🕑 Times</h3><div id="pvTimes" class="opts"></div>
        <h3>📍 Places</h3><div id="pvMap" class="planMap small"></div><div id="pvPlaces" class="opts"></div>
        <button id="pvSubmit" class="big primary">✅ Submit vote</button><div id="pvErr" class="planErr" role="alert"></div>
      </div>
      <div id="pvBest" class="bestLine"></div>
      <h3>🗳 Live tally <span class="note" id="pvCount"></span></h3>
      <div class="gridWrap"><table id="pvCombo" class="comboGrid"></table></div>
      <div class="gridWrap"><table id="pvGrid" class="tallyGrid"></table></div>
      <div id="pvWho" class="who"></div>
      <div id="pvLock" class="lockBox hidden"></div>
      <p class="note">Times are shown in your time zone. Polls expire 14 days after the last option.</p>
    </div>`;
    const $ = s => root.querySelector(s);
    if (opt.sheet) $('[data-close]').onclick = close;
    $('#pvShare').onclick = () => sharePoll(code);
    if (opt.created) setTimeout(() => say('📅 Poll created! Share it with the group'), 50);
    // tap = yes -> maybe -> clear; long-press = maybe
    const cycle = v => v === 2 ? 1 : v === 1 ? 0 : 2;
    let lp = null, lpFired = false;
    const onOptDown = e => { const b = e.target.closest('.opt'); if (!b || st.poll?.locked) return; lpFired = false; clearTimeout(lp);
      lp = setTimeout(() => { lpFired = true; setSel(b.dataset.k, +b.dataset.i, 1); navigator.vibrate?.(20); }, 500); };
    const onOptUp = () => clearTimeout(lp);
    const onOptClick = e => { const b = e.target.closest('.opt'); if (!b || st.poll?.locked) return; if (lpFired) { lpFired = false; return; } const k = b.dataset.k, i = +b.dataset.i; setSel(k, i, cycle(st.sel[k][i] || 0)); };
    for (const id of ['#pvTimes', '#pvPlaces']) { const el = $(id); el.addEventListener('pointerdown', onOptDown); el.addEventListener('pointerup', onOptUp); el.addEventListener('pointerleave', onOptUp, true); el.addEventListener('pointercancel', onOptUp); el.addEventListener('click', onOptClick); el.addEventListener('contextmenu', e => e.preventDefault()); }
    function setSel(k, i, v) { st.sel[k][i] = v; st.dirty = true; drawOpts(); }
    const mark = v => v === 2 ? '✅' : v === 1 ? '🤷' : '';
    function drawOpts() { const P = st.poll; if (!P) return;
      $('#pvTimes').innerHTML = P.times.map((t, i) => { const v = st.sel.t[i] || 0, T = P.timeTally[i]; return `<button class="opt ${v === 2 ? 'y' : v === 1 ? 'm' : ''}" data-k="t" data-i="${i}" aria-pressed="${v ? 'true' : 'false'}"><span class="mk">${mark(v)}</span><span class="lb"><b>${esc(short(t))}</b> <small>${esc(md(t))} · ${esc(zone(t))}</small></span><span class="tl">✅${T.yes}${T.maybe ? ' 🤷' + T.maybe : ''}</span></button>`; }).join('');
      $('#pvPlaces').innerHTML = P.places.map((p, i) => { const v = st.sel.p[i] || 0, T = P.placeTally[i];
        return `<button class="opt ${v === 2 ? 'y' : v === 1 ? 'm' : ''}" data-k="p" data-i="${i}" aria-pressed="${v ? 'true' : 'false'}"><span class="mk">${mark(v)}</span><span class="lb"><b>${i + 1}. ${esc(placeName(p))}</b> <a class="mapA" href="${esc(mapUrl(p))}" target="_blank" rel="noopener">map ↗</a></span><span class="tl">✅${T.yes}${T.maybe ? ' 🤷' + T.maybe : ''}</span></button>`; }).join('');
      $('#pvSubmit').textContent = st.voted ? (st.dirty ? '💾 Update my vote' : '✅ Vote saved · tap to update') : '✅ Submit vote';
    }
    function drawMap() { const P = st.poll; if (!window.L || !P) return; const key = JSON.stringify(P.places) + (P.locked ? P.locked.place : '');
      if (key === st.mapKey) return; st.mapKey = key;
      if (!st.map) { st.map = baseMap($('#pvMap'), { scrollWheelZoom: false }); }
      if (st.layer) st.layer.remove(); st.layer = L.layerGroup().addTo(st.map);
      P.places.forEach((p, i) => L.marker([p.lat, p.lng], { icon: pinIcon(i + 1) }).bindTooltip(esc(placeName(p))).addTo(st.layer));
      const b = L.latLngBounds(P.places.map(p => [p.lat, p.lng])); setTimeout(() => { if (!st.map) return; st.map.invalidateSize(); P.places.length > 1 ? st.map.fitBounds(b.pad(.3), { maxZoom: 16 }) : st.map.setView(b.getCenter(), 15); }, 60); }
    function draw() { const P = st.poll; if (!P) return;
      const L0 = P.locked, isC = !!token;
      $('#pvBy').innerHTML = `${P.by ? 'Planned by <b>' + esc(P.by) + '</b>' + (P.bySocial && window.igLink ? ' ' + window.igLink(P.bySocial) : '') + ' · ' : ''}${P.voters.length}/${P.max} voted${isC ? ' · <span class="pill">you created this</span>' : ''}`;
      $('#pvVote').classList.toggle('hidden', !!L0);
      $('#pvLocked').innerHTML = L0 ? lockedHtml(P) : '';
      if (L0) { $('#pvLocked').querySelector('[data-card]').onclick = () => makeCard(P).then(showCard).catch(e => say('Card failed: ' + e.message));
        const sh = $('#pvLocked').querySelector('[data-share2]'); if (sh) sh.onclick = () => sharePoll(code); }
      drawOpts(); if (!L0) drawMap();
      const B = P.best, any = B && (B.yes + B.maybe) > 0;
      $('#pvBest').classList.toggle('hidden', !!L0);
      $('#pvBest').innerHTML = L0 ? '' : any ? `⭐ Best so far: <b>${esc(short(P.times[B.time]))}</b> at <b>${esc(placeName(P.places[B.place]))}</b> <span class="note">(✅${B.yes}${B.maybe ? ' 🤷' + B.maybe : ''})</span>` : '<span class="note">No votes yet. Be the first!</span>';
      $('#pvCount').textContent = `${P.voters.length} voter${P.voters.length === 1 ? '' : 's'}`;
      // combination grid: times (rows) x places (columns); the best cell glows
      $('#pvCombo').innerHTML = `<tr><th></th>${P.places.map((p, j) => `<th title="${esc(placeName(p))}">📍${j + 1}</th>`).join('')}</tr>` +
        P.times.map((t, i) => `<tr><th>${esc(short(t))}</th>${P.places.map((_, j) => { const c = P.combos[i][j], isB = L0 ? (L0.time === i && L0.place === j) : any && B.time === i && B.place === j;
          return `<td class="${isB ? 'best' : ''}${c.yes ? ' has' : ''}" data-combo="${i}-${j}">${c.yes || c.maybe ? `${c.yes ? '✅' + c.yes : ''}${c.maybe ? (c.yes ? '<br>' : '') + '<small>🤷' + c.maybe + '</small>' : ''}` : '<span class="note">·</span>'}</td>`; }).join('')}</tr>`).join('');
      // who voted: one row per voter, a column per option
      $('#pvGrid').innerHTML = P.voters.length ? `<tr><th>Who</th>${P.times.map(t => `<th>${esc(short(t))}</th>`).join('')}${P.places.map((_, j) => `<th>📍${j + 1}</th>`).join('')}</tr>` +
        P.voters.map(v => `<tr><td class="vn">${esc(v.name)}${v.social && window.Socials ? ` <a class="ig" href="${esc(Socials.url(v.social))}" target="_blank" rel="noopener">@${esc(v.social.handle)}</a>` : ''}</td>${v.t.map(x => `<td>${mark(x) || '·'}</td>`).join('')}${v.p.map(x => `<td>${mark(x) || '·'}</td>`).join('')}</tr>`).join('') : '';
      $('#pvWho').innerHTML = P.voters.length ? '👥 ' + P.voters.map(v => `<span class="whoChip">${esc(v.name)}</span>`).join(' ') : '';
      // creator: lock it
      const lb = $('#pvLock'); lb.classList.toggle('hidden', !isC);
      if (isC) { const sel = st.lockSel || (L0 ? { time: L0.time, place: L0.place } : { time: B.time, place: B.place });
        lb.innerHTML = `<h3>🔒 ${L0 ? 'Locked' : 'Lock it'} <span class="note">(only you see this)</span></h3>
          <label>Time<select id="pvLockT">${P.times.map((t, i) => `<option value="${i}"${sel.time === i ? ' selected' : ''}>${esc(full(t))}${!L0 && any && B.time === i ? ' ⭐' : ''}</option>`).join('')}</select></label>
          <label>Place<select id="pvLockP">${P.places.map((p, i) => `<option value="${i}"${sel.place === i ? ' selected' : ''}>${i + 1}. ${esc(placeName(p))}${!L0 && any && B.place === i ? ' ⭐' : ''}</option>`).join('')}</select></label>
          <button id="pvLockBtn" class="big primary">${L0 ? '🔁 Change the plan' : '🔒 Lock it'}</button>${L0 ? '<button id="pvUnlock" class="small">🔓 Reopen voting</button>' : ''}`;
        const upd = () => { st.lockSel = { time: +$('#pvLockT').value, place: +$('#pvLockP').value }; };
        $('#pvLockT').onchange = upd; $('#pvLockP').onchange = upd;
        $('#pvLockBtn').onclick = () => { upd(); doLock({ time: st.lockSel.time, place: st.lockSel.place }); };
        if ($('#pvUnlock')) $('#pvUnlock').onclick = () => { st.lockSel = null; doLock({ unlock: true }); };
      }
    }
    async function doLock(b) { try { const r = await fetch(`/api/polls/${code}/lock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...b }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error); st.lockSel = null; setPoll(j); say(b.unlock ? '🔓 Voting reopened' : '🔒 Locked! Everyone sees the plan now'); } catch (e) { say('⚠️ ' + e.message, 4000); } }
    function lockedHtml(P) { const L0 = P.locked, t = P.times[L0.time], pl = P.places[L0.place];
      return `<div class="lockedCard" id="pvNext"><div class="note">🔒 Locked in</div><div class="nextLine">Next Last Ping: <b>${esc(short(t))}</b> at <b>${esc(placeName(pl))}</b></div>
        <div class="note">${esc(full(t))}</div>
        <div class="lockedBtns"><a class="big primary btnLink" id="pvIcs" href="/api/polls/${esc(P.code)}/ics" download="last-ping-${esc(P.code)}.ics">📅 Add to calendar</a>
        <a class="small btnLink" id="pvGcal" href="${esc(gcalUrl(P, pollLink(P.code)))}" target="_blank" rel="noopener">Google Calendar ↗</a>
        <a class="small btnLink" id="pvMapLink" href="${esc(mapUrl(pl))}" target="_blank" rel="noopener">🗺 Map ↗</a>
        <button class="small" data-card>🖼 Share card</button><button class="small" data-share2>📤 Share link</button></div></div>`; }
    function setPoll(P) { if (!P || P.code !== code) return;
      const first = !st.poll; st.poll = P;
      if (first && P.mine) { st.sel = { t: P.mine.t.slice(), p: P.mine.p.slice() }; st.voted = true; }
      if (first && !st.sel.t.length) st.sel = { t: P.times.map(() => 0), p: P.places.map(() => 0) };
      draw(); root.dispatchEvent(new CustomEvent('poll', { detail: P }));
      window.lastPoll = P; }
    $('#pvSubmit').onclick = async () => {
      const name = $('#pvName').value.trim().slice(0, LIM.nameLen); const err = t => { $('#pvErr').textContent = t; };
      if (!name) { err('Add your name first'); $('#pvName').focus(); return; }
      let social = null; const h = $('#pvHandle').value.trim();
      if (h && window.Socials) { social = Socials.parse(h, $('#pvPlat').value); if (!social) return err('⚠️ ' + Socials.hint($('#pvPlat').value)); }
      if (!st.sel.t.some(Boolean) && !st.sel.p.some(Boolean)) return err('Tap at least one time or place that works');
      err(''); $('#pvSubmit').disabled = true;
      try { const r = await fetch(`/api/polls/${code}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: voterId(), name, social, t: st.sel.t, p: st.sel.p }) });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Vote failed');
        LS.set('scramName', name); if (social) { LS.set('scramIg', social.handle); LS.set('scramPlatform', social.platform); }
        st.voted = true; st.dirty = false; setPoll(j); say('🗳 Vote saved!');
      } catch (e) { err('⚠️ ' + e.message); } finally { $('#pvSubmit').disabled = false; }
    };
    // ---- live updates: WebSocket subscription, polling fallback ----
    async function fetchPoll() { try { const r = await fetch(`/api/polls/${code}?v=${encodeURIComponent(voterId())}`, { cache: 'no-store' }); if (r.status === 404) return gone();
      const j = await r.json(); setPoll(j); } catch {} }
    function gone() { root.querySelector('.pollView').innerHTML = `<div class="sheetHead"><b>📅 Poll not found</b>${opt.sheet ? '<button class="small" data-close>✕</button>' : ''}</div><p class="planErr" id="pvGone">This poll doesn't exist or has expired (polls last 14 days after their last option, and can be lost when the server restarts).</p><a class="big primary btnLink" href="/">🏃 Play Last Ping</a>`;
      if (opt.sheet) root.querySelector('[data-close]').onclick = close; stop(); }
    function connect() { if (st.stopped) return; try {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); st.ws = ws;
      ws.onopen = () => { st.retry = 0; ws.send(JSON.stringify({ type: 'pollSub', code })); };
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type !== 'poll') return; if (m.gone) return gone(); setPoll(st.poll && m.poll ? { ...m.poll, mine: undefined } : m.poll); };
      ws.onclose = () => { if (st.ws === ws) st.ws = null; if (!st.stopped) setTimeout(connect, Math.min(15000, 1000 * 2 ** st.retry++)); };
    } catch {} }
    function stop() { st.stopped = true; clearInterval(st.timer); try { st.ws?.close(); } catch {} st.ws = null; if (st.map) { st.map.remove(); st.map = null; } }
    st.timer = setInterval(() => { if (!st.ws || st.ws.readyState !== 1) fetchPoll(); }, 10000); // fallback when the socket is down
    fetchPoll().then(connect);
    const ctl = { stop, state: st, refresh: fetchPoll, code };
    if (opt.sheet) live = ctl;
    return ctl;
  }

  // ================= 9:16 share card (canvas) =================
  async function qrImage(code) { const r = await fetch(`/qr/${code}.svg`); let svg = await r.text();
    if (!/<svg[^>]*\swidth=/.test(svg)) svg = svg.replace('<svg', '<svg width="600" height="600"');
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try { return await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error('QR')); im.src = url; }); } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); } }
  function wrap(ctx, text, maxW) { const words = String(text).split(' '), lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; } if (cur) lines.push(cur); return lines.slice(0, 3); }
  async function makeCard(P) {
    const W = 1080, H = 1920, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    const L0 = P.locked || { time: P.best.time, place: P.best.place }, t = P.times[L0.time], pl = P.places[L0.place];
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0b1020'); g.addColorStop(.55, '#151b2e'); g.addColorStop(1, '#312e81'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.strokeStyle = '#22d3ee22'; x.lineWidth = 4; for (let r = 160; r < 1400; r += 160) { x.beginPath(); x.arc(W / 2, 760, r, 0, Math.PI * 2); x.stroke(); }
    const F = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
    x.fillStyle = '#22d3ee'; x.font = F(900, 64); x.fillText('🏃 LAST PING', W / 2, 170);
    x.fillStyle = '#9ca3af'; x.font = F(700, 44); x.fillText('NEXT GAME', W / 2, 300);
    x.fillStyle = '#fff'; x.font = F(900, 190); x.fillText(new Date(t).toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(), W / 2, 490);
    x.font = F(900, 150); x.fillStyle = '#facc15'; x.fillText(hm(t).toUpperCase(), W / 2, 650);
    x.fillStyle = '#e5e7eb'; x.font = F(600, 52); x.fillText(`${new Date(t).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} · ${zone(t)}`, W / 2, 740);
    x.font = F(800, 66); x.fillStyle = '#fff'; const lines = wrap(x, '📍 ' + placeName(pl), W - 160); lines.forEach((l, i) => x.fillText(l, W / 2, 870 + i * 80));
    const qy = 870 + lines.length * 80 + 20, qs = 480;
    x.fillStyle = '#fff'; const rr = (X, Y, w, h, r) => { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); };
    rr(W / 2 - qs / 2 - 24, qy, qs + 48, qs + 48, 36); x.fill();
    try { const im = await qrImage(P.code); x.drawImage(im, W / 2 - qs / 2, qy + 24, qs, qs); } catch {}
    x.fillStyle = '#d1d5db'; x.font = F(700, 44); x.fillText(P.locked ? 'Scan for the details · add it to your calendar' : 'Scan to vote', W / 2, qy + qs + 120);
    x.fillStyle = '#9ca3af'; x.font = F(500, 38); x.fillText(pollLink(P.code).replace(/^https?:\/\//, ''), W / 2, qy + qs + 180);
    const cr = creator(); x.fillStyle = '#fff'; x.font = F(800, 48); x.fillText(`Game by @${cr.handle}`, W / 2, H - 110);
    x.fillStyle = '#9ca3af'; x.font = F(500, 34); x.fillText(window.Socials ? Socials.label(cr.platform) : '', W / 2, H - 60);
    return c;
  }
  function showCard(c) {
    let o = document.getElementById('planCard'); if (!o) { o = document.createElement('div'); o.id = 'planCard'; o.className = 'planCard'; document.body.appendChild(o); }
    const url = c.toDataURL('image/png');
    o.innerHTML = `<img id="planCardImg" alt="Next game card" src="${url}"><div class="seg"><a class="small btnLink primary" download="last-ping-next-game.png" href="${url}">⬇ Save</a><button class="small" id="planCardShare">↗ Share</button><button class="small" id="planCardClose">✕ Close</button></div>`;
    o.classList.remove('hidden');
    o.querySelector('#planCardClose').onclick = () => o.classList.add('hidden');
    o.querySelector('#planCardShare').onclick = () => c.toBlob(async b => { const f = new File([b], 'last-ping-next-game.png', { type: 'image/png' });
      try { if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], text: 'Next Last Ping 🏃' }); else say('Saving instead: use ⬇ Save'); } catch {} }, 'image/png');
    return o;
  }

  window.Plan = { openCreate, openPoll, render, close, rememberArea, areas, chipTimes, short, full, zone, placeName, mapUrl, gcalUrl, sharePoll, shareLink, makeCard, showCard, fieldCenter, SHARE_TEXT };
})();
