'use strict';
/**
 * 🔒 FINANCIAL HOLDS — the ONE rule (pure; the desktop and the cloud portal both load it) for which self-service a
 * student loses while they owe fees. Off until the Bursary switches it on.
 *
 *   A student is HELD when, in any currency, they owe more than the policy allows — UNLESS
 *     • the Bursary granted them an exemption that has not expired (for all services or the ones named), or
 *     • they are on an installment plan for what they owe and no installment is overdue (policy.honourPlans).
 *   A held student loses only the services the policy names: results, transcript, registration, hostel.
 */
const SERVICES = {
  results: 'Viewing results and result slips',
  transcript: 'Requesting transcripts, certificates and result documents',
  registration: 'Registering courses',
  hostel: 'Applying for a hostel',
  exams: 'Sitting exams and tests (the ID card shows “not eligible” when scanned)',
};
const DEFAULTS = { enabled: false, services: { results: true, transcript: true, registration: false, hostel: false, exams: false }, minOwed: 0, honourPlans: true, message: '' };

function policyOf(raw) {
  let p = raw; if (typeof raw === 'string') { try { p = JSON.parse(raw || '{}'); } catch (_) { p = {}; } }
  p = p && typeof p === 'object' ? p : {};
  const services = {}; for (const k of Object.keys(SERVICES)) services[k] = p.services && p.services[k] != null ? !!p.services[k] : DEFAULTS.services[k];
  return { enabled: !!p.enabled, services, minOwed: Math.max(0, Number(p.minOwed) || 0), honourPlans: p.honourPlans !== false, message: String(p.message || '').slice(0, 300) };
}

/**
 * @param {object} x { policy, balances: {cur: net owed (+) / credit (−)}, plans: [{ currency, overdue (amount), remaining }],
 *                    exemptions: [{ services: ['results'] | 'all', until: 'YYYY-MM-DD' }], today: 'YYYY-MM-DD' }
 * @returns {{ held, services: string[], owing: {cur: amt}, reason, exempt, onPlan }}
 */
function evaluate(x) {
  const pol = policyOf(x.policy);
  const owing = {}; for (const [c, v] of Object.entries(x.balances || {})) if (Number(v) > Math.max(0.009, pol.minOwed)) owing[c] = Math.round(Number(v) * 100) / 100;
  const none = { held: false, services: [], owing, reason: '', exempt: false, onPlan: false };
  if (!pol.enabled || !Object.keys(owing).length) return none;
  const today = x.today || new Date().toISOString().slice(0, 10);
  const live = (x.exemptions || []).filter(e => !e.until || String(e.until) >= today);
  const allEx = live.some(e => e.services === 'all' || (Array.isArray(e.services) && !e.services.length));
  const exSvc = new Set(live.flatMap(e => Array.isArray(e.services) ? e.services : []));
  if (allEx) return { ...none, exempt: true, reason: 'Exempted by the Bursary' };
  // on a plan and up to date: every currency owed is covered by an active plan with nothing overdue
  const plans = x.plans || [];
  const onPlan = pol.honourPlans && Object.keys(owing).every(c => plans.some(p => p.currency === c && Number(p.remaining) > 0.009) && !plans.some(p => p.currency === c && Number(p.overdue) > 0.009));
  if (onPlan) return { ...none, onPlan: true, reason: 'On an installment plan and up to date' };
  const services = Object.keys(SERVICES).filter(k => pol.services[k] && !exSvc.has(k));
  if (!services.length) return { ...none, exempt: exSvc.size > 0 };
  const due = Object.entries(owing).map(([c, v]) => `${c} ${v.toFixed(2)}`).join(' + ');
  const overdue = plans.some(p => Number(p.overdue) > 0.009);
  return { held: true, services, owing, exempt: false, onPlan: false,
    reason: (overdue ? 'An installment is overdue' : 'Outstanding fees') + ` (${due})` + (pol.message ? ' — ' + pol.message : '') };
}
const isHeld = (h, service) => !!(h && h.held && h.services.includes(service));
const holdMessage = (h, service) => `🔒 ${SERVICES[service] || 'This service'} is on hold: ${h.reason}. Pay on the portal or the app (or ask the Bursary about an installment plan) and it is released at once.`;

module.exports = { SERVICES, DEFAULTS, policyOf, evaluate, isHeld, holdMessage };
