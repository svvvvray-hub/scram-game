// v16 hider mini-tasks: card UI. The server generates every puzzle and checks every answer.
(function () {
  const $ = id => document.getElementById(id);
  const snow = () => Date.now() + (typeof offset === 'number' ? offset : 0);
  let task = null, open = false, cur = null, timer = 0; // cur = per-task client state
  const COL = { red: '#e5484d', blue: '#3e8ef7', yellow: '#f5c400', green: '#30a46c' };
  const NAMES = { math: '🧮 Quick math', slide: '🧩 Slide puzzle', wire: '🔌 Wire connect', hold: '🧘 Hold still' };
  const HINT = { math: 'Solve all 3 in 15 s.', slide: 'Tap tiles next to the gap to put 1–8 in order (30 s).', wire: 'Drag (or tap) each wire to its colour (20 s).', hold: 'Stay within 8 m for 20 s. Keep the app open.' };
  const send = m => typeof sendMsg === 'function' && sendMsg(m);
  function pill() {
    const p = $('taskPill'); if (!p) return;
    p.classList.toggle('hidden', !task || open);
    if (task) { const left = Math.max(0, Math.ceil(((task.startedAt ? task.startedAt + task.limitMs : task.expiresAt) - snow()) / 1000)); p.textContent = `${task.startedAt ? '▶' : '🧩'} Task · ${left}s`; }
  }
  function tickUI() {
    pill(); if (!task) return;
    if (open && task.startedAt) { const left = Math.max(0, (task.startedAt + task.limitMs - snow()) / 1000); $('taskTime').textContent = left.toFixed(0) + ' s';
      $('taskBar').style.width = (100 * left / (task.limitMs / 1000)) + '%'; }
    else if (open) { $('taskTime').textContent = 'expires in ' + Math.max(0, Math.ceil((task.expiresAt - snow()) / 1000)) + ' s'; $('taskBar').style.width = '100%'; }
  }
  function show() { if (!task) return; open = true; $('toast')?.classList.remove('show'); $('taskCard').classList.remove('hidden'); if (!task.startedAt) send({ type: 'taskStart', id: task.id }); render(); pill(); }
  function hide() { open = false; $('taskCard').classList.add('hidden'); pill(); }
  function render() {
    const k = task; if (!k) return; $('taskTitle').textContent = NAMES[k.type]; $('taskHint').textContent = HINT[k.type];
    const b = $('taskBody'); if (cur && cur.id === k.id && b.dataset.id === k.id) { tickUI(); return; }
    cur = { id: k.id }; b.dataset.id = k.id; b.innerHTML = '';
    if (k.type === 'math') {
      k.data.problems.forEach((p, i) => { const r = document.createElement('label'); r.className = 'tkMath';
        r.innerHTML = `<span>${p.a} ${p.op} ${p.b} =</span><input inputmode="numeric" pattern="-?[0-9]*" autocomplete="off" id="tkM${i}" aria-label="Answer ${i + 1}">`; b.appendChild(r); });
      const s = document.createElement('button'); s.id = 'tkSubmit'; s.className = 'primary'; s.textContent = 'Submit';
      s.onclick = () => send({ type: 'taskSubmit', id: k.id, answer: [0, 1, 2].map(i => $('tkM' + i).value.trim()) }); b.appendChild(s);
      setTimeout(() => $('tkM0')?.focus(), 50);
    } else if (k.type === 'slide') {
      cur.board = k.data.board.slice(); cur.moves = [];
      const g = document.createElement('div'); g.className = 'tkSlide'; g.id = 'tkSlide'; b.appendChild(g);
      const draw = () => { g.innerHTML = ''; cur.board.forEach((v, i) => { const t = document.createElement('button'); t.className = v ? 'tile' : 'tile gap'; t.textContent = v || ''; t.dataset.v = v;
        t.onclick = () => { const z = cur.board.indexOf(0), r = Math.floor(i / 3), c = i % 3, zr = Math.floor(z / 3), zc = z % 3;
          if (!v || Math.abs(r - zr) + Math.abs(c - zc) !== 1) return; cur.board[z] = v; cur.board[i] = 0; cur.moves.push(v); navigator.vibrate?.(10); draw();
          if (cur.board.join() === '1,2,3,4,5,6,7,8,0') send({ type: 'taskSubmit', id: k.id, answer: cur.moves }); }; g.appendChild(t); }); };
      draw();
    } else if (k.type === 'wire') {
      cur.map = {}; cur.sel = null;
      const w = document.createElement('div'); w.className = 'tkWire'; w.id = 'tkWire';
      w.innerHTML = '<svg class="tkLines"></svg><div class="col L"></div><div class="col R"></div>'; b.appendChild(w);
      const svg = w.querySelector('svg'), Lc = w.querySelector('.L'), Rc = w.querySelector('.R');
      k.data.left.forEach(c => { const d = document.createElement('button'); d.className = 'plug'; d.dataset.c = c; d.style.background = COL[c]; d.setAttribute('aria-label', c + ' wire'); Lc.appendChild(d); });
      k.data.right.forEach((c, i) => { const d = document.createElement('button'); d.className = 'plug sock'; d.dataset.i = i; d.style.borderColor = COL[c]; d.setAttribute('aria-label', c + ' socket'); Rc.appendChild(d); });
      const ctr = el => { const a = el.getBoundingClientRect(), o = w.getBoundingClientRect(); return [a.left - o.left + a.width / 2, a.top - o.top + a.height / 2]; };
      const lines = (drag) => { let h = ''; for (const [c, i] of Object.entries(cur.map)) { const [x1, y1] = ctr(Lc.querySelector(`[data-c="${c}"]`)), [x2, y2] = ctr(Rc.children[i]); h += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COL[c]}" stroke-width="8" stroke-linecap="round"/>`; }
        if (drag) h += `<line x1="${drag[0]}" y1="${drag[1]}" x2="${drag[2]}" y2="${drag[3]}" stroke="${COL[drag[4]]}" stroke-width="8" stroke-linecap="round" opacity=".6"/>`; svg.innerHTML = h;
        Lc.querySelectorAll('.plug').forEach(p => p.classList.toggle('sel', p.dataset.c === cur.sel)); };
      const connect = (c, i) => { for (const [cc, ii] of Object.entries(cur.map)) if (ii === i) delete cur.map[cc]; cur.map[c] = i; cur.sel = null; navigator.vibrate?.(10); lines();
        if (Object.keys(cur.map).length === 4) send({ type: 'taskSubmit', id: k.id, answer: cur.map }); };
      Lc.querySelectorAll('.plug').forEach(p => { p.onpointerdown = e => { e.preventDefault(); cur.sel = p.dataset.c; const [x, y] = ctr(p); lines();
        const o = w.getBoundingClientRect(); const mv = ev => lines([x, y, ev.clientX - o.left, ev.clientY - o.top, cur.sel]);
        const up = ev => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
          const t = document.elementFromPoint(ev.clientX, ev.clientY); if (t && t.classList.contains('sock') && cur.sel) connect(cur.sel, +t.dataset.i); else lines(); };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); }; });
      Rc.querySelectorAll('.sock').forEach(s => { s.onclick = () => { if (cur.sel) connect(cur.sel, +s.dataset.i); }; });
      requestAnimationFrame(() => lines());
    } else if (k.type === 'hold') {
      b.innerHTML = '<div class="tkHold" id="tkHold"><div class="ring"><span>🧘</span></div><p>Don’t move. Your GPS is checked by the server.</p></div>';
    }
    tickUI();
  }
  function result(m) {
    window.taskHold = false;
    navigator.vibrate?.(m.ok ? [40, 40, 40] : 120);
    toast(m.ok ? `✅ Task done! Extra Time −${m.bonusSec} s on the clock` : `❌ Task ${m.reason === 'expired' ? 'expired' : m.reason === 'moved' ? 'failed — you moved' : m.reason === 'timeout' ? 'ran out of time' : 'failed'} — your next ping is extra accurate`, 4000);
    task = null; cur = null; hide();
  }
  window.TaskUI = {
    onMsg(m) {
      if (m.type === 'taskOffer') { navigator.vibrate?.(60); toast('🧩 New task! Tap the Task button to earn Extra Time', 3500); return true; }
      if (m.type === 'taskResult') { result(m); return true; }
      if (m.type === 'taskDone') { toast('🧩 A hider completed a task!', 3500); return true; }
      return false;
    },
    onState(S) {
      const t = S && S.state === 'playing' ? S.task || null : null;
      if (!t) { if (task) { task = null; cur = null; hide(); } window.taskHold = false; return; }
      task = t; window.taskHold = t.type === 'hold' && !!t.startedAt;
      if (open) render(); pill();
    },
    show, hide,
  };
  document.addEventListener('DOMContentLoaded', () => {});
  $('taskPill').onclick = show; $('taskClose').onclick = hide;
  timer = setInterval(tickUI, 500);
})();
