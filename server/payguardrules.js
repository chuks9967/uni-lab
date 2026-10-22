'use strict';
/**
 * 🛡 PAYMENT INTEGRITY RULES — pure, deterministic fraud/loss checks for ONE payment (or one bank-transfer
 * claim). The caller (electron/services/payguard.js) gathers the facts; these rules only judge them, so they
 * are unit-testable and identical on every computer. AI only ever EXPLAINS a result and reads documents — it
 * never clears a payment on its own.
 *
 * Score: each reason carries a weight (0-100); weights combine like independent probabilities
 * (1 − Π(1 − w/100)), so two medium signals outrank one, and nothing exceeds 100. Levels:
 *   flagged ≥ 60 (or any CRITICAL reason) → a manual review is opened for the officer who issued the payment,
 *            and the student/parent is asked for supporting documents
 *   watch   ≥ 30 → listed for the finance office, no student contact
 *   ok      < 30
 */

const CRITICAL = new Set(['LEDGER_EDITED', 'LEDGER_UNSEALED', 'ONLINE_NOT_VERIFIED', 'DUP_REFERENCE', 'DUP_RECEIPT_NO', 'CLAIM_IMAGE_REUSED', 'CHARGEBACK_OPEN', 'CHARGEBACK_LOST', 'ONLINE_NOT_AT_PROVIDER']);

const CHECKS = {
  // ⚠ the card holder's bank disputed the payment (confirmed with the gateway, or reported at the desk)
  CHARGEBACK_LOST: { weight: 100, title: 'Chargeback lost — the money went back to the card holder; reverse this receipt', docs: [] },
  CHARGEBACK_OPEN: { weight: 90, title: "The card holder's bank disputed this payment (chargeback) — answer the bank", docs: ['gateway', 'id'] },
  LEDGER_EDITED: { weight: 100, title: 'Money record edited outside the software', docs: ['original'] },
  LEDGER_UNSEALED: { weight: 95, title: 'Payment inserted directly into the database (never recorded by the software)', docs: ['original'] },
  ONLINE_NOT_VERIFIED: { weight: 85, title: 'Online payment with no verified gateway checkout', docs: ['gateway'] },
  ONLINE_AMOUNT_OVER: { weight: 70, title: 'Online amount higher than the checkout that was started', docs: ['gateway'] },
  // 🔁 the daily gateway cross-check (the provider's own list of successful payments)
  ONLINE_NOT_AT_PROVIDER: { weight: 90, title: 'The payment gateway has no record of this online payment', docs: ['gateway'] },
  ONLINE_PROVIDER_AMOUNT: { weight: 70, title: 'The payment gateway received a different amount than this receipt', docs: ['gateway'] },
  DUP_REFERENCE: { weight: 75, title: 'Transaction reference already used by another payment', docs: ['gateway', 'bank'] },
  DUP_RECEIPT_NO: { weight: 75, title: 'Receipt number used twice', docs: ['original'] },
  CLAIM_IMAGE_REUSED: { weight: 80, title: 'The same receipt image was submitted for another claim', docs: ['bank', 'statement'] },
  CLAIM_REF_REUSED: { weight: 65, title: 'The bank reference was already claimed by another transfer', docs: ['bank', 'statement'] },
  BANK_NO_EVIDENCE: { weight: 45, title: 'Recorded as a bank transfer with no bank alert or uploaded proof', docs: ['bank', 'statement'] },
  OCR_CONTRADICTS: { weight: 40, title: "The AI's reading of the uploaded receipt does not match the claim", docs: ['bank', 'statement'] },
  DUP_PAYMENT: { weight: 45, title: 'Same student, fee and amount collected twice within minutes', docs: ['original'] },
  STRUCTURING: { weight: 40, title: 'Several cash payments in one day just under the cash limit', docs: ['cash'] },
  INACTIVE_STUDENT: { weight: 40, title: 'Payment for a student who is not active', docs: [] },
  OVERPAID: { weight: 35, title: 'Payment exceeds what was billed for this fee', docs: [] },
  CURRENCY_MISMATCH: { weight: 35, title: "Currency differs from the fee's billing currency", docs: [] },
  LARGE_CASH: { weight: 30, title: 'Large cash payment (above the cash limit)', docs: ['cash'] },
  BACKDATED: { weight: 30, title: 'Payment date set earlier than when it was recorded', docs: ['original'] },
  NO_CHARGE: { weight: 25, title: 'Payment for a fee that was never billed to this student', docs: [] },
  VELOCITY: { weight: 25, title: 'Unusually many payments for this student in one hour', docs: [] },
  AMOUNT_OUTLIER: { weight: 25, title: 'Amount far above what this fee normally costs', docs: [] },
  OFF_HOURS: { weight: 20, title: 'Desk payment recorded outside office hours', docs: ['cash'] },
  OFFICER_VOIDS: { weight: 20, title: 'The collecting officer voided several payments recently', docs: [] },
  PAYER_UNRELATED: { weight: 15, title: 'Payer name does not match the student or their parent', docs: ['id'] },
  // 🧾 what the AI read off an uploaded bank receipt (2026-10) — each is a reason to look, never proof on its own
  RECEIPT_WRONG_ACCOUNT: { weight: 70, title: "The receipt shows the money going to an account that is not the university's", docs: ['bank', 'statement'] },
  RECEIPT_NOT_SUCCESSFUL: { weight: 70, title: 'The receipt itself says the transfer failed or was reversed', docs: ['statement'] },
  RECEIPT_PENDING: { weight: 20, title: 'The receipt says the transfer was still pending', docs: [] },
  RECEIPT_FUTURE_DATE: { weight: 60, title: 'The receipt is dated in the future', docs: ['bank', 'statement'] },
  RECEIPT_AMOUNT_DIFFERS: { weight: 45, title: 'The amount on the receipt differs from the amount claimed', docs: ['bank', 'statement'] },
  RECEIPT_EDIT_SIGNS: { weight: 40, title: 'The AI saw signs that the receipt image was edited', docs: ['statement'] },
  RECEIPT_CURRENCY_DIFFERS: { weight: 30, title: 'The currency on the receipt differs from the claim', docs: ['bank'] },
  RECEIPT_OLD: { weight: 30, title: 'The receipt is much older than the claim', docs: ['statement'] },
  CLAIM_VELOCITY: { weight: 25, title: 'Many transfer claims from this student in one day', docs: ['statement'] },
};

/** What we ask the student/parent to upload, by evidence type. */
const DOCS = {
  gateway: 'The payment confirmation from the gateway (e-mail / SMS / screenshot showing the transaction reference)',
  bank: 'The bank transfer receipt or teller showing the amount, date and reference',
  statement: 'A bank statement page (or mobile banking history) showing the debit',
  cash: 'The cash receipt/teller you were given at the payment desk',
  original: 'Any receipt or proof you received when you paid',
  id: "Proof that the payer is the student's parent/guardian or sponsor (e.g. ID or letter)",
};

const DEFAULTS = { cashLimit: 500000, officeStart: 7, officeEnd: 19, weekendIsOff: true, dupWindowMin: 30, velocityPerHour: 5, outlierFactor: 3, voidsPerWeek: 3, tolerance: 0.01 };

const num = (x) => Math.round((Number(x) || 0) * 100) / 100;
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const words = (s) => String(s || '').toUpperCase().split(/[^A-Z]+/).filter(w => w.length >= 3);

/** Combine reason weights into a 0-100 score (probabilistic OR). */
function combine(reasons) {
  let keep = 1; for (const r of reasons) keep *= (1 - Math.max(0, Math.min(100, r.weight)) / 100);
  return Math.round((1 - keep) * 100);
}
function levelOf(score, reasons) {
  if ((reasons || []).some(r => CRITICAL.has(r.code))) return 'flagged';
  return score >= 60 ? 'flagged' : score >= 30 ? 'watch' : 'ok';
}
function reason(code, detail) { const c = CHECKS[code]; return { code, weight: c.weight, title: c.title, detail: detail || '' }; }

/**
 * Evaluate a COMPLETED payment.
 * p   = the payment row
 * ctx = {
 *   student: { status }, others: [other completed payments of this student (not p)],
 *   refTwins: [payments (≠ p) sharing p's transaction reference], receiptTwins: [payments (≠ p) with p's receipt_no],
 *   charges: [this student's charges for p.category], intent: the gateway checkout (online) | null,
 *   claim: the bank-transfer claim linked to p | null, ledger: 'ok'|'edited'|'unsealed',
 *   categoryAmounts: [charge amounts of this fee across students, same currency], officerVoids: n (7 days),
 *   settings: {…DEFAULTS}
 * }
 */
function evaluate(p, ctx = {}) {
  const S = Object.assign({}, DEFAULTS, ctx.settings || {});
  const out = [];
  const amt = num(p.amount); const cur = String(p.currency || '').toUpperCase();
  const channel = String(p.channel || '').toLowerCase(); const method = String(p.method || '').toLowerCase();
  const desk = method !== 'online';
  // 1) the ledger itself
  if (ctx.ledger === 'edited') out.push(reason('LEDGER_EDITED', 'Its sealed amount/status no longer matches — it was changed in the database file.'));
  if (ctx.ledger === 'unsealed') out.push(reason('LEDGER_UNSEALED', 'No seal: it never passed through the software (or sync).'));
  // 1b) chargebacks
  const dsp = String(p.dispute_status || '');
  const dspWhy = [p.dispute_reason, p.dispute_ref ? 'case ' + p.dispute_ref : '', p.dispute_amount ? num(p.dispute_amount) + ' ' + cur : ''].filter(Boolean).join(' · ');
  if (dsp === 'lost') out.push(reason('CHARGEBACK_LOST', dspWhy));
  else if (dsp === 'open') out.push(reason('CHARGEBACK_OPEN', dspWhy + (p.dispute_due_at ? ' · answer by ' + String(p.dispute_due_at).slice(0, 10) : '')));
  // 2) online payments must trace back to a verified checkout
  if (method === 'online') {
    const it = ctx.intent;
    if (!it || (it.status !== 'paid' && it.payment_id !== p.id)) out.push(reason('ONLINE_NOT_VERIFIED', it ? 'The checkout was never confirmed as paid.' : 'No checkout was ever started for this reference.'));
    else if (amt > num(it.amount) + 1) out.push(reason('ONLINE_AMOUNT_OVER', `Checkout was for ${num(it.amount)} ${it.currency || cur}; ${amt} was recorded.`));
    if (p.provider_status === 'missing') out.push(reason('ONLINE_NOT_AT_PROVIDER', p.provider_note || ''));
    else if (p.provider_status === 'amount_differs') out.push(reason('ONLINE_PROVIDER_AMOUNT', p.provider_note || ''));
  }
  // 3) duplicates
  if ((ctx.refTwins || []).length) out.push(reason('DUP_REFERENCE', 'Also on receipt(s) ' + ctx.refTwins.map(x => x.receipt_no || x.id).slice(0, 3).join(', ') + '.'));
  if ((ctx.receiptTwins || []).length) out.push(reason('DUP_RECEIPT_NO', `Receipt ${p.receipt_no} appears ${ctx.receiptTwins.length + 1} times.`));
  const t0 = new Date(p.decided_at || p.created_at || 0).getTime();
  const others = (ctx.others || []).filter(o => o.id !== p.id);
  const twin = desk && others.find(o => o.method !== 'online' && o.category === p.category && num(o.amount) === amt && String(o.currency || '').toUpperCase() === cur && Math.abs(new Date(o.decided_at || o.created_at || 0).getTime() - t0) <= S.dupWindowMin * 60000);
  if (twin) out.push(reason('DUP_PAYMENT', `Receipt ${twin.receipt_no || twin.id} took the same ${amt} ${cur} minutes apart.`));
  // 4) bank transfers need evidence
  if (channel === 'bank_transfer' || channel === 'transfer') {
    const c = ctx.claim;
    if (!c && !ctx.bankAlert) out.push(reason('BANK_NO_EVIDENCE', 'Entered at a desk as a transfer, without a matched bank alert or an uploaded receipt.'));
    if (c && c.ocr_match === 'none') out.push(reason('OCR_CONTRADICTS', 'Amount/reference/payer on the uploaded receipt do not match.'));
  }
  // 5) cash controls
  const isCash = desk && (channel === 'cash' || channel === 'direct' || !channel);
  if (isCash && amt > S.cashLimit) out.push(reason('LARGE_CASH', `${amt} ${cur} in cash (limit ${S.cashLimit}).`));
  if (isCash) {
    const day = new Date(t0).toISOString().slice(0, 10);
    const sameDay = others.filter(o => o.method !== 'online' && ['cash', 'direct', ''].includes(String(o.channel || '').toLowerCase()) && String(o.currency || '').toUpperCase() === cur && new Date(o.decided_at || o.created_at || 0).toISOString().slice(0, 10) === day);
    const total = sameDay.reduce((a, o) => a + num(o.amount), amt);
    if (sameDay.length >= 2 && amt < S.cashLimit && total > S.cashLimit && sameDay.every(o => num(o.amount) < S.cashLimit)) out.push(reason('STRUCTURING', `${sameDay.length + 1} cash payments today totalling ${total} ${cur}.`));
  }
  if (desk && t0) {
    const d = new Date(t0); const h = d.getHours(); const wd = d.getDay();
    if (h < S.officeStart || h >= S.officeEnd || (S.weekendIsOff && (wd === 0 || wd === 6))) out.push(reason('OFF_HOURS', d.toLocaleString('en-GB')));
  }
  if (p.decided_at && p.created_at && new Date(p.created_at).getTime() - new Date(p.decided_at).getTime() > 86400000) out.push(reason('BACKDATED', `Recorded ${String(p.created_at).slice(0, 10)}, dated ${String(p.decided_at).slice(0, 10)}.`));
  // 6) the student and the fee
  const st = ctx.student || {};
  if (st.status && !['active', 'admitted', 'registered', 'probation', 'pending', ''].includes(String(st.status).toLowerCase()) && !(String(p.category || '').includes('alumni') || String(p.category || '').includes('transcript'))) out.push(reason('INACTIVE_STUDENT', 'Status: ' + st.status + '.'));
  const charges = (ctx.charges || []).filter(c => !Number(c.deleted));
  const billedSame = charges.filter(c => String(c.currency || '').toUpperCase() === cur);
  if (!charges.length && amt > 0) out.push(reason('NO_CHARGE', `No "${p.category}" fee was billed to this student.`));
  else if (!billedSame.length) out.push(reason('CURRENCY_MISMATCH', `Billed in ${[...new Set(charges.map(c => c.currency))].join('/')}, paid in ${cur}.`));
  else {
    const billed = billedSame.reduce((a, c) => a + num(c.amount), 0);
    const paid = others.filter(o => o.category === p.category && String(o.currency || '').toUpperCase() === cur).reduce((a, o) => a + num(o.amount), 0) + amt;
    if (paid > billed * (1 + S.tolerance) + 1) out.push(reason('OVERPAID', `Paid ${paid} against ${billed} ${cur} billed.`));
  }
  const amounts = (ctx.categoryAmounts || []).map(num).filter(x => x > 0).sort((a, b) => a - b);
  if (amounts.length >= 5) { const med = amounts[Math.floor(amounts.length / 2)]; const p95 = amounts[Math.min(amounts.length - 1, Math.floor(amounts.length * 0.95))]; if (amt > med * S.outlierFactor && amt > p95) out.push(reason('AMOUNT_OUTLIER', `Typical ${p.category}: ${med} ${cur}.`)); }
  const lastHour = others.filter(o => Math.abs(new Date(o.decided_at || o.created_at || 0).getTime() - t0) <= 3600000).length;
  if (lastHour + 1 >= S.velocityPerHour) out.push(reason('VELOCITY', `${lastHour + 1} payments within an hour.`));
  if (desk && Number(ctx.officerVoids) >= S.voidsPerWeek) out.push(reason('OFFICER_VOIDS', `${ctx.officerVoids} voids by the collecting officer in 7 days.`));
  const score = combine(out);
  return { score, level: levelOf(score, out), reasons: out };
}

/**
 * Evaluate a BANK-TRANSFER CLAIM before any money is recorded (blocks automatic receipts).
 * ctx = { imageTwins: [claims (≠ req) with the same receipt image], refTwins: [claims (≠ req) with the same bank reference],
 *         names: [student + parent/guardian names] }
 */
function evaluateClaim(req, ctx = {}) {
  const out = [];
  if ((ctx.imageTwins || []).length) out.push(reason('CLAIM_IMAGE_REUSED', 'Same image as ' + ctx.imageTwins.map(x => x.ticket_no || x.id).slice(0, 3).join(', ') + '.'));
  if ((ctx.refTwins || []).length) out.push(reason('CLAIM_REF_REUSED', 'Reference also claimed on ' + ctx.refTwins.map(x => x.ticket_no || x.id).slice(0, 3).join(', ') + '.'));
  if (req.ocr_match === 'none') out.push(reason('OCR_CONTRADICTS', 'The AI could not find the declared amount/reference/payer on the receipt.'));
  const pw = words(req.payer_name); const known = new Set((ctx.names || []).flatMap(words));
  if (pw.length && known.size && !pw.some(w => known.has(w))) out.push(reason('PAYER_UNRELATED', `Payer "${req.payer_name}".`));
  if (ctx.receipt) for (const r of receiptReasons(req, ctx.receipt, ctx.accounts || [], ctx.now)) out.push(r);
  if (Number(ctx.claimsToday) >= 4) out.push(reason('CLAIM_VELOCITY', ctx.claimsToday + ' claims in the last 24 hours.'));
  const score = combine(out);
  return { score, level: levelOf(score, out), reasons: out };
}

/** 🧾 Checks on the fields the AI read off an uploaded receipt (`f` = { amount, currency, date, status,
 *  beneficiary_account, edit_signs[] }) against the claim and the university's own bank accounts. Pure. */
const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
function parseDay(s) {
  const t = String(s || '').trim(); if (!t) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(t); if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);     // day-first (most receipts outside the US)
  const p = Date.parse(t); return isFinite(p) ? p : null;
}
function receiptReasons(req, f, accounts, now) {
  const out = []; if (!f || typeof f !== 'object') return out;
  const at = Number(now) || Date.now();
  const amt = Number(f.amount);
  if (isFinite(amt) && amt > 0 && Math.abs(amt - Number(req.amount)) >= 0.01) out.push(reason('RECEIPT_AMOUNT_DIFFERS', `Receipt ${amt} vs claimed ${req.amount}.`));
  if (f.currency && req.currency && /^[A-Z]{3}$/.test(String(f.currency).toUpperCase()) && String(f.currency).toUpperCase() !== String(req.currency).toUpperCase()) out.push(reason('RECEIPT_CURRENCY_DIFFERS', `Receipt in ${String(f.currency).toUpperCase()}, claim in ${req.currency}.`));
  const st = String(f.status || '');
  if (/\b(fail(ed|ure)?|declined|reversed|unsuccessful|cancel+ed|rejected)\b/i.test(st)) out.push(reason('RECEIPT_NOT_SUCCESSFUL', `Status on the receipt: "${st.slice(0, 40)}".`));
  else if (/\b(pending|processing|in progress|queued)\b/i.test(st)) out.push(reason('RECEIPT_PENDING', `Status on the receipt: "${st.slice(0, 40)}".`));
  const ben = digits(f.beneficiary_account); const ours = (accounts || []).map(a => digits(a.account_no || a)).filter(d => d.length >= 4);
  if (ben.length >= 4 && ours.length) {
    // a masked number on the receipt (****1234) can only be compared on its visible tail
    const hit = ours.some(d => (ben.length >= 10 && d.length >= 10) ? d === ben : d.slice(-4) === ben.slice(-4));
    if (!hit) out.push(reason('RECEIPT_WRONG_ACCOUNT', `Paid into …${ben.slice(-4)}.`));
  }
  const day = parseDay(f.date);
  if (day != null) {
    if (day > at + 36 * 3600000) out.push(reason('RECEIPT_FUTURE_DATE', `Dated ${String(f.date).slice(0, 20)}.`));
    const filed = Date.parse(req.created_at || '') || at;
    if (day < filed - 60 * 86400000) out.push(reason('RECEIPT_OLD', `Dated ${String(f.date).slice(0, 20)}, claimed ${new Date(filed).toISOString().slice(0, 10)}.`));
  }
  const signs = (Array.isArray(f.edit_signs) ? f.edit_signs : []).map(x => String(x || '').trim()).filter(Boolean);
  if (signs.length) out.push(reason('RECEIPT_EDIT_SIGNS', signs.slice(0, 3).join('; ').slice(0, 160)));
  return out;
}

/** The documents to ask for, from a result's reasons (deduplicated, in a sensible order). */
function docsFor(reasons) {
  const keys = []; for (const r of reasons || []) for (const k of (CHECKS[r.code] ? CHECKS[r.code].docs : [])) if (!keys.includes(k)) keys.push(k);
  if (!keys.length) keys.push('original');
  return keys.map(k => DOCS[k]);
}

/** A stable reference key for duplicate detection: the gateway reference (after 'provider:'), else the
 *  bank reference found in the narration ("ref XXXX"). */
function referenceOf(p) {
  const tag = String(p.decision_note || '');
  if (p.method === 'online' && tag.includes(':')) return norm(tag.slice(tag.indexOf(':') + 1));
  const m = /\bref(?:erence)?\s*[:#]?\s*([A-Za-z0-9-]{6,})/i.exec(String(p.narration || ''));
  return m ? norm(m[1]) : '';
}

module.exports = { CHECKS, CRITICAL, DOCS, DEFAULTS, evaluate, evaluateClaim, receiptReasons, parseDay, docsFor, referenceOf, combine, levelOf };
