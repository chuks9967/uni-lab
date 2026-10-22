'use strict';
/**
 * 🎓 FINAL-YEAR PROJECTS & DEFENCES — the pure rules, shared by the desk (electron/services/defense.js) and the portal
 * (server/portal.js, vendored to the edge), so a topic check, a panel check, a clash or a defence score is the SAME
 * answer on every screen and on the phone.
 *
 *   topics      — a student proposes up to three topics; each is compared with every project the department has
 *                 (past and present) and with the other proposals, so a copied or recycled topic is seen before it
 *                 is approved. Boilerplate ("design and implementation of…", "a case study of…") does not count.
 *   allocation  — supervisors are given out by load (fewest active students first), never above the cap.
 *   panel       — one chair, at least one examiner who did not supervise, an external examiner for a doctorate, the
 *                 supervisor never chairs their own student's defence, nobody sits twice.
 *   timetable   — a defence clashes when an examiner, the student or the room is booked twice at the same time.
 *   scoring     — every panel member scores the rubric; the defence score is the average of the sheets, and a wide
 *                 spread between examiners is flagged for the chair to reconcile before the score is posted.
 *   corrections — a verdict with corrections sets a due date; the student submits, the supervisor signs off.
 */

const ROLES = { chair: 'Chair', supervisor: 'Supervisor', internal: 'Internal examiner', external: 'External examiner', member: 'Panel member' };
const MODES = { in_person: 'In person', online: 'Online', hybrid: 'Hybrid (room + online)' };
const TOPIC_STATUS = { proposed: 'Proposed', approved: 'Approved', rejected: 'Not approved', not_chosen: 'Another topic was approved', withdrawn: 'Withdrawn' };
const DEFAULT_RUBRIC = [
  { key: 'problem', label: 'Problem statement & objectives', max: 15 },
  { key: 'literature', label: 'Literature review', max: 15 },
  { key: 'method', label: 'Methodology', max: 20 },
  { key: 'results', label: 'Results & analysis', max: 20 },
  { key: 'report', label: 'Written report', max: 10 },
  { key: 'oral', label: 'Oral presentation', max: 10 },
  { key: 'questions', label: 'Answers to questions', max: 10 },
];
const MAX_TOPICS = 3;
const SIMILAR_AT = 0.35;      // shown to the HOD
const VERY_SIMILAR_AT = 0.6;  // flagged red
const SPREAD_LIMIT = 15;      // examiners more than 15 points apart → the chair reconciles
const DEFAULT_CAP = 8;        // active project students per supervisor
const CORRECTION_DAYS = { minor: 30, major: 90 };
const DEFAULT_MINUTES = 45;

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n || 500);
const day = (d) => String(d || '').slice(0, 10);
const todayOf = (now) => new Date(now == null ? Date.now() : now).toISOString().slice(0, 10);
function addDays(ymd, n) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || '')); if (!m) return null; return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10); }
function daysBetween(a, b) { const x = Date.parse(day(a) + 'T00:00:00Z'), y = Date.parse(day(b) + 'T00:00:00Z'); return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : null; }

// =====================================================================================================
// 💡 TOPICS — duplicate / recycled-topic detection
// =====================================================================================================
// words that every project title has — they say nothing about WHAT the project is
const STOP = new Set(('a an the of and or for to in on at by with from into within via as its is are be using use based towards toward '
  + 'design designing implementation implementing implement development developing develop develops developed '
  + 'case study studies analysis analysing analyzing evaluation evaluating assessment assessing investigation investigating '
  + 'approach effect effects impact role roles towards proposed new improved improving improve enhanced enhancing '
  + 'computerised computerized automated automation online web-based webbased application app '
  + 'de des du la le les et pour dans sur une un en par au aux avec').split(/\s+/));
function stem(w) { if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y'; if (w.length > 4 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1); return w; }
/** The content words of a title, lower-cased, de-pluralised, boilerplate removed. */
function topicWords(title) {
  return (String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || []).filter(w => !STOP.has(w) && w.length > 1).map(stem);
}
function jaccard(a, b) { if (!a.size && !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); }
/**
 * How alike two titles are, 0..1: shared content words (40%), how much of the shorter title is inside the longer one
 * (30% — "hostel management system" is the same project "for universities" or "for WAUU"), and shared word pairs
 * (30%, so word order counts a little).
 */
function topicSimilarity(a, b) {
  const wa = topicWords(a), wb = topicWords(b);
  if (!wa.length || !wb.length) return 0;
  const big = (w) => new Set(w.slice(1).map((x, i) => w[i] + ' ' + x));
  const sa = new Set(wa), sb = new Set(wb);
  let inter = 0; for (const x of sa) if (sb.has(x)) inter++;
  const j1 = jaccard(sa, sb), contain = inter / Math.min(sa.size, sb.size), ba = big(wa), bb = big(wb);
  const j2 = (ba.size && bb.size) ? jaccard(ba, bb) : j1;
  return Math.round((0.4 * j1 + 0.3 * contain + 0.3 * j2) * 1000) / 1000;
}
const similarLevel = (s) => s >= VERY_SIMILAR_AT ? 'very_similar' : s >= SIMILAR_AT ? 'similar' : 'different';
/** The existing projects / proposals most like `title`: [{ id, title, score, level, …meta }], most alike first (top 5). */
function similarTopics(title, pool, opts = {}) {
  const at = opts.at == null ? SIMILAR_AT : opts.at;
  const out = [];
  for (const p of pool || []) {
    if (!p || !p.title || (opts.exclude && opts.exclude(p))) continue;
    const score = topicSimilarity(title, p.title);
    if (score >= at) out.push(Object.assign({}, p, { score, level: similarLevel(score) }));
  }
  return out.sort((x, y) => y.score - x.score).slice(0, opts.limit || 5);
}
/** A student's set of proposed topics: 1–3 distinct, sensible titles. Returns { ok, topics:[{title, summary, rank}] } or { ok:false, error }. */
function validateTopics(list) {
  const rows = (Array.isArray(list) ? list : []).map(x => ({ title: clean(x && x.title, 300), summary: clean(x && x.summary, 2000) })).filter(x => x.title);
  if (!rows.length) return { ok: false, error: 'Enter at least one topic.' };
  if (rows.length > MAX_TOPICS) return { ok: false, error: 'You can propose at most ' + MAX_TOPICS + ' topics at a time.' };
  for (const r of rows) {
    if (r.title.length < 15 || topicWords(r.title).length < 2) return { ok: false, error: 'Write each topic in full — “' + r.title + '” is too short to judge.' };
  }
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (topicSimilarity(rows[i].title, rows[j].title) >= VERY_SIMILAR_AT) return { ok: false, error: 'Two of your topics are almost the same — propose different ideas.' };
  return { ok: true, topics: rows.map((r, i) => Object.assign(r, { rank: i + 1 })) };
}

// =====================================================================================================
// 👥 SUPERVISOR ALLOCATION — by load, never above the cap
// =====================================================================================================
/**
 * Give each project a supervisor from `staff` ([{ id, name, department_id }]), fewest active students first.
 * `load` = { staff_id: active count }. A project keeps a supervisor from its own department when one has room.
 * Returns { assignments: [{ project_id, staff_id, name }], unassigned: [{ project_id, reason }] }.
 */
function allocate(projects, staff, load, opts = {}) {
  const cap = Number(opts.cap) > 0 ? Number(opts.cap) : DEFAULT_CAP;
  const cur = Object.assign({}, load || {});
  const assignments = [], unassigned = [];
  for (const p of projects || []) {
    const pool = (staff || []).filter(s => s && s.id && (cur[s.id] || 0) < cap);
    const own = pool.filter(s => p.department_id && s.department_id === p.department_id);
    const from = own.length ? own : (opts.sameDepartmentOnly ? [] : pool);
    if (!from.length) { unassigned.push({ project_id: p.id, reason: pool.length ? 'No supervisor in the department has room.' : 'Every supervisor has reached the limit of ' + cap + '.' }); continue; }
    const pick = from.slice().sort((a, b) => ((cur[a.id] || 0) - (cur[b.id] || 0)) || String(a.name || '').localeCompare(String(b.name || '')))[0];
    cur[pick.id] = (cur[pick.id] || 0) + 1;
    assignments.push({ project_id: p.id, staff_id: pick.id, name: pick.name || '' });
  }
  return { assignments, unassigned, load: cur };
}

// =====================================================================================================
// 🧑‍⚖️ THE PANEL
// =====================================================================================================
/** The person behind a panel row — a staff id, or the external examiner's e-mail / name. */
const personKey = (m) => m.staff_id ? 's:' + m.staff_id : 'x:' + String(m.email || m.name || '').trim().toLowerCase();
/**
 * Check a defence panel. `members` = [{ staff_id?, name, email?, role, absent? }], `thesis` = { programme, supervisor_id, co_supervisor_id }.
 * Returns { ok, errors: [..], warnings: [..] } — errors block scheduling, warnings are shown.
 */
function checkPanel(members, thesis) {
  const ms = (members || []).filter(m => m && !Number(m.deleted));
  const errors = [], warnings = [];
  const t = thesis || {};
  if (!ms.length) return { ok: false, errors: ['Add the panel — a chair and at least one examiner.'], warnings };
  const seen = new Set();
  for (const m of ms) { const k = personKey(m); if (seen.has(k)) errors.push((m.name || 'Someone') + ' is on the panel twice.'); seen.add(k); if (!ROLES[m.role]) errors.push('Choose a role for ' + (m.name || 'every member') + '.'); }
  const chairs = ms.filter(m => m.role === 'chair');
  if (!chairs.length) errors.push('Name the chair of the panel.');
  if (chairs.length > 1) errors.push('A panel has one chair.');
  const sup = new Set([t.supervisor_id, t.co_supervisor_id].filter(Boolean));
  if (chairs.some(c => c.staff_id && sup.has(c.staff_id))) errors.push('The supervisor cannot chair their own student’s defence.');
  const examiners = ms.filter(m => m.role !== 'supervisor' && !(m.staff_id && sup.has(m.staff_id)));
  if (!examiners.some(m => m.role === 'internal' || m.role === 'external' || m.role === 'member' || m.role === 'chair')) errors.push('At least one examiner must be someone who did not supervise the work.');
  if (/^(PhD|MPhil)$/i.test(String(t.programme || '')) && !ms.some(m => m.role === 'external')) errors.push('A doctoral defence needs an external examiner.');
  else if (/^(MSc|MA|MBA|MEd|LLM)$/i.test(String(t.programme || '')) && !ms.some(m => m.role === 'external')) warnings.push('A master’s defence usually has an external examiner.');
  if (ms.filter(m => !Number(m.absent)).length < 2) warnings.push('Fewer than two panel members will score this defence.');
  if (ms.some(m => m.role === 'external' && !m.staff_id && !m.email)) warnings.push('Add the external examiner’s e-mail so the invitation can reach them.');
  return { ok: !errors.length, errors, warnings };
}

// =====================================================================================================
// 🗓 THE TIMETABLE — clashes
// =====================================================================================================
function span(d) {
  const s = Date.parse(String(d.start || ''));
  if (!Number.isFinite(s)) return null;
  const mins = Number(d.minutes) > 0 ? Number(d.minutes) : DEFAULT_MINUTES;
  return [s, s + mins * 60000];
}
/**
 * Every clash between defences: an examiner booked twice, the student booked twice, or one room for two
 * in-person defences at once. `defences` = [{ id, start, minutes, venue, mode, student_id, members:[{key,name}] }].
 * Returns [{ a, b, kind: 'examiner'|'student'|'venue', who }].
 */
function clashes(defences) {
  const ds = (defences || []).map(d => ({ d, s: span(d) })).filter(x => x.s).sort((x, y) => x.s[0] - y.s[0]);
  const out = [];
  for (let i = 0; i < ds.length; i++) {
    for (let j = i + 1; j < ds.length && ds[j].s[0] < ds[i].s[1]; j++) {
      const a = ds[i].d, b = ds[j].d;
      if (a.student_id && a.student_id === b.student_id) out.push({ a: a.id, b: b.id, kind: 'student', who: a.student || 'The same student' });
      const bk = new Map((b.members || []).map(m => [m.key, m.name]));
      for (const m of a.members || []) if (m.key && bk.has(m.key)) out.push({ a: a.id, b: b.id, kind: 'examiner', who: m.name || bk.get(m.key) || '' });
      const room = (x) => x.mode !== 'online' && String(x.venue || '').trim().toLowerCase();
      if (room(a) && room(a) === room(b)) out.push({ a: a.id, b: b.id, kind: 'venue', who: a.venue });
    }
  }
  return out;
}
/** Is the defence now (from 15 minutes before to the end) — when the join button shows. */
function isLive(start, minutes, now) {
  const s = span({ start, minutes }); if (!s) return false;
  const t = now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now));
  return t >= s[0] - 15 * 60000 && t <= s[1] + 30 * 60000;
}

// =====================================================================================================
// 📝 SCORING
// =====================================================================================================
/** A rubric from settings / the thesis, or the default. Criteria need a key, a label and a positive maximum. */
function normalizeRubric(r) {
  let list = r;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (_) { list = null; } }
  if (!Array.isArray(list) || !list.length) return DEFAULT_RUBRIC.map(x => Object.assign({}, x));
  const seen = new Set(); const out = [];
  for (const c of list) {
    const label = clean(c && c.label, 120); const max = Number(c && c.max);
    let key = clean(c && c.key, 40).toLowerCase().replace(/[^a-z0-9_]/g, '_') || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
    if (!label || !(max > 0) || max > 1000) throw new Error('Each criterion needs a name and a maximum mark above 0.');
    while (seen.has(key)) key += '_';
    seen.add(key); out.push({ key, label, max: r2(max) });
  }
  if (out.length > 20) throw new Error('A rubric has at most 20 criteria.');
  return out;
}
const rubricTotal = (rubric) => r2((rubric || []).reduce((s, c) => s + Number(c.max || 0), 0));
/** Check one examiner's sheet: every criterion scored, 0 ≤ mark ≤ max. Returns { ok, scores, total, pct } or { ok:false, error }. */
function checkSheet(rubric, scores) {
  const rb = normalizeRubric(rubric); const src = scores || {}; const out = {};
  for (const c of rb) {
    const raw = src[c.key];
    if (raw == null || raw === '') return { ok: false, error: 'Score “' + c.label + '”.' };
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > c.max) return { ok: false, error: '“' + c.label + '” is marked out of ' + c.max + '.' };
    out[c.key] = r2(v);
  }
  const total = r2(Object.values(out).reduce((s, v) => s + v, 0));
  const max = rubricTotal(rb);
  return { ok: true, scores: out, total, pct: max ? r2(total * 100 / max) : 0 };
}
/**
 * The defence score from the sheets. `panel` = [{ id, name, role, absent }], `sheets` = [{ member_id, scores, total }].
 * Expected = every member not marked absent. The score is the average of the submitted sheets, as a percentage.
 * Returns { expected, scored, complete, missing:[names], criteria:[{key,label,max,mean}], pct, spread, disagree, sheets:[…] }.
 */
function aggregate(rubric, panel, sheets, opts = {}) {
  const rb = normalizeRubric(rubric); const max = rubricTotal(rb);
  const members = (panel || []).filter(m => m && !Number(m.deleted));
  const present = members.filter(m => !Number(m.absent));
  const byMember = new Map((sheets || []).filter(s => s && !Number(s.deleted)).map(s => [s.member_id, s]));
  const used = present.map(m => ({ m, s: byMember.get(m.id) })).filter(x => x.s);
  const parse = (s) => { let sc = s.scores; if (typeof sc === 'string') { try { sc = JSON.parse(sc); } catch (_) { sc = {}; } } return sc || {}; };
  const criteria = rb.map(c => {
    const vals = used.map(x => Number(parse(x.s)[c.key])).filter(Number.isFinite);
    return { key: c.key, label: c.label, max: c.max, mean: vals.length ? r2(vals.reduce((a, b) => a + b, 0) / vals.length) : null };
  });
  const pcts = used.map(x => max ? r2(Number(x.s.total || 0) * 100 / max) : 0);
  const pct = pcts.length ? r2(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
  const spread = pcts.length > 1 ? r2(Math.max(...pcts) - Math.min(...pcts)) : 0;
  const limit = opts.spreadLimit == null ? SPREAD_LIMIT : Number(opts.spreadLimit);
  return {
    expected: present.length, scored: used.length, complete: present.length > 0 && used.length === present.length,
    missing: present.filter(m => !byMember.has(m.id)).map(m => m.name || ROLES[m.role] || 'A member'),
    criteria, max, pct, spread, disagree: spread > limit, limit,
    sheets: used.map((x, i) => ({ member_id: x.m.id, name: x.m.name, role: x.m.role, total: r2(x.s.total), pct: pcts[i], comment: x.s.comment || '', submitted_at: x.s.submitted_at || null })),
  };
}
/** Does the verdict agree with the score? A pass below the pass mark, or a fail well above it, is worth a second look. */
function verdictCheck(outcome, pct, passMark) {
  const pm = Number(passMark) > 0 ? Number(passMark) : 40;
  if (pct == null || !outcome) return null;
  if ((outcome === 'pass' || outcome === 'minor') && pct < pm) return 'The verdict is a pass but the panel’s score (' + pct + '%) is below the pass mark of ' + pm + '%.';
  if (outcome === 'fail' && pct >= pm + 10) return 'The verdict is a fail but the panel’s score (' + pct + '%) is well above the pass mark of ' + pm + '%.';
  return null;
}

// =====================================================================================================
// ✏️ CORRECTIONS
// =====================================================================================================
/** When corrections are due after a verdict given on `on` (YYYY-MM-DD): minor → 30 days, major → 90 (settable). */
function correctionsDue(outcome, on, days) {
  const d = Object.assign({}, CORRECTION_DAYS, days || {});
  return d[outcome] ? addDays(day(on), Number(d[outcome])) : null;
}
/** Where a student's corrections stand: none · due · overdue · submitted · approved — with days left. */
function correctionsState(t, now) {
  if (!t || !t.corrections_due) return { state: 'none' };
  if (t.corrections_approved_at) return { state: 'approved', due: day(t.corrections_due), approved_at: t.corrections_approved_at };
  if (t.corrections_submitted_at) return { state: 'submitted', due: day(t.corrections_due), submitted_at: t.corrections_submitted_at };
  const left = daysBetween(todayOf(now), t.corrections_due);
  return { state: left < 0 ? 'overdue' : 'due', due: day(t.corrections_due), days_left: left };
}

module.exports = {
  ROLES, MODES, TOPIC_STATUS, DEFAULT_RUBRIC, MAX_TOPICS, SIMILAR_AT, VERY_SIMILAR_AT, SPREAD_LIMIT, DEFAULT_CAP, CORRECTION_DAYS, DEFAULT_MINUTES,
  topicWords, topicSimilarity, similarLevel, similarTopics, validateTopics, allocate, personKey, checkPanel, clashes, isLive,
  normalizeRubric, rubricTotal, checkSheet, aggregate, verdictCheck, correctionsDue, correctionsState, addDays,
};
