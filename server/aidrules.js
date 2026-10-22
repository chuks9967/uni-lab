'use strict';
/**
 * 🤝 FINANCIAL AID (HARDSHIP) — the rules shared by the desk (electron/services/finaid.js), the portal and the edge.
 *
 *   apply       a student asks for a grant towards their fees while the window is open: an amount (up to the maximum
 *               award), a reason in their own words, their circumstances and household income band
 *   need        a transparent 0–100 score from what they told us — circumstances, income, dependants and how much of
 *               what they owe the request covers — so the queue is ranked by need, not by who shouted loudest
 *   two people  one reviewer RECOMMENDS an amount; a DIFFERENT person approves it (the award then reduces the
 *               student's fees as a scholarship credit); the fund cannot be overspent
 */
const CIRCUMSTANCES = {
  sponsor_lost: ['The person who paid my fees can no longer pay (death, job loss, separation)', 25],
  orphan: ['I have no parent supporting me', 20],
  displaced: ['Displaced by conflict, flood or disaster', 20],
  emergency: ['A medical or family emergency', 15],
  self_funded: ['I pay my own fees', 10],
  dependants: ['I support younger siblings or children', 10],
  disability: ['Disability or long-term illness', 10],
};
const INCOME = { none: ['No regular household income', 30], low: ['Low household income', 20], middle: ['Middle household income', 8], high: ['High household income', 0] };
const STATUS = { submitted: 'Submitted — being reviewed', recommended: 'Recommended — awaiting approval', awarded: 'Awarded', declined: 'Not awarded', withdrawn: 'Withdrawn' };
const OPEN = ['submitted', 'recommended'];
const DEFAULT_POLICY = { enabled: false, opens: null, closes: null, fund: null, max_award: 0 };

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const day = (d) => String(d || '').slice(0, 10);
const todayOf = (now) => new Date(now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now))).toISOString().slice(0, 10);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n || 500);

function policyOf(raw) {
  let p = raw; if (typeof p === 'string') { try { p = JSON.parse(p || '{}'); } catch (_) { p = {}; } }
  p = Object.assign({}, DEFAULT_POLICY, p && typeof p === 'object' ? p : {});
  const fund = p.fund && Number(p.fund.amount) > 0 && /^[A-Za-z]{3}$/.test(String(p.fund.currency || '')) ? { amount: r2(p.fund.amount), currency: String(p.fund.currency).toUpperCase() } : null;
  return { enabled: !!p.enabled && p.enabled !== '0', opens: /^\d{4}-\d{2}-\d{2}$/.test(day(p.opens)) ? day(p.opens) : null, closes: /^\d{4}-\d{2}-\d{2}$/.test(day(p.closes)) ? day(p.closes) : null,
    fund, max_award: Math.max(0, r2(p.max_award)), session_id: p.session_id || null };
}
/** Is the application window open today? */
function isOpen(policy, now) {
  const p = policyOf(policy); if (!p.enabled) return { open: false, reason: 'Financial aid applications are not open.' };
  const t = todayOf(now);
  if (p.opens && t < p.opens) return { open: false, reason: 'Applications open on ' + p.opens + '.' };
  if (p.closes && t > p.closes) return { open: false, reason: 'Applications closed on ' + p.closes + '.' };
  return { open: true, closes: p.closes };
}
/** Check an application. → { ok, app } or { ok:false, error } */
function validate(input, policy, mine, now) {
  const p = policyOf(policy); const st = isOpen(p, now); if (!st.open) return { ok: false, error: st.reason };
  if ((mine || []).some(a => a && !Number(a.deleted) && OPEN.includes(a.status))) return { ok: false, error: 'You already have an application being reviewed.' };
  const requested = r2(input && input.requested);
  if (!(requested > 0)) return { ok: false, error: 'Enter how much you are asking for.' };
  if (p.max_award && requested > p.max_award) return { ok: false, error: 'The most one student can be awarded is ' + (p.fund ? p.fund.currency + ' ' : '') + p.max_award + '.' };
  const reason = clean(input && input.reason, 3000);
  if (reason.length < 50) return { ok: false, error: 'Tell us in a few sentences why you need help (at least 50 characters).' };
  const circs = [...new Set((Array.isArray(input && input.circumstances) ? input.circumstances : String(input && input.circumstances || '').split(',')).map(x => String(x).trim()).filter(x => CIRCUMSTANCES[x]))];
  const income = INCOME[input && input.income] ? input.income : null;
  if (!income) return { ok: false, error: 'Choose your household income band.' };
  const dependants = Math.max(0, Math.min(20, parseInt(input && input.dependants, 10) || 0));
  const link = clean(input && input.link, 500);
  if (link && !/^https?:\/\/[^\s<>"']{3,500}$/i.test(link)) return { ok: false, error: 'A supporting-document link must start with http:// or https://' };
  return { ok: true, app: { requested, currency: p.fund ? p.fund.currency : String(input && input.currency || 'NGN').toUpperCase().slice(0, 3), reason, circumstances: circs, income, dependants, link: link || null, category: clean(input && input.category, 40) || null } };
}
/** The need score, with its parts, from what the student told us and what they owe. */
function needScore(app, ctx) {
  const parts = [];
  const circs = Array.isArray(app.circumstances) ? app.circumstances : (() => { try { return JSON.parse(app.circumstances || '[]'); } catch (_) { return []; } })();
  let c = 0; for (const k of circs) if (CIRCUMSTANCES[k]) c += CIRCUMSTANCES[k][1];
  c = Math.min(50, c); if (c) parts.push({ label: 'Circumstances', points: c });
  const inc = INCOME[app.income] ? INCOME[app.income][1] : 0; if (inc) parts.push({ label: 'Household income', points: inc });
  const dep = Math.min(10, (Number(app.dependants) || 0) * 2); if (dep) parts.push({ label: 'Dependants', points: dep });
  const owed = Number(ctx && ctx.owed) || 0; const req = Number(app.requested) || 0;
  const owe = owed > 0 && req > 0 ? Math.round(Math.min(1, owed / req) * 10) : 0; if (owe) parts.push({ label: 'Fees still owed', points: owe });
  return { score: Math.min(100, c + inc + dep + owe), parts };
}
/** How much of the fund is left (awards in the fund's currency). */
function fundLeft(policy, apps) {
  const p = policyOf(policy); if (!p.fund) return null;
  const used = (apps || []).filter(a => a && !Number(a.deleted) && a.status === 'awarded' && String(a.currency || '').toUpperCase() === p.fund.currency).reduce((s, a) => s + (Number(a.awarded_amount) || 0), 0);
  return { currency: p.fund.currency, total: p.fund.amount, used: r2(used), left: r2(p.fund.amount - used) };
}
/** Approve a recommendation: a different person, an amount within the request and the fund. → { ok } / { ok:false, error } */
function canApprove(app, actorId, fund) {
  if (!app || app.status !== 'recommended') return { ok: false, error: 'Only a recommended application can be approved.' };
  if (app.recommended_by_id && app.recommended_by_id === actorId) return { ok: false, error: 'You recommended this award — a second person approves it.' };
  const amt = Number(app.recommended_amount) || 0;
  if (!(amt > 0)) return { ok: false, error: 'The recommendation has no amount.' };
  if (fund && String(app.currency || '').toUpperCase() === fund.currency && amt > fund.left + 0.009) return { ok: false, error: 'Only ' + fund.currency + ' ' + fund.left + ' is left in the fund.' };
  return { ok: true, amount: r2(amt) };
}
const refOf = (id) => 'FA-' + String(id || '').replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase();

module.exports = { CIRCUMSTANCES, INCOME, STATUS, OPEN, policyOf, isOpen, validate, needScore, fundLeft, canApprove, refOf };
