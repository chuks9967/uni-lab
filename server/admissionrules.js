'use strict';
/**
 * 🎓 ADMISSION MERIT & ELIGIBILITY — pure rules shared by the desktop (registrar's screening), the portal
 * (an applicant asking "am I eligible?") and the server AI agent (which may offer admission ONLY inside the
 * policy computed here).
 *
 * Entry qualifications differ by country, so each programme's policy names a SCHEME:
 *   ng-utme    Nigeria — UTME score (/400) + O'level (WAEC/NECO/NABTEB) credits incl. English & Mathematics,
 *              optional Post-UTME; composite = UTME/8 (≤50) + best-five O'level points (≤30) + Post-UTME/5 (≤20).
 *   gh-wassce  Ghana — WASSCE aggregate of 3 core + 3 best electives (A1=1 … C6=6; lower is better), ≤ 24.
 *   ke-kcse    Kenya — KCSE mean grade (A=12 … E=1), usually C+ (7) for degrees.
 *   uk-ucas    United Kingdom — UCAS tariff points (A-level A*=56 … E=16).
 *   fr-bac     France and francophone Africa (Bénin, Sénégal, Côte d'Ivoire, Cameroun …) — Baccalauréat average /20, ≥ 10.
 *   us-gpa     United States / Canada — high-school GPA /4.0 (+ optional SAT, test-optional).
 *   in-12th    India — Class XII aggregate percentage.
 *   generic    any other system — one entry score /100.
 * Every scheme yields a native value (what a registrar would quote) AND a comparable 0–100 composite used
 * for ranking. Requirements that fail are listed in plain words; nothing is decided silently.
 */

const OLEVEL_POINTS = { A1: 6, B2: 5, B3: 4, C4: 3, C5: 2, C6: 1 };             // Nigeria (credit = C6 or better)
const WASSCE_POINTS = { A1: 1, B2: 2, B3: 3, C4: 4, C5: 5, C6: 6, D7: 7, E8: 8, F9: 9 }; // Ghana aggregate
const KCSE = { 'A': 12, 'A-': 11, 'B+': 10, 'B': 9, 'B-': 8, 'C+': 7, 'C': 6, 'C-': 5, 'D+': 4, 'D': 3, 'D-': 2, 'E': 1 };
const UCAS = { 'A*': 56, 'A': 48, 'B': 40, 'C': 32, 'D': 24, 'E': 16 };

const SCHEMES = {
  'ng-utme': { name: 'UTME + O’level (Nigeria)', native: 'UTME', cutoff: 180, better: 'higher', requiredSubjects: ['English', 'Mathematics'], minCredits: 5 },
  'gh-wassce': { name: 'WASSCE aggregate (Ghana)', native: 'Aggregate', cutoff: 24, better: 'lower', requiredSubjects: ['English', 'Mathematics', 'Integrated Science'], minCredits: 6 },
  'ke-kcse': { name: 'KCSE mean grade (Kenya)', native: 'Mean grade points', cutoff: 7, better: 'higher', requiredSubjects: [], minCredits: 0 },
  'uk-ucas': { name: 'UCAS tariff (United Kingdom)', native: 'UCAS points', cutoff: 112, better: 'higher', requiredSubjects: [], minCredits: 0 },
  'fr-bac': { name: 'Baccalauréat (France & francophone Africa)', native: 'Moyenne /20', cutoff: 10, better: 'higher', requiredSubjects: [], minCredits: 0 },
  'us-gpa': { name: 'High-school GPA (US / Canada)', native: 'GPA /4.0', cutoff: 2.5, better: 'higher', requiredSubjects: [], minCredits: 0 },
  'in-12th': { name: 'Class XII percentage (India)', native: 'Percentage', cutoff: 50, better: 'higher', requiredSubjects: [], minCredits: 0 },
  'generic': { name: 'Entry score /100', native: 'Entry score', cutoff: 50, better: 'higher', requiredSubjects: [], minCredits: 0 },
};
const COUNTRY_SCHEME = { NG: 'ng-utme', GH: 'gh-wassce', SL: 'gh-wassce', LR: 'gh-wassce', GM: 'gh-wassce', KE: 'ke-kcse', GB: 'uk-ucas', IE: 'uk-ucas',
  FR: 'fr-bac', BJ: 'fr-bac', SN: 'fr-bac', CI: 'fr-bac', CM: 'fr-bac', TG: 'fr-bac', BF: 'fr-bac', ML: 'fr-bac', NE: 'fr-bac', GA: 'fr-bac', CG: 'fr-bac', CD: 'fr-bac', MA: 'fr-bac', TN: 'fr-bac', DZ: 'fr-bac', MG: 'fr-bac',
  US: 'us-gpa', CA: 'us-gpa', IN: 'in-12th' };

/** Subject names as written by applicants → one canonical form ("Maths", "General Mathematics" → mathematics). */
// ORDER MATTERS — the specific names first ("Literature in English" is not English; "Further Mathematics" is not Mathematics)
const ALIASES = [
  [/literature/i, 'literature in english'], [/further math/i, 'further mathematics'], [/elective math/i, 'elective mathematics'],
  [/\b(use of )?english( language)?\b|\beng\.?\b|anglais/i, 'english'],
  [/\b(general |core )?math(ematic)?s?\b|mathématiques|maths/i, 'mathematics'],
  [/integrated science|\bint\.? sci/i, 'integrated science'],
  [/\bphysics\b|physique/i, 'physics'], [/\bchemistry\b|chimie/i, 'chemistry'], [/\bbiology\b|biologie|\bbio\b/i, 'biology'],
  [/economics|économie/i, 'economics'], [/geography|géographie/i, 'geography'], [/government|civic/i, 'government'],
  [/agric/i, 'agricultural science'], [/commerce/i, 'commerce'], [/account/i, 'accounting'],
  [/computer|ict|informatique/i, 'computer studies'], [/social studies/i, 'social studies'], [/french|français/i, 'french'],
];
function canonSubject(s) { const t = String(s || '').trim(); for (const [re, c] of ALIASES) if (re.test(t)) return c; return t.toLowerCase(); }
const J = (v, d) => { if (v && typeof v === 'object') return v; try { const x = JSON.parse(v || ''); return x == null ? d : x; } catch (_) { return d; } };
const round = (n, d) => Math.round(n * Math.pow(10, d || 1)) / Math.pow(10, d || 1);

/** Best grade per subject across all sittings (combined results are common and allowed). */
function bestGrades(olevel) {
  const sittings = Array.isArray(olevel) ? olevel : J(olevel, []);
  const best = {};
  for (const s of (Array.isArray(sittings) ? sittings : [])) for (const x of (s && s.subjects) || []) {
    const sub = canonSubject(x.subject); const g = String(x.grade || '').toUpperCase().replace(/\s+/g, '');
    if (!sub || !(g in WASSCE_POINTS)) continue;
    if (best[sub] == null || WASSCE_POINTS[g] < WASSCE_POINTS[best[sub]]) best[sub] = g;
  }
  return best;
}

/** The policy for one programme (programme override → institution default → country preset). */
function policyFor(all, departmentId, country) {
  const cfg = J(all, {}) || {};
  const base = cfg.default || {};
  const prog = (cfg.programmes || {})[departmentId] || {};
  const scheme = prog.scheme || base.scheme || COUNTRY_SCHEME[String(country || '').toUpperCase()] || 'generic';
  const S = SCHEMES[scheme] || SCHEMES.generic;
  const pick = (k, d) => (prog[k] != null && prog[k] !== '' ? prog[k] : (base[k] != null && base[k] !== '' && (base.scheme || scheme) === scheme ? base[k] : d));
  return {
    scheme, schemeName: S.name, native: S.native, better: S.better,
    cutoff: Number(pick('cutoff', S.cutoff)), minScore: Number(pick('minScore', 0)) || 0,
    requiredSubjects: (pick('requiredSubjects', S.requiredSubjects) || []).map(canonSubject), minCredits: Number(pick('minCredits', S.minCredits)) || 0,
    capacity: Number(prog.capacity) > 0 ? Number(prog.capacity) : null, autoOffer: !!(prog.autoOffer != null ? prog.autoOffer : base.autoOffer),
    autoOfferAbove: Number(pick('autoOfferAbove', 0)) || 0, waitlist: pick('waitlist', true) !== false,
  };
}

/**
 * Evaluate ONE application against a policy. app = admission_applications row (jamb_score, olevel, qualifications JSON…).
 * → { scheme, native:{label,value}, score (0–100 | null), eligible, passed:[…], failed:[…], missing:[…], recommendation: 'offer'|'reject'|'review' }
 */
function evaluate(app, policy) {
  const p = policy || policyFor(null, null, null); const q = J(app && app.qualifications, {}) || {};
  const passed = []; const failed = []; const missing = [];
  let native = null; let score = null;
  const need = (ok, good, bad) => { if (ok) passed.push(good); else failed.push(bad); };
  const creditsCheck = (best, table, isCredit) => {
    const credits = Object.keys(best).filter(s => isCredit(best[s]));
    for (const r of p.requiredSubjects) need(credits.includes(r), `${cap(r)}: ${best[r]}`, best[r] ? `${cap(r)} is ${best[r]} — a credit is required` : `${cap(r)} is missing from the results`);
    if (p.minCredits) need(credits.length >= p.minCredits, `${credits.length} credit(s)`, `${credits.length} credit(s) — at least ${p.minCredits} required`);
    return credits;
  };
  switch (p.scheme) {
    case 'ng-utme': {
      const utme = Number(app && app.jamb_score); const best = bestGrades(app && app.olevel);
      if (!(utme > 0)) missing.push('UTME score');
      if (!Object.keys(best).length) missing.push('O’level results');
      if (utme > 0) { native = { label: 'UTME', value: utme }; need(utme >= p.cutoff, `UTME ${utme} ≥ cut-off ${p.cutoff}`, `UTME ${utme} is below the cut-off ${p.cutoff}`); }
      const credits = creditsCheck(best, OLEVEL_POINTS, g => g in OLEVEL_POINTS);
      const top5 = credits.map(s => OLEVEL_POINTS[best[s]]).sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
      const post = Number(q.post_utme);
      // UTME/8 (≤50) + best-five O'level points (≤30) + Post-UTME/5 (≤20); with no Post-UTME its share follows the O'level
      if (utme > 0) score = Math.min(50, utme / 8) + top5 + (post > 0 ? Math.min(20, post / 5) : (top5 / 30) * 20);
      break;
    }
    case 'gh-wassce': {
      const best = bestGrades(app && app.olevel);
      if (!Object.keys(best).length) { missing.push('WASSCE results'); break; }
      const pass = g => WASSCE_POINTS[g] <= 6;
      creditsCheck(best, WASSCE_POINTS, pass);
      const core = ['english', 'mathematics', Object.keys(best).includes('integrated science') ? 'integrated science' : 'social studies'].filter(s => best[s]);
      const electives = Object.keys(best).filter(s => !core.includes(s) && pass(best[s])).map(s => WASSCE_POINTS[best[s]]).sort((a, b) => a - b).slice(0, 3);
      if (core.length < 3 || electives.length < 3) { missing.push('three core subjects and three electives'); break; }
      const agg = core.reduce((a, s) => a + WASSCE_POINTS[best[s]], 0) + electives.reduce((a, b) => a + b, 0);
      native = { label: 'Aggregate', value: agg };
      need(agg <= p.cutoff, `aggregate ${agg} ≤ ${p.cutoff}`, `aggregate ${agg} is above the maximum ${p.cutoff}`);
      score = Math.max(0, Math.min(100, ((54 - agg) / 48) * 100));
      break;
    }
    case 'ke-kcse': {
      const g = String(q.kcse_mean || q.mean_grade || '').toUpperCase().replace(/\s+/g, '');
      if (!(g in KCSE)) { missing.push('KCSE mean grade'); break; }
      native = { label: 'Mean grade', value: g }; need(KCSE[g] >= p.cutoff, `mean grade ${g}`, `mean grade ${g} is below the minimum (${Object.keys(KCSE).find(k => KCSE[k] === Math.round(p.cutoff)) || p.cutoff})`);
      score = KCSE[g] / 12 * 100; break;
    }
    case 'uk-ucas': {
      let pts = Number(q.ucas_points);
      if (!(pts > 0) && Array.isArray(q.a_levels)) pts = q.a_levels.map(x => UCAS[String(x.grade || x).toUpperCase()] || 0).reduce((a, b) => a + b, 0);
      if (!(pts > 0)) { missing.push('UCAS tariff points or A-level grades'); break; }
      native = { label: 'UCAS points', value: pts }; need(pts >= p.cutoff, `${pts} UCAS points`, `${pts} UCAS points — ${p.cutoff} required`);
      score = Math.min(100, pts / 168 * 100); break;
    }
    case 'fr-bac': {
      const m = Number(String(q.bac_average != null ? q.bac_average : q.moyenne != null ? q.moyenne : '').replace(',', '.'));
      if (!(m > 0)) { missing.push('Baccalauréat average (/20)'); break; }
      native = { label: 'Moyenne', value: m }; need(m >= p.cutoff, `moyenne ${m}/20`, `moyenne ${m}/20 — ${p.cutoff}/20 required`);
      score = Math.min(100, m * 5); break;
    }
    case 'us-gpa': {
      const g = Number(q.gpa);
      if (!(g > 0)) { missing.push('high-school GPA'); break; }
      native = { label: 'GPA', value: g }; need(g >= p.cutoff, `GPA ${g}`, `GPA ${g} — ${p.cutoff} required`);
      const sat = Number(q.sat); score = Math.min(100, (g / 4) * (sat > 0 ? 70 : 100) + (sat > 0 ? Math.min(30, (sat - 400) / 1200 * 30) : 0)); break;
    }
    case 'in-12th': {
      const pc = Number(q.percentage || q.class12_percentage);
      if (!(pc > 0)) { missing.push('Class XII percentage'); break; }
      native = { label: 'Percentage', value: pc }; need(pc >= p.cutoff, `${pc}%`, `${pc}% — ${p.cutoff}% required`);
      score = Math.min(100, pc); break;
    }
    default: {
      const e = Number(q.entry_score != null ? q.entry_score : app && app.jamb_score);
      if (!(e >= 0) || (q.entry_score == null && !(Number(app && app.jamb_score) > 0))) { missing.push('entry score'); break; }
      native = { label: 'Entry score', value: e }; need(e >= p.cutoff, `entry score ${e}`, `entry score ${e} — ${p.cutoff} required`);
      score = Math.min(100, e);
    }
  }
  if (score != null) score = round(score, 1);
  if (score != null && p.minScore) need(score >= p.minScore, `composite ${score} ≥ ${p.minScore}`, `composite score ${score} is below the programme minimum ${p.minScore}`);
  const eligible = !missing.length && !failed.length && score != null;
  const recommendation = missing.length ? 'review' : failed.length ? 'reject' : 'offer';
  return { scheme: p.scheme, schemeName: p.schemeName, native, score, eligible, passed, failed, missing, recommendation };
}
const cap = (s) => String(s).replace(/\b\w/g, c => c.toUpperCase());

/**
 * Rank a cohort programme by programme and apply CAPACITY: the best eligible applicants up to the seats left
 * are recommended 'offer', the next eligible ones 'waitlist'. taken = {deptId: seats already offered/admitted}.
 * Ties break on the earlier submission. Returns the list with rank + final recommendation.
 */
function rank(apps, policyAll, country, taken) {
  const byDept = {};
  for (const a of apps || []) (byDept[a.department_id || '_'] = byDept[a.department_id || '_'] || []).push(a);
  const out = [];
  for (const [dept, list] of Object.entries(byDept)) {
    const pol = policyFor(policyAll, dept === '_' ? null : dept, country);
    const ev = list.map(a => ({ app: a, ev: evaluate(a, pol) }));
    const eligible = ev.filter(x => x.ev.eligible).sort((x, y) => (y.ev.score - x.ev.score) || String(x.app.submitted_at || x.app.created_at || '').localeCompare(String(y.app.submitted_at || y.app.created_at || '')));
    let seats = pol.capacity != null ? Math.max(0, pol.capacity - (Number((taken || {})[dept]) || 0)) : Infinity;
    eligible.forEach((x, i) => {
      x.rank = i + 1;
      if (seats > 0) { x.final = 'offer'; seats--; } else x.final = pol.waitlist ? 'waitlist' : 'reject';
      x.auto = x.final === 'offer' && pol.autoOffer && x.ev.score >= (pol.autoOfferAbove || 0);
    });
    // the evaluation first, THEN the capacity-adjusted recommendation (it must win over the per-applicant one)
    for (const x of ev) out.push(Object.assign({}, x.ev, { id: x.app.id, department_id: x.app.department_id, rank: x.rank || null, recommendation: x.final || x.ev.recommendation, autoOffer: !!x.auto, policy: { scheme: pol.scheme, cutoff: pol.cutoff, capacity: pol.capacity } }));
  }
  return out;
}

/** A plain-language explanation (applicant-safe: their own facts, no other applicants). */
function explain(ev) {
  if (!ev) return '';
  if (ev.missing.length) return `We need your ${ev.missing.join(' and ')} to assess your application.`;
  if (ev.failed.length) return `You do not yet meet: ${ev.failed.join('; ')}.`;
  return `You meet the entry requirements (${ev.native ? ev.native.label + ' ' + ev.native.value + ', ' : ''}composite ${ev.score}/100). Offers are made in merit order within the places available.`;
}

module.exports = { SCHEMES, COUNTRY_SCHEME, OLEVEL_POINTS, WASSCE_POINTS, KCSE, UCAS, canonSubject, bestGrades, policyFor, evaluate, rank, explain };
