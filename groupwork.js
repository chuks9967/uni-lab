'use strict';
/**
 * 👥 GROUP PROJECTS + PEER ASSESSMENT — ONE pure module (desk · portal · edge).
 *
 * 🐛 THE HOLE THIS FILLS: coursework was strictly individual. A group project had to be handed in by every member
 * separately (or by one, leaving the others "not submitted"), marked many times, and everyone got the same mark —
 * the student who did nothing and the one who did everything alike.
 *
 * WHAT IT DOES
 *  • policy        — an assignment can be group work: students per group (2–8), how much of the mark the peer assessment
 *                    may move (0–100%), how many days after the deadline teammates may rate each other, self-rating on/off.
 *  • formGroups    — balanced groups from the class (seeded, so the same class gives the same groups), or from lines of
 *                    matric numbers the lecturer types (every student in at most one group).
 *  • one hand-in   — any member hands in for the group; the lecturer marks the group ONCE.
 *  • WebPA         — each member scores every member (1–5); each rater's scores are normalised to share 1, so a generous
 *                    rater counts the same as a strict one; a member's factor = the shares received × (members ÷ raters).
 *                    individual = group mark × ((1 − w) + w × factor), never above the maximum, never below 0.
 *                    Nobody sees another student's ratings — only their own factor once marked.
 */
const crypto = require('crypto');
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const r3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;
const pj = (s, d) => { if (s && typeof s === 'object') return s; try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n || 300); // eslint-disable-line no-control-regex

/** { size 2–8, peer_weight 0–100 (% of the mark the peers may move), peer_days 0–21, self (rate yourself too) } | null = individual work */
function normalizePolicy(input) {
  const x = pj(input, null); if (!x) return null;
  const size = Math.round(Number(x.size) || 0); if (size < 2) return null;
  return { size: Math.min(8, size), peer_weight: Math.max(0, Math.min(100, Math.round(Number(x.peer_weight == null ? 50 : x.peer_weight) || 0))),
    peer_days: Math.max(0, Math.min(21, Math.round(Number(x.peer_days == null ? 7 : x.peer_days) || 0))), self: x.self !== false && x.self !== 0 && x.self !== '0' };
}
const groupId = (assignmentId, n) => 'ag_' + crypto.createHash('sha1').update(String(assignmentId) + '|' + n).digest('hex').slice(0, 24);
const ratingId = (assignmentId, raterId) => 'pr_' + crypto.createHash('sha1').update(String(assignmentId) + '|' + String(raterId)).digest('hex').slice(0, 26);

function shuffle(seed, arr) {
  const a = (arr || []).slice(); let s = 0; const str = String(seed || '');
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0; s = s || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
/** Balanced groups of about `size` (never a group of one): ⌈n/size⌉ groups, filled in turn. */
function formGroups(studentIds, size, seed) {
  const ids = [...new Set((studentIds || []).map(String))]; const sz = Math.max(2, Math.min(8, Number(size) || 2));
  if (ids.length < 2) return [];
  let g = Math.ceil(ids.length / sz); if (Math.floor(ids.length / g) < 2) g = Math.max(1, Math.floor(ids.length / 2));   // never a group of one
  const out = Array.from({ length: g }, () => []);
  shuffle(seed, ids).forEach((id, i) => out[i % g].push(id));
  return out;
}
/** Groups from lines the lecturer types — one group per line, matric numbers separated by commas or spaces. */
function parseGroupLines(text, byMatric) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: 'Type one group per line.' };
  const seen = new Map(); const groups = [];
  for (let i = 0; i < lines.length; i++) {
    const ms = lines[i].split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
    const ids = [];
    for (const m of ms) {
      const id = byMatric(m); if (!id) return { ok: false, error: 'Line ' + (i + 1) + ': no student in this class with the number ' + m + '.' };
      if (seen.has(id)) return { ok: false, error: m + ' is in more than one group (lines ' + seen.get(id) + ' and ' + (i + 1) + ').' };
      seen.set(id, i + 1); ids.push(id);
    }
    if (ids.length < 2) return { ok: false, error: 'Line ' + (i + 1) + ': a group needs at least two students.' };
    if (ids.length > 8) return { ok: false, error: 'Line ' + (i + 1) + ': at most 8 students in a group.' };
    groups.push(ids);
  }
  return { ok: true, groups };
}

/** When teammates may rate each other: once the group has handed in or the deadline has passed, until peer_days after it. */
function peerWindow(a, policy, groupSubmitted, nowStamp) {
  const p = normalizePolicy(policy); if (!p) return { open: false };
  const stamp = (v) => String(v || '').replace(' ', 'T').slice(0, 16);
  const due = stamp(a && a.due_at); const now = stamp(nowStamp);
  const closes = due ? new Date(Date.parse(due + ':00Z') + p.peer_days * 864e5).toISOString().slice(0, 16) : null;
  const started = groupSubmitted || (due && now > due);
  if (!started) return { open: false, closes_at: closes, why: 'Peer assessment opens once your group has handed in.' };
  if (closes && now > closes) return { open: false, closes_at: closes, closed: true, why: 'Peer assessment has closed.' };
  return { open: true, closes_at: closes };
}
/** One member's ratings: every member (and themselves, when self-rating is on) 1–5. → { ok, scores, comments } */
function validateRatings(members, raterId, input, policy) {
  const p = normalizePolicy(policy) || { self: true };
  const ms = (members || []).map(String); const me = String(raterId);
  if (!ms.includes(me)) return { ok: false, error: 'You are not in this group.' };
  const want = ms.filter(m => p.self || m !== me);
  const x = pj(input && input.scores, {}) || {}; const scores = {};
  for (const m of want) { const n = Number(x[m]); if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: 'Give every member a score from 1 to 5.' }; scores[m] = n; }
  const cIn = pj(input && input.comments, {}) || {}; const comments = {};
  for (const m of want) { const c = clean(cIn[m], 300); if (c) comments[m] = c; }
  return { ok: true, scores, comments };
}
/** WebPA. ratings: { raterId: { memberId: score } } → { factor: { m: f }, raters, missing } (no ratings → everyone 1). */
function webpa(members, ratings) {
  const ms = (members || []).map(String); const n = ms.length; const share = {}; ms.forEach(m => { share[m] = 0; });
  const raters = [];
  for (const r of Object.keys(ratings || {})) {
    if (!ms.includes(String(r))) continue;
    const sc = ratings[r] || {}; const tot = ms.reduce((s, m) => s + (Number(sc[m]) || 0), 0); if (!tot) continue;
    raters.push(String(r)); ms.forEach(m => { share[m] += (Number(sc[m]) || 0) / tot; });
  }
  const factor = {}; ms.forEach(m => { factor[m] = raters.length ? r3(share[m] * n / raters.length) : 1; });
  return { factor, raters, missing: ms.filter(m => !raters.includes(m)) };
}
/** The individual marks from the group mark: mark × ((1 − w) + w × factor), 0 … max. */
function individualMarks(groupMark, factors, peerWeightPct, maxScore) {
  const w = Math.max(0, Math.min(100, Number(peerWeightPct) || 0)) / 100; const max = Number(maxScore) || 100; const out = {};
  for (const m of Object.keys(factors || {})) out[m] = r2(Math.max(0, Math.min(max, Number(groupMark) * ((1 - w) + w * Number(factors[m])))));
  return out;
}

module.exports = { normalizePolicy, groupId, ratingId, formGroups, parseGroupLines, peerWindow, validateRatings, webpa, individualMarks };
