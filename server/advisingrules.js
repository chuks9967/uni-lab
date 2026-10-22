'use strict';
/**
 * 🧭 ACADEMIC ADVISING — pure rules shared by the desktop (Registry assigns advisers) and the portal (advisers
 * see their advisees, approve pending course registrations, keep advising notes; students see their adviser).
 *
 *  • A class adviser covers a department + level ("level coordinator"); a personal adviser for one student
 *    overrides the class adviser.
 *  • Notes are private to advisers and the Registry unless the adviser shares one with the student.
 *  • At-risk flags come from the student's standing (probation / withdrawal), CGPA and carry-overs.
 */
const CATEGORIES = ['academic', 'registration', 'career', 'personal', 'other'];
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n || 4000); // eslint-disable-line no-control-regex
const alive = (r) => r && !Number(r.deleted);

/** The assignment that applies to a student: personal first, then the class adviser for their department + level. */
function adviserFor(s, assignments) {
  if (!s) return null;
  const live = (assignments || []).filter(alive);
  return live.find(a => a.scope === 'student' && a.student_id === s.id)
    || live.find(a => a.scope === 'cohort' && a.department_id && a.department_id === s.department_id && a.level_id && a.level_id === s.level_id)
    || null;
}
/** Students advised by this staff member (a personal assignment to someone else wins over the class adviser). */
function adviseesOf(staffId, assignments, students) {
  const out = [];
  for (const s of students || []) { if (!alive(s) || ['graduated', 'alumni', 'withdrawn', 'deceased', 'expelled'].includes(String(s.status || '').toLowerCase())) continue; const a = adviserFor(s, assignments); if (a && a.staff_id === staffId) out.push(s); }
  return out;
}
function validateNote(input) {
  const body = clean(input && input.body, 4000); if (body.length < 3) throw new Error('Write the note.');
  const category = CATEGORIES.includes(input && input.category) ? input.category : 'academic';
  return { body, category, shared: input && (input.shared === true || input.shared === 1 || input.shared === '1' || input.shared === 'true') ? 1 : 0 };
}
/** Flags an adviser should act on. standing: { status, outstanding[] } from the standards engine; cgpa on the institution's scale (maxPoint). */
function riskFlags(o) {
  const x = o || {}; const f = [];
  const st = String((x.standing && x.standing.status) || '').toLowerCase();
  if (/withdraw|dismiss/.test(st)) f.push({ key: 'withdrawal', label: 'Advised to withdraw', level: 'high' });
  else if (/probation/.test(st)) f.push({ key: 'probation', label: 'On probation', level: 'high' });
  const max = Number(x.maxPoint) || 5;
  if (x.cgpa != null && x.units > 0 && Number(x.cgpa) < max * 0.3) f.push({ key: 'low_cgpa', label: 'CGPA ' + x.cgpa, level: 'high' });
  else if (x.cgpa != null && x.units > 0 && Number(x.cgpa) < max * 0.45) f.push({ key: 'cgpa_watch', label: 'CGPA ' + x.cgpa, level: 'medium' });
  const co = ((x.standing && x.standing.outstanding) || []).length;
  if (co >= 3) f.push({ key: 'carryovers', label: co + ' carry-overs', level: 'high' }); else if (co) f.push({ key: 'carryovers', label: co + ' carry-over' + (co > 1 ? 's' : ''), level: 'medium' });
  if (x.pending) f.push({ key: 'pending', label: x.pending + ' registration' + (x.pending > 1 ? 's' : '') + ' to approve', level: 'action' });
  // ⏰ THIS TERM — the early signs, before the results show it (term = termSignals(...) for this student + the GPA trend)
  const tm = x.term || {}; const th = Number(x.threshold) || 75;
  const low = (tm.attendance || []).filter(c => c.held >= 3 && c.pct != null && c.pct < th);
  if (low.length) f.push({ key: 'attendance', label: (x.barExams ? 'Barred from ' : 'Low attendance: ') + low.map(c => c.course_code + ' ' + c.pct + '%').join(', '), level: x.barExams || low.length >= 2 ? 'high' : 'medium', courses: low.map(c => c.course_code) });
  if (tm.missed >= 3) f.push({ key: 'missed_work', label: tm.missed + ' assignments not handed in', level: 'high' });
  else if (tm.missed) f.push({ key: 'missed_work', label: tm.missed + ' assignment' + (tm.missed > 1 ? 's' : '') + ' not handed in', level: 'medium' });
  const sems = (x.semesters || []).filter(s => s && s.gpa != null);
  if (sems.length >= 2) {
    const drop = Number(sems[sems.length - 2].gpa) - Number(sems[sems.length - 1].gpa);
    if (drop >= max * 0.2 - 1e-9) f.push({ key: 'gpa_drop', label: 'GPA fell ' + Math.round(drop * 100) / 100 + ' last term', level: 'high' });
    else if (drop >= max * 0.1 - 1e-9) f.push({ key: 'gpa_drop', label: 'GPA fell ' + Math.round(drop * 100) / 100 + ' last term', level: 'medium' });
  }
  if (x.notRegistered) f.push({ key: 'not_registered', label: 'Not registered yet — registration is open', level: 'medium' });
  return f;
}
const riskLevel = (flags) => (flags || []).some(f => f.level === 'high') ? 'high' : (flags || []).some(f => f.level === 'medium') ? 'medium' : 'ok';

/**
 * The term's signals for MANY students in one pass (an adviser's list must not re-read every register per student):
 *   → Map(student id → { attendance: [{ course_code, held, attended, excused, pct }], missed })
 * Attendance follows the portal's per-student rule (studentAttendance): a register concerns a student who is marked on
 * it, or — when nobody is registered for the course, or they are — anyone of its cohort. Missed = assignments of the
 * student's cohort that have closed with nothing handed in. Only this session's registers / assignments count.
 */
function termSignals(o) {
  const x = o || {}; const t = x.now == null ? Date.now() : (typeof x.now === 'number' ? x.now : Date.parse(x.now));
  const key = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const thisTerm = (r) => !x.sessionId || !r.session_id || r.session_id === x.sessionId;
  const regs = new Map();
  for (const r of x.registrations || []) { if (!alive(r) || r.status !== 'registered') continue; const k = key(r.course_code) || r.course_id; if (!k) continue; let s = regs.get(k); if (!s) regs.set(k, s = new Set()); s.add(r.student_id); }
  const groups = new Map(); const out = new Map();
  for (const s of x.students || []) { const g = s.department_id + '|' + s.level_id; let a = groups.get(g); if (!a) groups.set(g, a = []); a.push(s); out.set(s.id, { attendance: new Map(), missed: 0 }); }
  for (const r of x.registers || []) {
    if (!alive(r) || !thisTerm(r)) continue;
    const grp = groups.get(r.department_id + '|' + r.level_id); if (!grp) continue;
    let marks = r.marks; if (typeof marks === 'string') { try { marks = JSON.parse(marks); } catch (_) { marks = {}; } }
    if (!marks || !Object.keys(marks).length) continue;
    const ck = key(r.course_code) || r.course_id || '?'; const reg = regs.get(ck); const k = ck + '|' + (r.semester_id || '');
    for (const s of grp) {
      if (marks[s.id] === undefined && reg && !reg.has(s.id)) continue;
      const m = out.get(s.id).attendance; let c = m.get(k); if (!c) m.set(k, c = { course_code: r.course_code, held: 0, attended: 0, excused: 0 });
      c.held++; const v = marks[s.id]; if (v === 'p' || v === 'l') c.attended++; else if (v === 'e') c.excused++;
    }
  }
  const handed = new Set((x.submissions || []).filter(alive).map(sb => sb.assignment_id + '|' + sb.student_id));
  for (const a of x.assignments || []) {
    if (!alive(a) || !thisTerm(a)) continue;
    const closes = Date.parse(a.late_until || a.due_at || ''); if (!(closes < t)) continue;
    for (const s of groups.get(a.department_id + '|' + a.level_id) || []) if (!handed.has(a.id + '|' + s.id)) out.get(s.id).missed++;
  }
  for (const v of out.values()) v.attendance = [...v.attendance.values()].map(c => Object.assign(c, { pct: c.held ? Math.round(c.attended / Math.max(1, c.held - c.excused) * 100) : null }));
  return out;
}

/** A first message an adviser can send (and edit) — about the most pressing sign. */
function checkInText(firstName, flags) {
  const hi = 'Hi ' + (firstName || 'there') + ', ';
  const f = (k) => (flags || []).find(x => x.key === k);
  const end = ' Is everything all right? Reply here, or come and see me this week.';
  if (f('attendance')) return hi + 'I see you have missed several classes in ' + (f('attendance').courses || []).join(', ') + '.' + end;
  if (f('missed_work')) return hi + 'I see some of your assignments have not been handed in.' + end;
  if (f('gpa_drop')) return hi + 'your last results dipped. Let us look at what happened and plan this term together.' + end;
  if (f('probation') || f('withdrawal') || f('low_cgpa')) return hi + 'I would like us to plan the coming term together so your results pick up.' + end;
  if (f('carryovers') || f('cgpa_watch')) return hi + 'let us look at your courses to retake and plan this term so your CGPA climbs.' + end;
  if (f('not_registered')) return hi + 'course registration is open and you have not registered yet — do you need help choosing your courses?';
  return hi + 'just checking in — how is the term going?';
}

module.exports = { CATEGORIES, adviserFor, adviseesOf, validateNote, riskFlags, riskLevel, termSignals, checkInText, clean };
