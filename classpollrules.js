'use strict';
/**
 * 🗳 THE RULES A CLASS POLL OBEYS — how options are cleaned, how votes are tallied, and exactly what a
 * given seat is allowed to SEE.
 *
 * ⚠ SHARED ON PURPOSE (like server/classmaterialrules.js / classregister.js). A poll is launched from
 * the desktop desk AND from the staff portal, votes arrive from the student portal/app, and the tally
 * is rendered on all of them. Two copies of "who may see the running result" or "what counts as a
 * valid vote" would drift, and the anonymity rule in particular is a privacy boundary.
 *
 * PRIVACY, same discipline as classqa.js: a vote row ALWAYS carries `student_id` (so a poll cannot be
 * abused untraceably and a lecturer can see who has not yet voted), but the per-student choice NEVER
 * leaves this module for an anonymous poll, and the tally is only ever aggregate counts — never a
 * per-voter list. Results are shown to the class only once a student has voted or the poll is closed,
 * so a poll cannot be swayed by watching the numbers move before you answer.
 *
 * Pure: no DB, no clock. Unit-tested through test/liveclass-suite.js ([poll] block).
 */

const MAX_QUESTION = 300;
const MAX_OPTION = 160;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;

/** Clean a raw options list into at most MAX_OPTIONS trimmed, non-empty, de-duplicated choices. */
function normalizeOptions(raw) {
  const seen = new Set(); const out = [];
  for (const o of (Array.isArray(raw) ? raw : [])) {
    const s = String(o == null ? '' : o).trim().slice(0, MAX_OPTION);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(s);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

/** Options as an array, whether stored as JSON text or already an array. */
function parseOptions(v) {
  if (Array.isArray(v)) return v.map(x => String(x));
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(x => String(x)) : []; } catch (_) { return []; }
}

/** A student's own (undeleted) vote row for a poll, or null. */
function voteOf(votes, studentId) {
  if (!studentId) return null;
  for (const v of (votes || [])) if (!v.deleted && v.student_id === studentId) return v;
  return null;
}
function hasVoted(votes, studentId) { return !!voteOf(votes, studentId); }

/** Aggregate tally: per-option counts + total. Out-of-range choices are ignored, never crash the bar. */
function tally(votes, optionCount) {
  const n = Math.max(0, Number(optionCount) || 0);
  const counts = new Array(n).fill(0);
  let total = 0;
  for (const v of (votes || [])) {
    if (v.deleted) continue;
    const c = Number(v.choice);
    if (Number.isInteger(c) && c >= 0 && c < n) { counts[c]++; total++; }
  }
  return { counts, total };
}

/**
 * The poll as one seat may see it. Aggregate counts are revealed to the host always, and to a student
 * once they have voted or the poll has closed — never before, and never as a per-voter breakdown.
 *   ctx = { isHost, studentId }
 */
function view(poll, votes, ctx = {}) {
  if (!poll) return null;
  const options = parseOptions(poll.options);
  const mine = voteOf(votes, ctx.studentId);
  const voted = !!mine;
  const closed = poll.status === 'closed';
  const showResults = !!ctx.isHost || closed || voted;
  const t = showResults ? tally(votes, options.length) : null;
  return {
    id: poll.id, room: poll.room, question: poll.question || '',
    options,
    status: poll.status || 'open',
    anonymous: !!poll.anonymous,
    closed,
    voted,
    mine: voted ? Number(mine.choice) : null,        // the caller's OWN choice — never anyone else's
    counts: t ? t.counts : null,
    total: t ? t.total : null,
    course_code: poll.course_code || '',
    created_at: poll.created_at, closed_at: poll.closed_at || null,
  };
}

/** Open polls first, then newest — the order the in-class panel wants. Closed polls stay as a record. */
function sortPolls(rows) {
  return (rows || []).slice().sort((a, b) =>
    (a.status === 'closed' ? 1 : 0) - (b.status === 'closed' ? 1 : 0)
    || String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

module.exports = {
  MAX_QUESTION, MAX_OPTION, MIN_OPTIONS, MAX_OPTIONS,
  normalizeOptions, parseOptions, voteOf, hasVoted, tally, view, sortPolls,
};
