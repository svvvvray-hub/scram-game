'use strict';
// Growth stats + brake settings, persisted to a JSON file with throttled writes. No personal data:
// players are counted by an anonymous random device id (hashed before storage).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const day = t => new Date(t).toISOString().slice(0, 10);
const hashId = s => crypto.createHash('sha256').update('lastping:' + s).digest('hex').slice(0, 16);

function createStats({ file, now = () => Date.now(), throttleMs = 5000, maxGames = 50 } = {}) {
  const blank = () => ({ v: 1, days: {}, devices: {}, refs: {}, playClicks: 0, shares: {}, totals: { games: 0, started: 0, players: 0, blocked: 0 },
    settings: { paused: false, maxGames, maxPerHour: 0 }, recentCreates: [] });
  let d = blank();
  if (file) try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); d = { ...blank(), ...j, totals: { ...blank().totals, ...j.totals }, settings: { ...blank().settings, ...j.settings } }; } catch {}
  let timer = null, dirty = false;
  function flush() { timer = null; if (!file || !dirty) return; dirty = false;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, file); } catch (e) { console.error('[stats] write failed', e.message); } }
  function touch() { dirty = true; if (!timer && file) { timer = setTimeout(flush, throttleMs); timer.unref?.(); } }
  const today = () => { const k = day(now()); return d.days[k] ||= { games: 0, started: 0, players: [], newPlayers: 0 }; };
  const refRow = r => d.refs[r] ||= { players: 0, games: 0, visits: 0 };
  function player(dev, ref) { // returns hashed id; counts unique/day and first-seen referrer
    if (!dev || typeof dev !== 'string') return null;
    const h = hashId(dev.slice(0, 64)), D = today();
    if (!D.players.includes(h)) D.players.push(h);
    if (!d.devices[h]) { d.devices[h] = { first: day(now()), ref: ref || null }; d.totals.players++; D.newPlayers++; if (ref) refRow(ref).players++; }
    touch(); return h;
  }
  return {
    data: () => d, flush,
    player,
    gameCreated(dev, ref) { const h = player(dev, ref); d.totals.games++; today().games++; const r = (h && d.devices[h].ref) || ref; if (r) refRow(r).games++; d.recentCreates.push(now()); touch(); },
    gameStarted() { d.totals.started++; today().started++; touch(); },
    visit(ref) { refRow(ref).visits++; touch(); },
    playClick() { d.playClicks++; touch(); },
    share(kind) { if (!/^[a-z]{2,16}$/.test(kind)) return false; d.shares[kind] = (d.shares[kind] || 0) + 1; touch(); return true; },
    // brake: returns null if a new game may be created, else a reason
    canCreate(live) { const s = d.settings, t = now(); d.recentCreates = d.recentCreates.filter(x => x > t - 3600e3);
      const why = s.paused ? 'paused' : (s.maxGames > 0 && live >= s.maxGames) ? 'max' : (s.maxPerHour > 0 && d.recentCreates.length >= s.maxPerHour) ? 'hourly' : null;
      if (why) { d.totals.blocked++; touch(); } return why; },
    setSettings(p) { const s = d.settings, n = (v, dv) => { v = Math.round(Number(v)); return Number.isFinite(v) && v >= 0 ? Math.min(v, 100000) : dv; };
      if ('paused' in p) s.paused = p.paused === true || p.paused === 'true' || p.paused === 'on' || p.paused === '1';
      if ('maxGames' in p) s.maxGames = n(p.maxGames, s.maxGames);
      if ('maxPerHour' in p) s.maxPerHour = n(p.maxPerHour, s.maxPerHour);
      touch(); flush(); return s; },
    summary(live) { const t = now(), days = [];
      for (let i = 29; i >= 0; i--) { const k = day(t - i * 864e5), D = d.days[k]; days.push({ day: k, games: D?.games || 0, started: D?.started || 0, players: D?.players.length || 0, newPlayers: D?.newPlayers || 0 }); }
      const refs = Object.entries(d.refs).map(([ref, r]) => ({ ref, ...r })).sort((a, b) => b.players - a.players || b.games - a.games || b.visits - a.visits).slice(0, 20);
      return { days, refs, totals: d.totals, playClicks: d.playClicks, shares: d.shares, settings: d.settings, live,
        lastHour: d.recentCreates.filter(x => x > t - 3600e3).length };
    },
  };
}
module.exports = { createStats, hashId };
