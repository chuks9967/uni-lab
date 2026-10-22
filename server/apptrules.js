'use strict';
/**
 * 📅 OFFICE HOURS & APPOINTMENTS — pure rules shared by the portal (cloud / edge / LAN) and the desktop.
 *
 * An office-hours block is a weekly (day 0–6, Sunday = 0) or one-off (date) window split into slots of
 * `slot_minutes`, each taking up to `capacity` students. Everything is computed on the institution's LOCAL
 * wall-clock (a string "YYYY-MM-DDTHH:MM" supplied by the caller) — never the server's zone, so a cloud
 * server running in UTC shows a Lagos or Nairobi student the same slots the lecturer published.
 */
const pad = (n) => String(n).padStart(2, '0');
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fromMin = (n) => pad(Math.floor(n / 60)) + ':' + pad(n % 60);
const ACTIVE = ['booked'];
const MAX_PER_HOST = 2;           // active bookings one student may hold with the same person

/** "now" on the institution's wall clock → "YYYY-MM-DDTHH:MM" (Intl, any IANA zone; falls back to the host clock). */
function localNow(tz, date) {
  const d = date || new Date();
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch (_) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
}
function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
function weekday(ymd) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

/** Validate an office-hours definition; returns a list of problems (empty = fine). */
function validateBlock(oh) {
  const e = [];
  const a = toMin(oh.start_time), b = toMin(oh.end_time), step = Number(oh.slot_minutes) || 0;
  if (a == null || b == null) e.push('Give a start and an end time.');
  else if (b <= a) e.push('The end time must be after the start time.');
  if (!(step >= 5 && step <= 240)) e.push('A slot must last between 5 and 240 minutes.');
  if (a != null && b != null && step && (b - a) / step > 48) e.push('That makes too many slots — use longer slots or a shorter window.');
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(String(oh.date || ''));
  const day = Number(oh.day);
  if (!isDate && !(day >= 0 && day <= 6)) e.push('Choose a weekday or a date.');
  if (!(Number(oh.capacity || 1) >= 1 && Number(oh.capacity || 1) <= 50)) e.push('Capacity must be between 1 and 50.');
  return e;
}

/**
 * The slots of one block over the next `days` days, from local "now".
 *   bookings — every appointment of this block {date, start_time, status}
 *   leadMin  — a slot must start at least this many minutes from now (default 60)
 */
function slotsFor(oh, o) {
  const x = o || {}; const now = x.now || localNow(); const today = now.slice(0, 10); const nowMin = toMin(now.slice(11));
  const days = Math.min(60, Math.max(1, Number(x.days) || 14)); const lead = x.leadMin != null ? x.leadMin : 60;
  const a = toMin(oh.start_time), b = toMin(oh.end_time), step = Number(oh.slot_minutes) || 15, cap = Math.max(1, Number(oh.capacity) || 1);
  if (a == null || b == null || b <= a || Number(oh.active) === 0) return [];
  const bookings = (x.bookings || []).filter(k => ACTIVE.includes(k.status));
  const dates = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(oh.date || ''))) { if (oh.date >= today && oh.date <= addDays(today, days)) dates.push(oh.date); }
  else for (let i = 0; i <= days; i++) { const d = addDays(today, i); if (weekday(d) === Number(oh.day)) dates.push(d); }
  const out = [];
  for (const d of dates) for (let t = a; t + step <= b; t += step) {
    if (d === today && t < nowMin + lead) continue;
    const start = fromMin(t); const taken = bookings.filter(k => k.date === d && k.start_time === start).length;
    out.push({ date: d, start, end: fromMin(t + step), taken, free: taken < cap });
  }
  return out;
}

/** Can this student book this slot? → [] when fine, else plain-language reasons. */
function checkBooking(oh, slot, o) {
  const x = o || {}; const e = [];
  if (!oh || Number(oh.active) === 0) return ['These office hours are no longer offered.'];
  const s = slotsFor(oh, { now: x.now, days: 60, bookings: x.bookings, leadMin: x.leadMin }).find(k => k.date === slot.date && k.start === slot.start);
  if (!s) return ['That time is not available (past, outside the office hours, or too soon).'];
  if (!s.free) e.push('That slot has just been taken — pick another.');
  const mine = (x.mine || []).filter(k => ACTIVE.includes(k.status));
  if (mine.some(k => k.office_hour_id === oh.id && k.date === slot.date && k.start_time === slot.start)) e.push('You already booked this slot.');
  else if (mine.filter(k => k.host_id === oh.host_id).length >= MAX_PER_HOST) e.push(`You already have ${MAX_PER_HOST} upcoming appointments with ${oh.host_name || 'this person'} — attend or cancel one first.`);
  return e;
}

/** A booking may be cancelled until `hours` before it starts (the host may always cancel). */
function canCancel(appt, now, hours) {
  if (!appt || !ACTIVE.includes(appt.status)) return false;
  const h = hours == null ? 2 : hours;
  const start = new Date(`${appt.date}T${appt.start_time}:00Z`).getTime();
  const n = new Date(`${String(now || localNow()).slice(0, 16)}:00Z`).getTime();
  return start - n >= h * 3600000;
}

module.exports = { localNow, addDays, weekday, validateBlock, slotsFor, checkBooking, canCancel, toMin, fromMin, MAX_PER_HOST, ACTIVE };
