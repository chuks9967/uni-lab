'use strict';
/**
 * 🧾 FAIR COURSEWORK MARKING — ONE pure module (desk · portal · app via the portal · edge).
 *
 * 🐛 THE HOLES THIS FILLS
 *  • A mark was one number. Students could not see beforehand what the work would be judged on, and afterwards could
 *    not see where the marks went. → a RUBRIC: up to 10 criteria with their marks (adding up to the assignment's
 *    maximum); the marker gives a mark per criterion and the total follows.
 *  • "Late" was a flag and nothing else — every lecturer docked marks by hand, differently, or not at all.
 *    → a LATE POLICY on the assignment: so many % of the marks per day late (after a grace period), at most so much.
 *    It is counted against THE STUDENT'S OWN deadline (a Learning Support plan's extra days are on time), worked out
 *    when the work is marked, and can be waived WITH A REASON (illness, a documented emergency).
 *
 *   normalizeRubric · rubricText · scoreRubric · normalizeLatePolicy · describePolicy · lateMinutes · penaltyFor · finalScore
 */
const MAX_CRITERIA = 10;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n || 200); // eslint-disable-line no-control-regex
const pj = (s, d) => { if (s && typeof s === 'object') return s; try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };

/** A rubric from a list [{ label, max, guide }] or from text, one criterion per line: "Criterion | marks | what earns them".
 *  The criteria must add up to the assignment's maximum. Empty → no rubric. → { ok, rubric, total } | { ok:false, error } */
function normalizeRubric(input, maxScore) {
  let rows = [];
  if (Array.isArray(input)) rows = input.map(x => ({ label: x && x.label, max: x && x.max, guide: x && x.guide }));
  else if (typeof input === 'string') {
    for (const line of input.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length < 2) return { ok: false, error: 'Write each criterion as “Criterion | marks” (for example “Analysis | 30”).' };
      rows.push({ label: parts[0], max: parts[1], guide: parts.slice(2).join(' | ') });
    }
  } else if (input == null || input === '') rows = [];
  else return { ok: false, error: 'The rubric could not be read.' };
  if (!rows.length) return { ok: true, rubric: [], total: 0 };
  if (rows.length > MAX_CRITERIA) return { ok: false, error: 'At most ' + MAX_CRITERIA + ' criteria.' };
  const rubric = []; const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const label = clean(rows[i].label, 80); const max = Number(rows[i].max);
    if (!label) return { ok: false, error: 'Every criterion needs a name.' };
    if (!(max > 0 && max <= 1000)) return { ok: false, error: 'Give “' + label + '” its marks (a number above 0).' };
    if (seen.has(label.toLowerCase())) return { ok: false, error: 'Two criteria are called “' + label + '”.' };
    seen.add(label.toLowerCase());
    rubric.push({ key: 'c' + (i + 1), label, max: r2(max), guide: clean(rows[i].guide, 300) || '' });
  }
  const total = r2(rubric.reduce((s, c) => s + c.max, 0));
  const want = Number(maxScore);
  if (want > 0 && total !== r2(want)) return { ok: false, error: 'The criteria add up to ' + total + ' — the assignment is out of ' + r2(want) + '.' };
  return { ok: true, rubric, total };
}
/** The rubric back as editable text. */
const rubricText = (rubric) => (pj(rubric, []) || []).map(c => c.label + ' | ' + c.max + (c.guide ? ' | ' + c.guide : '')).join('\n');

/** A mark per criterion → { ok, total, marks } (every criterion marked, 0 … its max; half marks fine). */
function scoreRubric(rubric, marks) {
  const rb = pj(rubric, []) || []; const m = pj(marks, {}) || {};
  if (!rb.length) return { ok: false, error: 'This assignment has no rubric.' };
  const out = {}; let total = 0;
  for (const c of rb) {
    const v = m[c.key]; const n = Number(v);
    if (v == null || v === '' || !Number.isFinite(n)) return { ok: false, error: 'Give a mark for “' + c.label + '”.' };
    if (n < 0 || n > c.max) return { ok: false, error: '“' + c.label + '” is out of ' + c.max + '.' };
    out[c.key] = r2(n); total += n;
  }
  return { ok: true, total: r2(total), marks: out };
}

/** { per_day: % of the marks per day late (0–50; 0 = no penalty), cap: at most this % (0–100), grace_min: 0–240 } | null */
function normalizeLatePolicy(input) {
  const x = pj(input, null); if (!x) return null;
  const per = Math.max(0, Math.min(50, Number(x.per_day) || 0));
  if (!per) return null;
  const cap = Math.max(per, Math.min(100, Number(x.cap) || 100));
  return { per_day: r2(per), cap: r2(cap), grace_min: Math.max(0, Math.min(240, Math.round(Number(x.grace_min) || 0))) };
}
const describePolicy = (p) => { const x = normalizeLatePolicy(p); if (!x) return ''; return 'Late work loses ' + x.per_day + '% of the marks per day' + (x.cap < 100 ? ', at most ' + x.cap + '%' : '') + (x.grace_min ? ' (after ' + x.grace_min + ' minutes’ grace)' : '') + '.'; };

/** Minutes between two local wall-clock stamps "YYYY-MM-DDTHH:MM" (0 when on time). */
function lateMinutes(dueStamp, atStamp) {
  const d = Date.parse(String(dueStamp || '').slice(0, 16) + ':00Z'), a = Date.parse(String(atStamp || '').slice(0, 16) + ':00Z');
  if (!Number.isFinite(d) || !Number.isFinite(a) || a <= d) return 0;
  return Math.round((a - d) / 60000);
}
/** → { days (started days late, after the grace), pct, points } */
function penaltyFor(policy, minutes, maxScore) {
  const p = normalizeLatePolicy(policy); const m = Math.max(0, Number(minutes) || 0);
  if (!p || m <= p.grace_min) return { days: 0, pct: 0, points: 0 };
  const days = Math.ceil((m - p.grace_min) / 1440);
  const pct = Math.min(p.cap, r2(days * p.per_day));
  return { days, pct, points: r2((Number(maxScore) || 100) * pct / 100) };
}
/** The mark that stands: { raw, penalty, score, days, pct, waived } — never below 0; a waiver needs a reason. */
function finalScore(o) {
  const x = o || {}; const raw = r2(x.raw); const pen = penaltyFor(x.policy, x.minutes, x.maxScore);
  const waived = pen.points > 0 && clean(x.waive, 300).length >= 8 ? clean(x.waive, 300) : null;
  const penalty = waived ? 0 : Math.min(raw, pen.points);
  return { raw, penalty: r2(penalty), score: r2(raw - penalty), days: pen.days, pct: pen.pct, waived };
}

module.exports = { MAX_CRITERIA, normalizeRubric, rubricText, scoreRubric, normalizeLatePolicy, describePolicy, lateMinutes, penaltyFor, finalScore };
