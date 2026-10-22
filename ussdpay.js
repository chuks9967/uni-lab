'use strict';
/**
 * 📞 PAY BY USSD — fees from a basic phone with no data: dial the institution's code, pick the student, see what is
 * owed, pay. The aggregator (Africa's Talking format) POSTs sessionId, serviceCode, phoneNumber and `text` = every
 * answer so far joined by '*'; we answer 'CON …' (ask again) or 'END …' (done).
 *
 * STATELESS: every request replays the whole path, so the same menu runs on the LAN hub and the cloud edge with no
 * session store. 0 = back, 00 = start again; a wrong answer is dropped and the same screen shown again with a note.
 *
 * Who is paying: a phone registered as the student's or the parent's (the network vouches for the number) picks from
 * those students; anyone else (a relative, a sponsor) gives the matric number's digits + the surname — the same check
 * and the same guessing limits as the public /pay page. Paying: a one-time bank account confirmed automatically (any
 * bank app or the bank's own USSD), an M-Pesa prompt on this phone, or the bank details. The money flow is the portal's
 * own (startStudentPayment): the same basket rules, double-payment guard, failover and receipts.
 *
 * The portal supplies the adapter A:
 *   wardsFor(phone) → [{ id, name }]                      students this phone is registered to (as student or parent)
 *   find(digits, surname, isNew) → { student:{id,name} } | { error, blocked }
 *   owed(sid) → { items:[{ key, label, currency, owed, suggest, group }], groups:[{ key, currency, categories, owed,
 *                 transfer, push, bank:{ bank, account_no, account_name } | null }] }
 *   history(sid) → { last:{ receipt_no, amount, currency, label, date } | null, pending:[{ amount, currency, what, status }] }
 *   inFlight(sid, lines, currency) → message | null
 *   pay(sid, { items, currency, mode:'transfer'|'push', phone, confirm_duplicate }) → the portal's checkout answer
 *   pushOk(phone, currency) → bool                         this phone can receive a mobile-money prompt for the currency
 *   name → the institution's short name;  matricOf(sid) → the narration for a manual bank transfer
 */
const MAX_FEES = 6;
const BACK = '\n0 Back';
const LIMIT = 182;   // what most networks show on one USSD screen
/** As many numbered choices as fit on one screen (the same data always gives the same list, so replays agree). */
function fit(head, list, tail, label) {
  let n = list.length;
  while (n > 1 && ('CON ' + head + list.slice(0, n).map((c, k) => '\n' + (k + 1) + ' ' + label(c)).join('') + tail).length > LIMIT - 30) n--;
  return list.slice(0, n);
}

function money(a, cur) { return String(cur || '') + ' ' + (Math.round((Number(a) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '.' : s; };

/** The answers so far, with 0 (back) and 00 (start again) applied. */
function tokensOf(text) {
  const raw = String(text == null ? '' : text) === '' ? [] : String(text).split('*').map(x => x.trim());
  const st = [];
  for (const t of raw) { if (t === '00') st.length = 0; else if (t === '0') st.pop(); else st.push(t); }
  return st;
}
const pick = (t, n) => { const k = /^\d{1,2}$/.test(String(t)) ? parseInt(t, 10) : 0; return k >= 1 && k <= n ? k : 0; };
const describe = (lines, labelOf) => lines.map(l => labelOf(l.category)).join(' + ');

async function respond(input, A) {
  const tk = tokensOf(input && input.text); let i = 0; let err = '';
  const more = () => i < tk.length;
  const next = () => tk[i++];
  const CON = (s) => ({ end: false, text: 'CON ' + (err ? err + '\n' : '') + s });
  const END = (s) => ({ end: true, text: 'END ' + s });
  const BAD = 'Not a choice - try again.';
  const phone = String((input && input.phone) || '');

  // 1) what to do
  let action = '';
  for (;;) {
    if (!more()) return CON((A.name ? A.name + ' fees' : 'School fees') + '\n1 Pay fees\n2 What is owed\n3 Last payment');
    const t = next(); if (t === '1' || t === '2' || t === '3') { action = t; err = ''; break; } err = BAD;
  }

  // 2) which student
  let wards = []; try { wards = (await A.wardsFor(phone)) || []; } catch (_) { wards = []; }
  wards = wards.slice(0, 7);
  let sid = null, who = '', byMatric = !wards.length;
  while (!sid) {
    if (!byMatric) {
      if (!more()) return CON('Which student?\n' + wards.map((w, k) => (k + 1) + ' ' + short(w.name, 20)).join('\n') + '\n9 Another student' + BACK);
      const t = next();
      if (t === '9') { byMatric = true; err = ''; continue; }
      const k = pick(t, wards.length); if (k) { sid = wards[k - 1].id; who = wards[k - 1].name; err = ''; break; }
      err = BAD; continue;
    }
    if (!more()) return CON("Student's matric number - digits only (CSC/25/0042 is 250042):" + BACK);
    const digits = String(next()).replace(/\D/g, '');
    if (digits.length < 4) { err = 'Enter at least 4 digits.'; continue; }
    err = '';
    if (!more()) return CON("Student's surname:" + BACK);
    const sur = next();
    const r = (await A.find(digits, sur, !more())) || {};
    if (r.student) { sid = r.student.id; who = r.student.name; err = ''; break; }
    if (r.blocked) return END(r.error || 'Too many attempts - please try again later.');
    err = r.error || 'No student with that matric number and surname.';
  }

  const ov = (await A.owed(sid)) || { items: [], groups: [] };
  const labelOf = (key) => { const it = ov.items.find(x => x.key === key); return it ? it.label : key; };

  // 3a) what is owed
  if (action === '2') {
    if (!ov.items.length) return END(who + ' owes nothing right now. Thank you!');
    const tot = {}; for (const it of ov.items) tot[it.currency] = (tot[it.currency] || 0) + it.owed;
    const total = ov.items.length > 1 ? '\nTotal ' + Object.entries(tot).map(([c, v]) => money(v, c)).join(' + ') : '';
    let n = Math.min(MAX_FEES, ov.items.length); let body;
    for (;;) {
      const lines = ov.items.slice(0, n).map(it => short(it.label, 16) + ' ' + money(it.owed, it.currency));
      if (ov.items.length > n) lines.push('+' + (ov.items.length - n) + ' more');
      body = who + ' owes:\n' + lines.join('\n') + total;
      if (('END ' + body).length <= LIMIT || n <= 1) break;
      n--;
    }
    return END(body + (('END ' + body + '\nDial again, choose 1 to pay.').length <= LIMIT ? '\nDial again, choose 1 to pay.' : ''));
  }
  // 3b) the last payment, and anything still being confirmed
  if (action === '3') {
    const h = (await A.history(sid)) || {};
    const out = [];
    if (h.last) out.push('Last: ' + money(h.last.amount, h.last.currency) + ' ' + short(h.last.label, 16) + ', receipt ' + h.last.receipt_no + ', ' + String(h.last.date || '').slice(0, 10));
    for (const p of (h.pending || []).slice(0, 2)) out.push((p.status === 'failed' ? 'Did not go through: ' : p.status === 'review' ? 'Being checked: ' : 'Waiting: ') + money(p.amount, p.currency) + ' ' + short(p.what, 16));
    return END(out.length ? who + '\n' + out.join('\n') : 'No payments yet for ' + who + '.');
  }

  // 3c) pay — which fee (one fee, or all of one office's fees in one go)
  if (!ov.items.length) return END(who + ' owes nothing right now. Thank you!');
  // "all of one office's fees" first (the quickest way to clear everything), then each fee — as many as fit on the screen
  const choices = [];
  for (const g of ov.groups) {
    const its = ov.items.filter(x => x.group === g.key);
    if (its.length > 1 && choices.length < 2) choices.push({ label: 'All ' + its.length + ' fees ' + money(g.owed, g.currency), items: its, currency: g.currency, group: g.key, all: true });
  }
  for (const it of ov.items.slice(0, MAX_FEES)) choices.push({ label: short(it.label, 14) + ' ' + money(it.owed, it.currency), items: [it], currency: it.currency, group: it.group });
  const shown = fit('Pay for ' + short(who, 20) + ':', choices, BACK, c => c.label);
  let ch = null;
  for (;;) {
    if (!more()) return CON('Pay for ' + short(who, 20) + ':\n' + shown.map((c, k) => (k + 1) + ' ' + c.label).join('\n') + BACK);
    const k = pick(next(), shown.length); if (k) { ch = shown[k - 1]; err = ''; break; } err = BAD;
  }

  // how much
  let lines;
  if (ch.all) lines = ch.items.map(x => ({ category: x.key, amount: x.owed }));
  else {
    const it = ch.items[0];
    const opts = [{ label: 'All ' + money(it.owed, it.currency), amount: it.owed }];
    if (it.suggest > 0 && it.suggest < it.owed - 0.009) opts.push({ label: 'Installment due ' + money(it.suggest, it.currency), amount: it.suggest });
    opts.push({ label: 'Another amount', other: true });
    let o = null;
    for (;;) {
      if (!more()) return CON(short(it.label, 20) + ': ' + money(it.owed, it.currency) + ' owed\n' + opts.map((x, k) => (k + 1) + ' ' + x.label).join('\n') + BACK);
      const k = pick(next(), opts.length); if (k) { o = opts[k - 1]; err = ''; break; } err = BAD;
    }
    let amount = o.amount;
    if (o.other) {
      for (;;) {
        if (!more()) return CON('Amount to pay in ' + it.currency + ' (up to ' + money(it.owed, it.currency) + '):' + BACK);
        const v = Math.round((Number(String(next()).replace(/[^\d.]/g, '')) || 0) * 100) / 100;
        if (v > 0 && v <= it.owed + 0.009) { amount = v; err = ''; break; }
        err = 'Enter an amount up to ' + money(it.owed, it.currency) + '.';
      }
    }
    lines = [{ category: it.key, amount }];
  }
  const total = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
  const what = describe(lines, labelOf);

  // how to pay
  const g = ov.groups.find(x => x.key === ch.group) || {};
  const methods = [];
  if (g.transfer) methods.push({ mode: 'transfer', label: 'Bank transfer (account given now, confirmed automatically)', word: 'bank transfer' });
  if (g.push && A.pushOk(phone, ch.currency)) methods.push({ mode: 'push', label: 'Mobile money prompt on this phone', word: 'mobile money' });
  if (g.bank) methods.push({ mode: 'bank', label: 'Bank account details', word: 'bank details' });
  if (!methods.length) return END('Paying by phone is not set up for this fee yet. Please pay on the student portal or at the Bursary.');
  let m = methods[0];
  if (methods.length > 1) {
    for (;;) {
      if (!more()) return CON('Pay ' + money(total, ch.currency) + ' by:\n' + methods.map((x, k) => (k + 1) + ' ' + x.label).join('\n') + BACK);
      const k = pick(next(), methods.length); if (k) { m = methods[k - 1]; err = ''; break; } err = BAD;
    }
  }
  if (m.mode === 'bank') {
    const b = g.bank;
    return END('Pay ' + money(total, ch.currency) + ' into ' + b.bank + ' ' + b.account_no + (b.account_name ? ' (' + b.account_name + ')' : '') + '. Narration: ' + (A.matricOf ? A.matricOf(sid) : '') + '. Then the student declares it on the portal (Fees, bank transfer) for the receipt.');
  }

  // confirm (with a warning when money for these fees is already on its way)
  let dup = null; try { dup = await A.inFlight(sid, lines, ch.currency); } catch (_) { dup = null; }
  for (;;) {
    if (!more()) return CON((dup ? 'Note: ' + short(dup, 70) + '\n' : '') + 'Pay ' + money(total, ch.currency) + ' for ' + short(what, 30) + ' (' + short(who, 16) + ') by ' + m.word + '?\n1 Yes\n2 Cancel' + BACK);
    const t = next();
    if (t === '1') break;
    if (t === '2') return END('Cancelled. Nothing was charged.');
    err = BAD;
  }
  if (more()) return END('This payment was already started - dial again to check it.');

  const r = (await A.pay(sid, { items: lines, currency: ch.currency, mode: m.mode, phone, confirm_duplicate: !!dup })) || {};
  if (r.ok && r.mode === 'transfer' && r.transfer) {
    const t = r.transfer; const mins = t.expires_at ? Math.round((Date.parse(t.expires_at) - Date.now()) / 60000) : 0;
    return END('Transfer exactly ' + money(t.amount || r.amount || total, ch.currency) + ' to ' + t.account_number + ' ' + (t.bank || '') + (t.account_name ? ' (' + t.account_name + ')' : '') + (mins > 0 ? ' within ' + mins + ' min' : '') + '. It is confirmed automatically and ' + short(who, 16) + ' gets the receipt.');
  }
  if (r.ok && r.mode === 'push') return END('Approve the ' + money(r.amount || total, ch.currency) + ' prompt on this phone. ' + short(who, 16) + ' gets the receipt once it is paid.');
  if (r.duplicate) return END(short(r.error, 170));
  if (r.fallback === 'bank' && r.banks && r.banks[0]) { const b = r.banks[0]; return END('Online payment is not answering right now. Pay ' + money(total, ch.currency) + ' into ' + b.bank + ' ' + b.account_no + ', then declare it on the portal - or dial again later.'); }
  if (r.needs_phone) return END('This phone cannot receive the payment prompt. Choose bank transfer instead.');
  return END(short(r.error || 'The payment could not be started. Please try again later.', 170));
}

module.exports = { respond, tokensOf, money };
