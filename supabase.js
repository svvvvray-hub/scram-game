'use strict';
// Supabase persistence for stats / brake settings / players' socials / polls, over Supabase's PostgREST REST API
// (Data API) with plain fetch: no SDK, no new npm dependencies. Server-only: SUPABASE_SERVICE_KEY never leaves this module
// (it is only put in the `apikey` request header to SUPABASE_URL and is never logged or sent to clients).
//
// Tables (see supabase/schema.sql):
//   lastping_kv      key 'stats' (counters blob) and 'settings' (brake switch)
//   lastping_socials one row per (platform, handle) -> admin deletes are real row deletes
//   lastping_polls   one row per poll code, expires_at for server-side cleanup / on-demand lookups
//   lastping_feedback one row per post-round feedback (v18), admin delete = real row delete
//
// Flow: start() loads everything (retrying with backoff); afterwards every stats.touch() schedules a throttled save
// (default 5 s) that upserts only rows whose JSON changed since the last successful save and deletes rows that are gone
// (expired polls, deleted handles). Failures are logged, retried with exponential backoff, and the app keeps serving from memory.
const KV = 'lastping_kv', SOC = 'lastping_socials', POLLS = 'lastping_polls', FB = 'lastping_feedback', NT = 'lastping_notify';
const PAGE = 1000, CHUNK = 500;
const iso = ms => new Date(ms).toISOString();
const q = v => '"' + String(v).replace(/["\\]/g, '\\$&') + '"'; // PostgREST quoted value for in.(...)

class SupabaseError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

function createSupabaseStore({ url, key, fetch: f = globalThis.fetch, throttleMs = 5000, now = () => Date.now(), log = console,
  timeoutMs = 8000, pollTimeoutMs = 3000, backoffMs = 1000, maxBackoffMs = 60000, cleanupMs = 3600e3 } = {}) {
  if (!url || !key) throw new Error('createSupabaseStore: url and key are required');
  const base = String(url).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '') + '/rest/v1/';
  let host = ''; try { host = new URL(base).host; } catch {}
  // New sb_secret_... keys go in the apikey header only (they are not JWTs); legacy service_role JWTs (eyJ...) also need Authorization.
  const headers = { apikey: key, 'content-type': 'application/json', accept: 'application/json', ...(/^eyJ/.test(key) ? { authorization: 'Bearer ' + key } : {}) };
  let stats = null, loaded = false, closed = false;
  let timer = null, saving = null, again = false, failures = 0, loadFailures = 0, nextRetryAt = 0;
  let lastSaveAt = 0, lastLoadAt = 0, lastError = null, lastErrorAt = 0, lastOkAt = 0, cleanupTimer = null;
  const snap = { kv: new Map(), soc: new Map(), polls: new Map(), fb: new Map(), nt: new Map() }; // last successfully saved JSON per row
  const tomb = new Set(); // socials deleted by the admin: deleted remotely even if not in the snapshot (e.g. before load finished)
  const misses = new Map(); // code -> time of a recent "not found" (on-demand poll lookups)

  async function rest(method, path, { body, prefer, timeout = timeoutMs } = {}) {
    let r;
    try { r = await f(base + path, { method, headers: { ...headers, ...(prefer ? { prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); }
    catch (e) { throw new SupabaseError(`${method} ${path.split('?')[0]}: ${e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.message)}`, 0); }
    const text = await r.text().catch(() => '');
    if (!r.ok) { let m = text.slice(0, 200); try { const j = JSON.parse(text); m = [j.code, j.message, j.hint].filter(Boolean).join(' '); } catch {}
      throw new SupabaseError(`${method} ${path.split('?')[0]}: HTTP ${r.status} ${m}`.trim(), r.status); }
    lastOkAt = now();
    if (!text) return null; try { return JSON.parse(text); } catch { return null; }
  }
  const fail = (what, e) => { lastError = String(e.message || e).split(key).join('***'); lastErrorAt = now(); log.error?.(`[supabase] ${what} failed: ${lastError}`); };
  const backoff = n => Math.min(maxBackoffMs, backoffMs * 2 ** Math.max(0, n - 1));

  async function selectAll(table, select, filter = '', order) {
    const out = [];
    for (let off = 0; ; off += PAGE) { const rows = await rest('GET', `${table}?select=${select}${filter}&order=${order}&limit=${PAGE}&offset=${off}`) || [];
      out.push(...rows); if (rows.length < PAGE) return out; }
  }
  async function load() {
    const t = now();
    const [kv, socials, polls, fbs, nts] = await Promise.all([selectAll(KV, 'key,value', '', 'key.asc'), selectAll(SOC, 'platform,handle,data', '', 'platform.asc,handle.asc'),
      selectAll(POLLS, 'code,data', `&expires_at=gt.${encodeURIComponent(iso(t))}`, 'code.asc'), selectAll(FB, 'id,data', '', 'id.asc'), selectAll(NT, 'id,data', '', 'id.asc')]);
    const remote = { kv: {}, handles: {}, polls: {}, feedback: {}, notify: {} };
    for (const r of nts) if (r && r.data && r.data.id === r.id) remote.notify[r.id] = r.data;
    for (const r of fbs) if (r && r.data && r.data.id === r.id) remote.feedback[r.id] = r.data;
    for (const r of kv) remote.kv[r.key] = r.value;
    for (const r of socials) if (r && r.data && typeof r.data === 'object') remote.handles[r.platform + ':' + r.handle] = r.data;
    for (const r of polls) if (r && r.data && r.data.code === r.code) remote.polls[r.code] = r.data;
    snap.kv.clear(); snap.soc.clear(); snap.polls.clear(); snap.fb.clear(); snap.nt.clear();
    for (const [k, v] of Object.entries(remote.notify)) snap.nt.set(k, JSON.stringify(v));
    for (const [k, v] of Object.entries(remote.feedback)) snap.fb.set(k, JSON.stringify(v));
    for (const [k, v] of Object.entries(remote.kv)) snap.kv.set(k, JSON.stringify(v));
    for (const [k, v] of Object.entries(remote.handles)) snap.soc.set(k, JSON.stringify(v));
    for (const [k, v] of Object.entries(remote.polls)) snap.polls.set(k, JSON.stringify(v));
    stats.adopt(remote, { skipHandles: tomb });
    loaded = true; lastLoadAt = now(); loadFailures = 0;
    log.log?.(`[supabase] loaded ${Object.keys(remote.handles).length} socials, ${Object.keys(remote.polls).length} polls, stats ${remote.kv.stats ? 'yes' : 'none yet'} from ${host}`);
    cleanup().catch(() => {});
    schedule(0); // push anything changed locally before / during the load (and the merged blobs)
  }
  async function cleanup() { if (closed) return; await rest('DELETE', `${POLLS}?expires_at=lt.${encodeURIComponent(iso(now()))}`, { prefer: 'return=minimal' }).catch(e => fail('expired-poll cleanup', e)); }

  // start(): try to load; resolves after the first success or after waitMs (then keeps retrying in the background)
  function start({ waitMs = 10000 } = {}) {
    let done; const ready = new Promise(r => done = r);
    const attempt = async () => { if (closed || loaded) return done(loaded);
      try { await load(); done(true); }
      catch (e) { loadFailures++; fail(`load (attempt ${loadFailures})`, e); const d = backoff(loadFailures); nextRetryAt = now() + d;
        const tm = setTimeout(attempt, d); tm.unref?.(); } };
    attempt();
    const cap = setTimeout(() => done(false), waitMs); cap.unref?.();
    cleanupTimer = setInterval(() => { if (loaded) cleanup(); }, cleanupMs); cleanupTimer.unref?.();
    return ready.finally(() => clearTimeout(cap));
  }

  function rowsToSave() {
    const d = stats.data(), out = { kv: [], socUp: [], socDel: [], pollUp: [], pollDel: [], fbUp: [], fbDel: [], ntUp: [], ntDel: [] };
    const { handles, polls, settings, feedback, notify, ...rest } = d;
    for (const [k, r] of Object.entries(notify || {})) { const j = JSON.stringify(r); if (snap.nt.get(k) !== j) out.ntUp.push({ k, j, at: r.first || r.at }); }
    for (const k of snap.nt.keys()) if (!notify || !Object.prototype.hasOwnProperty.call(notify, k)) out.ntDel.push(k);
    for (const [k, r] of Object.entries(feedback || {})) { const j = JSON.stringify(r); if (snap.fb.get(k) !== j) out.fbUp.push({ k, j, at: r.at }); }
    for (const k of snap.fb.keys()) if (!feedback || !Object.prototype.hasOwnProperty.call(feedback, k)) out.fbDel.push(k);
    for (const [k, v] of [['stats', rest], ['settings', settings]]) { const j = JSON.stringify(v); if (snap.kv.get(k) !== j) out.kv.push({ k, j }); }
    for (const [k, r] of Object.entries(handles || {})) { const j = JSON.stringify(r); if (snap.soc.get(k) !== j) out.socUp.push({ k, j }); }
    for (const k of new Set([...snap.soc.keys(), ...tomb])) if (!handles || !Object.prototype.hasOwnProperty.call(handles, k)) out.socDel.push(k);
    for (const [k, p] of Object.entries(polls || {})) { if (!p) continue; const j = JSON.stringify(p); if (snap.polls.get(k) !== j) out.pollUp.push({ k, j, exp: p.expiresAt }); }
    for (const k of snap.polls.keys()) if (!polls || !polls[k]) out.pollDel.push(k);
    return out;
  }
  const split = (k) => { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; };
  const chunks = (a, n = CHUNK) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  const UPSERT = 'resolution=merge-duplicates,return=minimal';
  async function saveOnce() {
    const w = rowsToSave(), at = iso(now());
    if (w.kv.length) { await rest('POST', KV, { prefer: UPSERT, body: w.kv.map(r => ({ key: r.k, value: JSON.parse(r.j), updated_at: at })) }); for (const r of w.kv) snap.kv.set(r.k, r.j); }
    for (const c of chunks(w.socUp)) { await rest('POST', SOC, { prefer: UPSERT, body: c.map(r => { const [platform, handle] = split(r.k); return { platform, handle, data: JSON.parse(r.j), updated_at: at }; }) }); for (const r of c) snap.soc.set(r.k, r.j); }
    const byPlat = {}; for (const k of w.socDel) { const [p, h] = split(k); (byPlat[p] ||= []).push(h); }
    for (const [p, hs] of Object.entries(byPlat)) for (const c of chunks(hs, 100)) {
      await rest('DELETE', `${SOC}?platform=eq.${encodeURIComponent(p)}&handle=in.(${encodeURIComponent(c.map(q).join(','))})`, { prefer: 'return=minimal' });
      for (const h of c) { snap.soc.delete(p + ':' + h); tomb.delete(p + ':' + h); } }
    for (const c of chunks(w.pollUp)) { await rest('POST', POLLS, { prefer: UPSERT, body: c.map(r => ({ code: r.k, data: JSON.parse(r.j), expires_at: iso(r.exp), updated_at: at })) }); for (const r of c) snap.polls.set(r.k, r.j); }
    for (const c of chunks(w.pollDel, 100)) { await rest('DELETE', `${POLLS}?code=in.(${encodeURIComponent(c.map(q).join(','))})`, { prefer: 'return=minimal' }); for (const k of c) snap.polls.delete(k); }
    for (const c of chunks(w.fbUp)) { await rest('POST', FB, { prefer: UPSERT, body: c.map(r => ({ id: r.k, data: JSON.parse(r.j), created_at: r.at, updated_at: at })) }); for (const r of c) snap.fb.set(r.k, r.j); }
    for (const c of chunks(w.fbDel, 100)) { await rest('DELETE', `${FB}?id=in.(${encodeURIComponent(c.map(q).join(','))})`, { prefer: 'return=minimal' }); for (const k of c) snap.fb.delete(k); }
    for (const c of chunks(w.ntUp)) { await rest('POST', NT, { prefer: UPSERT, body: c.map(r => ({ id: r.k, data: JSON.parse(r.j), created_at: r.at, updated_at: at })) }); for (const r of c) snap.nt.set(r.k, r.j); }
    for (const c of chunks(w.ntDel, 100)) { await rest('DELETE', `${NT}?id=in.(${encodeURIComponent(c.map(q).join(','))})`, { prefer: 'return=minimal' }); for (const k of c) snap.nt.delete(k); }
    return w.ntUp.length + w.ntDel.length + w.fbUp.length + w.fbDel.length + w.kv.length + w.socUp.length + w.socDel.length + w.pollUp.length + w.pollDel.length;
  }
  function run() {
    timer = null;
    if (!loaded) return Promise.resolve(false); // never overwrite remote data before it was loaded (the load loop calls schedule when done)
    if (saving) { again = true; return saving; }
    saving = (async () => {
      try { const n = await saveOnce(); failures = 0; nextRetryAt = 0; if (n) lastSaveAt = now(); return true; }
      catch (e) { failures++; fail(`save (attempt ${failures})`, e); const d = backoff(failures); nextRetryAt = now() + d;
        clearTimeout(timer); timer = setTimeout(run, d); timer.unref?.(); return false; }
      finally { saving = null; if (again) { again = false; schedule(); } }
    })();
    return saving;
  }
  function schedule(ms = throttleMs) { if (closed || timer || !loaded) return; if (saving) { again = true; return; } timer = setTimeout(run, ms); timer.unref?.(); }
  async function flush() { clearTimeout(timer); timer = null; if (saving) { again = false; await saving; } return run(); }

  async function fetchPoll(code) {
    if (closed) return null; const t = now(), m = misses.get(code); if (m && t - m < 30000) return null;
    if (lastErrorAt && lastErrorAt > lastOkAt && t - lastErrorAt < 10000) return null; // Supabase is failing right now: don't stall requests
    try { const rows = await rest('GET', `${POLLS}?select=code,data&code=eq.${encodeURIComponent(code)}&expires_at=gt.${encodeURIComponent(iso(t))}&limit=1`, { timeout: pollTimeoutMs });
      const p = rows && rows[0] && rows[0].data; if (!p || p.code !== code) { if (misses.size > 2000) misses.clear(); misses.set(code, t); return null; }
      snap.polls.set(code, JSON.stringify(p)); misses.delete(code); return p; }
    catch (e) { fail(`poll ${code} lookup`, e); return null; }
  }
  return {
    kind: 'supabase',
    attach(s) { stats = s; },
    start, schedule, flush, fetchPoll, cleanup,
    forgetHandle(k) { tomb.add(k); },
    get loaded() { return loaded; },
    // final flush (SIGTERM): if the remote data never loaded, try one last load (merging local activity) so it isn't lost
    async close() { if (closed) return; if (!loaded) await load().catch(e => fail('final load', e)); const r = await flush().catch(() => false); closed = true; clearTimeout(timer); clearInterval(cleanupTimer); return r; },
    status() { const t = now(), ok = loaded && !failures && !(lastErrorAt > lastOkAt);
      return { mode: 'supabase', host, loaded, connected: ok, lastSaveAt: lastSaveAt || null, lastLoadAt: lastLoadAt || null, lastError: ok ? null : lastError,
        lastErrorAt: lastErrorAt || null, failures: Math.max(failures, loadFailures), retryInMs: nextRetryAt > t ? nextRetryAt - t : 0, pending: !!timer || !!saving }; },
  };
}
module.exports = { createSupabaseStore, SupabaseError };
