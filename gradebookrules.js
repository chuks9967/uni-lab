'use strict';
/**
 * 📝 ONLINE MARK SHEETS — ONE pure module (portal · edge · desk) for a lecturer's marks for a course: continuous
 * assessment + exam per student, saved as a draft any time, SUBMITTED to the head of department, who approves it or
 * returns it with a note; the Registry then imports an approved sheet into result processing (the existing pipeline:
 * review → approve → moderation → publish). Nothing here writes — the callers do.
 *
 *   policyOf(raw, scoreMax)      → { open, ca_max, exam_max, max }   (setting `gradebook_policy`; the split defaults to 30/70 of the standard's maximum)
 *   sheetId(code, session, semester, lecturer) → the ONE sheet per course / term / lecturer (so a draft saved twice is one sheet)
 *   checkRow(row, pol)           → { ok, error, ca, exam, total, mark }   mark: 'ABS' (absent) · 'INC' (incomplete) · ''
 *   normalizeRows(rows, roster, pol) → { rows, errors }   only students of the roster; every value checked
 *   summary(rows, gradeOf)       → { n, scored, missing, absent, incomplete, mean, median, pass_rate, dist, high, low, warnings }
 *   canSubmit(rows, roster)      → { ok, errors }  every student has a mark, or is marked absent / incomplete
 *   canEdit(status)              → a draft or a returned sheet
 *   toBatchRows(rows)            → [{ matric, name, test, exam, score }] for result processing (absent / incomplete stay out — still awaited)
 *   diff(before, after)          → the marks that changed since the last submission (the HOD sees what moved)
 */

const r1 = (v) => Math.round(Number(v) * 10) / 10;
const STATUS = { draft: 'Draft', submitted: 'With the head of department', returned: 'Returned to the lecturer', approved: 'Approved — waiting for the Registry', imported: 'With the Registry (result processing)' };
const MARKS = ['ABS', 'INC'];
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n || 500);
const keyOf = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function policyOf(raw, scoreMax) {
  let p = raw; if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = null; } }
  p = p && typeof p === 'object' ? p : {};
  const max = Number(scoreMax) > 0 ? Number(scoreMax) : 100;
  let ca = Number(p.ca_max), ex = Number(p.exam_max);
  if (!(ca >= 0) || !(ex > 0) || Math.abs(ca + ex - max) > 0.001) { ca = r1(max * 0.3); ex = r1(max - ca); }
  return { open: p.open !== false && p.open !== 0 && p.open !== '0', ca_max: ca, exam_max: ex, max };
}

function sheetId(code, session, semester, lecturer) {
  const raw = [keyOf(code), session || '-', semester || '-', lecturer || '-'].join('|');
  let h = 2166136261; for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return 'gb-' + keyOf(code).toLowerCase() + '-' + h.toString(36);
}

/** One student's marks. Empty = not marked yet (allowed in a draft). */
function checkRow(row, pol) {
  const P = pol || policyOf(null);
  const mark = String((row && row.mark) || '').toUpperCase();
  if (MARKS.includes(mark)) return { ok: true, ca: row.ca === '' || row.ca == null ? null : Number(row.ca), exam: null, total: null, mark };
  const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
  const ca = num(row && row.ca), exam = num(row && row.exam);
  for (const [v, mx, label] of [[ca, P.ca_max, 'CA'], [exam, P.exam_max, 'Exam']]) {
    if (v == null) continue;
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: label + ' must be a number from 0.' };
    if (v > mx + 1e-9) return { ok: false, error: label + ' is out of ' + mx + '.' };
  }
  const total = ca == null && exam == null ? null : r1((ca || 0) + (exam || 0));
  return { ok: true, ca: ca == null ? null : r1(ca), exam: exam == null ? null : r1(exam), total, mark: '' };
}

/** Keep only the roster's students (a lecturer never marks someone outside the class), each value checked. */
function normalizeRows(rows, roster, pol) {
  const byId = new Map((roster || []).map(s => [s.id, s]));
  const out = []; const errors = [];
  for (const r of rows || []) {
    const s = byId.get(r && r.student_id); if (!s) continue;
    const c = checkRow(r, pol);
    if (!c.ok) { errors.push((s.name || s.matric || 'A student') + ': ' + c.error); continue; }
    out.push({ student_id: s.id, matric: s.matric || '', name: s.name || '', ca: c.ca, exam: c.exam, total: c.total, mark: c.mark, note: clean(r.note, 200) || undefined });
  }
  return { rows: out, errors };
}

/** The class at a glance — and what looks wrong before it goes to the head of department. */
function summary(rows, gradeOf) {
  const R = rows || [];
  const scored = R.filter(r => r.total != null && !r.mark);
  const totals = scored.map(r => r.total).sort((a, b) => a - b);
  const g = typeof gradeOf === 'function' ? gradeOf : (t) => ({ grade: t >= 70 ? 'A' : t >= 60 ? 'B' : t >= 50 ? 'C' : t >= 45 ? 'D' : t >= 40 ? 'E' : 'F', pass: t >= 40 });
  const dist = {}; let passed = 0;
  for (const t of totals) { const x = g(t) || {}; dist[x.grade || '?'] = (dist[x.grade || '?'] || 0) + 1; if (x.pass) passed++; }
  const mean = totals.length ? r1(totals.reduce((a, b) => a + b, 0) / totals.length) : null;
  const median = totals.length ? (totals.length % 2 ? totals[(totals.length - 1) / 2] : r1((totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2)) : null;
  const passRate = totals.length ? Math.round(passed / totals.length * 100) : null;
  const missing = R.filter(r => r.total == null && !r.mark).length;
  const warnings = [];
  if (missing) warnings.push(missing + ' student(s) have no mark yet');
  if (totals.length >= 5 && passRate != null && passRate < 30) warnings.push('Only ' + passRate + '% passed — unusually low');
  if (totals.length >= 5 && passRate === 100 && mean >= 80) warnings.push('Everyone passed with a high average (' + mean + ') — please check');
  if (totals.length >= 5 && new Set(totals).size === 1) warnings.push('Every student has the same mark (' + totals[0] + ')');
  const noExam = scored.filter(r => r.exam == null).length;
  if (noExam) warnings.push(noExam + ' student(s) have CA but no exam mark');
  return { n: R.length, scored: totals.length, missing, absent: R.filter(r => r.mark === 'ABS').length, incomplete: R.filter(r => r.mark === 'INC').length,
    mean, median, pass_rate: passRate, dist, high: totals.length ? totals[totals.length - 1] : null, low: totals.length ? totals[0] : null, warnings };
}

/** Ready to submit: every student of the class has a mark, or is marked absent / incomplete. */
function canSubmit(rows, roster) {
  const have = new Map((rows || []).map(r => [r.student_id, r]));
  const errors = [];
  const gaps = (roster || []).filter(s => { const r = have.get(s.id); return !r || (r.total == null && !r.mark); });
  if (gaps.length) errors.push(gaps.length + ' student(s) still need a mark (or “absent” / “incomplete”): ' + gaps.slice(0, 5).map(s => s.name || s.matric).join(', ') + (gaps.length > 5 ? '…' : ''));
  if (!(rows || []).length) errors.push('There is nobody on this sheet.');
  return { ok: !errors.length, errors };
}

const canEdit = (status) => !status || status === 'draft' || status === 'returned';

/** Rows for result processing — matched by matric number; absent / incomplete stay out (their result is still awaited). */
function toBatchRows(rows) {
  return (rows || []).filter(r => !r.mark && r.total != null && r.matric).map(r => ({ matric: r.matric, name: r.name, test: r.ca == null ? 0 : r.ca, exam: r.exam == null ? 0 : r.exam, score: r.total }));   // the fields result processing reads (test · exam · score)
}

/** What changed between two versions of a sheet (the head of department sees what moved after a return). */
function diff(before, after) {
  const a = new Map((before || []).map(r => [r.student_id, r])); const out = [];
  for (const r of after || []) {
    const p = a.get(r.student_id);
    const same = p && p.ca === r.ca && p.exam === r.exam && (p.mark || '') === (r.mark || '');
    if (!same) out.push({ student_id: r.student_id, name: r.name, from: p ? (p.mark || p.total) : null, to: r.mark || r.total });
  }
  return out;
}

/**
 * 📝 Coursework so far for each student of the class — the marks of graded assignments out of what they were worth,
 * scaled to the CA maximum: a SUGGESTION the lecturer may take for the CA. An assignment not handed in once it closed
 * counts 0; one handed in but not graded yet is left out of both sides (it is not a mark yet).
 */
function courseworkCA(assignments, submissions, studentIds, caMax, now) {
  const t = now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now));
  const subs = new Map(); for (const s of submissions || []) if (s) subs.set(s.assignment_id + '|' + s.student_id, s);
  const out = {};
  for (const sid of studentIds || []) {
    let got = 0, max = 0, n = 0;
    for (const a of assignments || []) {
      const m = Number(a && a.max_score) || 0; if (!m) continue;
      const s = subs.get(a.id + '|' + sid);
      const closed = Date.parse(a.late_until || a.due_at || '') < t;
      if (s && s.status === 'graded' && s.score != null && s.score !== '') { got += Number(s.score) || 0; max += m; n++; }
      else if (!s && closed) { max += m; n++; }
    }
    out[sid] = { got: r1(got), max: r1(max), n, suggest: max > 0 ? r1(Math.min(caMax, got / max * caMax)) : null };
  }
  return out;
}

/** Each student's attendance in the course, from its registers: { pct, held, attended } (excused classes left out). */
function attendanceOf(registers, studentIds) {
  const out = {}; for (const sid of studentIds || []) out[sid] = { held: 0, attended: 0, excused: 0 };
  for (const r of registers || []) {
    let marks = r && r.marks; if (typeof marks === 'string') { try { marks = JSON.parse(marks); } catch (_) { marks = {}; } }
    if (!marks || !Object.keys(marks).length) continue;
    for (const sid of studentIds || []) {
      const m = marks[sid]; const o = out[sid]; o.held++;
      if (m === 'p' || m === 'l') o.attended++; else if (m === 'e') o.excused++;
    }
  }
  for (const sid of Object.keys(out)) { const o = out[sid]; const d = Math.max(1, o.held - o.excused); o.pct = o.held ? Math.round(o.attended / d * 100) : null; }
  return out;
}

module.exports = { STATUS, MARKS, policyOf, sheetId, checkRow, normalizeRows, summary, canSubmit, canEdit, toBatchRows, diff, keyOf, courseworkCA, attendanceOf };
