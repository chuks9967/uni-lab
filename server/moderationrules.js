'use strict';
/**
 * 🔍 RESULT MODERATION — the checks an external moderator or a faculty board runs on a course's marks before they
 * are approved: the shape of the marks, not just their range. Pure (no database), shared by the desk's result
 * wizard and anything else that reports on a course's marks.
 *
 *   pass_bunching   marks crowd just at the pass mark while almost nobody sits just below it — the classic sign of
 *                   scripts "pushed" over the line (high when nobody at all is just below)
 *   round_marks     most totals are multiples of 5 — estimated rather than marked
 *   low_spread      nearly everyone within a few marks of each other
 *   high_fail       more than half the class failed
 *   inflation       half or more of the class on the top grade
 *   parts_missing   some rows have an exam mark but no continuous assessment (or the reverse)
 *   off_cohort      the course average is far from the cohort's average across its other courses
 *
 * Every flag carries a level (high · medium), a plain message and the numbers behind it. A high flag means the
 * approver records a moderation note; nothing here changes a mark.
 */
const r1 = (n) => Math.round(Number(n || 0) * 10) / 10;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);

/** Statistics + flags for one course. rows = [{ score, test_score?, exam_score?, grade? }]; opts = { passMark, topGrade, cohortMean, minN } */
function moderate(rows, opts = {}) {
  const pm = Number(opts.passMark) > 0 ? Number(opts.passMark) : 40;
  const minN = Number(opts.minN) > 0 ? Number(opts.minN) : 10;
  const list = (rows || []).map(r => ({ score: num(r.score), test: num(r.test_score), exam: num(r.exam_score), grade: r.grade ? String(r.grade).trim() : '' })).filter(r => r.score != null);
  const n = list.length;
  const scores = list.map(r => r.score).sort((a, b) => a - b);
  const mean = n ? scores.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)) : 0;
  const median = n ? (n % 2 ? scores[(n - 1) / 2] : (scores[n / 2 - 1] + scores[n / 2]) / 2) : 0;
  const passed = scores.filter(s => s >= pm).length;
  const grades = {}; for (const r of list) if (r.grade) grades[r.grade] = (grades[r.grade] || 0) + 1;
  const stats = { n, mean: r1(mean), sd: r1(sd), median: r1(median), min: n ? scores[0] : null, max: n ? scores[n - 1] : null, pass_rate: n ? r1(passed * 100 / n) : 0, pass_mark: pm, grades };
  const flags = [];
  const flag = (code, level, message, data) => flags.push({ code, level, message, data: data || {} });
  // parts missing — only meaningful when most rows carry both parts
  const both = list.filter(r => r.test != null && r.exam != null).length;
  const oneOnly = list.filter(r => (r.test == null) !== (r.exam == null));
  if (both >= Math.max(3, n / 2) && oneOnly.length) flag('parts_missing', 'medium', oneOnly.length + ' student(s) have only one part of the mark (test or exam) — check the continuous assessment.', { count: oneOnly.length });
  if (n >= minN) {
    const atPass = scores.filter(s => s >= pm && s < pm + 2).length;         // pm, pm+1
    const below = scores.filter(s => s >= pm - 4 && s < pm).length;         // pm-4 … pm-1
    if (atPass >= 3 && below === 0) flag('pass_bunching', 'high', atPass + ' student(s) scored ' + pm + '–' + (pm + 1) + ' but nobody scored ' + (pm - 4) + '–' + (pm - 1) + ' — check whether marks were raised to the pass mark.', { at_pass: atPass, just_below: below });
    else if (atPass >= 4 && atPass >= 4 * below) flag('pass_bunching', 'medium', atPass + ' student(s) sit at ' + pm + '–' + (pm + 1) + ' against ' + below + ' just below — an unusual pile-up at the pass mark.', { at_pass: atPass, just_below: below });
    const fives = scores.filter(s => Number.isInteger(s) && s % 5 === 0).length;
    if (fives / n >= 0.6) flag('round_marks', 'medium', Math.round(fives * 100 / n) + '% of the totals are multiples of 5 (about 20% is normal) — were scripts estimated rather than marked?', { share: r1(fives * 100 / n) });
    if (sd < 4) flag('low_spread', 'medium', 'Almost no spread in the marks (standard deviation ' + r1(sd) + ') — check for a copied column.', { sd: r1(sd) });
    const failRate = 100 - stats.pass_rate;
    if (failRate > 60) flag('high_fail', 'high', r1(failRate) + '% of the class failed — the board should review the paper and the marking.', { fail_rate: r1(failRate) });
    else if (failRate > 50) flag('high_fail', 'medium', r1(failRate) + '% of the class failed.', { fail_rate: r1(failRate) });
    const top = opts.topGrade ? (grades[opts.topGrade] || 0) : 0;
    if (opts.topGrade && top / n >= 0.5) flag('inflation', 'medium', Math.round(top * 100 / n) + '% of the class got ' + opts.topGrade + ' — check for grade inflation.', { share: r1(top * 100 / n) });
    if (Number.isFinite(Number(opts.cohortMean)) && opts.cohortMean !== null && Math.abs(mean - Number(opts.cohortMean)) >= 15) flag('off_cohort', 'medium', 'The course average (' + r1(mean) + ') is ' + r1(Math.abs(mean - Number(opts.cohortMean))) + ' marks ' + (mean > opts.cohortMean ? 'above' : 'below') + ' the same students’ average in their other courses (' + r1(opts.cohortMean) + ').', { cohort_mean: r1(opts.cohortMean) });
  }
  return { stats, flags, high: flags.filter(f => f.level === 'high').length, medium: flags.filter(f => f.level === 'medium').length };
}

/** Moderate every course in a list of rows grouped by course; cohort means are worked out per course from the same
 *  students' marks in the OTHER courses. rows = [{ course_code, student_id, score, test_score, exam_score, grade }] */
function moderateSet(rows, opts = {}) {
  const byCourse = new Map();
  for (const r of rows || []) { if (!r || !r.course_code) continue; const a = byCourse.get(r.course_code) || []; a.push(r); byCourse.set(r.course_code, a); }
  const out = [];
  for (const [code, list] of byCourse) {
    const ids = new Set(list.map(r => r.student_id).filter(Boolean));
    const others = (rows || []).filter(r => r.course_code !== code && ids.has(r.student_id) && num(r.score) != null);
    const cohortMean = others.length >= 5 ? others.reduce((a, r) => a + Number(r.score), 0) / others.length : null;
    out.push(Object.assign({ course_code: code }, moderate(list, Object.assign({}, opts, { cohortMean }))));
  }
  return out.sort((a, b) => (b.high - a.high) || (b.medium - a.medium) || String(a.course_code).localeCompare(String(b.course_code)));
}

module.exports = { moderate, moderateSet };
