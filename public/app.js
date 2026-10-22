'use strict';
const $ = id => document.getElementById(id);
const COLORS = ['#3b82f6', '#a855f7', '#14b8a6', '#eab308', '#ec4899', '#22c55e', '#f43f5e', '#06b6d4'];
let ws, S = null, sess = JSON.parse(localStorage.getItem('scram') || 'null'), offset = 0, watchId = null, myLoc = null;
let dismissedRound = -1, viewingEnd = false, lastRound = -1, endLayer = null, lastMsgAt = Date.now(), syncSentAt = 0;
let map, endMap, layers = {}, wakeLock = null, retry = 0, pendingAction = null, lastPingN = 0;
const fmt = ms => { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ago = ts => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };
const tnow = () => Date.now() + offset;
const show = id => { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id); };
function toast(t, ms = 2500) { const e = $('toast'); e.textContent = t; e.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.add('hidden'), ms); }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

if (!$('name').value) $('name').value = localStorage.getItem('scramName') || '';
const qcode = new URLSearchParams(location.search).get('code'); if (qcode) $('code').value = qcode;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const sock = ws, guard = setTimeout(() => { if (sock.readyState === 0) sock.close(); }, 6000); // stuck handshake (some tunnels) -> retry
  ws.onopen = () => {
    clearTimeout(guard); retry = 0; $('btnCreate').disabled = $('btnJoin').disabled = false; $('btnCreate').textContent = 'Create game'; document.body.dataset.ready = '1';
    if (pendingAction) { ws.send(JSON.stringify(pendingAction)); pendingAction = null; }
    else if (sess && (!qcode || qcode === sess.code)) ws.send(JSON.stringify({ type: 'rejoin', code: sess.code, token: sess.token }));
  };
  ws.onmessage = e => { lastMsgAt = Date.now(); syncSentAt = 0; handle(JSON.parse(e.data)); };
  ws.onclose = () => { if (sock !== ws) return; setTimeout(connect, Math.min(5000, 500 * 2 ** retry++)); if (S) toast('Reconnecting…'); };
}
const sendMsg = m => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));

function handle(m) {
  if (m.type === 'joined') { sess = { code: m.code, token: m.token }; localStorage.setItem('scram', JSON.stringify(sess)); history.replaceState(null, '', '/?code=' + m.code); startGps(); if (myLoc) sendLoc(myLoc); }
  else if (m.type === 'error') { toast(m.error, 4000); if (m.reset) { sess = null; localStorage.removeItem('scram'); show('home'); } }
  else if (m.type === 'left') { resetLocal(); toast('You left the lobby'); }
  else if (m.type === 'gone') { toast(m.kicked ? 'Removed from lobby' : 'Lobby closed'); sess = null; S = null; localStorage.removeItem('scram'); show('home'); }
  else if (m.type === 'ping') { if (m.locs) { toast(`📡 Ping #${m.n}: hider locations updated`); if (S && S.state === 'playing') { S.last = S.last || {}; for (const [id, l] of Object.entries(m.locs)) if (l) S.last[id] = { ...l, t: m.t }; for (const id of m.hidden || []) delete S.last[id]; S.pingCount = m.n; render(); } } else if (S && me()?.role === 'hider') { toast(m.out ? `💰 Surprise ping — a hunter grabbed the bounty and saw you!` : `📡 Ping #${m.n} — hunters just saw your location!`, 4000); navigator.vibrate?.(300); } }
  else if (m.type === 'chime') { playChime(); navigator.vibrate?.([200, 100, 200]); toast('🔔 You chimed! A hunter is within 40 m', 5000); fx('🔔 You chimed at the last ping — a hunter is close!'); }
  else if (m.type === 'chimeNearby') { const e = $('chimeNote'); e.textContent = `🔔 ${m.n > 1 ? m.n + ' hiders' : 'A hider'} chimed nearby!`; e.classList.remove('hidden'); clearTimeout(e.t); e.t = setTimeout(() => e.classList.add('hidden'), 15000); toast(e.textContent, 4000); }
  else if (m.type === 'bounty') { toast(m.effect === 'wipe' ? '💰 Bounty! Your next ping is wiped — hunters will see nothing.' : '💰 Bounty! Surprise ping of all hiders.', 5000); if (m.effect === 'wipe') fx('💰 Cloaked: your next ping is wiped.'); }
  else if (m.type === 'camRequest') takePhoto();
  else if (m.type === 'camPeek') { photos[m.id] = m; renderPhotos(); if (m.data || m.unavailable) toast(`📷 Sneak peek: ${m.name}${m.data ? '' : ' — photo unavailable'}`); }
  else if (m.type === 'compass') { compassData = m; renderCompass(); }
  else if (m.type === 'state') { offset = m.serverNow - Date.now(); S = m; window.S = m; render(); }
}
const me = () => S && S.players.find(p => p.id === S.you);

setInterval(() => {
  if (!sess || !ws || ws.readyState !== 1) return;
  if (syncSentAt && Date.now() - syncSentAt > 8000) { try { ws.close(); } catch {} syncSentAt = 0; return; }
  if (Date.now() - lastMsgAt > 10000 && !syncSentAt) { syncSentAt = Date.now(); sendMsg({ type: 'sync' }); }
}, 2000);
function resetLocal() {
  sess = null; S = null; window.S = null; viewingEnd = false; lastRound = -1; localStorage.removeItem('scram');
  if (endMap) { endMap.remove(); endMap = null; endLayer = null; } if (map) { map.remove(); map = null; layers = {}; }
  history.replaceState(null, '', '/'); show('home');
}
// ---------- GPS ----------
function startGps() {
  if (watchId !== null) return;
  if (!('geolocation' in navigator)) { sendMsg({ type: 'perm', perm: 'unsupported' }); return setGps('❌ This browser has no GPS support'); }
  if (!window.isSecureContext) setGps('❌ Location needs HTTPS');
  watchId = navigator.geolocation.watchPosition(pos => {
    myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, ts: pos.timestamp || Date.now() };
    sendLoc(myLoc);
  }, err => {
    const perm = err.code === 1 ? 'denied' : 'error';
    sendMsg({ type: 'perm', perm });
    setGps(err.code === 1 ? '❌ Location blocked. Allow it in browser settings (🔒 icon / Settings › Safari › Location) and reload.' : '⚠️ GPS error: ' + err.message);
    if (err.code === 1) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
function sendLoc(l) { sendMsg({ type: 'loc', ...l }); setGps(`✅ GPS on · ±${Math.round(l.acc)} m`); }
setInterval(() => { if (myLoc) sendLoc(myLoc); }, 15000); // heartbeat keeps "fresh" status even if stationary
function setGps(t) { $('gpsStatus').textContent = t; $('btnGps').classList.toggle('hidden', t.startsWith('✅')); }
$('btnGps').onclick = () => { watchId !== null && navigator.geolocation.clearWatch(watchId); watchId = null; startGps(); };

async function wake() {
  try { if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => wakeLock = null; } } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { wake(); if (ws?.readyState !== 1) { try { ws.close(); } catch {} } else sendMsg({ type: 'sync' }); if (myLoc) sendLoc(myLoc); }
});

// ---------- home ----------
// ---------- audio (Web Audio, unlocked on first tap) ----------
let actx = null;
function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); const o = actx.createOscillator(), g = actx.createGain(); g.gain.value = 0; o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.01); } catch {} }
function playChime() {
  if (!actx) return; actx.resume?.(); const t = actx.currentTime;
  for (const [f, d] of [[880, 0], [1320, 0.25], [1760, 0.5]]) {
    const o = actx.createOscillator(), g = actx.createGain(); o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.5, t + d + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    o.connect(g).connect(actx.destination); o.start(t + d); o.stop(t + 1.5);
  }
}
document.addEventListener('pointerdown', unlockAudio, { once: true });
const fx = t => { $('hiderFx').textContent = t; };

// ---------- camera (one rear-camera frame at minute 10) ----------
const photos = {}; let camConsent = localStorage.getItem('scramCam'); let compassData = null, heading = null;
async function askCam() {
  unlockAudio();
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    st.getTracks().forEach(t => t.stop()); camConsent = 'granted';
  } catch { camConsent = 'denied'; toast('Camera blocked — hunters will see “photo unavailable”'); }
  localStorage.setItem('scramCam', camConsent); sendMsg({ type: 'cam', cam: camConsent }); renderLobby();
}
async function takePhoto() {
  if (camConsent !== 'granted' || document.visibilityState !== 'visible' || !navigator.mediaDevices) return sendMsg({ type: 'camPhoto', unavailable: true });
  let st;
  try {
    st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 640 } }, audio: false });
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = st; await v.play();
    await new Promise(r => setTimeout(r, 400)); // let exposure settle
    const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    sendMsg({ type: 'camPhoto', data: c.toDataURL('image/jpeg', 0.6) }); toast('📷 Hunters just got a sneak-peek photo');
  } catch { sendMsg({ type: 'camPhoto', unavailable: true }); }
  finally { st?.getTracks().forEach(t => t.stop()); }
}
function renderPhotos() {
  const all = { ...(S?.photos || {}) }; for (const [id, p] of Object.entries(photos)) all[id] = { ...all[id], ...p };
  const html = Object.entries(all).map(([id, p]) => `<div class="ph">${p.data ? `<img data-ph="${id}" src="${p.data}" alt="">` : `<div class="na">${p.pending ? '⏳' : '🚫 photo unavailable'}</div>`}${esc(p.name || '')}</div>`).join('');
  $('camStrip').innerHTML = html ? `<div><b>📷 Sneak peek</b></div>${html}` : '';
  for (const i of document.querySelectorAll('[data-ph]')) i.onclick = () => { $('photoBig').src = i.src; $('photoCap').textContent = '📷 ' + (all[i.dataset.ph].name || '') + ' · tap to close'; $('photoView').classList.remove('hidden'); };
}
$('photoView').onclick = () => $('photoView').classList.add('hidden');

// ---------- sudden-death compass ----------
function onOrient(e) { const h = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null); if (h != null) { heading = h; renderCompass(); } }
async function enableHeading() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') { // iOS 13+
      if (await DeviceOrientationEvent.requestPermission() !== 'granted') return toast('Compass permission denied — arrow is north-up');
    }
    window.addEventListener('deviceorientationabsolute', onOrient); window.addEventListener('deviceorientation', onOrient);
    $('btnHeading').classList.add('hidden');
  } catch { toast('No phone compass — arrow is north-up'); }
}
$('btnHeading').onclick = enableHeading;
const BANDS = { scorching: ['🔥 SCORCHING', '#ef4444'], hot: ['🔥 HOT', '#f97316'], warm: ['WARM', '#eab308'], cool: ['COOL', '#38bdf8'], cold: ['❄️ COLD', '#60a5fa'] };
function renderCompass() {
  const on = S && S.compass && me()?.role === 'hunter';
  $('compass').classList.toggle('hidden', !on); if (!on) return;
  if (!compassData || compassData.none) { $('compassBand').textContent = 'No signal'; $('compassNote').textContent = 'Waiting for GPS…'; return; }
  const rot = compassData.bearing - (heading ?? 0) - 90;
  $('arrow').style.transform = `rotate(${rot}deg)`;
  const [txt, col] = BANDS[compassData.band] || [compassData.band, '#fff'];
  $('compassBand').textContent = txt; $('compassBand').style.color = col;
  $('compassNote').textContent = heading == null ? 'Arrow is north-up (top = north). Points at the nearest hider.' : 'Arrow follows your phone heading → nearest hider.';
  $('btnHeading').classList.toggle('hidden', heading != null);
}

function go(type) {
  const name = $('name').value.trim(); if (!name) return toast('Enter your name');
  localStorage.setItem('scramName', name);
  const msg = type === 'create' ? { type, name } : { type, name, code: $('code').value.trim().toUpperCase() };
  if (type === 'join' && msg.code.length < 4) return toast('Enter the join code');
  startGps(); wake(); unlockAudio();
  if (ws?.readyState === 1) sendMsg(msg); else pendingAction = msg;
}
$('btnCreate').onclick = () => go('create'); $('btnJoin').onclick = () => go('join');

// ---------- lobby ----------
const sec = { game: v => v / 60, ping: v => v, hide: v => v };
function renderLobby() {
  show('lobby');
  const url = location.origin + '/j/' + S.code;
  const hp = S.players.find(p => p.id === S.host); $('hostName').textContent = '👑 Host: ' + (hp ? hp.name : '?') + (S.host === S.you ? ' (you)' : '');
  $('lobbyCode').textContent = S.code; $('joinUrl').textContent = url;
  if ($('qr').dataset.c !== S.code) { $('qr').src = '/qr/' + S.code + '.svg'; $('qr').dataset.c = S.code; }
  const isHost = S.you === S.host;
  $('hostPanel').classList.toggle('hidden', !isHost); $('waitHost').classList.toggle('hidden', isHost);
  $('playerList').innerHTML = S.players.map(p => {
    const gps = p.perm === 'granted' ? (p.stale ? `<span class="pill bad">GPS stale</span>` : `<span class="pill ok">GPS ±${p.acc ?? '?'}m</span>`)
      : `<span class="pill bad">${p.perm === 'denied' ? 'GPS blocked' : 'no GPS yet'}</span>`;
    const role = isHost ? `<button class="small pill ${p.role}" data-role="${p.id}">${p.role === 'hunter' ? '🔦 hunter' : '🙈 hider'}</button>`
      : `<span class="pill ${p.role}">${p.role === 'hunter' ? '🔦 hunter' : '🙈 hider'}</span>`;
    const cam = p.role === 'hider' && S.settings.features?.cam ? (p.cam === 'granted' ? '<span class="pill ok">📷</span>' : p.cam === 'denied' ? '<span class="pill bad">no 📷</span>' : '') : '';
    return `<li><span class="nm">${esc(p.name)}${cam}${p.host ? ' 👑' : ''}${p.id === S.you ? ' (you)' : ''}${p.connected ? '' : ' 💤'}</span>${gps}${role}</li>`;
  }).join('');
  for (const b of document.querySelectorAll('[data-role]')) b.onclick = () => { const p = S.players.find(x => x.id === b.dataset.role); sendMsg({ type: 'role', id: p.id, role: p.role === 'hunter' ? 'hider' : 'hunter' }); };
  const st = S.settings; const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  set('sGame', +(st.gameSec / 60).toFixed(2)); set('sPing', st.pingSec); set('sHide', st.hideSec);
  $('sBecome').checked = st.caughtBecomeHunter; $('sReveal').checked = st.showRevealed;
  for (const [f, id] of FEAT) $(id).checked = !!st.features?.[f];
  const m = me(), hider = m && m.role === 'hider';
  $('camPanel').classList.toggle('hidden', !(hider && st.features?.cam));
  if (m && camConsent && m.cam !== camConsent) sendMsg({ type: 'cam', cam: camConsent });
  $('camStatus').textContent = m?.cam === 'granted' ? '✅ Ready · camera allowed' : m?.cam === 'denied' ? '✅ Ready · no camera (hunters see “photo unavailable”)' : 'Not ready yet';
}
const FEAT = [['decoy', 'fDecoy'], ['chime', 'fChime'], ['bounty', 'fBounty'], ['cam', 'fCam'], ['compass', 'fCompass']];
function pushSettings() { sendMsg({ type: 'settings', settings: { gameSec: $('sGame').value * 60, pingSec: +$('sPing').value, hideSec: +$('sHide').value, caughtBecomeHunter: $('sBecome').checked, showRevealed: $('sReveal').checked,
  features: Object.fromEntries(FEAT.map(([f, id]) => [f, $(id).checked])) } }); }
for (const id of ['sGame', 'sPing', 'sHide', 'sBecome', 'sReveal', ...FEAT.map(x => x[1])]) $(id).onchange = pushSettings;
$('btnQuick').onclick = () => { $('sGame').value = 2; $('sPing').value = 10; $('sHide').value = 10; pushSettings(); toast('2-min test game: pings 10 s, bounty every 30 s, cam at 1:00, compass from 1:48'); };
$('btnReadyCam').onclick = askCam;
$('btnReadyNoCam').onclick = () => { unlockAudio(); camConsent = 'denied'; localStorage.setItem('scramCam', 'denied'); sendMsg({ type: 'cam', cam: 'denied' }); };
$('btnRandom').onclick = () => sendMsg({ type: 'randomize', hunters: +$('sHunters').value || 1 });
$('btnStart').onclick = () => { const bad = S.players.filter(p => p.perm !== 'granted'); if (bad.length && !confirm(`${bad.map(p => p.name).join(', ')} ${bad.length > 1 ? "don't" : "doesn't"} have GPS yet. Start anyway?`)) return; sendMsg({ type: 'start' }); };
$('btnShare').onclick = async () => { const url = location.origin + '/j/' + S.code; try { if (navigator.share) await navigator.share({ title: 'Join my Scram game', url }); else { await navigator.clipboard.writeText(url); toast('Link copied'); } } catch {} };

// ---------- game ----------
function ensureMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false }).setView([myLoc?.lat || 51.5, myLoc?.lng || 0], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  map._fitted = false;
}
function marker(key, loc, color, label, opts = {}) {
  let l = layers[key];
  if (!l) { l = layers[key] = { c: L.circle([loc.lat, loc.lng], { radius: loc.acc, color, weight: 1, fillOpacity: .15 }).addTo(map), m: L.circleMarker([loc.lat, loc.lng], { radius: 9, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 }).addTo(map) }; l.m.bindTooltip('', { permanent: true, direction: 'top', offset: [0, -8] }); }
  l.c.setLatLng([loc.lat, loc.lng]).setRadius(loc.acc || 5); l.m.setLatLng([loc.lat, loc.lng]).setStyle({ fillColor: color, dashArray: opts.dash ? '4' : null });
  l.m.setTooltipContent(label); l.seen = true;
}
function renderGame() {
  if (S.round !== lastRound && map) { for (const k in layers) { map.removeLayer(layers[k].c); map.removeLayer(layers[k].m); } layers = {}; map._fitted = false; }
  lastRound = S.round;
  show('game'); ensureMap(); setTimeout(() => map.invalidateSize(), 50);
  const m = me(), hunter = m.role === 'hunter';
  $('roleBadge').textContent = hunter ? '🔦 HUNTER' : (m.caught ? '😵 CAUGHT' : '🙈 HIDER'); $('roleBadge').style.background = hunter ? '#c2410c' : '#1d4ed8';
  $('hideCover').classList.toggle('hidden', !(hunter && S.state === 'hiding'));
  $('hunterPanel').classList.toggle('hidden', !hunter); $('hiderPanel').classList.toggle('hidden', hunter || m.caught);
  $('btnEnd').classList.toggle('hidden', S.you !== S.host);
  for (const k in layers) layers[k].seen = false;
  const pts = [];
  // me
  if (m.loc) { marker('me', m.loc, '#22c55e', 'You'); pts.push([m.loc.lat, m.loc.lng]); }
  // other hunters live (server only sends these to hunters)
  S.players.filter(p => p.id !== S.you && p.role === 'hunter' && p.loc).forEach(p => { marker('h' + p.id, p.loc, '#f97316', '🔦 ' + esc(p.name)); pts.push([p.loc.lat, p.loc.lng]); });
  // hiders: last ping only
  const last = S.last || {};
  const hiders = S.players.filter(p => p.role === 'hider' || p.caught);
  if (hunter) hiders.forEach((p, i) => {
    const lp = last[p.id];
    if (lp && !p.caught) { marker('x' + p.id, lp, COLORS[i % COLORS.length], `🙈 ${esc(p.name)} · ${ago(lp.t - lp.age - offset)}`); pts.push([lp.lat, lp.lng]); }
  });
  if (S.bounty) {
    const b = S.bounty;
    if (!layers.bounty || layers.bounty.id !== b.id) {
      if (layers.bounty) { map.removeLayer(layers.bounty.c); map.removeLayer(layers.bounty.m); }
      layers.bounty = { id: b.id, c: L.circle([b.lat, b.lng], { radius: 15, color: '#facc15', weight: 2, fillOpacity: .25, dashArray: '5' }).addTo(map),
        m: L.marker([b.lat, b.lng], { icon: L.divIcon({ className: 'bountyIcon', html: '💰', iconSize: [30, 30], iconAnchor: [15, 15] }) }).bindTooltip('💰 Bounty — get within 15 m', { permanent: true, direction: 'top', offset: [0, -14] }).addTo(map) };
      if (!map.getBounds().contains([b.lat, b.lng])) map.fitBounds(L.latLngBounds([...pts, [b.lat, b.lng]]).pad(.2), { maxZoom: 17 });
    }
    layers.bounty.seen = true;
  }
  if (!hunter && m.loc && !map.getBounds().pad(-0.1).contains([m.loc.lat, m.loc.lng])) map.panTo([m.loc.lat, m.loc.lng]);
  for (const k in layers) if (!layers[k].seen) { map.removeLayer(layers[k].c); map.removeLayer(layers[k].m); delete layers[k]; }
  if (pts.length && (!map._fitted || (S.pingCount !== lastPingN && hunter))) { map.fitBounds(L.latLngBounds(pts).pad(.3), { maxZoom: 17 }); map._fitted = true; lastPingN = S.pingCount; }
  if (hunter) {
    $('hiderBtns').innerHTML = hiders.map(p => `<button ${p.caught ? 'disabled' : ''} class="${p.caught ? '' : 'hunt'}" data-catch="${p.id}"><span>${p.caught ? '✅' : '🙈'} ${esc(p.name)}</span><span>${p.caught ? 'caught' : 'Mark caught'}</span></button>`).join('') || '<p class="note">No hiders left</p>';
    for (const b of document.querySelectorAll('[data-catch]')) b.onclick = () => { const p = S.players.find(x => x.id === b.dataset.catch); if (confirm(`Mark ${p.name} as caught?`)) sendMsg({ type: 'catch', id: p.id }); };
  } else {
    const dOn = S.settings.features?.decoy && !S.compass;
    $('btnDecoy').classList.toggle('hidden', !S.settings.features?.decoy);
    $('btnDecoy').disabled = !dOn || S.decoyArmed || !S.decoys;
    $('btnDecoy').classList.toggle('armed', !!S.decoyArmed);
    $('decoyCount').textContent = S.decoyArmed ? '· ARMED for next ping' : `· ${S.decoys ?? 0}/2 charges`;
    if (S.cloaked) fx('💰 Cloaked: your next ping is wiped.'); else if (S.decoyArmed) fx('👻 Decoy armed: next ping shows a fake spot 30-150 m away.');
    $('revealed').textContent = S.revealedAt ? `Hunters last saw your location ${ago(S.revealedAt - offset)}.` : (S.settings.showRevealed ? 'Not revealed yet.' : '');
  }
  if (hunter) renderPhotos();
  renderCompass();
  const ev = S.events[S.events.length - 1];
  $('banner').classList.toggle('hidden', !ev || tnow() - ev.t > 6000); if (ev) $('banner').textContent = ev.text;
}
$('btnCaughtSelf').onclick = () => { if (confirm('Confirm you were caught?')) sendMsg({ type: 'caughtSelf' }); };
$('btnEnd').onclick = () => { if (confirm('End the game for everyone?')) sendMsg({ type: 'end' }); };

function warnings() {
  if (!S || S.state === 'lobby' || S.state === 'ended') return;
  const m = me(), w = [];
  if (!myLoc) w.push('No GPS fix yet — your location is not being shared.');
  else if (Date.now() - myLoc.ts > 45000) w.push(`Your GPS is stale (${ago(myLoc.ts)}). Keep the screen on and this tab open.`);
  else if (myLoc.acc > 100) w.push(`GPS accuracy is poor (±${Math.round(myLoc.acc)} m).`);
  if (m.role === 'hunter') S.players.filter(p => p.role === 'hider' && !p.caught && p.stale).forEach(p => w.push(`${p.name}'s GPS is stale/offline — their next ping may be old.`));
  if (ws?.readyState !== 1) w.push('Disconnected — reconnecting…');
  $('warn').innerHTML = w.map(esc).join('<br>'); $('warn').classList.toggle('hidden', !w.length);
}
setInterval(() => {
  if (!S) return;
  const t = tnow();
  if (S.state === 'hiding') { $('clock').textContent = fmt(S.hideEndsAt - t); $('pingClock').textContent = 'Head start'; $('hideClock').textContent = fmt(S.hideEndsAt - t); }
  else if (S.state === 'playing') { $('clock').textContent = fmt(S.endsAt - t); $('pingClock').innerHTML = S.compass ? '🧭 <b>SUDDEN<br>DEATH</b>' : `Next ping<br><b>${fmt(S.nextPingAt - t)}</b>`; }
  warnings();
}, 250);

// ---------- end ----------
function renderEnd() {
  show('end');
  $('winner').textContent = S.winner === 'hiders' ? '🙈 Hiders win!' : '🔦 Hunters win!';
  const hiders = S.players.filter(p => p.caught || p.role === 'hider');
  $('summary').innerHTML = hiders.map((p, i) => { const n = S.pings.filter(pg => pg.locs[p.id]).length;
    return `<div class="sumrow"><b style="color:${COLORS[i % COLORS.length]}">● ${esc(p.name)}</b> — ${p.caught ? 'caught at ' + fmt(p.caughtAt - S.startedAt) : 'survived'} · ${n} ping${n === 1 ? '' : 's'}</div>`; }).join('') +
    `<p class="note">${S.pingCount} pings · ${S.events.map(e => esc(e.text)).join(' · ')}</p>`;
  if (!endMap) { endMap = L.map('endMap'); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(endMap); }
  if (endLayer) endLayer.remove(); endLayer = L.layerGroup().addTo(endMap);
  const all = [];
  hiders.forEach((p, i) => {
    const trail = S.pings.map(pg => pg.locs[p.id]).filter(Boolean).map(l => [l.lat, l.lng]);
    if (!trail.length) return; all.push(...trail);
    const c = COLORS[i % COLORS.length];
    L.polyline(trail, { color: c, weight: 4 }).addTo(endLayer);
    trail.forEach((ll, k) => L.circleMarker(ll, { radius: 5, color: c, fillOpacity: 1 }).bindTooltip(`${esc(p.name)} #${k + 1}`).addTo(endLayer));
  });
  setTimeout(() => { endMap.invalidateSize(); if (all.length) endMap.fitBounds(L.latLngBounds(all).pad(.2)); else endMap.setView([myLoc?.lat || 0, myLoc?.lng || 0], 15); }, 50);
}
$('btnHome').onclick = () => { viewingEnd = false; dismissedRound = S ? S.round : -1; sendMsg({ type: 'rematch' }); if (S && S.state === 'lobby') render(); };
function leaveLobby(ask) { if (ask && !confirm('Leave this lobby? You will be removed from the game.')) return; if (ws?.readyState === 1 && sess) sendMsg({ type: 'leave' }); else resetLocal(); setTimeout(() => { if (sess) resetLocal(); }, 3000); }
$('btnLeaveEnd').onclick = () => leaveLobby(false); $('btnLeaveLobby').onclick = () => leaveLobby(false); $('btnLeaveGame').onclick = () => leaveLobby(true);

$('btnDecoy').onclick = () => { if (confirm('Use a ghost decoy? Your NEXT ping will show hunters a fake spot 30-150 m away.')) sendMsg({ type: 'decoy' }); };
function render() {
  if (!S) return;
  if (S.state === 'lobby') { for (const k in photos) delete photos[k]; compassData = null; }
  if (S.state === 'ended' && S.round === dismissedRound) { renderLobby(); sendMsg({ type: 'rematch' }); }
  else if (S.state === 'ended') { if (!viewingEnd) { viewingEnd = true; S._endSnap = true; renderEnd(); } else if (S.pings) renderEnd(); }
  else if (S.state === 'lobby' && viewingEnd) { // someone started a rematch; keep showing my summary until I tap Play again
    $('rematchNote').textContent = '🔁 The lobby is back in the waiting room — tap Play again to join the next round.'; $('rematchNote').classList.remove('hidden');
  } else { viewingEnd = false; $('rematchNote').classList.add('hidden'); if (S.state === 'lobby') renderLobby(); else renderGame(); }
  if (S.state !== 'ended') wake();
}
connect();
