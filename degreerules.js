'use strict';
/**
 * 🎓 DEGREE PROGRESS — "how far am I from graduating, and what do I take next?" Pure, shared by the desk's degree
 * audit (electron/services/degreeaudit.js), the student portal / app and the edge bundle, so the registry and the
 * student read the same audit.
 *
 *   allocate / summarise   each PASSED course's credits go to the FIRST matching requirement (specific rules before
 *                          the catch-all, so nothing is counted twice) → per-requirement progress + the shortfall
 *   pickProgram            the programme a student is held to: their department, the latest catalog year on or
 *                          before their intake year
 *   passedFrom             one row per course (the latest attempt), passes only
 *   suggest                for every unmet requirement, catalogue courses that would count, not yet passed or
 *                          registered, whose prerequisites are met — lowest level first
 *   afterThisTerm          the same audit if the courses registered now are passed ("what if")
 *   projection             terms left at the student's own pace (average credits per term so far)
 */
const norm = (s) => String(s == null ? '' : s).trim();
const codeKey = (c) => norm(c).toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const r1 = (n) => Math.round(n * 10) / 10;
function alphaPrefix(code) { const m = /^([A-Za-z]+)/.exec(codeKey(code)); return m ? m[1] : ''; }
function levelDigit(code) { const m = /(\d)/.exec(codeKey(code)); return m ? m[1] : ''; }
function yearOf(label) { const m = /(\d{4})/.exec(String(label || '')); return m ? Number(m[1]) : 0; }

function ruleMatches(rule, code) {
  const kind = norm(rule.match_kind) || 'any';
  if (kind === 'any') return true;
  const key = codeKey(code);
  const vals = norm(rule.match_value).split(/[\s,;]+/).map(v => codeKey(v)).filter(Boolean);
  if (kind === 'list') return vals.includes(key);
  if (kind === 'prefix') return vals.some(v => key.startsWith(v)) || vals.includes(alphaPrefix(code));
  if (kind === 'level') return vals.includes(levelDigit(code));
  return false;
}
/** The catch-all 'any' rule is always tried LAST, so it never takes a credit a specific rule wanted. */
function orderRules(rules) {
  return (rules || []).slice().sort((a, b) => (norm(a.match_kind) === 'any' ? 1 : 0) - (norm(b.match_kind) === 'any' ? 1 : 0) || num(a.sort_order) - num(b.sort_order));
}
/** passed = [{ code, credits }], rules pre-ordered → { byRule: { id: { earned, courses } }, unallocated } */
function allocate(passed, rules) {
  const byRule = {};
  for (const r of rules) byRule[r.id] = { earned: 0, courses: [] };
  const unallocated = [];
  for (const c of passed) {
    const rule = rules.find(r => ruleMatches(r, c.code));
    if (rule) { const b = byRule[rule.id]; b.earned += num(c.credits); b.courses.push(c); }
    else unallocated.push(c);
  }
  return { byRule, unallocated };
}
/** → { categories, creditsEarned, creditsRequired, creditsRemaining, percent, met, needs } */
function summarise(program, rules, alloc, passedTotalCredits) {
  const categories = rules.map(r => {
    const b = alloc.byRule[r.id] || { earned: 0, courses: [] };
    const min = num(r.min_credits); const remaining = Math.max(0, min - b.earned);
    return { id: r.id, title: r.title || 'Requirement', min, earned: r1(b.earned), remaining: r1(remaining), met: b.earned + 1e-6 >= min, courses: b.courses.map(c => ({ code: c.code, credits: c.credits })) };
  });
  const rulesMin = rules.reduce((s, r) => s + num(r.min_credits), 0);
  const creditsRequired = num(program.total_credits) || rulesMin;
  const creditsEarned = r1(passedTotalCredits);
  const creditsRemaining = Math.max(0, r1(creditsRequired - creditsEarned));
  const percent = creditsRequired > 0 ? Math.min(100, Math.round((creditsEarned / creditsRequired) * 100)) : 0;
  const needs = categories.filter(c => !c.met).map(c => `${c.remaining} more credit${c.remaining === 1 ? '' : 's'} in ${c.title}`);
  if (creditsRemaining > 0) needs.push(`${creditsRemaining} more credit${creditsRemaining === 1 ? '' : 's'} overall`);
  const met = creditsRemaining <= 0 && categories.every(c => c.met);
  return { categories, creditsEarned, creditsRequired, creditsRemaining, percent, met, needs };
}
/** The programme for this student: their department's active programmes, the newest catalog on/before the intake year. */
function pickProgram(programs, departmentId, entryYear) {
  const progs = (programs || []).filter(p => p && !Number(p.deleted) && p.department_id === departmentId && (p.active == null || Number(p.active) === 1))
    .sort((a, b) => yearOf(b.catalog_year) - yearOf(a.catalog_year));
  if (!progs.length) return null;
  if (entryYear) { const ok = progs.filter(p => yearOf(p.catalog_year) <= entryYear); if (ok.length) return ok[0]; }
  return progs[0];
}
/** One row per course (latest attempt), passes only. isPass(grade) decides; default: any grade but F / FAIL. */
function passedFrom(scores, isPass) {
  const best = new Map();
  for (const r of scores || []) { if (!r || Number(r.deleted)) continue; const k = codeKey(r.course_code); const prev = best.get(k); if (!prev || String(r.created_at || '') > String(prev.created_at || '')) best.set(k, r); }
  const out = [];
  for (const r of best.values()) {
    const g = norm(r.grade).toUpperCase();
    const ok = typeof isPass === 'function' ? (g && isPass(g)) : (g && g !== 'F' && g !== 'FAIL');
    if (ok) out.push({ code: r.course_code, credits: num(r.credit_unit), grade: g });
  }
  return out;
}
/** Run the audit for one programme. */
function audit(program, rules, passed) {
  const rs = orderRules(rules && rules.length ? rules : [{ id: '_all', title: 'All courses', min_credits: num(program.total_credits), match_kind: 'any', match_value: '' }]);
  const alloc = allocate(passed, rs);
  const total = passed.reduce((s, c) => s + num(c.credits), 0);
  return Object.assign(summarise(program, rs, alloc, total), { unallocatedCredits: r1(alloc.unallocated.reduce((s, c) => s + num(c.credits), 0)), rules: rs });
}
/**
 * Courses that would count towards each unmet requirement. catalogue = [{ code, title, credit_unit, prerequisites,
 * department_id, level_id }]; taken = Set of codeKeys passed or registered now; unmetFn(prereqText) → unmet groups.
 */
function suggest(summary, catalogue, taken, unmetFn, limit) {
  const out = [];
  const claimed = new Set();
  for (const c of summary.categories) {
    if (c.met) continue;
    const rule = (summary.rules || []).find(r => r.id === c.id); if (!rule) continue;
    const list = (catalogue || []).filter(x => x && x.code && !taken.has(codeKey(x.code)) && !claimed.has(codeKey(x.code)) && ruleMatches(rule, x.code))
      // the catch-all would match every course — then only the student's own department's catalogue counts
      .filter(x => norm(rule.match_kind) !== 'any' || !summary.departmentId || x.department_id === summary.departmentId)
      .map(x => ({ code: String(x.code).toUpperCase().trim(), title: x.title || '', credits: num(x.credit_unit), level: levelDigit(x.code), blocked: typeof unmetFn === 'function' ? unmetFn(x.prerequisites || '') : [] }))
      .sort((a, b) => (a.blocked.length ? 1 : 0) - (b.blocked.length ? 1 : 0) || String(a.level).localeCompare(String(b.level)) || a.code.localeCompare(b.code))
      .slice(0, limit || 6);
    for (const x of list) claimed.add(codeKey(x.code));
    out.push({ category: c.title, remaining: c.remaining, courses: list.map(x => ({ code: x.code, title: x.title, credits: x.credits, ready: !x.blocked.length, needs: x.blocked.map(g => Array.isArray(g) ? g.join(' or ') : String(g)) })) });
  }
  return out;
}
/** Terms left at the student's pace: credits per completed term so far (at least the nominal pace when known). */
function projection(summary, termUnits, program) {
  const done = (termUnits || []).filter(u => num(u) > 0);
  const pace = done.length ? done.reduce((a, b) => a + num(b), 0) / done.length : 0;
  const nominalTerms = num(program && program.duration_years) * 2;
  const nominalPace = nominalTerms && summary.creditsRequired ? summary.creditsRequired / nominalTerms : 0;
  const usePace = pace || nominalPace;
  const termsLeft = summary.creditsRemaining <= 0 ? 0 : (usePace ? Math.ceil(summary.creditsRemaining / usePace) : null);
  return { pace: r1(pace), nominal_pace: r1(nominalPace), terms_done: done.length, terms_left: termsLeft, on_pace: !pace || !nominalPace ? null : pace + 1e-6 >= nominalPace * 0.9 };
}
/**
 * The full student-facing audit. o = { student, programs, rules (all), scores, catalogue, registered: [{code, credits}],
 * cgpa, entryYear, isPass, unmetFn, termUnits }
 */
function progress(o) {
  const x = o || {}; const st = x.student || {};
  const program = pickProgram(x.programs, st.department_id, x.entryYear);
  if (!program) return { hasProgram: false };
  const rules = (x.rules || []).filter(r => r && !Number(r.deleted) && r.program_id === program.id);
  const passed = passedFrom(x.scores, x.isPass);
  const now = audit(program, rules, passed);
  now.departmentId = st.department_id;
  const passedK = new Set(passed.map(c => codeKey(c.code)));
  const reg = (x.registered || []).filter(r => r && r.code && !passedK.has(codeKey(r.code)));
  const after = reg.length ? audit(program, rules, passed.concat(reg.map(r => ({ code: r.code, credits: num(r.credits) })))) : null;
  const taken = new Set([...passedK, ...reg.map(r => codeKey(r.code))]);
  const minCgpa = num(program.min_cgpa);
  const cgpa = x.cgpa == null ? null : num(x.cgpa, null);
  return {
    hasProgram: true, program: { name: program.name, award: program.award || '', catalog_year: program.catalog_year || '', duration_years: num(program.duration_years), min_cgpa: minCgpa },
    percent: now.percent, creditsEarned: now.creditsEarned, creditsRequired: now.creditsRequired, creditsRemaining: now.creditsRemaining, met: now.met, needs: now.needs,
    categories: now.categories.map(c => ({ title: c.title, min: c.min, earned: c.earned, remaining: c.remaining, met: c.met, courses: c.courses.map(k => k.code) })),
    afterThisTerm: after ? { percent: after.percent, creditsEarned: after.creditsEarned, registeredCredits: r1(reg.reduce((a, r) => a + num(r.credits), 0)), met: after.met } : null,
    suggestions: suggest(now, x.catalogue, taken, x.unmetFn),
    projection: projection(now, x.termUnits, program),
    cgpa, cgpaOk: !minCgpa || (cgpa != null && cgpa + 1e-9 >= minCgpa), eligible: now.met && (!minCgpa || (cgpa != null && cgpa + 1e-9 >= minCgpa)),
  };
}

module.exports = { codeKey, alphaPrefix, levelDigit, yearOf, ruleMatches, orderRules, allocate, summarise, pickProgram, passedFrom, audit, suggest, projection, progress };
