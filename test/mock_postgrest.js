'use strict';
// Tiny in-process imitation of Supabase's PostgREST (/rest/v1) for tests: apikey auth, select with eq/in/gt/lt filters,
// order/limit/offset, upsert (POST + Prefer: resolution=merge-duplicates), delete with filters. Failure injection via .failing.
const express = require('express');
const PK = { lastping_kv: ['key'], lastping_socials: ['platform', 'handle'], lastping_polls: ['code'] };
const COLS = { lastping_kv: ['key', 'value', 'updated_at'], lastping_socials: ['platform', 'handle', 'data', 'updated_at'], lastping_polls: ['code', 'data', 'expires_at', 'updated_at'] };

function parseIn(v) { const m = /^\((.*)\)$/.exec(v); if (!m) return null; const out = []; let cur = '', inq = false, esc = false, quoted = false;
  for (const ch of m[1]) { if (esc) { cur += ch; esc = false; } else if (ch === '\\' && inq) esc = true; else if (ch === '"') { inq = !inq; quoted = true; }
    else if (ch === ',' && !inq) { out.push(cur); cur = ''; quoted = false; } else cur += ch; }
  if (cur || quoted) out.push(cur); return out; }
const cmp = (a, b) => { const da = Date.parse(a), db = Date.parse(b); if (typeof a === 'string' && /^\d{4}-/.test(a) && !isNaN(da) && !isNaN(db)) return da - db; return a < b ? -1 : a > b ? 1 : 0; };

function createMock({ key }) {
  const tables = Object.fromEntries(Object.keys(PK).map(t => [t, new Map()]));
  const app = express(), mock = { app, tables, log: [], failing: false, echoKeyInErrors: false };
  const pk = (t, r) => PK[t].map(c => String(r[c])).join('\u0000');
  function filters(t, q) { const fs = [];
    for (const [c, v] of Object.entries(q)) { if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(c)) continue;
      if (!COLS[t].includes(c)) throw Object.assign(new Error(`column ${t}.${c} does not exist`), { status: 400, code: '42703' });
      const i = String(v).indexOf('.'), op = String(v).slice(0, i), val = String(v).slice(i + 1);
      if (op === 'eq') fs.push(r => String(r[c]) === val);
      else if (op === 'in') { const vs = parseIn(val); if (!vs) throw Object.assign(new Error('bad in()'), { status: 400 }); fs.push(r => vs.includes(String(r[c]))); }
      else if (op === 'gt') fs.push(r => cmp(r[c], val) > 0); else if (op === 'lt') fs.push(r => cmp(r[c], val) < 0);
      else throw Object.assign(new Error('unsupported operator ' + op), { status: 400 }); }
    return fs; }
  app.use(express.json({ limit: '20mb' }));
  app.use('/rest/v1/:table', (req, res) => {
    const t = req.params.table, entry = { method: req.method, table: t, query: { ...req.query }, prefer: req.get('prefer') || '', auth: req.get('authorization') || null, body: req.body };
    mock.log.push(entry);
    if (req.get('apikey') !== key) return res.status(401).json({ message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });
    if (mock.failing) return res.status(503).json({ message: 'Service unavailable (mock)' + (mock.echoKeyInErrors ? ' key=' + req.get('apikey') : '') });
    if (!PK[t]) return res.status(404).json({ code: '42P01', message: `relation "public.${t}" does not exist` });
    try {
      const rows = tables[t];
      if (req.method === 'GET') { const fs = filters(t, req.query); let out = [...rows.values()].filter(r => fs.every(f => f(r)));
        if (req.query.order) { const ord = String(req.query.order).split(',').map(s => s.split('.')); out.sort((a, b) => { for (const [c, d] of ord) { const x = cmp(a[c], b[c]); if (x) return d === 'desc' ? -x : x; } return 0; }); }
        const off = Number(req.query.offset) || 0, lim = req.query.limit !== undefined ? Number(req.query.limit) : 1000; out = out.slice(off, off + Math.min(lim, 1000)); // Supabase max rows = 1000
        const sel = req.query.select && req.query.select !== '*' ? String(req.query.select).split(',') : COLS[t];
        return res.json(out.map(r => Object.fromEntries(sel.map(c => [c, r[c] ?? null])))); }
      if (req.method === 'POST') { const body = Array.isArray(req.body) ? req.body : [req.body], merge = /resolution=merge-duplicates/.test(entry.prefer);
        for (const r of body) { for (const c of Object.keys(r)) if (!COLS[t].includes(c)) throw Object.assign(new Error(`Could not find the '${c}' column`), { status: 400, code: 'PGRST204' });
          for (const c of PK[t]) if (r[c] == null) throw Object.assign(new Error('null value in ' + c), { status: 400, code: '23502' });
          const k = pk(t, r); if (rows.has(k) && !merge) throw Object.assign(new Error('duplicate key value violates unique constraint'), { status: 409, code: '23505' });
          rows.set(k, { updated_at: new Date().toISOString(), ...(rows.get(k) || {}), ...r }); }
        return /return=minimal/.test(entry.prefer) ? res.status(201).end() : res.status(201).json(body); }
      if (req.method === 'DELETE') { const fs = filters(t, req.query); if (!fs.length) throw Object.assign(new Error('DELETE requires a WHERE clause'), { status: 400, code: '21000' });
        for (const [k, r] of [...rows]) if (fs.every(f => f(r))) rows.delete(k); return res.status(204).end(); }
      res.status(405).json({ message: 'method not allowed' });
    } catch (e) { res.status(e.status || 500).json({ code: e.code, message: e.message }); }
  });
  mock.start = () => new Promise(r => { mock.server = app.listen(0, '127.0.0.1', () => { mock.url = `http://127.0.0.1:${mock.server.address().port}`; r(mock); }); });
  mock.stop = () => new Promise(r => mock.server.close(r));
  mock.rows = t => [...tables[t].values()];
  mock.count = (method, table) => mock.log.filter(e => e.method === method && e.table === table).length;
  return mock;
}
module.exports = { createMock, parseIn };
