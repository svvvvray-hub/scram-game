'use strict';
// Private growth dashboard + brake switch at /admin. Enabled only when ADMIN_KEY is set.
// Auth: ?key=<ADMIN_KEY> or the login form; both set an HttpOnly cookie holding an HMAC of the key (never the key itself).
const crypto = require('crypto');
const express = require('express');
const COOKIE = 'lp_admin';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

function mount(app, { env, stats, liveCounts }) {
  const key = () => env.ADMIN_KEY || '';
  const token = () => crypto.createHmac('sha256', key()).update('lastping-admin-v1').digest('hex');
  const authed = req => { const k = key(); if (!k) return false;
    const q = req.query.key ?? req.body?.key; if (typeof q === 'string' && safeEq(q, k)) return true;
    const c = cookies(req)[COOKIE]; return typeof c === 'string' && safeEq(c, token()); };
  const setCookie = (req, res) => res.cookie(COOKIE, token(), { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/admin', maxAge: 30 * 864e5 });
  const gate = (req, res, next) => { if (!key()) return res.status(404).type('text').send('Not found'); res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex'); next(); };
  const form = express.urlencoded({ extended: false, limit: '4kb' }), json = express.json({ limit: '4kb' });

  app.get('/admin', gate, (req, res) => {
    if (!authed(req)) return res.status(401).type('html').send(page('Admin login', login(req.query.key !== undefined)));
    if (req.query.key !== undefined) { setCookie(req, res); return res.redirect(303, '/admin'); } // strip the key from the URL / history
    res.type('html').send(page('Last Ping · growth', dashboard(stats.summary(liveCounts()), req.query.saved)));
  });
  app.post('/admin/login', gate, form, (req, res) => {
    if (!authed(req)) return res.status(401).type('html').send(page('Admin login', login(true)));
    setCookie(req, res); res.redirect(303, '/admin');
  });
  app.post('/admin/logout', gate, (req, res) => { res.clearCookie(COOKIE, { path: '/admin' }); res.redirect(303, '/admin'); });
  app.get('/admin/stats.json', gate, (req, res) => { if (!authed(req)) return res.status(401).json({ error: 'unauthorized' }); res.json(stats.summary(liveCounts())); });
  app.post('/admin/settings', gate, form, json, (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    const b = req.body || {}, p = { maxGames: b.maxGames, maxPerHour: b.maxPerHour };
    if ('paused' in b || b.form === '1') p.paused = b.paused ?? false; // unchecked checkbox = not paused
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
    const s = stats.setSettings(p);
    if (req.is('json')) return res.json({ ok: true, settings: s });
    res.redirect(303, '/admin?saved=1');
  });
}

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#111827;color:#f9fafb;font:15px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px}h1{margin:.2em 0 .1em;font-size:1.8em}h2{font-size:1.05em;margin:0 0 10px;color:#d1d5db}
.sub{color:#9ca3af;margin:0 0 18px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px}
.card{background:#1f2937;border:1px solid #374151;border-radius:14px;padding:14px}.big{font:800 1.9em ui-monospace,monospace}.lbl{color:#9ca3af;font-size:.85em}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}@media(max-width:760px){.two{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid #374151;text-align:left}th{color:#9ca3af;font-weight:600}td.n,th.n{text-align:right;font-family:ui-monospace,monospace}
input{font:inherit;background:#111827;color:#fff;border:1px solid #374151;border-radius:8px;padding:8px;width:110px}
button{font:inherit;border:0;border-radius:10px;background:#16a34a;color:#fff;padding:9px 16px;font-weight:700;cursor:pointer}.ghost{background:#374151}
.brake{border-color:#f59e0b}.row{display:flex;gap:18px;flex-wrap:wrap;align-items:end}.row label{display:flex;flex-direction:column;gap:4px;color:#d1d5db}
.sw{display:flex!important;flex-direction:row!important;align-items:center;gap:8px;font-weight:700}.sw input{width:22px;height:22px}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:700;font-size:.85em}.on{background:#7f1d1d;color:#fecaca}.off{background:#14532d;color:#bbf7d0}
.ok{background:#14532d;border:1px solid #22c55e;border-radius:10px;padding:8px 12px;margin-bottom:12px}.err{color:#fca5a5}svg text{fill:#9ca3af;font-size:10px}
</style></head><body><main>${body}</main></body></html>`;

const login = bad => `<h1>📡 Last Ping admin</h1><p class="sub">Enter the admin key.</p>${bad ? '<p class="err">Wrong key.</p>' : ''}
<form method="post" action="/admin/login" class="card" style="max-width:360px"><label>Admin key<br><input type="password" name="key" autocomplete="current-password" style="width:100%" autofocus></label><br><button>Sign in</button></form>`;

function chart(days, field, color) { // inline SVG bar chart, 30 days
  const W = 500, H = 150, pad = 22, max = Math.max(1, ...days.map(d => d[field])), bw = (W - pad) / days.length;
  const bars = days.map((d, i) => { const h = (d[field] / max) * (H - 30); return `<rect x="${(pad + i * bw + 1).toFixed(1)}" y="${(H - 16 - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}"><title>${d.day}: ${d[field]}</title></rect>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${field} per day"><line x1="${pad}" y1="${H - 16}" x2="${W}" y2="${H - 16}" stroke="#374151"/>
<text x="0" y="12">${max}</text><text x="0" y="${H - 18}">0</text>${bars}<text x="${pad}" y="${H - 3}">${days[0].day.slice(5)}</text><text x="${W}" y="${H - 3}" text-anchor="end">today</text></svg>`;
}

function dashboard(s, saved) {
  const c = (n, l) => `<div class="card"><div class="big">${esc(n)}</div><div class="lbl">${esc(l)}</div></div>`;
  const t = s.days[s.days.length - 1], st = s.settings;
  const refRows = s.refs.length ? s.refs.map(r => `<tr><td>@${esc(r.ref)}</td><td class="n">${r.players}</td><td class="n">${r.games}</td><td class="n">${r.visits}</td></tr>`).join('') : '<tr><td colspan="4" class="lbl">No ?ref traffic yet</td></tr>';
  const shares = Object.entries(s.shares); const shareRows = shares.length ? shares.map(([k, n]) => `<tr><td>${k === 'viral' ? 'Make it viral' : k === 'reel' ? 'Reel share' : esc(k)}</td><td class="n">${n}</td></tr>`).join('') : '<tr><td colspan="2" class="lbl">No shares yet</td></tr>';
  return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><div><h1>📡 Last Ping · growth</h1><p class="sub">Private dashboard · counts only, anonymous device ids · last 30 days</p></div>
<form method="post" action="/admin/logout"><button class="ghost">Sign out</button></form></div>
${saved ? '<div class="ok">✅ Brake settings saved</div>' : ''}
<form method="post" action="/admin/settings" class="card brake" style="margin-bottom:14px"><input type="hidden" name="form" value="1">
<h2>🛑 Brake switch <span class="pill ${st.paused ? 'on' : 'off'}">${st.paused ? 'NEW GAMES PAUSED' : 'accepting new games'}</span></h2>
<div class="row"><label class="sw"><input type="checkbox" name="paused" value="on" id="paused" ${st.paused ? 'checked' : ''}> Pause new games</label>
<label>Max concurrent games<input type="number" name="maxGames" id="maxGames" min="0" value="${st.maxGames}"></label>
<label>Max new games / hour (0 = unlimited)<input type="number" name="maxPerHour" id="maxPerHour" min="0" value="${st.maxPerHour}"></label>
<button id="saveBrake">Save</button></div>
<p class="lbl" style="margin:8px 0 0">Existing games and joining always keep working. Blocked creates so far: ${s.totals.blocked} · created in the last hour: ${s.lastHour}</p></form>
<div class="grid" id="kpis">${c(s.live.games, 'open games now')}${c(s.live.playing, 'games in play now')}${c(s.live.online, 'players online now')}${c(s.totals.games, 'total games created')}${c(s.totals.started, 'total games started')}${c(s.totals.players, 'total unique players')}${c(t.players, 'players today')}${c(s.playClicks, '/play clicks')}</div>
<div class="two"><div class="card"><h2>Games created per day</h2>${chart(s.days, 'games', '#16a34a')}</div><div class="card"><h2>Unique players per day</h2>${chart(s.days, 'players', '#3b82f6')}</div></div>
<div class="two"><div class="card"><h2>Top referrers (?ref)</h2><table><tr><th>Referrer</th><th class="n">New players</th><th class="n">Games</th><th class="n">Visits</th></tr>${refRows}</table></div>
<div class="card"><h2>Shares</h2><table><tr><th>Kind</th><th class="n">Count</th></tr>${shareRows}</table><p class="lbl">Counted when a player taps Share on a reel or "Make it viral" clip.</p></div></div>`;
}
module.exports = { mount };
