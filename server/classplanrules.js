'use strict';
/**
 * 🗓 ONLINE CLASSES BEYOND THE CALL — the schedule, the reminders, catch-up for a missed class, and engagement.
 * Pure (no database, no clock unless passed), shared by the desk (electron/services/classplan.js), the portal and
 * the edge bundle, so a "missed" class or an "at risk" student means the same thing on every screen.
 *
 *   schedule     a lecturer books a class ahead (date, length, topic, agenda); their own double-booking is refused,
 *                and a clash with another class the same students have is a warning
 *   reminders    the day before (when booked far enough ahead) and 15 minutes before — each sent once
 *   catch-up     every class a student missed, with its recording, the materials shared around it and the
 *                questions answered in it — "attended" uses the SAME bar as the register (server/classregister.js)
 *   engagement   per student: classes attended, minutes, polls answered, questions asked → a score and an
 *                at-risk flag a lecturer acts on before the exam-attendance bar does
 */
const REG = require('./classregister');

const MIN_MINUTES = 10, MAX_MINUTES = 300, DEFAULT_MINUTES = 60;
const SOON_MIN = 15;
const parseT = (s) => { const t = Date.parse(String(s || '')); return Number.isFinite(t) ? t : null; };
const nowMs = (now) => now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now));
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n || 500);
// the instant (starts_utc, set by whoever booked it — the browser / the app send it, the desk derives it) drives every
// comparison; starts_at is the wall-clock time people read, so a cloud server in UTC is never an hour out
const instantOf = (r) => parseT(r && (r.starts_utc || r.starts_at));
const span = (r) => { const s = instantOf(r); return s == null ? null : [s, s + (Number(r.minutes) > 0 ? Number(r.minutes) : DEFAULT_MINUTES) * 60000]; };
const overlaps = (a, b) => { const x = span(a), y = span(b); return !!(x && y && x[0] < y[1] && y[0] < x[1]); };

/**
 * Check a class booking. input = { starts_at 'YYYY-MM-DDTHH:MM', minutes, topic, agenda }; ctx = { now, mine: [the
 * lecturer's other booked classes], cohort: [other classes booked for the same students], id (when moving) }.
 * → { ok, row, errors, warnings }
 */
function validate(input, ctx = {}) {
  const errors = [], warnings = [];
  const starts = String(input && input.starts_at || '').trim();
  const utc = input && input.starts_utc && /(Z|[+-]\d{2}:?\d{2})$/.test(String(input.starts_utc)) ? parseT(input.starts_utc) : null;
  const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(starts) ? (utc != null ? utc : parseT(starts)) : null;
  if (t == null) errors.push('Choose the date and time of the class.');
  else if (t < nowMs(ctx.now) + 5 * 60000) errors.push('A class is booked for a time still to come.');
  const raw = parseInt(input && input.minutes, 10);
  const minutes = Number.isFinite(raw) ? raw : DEFAULT_MINUTES;
  if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) errors.push('A class lasts between ' + MIN_MINUTES + ' minutes and ' + (MAX_MINUTES / 60) + ' hours.');
  const topic = clean(input && input.topic, 200);
  if (topic.length < 3) errors.push('Say what the class is about (the topic).');
  const row = { starts_at: starts.slice(0, 16), starts_utc: t != null ? new Date(t).toISOString() : null, minutes, topic, agenda: clean(input && input.agenda, 3000) || null };
  if (!errors.length) {
    const others = (list) => (list || []).filter(x => x && x.id !== ctx.id && (x.status || 'scheduled') === 'scheduled');
    const mine = others(ctx.mine).find(x => overlaps(row, x));
    if (mine) errors.push('You already have ' + (mine.course_code || 'a class') + ' booked then (' + String(mine.starts_at).replace('T', ' ') + ').');
    const theirs = others(ctx.cohort).find(x => overlaps(row, x));
    if (theirs) warnings.push('The same students have ' + (theirs.course_code || 'another class') + ' booked then (' + String(theirs.starts_at).replace('T', ' ') + ').');
  }
  return { ok: !errors.length, row, errors, warnings };
}

/** Where a booked class stands now: upcoming · starting (≤15 min) · live · ended · cancelled. */
function stateOf(row, now, liveRooms) {
  if (!row) return 'ended';
  if (row.status === 'cancelled') return 'cancelled';
  const s = span(row); if (!s) return 'ended';
  const t = nowMs(now);
  if (liveRooms && liveRooms.has && liveRooms.has(row.room) && t >= s[0] - 30 * 60000 && t <= s[1] + 60 * 60000) return 'live';
  if (t > s[1]) return 'ended';
  if (t >= s[0]) return 'live';
  return t >= s[0] - SOON_MIN * 60000 ? 'starting' : 'upcoming';
}
/** Which reminders are due now (each once): 'day' — 1 h to 24 h before; 'soon' — 20 min before to 5 min after the start. */
function remindersDue(row, now) {
  if (!row || (row.status || 'scheduled') !== 'scheduled') return [];
  const s = span(row); if (!s) return [];
  const left = s[0] - nowMs(now); const out = [];
  if (!row.remind_day_at && left > 60 * 60000 && left <= 24 * 3600000) out.push('day');
  if (!row.remind_soon_at && left <= 20 * 60000 && left >= -5 * 60000) out.push('soon');
  return out;
}

/** The register's bar for one held class: did this student attend? */
function attended(seconds, ranSeconds, rule) { const s = Number(seconds) || 0; return s > 0 && s >= REG.barFor(ranSeconds, rule || REG.presenceRule()); }
const dayOf = (iso) => String(iso || '').slice(0, 10);
function addDays(ymd, n) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || '')); if (!m) return null; return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10); }

/**
 * The classes a student missed, newest first, each with what helps them catch up.
 * sessions = held class sessions of the student's cohort [{ id, room, subject, course_code, started_at, heartbeat_at }]
 * presence = this student's live_attendance rows [{ room, date, seconds }]
 * recordings = [{ id, room, session_ref, subject, status, published, started_at, duration_sec }]
 * materials = [{ id, room, title, kind, created_at, published }]; questions = [{ room, date, resolved, answer }]
 */
function catchUp({ sessions, presence, recordings, materials, questions, rule, now } = {}) {
  const t = nowMs(now);
  // one class = one room on one day (a host who reconnects makes several sessions)
  const byClass = new Map();
  for (const s of sessions || []) {
    if (!s || !s.room || !s.started_at) continue;
    const end = parseT(s.heartbeat_at || s.updated_at || s.started_at);
    if (end != null && t - end < 10 * 60000 && s.active !== 0 && s.active !== '0') continue;   // still running
    const k = s.room + '|' + dayOf(s.started_at);
    // the session subject usually starts with the course code ("UIC101 Computing Basics") — keep it once
    const code = s.course_code || ''; let subj = s.subject || s.course_title || '';
    if (code) {
      // walk past the code's letters and digits at the start of the subject, ignoring spaces ("CSC 305" = "CSC305")
      const want = code.toUpperCase().replace(/[^A-Z0-9]/g, ''); let i = 0, j = 0;
      while (i < subj.length && j < want.length) { const ch = subj[i].toUpperCase(); if (ch === want[j]) { i++; j++; } else if (/[\s\-]/.test(ch)) i++; else break; }
      if (j === want.length) subj = subj.slice(i).replace(/^[\s\-–—:]+/, '').trim() || s.course_title || '';
    }
    const g = byClass.get(k) || { room: s.room, date: dayOf(s.started_at), course_code: code, subject: subj, sessions: [] };
    g.sessions.push(s); byClass.set(k, g);
  }
  const seen = new Map(); for (const p of presence || []) { const k = p.room + '|' + p.date; seen.set(k, (seen.get(k) || 0) + (Number(p.seconds) || 0)); }
  const out = [];
  for (const g of byClass.values()) {
    const ran = REG.ranSecondsFrom(g.sessions);
    const secs = seen.get(g.room + '|' + g.date) || 0;
    if (attended(secs, ran, rule)) continue;
    const ids = new Set(g.sessions.map(s => s.id));
    const rec = (recordings || []).filter(r => r && r.room === g.room && r.status === 'ready' && Number(r.published) !== 0 && (ids.has(r.session_ref) || dayOf(r.started_at || r.created_at) === g.date))[0] || null;
    const mats = (materials || []).filter(m => m && m.room === g.room && Number(m.published) !== 0 && dayOf(m.created_at) >= addDays(g.date, -2) && dayOf(m.created_at) <= addDays(g.date, 3)).slice(0, 8);
    const qs = (questions || []).filter(q => q && q.room === g.room && q.date === g.date && q.resolved && q.answer);
    out.push({ room: g.room, date: g.date, course_code: g.course_code, subject: g.subject, ran_minutes: Math.round(ran / 60), my_minutes: Math.round(secs / 60), partial: secs > 0,
      recording: rec ? { id: rec.id, minutes: rec.duration_sec ? Math.round(rec.duration_sec / 60) : null } : null,
      materials: mats.map(m => ({ id: m.id, title: m.title || 'Material', kind: m.kind || 'other' })), answered: qs.length });
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * Engagement in ONE course (room) for its roster. held = the classes held (by day), votes / questions by student.
 * → [{ student_id, held, attended, pct, minutes, polls, polls_answered, questions, score, at_risk, streak_missed }]
 */
function engagement({ roster, sessions, presence, polls, votes, questions, rule, riskPct } = {}) {
  const byDay = new Map(); for (const s of sessions || []) { if (!s || !s.started_at) continue; const d = dayOf(s.started_at); const a = byDay.get(d) || []; a.push(s); byDay.set(d, a); }
  const days = [...byDay.keys()].sort();
  const ran = new Map(days.map(d => [d, REG.ranSecondsFrom(byDay.get(d))]));
  const pres = new Map(); for (const p of presence || []) { const k = p.student_id + '|' + p.date; pres.set(k, (pres.get(k) || 0) + (Number(p.seconds) || 0)); }
  const pollIds = new Set((polls || []).map(p => p.id));
  const voted = new Map(); for (const v of votes || []) if (v && pollIds.has(v.poll_id) && v.student_id) { const s = voted.get(v.student_id) || new Set(); s.add(v.poll_id); voted.set(v.student_id, s); }
  const asked = new Map(); for (const q of questions || []) if (q && q.student_id) asked.set(q.student_id, (asked.get(q.student_id) || 0) + 1);
  const risk = Number(riskPct) > 0 ? Number(riskPct) : 50;
  return (roster || []).map(st => {
    let att = 0, secs = 0, streak = 0;
    for (const d of days) { const s = pres.get(st.id + '|' + d) || 0; secs += s; if (attended(s, ran.get(d), rule)) { att++; streak = 0; } else streak++; }
    const held = days.length; const pct = held ? Math.round(att * 100 / held) : null;
    const pollsHeld = pollIds.size; const answered = (voted.get(st.id) || new Set()).size; const q = asked.get(st.id) || 0;
    const pollPct = pollsHeld ? answered * 100 / pollsHeld : null;
    const score = held ? Math.round(0.7 * pct + 0.2 * (pollPct == null ? pct : pollPct) + 0.1 * Math.min(100, q * 50)) : null;
    return { student_id: st.id, name: st.name || '', matric: st.matric || '', held, attended: att, pct, minutes: Math.round(secs / 60), polls: pollsHeld, polls_answered: answered, questions: q, score,
      streak_missed: streak, at_risk: held >= 2 && (pct < risk || streak >= 3) };
  }).sort((a, b) => (a.score == null ? 1 : 0) - (b.score == null ? 1 : 0) || (a.score || 0) - (b.score || 0));
}

module.exports = { MIN_MINUTES, MAX_MINUTES, DEFAULT_MINUTES, SOON_MIN, validate, overlaps, stateOf, remindersDue, attended, catchUp, engagement, addDays };
