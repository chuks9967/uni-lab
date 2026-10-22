'use strict';
/**
 * ⏰ FEE DEADLINES, LATE FEES AND MORE TIME TO PAY — the rules shared by the desk (electron/services/feeplan.js), the
 * portal and the edge bundle. Off until the Bursary sets a deadline.
 *
 *   rule        { id, title, category ('*' = every fee), session_id (null = any), due_date, grace_days,
 *                 late: { kind: 'flat' | 'percent', amount, cap }, min_owed }
 *   assess      where one student stands against one deadline: paid · upcoming · due soon (7 days) · in grace ·
 *               late (a late fee is due, once) · more time granted (an approved extension that has not run out)
 *   lateFee     flat, or a percentage of what is still owed, never above the cap
 *   validate    a request for more time: a date after the deadline, within the longest extension allowed, a reason
 */
const day = (d) => String(d || '').slice(0, 10);
const todayOf = (now) => new Date(now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now))).toISOString().slice(0, 10);
function addDays(ymd, n) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || '')); if (!m) return null; return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10); }
function daysBetween(a, b) { const x = Date.parse(day(a) + 'T00:00:00Z'), y = Date.parse(day(b) + 'T00:00:00Z'); return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : null; }
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n || 300);

/** The deadlines as configured (a JSON setting) — cleaned; inactive or malformed ones dropped. */
function rulesOf(raw) {
  let list = raw; if (typeof list === 'string') { try { list = JSON.parse(list || '[]'); } catch (_) { list = []; } }
  if (!Array.isArray(list)) list = (list && Array.isArray(list.rules)) ? list.rules : [];
  return list.map(r => {
    if (!r || r.active === false || r.active === 0) return null;
    const due = day(r.due_date); if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
    const kind = r.late && r.late.kind === 'percent' ? 'percent' : 'flat';
    const amount = Math.max(0, Number(r.late && r.late.amount) || 0);
    return { id: clean(r.id, 60) || ('dl-' + due + '-' + clean(r.category || 'all', 30)), title: clean(r.title, 120) || 'Fees', category: clean(r.category, 60) || '*', session_id: r.session_id || null,
      due_date: due, grace_days: Math.max(0, Math.min(90, parseInt(r.grace_days, 10) || 0)), late: { kind, amount: kind === 'percent' ? Math.min(100, amount) : r2(amount), cap: Math.max(0, Number(r.late && r.late.cap) || 0) },
      min_owed: Math.max(0, Number(r.min_owed) || 0), max_extension_days: Math.max(0, Math.min(365, parseInt(r.max_extension_days, 10) || 60)) };
  }).filter(Boolean);
}
/** Check a deadline the Bursary is saving. → { ok, errors } */
function checkRule(r) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day(r && r.due_date))) errors.push('Choose the deadline date.');
  if (!clean(r && r.title)) errors.push('Name the deadline (e.g. “First-semester tuition”).');
  const kind = r && r.late && r.late.kind; const amt = Number(r && r.late && r.late.amount);
  if (kind === 'percent' && (!(amt >= 0) || amt > 50)) errors.push('A percentage late fee is between 0 and 50%.');
  if (kind !== 'percent' && amt < 0) errors.push('A late fee cannot be negative.');
  return { ok: !errors.length, errors };
}
/** The late fee for what is still owed. */
function lateFee(rule, owed) {
  const o = Math.max(0, Number(owed) || 0); if (!rule || !o) return 0;
  let fee = rule.late.kind === 'percent' ? o * rule.late.amount / 100 : rule.late.amount;
  if (rule.late.cap > 0) fee = Math.min(fee, rule.late.cap);
  return r2(Math.max(0, fee));
}
/** Does a charge / payment belong to this deadline? (category and, when the rule names one, the session) */
function covers(rule, row) {
  if (!rule || !row) return false;
  if (rule.category !== '*' && String(row.category || '') !== rule.category) return false;
  if (rule.session_id && row.session_id && row.session_id !== rule.session_id) return false;
  return true;
}
/**
 * What a student owes against a deadline, per currency, from their charges and completed payments — never more than
 * their overall balance (`balances` = { cur: net owed }), so a scholarship or credit that covers the fee (it sits in
 * another category) means nothing is owed and no late fee is charged.
 */
function owedFor(rule, charges, payments, balances) {
  const billed = {}, paid = {};
  for (const c of charges || []) if (c && !Number(c.deleted) && covers(rule, c)) { const k = String(c.currency || 'NGN').toUpperCase(); billed[k] = (billed[k] || 0) + (Number(c.amount) || 0); }
  for (const p of payments || []) if (p && !Number(p.deleted) && p.status === 'completed' && covers(rule, p)) { const k = String(p.currency || 'NGN').toUpperCase(); paid[k] = (paid[k] || 0) + (Number(p.amount) || 0); }
  const out = {};
  for (const k of Object.keys(billed)) {
    let o = r2(billed[k] - (paid[k] || 0));
    // a currency missing from the balances is settled (the portal drops zero balances)
    if (balances) o = Math.min(o, r2(Number(balances[k]) || 0));
    if (o > 0.009) out[k] = o;
  }
  return out;
}
/**
 * Where one student stands against one deadline (one currency's amount owed).
 * → { state, due_date, grace_until, days_left | days_late, owed, late_fee (to charge now), deferred_until }
 */
function assess({ rule, owed, lateCharged, deferredUntil, now } = {}) {
  const today = todayOf(now); const o = Math.max(0, Number(owed) || 0);
  const graceUntil = addDays(rule.due_date, rule.grace_days);
  const base = { due_date: rule.due_date, grace_until: graceUntil, owed: r2(o), late_fee: 0, deferred_until: null, late_charged: !!lateCharged };
  if (o <= Math.max(0.009, rule.min_owed)) return Object.assign(base, { state: 'paid' });
  if (deferredUntil && day(deferredUntil) >= today) return Object.assign(base, { state: 'deferred', deferred_until: day(deferredUntil), days_left: daysBetween(today, deferredUntil) });
  const left = daysBetween(today, rule.due_date);
  if (left > 7) return Object.assign(base, { state: 'upcoming', days_left: left });
  if (left >= 0) return Object.assign(base, { state: 'due_soon', days_left: left });
  if (today <= graceUntil) return Object.assign(base, { state: 'grace', days_late: -left, days_left: daysBetween(today, graceUntil) });
  // past the grace period: the late fee is due once (an extension that has run out does not waive it)
  return Object.assign(base, { state: 'late', days_late: -left, late_fee: lateCharged ? 0 : lateFee(rule, o) });
}
/** A request for more time: a date after the deadline, within the longest extension the deadline allows, and a reason. */
function validateExtension({ rule, until, reason, now } = {}) {
  const u = day(until);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(u)) return { ok: false, error: 'Choose the date you can pay by.' };
  if (u <= todayOf(now)) return { ok: false, error: 'Choose a date after today.' };
  if (rule && u <= rule.due_date) return { ok: false, error: 'The deadline is ' + rule.due_date + ' — choose a later date, or simply pay by the deadline.' };
  if (rule && daysBetween(rule.due_date, u) > rule.max_extension_days) return { ok: false, error: 'At most ' + rule.max_extension_days + ' days after the deadline (by ' + addDays(rule.due_date, rule.max_extension_days) + ').' };
  const why = clean(reason, 1000);
  if (why.length < 15) return { ok: false, error: 'Say briefly why you need more time.' };
  return { ok: true, until: u, reason: why };
}
/** A stable id for "the late fee for this deadline, for this student, in this currency" — so it is never charged twice. */
const lateFeeId = (ruleId, studentId, currency) => 'latefee-' + String(ruleId).replace(/[^A-Za-z0-9_-]/g, '') + '-' + studentId + '-' + String(currency || 'NGN').toUpperCase();

module.exports = { rulesOf, checkRule, lateFee, covers, owedFor, assess, validateExtension, lateFeeId, addDays, daysBetween };
