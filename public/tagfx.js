// v19 auto-tag reliability: fast GPS while a tag is in progress + the "GPS went quiet" confirm fallback.
(function () {
  const $ = id => document.getElementById(id);
  const send = m => typeof sendMsg === 'function' && sendMsg(m);
  let boostT = 0, nudged = 0, fbKey = null, fbExp = 0, askKey = null, askExp = 0, hostKey = null;
  function boostFix() { // a brand-new high-accuracy fix every second (never re-sends an old one)
    navigator.geolocation?.getCurrentPosition(pos => { const l = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, ts: pos.timestamp || Date.now() };
      if (typeof GpsThrottle !== 'undefined' && !GpsThrottle.accept(myLoc, l, Date.now())) return; myLoc = l; window.lastWatchAt = Date.now(); maybeSend(true); }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 2500 });
    if (typeof watchId !== 'undefined' && watchId !== null && Date.now() - (window.lastWatchAt || 0) > 5000) { // watchPosition stalled: re-arm it
      navigator.geolocation.clearWatch(watchId); watchId = null; startGps(); window.gpsRearms = (window.gpsRearms || 0) + 1; }
  }
  function boost(on) {
    window.gpsBoost = on; clearInterval(boostT); boostT = 0;
    if (on) { boostT = setInterval(boostFix, 1000); boostFix(); typeof wake === 'function' && wake();
      if (Date.now() - nudged > 60000) { nudged = Date.now(); toast('📶 Tag in progress: keep your screen on and the app open', 3500); } }
  }
  function tickUI() {
    if (fbKey) { const s = Math.max(0, Math.ceil((fbExp - snow()) / 1000)); $('tagFbLeft').textContent = s + ' s'; if (!s) hideFb(); }
    if (askKey) { const s = Math.max(0, Math.ceil((askExp - snow()) / 1000)); $('tagAskLeft').textContent = `Answer within ${s} s, or the host decides.`; }
  }
  const snow = () => Date.now() + (typeof offset === 'number' ? offset : 0);
  const hideFb = () => { fbKey = null; $('tagFbBtn').classList.add('hidden'); };
  window.TagFx = {
    onMsg(m) {
      if (m.type === 'gpsBoost') { boost(!!m.on); return true; }
      if (m.type === 'tagFallback') { fbKey = m.key; fbExp = m.expiresAt; $('tagFbBtn').disabled = false; $('tagFbBtn').firstChild.textContent = '✅ Tap to confirm tag '; $('tagFbBtn').classList.remove('hidden');
        navigator.vibrate?.([80, 60, 80]); toast('📶 The hider’s GPS went quiet. Tagged them in real life? Tap to confirm.', 4500); tickUI(); return true; }
      if (m.type === 'tagFbWait') { $('tagFbBtn').disabled = true; $('tagFbBtn').firstChild.textContent = '⏳ Waiting for the hider to confirm… '; return true; }
      if (m.type === 'tagAsk') { askKey = m.key; askExp = m.expiresAt; $('tagAskBy').textContent = `${m.by} says they tagged you while your GPS was quiet.`; $('tagAsk').classList.remove('hidden'); navigator.vibrate?.([200, 100, 200]); tickUI(); return true; }
      if (m.type === 'tagHost') { hostKey = m.key; $('tagHostTxt').textContent = `${m.hunter} says they tagged ${m.hider}, whose GPS went quiet. ${m.hider} didn’t answer.`; $('tagHostAsk').classList.remove('hidden'); navigator.vibrate?.(150); return true; }
      if (m.type === 'tagFbEnd') {
        if (m.key === fbKey) { hideFb(); if (m.ok === false) toast(m.why === 'denied' ? '🙅 The hider says they weren’t tagged' : m.why === 'host-denied' ? '🙅 The host says no tag' : '⌛ Tag confirm expired', 3500); }
        if (m.key === askKey) { askKey = null; $('tagAsk').classList.add('hidden'); if (m.why === 'host') toast('⌛ No answer: the host will decide', 3500); }
        if (m.key === hostKey && m.ok !== null) { hostKey = null; $('tagHostAsk').classList.add('hidden'); }
        return true;
      }
      return false;
    },
  };
  $('tagFbBtn').onclick = () => { if (fbKey) send({ type: 'tagClaim', key: fbKey }); };
  $('tagAskYes').onclick = () => { if (askKey) send({ type: 'tagAnswer', key: askKey, yes: true }); };
  $('tagAskNo').onclick = () => { if (askKey) send({ type: 'tagAnswer', key: askKey, yes: false }); };
  $('tagHostYes').onclick = () => { if (hostKey) send({ type: 'tagHostAnswer', key: hostKey, yes: true }); };
  $('tagHostNo').onclick = () => { if (hostKey) send({ type: 'tagHostAnswer', key: hostKey, yes: false }); };
  setInterval(tickUI, 500);
})();
