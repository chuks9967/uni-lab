'use strict';
/**
 * 📣 ANNOUNCEMENTS — pure rules shared by the desktop (where offices write them) and the portal / app (where everyone
 * reads them), wherever the portal runs (cloud edge, Node hub, LAN hub). An announcement is one synced row; who sees
 * it is decided HERE from its audience, so nothing has to be copied per reader and a phone in another country sees
 * the same notice as a desk on campus.
 *
 * Audience = { groups: students | parents | lecturers | staff | officers, roles: [officer roles] (when officers),
 *              campus_id?, faculty_id?, department_id?, level_id?, courses?: [course codes] }  — the academic filters
 *              narrow STUDENTS and PARENTS (by their ward); a campus narrows everyone. A COURSE notice (a lecturer
 *              writing to the classes they teach) reaches only the students taking one of those courses (and, if
 *              chosen, their parents) — "taking" is decided by courseIndex() below, the one rule for it.
 * Reading state = one row per (announcement, reader), written only by that reader: read_at, acked_at
 * ("I have read and understood" — for notices that must be acknowledged).
 */
const crypto = require('crypto');

const GROUPS = { students: 'Students', parents: 'Parents & guardians', lecturers: 'Lecturers', staff: 'Non-teaching staff', officers: 'Offices (desktop users)' };
const ROLES = ['admin', 'accountant', 'registrar', 'dean', 'hod', 'student_affairs', 'ict', 'campus_admin'];
const MAX_TITLE = 160, MAX_BODY = 8000;
/** A course code as one key: "csc 101" → "CSC101" (the same key the course forums use). */
const ck = (code) => String(code == null ? '' : code).toUpperCase().replace(/\s+/g, '').slice(0, 24);
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const pj = (x, d) => { if (x && typeof x === 'object') return x; try { const v = JSON.parse(x == null ? 'null' : x); return v == null ? d : v; } catch (_) { return d; } };

function clean(s, n) {
  // eslint-disable-next-line no-control-regex
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n);
}
/** A well-formed audience (unknown groups / roles dropped). */
function cleanAudience(a) {
  const x = pj(a, {}) || {};
  const groups = [...new Set((Array.isArray(x.groups) ? x.groups : []).filter(g => GROUPS[g]))];
  const roles = [...new Set((Array.isArray(x.roles) ? x.roles : []).filter(r => ROLES.includes(r)))];
  const id = (v) => (v == null || v === '' ? null : String(v).slice(0, 80));
  const courses = [...new Set((Array.isArray(x.courses) ? x.courses : []).map(ck).filter(Boolean))].slice(0, 30);
  return { groups, roles, campus_id: id(x.campus_id), faculty_id: id(x.faculty_id), department_id: id(x.department_id), level_id: id(x.level_id), courses };
}
/** Published, started and not expired. */
function isLive(a, nowIso) {
  const now = nowIso || new Date().toISOString();
  if (!a || Number(a.deleted) || a.status !== 'published') return false;
  if (a.publish_at && String(a.publish_at) > now) return false;
  if (a.expires_at && String(a.expires_at) <= now) return false;
  return true;
}
/**
 * Is this reader in the audience? viewer = { kind: 'student'|'parent'|'staff'|'user', role?, staff_type?,
 * campus_id?, faculty_id?, department_id?, level_id?, courses?: [keys] } (a parent carries their ward's academic facts
 * and courses). A reader whose courses are unknown never sees a course notice.
 */
function matches(a, viewer) {
  const au = cleanAudience(a && a.audience);
  if (!viewer || !au.groups.length) return false;
  if (au.campus_id && viewer.campus_id && au.campus_id !== viewer.campus_id) return false;
  const academic = () => (!au.faculty_id || au.faculty_id === viewer.faculty_id) && (!au.department_id || au.department_id === viewer.department_id) && (!au.level_id || au.level_id === viewer.level_id);
  const inCourse = () => !au.courses.length || (Array.isArray(viewer.courses) && au.courses.some(c => viewer.courses.includes(c)));
  if (viewer.kind === 'student') return au.groups.includes('students') && academic() && inCourse();
  if (viewer.kind === 'parent') return au.groups.includes('parents') && academic() && inCourse();
  if (au.courses.length) return false;   // a course notice is for the class (and its parents) only
  if (viewer.kind === 'staff') return au.groups.includes(viewer.staff_type === 'lecturer' ? 'lecturers' : 'staff');
  if (viewer.kind === 'user') return au.groups.includes('officers') && (!au.roles.length || au.roles.includes(viewer.role));
  return false;
}
function readerKey(kind, id) { return ({ student: 's:', parent: 'p:', staff: 'st:', user: 'u:' }[kind] || 'x:') + id; }
function readId(annId, rKey) { return 'ar_' + sha(String(annId) + '|' + String(rKey)).slice(0, 28); }

/** A new announcement row (the caller fills author / status / timestamps). */
function build(data) {
  const title = clean(data.title, MAX_TITLE); if (title.length < 3) throw new Error('Give the announcement a title.');
  const body = clean(data.body, MAX_BODY); if (body.length < 3) throw new Error('Write the announcement.');
  const audience = cleanAudience(data.audience);
  if (!audience.groups.length) throw new Error('Choose who it is for.');
  if (audience.courses.length && audience.groups.some(g => g !== 'students' && g !== 'parents')) throw new Error('A course notice goes to the students of the course (and their parents) only.');
  const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v) : null);
  const publish_at = day(data.publish_at), expires_at = day(data.expires_at);
  if (publish_at && expires_at && expires_at <= publish_at) throw new Error('It must expire after it is published.');
  return { title, body, audience: JSON.stringify(audience), priority: data.priority === 'urgent' ? 'urgent' : 'normal', pinned: data.pinned ? 1 : 0, requires_ack: data.requires_ack ? 1 : 0, publish_at, expires_at };
}
/** What a reader sees, newest first — on top: still to acknowledge, then urgent and unread, then pinned. */
function forReader(rows, viewer, readsById, rKey, nowIso) {
  const out = [];
  for (const a of rows || []) {
    if (!isLive(a, nowIso) || !matches(a, viewer)) continue;
    const r = readsById ? readsById.get(readId(a.id, rKey)) : null;
    out.push({ id: a.id, title: a.title, body: a.body, priority: a.priority || 'normal', pinned: !!Number(a.pinned), requires_ack: !!Number(a.requires_ack), from: a.author_office || a.author_name || 'The university',
      date: a.publish_at && String(a.publish_at) > String(a.created_at || '') ? a.publish_at : a.created_at, expires_at: a.expires_at || null, read: !!(r && r.read_at), acked: !!(r && r.acked_at) });
  }
  const rank = (x) => (x.requires_ack && !x.acked ? 0 : x.priority === 'urgent' && !x.read ? 1 : x.pinned ? 2 : 3);
  return out.sort((x, y) => rank(x) - rank(y) || String(y.date).localeCompare(String(x.date)));
}
/**
 * 📚 Which courses each student is taking — the ONE rule (portal, app, desktop): the courses allocated to their
 * department + level in a PUBLISHED allocation, the catalogue courses of their department + level, and every course
 * they registered for. Built once over the tables, then asked per student: courseIndex(tables)(student) → [keys].
 */
function courseIndex(t) {
  const alive = (r) => r && !Number(r.deleted);
  const byCohort = new Map(); const reg = new Map();
  const put = (m, k, code) => { const c = ck(code); if (!c) return; let x = m.get(k); if (!x) { x = new Set(); m.set(k, x); } x.add(c); };
  const pub = new Map(); for (const a of (t && t.allocation_sets) || []) if (alive(a) && a.status === 'published') pub.set(a.id, a.department_id + '|' + a.level_id);
  for (const r of (t && t.course_allocations) || []) if (alive(r) && pub.has(r.set_id)) put(byCohort, pub.get(r.set_id), r.course_code);
  for (const c of (t && t.courses) || []) if (alive(c) && c.department_id && c.level_id) put(byCohort, c.department_id + '|' + c.level_id, c.code);
  for (const r of (t && t.course_registrations) || []) if (alive(r) && r.student_id && r.status === 'registered') put(reg, r.student_id, r.course_code);
  return (s) => { if (!s) return []; const out = new Set(byCohort.get(s.department_id + '|' + s.level_id) || []); for (const c of reg.get(s.id) || []) out.add(c); return [...out]; };
}
/** Offices that write announcements, and the name they sign with. */
const WRITERS = ['admin', 'campus_admin', 'registrar', 'student_affairs', 'accountant', 'ict', 'dean', 'hod'];
const OFFICE = { admin: 'Administration', campus_admin: 'Campus Administration', registrar: 'Registry', student_affairs: 'Student Affairs', accountant: 'Bursary', ict: 'ICT', dean: 'Dean’s Office', hod: 'Head of Department' };
/**
 * Narrow an office's audience to what is theirs — the ONE rule for the desktop and the portal / app: a dean writes to
 * their faculty (students, parents, lecturers, staff), a head of department to their department (students, parents,
 * lecturers), a campus-bound officer to their campus. Never widened. actor = { role, faculty_id, department_id }.
 */
function scopeAudience(actor, audience, campusId) {
  const a = cleanAudience(audience);
  const r = actor && actor.role;
  if (r === 'dean' && actor.faculty_id) { a.faculty_id = actor.faculty_id; a.groups = a.groups.filter(g => ['students', 'parents', 'lecturers', 'staff'].includes(g)); }
  if (r === 'hod' && actor.department_id) { a.department_id = actor.department_id; a.faculty_id = a.faculty_id || actor.faculty_id || null; a.groups = a.groups.filter(g => ['students', 'parents', 'lecturers'].includes(g)); }
  if (campusId) a.campus_id = campusId;
  return a;
}
/** May this lecturer write to these courses? Only the ones they teach. → the clean list, or throws. */
function lecturerCourses(requested, teaches) {
  const mine = new Set((teaches || []).map(ck).filter(Boolean));
  const want = [...new Set((Array.isArray(requested) ? requested : []).map(ck).filter(Boolean))];
  if (!want.length) throw new Error('Choose the class (course) it is for.');
  const bad = want.filter(c => !mine.has(c));
  if (bad.length) throw new Error('You can only write to the classes you teach (' + bad.join(', ') + ' is not one of them).');
  return want;
}
/** The read-marker row (caller upserts it). */
function readRow(annId, rKey, ack, at) {
  const t = at || new Date().toISOString();
  return { id: readId(annId, rKey), announcement_id: annId, reader_key: rKey, read_at: t, acked_at: ack ? t : null, created_at: t, updated_at: t, deleted: 0 };
}

module.exports = { GROUPS, ROLES, WRITERS, OFFICE, ck, cleanAudience, isLive, matches, readerKey, readId, build, forReader, readRow, courseIndex, lecturerCourses, scopeAudience };
