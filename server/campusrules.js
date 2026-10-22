'use strict';
/**
 * 🎓 CAMPUS SERVICES — pure rules shared by the desktop and the portal (cloud edge, Node hub, LAN hub) for the
 * student-life and research modules:
 *   🔬 research & theses   🏭 industrial training / internships   🩺 health & counselling
 *   🎭 clubs & events       🚌 transport                           💼 careers
 * No database access here — every function is deterministic and unit-tested (test/campus.js).
 */
const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const did = (prefix, ...parts) => prefix + '_' + sha(parts.map(String).join('|')).slice(0, 28);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
function parseDay(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; }
function addMonths(day, n) { const d = parseDay(day); if (!d) return null; const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate())); return ymd(t); }
function addDays(day, n) { const d = parseDay(day); if (!d) return null; return ymd(new Date(d.getTime() + n * 86400000)); }
// the LOCAL wall clock (an office in Lagos at 00:30 is on the new day; UTC would still say yesterday). On a cloud
// server the local zone is UTC — dates coming from the desktop are already local strings.
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = (now) => (now ? String(now).slice(0, 10) : localDay(new Date()));
/** 'YYYY-MM-DDTHH:MM' on the local wall clock (what a datetime-local field shows). */
function localStamp(d) { const x = d || new Date(); return localDay(x) + 'T' + pad(x.getHours()) + ':' + pad(x.getMinutes()); }
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max || 2000); // eslint-disable-line no-control-regex

// =====================================================================================================
// 🔬 RESEARCH & THESES
// =====================================================================================================
const THESIS_PROGRAMMES = ['PhD', 'MPhil', 'MSc', 'MA', 'MBA', 'MEd', 'LLM', 'PGD', 'Project'];
const THESIS_STATUS = ['proposal', 'in_progress', 'submitted', 'under_examination', 'corrections', 'completed', 'withdrawn'];
const THESIS_STATUS_LABEL = { proposal: 'Proposal stage', in_progress: 'In progress', submitted: 'Submitted', under_examination: 'Under examination', corrections: 'Corrections', completed: 'Completed', withdrawn: 'Withdrawn' };
const VIVA_OUTCOMES = { pass: 'Pass (no corrections)', minor: 'Pass with minor corrections', major: 'Major corrections', resubmit: 'Revise and resubmit', fail: 'Fail' };
const MILESTONE_KINDS = { proposal: 'Research proposal', seminar: 'Seminar / proposal defence', progress_report: 'Progress report', chapter: 'Chapter draft', full_draft: 'Full draft', submission: 'Thesis submission', viva: 'Viva / oral defence', corrections: 'Corrections', final_copy: 'Final bound copy' };
// months from the start date — the institution edits dates per student afterwards
const TEMPLATES = {
  doctoral: [['proposal', 'Research proposal', 3], ['seminar', 'Proposal defence (seminar 1)', 6], ['progress_report', 'Progress report — year 1', 12], ['progress_report', 'Progress report — 18 months', 18],
    ['seminar', 'Post-field seminar (seminar 2)', 24], ['progress_report', 'Progress report — year 2', 24], ['full_draft', 'Full draft to supervisors', 30], ['submission', 'Thesis submission', 33], ['viva', 'Viva voce', 36], ['corrections', 'Corrections signed off', 38], ['final_copy', 'Final bound copy deposited', 39]],
  masters: [['proposal', 'Research proposal', 2], ['seminar', 'Proposal defence', 4], ['progress_report', 'Progress report', 6], ['full_draft', 'Full draft to supervisor', 10], ['submission', 'Dissertation submission', 11],
    ['viva', 'Oral defence', 12], ['corrections', 'Corrections signed off', 13], ['final_copy', 'Final copy deposited', 14]],
  project: [['proposal', 'Project topic & proposal', 1], ['chapter', 'Chapters 1–3', 3], ['full_draft', 'Full draft', 5], ['submission', 'Project submission', 6], ['viva', 'Project defence', 7]],
};
function templateFor(programme) { const p = String(programme || ''); return /^(PhD|MPhil)$/i.test(p) ? 'doctoral' : /^Project$/i.test(p) ? 'project' : 'masters'; }
/** The standard milestones for a programme starting on `start` (YYYY-MM-DD). */
function milestonePlan(programme, start) {
  const s = parseDay(start) ? String(start).slice(0, 10) : today();
  return TEMPLATES[templateFor(programme)].map(([kind, title, m], i) => ({ kind, title, seq: i + 1, due_date: addMonths(s, m) }));
}
function milestoneOverdue(m, now) { return !!m && ['pending', 'revision'].includes(m.status || 'pending') && !!m.due_date && String(m.due_date).slice(0, 10) < today(now); }
/** Progress + health of a thesis from its milestones: on_track · at_risk (one overdue) · behind (two or more, or past the expected end). */
function thesisProgress(thesis, milestones, now) {
  const ms = (milestones || []).filter(m => m && !m.deleted);
  const approved = ms.filter(m => m.status === 'approved').length;
  const overdue = ms.filter(m => milestoneOverdue(m, now)).length;
  const waiting = ms.filter(m => m.status === 'submitted').length;
  const next = ms.filter(m => m.status !== 'approved').sort((a, b) => (a.seq || 0) - (b.seq || 0))[0] || null;
  const done = thesis && ['completed', 'withdrawn'].includes(thesis.status);
  const pastEnd = thesis && thesis.expected_end && !done && String(thesis.expected_end).slice(0, 10) < today(now);
  const health = done ? (thesis.status === 'completed' ? 'completed' : 'withdrawn') : (overdue >= 2 || pastEnd) ? 'behind' : overdue === 1 ? 'at_risk' : 'on_track';
  return { total: ms.length, approved, overdue, waiting, pct: ms.length ? Math.round(approved * 100 / ms.length) : 0, next: next ? { id: next.id, title: next.title, due_date: next.due_date, status: next.status } : null, health };
}
/** Which thesis status a viva outcome leads to. */
function statusAfterOutcome(outcome) { return outcome === 'pass' ? 'completed' : outcome === 'fail' ? 'withdrawn' : (outcome === 'minor' || outcome === 'major') ? 'corrections' : outcome === 'resubmit' ? 'in_progress' : null; }

// =====================================================================================================
// 🏭 INDUSTRIAL TRAINING / INTERNSHIPS
// =====================================================================================================
const PLACEMENT_PROGRAMMES = ['SIWES', 'Internship', 'Co-op', 'Teaching practice', 'Clinical rotation', 'Industrial attachment'];
const PLACEMENT_STATUS = ['applied', 'approved', 'active', 'completed', 'cancelled', 'rejected'];
const DEFAULT_WEIGHTS = { logbook: 30, supervisor: 30, report: 20, defense: 20 };
const DEFAULT_SCALE = [[70, 'A'], [60, 'B'], [50, 'C'], [45, 'D'], [40, 'E'], [0, 'F']];
function weeksBetween(start, end) { const a = parseDay(start), b = parseDay(end); if (!a || !b || b < a) return 0; return Math.max(1, Math.ceil(((b - a) / 86400000 + 1) / 7)); }
/** The week of the placement `now` falls in (1-based; 0 before it starts). */
function currentWeek(start, now) { const a = parseDay(start), t = parseDay(today(now)); if (!a || !t || t < a) return 0; return Math.floor((t - a) / (7 * 86400000)) + 1; }
function logId(placementId, week) { return did('pl', placementId, Number(week)); }
/** May the student file (or re-file) the logbook entry for `week`? */
function canLogWeek(placement, week, existing, now) {
  const w = Number(week);
  if (!placement || !['approved', 'active'].includes(placement.status)) return { ok: false, error: 'Your placement is not active yet — the logbook opens once it is approved.' };
  const total = placement.weeks_required || weeksBetween(placement.start_date, placement.end_date) || 0;
  if (!Number.isInteger(w) || w < 1 || (total && w > total)) return { ok: false, error: 'Choose a week between 1 and ' + (total || '…') + '.' };
  if (w > currentWeek(placement.start_date, now)) return { ok: false, error: 'You cannot fill a week that has not started yet.' };
  if (existing && existing.status === 'approved') return { ok: false, error: 'That week has already been approved by your supervisor.' };
  return { ok: true };
}
function logbookCompletion(placement, logs) {
  const total = (placement && (placement.weeks_required || weeksBetween(placement.start_date, placement.end_date))) || 0;
  const weeks = new Set((logs || []).filter(l => l && !l.deleted && l.status !== 'returned').map(l => Number(l.week_no)));
  const approved = new Set((logs || []).filter(l => l && !l.deleted && l.status === 'approved').map(l => Number(l.week_no)));
  return { total, filed: weeks.size, approved: approved.size, pct: total ? Math.min(100, Math.round(weeks.size * 100 / total)) : 0 };
}
function gradeFor(score, scale) { const s = Number(score); if (!Number.isFinite(s)) return null; for (const [min, g] of (scale || DEFAULT_SCALE)) if (s >= min) return g; return 'F'; }
/** Weighted final score (each component 0–100). `complete` only when every weighted component has a score. */
function placementScore(p, weights, scale) {
  const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
  const comp = { logbook: p.score_logbook, supervisor: p.score_supervisor, report: p.score_report, defense: p.score_defense };
  let sum = 0, wsum = 0, complete = true;
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const wt = Number(w[k]) || 0; if (!wt) continue;
    const v = comp[k]; if (v == null || v === '' || !Number.isFinite(Number(v))) { complete = false; continue; }
    sum += Math.max(0, Math.min(100, Number(v))) * wt; wsum += wt;
  }
  const score = wsum ? Math.round(sum / wsum * 10) / 10 : null;
  return { score, complete, grade: complete && score != null ? gradeFor(score, scale) : null };
}

// =====================================================================================================
// 🩺 HEALTH & COUNSELLING
// =====================================================================================================
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const GENOTYPES = ['AA', 'AS', 'AC', 'SS', 'SC', 'CC'];
const COUNSEL_CATEGORIES = { academic: 'Academic', personal: 'Personal', career: 'Career', financial: 'Financial', wellbeing: 'Wellbeing / mental health', other: 'Other' };
const COUNSEL_MODES = { in_person: 'In person', online: 'Online', phone: 'Phone' };
const RISK_LEVELS = ['none', 'low', 'medium', 'high'];
function healthId(studentId) { return 'hp_' + String(studentId); }
/** The fields a STUDENT may edit on their own health profile (the clinic edits the rest). */
const STUDENT_HEALTH_FIELDS = ['blood_group', 'genotype', 'allergies', 'conditions', 'medications', 'disability', 'emergency_name', 'emergency_phone', 'emergency_relation', 'insurance_no'];
function cleanHealth(input, fields) {
  const out = {};
  for (const f of fields || STUDENT_HEALTH_FIELDS) {
    if (input == null || input[f] === undefined) continue;
    let v = clean(input[f], 600);
    if (f === 'blood_group' && v && !BLOOD_GROUPS.includes(v.toUpperCase())) throw new Error('Choose a valid blood group.');
    if (f === 'genotype' && v && !GENOTYPES.includes(v.toUpperCase())) throw new Error('Choose a valid genotype.');
    if ((f === 'blood_group' || f === 'genotype') && v) v = v.toUpperCase();
    if (f === 'emergency_phone' && v && !/^[+0-9 ()-]{6,20}$/.test(v)) throw new Error('Enter a valid emergency phone number.');
    out[f] = v || null;
  }
  return out;
}
/** A sick note is what a student (and a lecturer taking the register) may see — never the diagnosis. */
function sickNoteView(v) { return v && v.sick_from ? { id: v.id, from: String(v.sick_from).slice(0, 10), to: String(v.sick_to || v.sick_from).slice(0, 10), days: Math.max(1, Math.round(((parseDay(v.sick_to || v.sick_from) || 0) - (parseDay(v.sick_from) || 0)) / 86400000) + 1), issued: String(v.visit_date || '').slice(0, 10) } : null; }
function sickNoteCovers(v, day) { const n = sickNoteView(v); const d = today(day); return !!n && n.from <= d && d <= n.to; }
/** What a student sees of their counselling requests — status and time, never the counsellor's notes or risk level. */
function counsellingView(c) { return c ? { id: c.id, status: c.status, category: COUNSEL_CATEGORIES[c.category] || c.category, mode: COUNSEL_MODES[c.mode] || c.mode || '', scheduled_at: c.scheduled_at || null, requested: c.created_at } : null; }

// =====================================================================================================
// 🎭 CLUBS & EVENTS
// =====================================================================================================
const CLUB_CATEGORIES = ['academic', 'faith', 'sports', 'arts', 'technology', 'community', 'professional', 'other'];
const EVENT_CATEGORIES = ['academic', 'cultural', 'sports', 'career', 'religious', 'orientation', 'other'];
const CLUB_ROLES = ['member', 'executive', 'president', 'secretary', 'treasurer'];
function membershipId(clubId, studentId) { return did('cmb', clubId, studentId); }
function rsvpId(eventId, studentId) { return did('rsv', eventId, studentId); }
function audienceMatches(ev, s) {
  if (!ev || !s) return false;
  if (ev.campus_id && s.campus_id && ev.campus_id !== s.campus_id) return false;
  return (!ev.faculty_id || ev.faculty_id === s.faculty_id) && (!ev.department_id || ev.department_id === s.department_id) && (!ev.level_id || ev.level_id === s.level_id);
}
function eventState(ev, now) {
  const t = now ? new Date(now).toISOString() : new Date().toISOString();
  if (!ev || ev.status === 'cancelled') return 'cancelled';
  const s = String(ev.starts_at || ''), e = String(ev.ends_at || ev.starts_at || '');
  const endKey = e.length <= 10 && e ? e + 'T23:59' : e;       // a date-only event lasts the whole day
  if (endKey && endKey < t.slice(0, endKey.length)) return 'past';
  if (s && s <= t.slice(0, s.length)) return 'ongoing';
  return 'upcoming';
}
function canRsvp(ev, student, goingCount, now) {
  if (!ev || ev.status !== 'published') return { ok: false, error: 'This event is not open.' };
  if (!audienceMatches(ev, student)) return { ok: false, error: 'This event is for another group of students.' };
  if (eventState(ev, now) === 'past') return { ok: false, error: 'This event has already ended.' };
  const cap = Number(ev.capacity) || 0;
  if (cap > 0 && goingCount >= cap) return { ok: false, error: 'This event is full.' };
  return { ok: true };
}

// =====================================================================================================
// 🚌 TRANSPORT
// =====================================================================================================
function parseStops(s) { try { const a = typeof s === 'string' ? JSON.parse(s) : s; return Array.isArray(a) ? a.map(x => clean(x, 80)).filter(Boolean) : []; } catch (_) { return String(s || '').split(/[\n,;]+/).map(x => clean(x, 80)).filter(Boolean); } }
function seatsLeft(route, activeCount) { const cap = Number(route && route.capacity) || 0; return cap > 0 ? Math.max(0, cap - (Number(activeCount) || 0)) : null; }
function canSubscribe(route, student, mySubs, activeCount) {
  if (!route || route.status !== 'active') return { ok: false, error: 'This route is not running.' };
  if (route.campus_id && student && student.campus_id && route.campus_id !== student.campus_id) return { ok: false, error: 'This route serves another campus.' };
  if ((mySubs || []).some(s => s && !s.deleted && ['requested', 'active'].includes(s.status))) return { ok: false, error: 'You already have a transport subscription (or a request) — cancel it first to change route.' };
  const left = seatsLeft(route, activeCount); if (left === 0) return { ok: false, error: 'This route is full.' };
  return { ok: true };
}

// =====================================================================================================
// 💼 CAREERS
// =====================================================================================================
const JOB_KINDS = { job: 'Job', internship: 'Internship', graduate_trainee: 'Graduate trainee', scholarship: 'Scholarship', volunteer: 'Volunteering' };
const APPLICATION_STATUS = ['submitted', 'shortlisted', 'rejected', 'hired', 'withdrawn'];
function applicationId(postId, studentId) { return did('ja', postId, studentId); }
function postOpen(p, now) { return !!p && p.status === 'published' && (!p.deadline || String(p.deadline).slice(0, 10) >= today(now)); }
function postVisibleTo(p, s) {
  if (!p || !s) return false;
  const alum = s.status === 'alumni' || s.status === 'graduated';
  if (p.audience === 'students' && alum) return false;
  if (p.audience === 'alumni' && !alum) return false;
  if (p.department_id && p.department_id !== s.department_id) return false;
  if (p.campus_id && s.campus_id && p.campus_id !== s.campus_id) return false;
  return true;
}
function validLink(u) { const s = String(u || '').trim(); return !s || /^https?:\/\/[^\s<>"']{3,500}$/i.test(s); }

module.exports = {
  clean, addMonths, addDays, today, localStamp, did,
  // research
  THESIS_PROGRAMMES, THESIS_STATUS, THESIS_STATUS_LABEL, VIVA_OUTCOMES, MILESTONE_KINDS, milestonePlan, milestoneOverdue, thesisProgress, statusAfterOutcome,
  // placements
  PLACEMENT_PROGRAMMES, PLACEMENT_STATUS, DEFAULT_WEIGHTS, weeksBetween, currentWeek, logId, canLogWeek, logbookCompletion, gradeFor, placementScore,
  // welfare
  BLOOD_GROUPS, GENOTYPES, COUNSEL_CATEGORIES, COUNSEL_MODES, RISK_LEVELS, STUDENT_HEALTH_FIELDS, healthId, cleanHealth, sickNoteView, sickNoteCovers, counsellingView,
  // clubs & events
  CLUB_CATEGORIES, EVENT_CATEGORIES, CLUB_ROLES, membershipId, rsvpId, audienceMatches, eventState, canRsvp,
  // transport
  parseStops, seatsLeft, canSubscribe,
  // careers
  JOB_KINDS, APPLICATION_STATUS, applicationId, postOpen, postVisibleTo, validLink,
};
