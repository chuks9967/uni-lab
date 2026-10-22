'use strict';
/**
 * 💳 PAYMENT FLOW RULES — the ONE place that decides, for the portal, the mobile app and the desktop:
 *   • the BASKET: a student/parent ticks several fees and pays them in one checkout (same currency, same collecting
 *     office) — never more than each fee still owes;
 *   • how a gateway-confirmed amount is SPLIT back over the basket (first ticked fee first; any rounding excess —
 *     CinetPay rounds CFA up to a multiple of 5 — lands on the last line and becomes credit);
 *   • the progress a payer sees for a bank-transfer claim (received → receipt read → waiting for the bank → bank
 *     confirmed → receipt issued) and which reassurance message is due while a slow bank's alert is awaited;
 *   • the words of every payment update (e-mail, WhatsApp, the in-app feed) — for the student AND the parent.
 * Pure: no database, no network, no clock except the `now` you pass.
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cap = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** How far a gateway's confirmed amount may exceed the checkout (CinetPay rounds CFA up to a multiple of 5). */
function tolerance(currency) { return /^(XOF|XAF)$/i.test(String(currency || '')) ? 5 : 1; }

const MAX_LINES = 12;
/** The fees a payer chose → [{ category, amount }] (one line per fee, positive, ≤ 12 lines) or { error }. */
function normaliseItems(body) {
  const b = body || {};
  const raw = Array.isArray(b.items) && b.items.length ? b.items : [{ category: b.category, amount: b.amount }];
  const by = new Map();
  for (const it of raw.slice(0, 40)) {
    const category = String((it && it.category) || 'tuition').trim().slice(0, 40); const amount = r2(it && it.amount);
    if (!category) continue;
    if (!(amount > 0)) return { error: 'Enter a valid amount for ' + cap(category) + '.' };
    by.set(category, r2((by.get(category) || 0) + amount));
  }
  const items = Array.from(by, ([category, amount]) => ({ category, amount }));
  if (!items.length) return { error: 'Choose at least one fee to pay.' };
  if (items.length > MAX_LINES) return { error: 'Choose at most ' + MAX_LINES + ' fees in one payment.' };
  return { items };
}

/**
 * Check a basket against what is owed and who collects each fee.
 *   owedFor(category)  → what the payer still owes for it in this currency (null = unknown here → not blocked)
 *   ownerOf(category)  → { user_id, role } of the collecting office
 *   money(a)           → formatted amount for messages
 * → { ok, items, total, owner } | { ok:false, error, groups? }
 */
function checkBasket(items, owedFor, ownerOf, money) {
  const fmt = typeof money === 'function' ? money : (a) => String(r2(a));
  const owners = new Map();
  for (const it of items) {
    const owed = owedFor(it.category);
    if (owed != null && !(owed > 0.009)) return { ok: false, error: 'Nothing is owed for ' + cap(it.category) + ' — remove it from the payment.' };
    if (owed != null && it.amount > owed + 0.01) return { ok: false, error: 'You owe ' + fmt(owed) + ' for ' + cap(it.category) + '. Please pay ' + fmt(owed) + ' or less for it.' };
    // fees go in ONE checkout when they reach the same office set-up (methods + accounts) — `key` from the host when known
    const o = ownerOf(it.category) || { role: 'accountant' }; const key = o.key || ((o.user_id || '') + '|' + (o.role || ''));
    if (!owners.has(key)) owners.set(key, { owner: o, categories: [] });
    owners.get(key).categories.push(it.category);
  }
  if (owners.size > 1) {
    return { ok: false, error: 'These fees are collected by different offices, so they are paid in separate checkouts: ' + Array.from(owners.values()).map(g => g.categories.map(cap).join(' + ')).join(' · ') + '.', groups: Array.from(owners.values()) };
  }
  const total = r2(items.reduce((a, it) => a + it.amount, 0));
  return { ok: true, items, total, owner: Array.from(owners.values())[0].owner };
}

/** Split a confirmed amount over the basket lines, in order. Short payment → the first fees are covered first;
 *  an excess (rounding) → added to the last line. Lines that receive nothing are dropped. */
function allocate(items, paid) {
  let left = r2(paid); const out = [];
  (items || []).forEach((it, i) => {
    if (left <= 0.004) return;
    const a = r2(Math.min(left, Number(it.amount) || 0)); if (a <= 0) return;
    out.push({ category: it.category, amount: a, index: i }); left = r2(left - a);
  });
  if (left > 0.004 && out.length) out[out.length - 1].amount = r2(out[out.length - 1].amount + left);
  return out;
}

/** Items stored on an intent / claim (JSON) → [{category, amount}] or null for a single-fee record. */
function itemsOf(row) {
  if (!row || !row.items_json) return null;
  try { const v = typeof row.items_json === 'string' ? JSON.parse(row.items_json) : row.items_json; return Array.isArray(v) && v.length ? v.map(x => ({ category: String(x.category || ''), amount: r2(x.amount) })).filter(x => x.category && x.amount > 0) : null; } catch (_) { return null; }
}
function describeItems(items, fallbackCategory) {
  const list = items && items.length ? items : [{ category: fallbackCategory || 'fees' }];
  return list.map(x => cap(x.category)).join(' + ');
}

// ---- 🏦 bank-transfer claims: what the payer sees -------------------------------------------------------------
const LATE_DAYS = 14;          // after the 48 h review flag, keep matching late bank alerts this long
const CLAIM_STEPS = [
  { key: 'received', label: 'Received' },
  { key: 'scanned', label: 'Receipt read' },
  { key: 'bank', label: 'Bank confirmed' },
  { key: 'receipt', label: 'Receipt issued' },
];
/** The progress card for one claim. `c` = a manual_payments row (receipt bytes not needed); `extra.proofs` = how many
 *  documents the payer added (a bank statement…) — more can be added while the claim is still being checked. */
const PROOF_OPEN = ['submitted', 'flagged', 'physical_check', 'bank_matched', 'registrar_confirmed'];
const MAX_PROOFS = 5;
function claimView(c, now, extra) {
  const t = Number(now) || Date.now();
  const ageH = Math.max(0, (t - (Date.parse(c.created_at || '') || t)) / 3600000);
  const scanned = !!(c.ocr_json && String(c.ocr_json).trim());
  const code = flagCode(c);
  let at = 1, label = 'Waiting for the bank’s credit alert', tone = 'warn', explain = '';
  switch (c.status) {
    case 'submitted':
      at = scanned ? 2 : 1;
      explain = ageH < 6 ? 'We check the bank’s alerts every 30 minutes. Most transfers are confirmed within a few hours.'
        : ageH < 48 ? 'Some banks send their credit alerts late. We keep checking every 30 minutes and will message you the moment it arrives.'
          : 'We are still waiting for the bank. The Bursary has been asked to check it by hand.';
      break;
    case 'bank_matched': case 'registrar_confirmed':
      at = 3; label = 'Bank confirmed — receipt being issued'; tone = 'ok';
      explain = 'The bank confirmed your transfer. The Bursary gives the final approval and your official receipt follows.';
      break;
    case 'receipted': at = 4; label = 'Paid — receipt issued'; tone = 'ok'; explain = 'Your official receipt was sent by e-mail and WhatsApp and is in Receipts.'; break;
    case 'flagged':
      at = scanned ? 2 : 1; tone = 'warn';
      if (code === 'timeout') { label = 'Still waiting for the bank'; explain = 'The bank’s alert has not arrived yet. We keep watching for it (late alerts still count) and the Bursary is checking too.'; }
      else if (code === 'amount_mismatch') { label = 'Amount differs from the bank'; explain = 'The bank credited a different amount than you entered. The Registry will review it — you may be asked for your bank statement.'; }
      else { label = 'Being checked by the Bursary'; explain = 'A routine check that protects your money. Keep your bank receipt and statement ready in case the office asks for them.'; }
      break;
    case 'physical_check': at = 2; label = 'Please visit the Bursary'; tone = 'bad'; explain = 'Bring your original proof of payment (bank receipt, teller or statement).'; break;
    case 'rejected': at = 0; label = 'Closed — could not be verified'; tone = 'bad'; explain = c.flag_reason ? String(c.flag_reason) : 'Visit the Bursary with your proof of payment if you believe this is a mistake.'; break;
    default: break;
  }
  const steps = CLAIM_STEPS.map((s, i) => ({ key: s.key, label: s.label, done: i < at, current: i === at && c.status !== 'rejected' && c.status !== 'receipted' }));
  const watching = c.status === 'submitted' || (c.status === 'flagged' && code === 'timeout' && ageH < (48 + LATE_DAYS * 24));
  const proofs = Number(extra && extra.proofs) || 0;
  // a payer waiting on a slow bank can speed things up with their statement — invited once the wait is long
  const askProof = (c.status === 'submitted' && ageH >= 24) || (c.status === 'flagged') || c.status === 'physical_check';
  return { id: c.id, ticket_no: c.ticket_no || '', amount: r2(c.amount), currency: c.currency || '', what: describeItems(itemsOf(c), c.category), status: c.status, label, tone, explain, steps, watching, age_hours: Math.round(ageH * 10) / 10, created_at: c.created_at, receipt_payment_id: c.payment_id || null,
    proofs, can_add_proof: PROOF_OPEN.includes(c.status) && proofs < MAX_PROOFS, ask_proof: askProof && proofs === 0 && PROOF_OPEN.includes(c.status) };
}
/** Why a claim was flagged, from its stored code (newer rows) or its reason text (older rows). */
function flagCode(c) {
  if (c.flag_code) return String(c.flag_code);
  const r = String(c.flag_reason || '');
  if (/^No matching bank credit/i.test(r)) return 'timeout';
  if (/^Amount mismatch/i.test(r)) return 'amount_mismatch';
  if (/^Fraud check/i.test(r)) return 'fraud';
  return r ? 'review' : '';
}
/** Is a late bank alert still allowed to verify this claim? (flagged only for want of an alert, inside the window) */
function lateMatchable(c, now) {
  if (!(c.status === 'flagged' || c.status === 'physical_check') || flagCode(c) !== 'timeout') return false;
  const ageH = ((Number(now) || Date.now()) - (Date.parse(c.created_at || '') || 0)) / 3600000;
  return ageH < 48 + LATE_DAYS * 24;
}
/** Which reassurance message is due now for a claim still waiting on its bank alert (null = none). `sent` = the
 *  set of nudge keys already sent (from its timeline). Only the latest due one is sent (no back-fill bursts). */
function nudgeDue(c, sent, now) {
  const has = (k) => sent && (sent.has ? sent.has(k) : sent.includes(k));
  const ageH = ((Number(now) || Date.now()) - (Date.parse(c.created_at || '') || 0)) / 3600000;
  if (c.status === 'submitted') {
    if (ageH >= 24 && ageH < 48 && !has('nudge_24h')) return 'nudge_24h';
    if (ageH >= 6 && ageH < 24 && !has('nudge_6h') && !has('nudge_24h')) return 'nudge_6h';
    return null;
  }
  if (c.status === 'flagged' && flagCode(c) === 'timeout') {
    const d = ageH / 24;
    if (d >= 7 && d < 2 + LATE_DAYS && !has('late_7d')) return 'late_7d';
    if (d >= 4 && d < 7 && !has('late_4d') && !has('late_7d')) return 'late_4d';
  }
  return null;
}

// ---- ⚠ chargebacks ----------------------------------------------------------------------------------------------
const DISPUTE_STATES = ['open', 'won', 'lost'];
/**
 * What a dispute changes on a receipted payment. d = { status:'open'|'won'|'lost', id (the bank/gateway case), reason,
 * amount, due_at, source:'gateway'|'desk' } → { patch, stage } or null when it says nothing new. A closed case never
 * re-opens from a late or replayed 'open' notice for the SAME case. The receipt itself is never changed here — the patch
 * clears checked_at so the payment-integrity check looks again (open → answer the bank; lost → reverse the receipt).
 */
function disputePatch(p, d, nowIso) {
  if (!p || !d || !DISPUTE_STATES.includes(d.status)) return null;
  const sameCase = !d.id || !p.dispute_ref || String(p.dispute_ref) === String(d.id);
  if (p.dispute_status === d.status && sameCase) return null;
  if (d.status === 'open' && sameCase && (p.dispute_status === 'won' || p.dispute_status === 'lost')) return null;
  const now = nowIso || new Date().toISOString();
  const amt = Number(d.amount);
  return {
    stage: 'dispute_' + d.status,
    patch: {
      dispute_status: d.status, dispute_ref: d.id ? String(d.id).slice(0, 80) : (p.dispute_ref || null),
      dispute_reason: String(d.reason || p.dispute_reason || 'Disputed by the card holder').slice(0, 200),
      dispute_amount: isFinite(amt) && amt > 0 ? Math.min(Math.round(amt * 100) / 100, Number(p.amount) || amt) : (p.dispute_amount != null ? p.dispute_amount : null),
      dispute_due_at: d.status === 'open' ? (d.due_at || p.dispute_due_at || null) : (p.dispute_due_at || null),
      dispute_source: d.source || p.dispute_source || 'gateway',
      disputed_at: (sameCase && p.disputed_at) || now, dispute_closed_at: d.status === 'open' ? null : now,
      checked_at: null, updated_at: now,
    },
  };
}

// ---- 🔁 AutoPay (installment plans charged to a saved card) ------------------------------------------------------
const AUTOPAY_NOTICE_DAYS = 3;   // the payer is told this many days before each charge
const AUTOPAY_MAX_TRIES = 3;     // one try a day; after this many declines for one installment AutoPay pauses
/** Has a card expired by `today`? exp = 'YYYY-MM' (good through the end of that month). */
function cardExpired(exp, today) { const m = /^(\d{4})-(\d{2})$/.exec(String(exp || '')); return !!m && String(today || '').slice(0, 7) > m[1] + '-' + m[2]; }
function addDaysIso(d, n) { const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
/**
 * What AutoPay does today for one mandate — a pure decision, so every host decides the same.
 * m    = { status, exp, fails, fails_seq, last_attempt_at, notice_seq }
 * plan = the plan as the portal shows it ({ next:{ seq, due_date, due }, remaining }) or null when it is finished/gone
 * owed = what the fee itself still owes;  today = 'YYYY-MM-DD'
 * → { action:'none'|'notice'|'charge'|'complete'|'expire'|'pause', seq, amount, due_date, attempt }
 * Never more than the installment, never more than the fee owes, one try a day, a notice before the first try.
 */
function autopayStep(m, plan, owed, today) {
  if (!m || m.status !== 'active') return { action: 'none' };
  if (!plan || !plan.next || !(Number(plan.remaining) > 0.001) || !(Number(owed) > 0.009)) return { action: 'complete' };
  if (cardExpired(m.exp, today)) return { action: 'expire' };
  const n = plan.next; const amount = Math.round(Math.min(Number(n.due) || 0, Number(owed)) * 100) / 100;
  const base = { seq: n.seq, amount, due_date: n.due_date };
  if (!(amount > 0)) return Object.assign({ action: 'none' }, base);
  if (String(n.due_date) <= today) {
    const tries = Number(m.fails_seq) === Number(n.seq) ? (Number(m.fails) || 0) : 0;
    if (tries >= AUTOPAY_MAX_TRIES) return Object.assign({ action: 'pause' }, base);
    if (String(m.last_attempt_at || '').slice(0, 10) === today) return Object.assign({ action: 'none' }, base);
    if (Number(m.notice_seq) !== Number(n.seq)) return Object.assign({ action: 'notice', overdue: true }, base);   // never charged without a word first
    return Object.assign({ action: 'charge', attempt: tries + 1 }, base);
  }
  if (addDaysIso(today, AUTOPAY_NOTICE_DAYS) >= String(n.due_date) && Number(m.notice_seq) !== Number(n.seq)) return Object.assign({ action: 'notice' }, base);
  return Object.assign({ action: 'none' }, base);
}
/** The checkout reference of one AutoPay try — the same on every host, so a gateway refuses a second charge for it. */
function autopayRef(mandateId, seq, attempt) { return 'AP-' + String(mandateId).replace(/[^a-z0-9]/gi, '').slice(0, 12).toUpperCase() + '-' + seq + '-' + attempt; }

// ---- 📨 the words of every payment update ----------------------------------------------------------------------
/**
 * stage: claim_received | nudge_6h | nudge_24h | late_4d | late_7d | claim_matched | claim_late_matched | claim_receipted
 *        | claim_review | claim_mismatch | claim_timeout | claim_physical | claim_rejected | claim_confirmed_manual
 *        | online_failed | online_review | online_delayed | online_late_paid | dispute_open | dispute_lost | dispute_won
 *        | autopay_on | autopay_upcoming | autopay_paid | autopay_failed | autopay_paused | autopay_expired | autopay_off
 * ctx: { first, ward, parent:bool, inst, ticket, amount (formatted), what, reason, receipt_no, portal, method, card, date, seq }
 * → { subject, html, text (WhatsApp/SMS), title (feed, with emoji), body (feed) }
 */
function noticeFor(stage, ctx) {
  const c = ctx || {};
  const who = c.parent ? 'Parent/Guardian' : (c.first || 'Student');
  const forWard = c.parent && c.ward ? ' for ' + c.ward : '';
  const amt = c.amount || ''; const what = c.what || 'fees'; const tk = c.ticket ? ' (ticket ' + c.ticket + ')' : '';
  const rc = c.receipt_no ? ', receipt ' + c.receipt_no : '';
  const where = c.portal ? 'Track it on the portal (' + c.portal + ') → Fees, or in the mobile app.' : 'Track it on the student portal → Fees, or in the mobile app.';
  const T = {
    claim_received: ['🏦 Transfer claim received', `We received the bank-transfer claim of ${amt}${forWard} (${what})${tk}. We check the bank's credit alerts every 30 minutes and will tell you the moment it is confirmed.`],
    nudge_6h: ['⏳ Still waiting for the bank', `The bank has not sent the credit alert for the ${amt} transfer${forWard}${tk} yet. That is normal for some banks — we keep checking every 30 minutes. No action is needed.`],
    nudge_24h: ['⏳ Your bank is slow today', `A day on, the bank's alert for the ${amt} transfer${forWard}${tk} has still not arrived. We keep checking. If your bank shows the debit, keep the receipt — nothing else is needed for now.`],
    claim_timeout: ['🔎 Transfer passed to the Bursary', `After 48 hours there is still no bank alert for the ${amt} transfer${forWard}${tk}. The Bursary will check it by hand, and we keep watching for a late alert for another ${LATE_DAYS} days.`],
    late_4d: ['🔎 Still watching for your transfer', `We are still watching for the bank's late alert for the ${amt} transfer${forWard}${tk}, and the Bursary is checking it by hand.`],
    late_7d: ['🔎 Transfer still under check', `A week on, the bank has not confirmed the ${amt} transfer${forWard}${tk}. If you have a bank statement showing the debit, upload it on the portal (Fees) or bring it to the Bursary — it speeds things up.`],
    claim_matched: ['✅ Bank confirmed your transfer', `The bank confirmed the ${amt} transfer${forWard}${tk}. The Bursary gives the final approval and the official receipt follows.`],
    claim_late_matched: ['✅ Late bank alert — transfer confirmed', `The bank's alert for the ${amt} transfer${forWard}${tk} arrived late, and it is now confirmed. The official receipt follows.`],
    claim_confirmed_manual: ['✅ Transfer confirmed after a check', `The Registry confirmed the ${amt} transfer${forWard}${tk} after a manual check. The official receipt follows.`],
    claim_receipted: ['🧾 Payment verified — receipt issued', `The ${amt} payment${forWard} (${what}) is verified and receipted${c.receipt_no ? ' — receipt ' + c.receipt_no : ''}. The PDF receipt is sent by e-mail and WhatsApp and is always in Receipts.`],
    claim_review: ['🛡 A routine check on your transfer', `The ${amt} transfer${forWard}${tk} needs a quick manual check before it is confirmed. Keep the original bank receipt and statement ready — the office may ask for them.`],
    claim_mismatch: ['⚠ Amount differs from the bank', `The bank credited a different amount than the ${amt} entered${forWard}${tk}. The Registry will review it — you may be asked for the bank statement.`],
    claim_physical: ['🏛 Please visit the Bursary', `Please bring the original proof of the ${amt} transfer${forWard}${tk} (bank receipt, teller or statement) to the Bursary${c.reason ? ': ' + c.reason : '.'}`],
    claim_rejected: ['Transfer claim closed', `The ${amt} transfer claim${forWard}${tk} could not be verified${c.reason ? ': ' + c.reason : '.'} If you believe this is a mistake, visit the Bursary with your proof of payment.`],
    online_failed: ['⚠ Payment did not go through', `The ${amt} ${c.method ? c.method + ' ' : ''}payment${forWard} (${what}) did not go through${c.reason ? ': ' + c.reason : '.'} Nothing is owed for this attempt. You can try again, choose another payment method, or pay by bank transfer.`],
    online_review: ['🛡 Payment received — quick check needed', `We received the ${amt} payment${forWard} (${what}), but it needs a quick check by the Bursary before the receipt is issued. No action is needed — you will be told when it is done.`],
    online_delayed: ['⏳ Payment still being confirmed', `The ${amt} payment${forWard} (${what}) has not been confirmed by the provider yet. If money left your account, it will reflect automatically — we keep checking for 30 days. If you did not finish paying, you can ignore this.`],
    online_late_paid: ['✅ Payment confirmed', `The ${amt} payment${forWard} (${what}) has now been confirmed by the provider. The official receipt is on its way.`],
    // ⚠ chargebacks: the card holder's bank disputed a receipted online payment
    dispute_open: ['⚠ A bank disputed this payment', `The card holder's bank has disputed the ${amt} payment${forWard} (${what})${rc}. If you did not ask your bank to reverse it, tell the Bursary and upload the payment confirmation on the portal (Fees). If the money goes back to the card holder, the receipt is cancelled and the fee is owed again.`],
    dispute_lost: ['⚠ Disputed payment returned to the card', `After a dispute with the bank, the ${amt} payment${forWard} (${what})${rc} was returned to the card holder. The Bursary will cancel that receipt, so the fee will be owed again. Contact the Bursary if this is a mistake.`],
    // 🔁 AutoPay (installment plans charged to a saved card)
    autopay_on: ['🔁 AutoPay is on', `The next installments of ${what}${forWard} will be paid automatically from ${c.card || 'the card used'} on their due dates. You are told ${AUTOPAY_NOTICE_DAYS} days before each one, and you can turn AutoPay off any time on the portal or the app (Fees).`],
    autopay_upcoming: ['🔁 AutoPay charge coming up', `${c.date ? 'On ' + c.date : 'Soon'}, ${amt} will be charged to ${c.card || 'the saved card'} for installment ${c.seq || ''} of ${what}${forWard}. Nothing to do — or turn AutoPay off on Fees before then.`],
    autopay_paid: ['✅ AutoPay installment paid', `Installment ${c.seq || ''} of ${what}${forWard} — ${amt} — was paid from ${c.card || 'the saved card'}${rc}. The receipt is in Receipts.`],
    autopay_failed: ['⚠ AutoPay charge did not go through', `The ${amt} AutoPay charge to ${c.card || 'the saved card'} for ${what}${forWard} did not go through${c.reason ? ': ' + c.reason : '.'} We will try again tomorrow — or pay it now on Fees.`],
    autopay_paused: ['⏸ AutoPay paused', `After ${AUTOPAY_MAX_TRIES} tries, the ${amt} installment of ${what}${forWard} could not be charged to ${c.card || 'the saved card'}${c.reason ? ' (' + c.reason + ')' : ''}. Please pay it on Fees — you can turn AutoPay on again with another card.`],
    autopay_expired: ['⏸ AutoPay card expired', `${c.card || 'The saved card'} has expired, so AutoPay for ${what}${forWard} has stopped. Pay the next installment on Fees and tick AutoPay again with the new card.`],
    autopay_off: ['AutoPay turned off', `AutoPay for ${what}${forWard} is off — no more automatic charges to ${c.card || 'the saved card'}. Pay each installment on Fees.`],
    dispute_won: ['✅ Payment dispute closed', `The bank's dispute on the ${amt} payment${forWard} (${what})${rc} was closed in the university's favour. The receipt stands — no action is needed.`],
  };
  const t = T[stage] || ['💳 Payment update', `There is an update on the ${amt} payment${forWard}.`];
  const subject = t[0].replace(/^\S+\s/, '') + (c.ticket ? ' · ' + c.ticket : '');
  const html = `<p>Dear ${esc(who)},</p><p>${esc(t[1])}</p><p style="color:#64748b;font-size:13px">${esc(where)}</p><p>Regards,<br>Bursary · ${esc(c.inst || 'the University')}</p>`;
  const text = `*${t[0]}*\n${c.inst || ''}\n\n${c.parent ? 'Dear Parent/Guardian' : 'Hello ' + who}, ${t[1]}\n\n${where}`;
  return { subject, html, text, title: t[0], body: t[1] };
}

/** 🌍 The words of the public /pay page (pay for a student without signing in) in French, Spanish, Arabic and Hausa. */
const PUBPAY_I18N = {"fr":{"No smartphone or no data? Dial":"Pas de smartphone ou pas de données ? Composez","Pay fees for a student":"Payer les frais d’un étudiant","For parents, relatives and sponsors — no account needed. The official receipt goes to the student; you get a confirmation by e-mail.":"Pour les parents, proches et sponsors — sans compte. Le reçu officiel va à l’étudiant ; vous recevez une confirmation par e-mail.","Student’s matric number":"Numéro matricule de l’étudiant","Student’s surname":"Nom de famille de l’étudiant","as on their records":"comme dans son dossier","Find the fees":"Trouver les frais","Paying for":"Paiement pour","Nothing is owed right now. 🎉":"Rien n’est dû pour le moment. 🎉","Your name":"Votre nom","Your e-mail (your confirmation goes here)":"Votre e-mail (votre confirmation arrive ici)","Your phone (optional — needed for pay-on-phone methods)":"Votre téléphone (facultatif — requis pour le paiement par téléphone)","Owed":"Dû","How to pay":"Comment payer","🏦 Bank transfer — confirmed automatically":"🏦 Virement bancaire — confirmé automatiquement","From any bank app or USSD · no receipt needed":"Depuis n’importe quelle appli bancaire ou USSD · aucun reçu","Pay by bank transfer to:":"Payez par virement à :","Put the matric number in the narration and ask the student to declare it on their portal.":"Indiquez le matricule dans le libellé et demandez à l’étudiant de le déclarer sur son portail.","💳 Pay":"💳 Payer","Check the amount for":"Vérifiez le montant pour","Tick at least one fee.":"Cochez au moins un frais.","Pay again anyway":"Payer quand même","Could not start the payment.":"Le paiement n’a pas pu démarrer.","Transfer exactly":"Virez exactement","to":"sur","Waiting for your transfer… it is confirmed automatically.":"En attente de votre virement… il est confirmé automatiquement.","Approve the payment on your phone.":"Validez le paiement sur votre téléphone.","Waiting for your approval…":"En attente de votre validation…","Received":"Reçu","receipt":"reçu","Thank you!":"Merci !","It did not go through.":"Le paiement n’a pas abouti.","Received — being checked.":"Reçu — en vérification.","Still waiting. If you paid, it is confirmed automatically and the student is told.":"Toujours en attente. Si vous avez payé, c’est confirmé automatiquement et l’étudiant est prévenu.","Network error — check your connection.":"Erreur réseau — vérifiez votre connexion.","Not found.":"Introuvable.","Amount for":"Montant pour","Bank transfer:":"Virement bancaire :","We could not find a student with that matric number and surname. Check both and try again.":"Aucun étudiant ne correspond à ce matricule et ce nom. Vérifiez les deux et réessayez.","Enter the student’s matric number and surname.":"Saisissez le matricule et le nom de l’étudiant.","Too many searches — please wait a little and try again.":"Trop de recherches — patientez un peu puis réessayez.","Too many attempts for this matric number — please try again later.":"Trop de tentatives pour ce matricule — réessayez plus tard.","Enter your name.":"Saisissez votre nom.","Enter your e-mail — your confirmation goes there.":"Saisissez votre e-mail — votre confirmation y sera envoyée.","This page has expired — search for the student again.":"Cette page a expiré — recherchez à nouveau l’étudiant.","Language":"Langue"},"es":{"No smartphone or no data? Dial":"¿Sin smartphone o sin datos? Marque","Pay fees for a student":"Pagar las tasas de un estudiante","For parents, relatives and sponsors — no account needed. The official receipt goes to the student; you get a confirmation by e-mail.":"Para padres, familiares y patrocinadores — sin cuenta. El recibo oficial va al estudiante; usted recibe una confirmación por correo.","Student’s matric number":"Número de matrícula del estudiante","Student’s surname":"Apellido del estudiante","as on their records":"como figura en su expediente","Find the fees":"Buscar las tasas","Paying for":"Pago para","Nothing is owed right now. 🎉":"No se debe nada por ahora. 🎉","Your name":"Su nombre","Your e-mail (your confirmation goes here)":"Su correo (aquí llega su confirmación)","Your phone (optional — needed for pay-on-phone methods)":"Su teléfono (opcional — necesario para pagos por teléfono)","Owed":"Adeudado","How to pay":"Cómo pagar","🏦 Bank transfer — confirmed automatically":"🏦 Transferencia bancaria — confirmada automáticamente","From any bank app or USSD · no receipt needed":"Desde cualquier app bancaria o USSD · sin comprobante","Pay by bank transfer to:":"Pague por transferencia a:","Put the matric number in the narration and ask the student to declare it on their portal.":"Ponga la matrícula en el concepto y pida al estudiante que lo declare en su portal.","💳 Pay":"💳 Pagar","Check the amount for":"Revise el importe de","Tick at least one fee.":"Marque al menos una tasa.","Pay again anyway":"Pagar de todos modos","Could not start the payment.":"No se pudo iniciar el pago.","Transfer exactly":"Transfiera exactamente","to":"a","Waiting for your transfer… it is confirmed automatically.":"Esperando su transferencia… se confirma automáticamente.","Approve the payment on your phone.":"Apruebe el pago en su teléfono.","Waiting for your approval…":"Esperando su aprobación…","Received":"Recibido","receipt":"recibo","Thank you!":"¡Gracias!","It did not go through.":"No se completó.","Received — being checked.":"Recibido — en revisión.","Still waiting. If you paid, it is confirmed automatically and the student is told.":"Aún en espera. Si pagó, se confirma solo y se avisa al estudiante.","Network error — check your connection.":"Error de red — revise su conexión.","Not found.":"No encontrado.","Amount for":"Importe de","Bank transfer:":"Transferencia bancaria:","We could not find a student with that matric number and surname. Check both and try again.":"No encontramos un estudiante con esa matrícula y apellido. Revise ambos e inténtelo de nuevo.","Enter the student’s matric number and surname.":"Introduzca la matrícula y el apellido del estudiante.","Too many searches — please wait a little and try again.":"Demasiadas búsquedas — espere un poco e inténtelo de nuevo.","Too many attempts for this matric number — please try again later.":"Demasiados intentos para esta matrícula — inténtelo más tarde.","Enter your name.":"Introduzca su nombre.","Enter your e-mail — your confirmation goes there.":"Introduzca su correo — allí llega su confirmación.","This page has expired — search for the student again.":"Esta página caducó — busque de nuevo al estudiante.","Language":"Idioma"},"ar":{"No smartphone or no data? Dial":"لا هاتف ذكي أو لا إنترنت؟ اطلب","Pay fees for a student":"دفع رسوم طالب","For parents, relatives and sponsors — no account needed. The official receipt goes to the student; you get a confirmation by e-mail.":"للآباء والأقارب والرعاة — دون حساب. يذهب الإيصال الرسمي إلى الطالب، وتصلك رسالة تأكيد بالبريد.","Student’s matric number":"الرقم الجامعي للطالب","Student’s surname":"اسم عائلة الطالب","as on their records":"كما في سجلاته","Find the fees":"ابحث عن الرسوم","Paying for":"الدفع لـ","Nothing is owed right now. 🎉":"لا شيء مستحق الآن. 🎉","Your name":"اسمك","Your e-mail (your confirmation goes here)":"بريدك الإلكتروني (يصل التأكيد إليه)","Your phone (optional — needed for pay-on-phone methods)":"هاتفك (اختياري — لازم للدفع عبر الهاتف)","Owed":"مستحق","How to pay":"طريقة الدفع","🏦 Bank transfer — confirmed automatically":"🏦 تحويل بنكي — يُؤكَّد تلقائيًا","From any bank app or USSD · no receipt needed":"من أي تطبيق بنكي أو USSD · دون إيصال","Pay by bank transfer to:":"ادفع بالتحويل البنكي إلى:","Put the matric number in the narration and ask the student to declare it on their portal.":"ضع الرقم الجامعي في وصف التحويل واطلب من الطالب الإبلاغ عنه في بوابته.","💳 Pay":"💳 ادفع","Check the amount for":"تحقق من المبلغ لـ","Tick at least one fee.":"حدّد رسمًا واحدًا على الأقل.","Pay again anyway":"ادفع مع ذلك","Could not start the payment.":"تعذّر بدء الدفع.","Transfer exactly":"حوّل بالضبط","to":"إلى","Waiting for your transfer… it is confirmed automatically.":"بانتظار تحويلك… يُؤكَّد تلقائيًا.","Approve the payment on your phone.":"وافق على الدفع من هاتفك.","Waiting for your approval…":"بانتظار موافقتك…","Received":"تم الاستلام","receipt":"إيصال","Thank you!":"شكرًا لك!","It did not go through.":"لم يتم.","Received — being checked.":"تم الاستلام — قيد المراجعة.","Still waiting. If you paid, it is confirmed automatically and the student is told.":"ما زلنا ننتظر. إن دفعت فسيُؤكَّد تلقائيًا ويُبلَّغ الطالب.","Network error — check your connection.":"خطأ في الشبكة — تحقق من اتصالك.","Not found.":"غير موجود.","Amount for":"المبلغ لـ","Bank transfer:":"تحويل بنكي:","We could not find a student with that matric number and surname. Check both and try again.":"لم نجد طالبًا بهذا الرقم الجامعي واسم العائلة. تحقق منهما وحاول مجددًا.","Enter the student’s matric number and surname.":"أدخل الرقم الجامعي واسم عائلة الطالب.","Too many searches — please wait a little and try again.":"عمليات بحث كثيرة — انتظر قليلًا وحاول مجددًا.","Too many attempts for this matric number — please try again later.":"محاولات كثيرة لهذا الرقم الجامعي — حاول لاحقًا.","Enter your name.":"أدخل اسمك.","Enter your e-mail — your confirmation goes there.":"أدخل بريدك الإلكتروني — يصل التأكيد إليه.","This page has expired — search for the student again.":"انتهت صلاحية هذه الصفحة — ابحث عن الطالب مجددًا.","Language":"اللغة"},"ha":{"No smartphone or no data? Dial":"Babu wayar zamani ko data? Danna","Pay fees for a student":"Biya kuɗin ɗalibi","For parents, relatives and sponsors — no account needed. The official receipt goes to the student; you get a confirmation by e-mail.":"Ga iyaye, dangi da masu tallafi — ba sai da asusu ba. Rasit na hukuma zai je ga ɗalibi; kai za ka sami tabbaci ta imel.","Student’s matric number":"Lambar matric ɗin ɗalibi","Student’s surname":"Sunan mahaifin ɗalibi","as on their records":"kamar yadda yake a bayanansa","Find the fees":"Nemo kuɗaɗen","Paying for":"Ana biya wa","Nothing is owed right now. 🎉":"Babu bashi yanzu. 🎉","Your name":"Sunanka","Your e-mail (your confirmation goes here)":"Imel ɗinka (tabbacinka zai zo nan)","Your phone (optional — needed for pay-on-phone methods)":"Wayarka (zaɓi — ana buƙata don biya ta waya)","Owed":"Bashi","How to pay":"Yadda za a biya","🏦 Bank transfer — confirmed automatically":"🏦 Tura kuɗi a banki — ana tabbatarwa kai tsaye","From any bank app or USSD · no receipt needed":"Daga kowace manhajar banki ko USSD · babu rasit","Pay by bank transfer to:":"Biya ta tura kuɗi zuwa:","Put the matric number in the narration and ask the student to declare it on their portal.":"Saka lambar matric a bayanin tura kuɗi kuma ka roƙi ɗalibi ya bayyana shi a shafinsa.","💳 Pay":"💳 Biya","Check the amount for":"Duba adadin","Tick at least one fee.":"Zaɓi aƙalla kuɗi ɗaya.","Pay again anyway":"Biya duk da haka","Could not start the payment.":"Ba a iya fara biyan ba.","Transfer exactly":"Tura daidai","to":"zuwa","Waiting for your transfer… it is confirmed automatically.":"Ana jiran tura kuɗinka… ana tabbatarwa kai tsaye.","Approve the payment on your phone.":"Amince da biyan a wayarka.","Waiting for your approval…":"Ana jiran amincewarka…","Received":"An karɓa","receipt":"rasit","Thank you!":"Na gode!","It did not go through.":"Bai yiwu ba.","Received — being checked.":"An karɓa — ana dubawa.","Still waiting. If you paid, it is confirmed automatically and the student is told.":"Har yanzu ana jira. Idan ka biya, za a tabbatar kai tsaye kuma a sanar da ɗalibi.","Network error — check your connection.":"Matsalar intanet — duba haɗinka.","Not found.":"Ba a samu ba.","Amount for":"Adadin","Bank transfer:":"Tura kuɗi a banki:","We could not find a student with that matric number and surname. Check both and try again.":"Ba mu sami ɗalibi da wannan lambar matric da sunan ba. Duba su biyu ka sake gwadawa.","Enter the student’s matric number and surname.":"Shigar da lambar matric da sunan ɗalibi.","Too many searches — please wait a little and try again.":"Bincike ya yi yawa — jira kaɗan ka sake gwadawa.","Too many attempts for this matric number — please try again later.":"Ƙoƙari ya yi yawa kan wannan lambar matric — sake gwadawa daga baya.","Enter your name.":"Shigar da sunanka.","Enter your e-mail — your confirmation goes there.":"Shigar da imel ɗinka — tabbacinka zai je can.","This page has expired — search for the student again.":"Shafin ya ƙare — sake neman ɗalibin.","Language":"Harshe"}};

module.exports = { tolerance, normaliseItems, checkBasket, allocate, itemsOf, describeItems, claimView, flagCode, lateMatchable, nudgeDue, noticeFor, disputePatch, DISPUTE_STATES, autopayStep, autopayRef, cardExpired, AUTOPAY_NOTICE_DAYS, AUTOPAY_MAX_TRIES, LATE_DAYS, CLAIM_STEPS, MAX_LINES, MAX_PROOFS, PROOF_OPEN, PUBPAY_I18N };
