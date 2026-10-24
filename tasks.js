// v16 hider mini-tasks: pure generation + validation (server-authoritative; answers never leave the server).
const crypto = require('crypto');
const TYPES = ['math', 'slide', 'wire', 'hold'];
const LIMIT_MS = { math: 15000, slide: 30000, wire: 20000, hold: 20000 }; // time to finish once opened
const HOLD_R = 8; // metres you may drift during Hold still
const COLORS = ['red', 'blue', 'yellow', 'green'];
const GRACE = 2000;
const ri = (a, b) => crypto.randomInt(a, b + 1);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const SOLVED = [1, 2, 3, 4, 5, 6, 7, 8, 0];
const nbrs = i => [i - 3, i + 3, i % 3 ? i - 1 : -1, i % 3 < 2 ? i + 1 : -1].filter(j => j >= 0 && j < 9);
// apply one slide: tile value v must sit next to the blank
function slide(b, v) { const i = b.indexOf(v), z = b.indexOf(0); if (v === 0 || i < 0 || !nbrs(z).includes(i)) return null; b = b.slice(); b[z] = v; b[i] = 0; return b; }
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function make(type, rand = Math.random) {
  type = TYPES.includes(type) ? type : TYPES[Math.floor(rand() * TYPES.length)];
  const t = { id: crypto.randomBytes(4).toString('hex'), type, limitMs: LIMIT_MS[type] };
  if (type === 'math') {
    t.data = { problems: [] }; t.secret = [];
    for (let k = 0; k < 3; k++) { const op = ['+', '−', '×'][ri(0, 2)]; let a, b, r;
      if (op === '×') { a = ri(2, 9); b = ri(2, 9); r = a * b; } else if (op === '+') { a = ri(5, 49); b = ri(5, 49); r = a + b; } else { a = ri(10, 60); b = ri(1, a); r = a - b; }
      t.data.problems.push({ a, op, b }); t.secret.push(r); }
  } else if (type === 'slide') { // scramble by legal moves from solved => always solvable, short
    let b = SOLVED.slice(), prev = -1;
    for (let k = 0, n = ri(8, 12); k < n || same(b, SOLVED); k++) { const z = b.indexOf(0); const opts = nbrs(z).filter(j => b[j] !== prev); const j = opts[ri(0, opts.length - 1)]; prev = b[j]; b = slide(b, b[j]); }
    t.data = { board: b };
  } else if (type === 'wire') {
    t.data = { left: shuffle(COLORS), right: shuffle(COLORS) };
  } else t.data = { radiusM: HOLD_R, holdMs: LIMIT_MS.hold };
  return t;
}
// answer shapes: math [n,n,n]; slide [tile values moved in order]; wire {color: rightIndex}
function check(t, ans) {
  if (t.type === 'math') return Array.isArray(ans) && ans.length === 3 && ans.every((x, i) => Number(x) === t.secret[i] && String(x).trim() !== '');
  if (t.type === 'slide') { if (!Array.isArray(ans) || ans.length > 300) return false; let b = t.data.board;
    for (const v of ans) { b = slide(b, Number(v)); if (!b) return false; } return same(b, SOLVED); }
  if (t.type === 'wire') { if (!ans || typeof ans !== 'object' || Array.isArray(ans)) return false;
    return COLORS.every(c => Object.prototype.hasOwnProperty.call(ans, c) && t.data.right[Number(ans[c])] === c); }
  return false; // hold is checked from GPS, never from a client answer
}
const pub = t => t && ({ id: t.id, type: t.type, limitMs: t.limitMs, data: t.data, offeredAt: t.offeredAt, expiresAt: t.expiresAt, startedAt: t.startedAt || 0 });
module.exports = { TYPES, LIMIT_MS, HOLD_R, GRACE, COLORS, SOLVED, make, check, slide, pub };
