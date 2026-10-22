'use strict';
/**
 * 📅 THE ACADEMIC CALENDAR — pure rules shared by the desktop, the portal (LAN / cloud / edge) and the app.
 *
 * One calendar per semester: the KEY DATES (the semester itself, course registration, the end of add/drop, lectures, the
 * mid-semester break, revision, examinations, results) plus holidays, closures and events. Everything that has a date
 * reads it from here — the registration window, the welcome pack, reminders, the student's phone calendar.
 *
 *   KINDS                 what an entry can be, and whether it spans days
 *   validate(ev)          a clean entry, or the reason it is refused
 *   checkTerm(evs, others) contradictions a registry would want to know before publishing (exams before lectures end …)
 *   status(evs, today)    "Week 7 of First Semester — lectures · Mid-semester break in 5 days"
 *   upcoming(evs, today, days)   what is coming, soonest first
 *   dueReminders(evs, today)     the entries whose reminder is due today (registration closing, add/drop, exams, fees)
 *   termIds / keyId       one stable id per semester and key date (re-saving the key dates never duplicates)
 *
 * Dates are plain calendar dates (YYYY-MM-DD); an entry's `end_date` is inclusive. Nothing here touches a database.
 */

const KINDS = [
  { key: 'term', label: 'Semester', range: true, key_date: true, icon: '🎓' },
  { key: 'registration', label: 'Course registration', range: true, key_date: true, icon: '📝', remind: { at: 'end', days: 3 } },
  { key: 'add_drop', label: 'End of add / drop', range: false, key_date: true, icon: '🔁', remind: { at: 'start', days: 3 } },
  { key: 'lectures', label: 'Lectures', range: true, key_date: true, icon: '📚' },
  { key: 'break', label: 'Mid-semester break', range: true, key_date: true, icon: '🌴' },
  { key: 'revision', label: 'Revision week', range: true, key_date: true, icon: '📖' },
  { key: 'exams', label: 'Examinations', range: true, key_date: true, icon: '✍️', remind: { at: 'start', days: 7 } },
  { key: 'results', label: 'Results released', range: false, key_date: true, icon: '📑' },
  { key: 'fees_due', label: 'Fees deadline', range: false, key_date: false, icon: '💳', remind: { at: 'start', days: 7 } },
  { key: 'holiday', label: 'Public holiday / closure', range: true, key_date: false, icon: '🏖' },
  { key: 'matriculation', label: 'Matriculation', range: false, key_date: false, icon: '🎒' },
  { key: 'convocation', label: 'Convocation', range: false, key_date: false, icon: '🎓' },
  { key: 'event', label: 'Event', range: true, key_date: false, icon: '📌' },
];
const BY = {}; for (const k of KINDS) BY[k.key] = k;
const AUDIENCES = ['all', 'students', 'staff'];
const DAY = 86400000;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && Number.isFinite(Date.parse(String(s) + 'T00:00:00Z'));
const t = (s) => Date.parse(String(s).slice(0, 10) + 'T00:00:00Z');
const days = (a, b) => Math.round((t(b) - t(a)) / DAY);
const endOf = (e) => (e && (e.end_date || e.start_date)) || null;
const addDays = (d, n) => new Date(t(d) + n * DAY).toISOString().slice(0, 10);

/** → { ok, value } with a clean entry, or { ok:false, error } */
function validate(ev) {
  const e = ev || {}; const k = BY[e.kind];
  if (!k) return { ok: false, error: 'Choose what kind of date this is.' };
  const title = String(e.title || '').trim() || k.label;
  if (title.length > 140) return { ok: false, error: 'Keep the title under 140 characters.' };
  if (!isDate(e.start_date)) return { ok: false, error: 'Give the date (YYYY-MM-DD).' };
  let end = e.end_date ? String(e.end_date).slice(0, 10) : null;
  if (end && !isDate(end)) return { ok: false, error: 'The end date is not a date.' };
  if (!k.range) end = null;
  if (k.range && !end) end = String(e.start_date).slice(0, 10);
  if (end && end < String(e.start_date).slice(0, 10)) return { ok: false, error: 'The end date is before the start date.' };
  if (end && days(e.start_date, end) > 400) return { ok: false, error: 'An entry cannot span more than about a year.' };
  const audience = AUDIENCES.includes(e.audience) ? e.audience : 'all';
  return { ok: true, value: { kind: k.key, title, start_date: String(e.start_date).slice(0, 10), end_date: end, audience, notes: String(e.notes || '').trim().slice(0, 500) || null } };
}

const first = (evs, kind) => (evs || []).filter(e => e.kind === kind).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))[0] || null;
const inside = (d, e) => e && d >= e.start_date && d <= endOf(e);

/** Contradictions in one semester's calendar → [{ level: 'error'|'warn', text }]. `others` = the other semesters' term entries. */
function checkTerm(evs, others) {
  const out = []; const err = (text) => out.push({ level: 'error', text }); const warn = (text) => out.push({ level: 'warn', text });
  const term = first(evs, 'term'), lec = first(evs, 'lectures'), ex = first(evs, 'exams'), reg = first(evs, 'registration'), ad = first(evs, 'add_drop'), res = first(evs, 'results'), brk = first(evs, 'break');
  if (!term) warn('The semester has no start and end dates yet.');
  if (!ex) warn('No examination period yet.');
  if (term) for (const e of evs || []) if (e.kind !== 'term' && e.kind !== 'registration' && e.kind !== 'holiday' && e.kind !== 'event' && e.kind !== 'results' && e.kind !== 'fees_due' && e.kind !== 'convocation' && e.kind !== 'matriculation' && e.start_date && (e.start_date < term.start_date || endOf(e) > endOf(term)))
    err((BY[e.kind] || {}).label + ' (' + e.start_date + (e.end_date && e.end_date !== e.start_date ? ' → ' + e.end_date : '') + ') falls outside the semester (' + term.start_date + ' → ' + endOf(term) + ').');
  if (lec && ex && ex.start_date <= endOf(lec)) err('Examinations start (' + ex.start_date + ') before lectures end (' + endOf(lec) + ').');
  if (reg && term && endOf(reg) > endOf(term)) err('Course registration closes after the semester ends.');
  if (reg && term && days(reg.start_date, term.start_date) > 90) warn('Registration opens more than three months before the semester.');
  if (reg && lec && days(lec.start_date, endOf(reg)) > 21) warn('Registration stays open more than three weeks into lectures.');
  if (ad && lec && days(lec.start_date, ad.start_date) > 28) warn('Add / drop ends more than four weeks into lectures — students would be dropping late in the course.');
  if (ad && reg && ad.start_date < reg.start_date) err('Add / drop ends (' + ad.start_date + ') before registration opens (' + reg.start_date + ').');
  if (res && ex && res.start_date < endOf(ex)) err('Results are released (' + res.start_date + ') before the examinations end (' + endOf(ex) + ').');
  if (brk && lec && (brk.start_date < lec.start_date || endOf(brk) > endOf(lec))) warn('The mid-semester break is not inside the lecture period.');
  if (ex) for (const h of (evs || []).filter(e => e.kind === 'holiday')) if (h.start_date <= endOf(ex) && endOf(h) >= ex.start_date) warn('A holiday (' + h.title + ', ' + h.start_date + ') falls in the examination period — no paper should be set that day.');
  if (term) for (const o of others || []) if (o && o.start_date && o.start_date <= endOf(term) && endOf(o) >= term.start_date) err('This semester overlaps ' + (o.label || 'another semester') + ' (' + o.start_date + ' → ' + endOf(o) + ').');
  return out;
}

/** Where the university stands on `today` (YYYY-MM-DD), from ALL entries (several semesters). */
function status(evs, today) {
  const list = (evs || []).filter(e => e && isDate(e.start_date));
  const terms = list.filter(e => e.kind === 'term').sort((a, b) => a.start_date.localeCompare(b.start_date));
  const cur = terms.find(e => inside(today, e)) || null;
  const next = terms.find(e => e.start_date > today) || null;
  const scope = cur ? list.filter(e => e.semester_id === cur.semester_id) : [];
  const lec = first(scope, 'lectures');
  const startWeeks = lec ? lec.start_date : (cur ? cur.start_date : null);
  const week = startWeeks && today >= startWeeks ? Math.floor(days(startWeeks, today) / 7) + 1 : null;
  const on = (k) => list.find(e => e.kind === k && inside(today, e) && (!cur || !e.semester_id || e.semester_id === cur.semester_id));
  const phase = on('holiday') ? 'holiday' : on('break') ? 'break' : on('exams') ? 'exams' : on('revision') ? 'revision' : on('lectures') ? 'lectures' : on('registration') ? 'registration' : cur ? 'term' : 'between_terms';
  const holiday = on('holiday') || null;
  const coming = upcoming(list, today, 120).filter(e => e.start_date > today).slice(0, 5);
  return { today, term: cur ? { semester_id: cur.semester_id || null, title: cur.title, start_date: cur.start_date, end_date: endOf(cur), day: days(cur.start_date, today) + 1, of: days(cur.start_date, endOf(cur)) + 1 } : null,
    week, phase, holiday: holiday ? { title: holiday.title, until: endOf(holiday) } : null,
    next_term: !cur && next ? { semester_id: next.semester_id || null, title: next.title, start_date: next.start_date, in_days: days(today, next.start_date) } : null,
    next: coming.map(e => ({ id: e.id || null, kind: e.kind, title: e.title, start_date: e.start_date, end_date: e.end_date || null, in_days: days(today, e.start_date) })) };
}

/** Entries that touch [today, today + horizon], soonest first (an entry already under way is included). */
function upcoming(evs, today, horizon) {
  const last = addDays(today, Math.max(0, Number(horizon) || 60));
  return (evs || []).filter(e => e && isDate(e.start_date) && endOf(e) >= today && e.start_date <= last).sort((a, b) => a.start_date.localeCompare(b.start_date) || String(a.kind).localeCompare(String(b.kind)));
}

/** Entries whose reminder is due today (and was not sent) → [{ event, kind, lead, when }] */
function dueReminders(evs, today) {
  const out = [];
  for (const e of evs || []) {
    const k = BY[e.kind]; if (!k || !k.remind || e.reminded_at || !isDate(e.start_date)) continue;
    if (Number(e.published) === 0) continue;
    const when = k.remind.at === 'end' ? endOf(e) : e.start_date;
    const left = days(today, when);
    if (left >= 0 && left <= k.remind.days) out.push({ event: e, kind: e.kind, lead: left, when });
  }
  return out;
}

const crypto = require('crypto');
/** One stable id per semester + key date: re-saving the key dates updates, never duplicates. */
const keyId = (semesterId, kind) => 'cal_' + crypto.createHash('sha1').update(String(semesterId || '') + '|' + kind).digest('hex').slice(0, 24);

module.exports = { KINDS, BY, AUDIENCES, isDate, days, addDays, endOf, validate, checkTerm, status, upcoming, dueReminders, keyId };
