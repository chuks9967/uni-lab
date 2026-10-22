'use strict';
/**
 * 🧊 THE CLOUD PORTAL'S START-UP COPY — why the Supabase project ran out of quota: every time Supabase starts a fresh
 * copy of the portal function (a "cold start", which happens often), it re-read the WHOLE database over the REST API,
 * and every byte of that counts as egress. A ~50 MB store × dozens of cold starts a day exhausts a 5 GB plan.
 *
 * Instead the portal keeps an encrypted, compressed copy of its in-memory store in Cloudflare R2 (no egress charges),
 * starts from it, and asks the database ONLY for rows changed since the copy's exact cursor. The copy is refreshed
 * every half hour by a warm worker. It is a cache, never the source of truth: wrong key, damaged file, another
 * scale setting or a copy older than a week → ignored, and the portal falls back to reading the database once.
 *
 *   format  "UBSNAP1" | iv(12) | tag(16) | AES-256-GCM( gzip(JSON { v, at, cursor, scale, n, rows:[[entity,id,updated_at,row]…] }) )
 *   key     sha256("ub-edge-snapshot|" + the portal's secret) — the copy is unreadable without the portal's own secret
 */
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = Buffer.from('UBSNAP1', 'latin1');
const MAX_AGE_MS = 7 * 86400000;
const REFRESH_MS = 30 * 60 * 1000;
const KEY = 'edge/portal-snapshot-v1.bin';

const keyOf = (secret) => crypto.createHash('sha256').update('ub-edge-snapshot|' + String(secret || '')).digest();

/** records = { "entity:id": { entity, id, row, updated_at } } → encrypted bytes */
function pack(records, cursor, { secret, scale } = {}) {
  const rows = [];
  for (const k of Object.keys(records || {})) { const r = records[k]; if (r && r.entity && r.row) rows.push([r.entity, r.id, r.updated_at || '', r.row]); }
  const json = Buffer.from(JSON.stringify({ v: 1, at: new Date().toISOString(), cursor: String(cursor || ''), scale: scale ? 1 : 0, n: rows.length, rows }), 'utf8');
  const gz = zlib.gzipSync(json, { level: 6 });
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const enc = Buffer.concat([c.update(gz), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
}
/** bytes → { at, cursor, n, records } — throws on anything not trustworthy */
function unpack(buf, { secret, scale, now } = {}) {
  const b = Buffer.from(buf || []);
  if (b.length < MAGIC.length + 28 || !b.slice(0, MAGIC.length).equals(MAGIC)) throw new Error('not a portal snapshot');
  const iv = b.slice(7, 19), tag = b.slice(19, 35), enc = b.slice(35);
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(secret), iv); d.setAuthTag(tag);
  const j = JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(enc), d.final()])).toString('utf8'));
  if (!j || j.v !== 1 || !j.cursor || !Array.isArray(j.rows)) throw new Error('damaged snapshot');
  if ((j.scale ? 1 : 0) !== (scale ? 1 : 0)) throw new Error('snapshot taken under another scale setting');
  if ((now || Date.now()) - Date.parse(j.at) > MAX_AGE_MS) throw new Error('snapshot too old');
  const records = {};
  for (const [entity, id, updated_at, row] of j.rows) records[entity + ':' + id] = { entity, id, row, updated_at };
  return { at: j.at, cursor: j.cursor, n: j.n, records };
}
/** Should a warm worker write a fresh copy now? */
function due(lastAt, now) { return !lastAt || (now || Date.now()) - lastAt > REFRESH_MS; }

module.exports = { MAGIC, KEY, MAX_AGE_MS, REFRESH_MS, pack, unpack, due };
