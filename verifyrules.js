'use strict';
/**
 * ✅ VERIFICATION RULES — pure; shared by the portal (and the cloud edge) and the desktop's Verification Centre.
 *
 *   nameMatch     the name printed on the document the verifier holds vs the registry's record — a stolen matric
 *                 number used with someone else's name is caught here (titles, accents, order and initials tolerated)
 *   reportNo      the official reference of a verification report ("UBV-2026-7F3A2C")
 *   reportKey     the HMAC that makes a report link unguessable (no walking /verify/report/<id> to read records)
 *   share tokens  a graduate's own time-limited, revocable link to their verified record (only the token's hash
 *                 is stored, so a database copy cannot be turned into working links)
 *   parseBulk     a pasted / uploaded list for bulk verification (matric + optional name per line)
 *   suspicious    patterns worth a look: many not-found lookups from one organisation, one record checked by
 *                 many organisations in a day, repeated name mismatches
 */
const crypto = require('crypto');

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'engr', 'eng', 'chief', 'alhaji', 'alhaja', 'pastor', 'rev', 'sir', 'madam', 'mallam', 'hon']);
function tokens(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ').replace(/['-]/g, '').split(/\s+/).filter(t => t && !TITLES.has(t));
}
/** Edit distance where swapping two neighbouring letters ("Okonkow" for "Okonkwo") counts as ONE typo. */
function lev(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  const d = Array.from({ length: a.length + 1 }, (_, i) => { const r = new Array(b.length + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const close = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1) || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b));
/**
 * → { level: 'match' | 'partial' | 'mismatch' | 'unchecked', matched, of }. 'match' = every word of the shorter name is
 * found in the other (order-free; an initial matches its name; one typo tolerated in long words); 'partial' = at least
 * the surname-or-first-name and one more word agree; else 'mismatch'.
 */
function nameMatch(given, record) {
  const g = tokens(given), r = tokens(record);
  if (!g.length || !r.length) return { level: 'unchecked', matched: 0, of: 0 };
  const [short, long] = g.length <= r.length ? [g, r] : [r, g];
  const used = new Set(); let matched = 0;
  for (const t of short) { const i = long.findIndex((x, k) => !used.has(k) && close(t, x)); if (i >= 0) { used.add(i); matched++; } }
  const full = short.filter(t => t.length > 1).length;
  // a full match needs at least two real words (a surname alone, or initials, is only 'partial')
  const level = matched === short.length && full >= 2 ? 'match' : matched >= 2 || (short.length === 1 && matched === 1) ? 'partial' : 'mismatch';
  return { level, matched, of: short.length };
}

/** "UBV-2026-7F3A2C" — stable for a given verification id. */
function reportNo(id, iso) { return 'UBV-' + String(iso || new Date().toISOString()).slice(0, 4) + '-' + crypto.createHash('sha256').update('ubv|' + String(id)).digest('hex').slice(0, 6).toUpperCase(); }
function reportKey(id, secret) { return crypto.createHmac('sha256', Buffer.isBuffer(secret) ? secret : String(secret || '')).update('verify-report|' + String(id)).digest('base64url').slice(0, 22); }
function reportKeyOk(id, key, secret) {
  const a = Buffer.from(reportKey(id, secret)), b = Buffer.from(String(key || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 🔗 graduate share links
const SHARE_DAYS = [7, 30, 90];
function newShareToken() { const token = crypto.randomBytes(18).toString('base64url'); return { token, hash: shareHash(token) }; }
function shareHash(token) { return crypto.createHash('sha256').update('ub-share|' + String(token || '')).digest('hex'); }
function newShare({ studentId, label, days, now }) {
  const d = Number(days); if (!SHARE_DAYS.includes(d)) throw new Error('Choose how long the link works: 7, 30 or 90 days.');
  const at = now || new Date().toISOString(); const { token, hash } = newShareToken();
  return { token, row: { id: 'sh_' + hash.slice(0, 26), student_id: studentId, token_hash: hash, label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 80), expires_at: new Date(Date.parse(at) + d * 86400000).toISOString(),
    revoked: 0, views: 0, last_viewed_at: null, created_at: at, updated_at: at, deleted: 0 } };
}
/** Is this share row usable now? → null, or why not. */
function shareProblem(row, now) {
  if (!row || Number(row.deleted)) return 'This link does not exist.';
  if (Number(row.revoked)) return 'The graduate has withdrawn this link.';
  if (String(row.expires_at || '') <= String(now || new Date().toISOString())) return 'This link has expired — ask the graduate for a new one.';
  return null;
}

/** A pasted / uploaded list → [{ matric, name }] (comma, tab or semicolon separated; a header row is skipped). */
const BULK_MAX = 200;
function parseBulk(text) {
  const out = []; const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const cells = line.split(/[,;\t]/).map(c => c.trim().replace(/^"|"$/g, ''));
    if (/^(matric|matriculation|reg|registration|student)/i.test(cells[0]) && out.length === 0) continue;   // a header
    const matric = cells[0].slice(0, 60); if (!matric || seen.has(matric.toLowerCase())) continue;
    seen.add(matric.toLowerCase()); out.push({ matric, name: (cells[1] || '').slice(0, 120) });
    if (out.length > BULK_MAX) throw new Error('A bulk check takes at most ' + BULK_MAX + ' people at a time.');
  }
  if (!out.length) throw new Error('Paste one matric number per line (optionally followed by a comma and the name on the document).');
  return out;
}

/**
 * Patterns worth an officer's look, over the verification log (rows of verification_requests).
 * → [{ kind, who, count, detail }]
 */
function suspicious(rows, now) {
  const since = new Date((now ? Date.parse(now) : Date.now()) - 86400000).toISOString();
  const recent = (rows || []).filter(r => r && !Number(r.deleted) && String(r.created_at || '') >= since);
  const flags = [];
  const by = (key, pred) => { const m = new Map(); for (const r of recent.filter(pred)) { const k = key(r); if (!k) continue; m.set(k, (m.get(k) || 0) + 1); } return m; };
  for (const [who, n] of by(r => String(r.verifier_email || '').toLowerCase(), r => !Number(r.found))) if (n >= 10) flags.push({ kind: 'many_not_found', who, count: n, detail: n + ' lookups that matched nobody in 24 hours — someone may be guessing matric numbers.' });
  const orgsPerStudent = new Map();
  for (const r of recent.filter(r => r.student_id)) { const s = orgsPerStudent.get(r.student_id) || new Set(); s.add(String(r.verifier_email || '').toLowerCase()); orgsPerStudent.set(r.student_id, s); }
  for (const [sid, set] of orgsPerStudent) if (set.size >= 6) flags.push({ kind: 'many_orgs', who: sid, count: set.size, detail: 'One record checked by ' + set.size + ' different organisations in 24 hours.' });
  for (const [who, n] of by(r => String(r.verifier_email || '').toLowerCase(), r => r.name_match === 'mismatch')) if (n >= 3) flags.push({ kind: 'name_mismatch', who, count: n, detail: n + ' documents whose name did not match the record — possible forged identities.' });
  return flags;
}

module.exports = { tokens, nameMatch, reportNo, reportKey, reportKeyOk, SHARE_DAYS, newShareToken, shareHash, newShare, shareProblem, BULK_MAX, parseBulk, suspicious };
