'use strict';
/**
 * 🔎 QUESTION REVIEW — ONE pure module (desk · portal · edge) for marking an online exam and putting a faulty question
 * right AFTER the candidates have sat it.
 *
 * 🐛 THE HOLES THIS FILLS
 *  1. A wrong key, a question with two right answers or an unclear question was found by item analysis and then… nothing.
 *     The only remedy was to edit the question by hand, and the attempts already marked kept the old marks.
 *  2. "Give each student N of the questions" marked every student out of the WHOLE bank (10 right of their 10 → 10/25).
 *
 * WHAT IT DOES
 *  • score()        — the ONE marking rule: the student's OWN paper (the questions they were served), accepted alternative
 *                     answers, and voided questions (full marks to everyone, or removed from the total).
 *  • itemReview()   — per question: % right, discrimination, how the strongest and weakest candidates answered, and flags:
 *                     key_suspect (the strongest candidates chose another answer more often than the key), negative,
 *                     too_hard, too_easy. For short and numeric answers it lists the commonest WRONG answers — where an
 *                     equivalent answer the key missed ("0.5" for "1/2") shows itself.
 *  • applyDecision() — keep · accept another answer · change the answer · void (full marks / remove), with the reason,
 *                     and a history of every key the question ever had.
 *  • reviewWindow() · validateChallenge() — a candidate may challenge a question on their own paper for a few days
 *                     after EVERY candidate has finished (never while the paper could still leak).
 *  • diff()         — whose score changed, from what to what.
 */
const REASONS = { wrong_key: 'The marked answer looks wrong', two_answers: 'More than one answer is right', unclear: 'The question is unclear', not_taught: 'It was not in the course content', typo: 'A mistake in the question' };
const ACTIONS = { keep: 'Keep the question as it is', accept: 'Also accept another answer', rekey: 'Change the answer', void_full: 'Void it — full marks to everyone', void_drop: 'Void it — remove it from the total' };
const FLAGS = { key_suspect: 'The strongest candidates chose another answer — check the key', negative: 'Weaker candidates did better than stronger ones', too_hard: 'Fewer than 1 in 5 got it right', too_easy: 'Almost everyone got it right' };
const DEFAULT_DAYS = 3; const MAX_DAYS = 14; const MAX_OPEN = 5;
const OBJECTIVE = new Set(['mcq', 'truefalse', 'short', 'math']);

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const blank = (v) => v == null || String(v).trim() === '';
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n || 500); // eslint-disable-line no-control-regex
const pj = (s, d) => { if (s && typeof s === 'object') return s; try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
const altsOf = (q) => { const a = pj(q && q.alt_answers, []); return Array.isArray(a) ? a.map(String).filter(Boolean) : []; };
const historyOf = (q) => { const a = pj(q && q.key_history, []); return Array.isArray(a) ? a : []; };
const optionsOf = (q) => q && q.type === 'truefalse' ? ['True', 'False'] : (Array.isArray(q && q.options) ? q.options : pj(q && q.options, [])).map(String);

/** A numeric answer within 0.1% (units stripped), or the same text — against any |-separated form. */
function mathMatch(expected, ans) {
  const a = String(ans == null ? '' : ans).trim(); if (!a) return false;
  for (const e of String(expected || '').split('|').map(x => x.trim()).filter(Boolean)) {
    const en = parseFloat(e.replace(/[^0-9.eE+-]/g, '')), an = parseFloat(a.replace(/[^0-9.eE+-]/g, ''));
    if (!isNaN(en) && !isNaN(an) && Math.abs(en - an) <= Math.max(1e-6, Math.abs(en) * 0.001)) return true;
    if (norm(e) && norm(e) === norm(a)) return true;
  }
  return false;
}

/** Is this answer right — against the key AND every answer accepted on review? (A voided question is handled by score().) */
function correct(q, ans) {
  if (!q || blank(ans)) return false;
  const alts = altsOf(q);
  if (q.type === 'mcq' || q.type === 'truefalse') return [q.answer].concat(alts).some(k => norm(k) !== '' && norm(k) === norm(ans));
  if (q.type === 'short') return String(q.answer || '').split('|').concat(alts).map(norm).filter(Boolean).includes(norm(ans));
  if (q.type === 'math') return [q.answer].concat(alts).some(k => mathMatch(k, ans));
  return false;
}

/** The questions on THIS candidate's paper. `served` = the ids the portal handed them (recorded at start). An attempt from
 *  before that was recorded, on an exam that gives each student `pick` of the bank: its own questions are the ones it
 *  answered; the rest of its `pick` are unknown and count at the bank's average marks (exact when all carry the same). */
function paperOf(questions, served, pick, answers) {
  const all = questions || [];
  const sv = Array.isArray(served) && served.length ? new Set(served.map(String)) : null;
  if (sv) return { qs: all.filter(q => sv.has(String(q.id))), topUp: 0, exact: true };
  const p = Number(pick) || 0;
  if (p > 0 && p < all.length) {
    const a = answers || {};
    const seen = all.filter(q => !blank(a[q.id])).slice(0, p);
    const live = all.filter(q => q.voided !== 'drop');
    const avg = live.length ? live.reduce((s, q) => s + (Number(q.marks) || 1), 0) / live.length : 1;
    return { qs: seen, topUp: (p - seen.length) * avg, exact: false };
  }
  return { qs: all, topUp: 0, exact: true };
}

/** THE marking rule. answers may carry __manual { qid: marks } for essays. → { score, max, needsManual, pendingManual } */
function score(questions, answers, served, pick) {
  const a = answers || {}; const manual = a.__manual || {};
  const pp = paperOf(questions, served, pick, a);
  let s = 0, max = pp.topUp, needsManual = false, pendingManual = false;
  for (const q of pp.qs) {
    if (q.voided === 'drop') continue;
    const m = Number(q.marks) || 1; max += m;
    if (q.voided === 'full') { s += m; continue; }                       // credit to every candidate who sat it
    if (OBJECTIVE.has(q.type)) { if (correct(q, a[q.id])) s += m; continue; }
    if (!blank(a[q.id])) { needsManual = true; if (manual[q.id] == null) pendingManual = true; }
    s += Math.min(m, Number(manual[q.id]) || 0);
  }
  return { score: r2(s), max: r2(max), needsManual, pendingManual, exact: pp.exact };
}

/** Per-question review. attempts: [{ answers (object), served (array|null), score, max_score }] — the marked ones. */
function itemReview(questions, attempts, pick) {
  const at = (attempts || []).map(x => ({ answers: pj(x.answers, {}), served: pj(x.served, null), frac: Number(x.max_score) ? Number(x.score || 0) / Number(x.max_score) : 0 }));
  return (questions || []).map(q => {
    // only the candidates who had this question on their paper (served list; else, on a pick-N exam, those who answered it)
    const onPaper = (x) => Array.isArray(x.served) && x.served.length ? x.served.map(String).includes(String(q.id)) : (!(Number(pick) > 0) || !blank(x.answers[q.id]));
    const takers = at.filter(onPaper).sort((x, y) => y.frac - x.frac);
    // the strongest and weakest 27% (the classic split); a small group (under 12) compares halves instead
    const n = takers.length; const k = Math.max(1, n >= 12 ? Math.ceil(n * 0.27) : Math.ceil(n / 2));
    const upper = takers.slice(0, k), lower = takers.slice(Math.max(0, n - k));
    const base = { id: q.id, seq: q.seq, type: q.type, text: String(q.text || '').slice(0, 160), marks: Number(q.marks) || 1, answer: q.answer || '', alts: altsOf(q), voided: q.voided || null,
      history: historyOf(q).length, n, p: null, disc: null, options: [], common: [], flags: [] };
    if (!OBJECTIVE.has(q.type) || !n) return base;
    const got = takers.map(x => correct(q, x.answers[q.id]) ? 1 : 0); const scr = takers.map(x => x.frac);
    const p = got.reduce((s, v) => s + v, 0) / n;
    let disc = 0;
    if (n > 1) { const mc = p, ms = scr.reduce((s, v) => s + v, 0) / n; let cov = 0, vc = 0, vs = 0; for (let i = 0; i < n; i++) { cov += (got[i] - mc) * (scr[i] - ms); vc += (got[i] - mc) ** 2; vs += (scr[i] - ms) ** 2; } disc = (vc && vs) ? cov / Math.sqrt(vc * vs) : 0; }
    const flags = [];
    const count = (grp, pred) => grp.filter(x => pred(x.answers[q.id])).length;
    if (q.type === 'mcq' || q.type === 'truefalse') {
      base.options = optionsOf(q).map(o => ({ option: o, key: correct(q, o), n: count(takers, v => norm(v) === norm(o)), upper: count(upper, v => norm(v) === norm(o)), lower: count(lower, v => norm(v) === norm(o)) }));
      const keyUpper = base.options.filter(o => o.key).reduce((s, o) => s + o.upper, 0);
      if (upper.length >= 3 && base.options.some(o => !o.key && o.upper > keyUpper)) flags.push('key_suspect');
    } else {
      const wrong = {}; for (const x of takers) { const v = x.answers[q.id]; if (blank(v) || correct(q, v)) continue; const key = String(v).trim().slice(0, 60); const nk = norm(key) || key; (wrong[nk] = wrong[nk] || { answer: key, n: 0, upper: 0 }).n++; if (upper.includes(x)) wrong[nk].upper++; }
      base.common = Object.values(wrong).sort((a, b) => b.n - a.n).slice(0, 3);
      const keyUpper = count(upper, v => correct(q, v));
      if (upper.length >= 3 && base.common.some(c => c.upper > keyUpper)) flags.push('key_suspect');
    }
    if (n >= 5 && disc < -0.05) flags.push('negative');
    if (n >= 5 && p < 0.2) flags.push('too_hard');
    if (n >= 5 && p > 0.95) flags.push('too_easy');
    return Object.assign(base, { p: Math.round(p * 100), disc: r2(disc), flags: q.voided ? [] : flags });
  });
}

/** keep · accept · rekey · void_full · void_drop → { ok, patch (columns to write), entry (the history line) } */
function applyDecision(q, d, now, who) {
  const x = d || {}; const fail = (error) => ({ ok: false, error });
  const action = ACTIONS[x.action] ? x.action : null; if (!action) return fail('Choose what to do with the question.');
  const note = clean(x.note, 500); if (note.length < 8) return fail('Say why in a sentence — the candidates who challenged it are told.');
  const patch = {};
  if (action === 'accept' || action === 'rekey') {
    if (!OBJECTIVE.has(q.type)) return fail('Only a question marked automatically has an answer key to change.');
    let ans = clean(x.answer, 300); if (!ans) return fail('Enter the answer.');
    if (q.type === 'mcq' || q.type === 'truefalse') { const hit = optionsOf(q).find(o => norm(o) === norm(ans)); if (!hit) return fail('Pick one of the question’s options.'); ans = hit; }
    const plain = Object.assign({}, q, { voided: null });
    if (action === 'accept') { if (correct(plain, ans)) return fail('That answer is already accepted.'); patch.alt_answers = JSON.stringify(altsOf(q).concat([ans])); }
    else { if (norm(ans) === norm(q.answer) && !altsOf(q).length) return fail('That is already the answer.'); patch.answer = ans; patch.alt_answers = null; }
    patch.voided = null;                                                  // a corrected key is marked again
  } else if (action === 'void_full') patch.voided = 'full';
  else if (action === 'void_drop') patch.voided = 'drop';
  const entry = { at: now || new Date().toISOString(), by: who || '', action, note, from: { answer: q.answer || '', alts: altsOf(q), voided: q.voided || null } };
  entry.to = { answer: patch.answer !== undefined ? patch.answer : (q.answer || ''), alts: patch.alt_answers !== undefined ? altsOf({ alt_answers: patch.alt_answers }) : altsOf(q), voided: patch.voided !== undefined ? patch.voided : (q.voided || null) };
  patch.key_history = JSON.stringify(historyOf(q).concat([entry]));
  return { ok: true, patch, entry, changes: action !== 'keep' };
}

/** When a candidate may see their paper again and challenge a question: from the moment the LAST candidate could still be
 *  answering (end + the longest extra time, nobody in progress) for `days` days. o: { now, days, inProgress, extraMin } */
function reviewWindow(exam, attempt, o) {
  const x = o || {}; const now = x.now != null ? Number(x.now) : Date.now();
  const days = Math.max(0, Math.min(MAX_DAYS, x.days == null ? DEFAULT_DAYS : Number(x.days) || 0));
  if (!days) return { open: false, why: 'Question challenges are switched off.' };
  if (!attempt || !['submitted', 'auto_submitted', 'graded'].includes(attempt.status)) return { open: false, why: 'Only a candidate who sat this exam can challenge a question.' };
  if (x.inProgress) return { open: false, why: 'Candidates are still sitting this exam — come back when it has closed.' };
  let base = null;
  if (exam && exam.end_at) base = Date.parse(exam.end_at) + (Number(x.extraMin) || 0) * 60000;
  else if (exam && exam.status === 'ended') base = Date.parse(exam.ended_at || exam.updated_at || attempt.submitted_at || '') || null;
  if (!base) return { open: false, why: 'Challenges open when the exam has closed.' };
  const closes = base + days * 864e5;
  if (now < base) return { open: false, opens_at: new Date(base).toISOString(), closes_at: new Date(closes).toISOString(), why: 'Challenges open when the exam has closed for everyone.' };
  if (now > closes) return { open: false, opens_at: new Date(base).toISOString(), closes_at: new Date(closes).toISOString(), closed: true, why: 'The time to challenge a question has passed.' };
  return { open: true, opens_at: new Date(base).toISOString(), closes_at: new Date(closes).toISOString() };
}

/** A candidate's challenge. ctx: { window, paper (question ids on their paper), mine (their challenges on this exam) } */
function validateChallenge(input, ctx) {
  const x = input || {}; const c = ctx || {}; const fail = (error) => ({ ok: false, error });
  if (!c.window || !c.window.open) return fail((c.window && c.window.why) || 'Challenges are not open for this exam.');
  const qid = String(x.question_id || '');
  if (!qid || !(c.paper || []).map(String).includes(qid)) return fail('That question was not on your paper.');
  const reason = REASONS[x.reason] ? x.reason : null; if (!reason) return fail('Choose what is wrong with the question.');
  const detail = clean(x.detail, 1000); if (detail.length < 15) return fail('Explain the problem in a sentence or two.');
  const suggested = clean(x.suggested, 300) || null;
  const mine = (c.mine || []).filter(m => m && !Number(m.deleted) && m.status !== 'withdrawn');
  const same = mine.find(m => String(m.question_id) === qid);
  if (same) return same.status === 'open' && clean(same.detail, 1000) === detail ? { ok: true, already: true, id: same.id } : fail('You have already challenged this question.');
  if (mine.filter(m => m.status === 'open').length >= MAX_OPEN) return fail('At most ' + MAX_OPEN + ' open challenges per exam.');
  return { ok: true, row: { question_id: qid, reason, detail, suggested } };
}

/** Whose score changed: before/after maps { attemptId: { score, max, student_id } } → [{ attempt_id, student_id, from, to, max_from, max_to }] */
function diff(before, after) {
  const out = [];
  for (const id of Object.keys(after || {})) {
    const b = (before || {})[id] || {}; const a = after[id];
    if (r2(b.score) !== r2(a.score) || r2(b.max) !== r2(a.max)) out.push({ attempt_id: id, student_id: a.student_id || b.student_id || null, from: r2(b.score), to: r2(a.score), max_from: r2(b.max), max_to: r2(a.max) });
  }
  return out;
}

/** How a question is named to a candidate (their numbering differs — the papers are shuffled). */
const label = (q) => { const t = String((q && q.text) || '').replace(/\s+/g, ' ').trim(); return '“' + (t.length > 70 ? t.slice(0, 70) + '…' : t) + '”'; };

module.exports = { REASONS, ACTIONS, FLAGS, DEFAULT_DAYS, MAX_DAYS, MAX_OPEN, OBJECTIVE, norm, mathMatch, correct, altsOf, historyOf, optionsOf, paperOf, score, itemReview, applyDecision, reviewWindow, validateChallenge, diff, label };
