'use strict';
/* ============================================================================
 * 🎓 EXAM & TEST ELIGIBILITY — ONE rule for the desk, the portal, the app and the exam hall.
 *
 * Each CLEARING OFFICE (an "authority": the Bursary, the Dean of the student's faculty, the Head of department, the Registrar,
 * Student Affairs, ICT, the Library… — chosen by the administrator, with the users who act for it) sets its own RULES for TESTS and
 * for EXAMS (fees paid ≥ X %, class attendance ≥ X %, courses registered, no open misconduct case, no financial hold, no overdue
 * library book, or a clearance in person), for a session / semester or for every term. A student who meets an office's rules is
 * cleared by it AUTOMATICALLY; the office can also decide by hand:
 *   • cleared      — for tests and exams;
 *   • partial      — partly cleared: for TESTS only (or only for named courses);
 *   • conditional  — cleared until a date, on a stated condition (it lapses by itself after the date);
 *   • not cleared  — with the reason (it overrides the rules).
 * A student is ELIGIBLE for a test / an exam only when EVERY required office that concerns them has cleared them for it.
 *
 * Pure (no database): the caller gives the authorities, rules, decisions and the FACTS (the measured value of each rule for the
 * student). Vendored to the edge (scripts/build-edge.js) — the portal reads the desk's snapshots and uses the same wording.
 * ==========================================================================*/

const KINDS = ['test', 'exam'];
const OFFICES = { bursary: 'Bursary', dean: 'Dean of the faculty', hod: 'Head of department', registrar: 'Registrar', student_affairs: 'Student Affairs', ict: 'ICT', library: 'Library', exams: 'Examinations office', custom: 'Office' };
/** The base roles that act for an office when the administrator has not named its users. */
const OFFICE_ROLES = { bursary: ['accountant'], dean: ['dean'], hod: ['hod'], registrar: ['registrar'], student_affairs: ['student_affairs'], ict: ['ict'], library: [], exams: ['registrar'], custom: [] };
const RULE_TYPES = {
  fees_pct: { label: 'School fees paid', auto: true },
  attendance_pct: { label: 'Class attendance in every course', auto: true },
  registered: { label: 'Courses registered for the term', auto: true },
  no_misconduct: { label: 'No open misconduct case', auto: true },
  no_hold: { label: 'No financial hold', auto: true },
  library_clear: { label: 'No overdue library book', auto: true },
  manual: { label: 'Seen and cleared in person by the office', auto: false },
};
const STATUSES = ['cleared', 'partial', 'conditional', 'not_cleared'];
const SCOPES = ['all', 'faculty', 'department', 'own_faculty', 'own_department'];

const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const arr = (v) => { if (Array.isArray(v)) return v; try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } };
const obj = (v) => { if (v && typeof v === 'object' && !Array.isArray(v)) return v; try { const o = JSON.parse(v || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (_) { return {}; } };
const kindOk = (k) => (k === 'test' || k === 'exam' ? k : 'both');

/** An office as stored → its clean form. */
function normAuthority(a) {
  const x = a || {}; const office = OFFICES[x.office] ? x.office : 'custom';
  return { id: String(x.id || ''), office, title: String(x.title || OFFICES[office]).slice(0, 80), scope_type: SCOPES.includes(x.scope_type) ? x.scope_type : (office === 'dean' ? 'own_faculty' : office === 'hod' ? 'own_department' : 'all'),
    scope_id: x.scope_id ? String(x.scope_id) : null, required: x.required == null ? true : !!Number(x.required === true ? 1 : x.required), auto_clear: x.auto_clear == null ? true : !!Number(x.auto_clear === true ? 1 : x.auto_clear),
    members: arr(x.members).map(String).slice(0, 50), active: x.active == null ? true : !!Number(x.active === true ? 1 : x.active), sort: Number(x.sort) || 0 };
}
/** A rule as stored → its clean form. */
function normRule(r) {
  const x = r || {}; const p = obj(x.params); const type = RULE_TYPES[x.type] ? x.type : 'manual';
  return { id: String(x.id || ''), authority_id: String(x.authority_id || ''), kind: kindOk(x.kind), type, session_id: x.session_id || null, semester_id: x.semester_id || null, active: x.active == null ? true : !!Number(x.active === true ? 1 : x.active),
    pct: num(p.pct, type === 'attendance_pct' ? 75 : 100, 0, 100), categories: arr(p.categories).map(String).slice(0, 30), scope: ['session', 'semester', 'all'].includes(p.scope) ? p.scope : 'session',
    min: Math.round(num(p.min, 1, 0, 50)), text: String(p.text || '').slice(0, 200) };
}
/** A decision as stored → its clean form. */
function normDecision(d) {
  const x = d || {};
  return { id: String(x.id || ''), authority_id: String(x.authority_id || ''), student_id: String(x.student_id || ''), session_id: x.session_id || null, semester_id: x.semester_id || null, kind: kindOk(x.kind),
    status: STATUSES.includes(x.status) ? x.status : 'not_cleared', courses: arr(x.courses).map(c => String(c).toUpperCase()).slice(0, 40), condition: String(x.condition_text || x.condition || '').slice(0, 300),
    until: /^\d{4}-\d{2}-\d{2}/.test(String(x.until || '')) ? String(x.until).slice(0, 10) : null, reason: String(x.reason || '').slice(0, 300), decided_by: x.decided_by || null, decided_at: String(x.decided_at || x.updated_at || x.created_at || ''), deleted: !!Number(x.deleted) };
}
/** Does a rule / decision concern this kind (test | exam) and this term? (no session / semester = every term) */
const kindHits = (k, kind) => k === 'both' || k === kind;
const termHits = (x, term) => (!x.session_id || !term || !term.session_id || x.session_id === term.session_id) && (!x.semester_id || !term || !term.semester_id || x.semester_id === term.semester_id);
/** Does an office concern this student? (its scope: everyone, one faculty / department, or the student's own dean / head) */
function concerns(a, st) {
  const s = st || {};
  if (a.scope_type === 'faculty') return !a.scope_id || a.scope_id === s.faculty_id;
  if (a.scope_type === 'department') return !a.scope_id || a.scope_id === s.department_id;
  return true;
}
/** What a rule asks, in words. */
function ruleText(r) {
  const term = r.scope === 'semester' ? ' (this semester)' : r.scope === 'all' ? ' (all terms)' : ' (this session)';
  switch (r.type) {
    case 'fees_pct': return 'At least ' + r.pct + '% of ' + (r.categories.length ? 'the fees (' + r.categories.join(', ') + ')' : 'the school fees') + ' paid' + term;
    case 'attendance_pct': return 'At least ' + r.pct + '% attendance in every course';
    case 'registered': return 'At least ' + r.min + ' course' + (r.min === 1 ? '' : 's') + ' registered for the term';
    case 'no_misconduct': return 'No open misconduct case';
    case 'no_hold': return 'No financial hold on the account';
    case 'library_clear': return 'No overdue library book';
    default: return r.text || 'Seen and cleared in person by the office';
  }
}
/** Is a rule met by its fact? fact = { value, have } (value: a number for % / counts, a boolean for the checks). */
function checkRule(r, fact) {
  const f = fact || {}; const v = f.value;
  if (r.type === 'manual') return { met: false, manual: true, have: '' };
  if (r.type === 'fees_pct' || r.type === 'attendance_pct') { const n = Number(v); const ok = Number.isFinite(n) && n + 1e-9 >= r.pct; return { met: ok, have: f.have || (Number.isFinite(n) ? Math.floor(n) + '%' : '—') }; }
  if (r.type === 'registered') { const n = Number(v) || 0; return { met: n >= r.min, have: f.have || n + ' registered' }; }
  return { met: v === true, have: f.have || '' };
}
/** The decision of an office for a student, a kind and a term (the latest that is not withdrawn). */
function decisionFor(decisions, authorityId, studentId, kind, term) {
  const list = (decisions || []).map(normDecision).filter(d => !d.deleted && d.authority_id === authorityId && (!studentId || d.student_id === studentId) && kindHits(d.kind, kind) && termHits(d, term));
  list.sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at)));
  return list[0] || null;
}

/**
 * EVALUATE one student for one kind (test | exam).
 *   x = { authorities, rules, decisions, facts: { [rule.id]: { value, have } }, student: { id, status, faculty_id, department_id },
 *         kind, term: { session_id, semester_id }, today: 'YYYY-MM-DD', course: 'CSC101' (optional — a partial clearance for named courses) }
 * → { kind, eligible, offices: [{ id, office, title, required, status, by, met, reasons, todo, condition, until }], reasons: [...] }
 *   office status: cleared | auto (cleared by its rules) | partial | conditional | pending | not_cleared | lapsed
 */
function evaluate(x) {
  const o = x || {}; const kind = o.kind === 'test' ? 'test' : 'exam'; const st = o.student || {}; const today = String(o.today || '').slice(0, 10); const course = o.course ? String(o.course).toUpperCase() : '';
  const reasons = []; const offices = [];
  if (st.status && !['active', 'inactive'].includes(String(st.status).toLowerCase())) reasons.push('Not an active student (' + st.status + ').');
  const auths = (o.authorities || []).map(normAuthority).filter(a => a.active && concerns(a, st)).sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title));
  const termRules = (o.rules || []).map(normRule).filter(r => r.active && termHits(r, o.term));
  const rules = termRules.filter(r => kindHits(r.kind, kind));
  for (const a of auths) {
    const row = { id: a.id, office: a.office, title: a.title, required: a.required, status: 'pending', by: 'rules', met: [], reasons: [], todo: [], condition: '', until: null };
    const d = decisionFor(o.decisions, a.id, st.id, kind, o.term);
    if (d) {
      row.by = 'manual'; row.decided_at = d.decided_at;
      if (d.status === 'cleared') row.status = 'cleared';
      else if (d.status === 'partial') {
        const forCourse = d.courses.length ? (course ? d.courses.includes(course) : kind === 'test') : kind === 'test';
        row.status = forCourse ? 'partial' : 'not_cleared'; row.courses = d.courses;
        if (!forCourse) row.reasons.push(a.title + ': partly cleared — ' + (d.courses.length ? 'only for ' + d.courses.join(', ') : 'for tests only, not yet for exams') + (d.reason ? ' (' + d.reason + ')' : '') + '.');
      } else if (d.status === 'conditional') {
        row.condition = d.condition; row.until = d.until;
        if (d.until && today && d.until < today) { row.status = 'lapsed'; row.reasons.push(a.title + ': the conditional clearance lapsed on ' + d.until + (d.condition ? ' (' + d.condition + ')' : '') + '.'); }
        else row.status = 'conditional';
      } else { row.status = 'not_cleared'; row.reasons.push(a.title + ': not cleared' + (d.reason ? ' — ' + d.reason : '') + '.'); }
    } else {
      const mine = rules.filter(r => r.authority_id === a.id);
      // an office whose rules are for the OTHER kind only asks nothing for this one (the Dean's attendance rule is for exams, not tests)
      if (!mine.length && termRules.some(r => r.authority_id === a.id)) { row.status = 'auto'; row.met.push('No requirement for ' + (kind === 'test' ? 'tests' : 'exams')); }
      else if (!mine.length) { row.todo.push('Be cleared in person by the ' + a.title + '.'); row.reasons.push(a.title + ': awaiting its clearance.'); }
      else {
        for (const r of mine) { const c = checkRule(r, (o.facts || {})[r.id]); const t = ruleText(r); if (c.met) row.met.push(t + (c.have ? ' — ' + c.have : '')); else row.todo.push(t + (c.have ? ' (now: ' + c.have + ')' : '') + '.'); }
        if (!row.todo.length) { if (a.auto_clear) row.status = 'auto'; else { row.todo.push('Rules met — awaiting the ' + a.title + '’s confirmation.'); row.reasons.push(a.title + ': rules met, awaiting its confirmation.'); } }
        else row.reasons.push(a.title + ': ' + row.todo.map(t => t.replace(/\.$/, '')).join('; ') + '.');
      }
    }
    offices.push(row);
  }
  const OK = ['cleared', 'auto', 'partial', 'conditional'];
  for (const r of offices) if (r.required && !OK.includes(r.status)) reasons.push(...(r.reasons.length ? r.reasons : [r.title + ': not cleared.']));
  return { kind, eligible: !reasons.length, offices, reasons };
}
/** Both kinds at once → { test, exam } (each an evaluate() result). */
function evaluateBoth(x) { return { test: evaluate(Object.assign({}, x, { kind: 'test' })), exam: evaluate(Object.assign({}, x, { kind: 'exam' })) }; }
/** What a member of the public may see of a result (the exam hall's phone camera on the card's link): the verdict and WHICH offices
 *  have not cleared — never the amounts, percentages or reasons (those are for signed-in staff and the student). */
function publicView(r) { const x = r || {}; return { kind: x.kind, eligible: !!x.eligible, offices: (x.offices || []).map(o => ({ title: o.title, required: o.required, status: o.status })) }; }
/** The short line for a result. */
function summary(r) { const x = r || {}; if (x.eligible) return '✓ ELIGIBLE for ' + (x.kind === 'test' ? 'tests' : 'exams'); const n = (x.offices || []).filter(o => o.required && !['cleared', 'auto', 'partial', 'conditional'].includes(o.status)).map(o => o.title); return '✗ NOT eligible for ' + (x.kind === 'test' ? 'tests' : 'exams') + (n.length ? ' — not cleared by ' + n.join(', ') : ''); }

/** The default offices of a fresh set-up (the administrator edits them): the Bursary, the Registrar, the Dean, Student Affairs —
 *  required; the Head of department and ICT — present but not required. */
function defaultAuthorities() {
  return [
    { key: 'bursary', office: 'bursary', title: 'Bursary', required: 1, sort: 1, rules: [{ kind: 'exam', type: 'fees_pct', params: { pct: 100, scope: 'session' } }, { kind: 'test', type: 'fees_pct', params: { pct: 50, scope: 'session' } }] },
    { key: 'registrar', office: 'registrar', title: 'Registrar', required: 1, sort: 2, rules: [{ kind: 'both', type: 'registered', params: { min: 1 } }] },
    { key: 'dean', office: 'dean', title: 'Dean of the faculty', scope_type: 'own_faculty', required: 1, sort: 3, rules: [{ kind: 'exam', type: 'attendance_pct', params: { pct: 75 } }] },
    { key: 'student_affairs', office: 'student_affairs', title: 'Student Affairs', required: 1, sort: 4, rules: [{ kind: 'both', type: 'no_misconduct', params: {} }] },
    { key: 'hod', office: 'hod', title: 'Head of department', scope_type: 'own_department', required: 0, sort: 5, rules: [] },
    { key: 'ict', office: 'ict', title: 'ICT', required: 0, sort: 6, rules: [] },
  ];
}

module.exports = { KINDS, OFFICES, OFFICE_ROLES, RULE_TYPES, STATUSES, SCOPES, normAuthority, normRule, normDecision, concerns, ruleText, checkRule, decisionFor, evaluate, evaluateBoth, publicView, summary, defaultAuthorities };
