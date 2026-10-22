'use strict';
/**
 * 📝 COURSE REGISTRATION RULES — pure, shared by the desktop, the cloud portal and the Supabase edge, so a
 * student's registration is judged by exactly the same rules wherever it is made.
 *
 *   isOpen(window, now)          — is registration (add) / drop open right now?
 *   parseReqs(text)              — "CSC101, MTH101" (all of) · "CSC101 | CSC102" / "CSC101 or CSC102" (either)
 *   unmet(text, passed)          — which prerequisite groups a student has NOT yet passed
 *   offerings(o)                 — the courses a student may register this term, each with its kind
 *                                  (core / elective / carry-over), prerequisites, seats and current status
 *   planCart(o)                  — validate a selection: offered? prerequisites? co-requisites? the credit-load
 *                                  limits of the institution's standard? → a decision per course:
 *                                  registered · pending (adviser approval) · waitlisted (course full)
 *   waitlistToPromote(o)         — when a seat frees up, who moves up (first come, first served)
 */

const ck = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ACTIVE = ['registered', 'pending'];

// the teaching block of a term / course — identical to electron/services/courses.js (Summer → 1; a course with no
// stored semester follows the code-parity convention: CSC 101 → 1, CSC 102 → 2)
function normSemester(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v === 2 ? 2 : 1;
  const s = String(v).trim().toLowerCase(); if (!s) return null;
  if (/(^|\b)(2|2nd|second|two|ii|rain|spring)\b/.test(s)) return 2;
  if (/(^|\b)(1|1st|first|one|i|harmattan|summer|fall|autumn)\b/.test(s)) return 1;
  const n = Number(s.replace(/[^0-9]/g, '')); if (n === 2) return 2; if (n >= 1) return 1;
  return null;
}
function semesterFromCode(code) { const d = String(code || '').replace(/\D/g, ''); if (!d) return 1; return Number(d[d.length - 1]) % 2 === 0 ? 2 : 1; }
const blockOfCourse = (c) => normSemester(c && c.semester) || semesterFromCode(c && c.code);

/** Registration window: { open, from, to, dropUntil, session_id, semester_id, approval, enforceMin }. */
function isOpen(win, now) {
  const w = win || {}; const t = now ? new Date(now) : new Date();
  const day = (s) => s ? new Date(String(s).length <= 10 ? s + 'T23:59:59' : s) : null;
  const from = w.from ? new Date(String(w.from).length <= 10 ? w.from + 'T00:00:00' : w.from) : null;
  const to = day(w.to); const dropUntil = day(w.dropUntil) || to;
  if (!w.open) return { open: false, drop: false, reason: 'Course registration is closed.' };
  if (from && t < from) return { open: false, drop: false, reason: `Course registration opens on ${String(w.from).slice(0, 10)}.` };
  const addOpen = !to || t <= to;
  const dropOpen = !dropUntil || t <= dropUntil;
  return { open: addOpen, drop: dropOpen, reason: addOpen ? '' : `Course registration closed on ${String(w.to).slice(0, 10)}.` };
}

/** "A, B | C; D or E" → [["A"], ["B","C"], ["D","E"]] — every group must be met; any code in a group meets it. */
function parseReqs(text) {
  return String(text || '').split(/[,;&]|\band\b/i).map(g => g.split(/\||\/|\bor\b/i).map(ck).filter(Boolean)).filter(g => g.length);
}
/** The prerequisite groups not yet met, as readable strings ("CSC101", "CSC102 or CSC103"). */
function unmet(text, passed) {
  const has = (c) => passed && (passed.has ? passed.has(c) : passed.includes(c));
  return parseReqs(text).filter(g => !g.some(has)).map(g => g.join(' or '));
}

/**
 * Courses a student may register.
 *  o.courses  — catalogue rows {id, code, title, credit_unit, department_id, faculty_id, level_id, semester, prerequisites, corequisites, capacity, is_elective}
 *  o.student  — {department_id, faculty_id, level_id}
 *  o.passed   — Set of codeKeys passed · o.failed — Set of codeKeys failed and not yet passed (carry-overs)
 *  o.regs     — this student's registrations {id, course_code, status, kind, source, created_at}
 *  o.counts   — { codeKey: seats taken (registered + pending) }
 *  o.block    — the teaching block (1, 2, 3…) of the term being registered, or null
 */
function offerings(o) {
  const x = o || {}; const st = x.student || {}; const passed = x.passed || new Set(); const failed = x.failed || new Set();
  const regs = (x.regs || []).filter(r => r.status !== 'dropped');
  const regOf = (k) => regs.find(r => ck(r.course_code) === k) || null;
  const counts = x.counts || {};
  const inBlock = (c) => !x.block || blockOfCourse(c) === Number(x.block);
  const seen = new Set(); const out = [];
  const push = (c, kind) => {
    const k = ck(c.code); if (!k || seen.has(k)) return; seen.add(k);
    const reg = regOf(k);
    const cap = Number(c.capacity) || 0; const taken = Number(counts[k]) || 0;
    const miss = unmet(c.prerequisites, passed);
    out.push({
      course_id: c.id || null, code: String(c.code).toUpperCase().trim(), title: c.title || '', units: Number(c.credit_unit) || 0, kind,
      compulsory: kind === 'core' || kind === 'carryover', prerequisites: c.prerequisites || '', corequisites: c.corequisites || '', unmet: miss,
      eligible: !miss.length, capacity: cap, taken, seatsLeft: cap ? Math.max(0, cap - taken) : null, full: !!cap && taken >= cap,
      status: reg ? reg.status : null, regId: reg ? reg.id : null, self: !!(reg && reg.source === 'self'),
    });
  };
  // carry-overs first (they must be registered), then the programme's own courses, then open electives
  for (const k of failed) { if (passed.has(k)) continue; const c = (x.courses || []).find(r => ck(r.code) === k); if (c) push(c, 'carryover'); }
  for (const c of x.courses || []) {
    if (c.department_id !== st.department_id || c.level_id !== st.level_id || !inBlock(c) || passed.has(ck(c.code))) continue;
    push(c, Number(c.is_elective) ? 'elective' : 'core');
  }
  for (const c of x.courses || []) {
    if (!Number(c.is_elective) || c.level_id !== st.level_id || c.department_id === st.department_id || !inBlock(c) || passed.has(ck(c.code))) continue;
    if (st.faculty_id && c.faculty_id && c.faculty_id !== st.faculty_id && !Number(c.open_elective)) continue;
    push(c, 'elective');
  }
  // anything the student is ALREADY registered for that the catalogue above did not surface (borrowed, older term)
  for (const r of regs) { const k = ck(r.course_code); if (!seen.has(k)) { seen.add(k); out.push({ course_id: r.course_id || null, code: String(r.course_code || '').toUpperCase(), title: r.course_title || '', units: Number(r.credit_unit) || 0, kind: r.kind || 'core', compulsory: false, prerequisites: '', corequisites: '', unmet: [], eligible: true, capacity: 0, taken: 0, seatsLeft: null, full: false, status: r.status, regId: r.id, self: r.source === 'self' }); } }
  return out;
}

/**
 * Validate a selection of NEW courses (codes) on top of what is already registered.
 *  o.items (offerings) · o.selected (codes) · o.load {min, max} (from the standard) · o.approval 'none'|'adviser'
 *  o.enforceMin — block below-minimum submissions (default: warn only)
 */
function planCart(o) {
  const x = o || {}; const items = x.items || [];
  const byK = new Map(items.map(i => [ck(i.code), i]));
  const sel = [...new Set((x.selected || []).map(ck).filter(Boolean))];
  const errors = []; const warnings = []; const decisions = [];
  const active = items.filter(i => ACTIVE.includes(i.status));
  const activeK = new Set(active.map(i => ck(i.code)));
  const newItems = [];
  for (const k of sel) {
    const it = byK.get(k);
    if (!it) { errors.push(`${k} is not offered to you this term.`); continue; }
    if (activeK.has(k)) continue;                                   // already registered / pending — nothing to do
    if (it.status === 'waitlisted') { warnings.push(`${it.code} — you are already on the waiting list.`); continue; }
    if (it.unmet.length) { errors.push(`${it.code} needs ${it.unmet.join(' and ')} first.`); continue; }
    newItems.push(it);
  }
  // co-requisites: passed, already registered, or in this same selection
  const willHave = new Set([...activeK, ...newItems.map(i => ck(i.code))]);
  for (const it of newItems) {
    const missing = parseReqs(it.corequisites).filter(g => !g.some(c => willHave.has(c) || (x.passed && x.passed.has && x.passed.has(c))));
    if (missing.length) errors.push(`${it.code} must be taken together with ${missing.map(g => g.join(' or ')).join(' and ')}.`);
  }
  const units = active.reduce((a, i) => a + i.units, 0) + newItems.filter(i => !i.full).reduce((a, i) => a + i.units, 0);
  const L = x.load || {};
  if (L.max != null && units > L.max) errors.push(`That makes ${units} credits — above the maximum of ${L.max} for a term.`);
  if (L.min != null && units > 0 && units < L.min) (x.enforceMin ? errors : warnings).push(`That makes ${units} credits — below the minimum of ${L.min} for a term.`);
  // ⏰ two of the courses meet at the same time on the lecture timetable — the student cannot sit in both (common
  // with carry-overs). A warning, not a refusal: the department may run another stream, and it is their call.
  if (x.slots && x.slots.length) for (const c of timetableClashes([...willHave], x.slots)) if (newItems.some(i => ck(i.code) === ck(c.a) || ck(i.code) === ck(c.b))) warnings.push(`${c.a} and ${c.b} meet at the same time (${c.when}) — check with your department before you rely on both.`);
  const missingCarry = items.filter(i => i.kind === 'carryover' && !ACTIVE.includes(i.status) && !willHave.has(ck(i.code)));
  if (missingCarry.length) warnings.push(`Carry-over course(s) not yet registered: ${missingCarry.map(i => i.code).join(', ')}.`);
  if (!errors.length) for (const it of newItems) decisions.push({ code: it.code, course_id: it.course_id, title: it.title, units: it.units, kind: it.kind, status: it.full ? 'waitlisted' : (x.approval === 'adviser' ? 'pending' : 'registered') });
  return { ok: !errors.length, errors, warnings, units, decisions };
}

/**
 * Lecture-timetable clashes among a set of course codes. slots = [{ course_code, day_or_date, start_time, end_time, kind }]
 * (lectures only — exams and holidays are ignored). → [{ a, b, when: 'Monday 10:00–12:00' }] (each pair once)
 */
function timetableClashes(codes, slots) {
  const want = new Set((codes || []).map(ck).filter(Boolean));
  const mins = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const list = (slots || []).filter(s => s && !Number(s.deleted) && (!s.kind || s.kind === 'class' || s.kind === 'lecture') && want.has(ck(s.course_code)))
    .map(s => ({ code: String(s.course_code).toUpperCase().trim(), k: ck(s.course_code), day: String(s.day_or_date || '').trim().toLowerCase(), dayLabel: String(s.day_or_date || '').trim(), a: mins(s.start_time), b: mins(s.end_time), start: s.start_time, end: s.end_time }))
    .filter(s => s.day && s.a != null && s.b != null && s.b > s.a);
  const out = []; const seen = new Set();
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const p = list[i], q = list[j];
    if (p.k === q.k || p.day !== q.day || !(p.a < q.b && q.a < p.b)) continue;
    const key = [p.k, q.k].sort().join('|'); if (seen.has(key)) continue; seen.add(key);
    out.push({ a: p.code, b: q.code, when: p.dayLabel + ' ' + p.start + '–' + p.end });
  }
  return out;
}

/** A seat freed on a course: the waitlisted registrations (oldest first) that now fit. */
function waitlistToPromote(o) {
  const x = o || {}; const cap = Number(x.capacity) || 0;
  const wl = (x.regs || []).filter(r => r.status === 'waitlisted').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (!cap) return wl;                                   // capacity removed → everyone waiting gets in
  const free = Math.max(0, cap - (Number(x.taken) || 0));
  return wl.slice(0, free);
}

module.exports = { ck, isOpen, parseReqs, unmet, offerings, planCart, waitlistToPromote, timetableClashes, normSemester, semesterFromCode, blockOfCourse, ACTIVE };
