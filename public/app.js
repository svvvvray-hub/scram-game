'use strict';
// creator credit on the recap / share image / reel: server env CREATOR_HANDLE + CREATOR_PLATFORM via /config.js
const CREATOR = window.CREATOR && Socials.norm(window.CREATOR) || { handle: 'mmmmmray', platform: 'instagram' };
const LEGAL_VERSION = '2026-10-22'; // bump to re-ask for 18+/Terms/Privacy consent
const SHARE_LINK = location.origin + '/play'; // controllable redirect (server: PLAY_REDIRECT_URL); ?ref=<handle> is appended
window.SHARE_LINK = SHARE_LINK;
const $ = id => document.getElementById(id);
// anonymous device id (random, no personal data) + first referrer, for aggregate growth stats
const DEV = localStorage.getItem('scramDev') || (() => { const v = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now()); localStorage.setItem('scramDev', v); return v; })();
{ const r = new URLSearchParams(location.search).get('ref'); if (r && !localStorage.getItem('scramRef')) localStorage.setItem('scramRef', r.slice(0, 40)); }
window.trackShare = k => { try { navigator.sendBeacon?.('/api/share', new Blob([JSON.stringify({ k })], { type: 'application/json' })); } catch {} };
const COLORS = ['#3b82f6', '#a855f7', '#14b8a6', '#eab308', '#ec4899', '#22c55e', '#f43f5e', '#06b6d4'];
let ws, S = null, sess = JSON.parse(localStorage.getItem('scram') || 'null'), offset = 0, watchId = null, myLoc = null;
let dismissedRound = -1, viewingEnd = false, lastRound = -1, endLayer = null, lastMsgAt = Date.now(), syncSentAt = 0;
let nearestId = null, map, endMap, layers = {}, wakeLock = null, retry = 0, pendingAction = null, lastPingN = 0;
const fmt = ms => { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ago = ts => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };
const tnow = () => Date.now() + offset;
const show = id => { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id); if (id !== 'game') for (const x of document.querySelectorAll('.sheet, #roleCard')) x.classList.add('hidden'); };
function toast(t, ms = 2500) { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('show'), ms); }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

if (!$('name').value) $('name').value = localStorage.getItem('scramName') || '';
{ const sp = localStorage.getItem('scramPlatform'); $('platform').value = Socials.isPlatform(sp) ? sp : Socials.DEFAULT; } // remembered platform choice (old saves = Instagram)
if (!$('ig').value) $('ig').value = localStorage.getItem('scramIg') ? '@' + localStorage.getItem('scramIg') : '';
$('platform').onchange = () => localStorage.setItem('scramPlatform', $('platform').value);
// pasting a profile link picks the platform automatically
$('ig').addEventListener('input', () => { const u = Socials.fromUrl($('ig').value.trim()); if (u && u.platform !== $('platform').value) { $('platform').value = u.platform; localStorage.setItem('scramPlatform', u.platform); } });
$('agree').checked = localStorage.getItem('scramLegal') === LEGAL_VERSION;
// a player's handle: platform icon + @handle, linking to their profile on that platform
const igLink = so => so && Socials.norm(so) ? `<a class="ig" data-platform="${so.platform}" href="${esc(Socials.url(so))}" target="_blank" rel="noopener" title="${esc(Socials.label(so.platform))}">${Socials.icon(so.platform, 14)}@${esc(so.handle)}</a>` : '';
window.igLink = igLink; window.CREATOR = CREATOR; window.CREATOR_IG = CREATOR.handle; // CREATOR_IG kept for older callers
const qcode = new URLSearchParams(location.search).get('code'); if (qcode) { $('code').value = qcode.toUpperCase(); $('code').classList.add('prefilled'); $('btnJoin').classList.add('primary'); $('btnJoin').dataset.code = qcode.toUpperCase(); }

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const sock = ws, guard = setTimeout(() => { if (sock.readyState === 0) sock.close(); }, 6000); // stuck handshake (some tunnels) -> retry
  ws.onopen = () => {
    clearTimeout(guard); timeSync(); retry = 0; $('btnCreate').disabled = $('btnJoin').disabled = false; $('btnCreate').textContent = 'Create game'; if ($('btnJoin').dataset.code) $('btnJoin').textContent = 'Join game ' + $('btnJoin').dataset.code; document.body.dataset.ready = '1';
    if (pendingAction) { ws.send(JSON.stringify(pendingAction)); pendingAction = null; }
    else if (sess && (!qcode || qcode === sess.code) && !S) ws.send(JSON.stringify({ type: 'rejoin', code: sess.code, token: sess.token })); // auto-rejoin (load / reconnect / page visible again)
    else if (sess && S && S.code === sess.code) ws.send(JSON.stringify({ type: 'rejoin', code: sess.code, token: sess.token }));
    else if (sess) ws.send(JSON.stringify({ type: 'peek', code: sess.code, token: sess.token })); // different invite opened: offer a Rejoin button
  };
  ws.onmessage = e => { lastMsgAt = Date.now(); syncSentAt = 0; handle(JSON.parse(e.data)); };
  ws.onclose = () => { if (sock !== ws) return; setTimeout(connect, Math.min(5000, 500 * 2 ** retry++)); if (S) toast('Reconnecting…'); };
}
const sendMsg = m => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));

// ---------- plan the next game (poll; see plan.js) ----------
let planCode = null, planBy = '', areaRound = -1;
const canPlan = () => S && (S.you === S.host || !!window.RULES?.planAnyone);
function renderPlanBox() { if (!S) return;
  $('btnPlan').classList.toggle('hidden', !canPlan() || !!planCode); $('btnPlanOpen').classList.toggle('hidden', !planCode);
  $('btnPlanOpen').textContent = planCode && window.Plan && localStorage.getItem('scramPolls')?.includes('"' + planCode + '"') ? '📅 Open your poll' : '🗳 Vote on the next game';
  $('planNote').classList.toggle('hidden', !planCode); $('planNote').textContent = planCode ? `📅 ${planBy || 'The host'} started a poll for the next game · /p/${planCode}` : ''; }
$('btnPlan').onclick = () => { const p = me(); Plan.openCreate({ field: S?.field, name: p?.name || localStorage.getItem('scramName') || '', social: p?.social || null, lobby: S?.code, loc: myLoc,
  onCreated: code => { planCode = code; planBy = p?.name || ''; sendMsg({ type: 'plan', code }); renderPlanBox(); } }); };
$('btnPlanOpen').onclick = () => planCode && Plan.openPoll(planCode);
function handle(m) {
  if (m.type === 'plan') { const fresh = planCode !== m.code; planCode = m.code; planBy = m.by || ''; renderPlanBox(); if (fresh && S && m.by !== me()?.name) toast(`📅 ${m.by || 'The host'} is planning the next game. Vote!`, 4000); return; }
  if (m.type === 'session') { if (m.ok && m.state !== 'ended') showRejoin(m); else { $('btnRejoin').classList.add('hidden'); if (!m.ok) { sess = null; localStorage.removeItem('scram'); } } }
  else if (m.type === 'joined') { $('btnRejoin').classList.add('hidden'); sess = { code: m.code, token: m.token, id: m.id, at: Date.now() }; localStorage.setItem('scram', JSON.stringify(sess)); history.replaceState(null, '', '/?code=' + m.code); startGps(); maybeSend(true); }
  else if (m.type === 'error') { if (m.busy) { $('busyMsg').textContent = m.error; $('busyMsg').classList.remove('hidden'); } else toast(m.error, 4000); if (m.reset) { sess = null; localStorage.removeItem('scram'); show('home'); } }
  else if (m.type === 'left') { resetLocal(); toast('You left the lobby'); }
  else if (m.type === 'gone') { toast(m.kicked ? 'Removed from lobby' : 'Lobby closed'); sess = null; S = null; localStorage.removeItem('scram'); show('home'); }
  else if (m.type === 'need_fix') freshFix();
  else if (m.type === 'ping') { onPingFx(m); if (m.locs) { nearestId = m.nearest || null; toast(`📡 Ping #${m.n}: hider locations updated`); if (S && S.state === 'playing') { S.last = S.last || {}; for (const [id, l] of Object.entries(m.locs)) if (l) S.last[id] = { ...l, t: m.t }; for (const id of m.hidden || []) delete S.last[id]; S.pingCount = m.n; render(); } } else if (S && me()?.role === 'hider') { toast(m.out ? `💰 Surprise ping — a hunter grabbed the bounty and saw you!` : `📡 Ping #${m.n} — hunters just saw your location!`, 4000); navigator.vibrate?.(300); } }
  else if (m.type === 'chime') { playChime(); toast(m.sonar ? '🔊 Sonar made you chime! A hunter is within 75 m' : '🔔 You chimed! A hunter is within 40 m', 5000); fx('🔔 You chimed at the last ping — a hunter is close!'); coach('chime'); }
  else if (m.type === 'chimeNearby') { const e = $('chimeNote'); e.textContent = `🔔 ${m.n > 1 ? m.n + ' hiders' : 'A hider'} chimed nearby!`; e.classList.remove('hidden'); clearTimeout(e.t); e.t = setTimeout(() => e.classList.add('hidden'), 15000); toast(e.textContent, 4000); coach('chimeHunter'); }
  else if (m.type === 'bounty') { toast(m.effect === 'wipe' ? '💰 Bounty! Your next ping is wiped — hunters will see nothing.' : '💰 Bounty! Surprise ping of all hiders.', 5000); if (m.effect === 'wipe') fx('💰 Cloaked: your next ping is wiped.'); }
  else if (m.type === 'camRequest') takePhoto();
  else if (m.type === 'infected') { toast('🧟 You were caught — you are now a HUNTER! You will get pings now.', 6000); navigator.vibrate?.([300, 100, 300]); showRoleCard('infected'); coach('infected'); }
  else if (m.type === 'catchPrompt') { navigator.vibrate?.([200, 100, 200]); toast(m.by === 'hider' ? `🙋 ${m.hider} says they were caught — confirm?` : `🎯 ${m.hunter} says they caught you — confirm?`, 5000); }
  else if (m.type === 'chimeTest') { chimeTestId = m.id; window.lastChimeTest = { id: m.id, vol: m.vol, at: Date.now(), unlocked: audioReady() };
    if (audioReady()) playChime({ vol: m.vol }); else $('soundUnlock').classList.remove('hidden'); renderChimeVote(m); }
  else if (m.type === 'drop') toast(m.side === 'hider' ? '🎁 A hider power-up dropped — only hiders can see it!' : '⚡ A hunter power-up dropped!', 4000);
  else if (m.type === 'puGot') { const [i, l] = PU_INFO[m.ptype] || ['🎁', m.ptype]; toast(`${i} Got ${l}! Tap to use it.`, 4000); navigator.vibrate?.(150); coach('powerup'); }
  else if (m.type === 'puNote') toast(m.text, 4000);
  else if (m.type === 'powerUsed') toast(m.mine ? `${m.icon} You used ${m.label}!${m.note || ''}` : `${m.icon} ${m.who} used ${m.label}!${m.note || ''}`, 4000);
  else if (m.type === 'sonar') { const e = $('sonarAlert'); e.textContent = `🔊 Hunter ${m.by} used Sonar!`; e.classList.remove('hidden'); clearTimeout(e.t); e.t = setTimeout(() => e.classList.add('hidden'), 4000); toast(`🔊 Hunter ${m.by} used Sonar!`, 4000); navigator.vibrate?.([300, 100, 300]); }
  else if (m.type === 'revived') toast('💖 You were revived — you are a hider again! Run!', 6000);
  else if (m.type === 'shieldBlocked') toast(`🛡️ Shield blocked! ${m.hider} can't be caught this time`, 5000);
  else if (m.type === 'dropFlash') { flashSpot(m); toast(`🦝 A hider destroyed a hunter drop${me()?.role === 'hunter' ? ` — ${m.name} was pinged!` : ''}`, 5000); }
  else if (m.type === 'heatTrail') { heatData = m; renderHeatTrail(); setTimeout(() => { heatData = null; renderHeatTrail(); }, Math.max(1000, m.until - tnow())); }
  else if (m.type === 'bloodhound') { houndData = m; renderHound(); }
  else if (m.type === 'recap') { window.RecapUI?.set(m.recap); }
  else if (m.type === 'hlAck' || m.type === 'hlAll') window.Reel?.onMsg(m);
  else if (m.type === 'camPeek') { photos[m.id] = m; renderPhotos(); if (m.data || m.unavailable) toast(`📷 Sneak peek: ${m.name}${m.data ? '' : ' — photo unavailable'}`); }
  else if (m.type === 'compass') { compassData = m; renderCompass(); }
  else if (m.type === 'startBlocked') { const names = m.outside.map(o => o.name + (o.noGps ? ' (no GPS)' : '')).join(', '); if (confirm(`Outside the playing field: ${names}. Start anyway?`)) sendMsg({ type: 'start', force: true }); else toast('Outside: ' + names, 5000); }
  else if (m.type === 'time') onTime(m);
  else if (m.type === 'state') { offset = syncedOffset ?? (m.serverNow - Date.now()); if (m.revealAt && m.revealAt !== (S && S.revealAt) && m.revealAt > m.serverNow) timeSync(); const wasOut = S && S.outSince; S = m; window.S = m; if (S.outSince && !wasOut && S.state !== 'lobby') { navigator.vibrate?.([400, 200, 400]); lastVib = Date.now(); } render(); }
}
const me = () => S && S.players.find(p => p.id === S.you);
const PU_INFO = { radar: ['📡', 'Hunter Radar'], jammer: ['📵', 'Jammer'], silent: ['🤫', 'Silent Shoes'], shield: ['🛡️', 'Shield'], extraTime: ['⏩', 'Extra Time'], revive: ['💖', 'Revive'],
  sonar: ['🔊', 'Sonar'], truth: ['🔍', 'Truth Ping'], shrink: ['🎯', 'Shrink Zone'], campeek: ['📷', 'Cam Peek+'], heat: ['🔥', 'Heat Trail'], hound: ['🐕', 'Bloodhound'] };
let heatData = null, houndData = null, heatLayer = null, dropLayers = {};
function flashSpot(m) { if (!map) return; const c = L.circle([m.lat, m.lng], { radius: 40, color: '#ef4444', weight: 4, fillOpacity: .4, className: 'dropFlash' }).addTo(map); setTimeout(() => c.remove(), 5000); }
function renderHeatTrail() {
  if (heatLayer) { heatLayer.remove(); heatLayer = null; } if (!heatData || !map) return;
  heatLayer = L.layerGroup().addTo(map); let i = 0;
  for (const [id, h] of Object.entries(heatData.trails)) { const c = COLORS[i++ % COLORS.length]; if (h.pts.length > 1) L.polyline(h.pts, { color: c, weight: 6, opacity: .7, dashArray: '2 8' }).addTo(heatLayer);
    if (h.pts.length) L.circleMarker(h.pts.at(-1), { radius: 6, color: c }).bindTooltip('🔥 ' + esc(h.name), { permanent: true }).addTo(heatLayer); }
}
function renderHound() {
  const on = houndData && houndData.until > tnow() && me()?.role === 'hunter' && S?.state === 'playing';
  $('houndBox').classList.toggle('hidden', !on); if (!on) return;
  $('houndBox').innerHTML = `<b>🐕 Bloodhound</b> <span class="note">${Math.ceil((houndData.until - tnow()) / 1000)} s</span><br>` + houndData.dists.map(d => `${esc(d.name)}: <b>${d.d == null ? '?' : d.d + ' m'}</b>`).join(' · ');
}
function renderPower() {
  const pu = S.pu, puOn = S.settings.powerups !== 'off' && S.state === 'playing' && !(me()?.role === 'hider' && me()?.caught), b = $('btnPower');
  b.classList.toggle('hidden', !puOn);
  const on = S.state === 'playing' && pu && (pu.held || pu.cooldownUntil > tnow() || pu.shieldUntil > tnow() || pu.radarUntil > tnow());
  if (puOn && pu) { // held slot: icon, cooldown ring, greyed in sudden death
    const cd = Math.max(0, pu.cooldownUntil - tnow()), sd = !!S.compass, [, l] = PU_INFO[pu.held] || [];
    const key = (pu.held || '') + sd; if (b.dataset.k !== key) { b.dataset.k = key; b.querySelector('.ico').innerHTML = pu.held ? Icons.svg(pu.held, 30) : Icons.svg('gift', 26, 1.6); }
    b.querySelector('.lbl').textContent = pu.held ? (sd ? `${l} · off in sudden death` : cd ? `${l} · ${Math.ceil(cd / 1000)}s` : l) : (cd ? `Cooldown ${Math.ceil(cd / 1000)}s` : 'Empty slot');
    b.classList.toggle('empty', !pu.held); b.classList.toggle('sd', sd); b.disabled = !pu.held || sd || cd > 0;
    b.style.setProperty('--cd', cd ? Math.round(cd / Math.max(1, (S.pu.cooldownMs || 180000)) * 100) + '%' : '0%');
  }
  $('puBox').classList.toggle('hidden', !on); if (!on) return;
  const cd = Math.max(0, pu.cooldownUntil - tnow());
  const fx = []; if (pu.radarUntil > tnow()) fx.push(`📡 Radar ${Math.ceil((pu.radarUntil - tnow()) / 1000)} s`); if (pu.shieldUntil > tnow()) fx.push('🛡️ Shield up'); if (pu.silent) fx.push('🤫 Silent Shoes'); if (!pu.held && cd) fx.push(`cooldown ${Math.ceil(cd / 1000)} s`);
  $('puNote').textContent = fx.join(' · ');
}
function renderDrops() {
  if (!map) return; const ds = S.state === 'playing' ? S.drops || [] : [], seen = {};
  for (const d of ds) { seen[d.id] = 1; if (dropLayers[d.id]) continue;
    const hider = d.side === 'hider';
    const g = Icons.has(d.ptype) ? d.ptype : hider ? 'gift' : 'bolt', nm = PU_INFO[d.ptype]?.[1] || 'power-up';
    dropLayers[d.id] = L.layerGroup([L.circle([d.lat, d.lng], { radius: 15, color: hider ? Icons.COL.hider : Icons.COL.hunter, weight: 2, dashArray: '4', fillColor: Icons.COL.drop, fillOpacity: .18 }),
      L.marker([d.lat, d.lng], { icon: L.divIcon({ className: 'mkWrap', html: Icons.badge(g, Icons.COL.drop, { size: 34, cls: 'drop ' + d.side }), iconSize: [34, 34], iconAnchor: [17, 17] }) }).bindTooltip(hider ? `Hider drop: ${nm} · stand here 5 s` : (me()?.role === 'hider' ? `Hunter drop: ${nm} · steal it (you get pinged!)` : `Hunter drop: ${nm} · stand here 5 s`), { permanent: true, direction: 'top', offset: [0, -16] })]).addTo(map); }
  for (const id in dropLayers) if (!seen[id]) { dropLayers[id].remove(); delete dropLayers[id]; }
  const pk = S.pu?.pickup, ring = $('pickupRing');
  ring.classList.toggle('hidden', !pk); if (pk) coach('pickup');
  if (pk) { const k = Math.min(1, (tnow() - pk.since) / pk.need); ring.querySelector('.ring2').style.setProperty('--p', Math.round(k * 100) + '%'); $('pickupPct').textContent = Math.round(k * 100) + '%';
    const d = ds.find(x => x.id === pk.dropId); $('pickupTxt').textContent = d && d.side === 'hunter' && me()?.role === 'hider' ? '🦝 Destroying… (you will be pinged!)' : '🎁 Picking up… stay within 15 m'; }
}

setInterval(() => {
  if (!sess || !ws || ws.readyState !== 1) return;
  if (syncSentAt && Date.now() - syncSentAt > 8000) { try { ws.close(); } catch {} syncSentAt = 0; return; }
  if (Date.now() - lastMsgAt > 10000 && !syncSentAt) { syncSentAt = Date.now(); sendMsg({ type: 'sync' }); }
}, 2000);
function resetLocal() {
  sess = null; S = null; window.S = null; viewingEnd = false; lastRound = -1; planCode = null; localStorage.removeItem('scram');
  if (endMap) { endMap.remove(); endMap = null; endLayer = null; } if (map) { map.remove(); map = null; layers = {}; gameField = null; }
  if (fieldMap) { fieldMap.remove(); fieldMap = null; centerPin = null; fieldKey = ''; drawing = null; }
  history.replaceState(null, '', '/'); show('home');
}
// ---------- GPS ----------
function startGps() {
  if (watchId !== null) return;
  if (!('geolocation' in navigator)) { sendMsg({ type: 'perm', perm: 'unsupported' }); return setGps('❌ This browser has no GPS support'); }
  if (!window.isSecureContext) setGps('❌ Location needs HTTPS');
  watchId = navigator.geolocation.watchPosition(pos => {
    myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, ts: pos.timestamp || Date.now() };
    maybeSend();
  }, err => {
    const perm = err.code === 1 ? 'denied' : 'error';
    sendMsg({ type: 'perm', perm });
    setGps(err.code === 1 ? '❌ Location blocked. Allow it in browser settings (🔒 icon / Settings › Safari › Location) and reload.' : '⚠️ GPS error: ' + err.message);
    if (err.code === 1) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
}
function sendLoc(l) { sendMsg({ type: 'loc', ...l }); setGps(`✅ GPS on · ±${Math.round(l.acc)} m`); }
// Battery saver: adaptive uploads (public/gps.js). Still (<5 m) with no known enemy / drop / bounty within 150 m -> every 15 s, else every 3-5 s.
// Enemy positions used here are only ones this phone already knows (pings for hunters, Radar for hiders): the server never hints proximity.
let lastSent = null, saverOn = false;
function enemyPts() { const m = me(); if (!S || !m) return []; if (m.role === 'hunter') return Object.values(S.last || {}); return S.players.filter(p => p.role === 'hunter' && p.loc).map(p => p.loc); }
function maybeSend(force = false) {
  if (!myLoc) return;
  const running = !!S && (S.state === 'playing' || S.state === 'hiding');
  const d = GpsThrottle.decide({ now: Date.now(), loc: myLoc, last: lastSent, enemies: running ? enemyPts() : [], hot: running ? [...(S.drops || []), ...(S.bounty ? [S.bounty] : [])] : [], urgent: running && !!(S.compass || S.pu?.pickup), force });
  saverOn = running && d.saver; window.gpsSaver = saverOn; $('saverPill').classList.toggle('hidden', !saverOn);
  if (d.send) { sendLoc(myLoc); lastSent = { lat: myLoc.lat, lng: myLoc.lng, t: Date.now() }; window.gpsSends = (window.gpsSends || 0) + 1; }
}
function freshFix() { // server asks ~5 s before a ping: upload a fresh, high-accuracy fix right away
  maybeSend(true);
  navigator.geolocation?.getCurrentPosition(pos => { myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, ts: pos.timestamp || Date.now() }; maybeSend(true); }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 4500 });
}
setInterval(() => maybeSend(), 1000);
function setGps(t) { $('gpsStatus').textContent = t; $('btnGps').classList.toggle('hidden', t.startsWith('✅')); }
$('btnGps').onclick = () => { watchId !== null && navigator.geolocation.clearWatch(watchId); watchId = null; startGps(); };

// Screen wake lock: held while a round is running or a recording is on; re-acquired on visibilitychange, released at game end.
const wantWake = () => !!((S && (S.state === 'playing' || S.state === 'hiding')) || window.Rec?.recording);
let wakeBusy = false;
async function wake() {
  if (!('wakeLock' in navigator)) return;
  if (!wantWake()) return releaseWake();
  if (wakeLock || wakeBusy || document.visibilityState !== 'visible') return;
  wakeBusy = true;
  try { const l = await navigator.wakeLock.request('screen'); if (!wantWake()) l.release().catch(() => {}); else { wakeLock = l; l.addEventListener('release', () => { if (wakeLock === l) wakeLock = null; }); } } catch {}
  finally { wakeBusy = false; }
}
function releaseWake() { const l = wakeLock; wakeLock = null; if (l) l.release().catch(() => {}); }
window.Wake = { sync: wake, release: releaseWake, get held() { return !!wakeLock; }, get supported() { return 'wakeLock' in navigator; } };
window.addEventListener('pageshow', e => { if (e.persisted && ws?.readyState !== 1) { try { ws.close(); } catch {} } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { wake(); if (ws?.readyState !== 1) { try { ws.close(); } catch {} } else sendMsg({ type: 'sync' }); maybeSend(true); if (S) render(); }
});

// ---------- home ----------
// ---------- audio (Web Audio, unlocked on first tap) ----------
let actx = null;
function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); const o = actx.createOscillator(), g = actx.createGain(); g.gain.value = 0; o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.01); } catch {} }
// Soft, pleasant 3-note sine chime (residential-friendly). Volume = host's "Chime volume" (10-100 %, default 25 % = gain 0.25).
const chimeGain = () => Math.min(1, Math.max(0.1, (S?.settings?.chimeVol ?? 25) / 100));
const audioReady = () => !!actx && actx.state === 'running';
let chimeTestId = null;
function playChime(opts = {}) {
  const vol = opts.vol ? Math.min(1, Math.max(0.1, opts.vol / 100)) : chimeGain(); window.lastChime = { gain: vol, at: Date.now() };
  if (!opts.quiet) { navigator.vibrate?.([300, 100, 300]); const f = $('chimeFlash'); f.classList.remove('hidden'); void f.offsetWidth; clearTimeout(playChime.t); playChime.t = setTimeout(() => f.classList.add('hidden'), 900); }
  if (!actx) unlockAudio(); if (!actx) return; actx.resume?.(); const t = actx.currentTime;
  const master = actx.createGain(); master.gain.value = vol; master.connect(actx.destination);
  for (const [f, d] of [[659.25, 0], [783.99, 0.22], [987.77, 0.44]]) { // E5 G5 B5, gentle attack + long decay
    const o = actx.createOscillator(), g = actx.createGain(); o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.8, t + d + 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 1.4);
    o.connect(g).connect(master); o.start(t + d); o.stop(t + d + 1.5);
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
    const live = window.Rec?.backStream?.(); // recording holds the back camera: reuse its stream, don't stop it
    st = live ? null : await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 640 } }, audio: false });
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = live ? new MediaStream(live.getVideoTracks()) : st; await v.play();
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
  if (!$('agree').checked) return toast('Please confirm you are 18+ and agree to the Terms and Privacy Policy', 4000);
  localStorage.setItem('scramLegal', LEGAL_VERSION);
  const igRaw = $('ig').value.trim(), social = Socials.parse(igRaw, $('platform').value);
  if (igRaw && !social) return toast(Socials.hint(Socials.fromUrl(igRaw)?.platform || $('platform').value), 3500);
  if (social) { localStorage.setItem('scramIg', social.handle); localStorage.setItem('scramPlatform', social.platform); $('platform').value = social.platform; } else localStorage.removeItem('scramIg');
  const msg = type === 'create' ? { type, name, social, agreed: true, legal: LEGAL_VERSION, dev: DEV, ref: localStorage.getItem('scramRef') || '' } : { type, name, social, agreed: true, legal: LEGAL_VERSION, dev: DEV, ref: localStorage.getItem('scramRef') || '', code: $('code').value.trim().toUpperCase() };
  if (type === 'join' && msg.code.length < 4) return toast('Enter the join code');
  $('busyMsg').classList.add('hidden'); startGps(); wake(); unlockAudio();
  if (ws?.readyState === 1) sendMsg(msg); else pendingAction = msg;
}
// rules in an in-app iframe sheet: the lobby and its WebSocket stay put
for (const b of document.querySelectorAll('[data-rules]')) b.onclick = () => { if (!$('rulesFrame').src) $('rulesFrame').src = '/rules'; $('rulesSheet').classList.remove('hidden'); };
$('rulesClose').onclick = () => $('rulesSheet').classList.add('hidden');
addEventListener('message', e => { if (e.origin === location.origin && e.data === 'scram:closeRules') $('rulesSheet').classList.add('hidden'); });
$('btnCreate').onclick = () => go('create'); $('btnJoin').onclick = () => go('join');

// ---------- lobby ----------
const sec = { game: v => v / 60, ping: v => v, hide: v => v };
function renderLobby() {
  show('lobby');
  const url = location.origin + '/p/' + S.code;
  const hp = S.players.find(p => p.id === S.host); $('hostName').textContent = '👑 Host: ' + (hp ? hp.name : '?') + (S.host === S.you ? ' (you)' : '');
  $('lobbyCode').textContent = S.code; $('joinUrl').textContent = url;
  if ($('qr').dataset.c !== S.code) { $('qr').src = '/qr/' + S.code + '.svg'; $('qr').dataset.c = S.code; }
  const isHost = S.you === S.host;
  $('hostPanel').classList.toggle('hidden', !isHost); $('waitHost').classList.toggle('hidden', isHost);
  $('playerList').innerHTML = S.players.map(p => {
    const gps = p.perm === 'granted' ? (p.stale ? `<span class="pill bad">GPS stale</span>` : `<span class="pill ok">GPS ±${p.acc ?? '?'}m</span>`)
      : `<span class="pill bad">${p.perm === 'denied' ? 'GPS blocked' : 'no GPS yet'}</span>`;
    const hp = S.hostPick, picked = hp?.manual && hp.ids.includes(p.id); // host-only secret manual pick; players never get hostPick
    const role = isHost && hp?.manual ? `<button class="small pill pick${picked ? ' on' : ''}" data-pick="${p.id}" title="Only you can see this">${picked ? '🔒 picked' : '🔒 pick'}</button>` : '';
    const cam = S.settings.features?.cam ? (p.cam === 'granted' ? '<span class="pill ok">📷</span>' : p.cam === 'denied' ? '<span class="pill bad">no 📷</span>' : '') : '';
    const outP = S.field && p.out ? '<span class="pill out">outside field</span>' : '';
    return `<li><span class="nm">${esc(p.name)}${igLink(p.social)}${cam}${outP}${p.host ? ' 👑' : ''}${p.id === S.you ? ' (you)' : ''}${p.connected ? '' : ' 💤'}</span>${gps}${role}</li>`;
  }).join('');
  for (const b of document.querySelectorAll('[data-pick]')) b.onclick = () => { const on = S.hostPick?.ids.includes(b.dataset.pick);
    sendMsg({ type: 'role', id: b.dataset.pick, role: on ? 'hider' : 'hunter' }); };
  $('roleCounts').textContent = `Players ${S.players.length}/${S.maxPlayers || 20} · roles are revealed when the game starts`;
  if (isHost && S.hostPick) { const hp = S.hostPick; $('sHunters').max = Math.max(1, S.players.length - 1); if (document.activeElement !== $('sHunters')) $('sHunters').value = hp.hunters;
    $('sManual').checked = hp.manual; $('sHunters').disabled = hp.manual;
    $('pickNote').textContent = hp.manual ? `🔒 Manual pick (secret — only you see this): ${hp.ids.length} hunter${hp.ids.length === 1 ? '' : 's'} picked. Everyone else hides.` : `🎲 Roles are dealt randomly at start: ${Math.min(hp.hunters, Math.max(1, S.players.length - 1))} hunter(s), nobody sees roles until the reveal.`; }
  const st = S.settings; const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  set('sGame', +(st.gameSec / 60).toFixed(2)); set('sPing', st.pingSec); set('sHide', st.hideSec);
  set('sPower', st.powerups || 'normal'); set('sChimeVol', st.chimeVol ?? 25); $('chimeVolLbl').textContent = (st.chimeVol ?? 25) + '%';
  $('sPower').disabled = $('sChimeVol').disabled = S.you !== S.host;
  $('sBecome').checked = st.caughtBecomeHunter; $('sReveal').checked = st.showRevealed; $('sMates').checked = st.teammates !== false;
  for (const [f, id] of FEAT) $(id).checked = !!st.features?.[f];
  const m = me();
  $('camPanel').classList.toggle('hidden', !st.features?.cam); // anyone may be dealt hider, so everyone sees the notice
  if (m && camConsent && m.cam !== camConsent) sendMsg({ type: 'cam', cam: camConsent });
  renderModes(); renderField(); renderChimeVote();
  $('camStatus').textContent = m?.cam === 'granted' ? '✅ Ready · camera allowed' : m?.cam === 'denied' ? '✅ Ready · no camera (hunters see “photo unavailable”)' : 'Not ready yet';
}
const FEAT = [['decoy', 'fDecoy'], ['chime', 'fChime'], ['bounty', 'fBounty'], ['cam', 'fCam'], ['compass', 'fCompass']];
function pushSettings(e) { const custom = S.settings.mode === 'custom' || ['sPower', ...FEAT.map(x => x[1])].includes(e?.target?.id); // toggles only travel in Custom (a preset owns them otherwise)
  sendMsg({ type: 'settings', settings: { gameSec: $('sGame').value * 60, pingSec: +$('sPing').value, hideSec: +$('sHide').value, caughtBecomeHunter: $('sBecome').checked, showRevealed: $('sReveal').checked, teammates: $('sMates').checked, chimeVol: +$('sChimeVol').value,
  ...(custom ? { mode: 'custom', powerups: $('sPower').value, features: Object.fromEntries(FEAT.map(([f, id]) => [f, $(id).checked])) } : {}) } }); }
// ---------- game modes (presets; Custom reveals the individual toggles) ----------
const MODES = { classic: { label: 'Classic', desc: 'Pure hide & seek: pings, the field, the chime and catch confirmation. No extras.' }, party: { label: 'Party', desc: 'Classic plus decoys, bounties, power-ups (every 3 min) and the sudden-death compass.' },
  chaos: { label: 'Chaos', desc: 'Everything on: cam peek too, and power-ups drop every 90 s.' }, custom: { label: 'Custom', desc: 'Pick every toggle yourself.' } };
fetch('/api/rules').then(r => r.json()).then(r => { window.RULES = r; for (const k in r.modes || {}) MODES[k] = { ...MODES[k], ...r.modes[k] }; if (S?.state === 'lobby') renderModes(); }).catch(() => {});
function renderModes() {
  const mode = S.settings.mode || 'custom', M = MODES[mode] || MODES.custom;
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
  $('modeDesc').textContent = M.desc; $('customBox').classList.toggle('hidden', mode !== 'custom'); $('featBox').classList.toggle('hidden', mode !== 'custom');
  const host = S.you === S.host; $('modeBox').classList.toggle('hidden', !host); $('modeLine').classList.toggle('hidden', host);
  $('modeLine').innerHTML = `🎮 <b>${esc(M.label)}</b> <span class="note">${esc(M.desc)}</span>`;
}
for (const b of document.querySelectorAll('[data-mode]')) b.onclick = () => sendMsg({ type: 'settings', settings: { mode: b.dataset.mode } });
$('sChimeVol').oninput = () => $('chimeVolLbl').textContent = $('sChimeVol').value + '%';
for (const id of ['sGame', 'sPing', 'sHide', 'sBecome', 'sReveal', 'sMates', 'sPower', 'sChimeVol', ...FEAT.map(x => x[1])]) $(id).onchange = pushSettings;
$('btnQuick').onclick = () => { $('sGame').value = 2; $('sPing').value = 10; $('sHide').value = 10; pushSettings(); toast('2-min test game: pings 10 s, bounty every 30 s, cam at 1:00, compass from 1:48'); };
$('btnReadyCam').onclick = askCam;
// host chime preview on every phone (lobby only): on slider release, or at most every 1.5 s while dragging
let chimeDragAt = 0;
function chimeAll() { sendMsg({ type: 'chimeTest', vol: +$('sChimeVol').value }); chimeDragAt = Date.now(); }
$('sChimeVol').addEventListener('input', () => { if (Date.now() - chimeDragAt >= 1500) chimeAll(); });
$('sChimeVol').addEventListener('change', () => { setTimeout(chimeAll, Math.max(0, 1500 - (Date.now() - chimeDragAt))); });
$('btnChimeAll').onclick = () => { unlockAudio(); chimeAll(); };
$('btnUnlockSound').onclick = () => { unlockAudio(); $('soundUnlock').classList.add('hidden'); setTimeout(() => playChime({ vol: window.lastChimeTest?.vol }), 80); };
for (const b of document.querySelectorAll('[data-vote]')) b.onclick = () => { unlockAudio(); sendMsg({ type: 'chimeVote', id: chimeTestId, vote: b.dataset.vote }); };
function renderChimeVote(m) {
  const ct = S?.chimeTest || m; const on = S && S.state === 'lobby' && ct;
  $('chimeVoteBox').classList.toggle('hidden', !on); if (!on) return;
  $('chimeVoteVol').textContent = `at ${ct.vol}%`; for (const b of document.querySelectorAll('[data-vote]')) b.classList.toggle('on', S.chimeTest?.myVote === b.dataset.vote);
  const t = S.chimeTest?.tally; $('chimeTally').textContent = t ? `👍 ${t.good} · 🔉 ${t.quiet} · 🔊 ${t.loud} (${t.good + t.quiet + t.loud}/${S.chimeTest.n})` : '';
}
$('btnSound').onclick = () => { unlockAudio(); playChime(); $('soundAsk').classList.remove('hidden'); $('soundTips').classList.add('hidden'); };
$('soundYes').onclick = () => { $('soundAsk').classList.add('hidden'); toast('👍 Sound works — keep the volume up during the game'); };
$('soundNo').onclick = () => { $('soundAsk').classList.add('hidden'); $('soundTips').classList.remove('hidden'); };
$('btnReadyNoCam').onclick = () => { unlockAudio(); camConsent = 'denied'; localStorage.setItem('scramCam', 'denied'); sendMsg({ type: 'cam', cam: 'denied' }); };
$('sHunters').onchange = () => S?.hostPick?.manual || sendMsg({ type: 'pick', manual: false, hunters: +$('sHunters').value || 1 });
$('sManual').onchange = () => sendMsg({ type: 'pick', manual: $('sManual').checked, hunters: +$('sHunters').value || 1 });
$('btnStart').onclick = () => { const bad = S.players.filter(p => p.perm !== 'granted'); if (bad.length && !confirm(`${bad.map(p => p.name).join(', ')} ${bad.length > 1 ? "don't" : "doesn't"} have GPS yet. Start anyway?`)) return; sendMsg({ type: 'start' }); };
$('btnShare').onclick = async () => { const url = location.origin + '/p/' + S.code; try { if (navigator.share) await navigator.share({ title: 'Join my Last Ping game', text: `Join my GPS hide & seek game: code ${S.code}`, url }); else { await navigator.clipboard.writeText(url); toast('🔗 Invite link copied'); } } catch {} };
$('lobbyCode').onclick = async () => { try { await navigator.clipboard.writeText(S.code); toast(`📋 Code ${S.code} copied`); } catch { toast(`Join code: ${S.code}`); } };

// ---------- playing field ----------
let fieldMap = null, fieldGroup = null, drawGroup = null, myDot = null, centerPin = null, drawing = null, fieldKey = '', gameField = null, endField = null, lastVib = 0;
const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
// Dark basemap. CARTO's dark tiles now return an "API KEY REQUIRED" placeholder without a key, so the default is OSM tiles
// with a CSS dark filter (attribution kept). Set DARK_TILES_URL (+ DARK_TILES_ATTR) on the server, e.g. CARTO dark_nolabels with
// your API key, to use real dark raster tiles; if those fail to load we fall back to the filtered OSM tiles.
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
function baseLayer(m) {
  const osm = () => { L.tileLayer(TILES, { maxZoom: 19, attribution: OSM_ATTR, className: 'osmDark' }).addTo(m); m._tiles = 'osm'; };
  const dark = window.RULES?.tiles; if (!dark?.url) return osm();
  const t = L.tileLayer(dark.url, { maxZoom: 19, subdomains: 'abcd', attribution: dark.attr || OSM_ATTR }); let errs = 0, ok = false;
  t.on('tileload', () => { ok = true; }); t.on('tileerror', () => { if (!ok && ++errs >= 3 && m.hasLayer(t)) { m.removeLayer(t); osm(); } });
  t.addTo(m); m._tiles = 'dark'; return t;
}
const miles = r => { const m = r / Field.MILE; return (Math.abs(m - Math.round(m * 4) / 4) < 0.01 ? +(Math.round(m * 4) / 4) : +m.toFixed(2)) + ' mi'; };
function circlePts(c, n = 72) { const out = []; for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI;
  out.push([c.lat + c.r / 111320 * Math.cos(a), c.lng + c.r / (111320 * Math.cos(c.lat * Math.PI / 180)) * Math.sin(a)]); } return out; }
function fieldBounds(f) { const b = Field.bbox(f); return L.latLngBounds([b.s, b.w], [b.n, b.e]); }
// Outline in yellow + darken everything outside (one shaded "world with a hole" per shape; with both, outside either is dark).
function drawFieldLayers(group, f) {
  group.clearLayers(); if (!f) return;
  const world = [[-85, -179.9], [-85, 179.9], [85, 179.9], [85, -179.9]], holes = [];
  if (f.circle) { holes.push(circlePts(f.circle)); L.circle([f.circle.lat, f.circle.lng], { radius: f.circle.r, color: '#facc15', weight: 3, fill: false, interactive: false }).addTo(group); }
  if (f.poly) { holes.push(f.poly); L.polygon(f.poly, { color: '#facc15', weight: 3, fill: false, dashArray: f.circle ? '8 6' : null, interactive: false }).addTo(group); }
  for (const h of holes) L.polygon([world, h], { stroke: false, fillColor: '#000', fillOpacity: .35, interactive: false }).addTo(group);
}
const fieldText = f => !f ? 'No boundary — play anywhere.' : [f.circle && `⭕ ${miles(f.circle.r)} circle`, f.poly && `✏️ drawn shape (${f.poly.length} pts)`].filter(Boolean).join(' ∩ ') + (f.circle && f.poly ? ' — field is the area inside both' : '');
function setField(f) { if (f && !f.circle && !f.poly) f = null; sendMsg({ type: 'field', field: f }); }
const curField = () => S.field || { circle: null, poly: null };
function ensureFieldMap() {
  if (fieldMap) return;
  const c = S.field ? fieldBounds(S.field).getCenter() : myLoc ? L.latLng(myLoc.lat, myLoc.lng) : L.latLng(51.5, 0);
  fieldMap = window.fieldMap = L.map('fieldMap', { doubleClickZoom: false, tap: true }).setView(c, 15);
  baseLayer(fieldMap);
  fieldGroup = L.layerGroup().addTo(fieldMap); drawGroup = L.layerGroup().addTo(fieldMap);
  fieldMap.on('click', e => { if (!drawing) return; if (drawing.length >= Field.MAX_POINTS) return toast(`Max ${Field.MAX_POINTS} points`); drawing.push([e.latlng.lat, e.latlng.lng]); renderDraw(); });
  fieldKey = '';
}
function renderDraw() {
  drawGroup.clearLayers(); document.body.classList.toggle('drawing', !!drawing);
  $('drawBar').classList.toggle('hidden', !drawing); $('btnDraw').classList.toggle('hidden', !!drawing);
  if (!drawing) return;
  if (drawing.length > 1) (drawing.length > 2 ? L.polygon : L.polyline)(drawing, { color: '#facc15', weight: 3, dashArray: '6', fillOpacity: .15, interactive: false }).addTo(drawGroup);
  drawing.forEach(p => L.circleMarker(p, { radius: 7, color: '#000', weight: 2, fillColor: '#facc15', fillOpacity: 1, interactive: false }).addTo(drawGroup));
  $('drawCount').textContent = `${drawing.length} pt${drawing.length === 1 ? '' : 's'} — tap the map to add`;
  $('btnFinishDraw').disabled = drawing.length < 3;
}
function renderField() {
  const f = S.field, isHost = S.you === S.host;
  $('fieldPanel').classList.toggle('hidden', !isHost && !f); $('fieldHost').classList.toggle('hidden', !isHost);
  $('fieldSummary').textContent = fieldText(f) + (me()?.out ? ' ⚠️ You are outside the field.' : '');
  if (!isHost && !f) return;
  ensureFieldMap(); setTimeout(() => fieldMap && fieldMap.invalidateSize(), 60);
  const key = JSON.stringify(f || null);
  if (key !== fieldKey) { fieldKey = key; drawFieldLayers(fieldGroup, f); if (f && !drawing) setTimeout(() => fieldMap && fieldMap.fitBounds(fieldBounds(f).pad(.1), { maxZoom: 17 }), 80); }
  if (myLoc) { if (!myDot) myDot = L.circleMarker([myLoc.lat, myLoc.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#22c55e', fillOpacity: 1, interactive: false }).addTo(fieldMap); else myDot.setLatLng([myLoc.lat, myLoc.lng]); }
  if (isHost && f?.circle) {
    if (!centerPin) { centerPin = L.marker([f.circle.lat, f.circle.lng], { draggable: true, autoPan: true, icon: L.divIcon({ className: 'bountyIcon', html: '📍', iconSize: [36, 36], iconAnchor: [18, 34] }) }).addTo(fieldMap);
      centerPin.on('dragend', () => { const ll = centerPin.getLatLng(); setField({ ...curField(), circle: { ...S.field.circle, lat: ll.lat, lng: ll.lng } }); }); }
    else centerPin.setLatLng([f.circle.lat, f.circle.lng]);
  } else if (centerPin) { centerPin.remove(); centerPin = null; }
  for (const b of document.querySelectorAll('#fieldRadius button')) b.classList.toggle('on', +b.dataset.r === 0 ? !f : +b.dataset.r === f?.circle?.r);
  $('btnRemoveShape').classList.toggle('hidden', !f?.poly || !!drawing); $('btnDraw').textContent = f?.poly ? '✏️ Redraw shape' : '✏️ Draw shape';
  renderDraw();
}
for (const b of document.querySelectorAll('#fieldRadius button')) b.onclick = () => {
  const r = +b.dataset.r; if (!r) { drawing = null; return setField(null); }
  const old = S.field?.circle, c = old || (myLoc ? { lat: myLoc.lat, lng: myLoc.lng } : (() => { const m = fieldMap.getCenter(); toast('No GPS yet — circle centered on the map'); return { lat: m.lat, lng: m.lng }; })());
  setField({ ...curField(), circle: { lat: c.lat, lng: c.lng, r } });
};
$('btnCenterMe').onclick = () => { if (!myLoc) return toast('No GPS fix yet'); fieldMap.setView([myLoc.lat, myLoc.lng]); if (S.field?.circle) setField({ ...curField(), circle: { ...S.field.circle, lat: myLoc.lat, lng: myLoc.lng } }); else toast('Pick a radius to place a circle here'); };
$('btnDraw').onclick = () => { drawing = []; renderField(); toast('Tap the map to add corners, then Finish'); };
$('btnUndoPt').onclick = () => { drawing.pop(); renderDraw(); };
$('btnClearPts').onclick = () => { drawing = []; renderDraw(); };
$('btnFinishDraw').onclick = () => { if (drawing.length < 3) return toast('Need at least 3 points'); const poly = drawing; drawing = null; setField({ ...curField(), poly }); renderField(); };
$('btnRemoveShape').onclick = () => setField({ ...curField(), poly: null });

// ---------- game ----------
function ensureMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false }).setView([myLoc?.lat || 51.5, myLoc?.lng || 0], 16);
  baseLayer(map);
  map._fitted = false; gameField = L.layerGroup().addTo(map); gameField.key = '';
}
// ---- smooth markers: SVG badges, positions glide over ~600 ms (instant with prefers-reduced-motion or a hidden page) ----
const RM = matchMedia('(prefers-reduced-motion: reduce)');
function glide(layer, to) {
  const from = layer.getLatLng(); cancelAnimationFrame(layer._raf);
  if (RM.matches || document.hidden || !from || (Math.abs(from.lat - to[0]) < 1e-7 && Math.abs(from.lng - to[1]) < 1e-7) || L.latLng(from).distanceTo(to) > 2000) return layer.setLatLng(to);
  const t0 = performance.now(), step = now => { const k = Math.min(1, (now - t0) / 600), e = 1 - (1 - k) ** 3;
    layer.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]); if (k < 1) layer._raf = requestAnimationFrame(step); };
  layer._raf = requestAnimationFrame(step);
}
const mkIcon = (kind, glyph) => L.divIcon({ className: 'mkWrap', html: Icons.badge(glyph || kind, Icons.COL[kind] || kind, { size: kind === 'you' ? 28 : 34, pulse: kind === 'you', cls: kind }), iconSize: [34, 34], iconAnchor: [17, 17] });
function marker(key, loc, kind, label, opts = {}) {
  let l = layers[key]; const ll = [loc.lat, loc.lng], col = Icons.COL[kind] || kind, sig = kind + (opts.glyph || '');
  if (!l) { l = layers[key] = { c: L.circle(ll, { radius: loc.acc || 5, color: col, weight: 1, fillOpacity: .12, interactive: false }).addTo(map), m: L.marker(ll, { icon: mkIcon(kind, opts.glyph), keyboard: false }).addTo(map), sig };
    l.m.bindTooltip('', { permanent: true, direction: 'top', offset: [0, -16], className: 'tt tt-' + kind }); }
  else if (l.sig !== sig) { l.m.setIcon(mkIcon(kind, opts.glyph)); l.c.setStyle({ color: col }); l.sig = sig; }
  glide(l.m, ll); glide(l.c, ll); l.c.setRadius(loc.acc || 5);
  l.m.setTooltipContent(label); l.seen = true;
}
function renderGame() {
  if (S.round !== lastRound && map) { for (const k in layers) { map.removeLayer(layers[k].c); map.removeLayer(layers[k].m); } layers = {}; map._fitted = false; }
  lastRound = S.round;
  show('game'); ensureMap(); setTimeout(() => map.invalidateSize(), 50);
  const m = me(), hunter = m.role === 'hunter';
  if (S.revealAt && tnow() < S.revealAt) { $('roleBadge').textContent = '⏳'; $('roleBadge').style.background = '#374151'; } else
  $('roleBadge').textContent = hunter ? '🔦 HUNTER' : (m.caught ? '😵 CAUGHT' : '🙈 HIDER'); $('roleBadge').style.background = hunter ? '#dc2626' : (m.caught ? '#4b5563' : '#0891b2');
  $('hideCover').classList.toggle('hidden', !(hunter && S.state === 'hiding'));
  $('hunterPanel').classList.toggle('hidden', !hunter); $('hiderPanel').classList.toggle('hidden', hunter || m.caught);
  $('btnEnd').classList.toggle('hidden', S.you !== S.host);
  $('abCatch').classList.toggle('hidden', !hunter); $('btnCaughtSelf').classList.toggle('hidden', hunter || m.caught);
  if (!$('abCatch').dataset.i) { $('abCatch').dataset.i = 1; $('abCatch').querySelector('.ico').innerHTML = Icons.svg('hunter', 30); $('btnDecoy').querySelector('.ico').innerHTML = Icons.svg('decoy', 30); }
  if (!hunter) $('catchSheet').classList.add('hidden');
  placeRecBtn(); roleCardCheck(m); coachState(m);
  { const key = JSON.stringify(S.field || null); if (gameField.key !== key) { gameField.key = key; drawFieldLayers(gameField, S.field); } }
  for (const k in layers) layers[k].seen = false;
  const pts = [];
  // me
  if (m.loc) { marker('me', m.loc, 'you', 'You'); pts.push([m.loc.lat, m.loc.lng]); }
  // other hunters live (server only sends these to hunters)
  S.players.filter(p => p.id !== S.you && p.role === 'hunter' && p.loc).forEach(p => { marker('h' + p.id, p.loc, 'hunter', esc(p.name)); pts.push([p.loc.lat, p.loc.lng]); });
  // fellow hiders live (server only sends these to uncaught hiders when 'Teammates visible' is on)
  if (m.role === 'hider' && !m.caught) S.players.filter(p => p.id !== S.you && p.role === 'hider' && !p.caught && p.loc).forEach(p => { marker('t' + p.id, p.loc, 'mate', esc(p.name)); pts.push([p.loc.lat, p.loc.lng]); });
  // hiders: last ping only
  const last = S.last || {};
  const hiders = S.players.filter(p => p.role === 'hider' || p.caught);
  if (hunter) hiders.forEach((p, i) => {
    const lp = last[p.id];
    if (lp && !p.caught) { marker('x' + p.id, lp, 'hider', `${esc(p.name)} · ${ago(lp.t - lp.age - offset)}${p.id === nearestId ? ' · nearest' : ''}`); pts.push([lp.lat, lp.lng]); }
  });
  if (S.bounty) {
    const b = S.bounty;
    if (!layers.bounty || layers.bounty.id !== b.id) {
      if (layers.bounty) { map.removeLayer(layers.bounty.c); map.removeLayer(layers.bounty.m); }
      layers.bounty = { id: b.id, c: L.circle([b.lat, b.lng], { radius: 15, color: '#facc15', weight: 2, fillOpacity: .25, dashArray: '5' }).addTo(map),
        m: L.marker([b.lat, b.lng], { icon: L.divIcon({ className: 'mkWrap', html: Icons.badge('bounty', Icons.COL.drop, { size: 36, cls: 'drop' }), iconSize: [36, 36], iconAnchor: [18, 18] }) }).bindTooltip('Bounty · get within 15 m', { permanent: true, direction: 'top', offset: [0, -16] }).addTo(map) };
      coach('bounty');
      if (!map.getBounds().contains([b.lat, b.lng])) map.fitBounds(L.latLngBounds([...pts, [b.lat, b.lng]]).pad(.2), { maxZoom: 17 });
    }
    layers.bounty.seen = true;
  }
  if (!hunter && !S.outSince && m.loc && !map.getBounds().pad(-0.1).contains([m.loc.lat, m.loc.lng])) map.panTo([m.loc.lat, m.loc.lng]);
  for (const k in layers) if (!layers[k].seen) { map.removeLayer(layers[k].c); map.removeLayer(layers[k].m); delete layers[k]; }
  if (S.outSince && S.field && m.loc && map._oobFit !== S.outSince) { map._oobFit = S.outSince; const fb = fieldBounds(S.field).extend([m.loc.lat, m.loc.lng]).pad(.25); setTimeout(() => { if (map) { map.invalidateSize(); map.fitBounds(fb); } }, 120); map._fitted = true; }
  if (S.field && !map._fitted) { const fb = fieldBounds(S.field); pts.forEach(p => fb.extend(p)); setTimeout(() => { if (map) { map.invalidateSize(); map.fitBounds(fb.pad(.05)); } }, 120); map._fitted = true; }
  if (pts.length && (!map._fitted || (S.pingCount !== lastPingN && hunter))) { map.fitBounds(L.latLngBounds(pts).pad(.3), { maxZoom: 17 }); map._fitted = true; lastPingN = S.pingCount; }
  if (hunter) {
    const pend = id => (S.catches || []).some(c => c.hiderId === id);
    $('hiderBtns').innerHTML = hiders.map(p => `<button ${p.caught ? 'disabled' : ''} class="${p.caught ? '' : 'hunt'}" data-catch="${p.id}"><span>${p.caught ? '✅' : p.id === nearestId ? '🎯' : '🙈'} ${esc(p.name)}</span><span>${p.caught ? 'caught' : pend(p.id) ? '⏳ confirming…' : 'I caught them'}</span></button>`).join('') || '<p class="note">No hiders left</p>';
    for (const b of document.querySelectorAll('[data-catch]')) b.onclick = () => { const p = S.players.find(x => x.id === b.dataset.catch); if (confirm(`Mark ${p.name} as caught?`)) { maybeSend(true); sendMsg({ type: 'catch', id: p.id }); $('catchSheet').classList.add('hidden'); if (S.you !== S.host) toast(`⏳ Waiting for ${p.name} to confirm (20 s)…`); } };
    $('btnDecoy').classList.add('hidden');
  } else {
    const dOn = S.settings.features?.decoy && !S.compass;
    $('btnDecoy').classList.toggle('hidden', !S.settings.features?.decoy || m.caught);
    $('decoyBadge').textContent = S.decoyArmed ? '!' : (S.decoys ?? 0); $('btnDecoy').querySelector('.lbl').textContent = S.decoyArmed ? 'Armed' : 'Decoy';
    $('btnDecoy').disabled = !dOn || S.decoyArmed || !S.decoys;
    $('btnDecoy').classList.toggle('armed', !!S.decoyArmed);
    $('decoyCount').textContent = S.decoyArmed ? '· ARMED for next ping' : `· ${S.decoys ?? 0}/2 charges`;
    if (S.cloaked) fx('💰 Cloaked: your next ping is wiped.'); else if (S.decoyArmed) fx('👻 Decoy armed: next ping shows a fake spot 30-150 m away.');
    $('revealed').textContent = S.revealedAt ? `Hunters last saw your location ${ago(S.revealedAt - offset)}.` : (S.settings.showRevealed ? 'Not revealed yet.' : '');
  }
  if (hunter) renderPhotos();
  renderCatchBox(); renderDrops(); renderPower(); renderHound();
  document.body.classList.toggle('jammed', hunter && S.jamUntil > tnow() && S.state === 'playing');
  renderCompass();
  const ev = S.events[S.events.length - 1];
  $('banner').classList.toggle('hidden', !ev || tnow() - ev.t > 6000); if (ev) $('banner').textContent = ev.text;
}
$('btnPower').onclick = () => sendMsg({ type: 'usePower' });
$('btnCaughtSelf').onclick = () => { if (confirm('Confirm you were caught?')) { maybeSend(true); sendMsg({ type: 'caughtSelf' }); toast('⏳ Waiting for a hunter to confirm (20 s)…', 4000); } };
// pending catch claims: the other side (or the host) confirms within 20 s
function renderCatchBox() {
  const list = (S && (S.state === 'playing' || S.state === 'hiding') ? S.catches || [] : []), mine = list.filter(c => c.canAnswer || c.hiderId === S.you);
  $('catchBox').classList.toggle('hidden', !mine.length); if (!mine.length) return;
  $('catchBox').innerHTML = mine.map(c => { const left = Math.max(0, Math.ceil((c.expiresAt - tnow()) / 1000)), host = S.you === S.host;
    const party = c.by === 'hider' ? c.hiderId !== S.you : c.hiderId === S.you;
    const txt = c.by === 'hider' ? `🙋 ${esc(c.hider)} says they were caught${c.hunter ? ' by ' + esc(c.hunter) : ''}` : `🎯 ${esc(c.hunter)} says they caught ${c.hiderId === S.you ? 'you' : esc(c.hider)}`;
    const btns = c.canAnswer && (party || host) && !(c.by === 'hider' && c.hiderId === S.you) ? `<button class="small primary" data-cy="${c.pid}">${party ? '✅ Confirm' : '👑 Confirm'}</button><button class="small danger" data-cn="${c.pid}">${party ? '✕ No' : '👑 Cancel'}</button>` : '<span class="note">waiting…</span>';
    return `<div class="row"><span>${txt} · ${left}s</span>${btns}</div>`; }).join('');
  for (const b of document.querySelectorAll('[data-cy]')) b.onclick = () => sendMsg({ type: 'catchAnswer', pid: b.dataset.cy, yes: true });
  for (const b of document.querySelectorAll('[data-cn]')) b.onclick = () => sendMsg({ type: 'catchAnswer', pid: b.dataset.cn, yes: false });
}
$('btnEnd').onclick = () => { if (confirm('End the game for everyone?')) { $('moreSheet').classList.add('hidden'); sendMsg({ type: 'end' }); } };

function warnings() {
  if (!S || S.state === 'lobby' || S.state === 'ended') return;
  const m = me(), w = [];
  if (!myLoc) w.push('No GPS fix yet — your location is not being shared.');
  else if (Date.now() - myLoc.ts > 45000) w.push(`Your GPS is stale (${ago(myLoc.ts)}). Keep the screen on and this tab open.`);
  else if (myLoc.acc > 100) w.push(`GPS accuracy is poor (±${Math.round(myLoc.acc)} m).`);
  if (m.role === 'hunter') S.players.filter(p => p.role === 'hider' && !p.caught && p.stale).forEach(p => w.push(`${p.name}'s GPS is stale/offline — their next ping may be old.`));
  if (ws?.readyState !== 1) w.push('Disconnected — reconnecting…');
  if (!('wakeLock' in navigator)) w.push('🔆 Screen wake lock not supported here — keep the screen on manually.');
  $('warn').innerHTML = w.map(esc).join('<br>'); $('warn').classList.toggle('hidden', !w.length);
}
setInterval(() => {
  if (!S) return;
  const t = tnow();
  if (S.state === 'hiding') { $('clock').textContent = fmt(S.hideEndsAt - t); $('pingClock').innerHTML = 'Head<br>start'; $('hideClock').textContent = fmt(S.hideEndsAt - t); }
  else if (S.state === 'playing') { $('clock').textContent = fmt(S.endsAt - t); $('pingClock').innerHTML = S.compass ? '🧭 <b>SUDDEN<br>DEATH</b>' : `Next ping<br><b>${fmt(S.nextPingAt - t)}</b>`; }
  if (S.state === 'playing' || S.state === 'hiding') { // circular countdown ring around the ping timer
    const tot = S.state === 'hiding' ? S.settings.hideSec * 1000 : S.settings.pingSec * 1000, left = S.state === 'hiding' ? S.hideEndsAt - t : S.nextPingAt - t;
    $('pingArc').style.strokeDashoffset = (S.compass ? 0 : 131.95 * (1 - Math.max(0, Math.min(1, left / Math.max(1, tot))))).toFixed(1); $('pingWrap').classList.toggle('soon', !S.compass && left < 5000 && S.state === 'playing');
  }
  tickRoleCard();
  warnings(); oobBanner(); if (S.catches?.length) renderCatchBox();
  if (S.state === 'playing' && map) { renderDrops(); renderPower(); renderHound(); document.body.classList.toggle('jammed', me()?.role === 'hunter' && S.jamUntil > tnow()); } else document.body.classList.remove('jammed');
}, 250);
function oobBanner() {
  const running = S.state === 'playing' || S.state === 'hiding', m = me(), on = running && !!S.outSince && m;
  $('oob').classList.toggle('hidden', !on); if (!on) return;
  const left = S.outSince + S.oobGraceMs - tnow();
  $('oob').textContent = m.role === 'hunter' ? '🚨 OUT OF BOUNDS — get back inside the field!'
    : S.state === 'hiding' ? '🚨 OUT OF BOUNDS — get back inside before the hunt starts!'
    : left > 0 ? `🚨 OUT OF BOUNDS — get back inside! Revealed to hunters in ${Math.ceil(left / 1000)} s` : '🚨 OUT OF BOUNDS — you will be revealed at the next ping!';
  if (Date.now() - lastVib > 10000) { navigator.vibrate?.([400, 200, 400]); lastVib = Date.now(); }
}

// ---------- end ----------
function renderEnd() {
  show('end'); renderPlanBox();
  if (S.field && S.you === S.host && areaRound !== S.round && window.Plan) { areaRound = S.round; Plan.rememberArea(S.field); } // past play areas for the next poll
  $('winner').textContent = S.winner === 'hiders' ? '🙈 Hiders win!' : '🔦 Hunters win!';
  const hiders = S.players.filter(p => p.caught || p.role === 'hider');
  $('summary').innerHTML = hiders.map((p, i) => { const n = S.pings.filter(pg => pg.locs[p.id]).length;
    return `<div class="sumrow"><b style="color:${COLORS[i % COLORS.length]}">● ${esc(p.name)}</b>${igLink(p.social)} — ${p.caught ? 'caught at ' + fmt(p.caughtAt - S.startedAt) : 'survived'} · ${n} ping${n === 1 ? '' : 's'}</div>`; }).join('') +
    `<p class="note">${S.pingCount} pings · ${S.events.map(e => esc(e.text)).join(' · ')}</p>`;
  if (!endMap) { endMap = L.map('endMap'); baseLayer(endMap); }
  if (endLayer) endLayer.remove(); endLayer = L.layerGroup().addTo(endMap); drawFieldLayers(L.layerGroup().addTo(endLayer), S.field);
  const all = [];
  hiders.forEach((p, i) => {
    const trail = S.pings.map(pg => pg.locs[p.id]).filter(Boolean).map(l => [l.lat, l.lng]);
    if (!trail.length) return; all.push(...trail);
    const c = COLORS[i % COLORS.length];
    L.polyline(trail, { color: c, weight: 4 }).addTo(endLayer);
    trail.forEach((ll, k) => L.circleMarker(ll, { radius: 5, color: c, fillOpacity: 1 }).bindTooltip(`${esc(p.name)} #${k + 1}`).addTo(endLayer));
  });
  setTimeout(() => { endMap.invalidateSize(); if (all.length) endMap.fitBounds(L.latLngBounds(all).pad(.2)); else endMap.setView([myLoc?.lat || 0, myLoc?.lng || 0], 15); }, 50);
  $('btnFollow').href = Socials.url(CREATOR); $('btnFollow').dataset.platform = CREATOR.platform; $('followIcon').innerHTML = Socials.icon(CREATOR.platform, 22);
  $('followText').textContent = `Follow @${CREATOR.handle} on ${Socials.label(CREATOR.platform)}`;
  if (window.RecapUI?.data?.round === S.round) RecapUI.render(); else sendMsg({ type: 'recap' });
}
$('btnHome').onclick = () => { window.RecapUI?.clear(); window.Reel?.clear(); window.Rec?.releaseSaved?.(); viewingEnd = false; dismissedRound = S ? S.round : -1; sendMsg({ type: 'rematch' }); if (S && S.state === 'lobby') render(); };
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
  } else { viewingEnd = false; $('rematchNote').classList.add('hidden'); if (S.state === 'lobby') renderLobby(); else if (document.hidden && map) { /* paused while hidden: re-rendered on visibilitychange */ } else renderGame(); }
  wake();
}
connect();

// ---------- v9: sheets, record slot, role card, ping moment, coach tips ----------
$('abCatch').onclick = () => { $('moreSheet').classList.add('hidden'); $('catchSheet').classList.remove('hidden'); };
$('catchClose').onclick = () => $('catchSheet').classList.add('hidden');
$('abMore').onclick = () => { $('catchSheet').classList.add('hidden'); $('moreSheet').classList.remove('hidden'); };
$('moreClose').onclick = () => $('moreSheet').classList.add('hidden');
for (const b of document.querySelectorAll('#moreSheet [data-rules]')) b.addEventListener('click', () => $('moreSheet').classList.add('hidden'));
$('btnSoundGame').onclick = () => { unlockAudio(); playChime(); toast('🔔 Did you hear it? If not: turn off silent mode and raise the media volume.', 4000); };
const resetTips = () => { localStorage.removeItem('scramTips'); tipSeen = {}; toast('💡 Tips reset: they show again as things happen'); };
$('btnRecQ').onclick = () => { $('moreSheet').classList.add('hidden'); $('recQBtn').click(); };
$('btnResetTips').onclick = resetTips; $('btnResetTips2').onclick = resetTips;
function placeRecBtn() { // in game the Record button lives in the bottom action bar; elsewhere in the floating dock
  const inGame = S && (S.state === 'playing' || S.state === 'hiding') && !$('game').classList.contains('hidden'), b = $('recBtn'), want = inGame ? $('abRecSlot') : $('recDock');
  if (b && b.parentElement !== want) { if (inGame) want.appendChild(b); else $('recDock').insertBefore(b, $('clipsBtn')); b.classList.toggle('ab', inGame); b.innerHTML = inGame ? '<span class="ico recIco"></span><small class="lbl">Record</small>' : '⏺ Record'; }
}
// role card at round start (and on infection)
let rcRound = -1, rcMode = null;
function modeBullets(st) {
  const f = st.features || {}, ex = [f.decoy && '👻 decoys', f.bounty && '💰 bounties', st.powerups !== 'off' && `🎁 power-ups${st.powerups === 'chaos' ? ' (chaos)' : ''}`, f.compass && '🧭 sudden-death compass', f.cam && '📷 cam peek'].filter(Boolean);
  return [`📡 Ping every ${st.pingSec >= 60 ? (st.pingSec / 60) + ' min' : st.pingSec + ' s'} · ${Math.round(st.gameSec / 60)} min game`,
    ex.length ? `${(MODES[st.mode] || MODES.custom).label}: ${ex.join(', ')}` : `${(MODES[st.mode] || MODES.custom).label}: no extras, ${f.chime ? '🔔 chime within 40 m' : 'pure hide & seek'}`,
    S.field ? '🟨 Stay inside the yellow boundary (30 s grace)' : '🙌 Tag in real life, then confirm in the app'];
}
const QUIET = localStorage.getItem('scramQuiet') === '1'; // test hook (legacy e2e suites): skip role card + coach tips
function showRoleCard(kind) {
  const m = me(); if (!m || QUIET) return; rcMode = kind; const hunter = kind === 'infected' || m.role === 'hunter';
  const c = $('roleCard'); c.className = hunter ? 'hunter' : 'hider';
  $('rcTitle').innerHTML = kind === 'infected' ? "You've been infected,<br>you're a <b>HUNTER</b> now" : `You're a <b>${hunter ? 'HUNTER' : 'HIDER'}</b>`;
  $('rcGoal').textContent = kind === 'infected' ? 'Help the hunters find the hiders who are left.' : hunter ? 'Find and tag every hider before time runs out.' : 'Stay hidden until the timer hits zero.';
  $('rcBullets').innerHTML = (kind === 'infected' ? ['📡 You now get the hider pings', '🔦 You see the other hunters live', '🙌 Tag hiders, then confirm in the app'] : modeBullets(S.settings)).map(b => `<li>${esc(b)}</li>`).join('');
  tickRoleCard(); c.classList.remove('hidden');
}
function roleCardCheck(m) { if (revealCheck()) return; if (S.round !== rcRound && (S.state === 'hiding' || (S.state === 'playing' && tnow() - S.startedAt < 8000))) { rcRound = S.round; showRoleCard('start'); } }
function tickRoleCard() {
  const c = $('roleCard'); if (c.classList.contains('hidden') || !S) return; const m = me(), t = tnow();
  if (rcMode === 'infected') { $('rcCount').textContent = ''; return; }
  if (S.state === 'hiding') $('rcCount').textContent = m?.role === 'hunter' ? `Wait... hunters release in ${fmt(S.hideEndsAt - t)}` : `Hide! ${fmt(S.hideEndsAt - t)}`;
  else { $('rcCount').textContent = m?.role === 'hunter' ? 'Go! The hunt is on' : 'The hunt is on: stay hidden!'; if (m?.role === 'hunter' && rcMode === 'start') c.classList.add('hidden'); } // auto-dismiss at release for hunters
  if (S.state !== 'hiding' && S.state !== 'playing') c.classList.add('hidden');
}
$('roleCard').onclick = () => $('roleCard').classList.add('hidden');
// ping as a moment: ripple at each pinged spot, short haptic for hunters
function ripple(lat, lng, color) {
  if (!map || document.hidden) return; const r = L.marker([lat, lng], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'rippleWrap', html: `<div class="ripple" style="--c:${color}"><i></i><i></i></div>`, iconSize: [0, 0] }) }).addTo(map);
  setTimeout(() => r.remove(), 2400);
}
function onPingFx(m) {
  const mm = me(); if (!mm || !S || S.state !== 'playing') return;
  if (m.locs) { navigator.vibrate?.(40); for (const l of Object.values(m.locs)) if (l) ripple(l.lat, l.lng, Icons.COL.hider); window.lastRipple = Date.now(); }
  else if (mm.role === 'hider' && !mm.caught && myLoc) ripple(myLoc.lat, myLoc.lng, Icons.COL.hider);
  coach(mm.role === 'hunter' ? 'pingHunter' : 'pingHider');
}
// coach tips: one-time per device (localStorage), one at a time, auto-hide after 6 s
const TIPS = {
  pingHunter: '📡 First ping! Cyan badges show where each hider WAS. They update once per ping.',
  pingHider: "📡 You were just pinged: hunters saw this spot. Move before the next one!",
  decoy: '👻 Decoy ready: tap it to make your next ping show a fake spot 30-150 m away.',
  bounty: '💰 Bounty! Reach the gold coin first: hiders wipe their next ping, hunters trigger a surprise ping.',
  pickup: '🎁 Picking up: stay within 15 m for 5 s. Walk away and it resets.',
  powerup: '⚡ Power-up in your slot (bottom-left). Tap it to use, then a 3-min cooldown.',
  chime: '🔔 You chimed: a hunter was within 40 m at the ping. Move!',
  chimeHunter: '🔔 A chime means a hider was within 40 m of a hunter at that ping. Look around!',
  oob: '🚨 Out of bounds: get back inside the yellow line or hunters see your real spot.',
  compass: '🧭 Sudden death: no more map pings. Hunters get a compass to the nearest hider.',
  caught: "😵 You're caught. You're a spectator now: the full replay is in the recap.",
  infected: "🧟 Infected: you're a hunter now. You get pings and see the other hunters live.",
  record: '⏺ Recording stays on this phone. Tap the round bubble to swap camera and map.',
};
let tipSeen = JSON.parse(localStorage.getItem('scramTips') || '{}'), tipQ = [], tipOn = false;
function coach(k) {
  if (QUIET || !TIPS[k] || tipSeen[k] || tipQ.includes(k)) return; tipSeen[k] = 1; try { localStorage.setItem('scramTips', JSON.stringify(tipSeen)); } catch {}
  tipQ.push(k); if (!tipOn) nextTip();
}
function nextTip() { const k = tipQ.shift(), e = $('coach'); if (!k) { tipOn = false; return; } tipOn = true; window.lastTip = k; $('coachTxt').textContent = TIPS[k]; e.classList.add('show'); clearTimeout(nextTip.t); nextTip.t = setTimeout(hideTip, 6000); }
function hideTip() { $('coach').classList.remove('show'); clearTimeout(nextTip.t); setTimeout(nextTip, 450); }
$('coachX').onclick = hideTip;
function coachState(m) {
  if (S.state === 'playing' && m.role === 'hider' && !m.caught && S.settings.features?.decoy && S.decoys > 0 && !S.compass) coach('decoy');
  if (S.outSince) coach('oob'); if (S.compass) coach('compass');
  if (m.caught && m.role === 'hider') coach('caught');
}
setInterval(() => { if (window.Rec?.recording) coach('record'); }, 1000);
window.Coach = { show: coach, TIPS, reset: resetTips };

// ---- v10: rejoin button + in-app browser escape hatch
function showRejoin(m) {
  const b = $('btnRejoin'); b.classList.remove('hidden');
  b.textContent = `↩️ Rejoin game ${m.code} as ${m.name}` + (m.state === 'lobby' || !m.role ? '' : ` (${m.caught ? 'caught' : m.role})`);
}
$('btnRejoin').onclick = () => { if (!sess) return; unlockAudio?.(); sendMsg({ type: 'rejoin', code: sess.code, token: sess.token }); };
(function inAppBanner() {
  const r = window.InApp && InApp.detect(navigator.userAgent); if (!r || !r.inApp) return;
  document.body.dataset.inapp = r.app; const box = $('inapp'); box.classList.remove('hidden');
  const link = () => { const u = new URL(location.href); const c = $('code').value.trim().toUpperCase(); if (c && !u.searchParams.get('code')) u.searchParams.set('code', c); return u.href; };
  if (r.os === 'android') { $('inappMsg').textContent = "Open in Chrome so the game doesn't close when you switch apps."; const a = $('btnChrome'); a.classList.remove('hidden'); a.href = InApp.chromeIntent(link()); a.onclick = () => { a.href = InApp.chromeIntent(link()); }; }
  else if (r.os === 'ios') { $('inappMsg').classList.add('hidden'); $('inappIos').classList.remove('hidden'); $('inappArrow').classList.remove('hidden'); }
  $('btnCopyLink').onclick = async () => { const u = link(); try { await navigator.clipboard.writeText(u); toast('Link copied — paste it into ' + (r.os === 'ios' ? 'Safari' : 'Chrome')); } catch { prompt('Copy this link:', u); } };
  $('inappClose').onclick = () => box.classList.toggle('mini'); // minimizes, but stays on the join screen
})();

// ---------- v13: clock sync + synced countdown & dramatic role reveal ----------
let syncedOffset = null, tsSamples = [], tsBusy = false;
function timeSync() { // a few NTP-style round trips over the WS; offset = best of the lowest-RTT samples
  if (tsBusy) return; tsBusy = true; tsSamples = []; let n = 0;
  const go = () => { if (n++ >= 6 || !ws || ws.readyState !== 1) { tsBusy = false; return; } sendMsg({ type: 'time', c: performance.timeOrigin + performance.now() }); setTimeout(go, 80); };
  go();
}
function onTime(m) {
  tsSamples.push(TimeSync.sampleOf(m.c, m.s, performance.timeOrigin + performance.now()));
  const b = TimeSync.bestOffset(tsSamples); // performance clock ~ Date.now(), but monotonic within the page
  syncedOffset = b.offset + (performance.timeOrigin + performance.now() - Date.now()); offset = syncedOffset; window.clockSync = { offset: syncedOffset, rtt: b.rtt, n: tsSamples.length };
}
const RVRM = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let rv = null; // active reveal: { round, R, fired:{}, raf }
function revealCheck() { // true while the countdown/reveal owns the screen (role card waits)
  if (!S || QUIET || !S.revealAt || !(S.state === 'hiding' || S.state === 'playing')) return false;
  if (rv && rv.round === S.round) return !rv.done;
  if (S.round === rcRound) return false;
  if (tnow() >= S.revealAt + TimeSync.OUTRO) return false; // late joiner / reconnect after the reveal: straight to the role card
  startReveal(); return true;
}
function startReveal() {
  const o = $('reveal'); rv = { round: S.round, R: S.revealAt, fired: {}, done: false };
  o.className = RVRM() ? 'rm' : ''; o.dataset.phase = ''; $('rvStage').innerHTML = ''; o.classList.remove('hidden'); document.body.classList.add('revealing');
  let n = 0; try { n = +localStorage.getItem('scramGames') || 0; localStorage.setItem('scramGames', n + 1); } catch {}
  $('rvSkip').classList.toggle('hidden', n < 1);
  wake(); sizeRadar(); rv.raf = requestAnimationFrame(revealFrame);
}
function endReveal() {
  if (!rv || rv.done) return; rv.done = true; cancelAnimationFrame(rv.raf);
  $('reveal').classList.add('hidden'); document.body.classList.remove('revealing'); $('rvStage').innerHTML = '';
  rcRound = S.round; showRoleCard('start'); window.revealDone = { at: Date.now(), srv: tnow() };
}
$('rvSkip').onclick = e => { e.stopPropagation(); endReveal(); };
function rvGain(mult) { return chimeGain() * mult; } // host volume x soft factor (residential-friendly)
function tone(fn) { if (!actx || actx.state !== 'running') return; try { fn(actx, actx.currentTime); } catch {} }
function thump(i) { // heartbeat "lub-dub": two short low sine drops
  tone((a, t) => { for (const [d, f, v] of [[0, 70, 1], [0.16, 58, 0.7]]) { const o = a.createOscillator(), g = a.createGain(); o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.6, t + d); o.frequency.exponentialRampToValueAtTime(f, t + d + 0.09);
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(rvGain(0.55 + i * 0.1) * v, t + d + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22);
    o.connect(g).connect(a.destination); o.start(t + d); o.stop(t + d + 0.25); } });
}
function hunterHit() { tone((a, t) => { const o = a.createOscillator(), o2 = a.createOscillator(), f = a.createBiquadFilter(), g = a.createGain();
  o.type = 'sawtooth'; o2.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.6); o2.frequency.setValueAtTime(55, t);
  f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(120, t + 0.6);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(rvGain(0.6), t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  o.connect(f); o2.connect(f); f.connect(g).connect(a.destination); o.start(t); o2.start(t); o.stop(t + 0.95); o2.stop(t + 0.95); }); }
function hiderWhoosh() { tone((a, t) => { const len = a.sampleRate * 0.9, b = a.createBuffer(1, len, a.sampleRate), d = b.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(); src.buffer = b; f.type = 'bandpass'; f.Q.value = 1.2;
  f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2400, t + 0.45); f.frequency.exponentialRampToValueAtTime(600, t + 0.85);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(rvGain(0.35), t + 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
  src.connect(f).connect(g).connect(a.destination); src.start(t); src.stop(t + 0.9); }); }
function sizeRadar() { const c = $('rvRadar'), d = Math.min(devicePixelRatio || 1, 2); c.width = innerWidth * d; c.height = innerHeight * d; }
function drawRadar(p) { // p 0..1 over the 600 ms sweep
  const c = $('rvRadar'), x = c.getContext('2d'), w = c.width, h = c.height, cx = w / 2, cy = h / 2, r = Math.hypot(w, h) / 2;
  x.clearRect(0, 0, w, h); x.strokeStyle = 'rgba(52,211,153,.35)'; x.lineWidth = 2;
  for (let i = 1; i <= 4; i++) { x.beginPath(); x.arc(cx, cy, r * i / 4 * Math.min(1, p * 2), 0, 7); x.stroke(); }
  const a = -Math.PI / 2 + p * Math.PI * 2 * 1.5, g = x.createConicGradient ? x.createConicGradient(a - 0.9, cx, cy) : null;
  x.save(); x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, r, a - 0.9, a); x.closePath();
  if (g) { g.addColorStop(0, 'rgba(52,211,153,0)'); g.addColorStop(0.9 / 6.283, 'rgba(52,211,153,.55)'); g.addColorStop(1, 'rgba(52,211,153,0)'); x.fillStyle = g; } else x.fillStyle = 'rgba(52,211,153,.3)';
  x.fill(); x.restore(); if (p > 0.8) { x.fillStyle = `rgba(255,255,255,${(p - 0.8) * 4})`; x.fillRect(0, 0, w, h); }
}
const NUM_I = { 3: 0, 2: 1, 1: 2 };
function revealFrame() {
  if (!rv || rv.done) return; rv.raf = requestAnimationFrame(revealFrame);
  const dt = tnow() - rv.R, ph = TimeSync.phaseAt(dt), o = $('reveal');
  if (ph === 'card' || S.round !== rv.round || !(S.state === 'hiding' || S.state === 'playing')) return endReveal();
  if (ph === 'radar' && !o.classList.contains('rm')) drawRadar(Math.min(1, (dt + 600) / 600));
  if (rv.fired[ph]) return; if (ph === 'reveal' && !me()?.role) return; // roles only arrive from the server at revealAt: wait for that state
  rv.fired[ph] = true;
  const beat = TimeSync.BEATS.find(b => b.k === ph), late = beat ? dt - beat.at : 0, fresh = late < 150; // effects only when on time (late joiners jump silently)
  o.dataset.phase = ph; window.revealLog = window.revealLog || []; window.revealLog.push({ ph, srv: tnow(), late });
  const st = $('rvStage');
  if (ph === 'hold') st.innerHTML = '<div class="rvHold">Hold your phones out!</div>';
  else if (ph in NUM_I) { const i = NUM_I[ph]; st.innerHTML = `<div class="rvNum n${i}">${ph}</div>`; o.style.setProperty('--pulse', (0.9 - i * 0.25) + 's');
    if (fresh) { thump(i); navigator.vibrate?.(60 + i * 30); } }
  else if (ph === 'black') st.innerHTML = '';
  else if (ph === 'radar') { st.innerHTML = ''; }
  else if (ph === 'reveal') { // role element only enters the DOM now
    const m = me(); if (!m) return; const hunter = m.role === 'hunter';
    const team = hunter ? 'Team Hunters' : 'Team Hiders', inf = S.settings.caughtBecomeHunter ? (hunter ? '🧟 Infection: tagged hiders join you' : '🧟 Infection: if tagged, you turn hunter') : '';
    o.classList.add(hunter ? 'hunter' : 'hider'); $('rvRadar').getContext('2d').clearRect(0, 0, 9999, 9999);
    st.innerHTML = `<div id="rvRole" class="rvRole ${hunter ? 'hunter' : 'hider'}">${hunter ? '<div class="rvCross"><i></i><i></i><b></b></div>' : '<div class="rvFog"></div>'}<div class="rvWord">${hunter ? 'HUNTER' : 'HIDER'}</div><div class="rvTeam">${team}</div>${inf ? `<div class="rvInf">${inf}</div>` : ''}</div>`;
    window.revealRole = { text: st.textContent, cross: !!st.querySelector('.rvCross'), fog: !!st.querySelector('.rvFog'), srv: tnow() }; render();
    if (fresh) { if (hunter) { hunterHit(); navigator.vibrate?.([250, 60, 250]); } else { hiderWhoosh(); navigator.vibrate?.(80); } }
  }
}
addEventListener('resize', () => { if (rv && !rv.done) sizeRadar(); });
