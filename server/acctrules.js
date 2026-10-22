'use strict';
/**
 * ✍ MONTHLY SIGN-OFF RULES — ONE definition of what an officer confirms for a month, shared by the desk
 * (electron/services/acctreports.js, rows from SQL) and the portal / app office mode (server/portal.js, synced
 * rows), so a statement confirmed on the phone is fingerprinted from exactly the records the desk checks — and
 * a receipt voided, edited or back-dated into that month afterwards shows "changed since confirmed" on both.
 *
 * Pure: hand it the rows, it hands back the totals and the fingerprint. Voids are read off the payment itself
 * (voided_by / voided_at): the activity log stays on the desk and never travels to the cloud.
 */
const crypto = require('crypto');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isMonth = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''));
function monthRange(period) { const [y, m] = period.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return { from: period + '-01', to: period + '-' + String(last).padStart(2, '0') }; }
function prevMonth(period, n = 1) { const [y, m] = period.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - n, 1)); return d.toISOString().slice(0, 7); }
function thisMonth(nowMs) { return new Date(nowMs || Date.now()).toISOString().slice(0, 7); }
const dayOf = (p) => String((p && (p.decided_at || p.created_at)) || '').slice(0, 10);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const live = (r) => r && !Number(r.deleted);

/** The officer's records for the month: receipts they issued or raised, till sessions they ran, receipts they voided. */
function pick(userId, period, payments, tills) {
  const r = monthRange(period); const inR = (d) => d >= r.from && d <= r.to;
  const pays = [], voids = [];
  for (const p of payments || []) {
    if (!live(p)) continue;
    const mine = p.decided_by === userId || (p.raised_by === userId && p.decided_by !== userId);
    if (mine && inR(dayOf(p))) pays.push(p);
    if (p.voided_by === userId && inR(String(p.voided_at || '').slice(0, 10))) voids.push(p.id);
  }
  const ts = (tills || []).filter(t => live(t) && t.officer_id === userId && inR(String(t.day || '')));
  pays.sort(byId); ts.sort(byId); voids.sort();
  return { pays, tills: ts, voids };
}

/** Exactly what an officer confirms for a month — the totals per currency, and a fingerprint of every record behind them. */
function facts(userId, period, rows = {}) {
  const { pays, tills, voids } = pick(userId, period, rows.payments, rows.tills);
  const totals = {};
  const T = (c) => (totals[c] = totals[c] || { collected: 0, receipts: 0, refunds: 0, voided: 0, declared: 0, banked: 0 });
  for (const p of pays) {
    if (p.decided_by !== userId) continue;
    if (p.status === 'completed' && p.method === 'refund') T(p.currency).refunds = r2(T(p.currency).refunds - Number(p.amount));
    else if (p.status === 'completed' && Number(p.amount) > 0) { T(p.currency).collected = r2(T(p.currency).collected + Number(p.amount)); T(p.currency).receipts++; }
    else if (p.status === 'voided') T(p.currency).voided = r2(T(p.currency).voided + Number(p.amount));
  }
  for (const t of tills) { T(t.currency).declared = r2(T(t.currency).declared + (Number(t.declared) || 0)); T(t.currency).banked = r2(T(t.currency).banked + (Number(t.deposit_amount) || 0)); }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    p: pays.map(p => [p.id, r2(p.amount), p.status]),
    t: tills.map(t => [t.id, r2(t.declared), r2(t.deposit_amount), t.status]),
    v: voids,
  })).digest('hex');
  return { totals, fingerprint, records: pays.length + tills.length + voids.length, pays, tills, voids };
}

/** Did the officer handle any money that month (so there is something to confirm)? */
const handled = (f) => f.records > 0 || Object.values(f.totals).some(t => t.receipts || t.refunds || t.voided || t.declared);

/** Everyone with something to confirm for the month (issued/raised a receipt, voided one, ran a till). */
function officersIn(period, rows = {}) {
  const r = monthRange(period); const inR = (d) => d >= r.from && d <= r.to; const ids = new Set();
  for (const p of rows.payments || []) {
    if (!live(p)) continue;
    if (inR(dayOf(p))) { if (p.decided_by) ids.add(p.decided_by); if (p.raised_by && p.raised_by !== p.decided_by) ids.add(p.raised_by); }
    if (p.voided_by && inR(String(p.voided_at || '').slice(0, 10))) ids.add(p.voided_by);
  }
  for (const t of rows.tills || []) if (live(t) && t.officer_id && inR(String(t.day || ''))) ids.add(t.officer_id);
  return [...ids];
}

/** Check a confirm/dispute request: { status, note } or throws with a plain message. */
function checkAttest(period, data = {}, nowMs) {
  if (!isMonth(period)) throw new Error('Choose a month.');
  if (period >= thisMonth(nowMs)) throw new Error('A month can be confirmed once it is over.');
  const dispute = String((data && data.dispute) || '').trim().slice(0, 1000);
  if (!(data && data.confirm) && dispute.length < 5) throw new Error('Say what is wrong with the statement (it goes to the Bursary).');
  return { status: data.confirm ? 'attested' : 'disputed', note: data.confirm ? null : dispute };
}

const attId = (userId, period) => 'att:' + userId + ':' + period;
/** The state of one sign-off row against the officer's records now. */
function stateOf(att, f) {
  if (!att || Number(att.deleted)) return { state: 'waiting', changed: false };
  return { state: att.status, changed: att.fingerprint !== f.fingerprint };
}

module.exports = { facts, handled, officersIn, checkAttest, stateOf, attId, isMonth, monthRange, prevMonth, thisMonth, dayOf, r2 };
