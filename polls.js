'use strict';
// "Plan the next game" polls (whenisgood-style): 2-8 time options (UTC ms) x 1-3 places, no sign-up voting
// (name + optional handle), live tally, best combination, creator-only lock, .ics export.
// Polls live in memory in stats.data().polls and are persisted by the stats store: Supabase (one row per poll in
// lastping_polls, fetched on demand by ensure() if not in memory) or, without Supabase, the STATS_FILE JSON.
// Expire 14 days after the latest option (swept hourly / on access; expired rows are deleted remotely too).
const crypto = require('crypto');
const Socials = require('./public/socials');

const LIMITS = { minTimes: 2, maxTimes: 8, minPlaces: 1, maxPlaces: 3, maxVoters: 30, maxActive: 200, nameLen: 20, labelLen: 40,
  expireMs: 14 * 864e5, maxAheadMs: 180 * 864e5, pastSlackMs: 3600e3, eventMs: 3600e3, perIpHour: 20 };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const sha = s => crypto.createHash('sha256').update('lastping-poll:' + s).digest('hex');
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// strip control / bidi-override chars, collapse whitespace, trim, cap length (output is always escaped by the clients/admin)
const clean = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '';
const vote = v => (v === 2 || v === 'y' || v === 'yes') ? 2 : (v === 1 || v === 'm' || v === 'maybe') ? 1 : 0;

class PollError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

function createPolls({ stats, now = () => Date.now(), limits = {} } = {}) {
  const LIM = { ...LIMITS, ...limits };
  const store = () => { const d = stats.data(); d.polls ||= {}; d.pollTotals ||= { created: 0, votes: 0, locked: 0 }; return d; };
  const all = () => store().polls;
  const ipHits = new Map();
  function sweep() { const P = all(), t = now(); let n = 0; for (const [c, p] of Object.entries(P)) if (!p || p.expiresAt <= t) { delete P[c]; n++; } if (n) stats.touch?.(); return n; }
  const activeCount = () => { sweep(); return Object.keys(all()).length; };
  const get = code => { const c = String(code || '').toUpperCase(); if (!CODE_RE.test(c)) return null; const p = all()[c]; if (!p) return null; if (p.expiresAt <= now()) { delete all()[c]; stats.touch?.(); return null; } return p; };
  function makeCode() { let c; do c = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); while (all()[c]); return c; }

  function parseTimes(arr) {
    if (!Array.isArray(arr)) throw new PollError('Pick 2-8 times');
    const t = now(), out = [];
    for (const v of arr.slice(0, 50)) { const ms = typeof v === 'number' ? v : typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN;
      if (!Number.isFinite(ms)) throw new PollError('Invalid time');
      if (ms < t - LIM.pastSlackMs) throw new PollError('Times must be in the future');
      if (ms > t + LIM.maxAheadMs) throw new PollError('Times must be within 180 days');
      const r = Math.round(ms / 60000) * 60000; if (!out.includes(r)) out.push(r); }
    if (out.length < LIM.minTimes || out.length > LIM.maxTimes) throw new PollError(`Pick ${LIM.minTimes}-${LIM.maxTimes} times`);
    return out.sort((a, b) => a - b);
  }
  function parsePlaces(arr) {
    if (!Array.isArray(arr) || arr.length < LIM.minPlaces || arr.length > LIM.maxPlaces) throw new PollError(`Pick ${LIM.minPlaces}-${LIM.maxPlaces} places`);
    return arr.map(p => { const lat = Number(p?.lat), lng = Number(p?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new PollError('Invalid place');
      return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, label: clean(p.label, LIM.labelLen) }; });
  }
  function rateOk(ip) { if (!ip) return true; const t = now(), h = (ipHits.get(ip) || []).filter(x => x > t - 3600e3); if (h.length >= LIM.perIpHour) { ipHits.set(ip, h); return false; } h.push(t); ipHits.set(ip, h); if (ipHits.size > 5000) ipHits.clear(); return true; }

  function create(body = {}, { ip } = {}) {
    const times = parseTimes(body.times), places = parsePlaces(body.places);
    if (activeCount() >= LIM.maxActive) throw new PollError('Too many active polls right now. Try again later.', 503);
    if (!rateOk(ip)) throw new PollError('Too many polls from this network. Try again later.', 429);
    const D = store(), code = makeCode(), token = crypto.randomBytes(18).toString('base64url'), t = now();
    D.polls[code] = { code, tok: sha(token), by: clean(body.name, LIM.nameLen), bySocial: Socials.norm(body.social) || null, lobby: /^[A-Z2-9]{5}$/.test(String(body.lobby || '')) ? body.lobby : null,
      createdAt: t, times, places, voters: [], locked: null, expiresAt: Math.max(...times) + LIM.expireMs };
    D.pollTotals.created++; stats.touch?.();
    return { code, token, poll: view(D.polls[code]) };
  }
  function castVote(code, body = {}) {
    const p = get(code); if (!p) throw new PollError('Poll not found', 404);
    if (p.locked) throw new PollError('This poll is locked', 409);
    const vid = typeof body.voter === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.voter) ? sha('v:' + body.voter) : null;
    if (!vid) throw new PollError('Missing voter id');
    const name = clean(body.name, LIM.nameLen); if (!name) throw new PollError('Add your name');
    const t = Array.isArray(body.t) ? p.times.map((_, i) => vote(body.t[i])) : null, pl = Array.isArray(body.p) ? p.places.map((_, i) => vote(body.p[i])) : null;
    if (!t || !pl) throw new PollError('Invalid vote');
    let v = p.voters.find(x => x.id === vid);
    if (!v) { if (p.voters.length >= LIM.maxVoters) throw new PollError(`This poll is full (${LIM.maxVoters} voters max)`, 409); v = { id: vid }; p.voters.push(v); store().pollTotals.votes++; }
    Object.assign(v, { name, social: Socials.norm(body.social) || null, t, p: pl, at: now() });
    stats.touch?.(); return view(p);
  }
  function lock(code, body = {}) {
    const p = get(code); if (!p) throw new PollError('Poll not found', 404);
    if (!safeEq(sha(String(body.token || '')), p.tok)) throw new PollError('Only the poll creator can lock it', 403);
    if (body.unlock) { p.locked = null; stats.touch?.(); return view(p); }
    const ti = Number(body.time), pi = Number(body.place);
    if (!Number.isInteger(ti) || ti < 0 || ti >= p.times.length || !Number.isInteger(pi) || pi < 0 || pi >= p.places.length) throw new PollError('Pick a time and a place');
    if (!p.locked) store().pollTotals.locked++;
    p.locked = { time: ti, place: pi, at: now() }; stats.touch?.(); return view(p);
  }
  const isCreator = (code, token) => { const p = get(code); return !!p && safeEq(sha(String(token || '')), p.tok); };

  // best combination: most voters with YES for both the time and the place, then most "works" (yes or maybe for both), then earliest, then place order
  function tally(p) {
    const times = p.times.map((_, i) => ({ yes: p.voters.filter(v => v.t[i] === 2).length, maybe: p.voters.filter(v => v.t[i] === 1).length }));
    const places = p.places.map((_, j) => ({ yes: p.voters.filter(v => v.p[j] === 2).length, maybe: p.voters.filter(v => v.p[j] === 1).length }));
    const combos = p.times.map((_, i) => p.places.map((_, j) => { let yes = 0, maybe = 0; for (const v of p.voters) { const m = Math.min(v.t[i], v.p[j]); if (m === 2) yes++; else if (m === 1) maybe++; } return { yes, maybe }; }));
    let best = null;
    p.times.forEach((_, i) => p.places.forEach((_, j) => { const c = combos[i][j];
      if (!best || c.yes > best.yes || (c.yes === best.yes && (c.maybe > best.maybe || (c.maybe === best.maybe && (p.times[i] < p.times[best.time] || (p.times[i] === p.times[best.time] && j < best.place)))))) best = { time: i, place: j, ...c }; }));
    return { timeTally: times, placeTally: places, combos, best };
  }
  const view = p => ({ code: p.code, by: p.by, bySocial: p.bySocial, createdAt: p.createdAt, times: p.times, places: p.places, expiresAt: p.expiresAt, locked: p.locked,
    voters: p.voters.map(v => ({ name: v.name, social: v.social, t: v.t, p: v.p, at: v.at })), max: LIM.maxVoters, ...tally(p) });
  const mine = (p, voter) => { if (typeof voter !== 'string' || !voter) return null; const id = sha('v:' + voter), v = p.voters.find(x => x.id === id); return v ? { name: v.name, social: v.social, t: v.t, p: v.p } : null; };
  function summary(limit = 15) { sweep(); const P = Object.values(all()).sort((a, b) => b.createdAt - a.createdAt), T = store().pollTotals;
    return { active: P.length, created: T.created, votes: T.votes, locked: T.locked, voters: P.reduce((s, p) => s + p.voters.length, 0), max: LIM.maxActive,
      recent: P.slice(0, limit).map(p => ({ code: p.code, by: p.by, createdAt: p.createdAt, times: p.times.length, places: p.places.length, voters: p.voters.length, locked: !!p.locked, expiresAt: p.expiresAt, first: p.times[0] })) }; }
  // Make sure a poll is in memory: if not, look it up in the remote store (Supabase) once. Resolves to true if it exists.
  async function ensure(code) { const c = String(code || '').toUpperCase(); if (!CODE_RE.test(c)) return false; if (get(c)) return true;
    if (!stats.fetchPoll) return false;
    const p = await stats.fetchPoll(c).catch(() => null);
    if (p && p.code === c && Number(p.expiresAt) > now() && Array.isArray(p.times) && Array.isArray(p.places) && Array.isArray(p.voters) && !all()[c]) all()[c] = p;
    return !!get(c); }
  return { create, vote: castVote, ensure, lock, get, view: code => { const p = get(code); return p && view(p); }, mine: (code, voter) => { const p = get(code); return p && mine(p, voter); },
    isCreator, sweep, summary, activeCount, tally, LIMITS: LIM };
}

// ---- iCalendar (RFC 5545): CRLF line ends, escaped text, lines folded at 75 octets ----
const icsEsc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function fold(line) { const b = Buffer.from(line, 'utf8'); if (b.length <= 75) return line; const out = []; let cur = '', len = 0, first = true;
  for (const ch of line) { const n = Buffer.byteLength(ch); if (len + n > (first ? 75 : 74)) { out.push(cur); cur = ''; len = 0; first = false; } cur += ch; len += n; }
  out.push(cur); return out.join('\r\n '); }
const placeName = pl => pl.label || `${pl.lat.toFixed(5)}, ${pl.lng.toFixed(5)}`;
function ics(poll, { url = '', now = Date.now(), eventMs = LIMITS.eventMs } = {}) {
  const L = poll.locked; if (!L) return null;
  const start = poll.times[L.time], pl = poll.places[L.place];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Last Ping//Plan the next game//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${poll.code}-${start}@lastping`, `DTSTAMP:${icsDate(now)}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(start + eventMs)}`,
    `SUMMARY:${icsEsc('Last Ping 🏃 GPS hide & seek')}`, `LOCATION:${icsEsc(placeName(pl))}`, `GEO:${pl.lat};${pl.lng}`,
    `DESCRIPTION:${icsEsc(`Next round of Last Ping${poll.by ? ' (planned by ' + poll.by + ')' : ''}.\nMap: https://www.google.com/maps/search/?api=1&query=${pl.lat},${pl.lng}${url ? '\nPoll: ' + url : ''}`)}`,
    ...(url ? [`URL:${url}`] : []), 'END:VEVENT', 'END:VCALENDAR'];
  return lines.map(fold).join('\r\n') + '\r\n';
}
module.exports = { createPolls, ics, PollError, LIMITS, CODE_RE, clean, placeName };
