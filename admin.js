'use strict';
// Private growth dashboard + brake switch at /admin. Enabled only when ADMIN_KEY is set.
// Auth: ?key=<ADMIN_KEY> or the login form; both set an HttpOnly cookie holding an HMAC of the key (never the key itself).
const crypto = require('crypto');
const express = require('express');
const Socials = require('./public/socials');
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
    const sort = req.query.sort === 'games' ? 'games' : 'last', pf = Socials.isPlatform(req.query.platform) ? req.query.platform : '';
    res.type('html').send(page('Last Ping · growth', dashboard(stats.summary(liveCounts()), req.query.saved, stats.handleList(sort, pf || null), sort, pf, req.query.deleted)));
  });
  app.post('/admin/login', gate, form, (req, res) => {
    if (!authed(req)) return res.status(401).type('html').send(page('Admin login', login(true)));
    setCookie(req, res); res.redirect(303, '/admin');
  });
  app.post('/admin/logout', gate, (req, res) => { res.clearCookie(COOKIE, { path: '/admin' }); res.redirect(303, '/admin'); });
  app.get('/admin/stats.json', gate, (req, res) => { if (!authed(req)) return res.status(401).json({ error: 'unauthorized' }); res.json(stats.summary(liveCounts())); });
  const csv = (req, res) => {
    if (!authed(req)) return res.status(401).type('text').send('Unauthorized');
    const q = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const pf = Socials.isPlatform(req.query.platform) ? req.query.platform : null;
    const rows = stats.handleList(req.query.sort === 'games' ? 'games' : 'last', pf).map(h => [h.handle, h.platform, h.url, h.first, h.last, h.games, h.ref || ''].map(q).join(','));
    res.set('Content-Disposition', 'attachment; filename="lastping-socials.csv"').type('text/csv').send(['handle,platform,profile_url,first_seen,last_seen,games,ref', ...rows].join('\r\n') + '\r\n');
  };
  app.get('/admin/handles.csv', gate, csv); app.get('/admin/socials.csv', gate, csv);
  // removal requests: authenticated POST (cookie is SameSite=Strict; the dashboard asks for confirmation first)
  app.post('/admin/handles/delete', gate, form, json, (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
    const b = req.body || {}, ok = stats.deleteHandle(String(b.platform || ''), String(b.handle || ''));
    if (req.is('json')) return res.status(ok ? 200 : 404).json({ ok });
    res.redirect(303, '/admin?deleted=' + (ok ? '1' : '0') + '#handles');
  });
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

function dashboard(s, saved, handles = s.handles, sort = 'last', pf = '', deleted) {
  const c = (n, l) => `<div class="card"><div class="big">${esc(n)}</div><div class="lbl">${esc(l)}</div></div>`;
  const t = s.days[s.days.length - 1], st = s.settings;
  const refRows = s.refs.length ? s.refs.map(r => `<tr><td>@${esc(r.ref)}</td><td class="n">${r.players}</td><td class="n">${r.games}</td><td class="n">${r.visits}</td></tr>`).join('') : '<tr><td colspan="4" class="lbl">No ?ref traffic yet</td></tr>';
  const shares = Object.entries(s.shares); const shareRows = shares.length ? shares.map(([k, n]) => `<tr><td>${k === 'viral' ? 'Make it viral' : k === 'reel' ? 'Reel share' : esc(k)}</td><td class="n">${n}</td></tr>`).join('') : '<tr><td colspan="2" class="lbl">No shares yet</td></tr>';
  return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><div><h1>📡 Last Ping · growth</h1><p class="sub">Private dashboard · anonymous device ids · last 30 days</p></div>
<form method="post" action="/admin/logout"><button class="ghost">Sign out</button></form></div>
${saved ? '<div class="ok">✅ Brake settings saved</div>' : ''}${deleted === '1' ? '<div class="ok" id="deletedMsg">🗑️ Handle deleted</div>' : deleted === '0' ? '<div class="ok err" id="deletedMsg">Handle not found</div>' : ''}
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
<div class="card"><h2>Shares</h2><table><tr><th>Kind</th><th class="n">Count</th></tr>${shareRows}</table><p class="lbl">Counted when a player taps Share on a reel or "Make it viral" clip.</p></div></div>
<div class="card" id="handles"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2>📇 Players' socials <span class="pill off" id="handleCount">${s.handleCount}</span></h2>
<a href="/admin/socials.csv${pf ? '?platform=' + pf : ''}" download id="csvBtn"><button type="button">Download CSV</button></a></div>
<div class="row" id="platformCounts" style="margin:0 0 10px">${[['', 'All', s.handleCount], ...Socials.LIST.map(k => [k, Socials.label(k), (s.platformCounts || {})[k] || 0])].map(([k, l, n]) =>
  `<a href="/admin?${k ? 'platform=' + k + '&' : ''}sort=${sort}#handles" data-platform="${k}" class="pill ${pf === k ? 'on' : 'off'}" style="text-decoration:none;display:inline-flex;gap:5px;align-items:center">${k ? Socials.icon(k, 14) : ''}${esc(l)} <span class="pc">${n}</span></a>`).join(' ')}</div>
<form method="get" action="/admin" style="margin:0 0 10px"><input type="hidden" name="sort" value="${sort}"><label>Platform <select name="platform" id="platformFilter" onchange="this.form.submit()"><option value="">All</option>${Socials.LIST.map(k => `<option value="${k}"${pf === k ? ' selected' : ''}>${esc(Socials.label(k))}</option>`).join('')}</select></label> <noscript><button>Filter</button></noscript></form>
<table id="handleTable"><tr><th>Handle</th><th>Platform</th><th>First seen</th><th><a href="/admin?${pf ? 'platform=' + pf + '&' : ''}sort=last#handles" style="color:${sort === 'last' ? '#fff' : '#9ca3af'}" id="sortLast">Last seen${sort === 'last' ? ' ▼' : ''}</a></th><th class="n"><a href="/admin?${pf ? 'platform=' + pf + '&' : ''}sort=games#handles" style="color:${sort === 'games' ? '#fff' : '#9ca3af'}" id="sortGames">Games${sort === 'games' ? ' ▼' : ''}</a></th><th>Ref</th><th></th></tr>
${handles.length ? handles.map(h => `<tr data-platform="${esc(h.platform)}"><td><a href="${esc(Socials.url(h))}" target="_blank" rel="noopener noreferrer" style="color:#93c5fd">@${esc(h.handle)}</a></td><td style="white-space:nowrap">${Socials.icon(h.platform, 16)} ${esc(Socials.label(h.platform))}</td><td>${esc(h.first.slice(0, 16).replace('T', ' '))}</td><td>${esc(h.last.slice(0, 16).replace('T', ' '))}</td><td class="n">${h.games}</td><td>${h.ref ? '@' + esc(h.ref) : '<span class="lbl">—</span>'}</td>
<td><form method="post" action="/admin/handles/delete" class="del" style="margin:0" onsubmit="return confirm('Delete @' + this.handle.value + ' (' + this.dataset.label + ')? This cannot be undone.')" data-label="${esc(Socials.label(h.platform))}"><input type="hidden" name="platform" value="${esc(h.platform)}"><input type="hidden" name="handle" value="${esc(h.handle)}"><button class="ghost delBtn" title="Delete (removal request)">🗑️ Delete</button></form></td></tr>`).join('') : `<tr><td colspan="7" class="lbl">No handles${pf ? ' on ' + esc(Socials.label(pf)) : ''} yet</td></tr>`}</table>
<p class="lbl">Only players who typed a social handle. Delete removes a handle on request. Times in UTC.</p></div>`;
}
module.exports = { mount };
