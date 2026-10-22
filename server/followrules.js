'use strict';
/**
 * 📞 DEBT FOLLOW-UPS + 🎯 COLLECTION TARGETS — ONE set of rules shared by the desk (electron/services/acctfollow.js)
 * and the portal / app office mode (server/portal.js), so a promise logged on a dean's phone is judged exactly as the
 * Bursary's desk judges it.
 *
 *   follow-up: an officer contacted a student who owes (call · WhatsApp · SMS · e-mail · in person) and recorded the
 *   outcome. A PROMISE to pay is then checked against the payments that came in afterwards: kept (paid at least what
 *   was promised), pending (date not reached), broken (date passed, not paid).
 *   target: "collect P% of this session's billing by DATE" for the institution / a faculty / a department — met, on track
 *   (at or above the straight-line pace from the session start to the date), or behind.
 *
 * Pure: hand it the rows, it hands back states and summaries.
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const CHANNELS = { call: 'Phone call', whatsapp: 'WhatsApp', sms: 'SMS', email: 'E-mail', visit: 'In person' };
const OUTCOMES = { promised: 'Promised to pay', call_back: 'Asked to call back', no_answer: 'No answer', paid: 'Says already paid', refused: 'Refused / disputes the fee', wrong_number: 'Wrong number', other: 'Other' };
const TOL = 0.5;
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const dayOf = (x) => String(x || '').slice(0, 10);

/** Check a follow-up being logged → the clean row fields, or throws with a plain message. */
function validate(b = {}, today) {
  const channel = CHANNELS[b.channel] ? b.channel : null; if (!channel) throw new Error('How did you contact them?');
  const outcome = OUTCOMES[b.outcome] ? b.outcome : null; if (!outcome) throw new Error('What happened?');
  const note = String(b.note || '').trim().slice(0, 1000);
  const out = { channel, outcome, note: note || null, promised_amount: null, currency: null, promised_date: null };
  if (outcome === 'promised') {
    const amt = r2(b.promised_amount); if (!(amt > 0)) throw new Error('How much did they promise to pay?');
    if (!isDay(b.promised_date)) throw new Error('By what date did they promise to pay?');
    const t = today || new Date().toISOString().slice(0, 10);
    if (b.promised_date < t) throw new Error('The promised date cannot be in the past.');
    if (!/^[A-Z]{3}$/.test(String(b.currency || ''))) throw new Error('Choose the currency.');
    Object.assign(out, { promised_amount: amt, currency: b.currency, promised_date: b.promised_date });
  }
  if (outcome === 'other' && !note) throw new Error('Say what happened.');
  return out;
}

/** A promise's state: { state: kept|pending|broken|none, paid, days_left } from the student's completed payments. */
function promiseState(f, payments, today) {
  if (!f || f.outcome !== 'promised') return { state: 'none', paid: 0 };
  const t = today || new Date().toISOString().slice(0, 10); const from = String(f.created_at || '');
  let paid = 0;
  for (const p of payments || []) {
    if (!p || Number(p.deleted) || p.status !== 'completed' || p.student_id !== f.student_id || p.currency !== f.currency) continue;
    // only money paid AFTER the contact counts (a payment earlier the same day was not the promise being kept)
    const at = String(p.decided_at || p.created_at || ''); if (at < from) continue;
    paid += Number(p.amount) || 0;   // refunds are negative and count against
  }
  paid = r2(paid);
  const days_left = Math.round((Date.parse(f.promised_date) - Date.parse(t)) / 86400000);
  if (paid >= Number(f.promised_amount) - TOL) return { state: 'kept', paid, days_left };
  return { state: f.promised_date < t ? 'broken' : 'pending', paid, days_left };
}

/**
 * The follow-up picture: every follow-up with its promise state, per-officer accountability, and what to do next.
 * rows: { followups, payments } · opts: { today, names: { officer id → name } }
 */
function summarize(rows = {}, opts = {}) {
  const t = opts.today || new Date().toISOString().slice(0, 10);
  const byStudent = new Map(); for (const p of rows.payments || []) { if (!p || !p.student_id) continue; (byStudent.get(p.student_id) || byStudent.set(p.student_id, []).get(p.student_id)).push(p); }
  const list = (rows.followups || []).filter(f => f && !Number(f.deleted)).map(f => Object.assign({}, f, promiseState(f, byStudent.get(f.student_id), t)));
  list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const per = new Map();
  for (const f of list) {
    const o = per.get(f.officer_id) || { officer_id: f.officer_id, name: (opts.names || {})[f.officer_id] || '', logged: 0, students: new Set(), promised: 0, kept: 0, broken: 0, pending: 0, last: null };
    o.logged++; o.students.add(f.student_id); if (!o.last || f.created_at > o.last) o.last = f.created_at;
    if (f.outcome === 'promised') { o.promised++; o[f.state]++; }
    per.set(f.officer_id, o);
  }
  const officers = [...per.values()].map(o => Object.assign(o, { students: o.students.size, kept_rate: (o.kept + o.broken) ? r2(o.kept / (o.kept + o.broken)) : null })).sort((a, b) => b.logged - a.logged);
  const promises = list.filter(f => f.outcome === 'promised');
  const count = (st) => promises.filter(f => f.state === st).length;
  return { followups: list, officers, promises: { total: promises.length, kept: count('kept'), pending: count('pending'), broken: count('broken'), due_7: promises.filter(f => f.state === 'pending' && f.days_left <= 7).length,
    kept_amount: r2(promises.filter(f => f.state === 'kept').reduce((a, f) => a + Number(f.promised_amount), 0)) } };
}

// ---- 🎯 targets --------------------------------------------------------------------------------------------------
/** Check a target being set. scope_type: institution | faculty | department. */
function validateTarget(b = {}) {
  const scope_type = ['institution', 'faculty', 'department'].includes(b.scope_type) ? b.scope_type : null; if (!scope_type) throw new Error('Set it for the institution, a faculty or a department.');
  if (scope_type !== 'institution' && !b.scope_id) throw new Error('Choose the ' + scope_type + '.');
  const pct = Number(b.target_pct); if (!(pct > 0 && pct <= 1)) throw new Error('The target is a percentage between 1 and 100.');
  if (!isDay(b.due_date)) throw new Error('By what date?');
  if (!/^[A-Z]{3}$/.test(String(b.currency || ''))) throw new Error('Choose the currency.');
  if (!b.session_id) throw new Error('Choose the session.');
  return { scope_type, scope_id: scope_type === 'institution' ? null : String(b.scope_id), target_pct: Math.round(pct * 1000) / 1000, due_date: b.due_date, currency: b.currency, session_id: String(b.session_id), note: String(b.note || '').trim().slice(0, 300) || null };
}
/** Progress: rate now (paid ÷ billed) against the target and the straight-line pace from the session start to the due date. */
function targetProgress(tg, money, sessionStart, today) {
  const t = today || new Date().toISOString().slice(0, 10); const m = money || {}; const billed = Number(m.billed) || 0, paid = Number(m.paid) || 0;
  const rate = billed > 0 ? r2(paid / billed) : null;
  const start = Date.parse(isDay(sessionStart) ? sessionStart : t), due = Date.parse(tg.due_date), now = Date.parse(t);
  const frac = due > start ? Math.max(0, Math.min(1, (now - start) / (due - start))) : 1;
  const expected = r2(Number(tg.target_pct) * frac);
  const state = rate == null ? 'no_billing' : rate >= Number(tg.target_pct) - 0.0005 ? 'met' : t > tg.due_date ? 'missed' : rate >= expected - 0.02 ? 'on_track' : 'behind';
  const gap = rate == null ? null : r2(Math.max(0, Number(tg.target_pct) * billed - paid));   // money still to collect to hit the target
  return { rate, expected, state, billed: r2(billed), paid: r2(paid), to_collect: gap, days_left: Math.round((due - now) / 86400000) };
}

module.exports = { validate, promiseState, summarize, validateTarget, targetProgress, CHANNELS, OUTCOMES, TOL };
