'use strict';
/**
 * 📅 MY DAY — a student's agenda for today and the coming days, on the university's clock (its IANA time zone), from
 * what the portal already knows: the published lecture timetable (weekly), exam papers (dated), online exams,
 * assignment deadlines, library books due back, and a convocation reply deadline — and, for a lecturer, the classes they
 * teach and their invigilation duties.
 *
 *   agenda(src, { tz, now, days })   → { today, events: [{ id, kind, title, sub, where, start, end, local_date, local_time,
 *                                       remind: [minutes before…], open }] } — sorted, ongoing ones included
 *   zoned(date, 'HH:MM', tz)         → the real instant of a wall-clock time in that zone (daylight saving safe)
 *
 * Pure: the portal calls it for /api/my-day; the app schedules its own reminders from the answer (so they fire with no
 * data connection), and the portal shows "📅 My day".
 */
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const pad = (n) => String(n).padStart(2, '0');
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (_) { return 'UTC'; } }
function partsIn(tz, d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, dow: DOW[String(p.weekday).toLowerCase().slice(0, 3)] };
}
const offsetMin = (tz, d) => { const p = partsIn(tz, d); return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - d.getTime()) / 60000); };
/** The instant of a wall-clock time in tz. */
function zoned(ymd, hm, tz) {
  tz = validTz(tz);
  const [y, m, d] = String(ymd).split('-').map(Number); const [h, mi] = String(hm || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h || 0, mi || 0);
  const off1 = offsetMin(tz, new Date(guess)); const t1 = guess - off1 * 60000;
  const off2 = offsetMin(tz, new Date(t1));
  return new Date(off1 === off2 ? t1 : guess - off2 * 60000);
}
/** A stored time: with a zone (…Z / +01:00) it is an instant; without one it is the university's wall clock. */
function instant(v, tz) {
  const s = String(v || '').trim(); if (!s) return null;
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) { const t = Date.parse(s); return isNaN(t) ? null : new Date(t); }
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s); if (!m) return null;
  return zoned(m[1], m[2] || '23:59', tz);
}
const ymdOf = (p) => p.y + '-' + pad(p.m) + '-' + pad(p.d);
function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); }
const dowOfYmd = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const dayIndex = (v) => { const k = String(v || '').trim().toLowerCase().slice(0, 3); return k in DOW ? DOW[k] : null; };
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
const hmOk = (v) => /^\d{1,2}:\d{2}$/.test(String(v || '').trim());
const normHm = (v) => { const [h, m] = String(v).trim().split(':'); return pad(+h) + ':' + m; };

/**
 * src: { timetables: [{ type, slots: [{ course_code, course_title, lecturer, day, start, end, venue, kind }] }],
 *        exams: [{ id, title, course_code, start_at, end_at, attempt }], coursework: [{ id, title, course_code, due_at, mine }],
 *        loans: [{ id, title, due_date }], convocation: [{ id, title, rsvp_deadline, attending, can_reply }],
 *        booked: [{ id, subject, course_code, topic, lecturer, starts_at, starts_utc, minutes, teach }],
 *        defenses: [{ id, title, date, minutes, venue, online, mode_label, panel, role, student }] }
 */
function agenda(src, opts) {
  const o = opts || {}; const tz = validTz(o.tz || 'UTC'); const now = o.now ? new Date(o.now) : new Date();
  const days = Math.max(1, Math.min(14, Number(o.days) || 7));
  const today = ymdOf(partsIn(tz, now)); const lastDay = addDays(today, days - 1);
  const windowEnd = zoned(addDays(today, days), '00:00', tz).getTime();
  const local = (d) => { const p = partsIn(tz, d); return { local_date: ymdOf(p), local_time: pad(p.h) + ':' + pad(p.mi) }; };
  const out = [];
  const push = (e) => { if (!e.start) return; const s = e.start.getTime(), en = (e.end || e.start).getTime(); if (en < now.getTime() || s >= windowEnd) return;
    out.push(Object.assign({}, e, local(e.start), { start: e.start.toISOString(), end: e.end ? e.end.toISOString() : null, open: s <= now.getTime() && en >= now.getTime() })); };
  const s = src || {};
  // no classes on a holiday (a dated "holiday" slot in any published timetable)
  const holidays = new Set();
  for (const t of s.timetables || []) for (const sl of t.slots || []) if (sl && sl.kind === 'holiday' && isYmd(sl.day)) holidays.add(String(sl.day).trim());
  for (const t of s.timetables || []) {
    for (const sl of t.slots || []) {
      if (!sl || sl.kind === 'holiday' || sl.kind === 'break' || !hmOk(sl.start)) continue;
      const examish = sl.kind === 'exam' || t.type === 'exam';
      const kind = examish ? 'exam' : (t.teach ? 'teach' : 'class');   // teach = a lecturer's own class
      const title = [sl.course_code, sl.course_title].filter(Boolean).join(' ') || (examish ? 'Examination' : 'Lecture');
      const make = (ymd) => {
        const st = zoned(ymd, normHm(sl.start), tz);
        const en = hmOk(sl.end) ? zoned(ymd, normHm(sl.end), tz) : new Date(st.getTime() + 60 * 60000);
        push({ id: kind + ':' + (sl.course_code || title) + ':' + ymd + ':' + normHm(sl.start), kind, title, sub: kind === 'teach' ? (sl.cohort || '') : (sl.lecturer || ''), where: sl.venue || '', start: st, end: en, remind: examish ? [1440, 60] : kind === 'teach' ? [30] : [15] });
      };
      if (isYmd(sl.day)) { const dd = String(sl.day).trim(); if (dd >= today && dd <= lastDay) make(dd); continue; }
      const di = dayIndex(sl.day); if (di == null) continue;
      for (let i = 0; i < days; i++) { const ymd = addDays(today, i); if (dowOfYmd(ymd) === di && !holidays.has(ymd)) make(ymd); }
    }
  }
  // 🛡 a lecturer's invigilation duties (exam seatings)
  for (const v of s.invigilations || []) {
    if (!isYmd(v.date) || !hmOk(v.start)) continue;
    const st = zoned(v.date, normHm(v.start), tz); const en = hmOk(v.end) ? zoned(v.date, normHm(v.end), tz) : new Date(st.getTime() + 3 * 3600000);
    push({ id: 'invigilation:' + (v.course || '') + ':' + v.date + ':' + normHm(v.start) + ':' + (v.room || ''), kind: 'invigilation', title: (v.course || 'Examination'), sub: [v.department, v.level].filter(Boolean).join(' · '), where: v.room || '', start: st, end: en, remind: [1440, 60] });
  }
  for (const e of s.exams || []) {
    const st = String((e.attempt && e.attempt.status) || e.attempt || '');
    if (/submitted|graded|voided/.test(st)) continue;
    const a = instant(e.start_at, tz), b = instant(e.end_at, tz);
    if (!a) continue;
    push({ id: 'online_exam:' + e.id, kind: 'online_exam', title: e.title || e.course_code || 'Online exam', sub: e.title && e.course_code && String(e.title).includes(e.course_code) ? '' : (e.course_code || ''), where: 'Online', start: a, end: b, remind: [60, 0] });
  }
  for (const c of s.coursework || []) {
    if (c.mine && c.mine.submitted_at) continue;
    const due = instant(c.due_at, tz); if (!due) continue;
    push({ id: 'deadline:' + c.id, kind: 'deadline', title: c.title || 'Assignment', sub: c.title && c.course_code && String(c.title).includes(c.course_code) ? '' : (c.course_code || ''), where: '', start: due, end: due, remind: [1440, 120] });
  }
  for (const l of s.loans || []) {
    if (!isYmd(l.due_date)) continue;
    const due = zoned(l.due_date, '17:00', tz);
    push({ id: 'library:' + l.id, kind: 'library', title: l.title || 'Library book', sub: '', where: 'Library', start: due, end: due, remind: [1440] });
  }
  for (const c of s.convocation || []) {
    if (c.attending != null || !c.can_reply || !c.rsvp_deadline) continue;
    const dl = instant(String(c.rsvp_deadline).slice(0, 10) + 'T23:59', tz);
    push({ id: 'rsvp:' + c.id, kind: 'rsvp', title: c.title || 'Convocation', sub: '', where: '', start: dl, end: dl, remind: [2880] });
  }
  // 🎥 booked online classes — a student's, or the lecturer's own (teach). starts_utc is the exact instant the desk stored;
  // without it the wall clock is the university's. The reminder goes at the start ("join now") — the server already
  // sends the 15-minute notice, so the phone adds the one it cannot miss offline.
  for (const c of s.booked || []) {
    if (!c || c.state === 'cancelled') continue;
    const st = instant(c.starts_utc || c.starts_at, tz); if (!st) continue;
    const en = new Date(st.getTime() + (Number(c.minutes) > 0 ? Number(c.minutes) : 60) * 60000);
    const kind = c.teach ? 'online_teach' : 'online_class';
    push({ id: kind + ':' + c.id, kind, title: c.subject || c.course_code || 'Online class', sub: c.topic || (c.teach ? '' : (c.lecturer || '')), where: 'Online', start: st, end: en, remind: [0] });
  }
  // 🎓 a project defence — the student's own, or one a staff member sits on (panel). A date with no time = 09:00.
  for (const v of s.defenses || []) {
    const raw = String((v && v.date) || '').trim(); if (!raw) continue;
    const st = isYmd(raw) ? zoned(raw, '09:00', tz) : instant(raw, tz); if (!st) continue;
    const en = new Date(st.getTime() + (Number(v.minutes) > 0 ? Number(v.minutes) : 45) * 60000);
    const kind = v.panel ? 'defense_panel' : 'defense'; const where = v.venue || (v.online ? 'Online' : '');
    push({ id: kind + ':' + v.id, kind, title: v.title || 'Project defence', sub: v.panel ? [v.role, v.student].filter(Boolean).join(' · ') : (v.mode_label && v.mode_label !== where ? v.mode_label : ''),
      where, start: st, end: en, remind: [1440, 60] });
  }
  out.sort((x, y) => x.start.localeCompare(y.start) || x.title.localeCompare(y.title));
  return { tz, today, days, events: out };
}

module.exports = { agenda, zoned, instant, partsIn, addDays };
