'use strict';
/**
 * ♿ SUPPORT PLANS (accommodations) — ONE pure module (desk · portal · edge) for a student's standing support plan, granted once by
 * Student Affairs (disability / welfare office) and applied EVERYWHERE without anyone re-asking:
 *   • extra time in every online exam (a percentage of the paper's time, plus rest breaks),
 *   • extra days on every coursework deadline,
 *   • what invigilators and lecturers must provide (a separate room, large print, a reader / scribe, rest breaks,
 *     captions, front seating, assistive technology).
 *
 * PRIVACY BY DESIGN: there is NO field for a diagnosis or a condition — only WHAT to provide, and a pointer to the
 * evidence kept at the office ("letter on file, ref …"). Staff see `staffView` (what to do); the student sees their
 * own plan; nobody sees why.
 *
 *   NEEDS                      the support that can be named (key → label)
 *   validate(input)            → { ok, plan | error }
 *   current(rows, sid, today)  → the plan in force for a student today (active, within its dates) or null
 *   examExtraMinutes(plan, durationMin) → minutes added to a paper (percentage, at least 5, plus 10 per rest break hour)
 *   courseworkDays(plan)       → extra days on a deadline
 *   shiftAssignment(a, days)   → the assignment as THIS student sees it (due / late-until moved by `days`)
 *   staffView(plan)            → "Extra time +25% · Separate room · Large print" — what to provide, never why
 */
const NEEDS = {
  separate_room: 'Separate room', large_print: 'Large print', reader: 'Reader', scribe: 'Scribe', rest_breaks: 'Rest breaks',
  captions: 'Captions / transcripts', front_seat: 'Front seat', assistive_tech: 'Assistive technology', ergonomic: 'Adapted seating',
};
const PCTS = [0, 10, 15, 25, 33, 50, 100];
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n || 500); // eslint-disable-line no-control-regex
const day = (v) => String(v || '').slice(0, 10);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(day(v));

function validate(input) {
  const x = input || {};
  const pct = Number(x.extra_time_pct) || 0;
  if (!PCTS.includes(pct)) return { ok: false, error: 'Extra time is one of ' + PCTS.filter(Boolean).join(', ') + ' %.' };
  const days = Math.round(Number(x.coursework_days) || 0);
  if (days < 0 || days > 14) return { ok: false, error: 'Extra coursework days: 0 to 14.' };
  const needs = [...new Set((Array.isArray(x.needs) ? x.needs : String(x.needs || '').split(',')).map(s => String(s).trim()).filter(k => NEEDS[k]))];
  if (!pct && !days && !needs.length) return { ok: false, error: 'Choose at least one support (extra time, coursework days or a need).' };
  if (!isDay(x.valid_from)) return { ok: false, error: 'Choose the date it starts.' };
  if (x.valid_to && (!isDay(x.valid_to) || day(x.valid_to) < day(x.valid_from))) return { ok: false, error: 'The end date must be on or after the start.' };
  const evidence = clean(x.evidence_ref, 200);
  if (evidence.length < 3) return { ok: false, error: 'Say where the supporting document is kept (e.g. “Letter on file — Student Affairs, ref SA/24/031”).' };
  return { ok: true, plan: { extra_time_pct: pct, coursework_days: days, needs, staff_note: clean(x.staff_note, 300) || null, evidence_ref: evidence, valid_from: day(x.valid_from), valid_to: x.valid_to ? day(x.valid_to) : null } };
}

function current(rows, studentId, today) {
  const t = day(today || new Date().toISOString());
  return (rows || []).filter(r => r && !Number(r.deleted) && r.student_id === studentId && r.status !== 'ended' && day(r.valid_from) <= t && (!r.valid_to || day(r.valid_to) >= t))
    .sort((a, b) => String(b.valid_from).localeCompare(String(a.valid_from)))[0] || null;
}

const needsOf = (p) => { if (!p) return []; let n = p.needs; if (typeof n === 'string') { try { n = JSON.parse(n); } catch (_) { n = []; } } return (n || []).filter(k => NEEDS[k]); };

function examExtraMinutes(plan, durationMin) {
  if (!plan) return 0; const d = Math.max(0, Number(durationMin) || 0);
  const pct = Number(plan.extra_time_pct) || 0;
  let m = pct ? Math.max(5, Math.round(d * pct / 100)) : 0;
  if (needsOf(plan).includes('rest_breaks')) m += Math.max(5, Math.round(d / 60 * 10));
  return m;
}
const courseworkDays = (plan) => (plan ? Math.max(0, Math.min(14, Number(plan.coursework_days) || 0)) : 0);

function shiftAssignment(a, days) {
  if (!a || !(days > 0)) return a;
  // coursework times are the institution's WALL CLOCK "YYYY-MM-DDTHH:MM" — moved as wall-clock days and kept in that form
  // (parsing them as this machine's local time and returning UTC shifted the deadline by the time zone)
  const add = (v) => { const s = String(v || '').replace(' ', 'T').slice(0, 16); const t = Date.parse(s + ':00Z'); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && Number.isFinite(t) ? new Date(t + days * 864e5).toISOString().slice(0, 16) : v; };
  return Object.assign({}, a, { due_at: a.due_at ? add(a.due_at) : a.due_at, late_until: a.late_until ? add(a.late_until) : a.late_until, accommodated_days: days });
}

function staffView(plan) {
  if (!plan) return '';
  const parts = [];
  if (Number(plan.extra_time_pct)) parts.push('Extra time +' + plan.extra_time_pct + '%');
  for (const k of needsOf(plan)) parts.push(NEEDS[k]);
  if (courseworkDays(plan)) parts.push('Coursework +' + courseworkDays(plan) + ' day(s)');
  return parts.join(' · ');
}

module.exports = { NEEDS, PCTS, validate, current, examExtraMinutes, courseworkDays, shiftAssignment, staffView, needsOf };
