'use strict';
/**
 * 💼 ADVANCES & IMPREST — pure rules shared by the desktop (electron/services/advances.js, where the Bursary issues,
 * checks and settles) and the portal / app (where the member of staff holding the money sees it and RETIRES it with
 * receipt photos). One arithmetic for "what is still to be accounted for", one check of a retirement line.
 *
 *   outstanding = issued + reimbursed + replenished − approved spending − cash handed back − recovered − written off
 *   (negative = the university owes the holder: they spent more than they were given)
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const OPEN = ['requested', 'approved', 'issued', 'retiring'];
const RECEIPT_MAX = 8 * 1024 * 1024;
const RECEIPT_TYPES = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/i;

/** moves: advance_moves rows · lines: advance_lines rows · retirements: advance_retirements rows (all of ONE advance). */
function balance(moves, lines, retirements) {
  const alive = (x) => x && !Number(x.deleted);
  const sum = (k) => r2((moves || []).filter(m => alive(m) && m.kind === k).reduce((t, m) => t + (Number(m.amount) || 0), 0));
  const approved = new Set((retirements || []).filter(r => alive(r) && r.status === 'approved').map(r => r.id));
  const spent = r2((lines || []).filter(l => alive(l) && l.kind === 'spend' && approved.has(l.retirement_id)).reduce((t, l) => t + (Number(l.amount) || 0), 0));
  const given = r2(sum('issue') + sum('reimburse') + sum('replenish'));
  const refunded = sum('refund'), recovered = sum('recover'), writtenOff = sum('writeoff');
  return { given, spent, refunded, recovered, writtenOff, outstanding: r2(given - spent - refunded - recovered - writtenOff) };
}

/** A retirement line as entered by the holder (or an officer) → the clean fields, or throws a plain-language error. */
function cleanLine(data, o = {}) {
  const d = data || {};
  const kind = d.kind === 'refund' ? 'refund' : 'spend';
  const amount = r2(d.amount); if (!(amount > 0)) throw new Error('Enter the amount.');
  if (amount > 1e12) throw new Error('That amount is not possible.');
  const today = o.today || new Date().toISOString().slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? String(d.date) : today;
  if (date > today) throw new Error('The date cannot be in the future.');
  const description = String(d.description || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (kind === 'spend' && description.length < 3) throw new Error('Say what was bought / paid for.');
  return { kind, amount, date, description: description || (kind === 'refund' ? 'Unspent cash handed back' : ''), vendor: String(d.vendor || '').trim().slice(0, 120) || null, category: String(d.category || o.category || 'Other').slice(0, 60) };
}
/** A request for an advance made by the member of staff themselves (portal / app) → clean fields, or throws. */
function cleanRequest(data, o = {}) {
  const d = data || {};
  const purpose = String(d.purpose || '').replace(/\s+/g, ' ').trim();
  if (purpose.length < 5) throw new Error('Say what the money is for.');
  const amount = r2(d.amount); if (!(amount > 0)) throw new Error('Enter the amount.');
  if (amount > 1e10) throw new Error('That amount is not possible.');
  const currency = (String(d.currency || o.currency || 'NGN').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)) || 'NGN';
  if (currency.length !== 3) throw new Error('Enter the currency as a 3-letter code (e.g. NGN, USD).');
  const today = o.today || new Date().toISOString().slice(0, 10);
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(d.due_date || '')) && String(d.due_date) >= today ? String(d.due_date) : null;
  return { purpose: purpose.slice(0, 300), amount, currency, category: String(d.category || 'Other').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Other', due_date: due };
}
/** A receipt file: an image or a PDF, at most 8 MB. → { mime, name } or throws. */
function checkReceipt(mime, size, name) {
  const m = String(mime || '').toLowerCase();
  if (!RECEIPT_TYPES.test(m)) throw new Error('Attach a photo (JPG / PNG) or a PDF of the receipt.');
  if (!(size > 0)) throw new Error('The receipt file is empty.');
  if (size > RECEIPT_MAX) throw new Error('The receipt is too large (8 MB at most) — take a smaller photo.');
  return { mime: m, name: String(name || 'receipt').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) };
}

/** What the member of staff holding an advance sees (portal / app). */
function staffView(a, moves, retirements, lines, today) {
  const alive = (x) => x && !Number(x.deleted);
  const rets = (retirements || []).filter(alive).sort((x, y) => (Number(y.seq) || 0) - (Number(x.seq) || 0));
  const draft = rets.find(r => r.status === 'draft') || null;
  const last = rets.find(r => r.status !== 'draft') || null;
  const lineView = (l) => ({ id: l.id, kind: l.kind, date: l.date, description: l.description, vendor: l.vendor || null, amount: r2(l.amount), hasReceipt: !!(l.receipt || l.receipt_key), receipt_name: l.receipt_name || null });
  const draftLines = draft ? (lines || []).filter(l => alive(l) && l.retirement_id === draft.id).sort((x, y) => String(x.date || '').localeCompare(String(y.date || ''))).map(lineView) : [];
  const b = ['issued', 'retiring', 'retired', 'recovered', 'written_off'].includes(a.status) ? balance(moves, lines, retirements) : null;
  const t = today || new Date().toISOString().slice(0, 10);
  const overdue = a.status === 'issued' && !!a.due_date && a.due_date < t && !!b && b.outstanding > 0.005;
  return {
    id: a.id, no: a.adv_no, kind: a.kind, purpose: a.purpose, category: a.category, currency: a.currency, amount: r2(a.amount), status: a.status,
    due_date: a.due_date || null, issued_at: a.issued_at || null, closed_at: a.closed_at || null, created_at: a.created_at, balance: b, overdue,
    daysOverdue: overdue ? Math.round((Date.parse(t) - Date.parse(a.due_date)) / 86400000) : 0,
    canRetire: a.status === 'issued',
    draft: draft ? { id: draft.id, seq: Number(draft.seq) || 1, lines: draftLines, spend: r2(draftLines.filter(l => l.kind === 'spend').reduce((x, l) => x + l.amount, 0)), back: r2(draftLines.filter(l => l.kind === 'refund').reduce((x, l) => x + l.amount, 0)) } : null,
    last: last ? { seq: Number(last.seq) || 1, status: last.status, note: last.decide_note || null, submitted_at: last.submitted_at || null, decided_at: last.decided_at || null } : null,
  };
}

module.exports = { r2, OPEN, RECEIPT_MAX, balance, cleanLine, cleanRequest, checkReceipt, staffView };
