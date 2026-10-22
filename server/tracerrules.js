'use strict';
/**
 * 📊 GRADUATE TRACER STUDY — pure rules shared by the desktop (alumni office / quality assurance) and the
 * portal (graduates answer). A survey wave targets graduating sessions; each graduate answers once (and may
 * update the answer while the wave is open). The results give the employability figures accreditation
 * bodies ask for: employed / self-employed / in further study within a year, time to first job, sector,
 * how relevant the programme was, and the skills employers valued.
 */
const crypto = require('crypto');

const STATUS = { employed_full: 'Employed full-time', employed_part: 'Employed part-time', self_employed: 'Self-employed / business', further_study: 'In further study', nysc: 'National service (e.g. NYSC)', seeking: 'Unemployed — looking for work', not_seeking: 'Not looking for work' };
const MONTHS = { already: 'Had a job before graduating', lt3: 'Under 3 months', m3_6: '3–6 months', m6_12: '6–12 months', gt12: 'Over 12 months', never: 'Not yet' };
const SECTORS = { public: 'Public service / government', private: 'Private company', ngo: 'NGO / international organisation', academia: 'Education / research', self: 'Own business', other: 'Other' };
const SALARY = { b1: 'Lowest band', b2: 'Second band', b3: 'Middle band', b4: 'Fourth band', b5: 'Highest band', na: 'Prefer not to say' };
const SKILLS = ['technical', 'communication', 'problem_solving', 'teamwork', 'digital'];
const OUTCOME_OK = ['employed_full', 'employed_part', 'self_employed', 'further_study', 'nysc'];
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n || 300); // eslint-disable-line no-control-regex
const ids = (x) => { if (Array.isArray(x)) return x.map(String).filter(Boolean); try { const v = JSON.parse(x || '[]'); return Array.isArray(v) ? v.map(String).filter(Boolean) : []; } catch (_) { return String(x || '').split(',').map(v => v.trim()).filter(Boolean); } };

const responseId = (waveId, studentId) => 'trr_' + crypto.createHash('sha1').update(String(waveId) + '|' + String(studentId)).digest('hex').slice(0, 28);
function isOpen(w, today) { const d = String(today || new Date().toISOString()).slice(0, 10); return !!w && !Number(w.deleted) && w.status === 'open' && (!w.opens_on || d >= String(w.opens_on).slice(0, 10)) && (!w.closes_on || d <= String(w.closes_on).slice(0, 10)); }
/** A graduate is in a wave when their graduating session is one the wave targets (or the wave targets everyone). */
function inWave(w, graduationSession) { const want = ids(w && w.sessions); return !want.length || (!!graduationSession && want.includes(String(graduationSession))); }
const scale = (v) => { const n = parseInt(v, 10); return n >= 1 && n <= 5 ? n : null; };
function validateResponse(input) {
  const x = input || {};
  if (!STATUS[x.employment_status]) throw new Error('Tell us what you are doing now.');
  const working = ['employed_full', 'employed_part', 'self_employed', 'nysc'].includes(x.employment_status);
  if (working && !MONTHS[x.months_to_job]) throw new Error('How long after graduating did you start work?');
  if (working && !SECTORS[x.sector]) throw new Error('Which sector do you work in?');
  const relevance = scale(x.relevance); if (!relevance) throw new Error('Rate how relevant your programme was (1–5).');
  const satisfaction = scale(x.satisfaction); if (!satisfaction) throw new Error('Rate your overall satisfaction (1–5).');
  const skills = {}; for (const k of SKILLS) { const v = scale(x.skills && x.skills[k]); if (v) skills[k] = v; }
  return { employment_status: x.employment_status, months_to_job: working ? x.months_to_job : (x.employment_status === 'seeking' ? 'never' : null), sector: working ? x.sector : null,
    job_title: working ? (clean(x.job_title, 120) || null) : null, employer: working ? (clean(x.employer, 160) || null) : null, country: clean(x.country, 80) || null,
    salary_band: working && SALARY[x.salary_band] ? x.salary_band : null, relevance, satisfaction, skills: JSON.stringify(skills),
    recommend: x.recommend === true || x.recommend === 'yes' || x.recommend === 1 || x.recommend === '1' ? 1 : 0, comments: clean(x.comments, 2000) || null };
}
const pct = (n, d) => d ? Math.round(n * 1000 / d) / 10 : 0;
const avg = (arr) => { const v = arr.filter(n => n != null && !Number.isNaN(Number(n))).map(Number); return v.length ? Math.round(v.reduce((s, n) => s + n, 0) / v.length * 100) / 100 : null; };
/** responses (with department names) + the number of graduates surveyed → the figures, overall and per programme. */
function summarize(responses, eligible, groupKey) {
  const live = (responses || []).filter(r => !Number(r.deleted));
  const one = (list, n) => {
    const count = (f) => list.filter(f).length;
    const by = (key, dict) => Object.keys(dict).map(k => ({ key: k, label: dict[k], n: count(r => r[key] === k) })).filter(x => x.n);
    const skills = {}; for (const k of SKILLS) skills[k] = avg(list.map(r => { try { return (JSON.parse(r.skills || '{}') || {})[k]; } catch (_) { return null; } }));
    const working = list.filter(r => ['employed_full', 'employed_part', 'self_employed', 'nysc'].includes(r.employment_status));
    return { responses: list.length, eligible: n == null ? null : n, response_rate: n ? pct(list.length, n) : null,
      positive_rate: pct(count(r => OUTCOME_OK.includes(r.employment_status)), list.length),
      employed_rate: pct(working.length, list.length),
      within_6_months: pct(working.filter(r => ['already', 'lt3', 'm3_6'].includes(r.months_to_job)).length, working.length),
      seeking_rate: pct(count(r => r.employment_status === 'seeking'), list.length),
      status: by('employment_status', STATUS), months: by('months_to_job', MONTHS), sectors: by('sector', SECTORS),
      relevance: avg(list.map(r => r.relevance)), satisfaction: avg(list.map(r => r.satisfaction)), recommend_rate: pct(count(r => Number(r.recommend) === 1), list.length), skills };
  };
  const overall = one(live, eligible && eligible.total);
  const groups = new Map(); for (const r of live) { const k = r[groupKey || 'department'] || '—'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const by = [...groups.entries()].map(([k, list]) => Object.assign({ group: k }, one(list, eligible && eligible.by ? eligible.by[k] : null))).sort((a, b) => b.responses - a.responses);
  return { overall, by };
}

module.exports = { STATUS, MONTHS, SECTORS, SALARY, SKILLS, OUTCOME_OK, ids, clean, responseId, isOpen, inWave, validateResponse, summarize };
