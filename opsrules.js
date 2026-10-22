'use strict';
/**
 * 🏛 ACADEMIC OPERATIONS — pure rules shared by the desktop and the portal for:
 *   📖 library circulation (loans, renewals, holds, fines)   📋 staff performance appraisal
 *   🎯 outcome-based education (programme outcomes, attainment from real scores)   🎓 convocation
 * No database access — deterministic and unit-tested (test/opsmodules.js).
 */
const crypto = require('crypto');
const C = require('./campusrules');
const did = C.did;
const pj = (s, d) => { if (s && typeof s === 'object') return s; try { const v = JSON.parse(s == null ? 'null' : s); return v == null ? d : v; } catch (_) { return d; } };
const dayDiff = (a, b) => { const x = /^\d{4}-\d{2}-\d{2}/.test(String(a || '')) ? Date.UTC(+String(a).slice(0, 4), +String(a).slice(5, 7) - 1, +String(a).slice(8, 10)) : NaN; const y = /^\d{4}-\d{2}-\d{2}/.test(String(b || '')) ? Date.UTC(+String(b).slice(0, 4), +String(b).slice(5, 7) - 1, +String(b).slice(8, 10)) : NaN; return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : 0; };

// =====================================================================================================
// 📖 LIBRARY CIRCULATION
// =====================================================================================================
const DEFAULT_LIBRARY_POLICY = {
  student_days: 14, staff_days: 30,      // loan period
  student_max: 4, staff_max: 10,         // books out at once
  max_renewals: 2,
  fine_per_day: 50, fine_currency: 'NGN', grace_days: 0, fine_cap: 0,   // 0 = no cap
  hold_days: 3,                          // how long a held copy waits on the hold shelf
  block_when_overdue: true,              // no new loans while something is overdue
};
function libraryPolicy(raw) {
  const p = Object.assign({}, DEFAULT_LIBRARY_POLICY, pj(raw, {}) || {});
  for (const k of ['student_days', 'staff_days', 'student_max', 'staff_max', 'max_renewals', 'grace_days', 'hold_days']) p[k] = Math.max(0, Math.min(365, parseInt(p[k], 10) || 0));
  for (const k of ['fine_per_day', 'fine_cap']) p[k] = Math.max(0, Number(p[k]) || 0);
  p.block_when_overdue = p.block_when_overdue !== false && p.block_when_overdue !== 'false';
  return p;
}
const holdId = (itemId, kind, borrowerId) => did('lh', itemId, kind, borrowerId);
function dueDate(kind, policy, fromDay) { return C.addDays(fromDay || C.today(), kind === 'staff' ? policy.staff_days : policy.student_days); }
function daysOverdue(loan, policy, onDay) {
  if (!loan || !loan.due_date) return 0;
  const end = loan.returned_at ? String(loan.returned_at).slice(0, 10) : C.today(onDay);
  return Math.max(0, dayDiff(loan.due_date, end) - (policy.grace_days || 0));
}
function fineFor(loan, policy, onDay) {
  const d = daysOverdue(loan, policy, onDay); if (!d) return 0;
  const f = Math.round(d * policy.fine_per_day * 100) / 100;
  return policy.fine_cap > 0 ? Math.min(policy.fine_cap, f) : f;
}
/** May this borrower take this copy home now? `ctx` = { kind, activeLoans[], item, copy, holds[] (waiting/ready for the item) }. */
function canIssue(ctx, policy, borrowerId, onDay) {
  const { kind, activeLoans = [], item, copy, holds = [] } = ctx || {};
  if (!item || !copy) return { ok: false, error: 'That copy is not in the catalogue.' };
  if (Number(item.reference_only)) return { ok: false, error: 'Reference material — it is read in the library and never lent.' };
  if (copy.status === 'on_loan') return { ok: false, error: 'That copy is already on loan — return it first.' };
  if (['lost', 'damaged', 'withdrawn'].includes(copy.status)) return { ok: false, error: 'That copy is marked ' + copy.status + '.' };
  if (copy.status === 'on_hold_shelf') {
    const h = holds.find(x => x.status === 'ready' && x.copy_id === copy.id);
    if (h && h.borrower_id !== borrowerId) return { ok: false, error: 'This copy is on the hold shelf for another reader.' };
  }
  const max = kind === 'staff' ? policy.staff_max : policy.student_max;
  if (activeLoans.length >= max) return { ok: false, error: `Limit reached — ${max} item(s) out at once. Return one first.` };
  if (policy.block_when_overdue && activeLoans.some(l => daysOverdue(l, policy, onDay) > 0)) return { ok: false, error: 'An overdue item must be returned first.' };
  return { ok: true };
}
function canRenew(loan, waitingHolds, policy, onDay) {
  if (!loan || loan.status !== 'on_loan') return { ok: false, error: 'This loan is not active.' };
  if ((Number(loan.renewals) || 0) >= policy.max_renewals) return { ok: false, error: `Already renewed ${policy.max_renewals} time(s) — please return it.` };
  if ((waitingHolds || []).length) return { ok: false, error: 'Another reader is waiting for this title — it cannot be renewed.' };
  if (daysOverdue(loan, policy, onDay) > 0) return { ok: false, error: 'Overdue items cannot be renewed — return it at the desk.' };
  return { ok: true };
}
/** Next accession number after the highest existing one with the same prefix: ACC-000124. */
function nextAccession(existing, prefix) {
  const px = String(prefix || 'ACC').replace(/[^A-Z0-9-]/gi, '').toUpperCase() || 'ACC';
  let max = 0; const re = new RegExp('^' + px + '-(\\d+)$');
  for (const a of existing || []) { const m = re.exec(String(a || '')); if (m) max = Math.max(max, Number(m[1])); }
  return (n) => px + '-' + String(max + (n || 1)).padStart(6, '0');
}

// =====================================================================================================
// 📋 STAFF PERFORMANCE APPRAISAL
// =====================================================================================================
const DEFAULT_CRITERIA = [
  { key: 'teaching', label: 'Teaching & learning', weight: 30 },
  { key: 'research', label: 'Research, publications & grants', weight: 25 },
  { key: 'service', label: 'Service, administration & community', weight: 15 },
  { key: 'professionalism', label: 'Professional conduct & teamwork', weight: 15 },
  { key: 'punctuality', label: 'Punctuality & attendance', weight: 15 },
];
const RATING_BANDS = [[90, 'Outstanding'], [75, 'Exceeds expectations'], [60, 'Meets expectations'], [45, 'Needs improvement'], [0, 'Unsatisfactory']];
function normalizeCriteria(list) {
  const out = (Array.isArray(list) ? list : []).map((c, i) => ({ key: String((c && c.key) || ('c' + (i + 1))).replace(/[^a-z0-9_]/gi, '').slice(0, 24) || ('c' + (i + 1)), label: C.clean(c && c.label, 120), weight: Math.max(0, Math.min(100, Number(c && c.weight) || 0)) })).filter(c => c.label);
  if (!out.length) return DEFAULT_CRITERIA.map(c => Object.assign({}, c));
  const tot = out.reduce((s, c) => s + c.weight, 0);
  if (tot !== 100) throw new Error('The criteria weights must add up to 100 (now ' + tot + ').');
  if (new Set(out.map(c => c.key)).size !== out.length) throw new Error('Two criteria share the same key.');
  return out;
}
const appraisalId = (cycleId, staffId) => did('ap', cycleId, staffId);
/** Keep only this cycle's criteria, as whole numbers 1–5. `complete` when every criterion is scored. */
function cleanScores(criteria, input) {
  const src = pj(input, {}) || {}; const out = {};
  for (const c of criteria || []) { const v = Math.round(Number(src[c.key])); if (v >= 1 && v <= 5) out[c.key] = v; }
  return { scores: out, complete: (criteria || []).every(c => out[c.key] != null) };
}
/** Weighted score 0–100 (a 5 on every criterion = 100, a 1 = 20). */
function appraisalScore(criteria, scores) {
  const s = pj(scores, {}) || {}; let sum = 0, w = 0;
  for (const c of criteria || []) { const v = Number(s[c.key]); if (v >= 1 && v <= 5) { sum += v * 20 * c.weight; w += c.weight; } }
  return w ? Math.round(sum / w * 10) / 10 : null;
}
function ratingOf(score) { if (score == null) return null; for (const [min, r] of RATING_BANDS) if (score >= min) return r; return RATING_BANDS[RATING_BANDS.length - 1][1]; }

// =====================================================================================================
// 🎯 OUTCOME-BASED EDUCATION
// =====================================================================================================
const FRAMEWORKS = ['Institutional', 'NUC CCMAS', 'ABET', 'EUR-ACE', 'Washington Accord', 'AACSB', 'QAA', 'CHE'];
const outcomeMapId = (courseCode, outcomeId) => did('cm', String(courseCode || '').toUpperCase().replace(/\s+/g, ''), outcomeId);
const codeKey = (c) => String(c || '').toUpperCase().replace(/\s+/g, '');
/** Per course: how many students sat it and how many reached the mark (default 50). */
function courseAttainment(scores, passMark) {
  const pm = Number.isFinite(Number(passMark)) ? Number(passMark) : 50; const by = new Map();
  for (const s of scores || []) {
    if (!s || s.deleted || s.score == null || s.score === '') continue;
    const k = codeKey(s.course_code); if (!k) continue;
    const e = by.get(k) || { course_code: k, students: 0, reached: 0 }; e.students++; if (Number(s.score) >= pm) e.reached++; by.set(k, e);
  }
  for (const e of by.values()) e.pct = e.students ? Math.round(e.reached * 1000 / e.students) / 10 : null;
  return by;
}
/** Per outcome: attainment = the strength-weighted average of its courses' pass shares; `met` against its target. */
function outcomeAttainment(outcomes, maps, courseStats) {
  return (outcomes || []).filter(o => o && !o.deleted).map(o => {
    const ms = (maps || []).filter(m => m && !m.deleted && m.outcome_id === o.id);
    let sum = 0, w = 0; const courses = [];
    for (const m of ms) {
      const st = courseStats.get(codeKey(m.course_code)); const s = Math.max(1, Math.min(3, Number(m.strength) || 2));
      courses.push({ course_code: codeKey(m.course_code), strength: s, students: st ? st.students : 0, pct: st ? st.pct : null });
      if (st && st.pct != null) { sum += st.pct * s; w += s; }
    }
    const pct = w ? Math.round(sum / w * 10) / 10 : null; const target = Number(o.target_pct) || 60;
    return { id: o.id, code: o.code, statement: o.statement, target, pct, met: pct != null && pct >= target, courses, mapped: ms.length, assessed: courses.filter(c => c.pct != null).length };
  });
}

// =====================================================================================================
// 🎓 CONVOCATION
// =====================================================================================================
const graduandId = (convId, studentId) => did('gd', convId, studentId);
function ticketCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += A[b[i] % A.length]; return s.slice(0, 4) + '-' + s.slice(4); }
const CLASS_ORDER = ['first', 'second class upper', 'second class (upper', 'upper', 'second class lower', 'second class (lower', 'lower', 'third', 'pass'];
function classRank(c) { const s = String(c || '').toLowerCase(); for (let i = 0; i < CLASS_ORDER.length; i++) if (s.includes(CLASS_ORDER[i])) return i; return CLASS_ORDER.length; }
/** Seats in ceremony order: by class of degree, then name — "A-001", "A-002"… blocks of 50 per letter. */
function assignSeats(graduands) {
  const list = (graduands || []).filter(g => g && g.attending !== 0 && Number(g.attending) !== 0).slice()
    .sort((a, b) => classRank(a.classification) - classRank(b.classification) || String(a.name || '').localeCompare(String(b.name || '')));
  return list.map((g, i) => ({ id: g.id, seat_no: String.fromCharCode(65 + Math.floor(i / 50)) + '-' + String((i % 50) + 1).padStart(3, '0') }));
}
function canRsvp(conv, onDay) {
  if (!conv || conv.status !== 'published') return { ok: false, error: 'The ceremony details are not published yet.' };
  if (conv.rsvp_deadline && C.today(onDay) > String(conv.rsvp_deadline).slice(0, 10)) return { ok: false, error: 'The reply deadline has passed — contact the Registry.' };
  return { ok: true };
}

module.exports = {
  // library
  DEFAULT_LIBRARY_POLICY, libraryPolicy, holdId, dueDate, daysOverdue, fineFor, canIssue, canRenew, nextAccession,
  // appraisal
  DEFAULT_CRITERIA, RATING_BANDS, normalizeCriteria, appraisalId, cleanScores, appraisalScore, ratingOf,
  // outcomes
  FRAMEWORKS, outcomeMapId, codeKey, courseAttainment, outcomeAttainment,
  // convocation
  graduandId, ticketCode, classRank, assignSeats, canRsvp,
};
