'use strict';
/**
 * 🏢 ESTATES & FACILITIES — pure rules shared by the desktop and the portal:
 *   • room / venue BOOKING: no two approved (or pending) bookings of a room may overlap; capacity is respected;
 *   • MAINTENANCE requests (faults reported by students and staff): categories, priorities and the response
 *     target (SLA) each priority carries, so the estates desk sees what is overdue.
 * Times are local wall-clock strings "YYYY-MM-DDTHH:MM", compared as strings.
 */
const crypto = require('crypto');

const FACILITY_KINDS = { lecture_hall: 'Lecture hall', classroom: 'Classroom', lab: 'Laboratory', auditorium: 'Auditorium', meeting_room: 'Meeting room', sports: 'Sports facility', studio: 'Studio', other: 'Other' };
const FAULT_CATEGORIES = { electrical: 'Electrical', plumbing: 'Plumbing / water', carpentry: 'Carpentry / doors / windows', furniture: 'Furniture', ict: 'ICT / network / projector', cleaning: 'Cleaning / sanitation', security: 'Security / locks', air: 'Air-conditioning / fans', building: 'Building / roof / walls', other: 'Other' };
const PRIORITIES = { urgent: { label: 'Urgent (safety risk)', hours: 4 }, high: { label: 'High', hours: 24 }, normal: { label: 'Normal', hours: 72 }, low: { label: 'Low', hours: 168 } };
const MR_STATUS = ['open', 'assigned', 'in_progress', 'resolved', 'closed', 'rejected'];
const stamp = (s) => String(s || '').replace(' ', 'T').slice(0, 16);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n || 1000); // eslint-disable-line no-control-regex

function overlaps(a, b) { return stamp(a.starts_at) < stamp(b.ends_at) && stamp(b.starts_at) < stamp(a.ends_at); }
/** Bookings that clash with `bk` on the same facility (pending ones count — first come, first served). */
function conflicts(bk, existing) {
  return (existing || []).filter(x => x && !Number(x.deleted) && x.id !== bk.id && x.facility_id === bk.facility_id && ['requested', 'approved'].includes(x.status) && overlaps(bk, x));
}
function validateBooking(fac, bk, existing, now) {
  if (!fac || Number(fac.deleted) || fac.status !== 'active' || !Number(fac.bookable)) return { ok: false, error: 'That room cannot be booked.' };
  const s = stamp(bk.starts_at), e = stamp(bk.ends_at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e)) return { ok: false, error: 'Choose the start and end date and time.' };
  if (e <= s) return { ok: false, error: 'The booking ends before it starts.' };
  if (now && s < stamp(now)) return { ok: false, error: 'That time has already passed.' };
  const hours = (Date.parse(e + ':00Z') - Date.parse(s + ':00Z')) / 3600000;
  if (hours > 24 * 7) return { ok: false, error: 'A single booking can last at most 7 days.' };
  if (Number(fac.capacity) > 0 && Number(bk.attendees) > Number(fac.capacity)) return { ok: false, error: `${fac.name} holds ${fac.capacity} — pick a bigger room.` };
  const c = conflicts(bk, existing);
  if (c.length) return { ok: false, error: `${fac.name} is already booked then (${c.map(x => stamp(x.starts_at).slice(11) + '–' + stamp(x.ends_at).slice(11) + ' ' + (x.title || '')).join('; ')}).`, conflicts: c };
  return { ok: true };
}
/** Rooms free for a time slot (and big enough). */
function freeRooms(facilities, bookings, slot) {
  return (facilities || []).filter(f => !Number(f.deleted) && f.status === 'active' && Number(f.bookable) && (!(Number(slot.attendees) > 0) || !(Number(f.capacity) > 0) || Number(f.capacity) >= Number(slot.attendees))
    && !conflicts({ facility_id: f.id, starts_at: slot.starts_at, ends_at: slot.ends_at }, bookings).length)
    .sort((a, b) => (Number(a.capacity) || 0) - (Number(b.capacity) || 0));
}
function refFor(id, year) { return 'MR-' + (year || new Date().getFullYear()) + '-' + crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 6).toUpperCase(); }
/** When the response target for a request runs out (ISO). */
function dueBy(mr) { const p = PRIORITIES[mr && mr.priority] || PRIORITIES.normal; const t = Date.parse((mr && mr.created_at) || '') || Date.now(); return new Date(t + p.hours * 3600000).toISOString(); }
function overdue(mr, nowIso) { return !!mr && ['open', 'assigned', 'in_progress'].includes(mr.status) && String(nowIso || new Date().toISOString()) > dueBy(mr); }
function validateReport(input) {
  const description = clean(input && input.description, 2000); if (description.length < 10) throw new Error('Describe the problem (a sentence or two).');
  const location = clean(input && input.location, 200); if (!location && !(input && input.facility_id)) throw new Error('Say where it is (building, room, hostel block…).');
  return { description, location: location || null, category: FAULT_CATEGORIES[input && input.category] ? input.category : 'other', priority: PRIORITIES[input && input.priority] ? input.priority : 'normal', facility_id: (input && input.facility_id) || null };
}

module.exports = { FACILITY_KINDS, FAULT_CATEGORIES, PRIORITIES, MR_STATUS, stamp, overlaps, conflicts, validateBooking, freeRooms, refFor, dueBy, overdue, validateReport, clean };
