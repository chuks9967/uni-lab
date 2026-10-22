'use strict';
/**
 * 📝 SCRIPT REVIEW (RE-MARK) — the rules shared by the desk (electron/services/remarks.js), the portal and the app.
 *
 *   request    a student asks within the window after the result is released, gives a reason, at most N per
 *              session, one open request per result
 *   blind      the second examiner sees a code (SR-…), the course and the part to re-mark — never the student's
 *              name, the original mark or the student's reason, so the first mark cannot anchor the second
 *   decision   a re-mark changes the record only when it differs from the original by at least the threshold
 *              (5 marks by default); a lower re-mark stands only when the policy says marks may go down
 *   part       the exam script is re-marked (the continuous assessment stays); a result with only a total is
 *              re-marked as a total
 */
const STATUS = { requested: 'Requested', accepted: 'Accepted — waiting for a second examiner', assigned: 'With the second examiner', remarked: 'Re-marked — waiting for the decision',
  upheld: 'Reviewed — the original mark stands', changed: 'Reviewed — the mark was changed', rejected: 'Not accepted', withdrawn: 'Withdrawn' };
const OPEN = ['requested', 'accepted', 'assigned', 'remarked'];
const DONE = ['upheld', 'changed'];
const DEFAULT_POLICY = { enabled: true, window_days: 21, max_per_session: 3, threshold: 5, can_lower: true, marker_days: 14, fee: null };

const day = (d) => String(d || '').slice(0, 10);
const todayOf = (now) => new Date(now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now))).toISOString().slice(0, 10);
function addDays(ymd, n) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || '')); if (!m) return null; return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10); }
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);

/** The institution's policy (a JSON setting) with safe defaults. */
function policyOf(raw) {
  let p = raw; if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = null; } }
  p = Object.assign({}, DEFAULT_POLICY, p && typeof p === 'object' ? p : {});
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  const fee = p.fee && Number(p.fee.amount) > 0 && /^[A-Za-z]{3}$/.test(String(p.fee.currency || '')) ? { amount: r2(p.fee.amount), currency: String(p.fee.currency).toUpperCase() } : null;
  return { enabled: p.enabled !== false && p.enabled !== 0 && p.enabled !== '0', window_days: int(p.window_days, 1, 365, 21), max_per_session: int(p.max_per_session, 1, 50, 3),
    threshold: Math.max(0, Math.min(50, Number(p.threshold) >= 0 ? Number(p.threshold) : 5)), can_lower: p.can_lower !== false && p.can_lower !== 0 && p.can_lower !== '0', marker_days: int(p.marker_days, 1, 90, 14), fee };
}
/** Which part of the mark is re-marked, and its original value. */
function partOf(score) {
  const exam = num(score && score.exam_score);
  return exam != null ? { part: 'exam', original: exam, other: num(score.test_score) || 0 } : { part: 'total', original: num(score && score.score), other: 0 };
}
/** May this student ask for a review of this result now? → { ok, closes } or { ok:false, error } */
function canRequest(score, requests, policy, now) {
  const p = policyOf(policy);
  if (!p.enabled) return { ok: false, error: 'Script reviews are not open at the moment.' };
  if (!score || num(score.score) == null) return { ok: false, error: 'There is no mark to review.' };
  if (Number(score.released) === 0) return { ok: false, error: 'This result has not been released yet.' };
  const since = day(score.released_at || score.updated_at || score.created_at);
  const closes = since ? addDays(since, p.window_days) : null;
  if (closes && todayOf(now) > closes) return { ok: false, error: 'The review window for this result closed on ' + closes + '.' };
  const mine = (requests || []).filter(r => r && !Number(r.deleted));
  if (mine.some(r => r.score_id === score.id && OPEN.includes(r.status))) return { ok: false, error: 'You already asked for a review of this result.' };
  if (mine.some(r => r.score_id === score.id && DONE.includes(r.status))) return { ok: false, error: 'This result was already reviewed.' };
  const used = mine.filter(r => (r.session_id || null) === (score.session_id || null) && !['withdrawn', 'rejected'].includes(r.status)).length;
  if (used >= p.max_per_session) return { ok: false, error: 'You can ask for at most ' + p.max_per_session + ' script review(s) per session.' };
  return { ok: true, closes };
}
function validateReason(s) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 2000);
  return t.length >= 20 ? { ok: true, reason: t } : { ok: false, error: 'Say why you think the script should be re-marked (a sentence or two).' };
}
/** Check a second examiner's mark for the part being re-marked. */
function checkMark(value, part) {
  const v = num(value);
  if (v == null || v < 0) return { ok: false, error: 'Enter the mark you give the script.' };
  const pt = part || { part: 'total', other: 0 };
  if (v + (pt.other || 0) > 100) return { ok: false, error: pt.part === 'exam' ? 'The exam mark plus the continuous assessment (' + pt.other + ') cannot pass 100.' : 'A total cannot pass 100.' };
  return { ok: true, value: r2(v) };
}
/**
 * The decision: totals before and after. A difference smaller than the threshold leaves the original; a lower
 * re-mark is applied only when the policy allows marks to go down.
 */
function outcome(score, remark, policy) {
  const p = policyOf(policy); const pt = partOf(score);
  const before = num(score.score); const after = r2(pt.part === 'exam' ? pt.other + Number(remark) : Number(remark));
  const diff = r2(after - before);
  const material = Math.abs(diff) >= p.threshold && diff !== 0;
  if (!material) return { change: false, before, after, diff, final: before, reason: 'The re-mark is within ' + p.threshold + ' mark(s) of the original — the original mark stands.' };
  if (diff < 0 && !p.can_lower) return { change: false, before, after, diff, final: before, reason: 'The re-mark is lower, and the policy does not lower marks on review — the original mark stands.' };
  return { change: true, before, after, diff, final: after, part: pt.part, part_value: r2(Number(remark)), reason: 'The re-mark differs by ' + Math.abs(diff) + ' mark(s) — the new mark replaces the original.' };
}
/** What the second examiner sees instead of a name. */
function blindCode(id) { return 'SR-' + String(id || '').replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase(); }
const markerDue = (fromDay, policy) => addDays(day(fromDay), policyOf(policy).marker_days);

module.exports = { STATUS, OPEN, DONE, DEFAULT_POLICY, policyOf, partOf, canRequest, validateReason, checkMark, outcome, blindCode, markerDue, addDays };
