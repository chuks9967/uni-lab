'use strict';
/**
 * ⏸ DEFERRED EXAMS — pure rules shared by the desktop, the portal (LAN / cloud / edge) and the app.
 *
 * A student who missed (or will miss) an exam for an accepted reason — illness, bereavement, an emergency, official
 * university duty — is given a DEFERRAL: the course shows "DEF" on their record (never a fail, never counted in the
 * GPA, never a carry-over to register again), and they sit the paper later AS A FIRST ATTEMPT, filed into the term
 * they missed. A deferral not taken up by its deadline LAPSES: the missed exam then counts as absent.
 *
 *   courseKey(code)          the one way a course code is compared ("CSC 301" = "csc-301" = "CSC.301")
 *   deferralId(sid, key, session, semester)   one deferral per student, course and term (idempotent)
 *   deadline(grantedAt, days)  the date the deferred paper must be sat by
 *   state(def, todayISO)     granted · due_soon (≤ 14 days) · overdue · sat · lapsed · cancelled
 *   matches(def, row)        does a score row belong to this deferral?
 *   blocksGrant(row)         an exam mark already on the record → refuse (you cannot defer a paper you sat)
 *   reasonOk(reason)         the accepted grounds
 *   summary(list, today)     counts for the overview
 *
 * Nothing here touches a database.
 */

const DEF = 'DEF';
const REASONS = ['Medical', 'Bereavement', 'Emergency', 'Official university duty', 'Other'];
const DEFAULT_DAYS = 180;
const SOON_DAYS = 14;

const courseKey = (c) => String(c == null ? '' : c).toUpperCase().replace(/[\s./-]+/g, '');
const dayOf = (iso) => String(iso || '').slice(0, 10);

function deferralId(studentId, key, sessionId, semesterId) {
  return 'dfr_' + require('crypto').createHash('sha1').update([studentId, key, sessionId || '', semesterId || ''].join('|')).digest('hex').slice(0, 24);
}

/** The date (YYYY-MM-DD) a deferred paper must be sat by: `days` after the grant (bounded 14 … 730). */
function deadline(grantedAt, days) {
  const n = Math.max(14, Math.min(730, Math.round(Number(days) || DEFAULT_DAYS)));
  const t = Date.parse(dayOf(grantedAt) + 'T00:00:00Z'); if (!Number.isFinite(t)) return null;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

function daysBetween(a, b) { const x = Date.parse(dayOf(a) + 'T00:00:00Z'), y = Date.parse(dayOf(b) + 'T00:00:00Z'); return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : null; }

/** Where a deferral stands today. */
function state(d, today) {
  const st = String((d && d.status) || 'granted');
  if (st !== 'granted') return st;
  if (!d.deadline) return 'granted';
  const left = daysBetween(today, d.deadline);
  if (left == null) return 'granted';
  if (left < 0) return 'overdue';
  if (left <= SOON_DAYS) return 'due_soon';
  return 'granted';
}

/** Does this score row belong to the deferral (same student, same course, same term)? */
function matches(d, row) {
  if (!d || !row || d.student_id !== row.student_id) return false;
  const sameCourse = (d.course_id && row.course_id && d.course_id === row.course_id) || (d.course_key && d.course_key === courseKey(row.course_code));
  if (!sameCourse) return false;
  if (d.session_id && row.session_id !== d.session_id) return false;
  if (d.semester_id && row.semester_id && row.semester_id !== d.semester_id) return false;
  return true;
}

/** A real exam mark on the record means the paper was sat — a deferral cannot be put over it. → why, or null */
function blocksGrant(row) {
  if (!row) return null;
  const ex = row.exam_score == null || row.exam_score === '' ? null : Number(row.exam_score);
  if (ex != null && Number.isFinite(ex) && ex > 0 && String(row.grade || '').toUpperCase() !== DEF) return 'An exam mark (' + ex + ') is already on the record for this course and term — a deferral cannot replace a paper that was sat. Use a re-mark or the exam board instead.';
  return null;
}

const reasonOk = (r) => REASONS.includes(String(r || ''));
const isDeferredGrade = (g) => String(g == null ? '' : g).trim().toUpperCase() === DEF;

function summary(list, today) {
  const out = { owed: 0, due_soon: 0, overdue: 0, sat: 0, lapsed: 0, cancelled: 0, courses: 0 };
  const courses = new Set();
  for (const d of list || []) {
    const s = state(d, today);
    if (s === 'granted' || s === 'due_soon' || s === 'overdue') { out.owed++; courses.add(d.course_key); }
    if (s === 'due_soon') out.due_soon++;
    if (s === 'overdue') out.overdue++;
    if (s === 'sat') out.sat++;
    if (s === 'lapsed') out.lapsed++;
    if (s === 'cancelled') out.cancelled++;
  }
  out.courses = courses.size;
  return out;
}

module.exports = { DEF, REASONS, DEFAULT_DAYS, SOON_DAYS, courseKey, deferralId, deadline, daysBetween, state, matches, blocksGrant, reasonOk, isDeferredGrade, summary };
