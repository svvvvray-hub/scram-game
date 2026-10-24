// v18 post-round Regroup panel (shown on the recap screen; the server only sends this after the round has ended)
(function () {
  const $ = id => document.getElementById(id);
  const E = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const send = m => typeof sendMsg === 'function' && sendMsg(m);
  let R = null, map = null, pin = null, meDot = null, rating = 0, fitted = false, lastFbCount = 0;
  const fmtD = d => d == null ? '—' : d < 1000 ? `${d} m` : `${(d / 1000).toFixed(1)} km`;
  const TREND = { closer: '⬇ getting closer', away: '⬆ moving away', stopped: '⏸ stopped' };
  const STATUS = { in: '✅ coming back', done: '👋 done', none: '… no answer' };
  const FACES = ['', '😞', '😕', '😐', '🙂', '🤩'];
  function dirUrl(l) { const ios = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
    return ios ? `https://maps.apple.com/?daddr=${l.lat},${l.lng}&dirflg=w` : `https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lng}&travelmode=walking`; }
  function drawMap() {
    if (!window.L || !R?.anchor?.loc) { $('rgMap').classList.add('hidden'); return; } $('rgMap').classList.remove('hidden');
    if (!map) { map = L.map('rgMap', { zoomControl: false, attributionControl: true }); typeof baseLayer === 'function' ? baseLayer(map) : L.tileLayer('/tiles/{z}/{x}/{y}.png').addTo(map); }
    const a = R.anchor.loc, ll = [a.lat, a.lng];
    const icon = L.divIcon({ className: 'rgPin', html: '<div class="rgPinIn">📍<b>Meet here</b></div>', iconSize: [96, 40], iconAnchor: [48, 40] });
    if (!pin) pin = L.marker(ll, { icon, zIndexOffset: 1000 }).addTo(map); else pin.setLatLng(ll);
    const mine = typeof myLoc !== 'undefined' && myLoc ? [myLoc.lat, myLoc.lng] : null;
    if (mine && !R.me.isAnchor) { if (!meDot) meDot = L.circleMarker(mine, { radius: 8, color: '#fff', weight: 3, fillColor: '#3e8ef7', fillOpacity: 1 }).bindTooltip('You').addTo(map); else meDot.setLatLng(mine); }
    if (!fitted) { fitted = true; setTimeout(() => { map.invalidateSize(); if (mine && R.me.dist > 20) map.fitBounds(L.latLngBounds([ll, mine]).pad(0.35)); else map.setView(ll, 17); }, 60); }
  }
  function render() {
    if (!R || !window.S || S.state !== 'ended') { $('regroup').classList.add('hidden'); return; }
    $('regroup').classList.remove('hidden');
    const A = R.anchor, iAmAnchor = A && A.id === S.you; R.me.isAnchor = iAmAnchor;
    $('rgAnchor').innerHTML = !A ? '' : iAmAnchor ? '📍 You’re the meeting point. Everyone sees your live position now that the round is over.'
      : `📍 Meet back at <b>${E(A.name)}</b>${A.isCreator ? ' (room creator)' : ' (host)'}${A.loc ? '' : ' · waiting for their location…'}`;
    $('rgDist').textContent = iAmAnchor ? '' : A?.loc ? `You’re ${fmtD(R.me.dist)} away` : '';
    const dl = $('rgDirections'); dl.classList.toggle('hidden', iAmAnchor || !A?.loc); if (A?.loc) dl.href = dirUrl(A.loc);
    drawMap();
    const host = !!R.panel && S.you === S.host;
    $('rgChoice').classList.toggle('hidden', host || !!R.me.choice);
    $('rgMine').textContent = host ? '' : R.me.choice === 'in' ? '✅ You’re in. Head back to the host; the next round starts from the lobby.' : R.me.choice === 'done' ? '👋 Thanks for playing!' : '';
    const showFb = R.me.choice === 'done' && !R.me.fbDone;
    $('rgFeedback').classList.toggle('hidden', !showFb); $('rgThanks').classList.toggle('hidden', !(R.me.choice === 'done' && R.me.fbDone && !showFb));
    $('rgPanel').classList.toggle('hidden', !R.panel);
    if (R.panel) {
      const P = R.panel; $('rgWaiting').textContent = P.waiting ? `⏳ Waiting on ${P.waiting} of ${P.total}` : `✅ Everyone answered · ${P.inCount} in`;
      $('rgList').innerHTML = P.rows.map(r => `<li class="rg_${r.status}" data-id="${E(r.id)}"><b>${E(r.name)}</b>${r.anchor ? ' 📍' : ''} <span class="st">${STATUS[r.status]}</span>
        <span class="d">${r.anchor ? 'meeting point' : fmtD(r.dist)}${r.trend ? ' · ' + TREND[r.trend] : ''}</span>${r.conn !== 'ok' ? `<span class="warn">${r.conn === 'closed' ? '⚠️ closed the browser' : '⚠️ connection dropped'}</span>` : ''}${r.fb ? ' <span class="fbTag">💬</span>' : ''}</li>`).join('') || '<li class="note">Nobody else here.</li>';
      $('rgNext').classList.toggle('hidden', S.you !== S.host);
      $('rgFbList').innerHTML = P.fb.length ? '<h3>💬 Why people left</h3>' + P.fb.map(f => `<div class="rgFbItem"><b>${E(f.name)}</b> ${f.rating ? FACES[f.rating] : ''}${f.liked ? `<div>👍 ${E(f.liked)}</div>` : ''}${f.improve ? `<div>🛠 ${E(f.improve)}</div>` : ''}</div>`).join('') : '';
    }
  }
  window.Regroup = {
    onMsg(m) {
      if (m.type === 'regroup') { R = m; render(); return true; }
      if (m.type === 'feedbackIn') { toast(`💬 ${m.name} left feedback${m.rating ? ' ' + FACES[m.rating] : ''}`, 3500); return true; }
      if (m.type === 'notifyRes') { $('rgNMsg').textContent = m.ok ? '✅ You’re on the list. We’ll ping you for the next game!' : '⚠️ ' + (m.error || 'Could not save that.'); if (m.ok) $('rgNSave').disabled = true; return true; }
      if (m.type === 'regroupOut') { toast('👋 The next round started without you. Thanks for playing!', 5000); return true; }
      return false;
    },
    onState(S) {
      if (!S) return;
      if (S.state === 'ended') { if (R && R.round !== S.round) R = null; render(); return; }
      if (S.state === 'lobby' && R && R.me.choice === 'in' && typeof viewingEnd !== 'undefined' && viewingEnd) { R = null; fitted = false; $('btnHome').click(); return; }
      if (S.state !== 'ended') { $('regroup').classList.add('hidden'); fitted = false; }
    },
    get data() { return R; },
  };
  $('rgIn').onclick = () => { navigator.vibrate?.(30); send({ type: 'regroup', choice: 'in' }); };
  $('rgDone').onclick = () => { navigator.vibrate?.(30); send({ type: 'regroup', choice: 'done' }); };
  $('rgStars').onclick = e => { const b = e.target.closest('button'); if (!b) return; rating = +b.dataset.r; [...$('rgStars').children].forEach(x => x.classList.toggle('on', +x.dataset.r === rating)); };
  $('rgSend').onclick = () => send({ type: 'feedback', rating: rating || null, liked: $('rgLiked').value.slice(0, 500), improve: $('rgImprove').value.slice(0, 500) });
  $('rgSkip').onclick = () => send({ type: 'feedback', skip: true });
  $('rgNext').onclick = () => { const P = R?.panel; const out = P ? P.rows.filter(r => r.status !== 'in').length : 0;
    if (out && !confirm(`Start the next round? ${out} player${out === 1 ? '' : 's'} who aren’t in will leave the room.`)) return; send({ type: 'nextRound' }); };
  // "Ping me for the next game": reuses the lobby's platform picker (same options) and prefills the saved @
  let nKind = 'social';
  $('rgNPlatform').innerHTML = $('platform').innerHTML;
  const setKind = k => { nKind = k; $('rgNSocial').classList.toggle('on', k === 'social'); $('rgNEmail').classList.toggle('on', k === 'email');
    $('rgNSocialRow').classList.toggle('hidden', k !== 'social'); $('rgNEmailIn').classList.toggle('hidden', k !== 'email'); };
  $('rgNSocial').onclick = () => setKind('social'); $('rgNEmail').onclick = () => setKind('email');
  $('rgNotify').addEventListener('toggle', () => { if (!$('rgNHandle').value && $('ig').value) { $('rgNHandle').value = $('ig').value; $('rgNPlatform').value = $('platform').value; } });
  $('rgNSave').onclick = () => { $('rgNMsg').textContent = '';
    send(nKind === 'email' ? { type: 'notifyMe', email: $('rgNEmailIn').value.trim().slice(0, 254) } : { type: 'notifyMe', platform: $('rgNPlatform').value, handle: $('rgNHandle').value.trim().slice(0, 120) }); };
  addEventListener('pagehide', () => { if (window.S && S.state === 'ended') send({ type: 'regroupBye' }); });
})();
