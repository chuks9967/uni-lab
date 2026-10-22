'use strict';
/**
 * 📨 STUDENT E-SERVICES — pure rules shared by the portal (cloud / edge / LAN) and the desktop.
 *
 * The requests a student makes to the university between admission and graduation — letters, transcripts,
 * deferment, resumption, change of programme, withdrawal, record corrections, ID card replacement, extra
 * credit load, re-marking, excused absence — each with:
 *   • a FORM (fields validated here, identically on every server),
 *   • a PRE-CHECK against the student's own facts (status, balance, CGPA …) — BLOCKERS stop the request,
 *     WARNINGS are shown to the student and to every approver,
 *   • an APPROVAL CHAIN of offices (HOD → Dean → Registrar …), each scoped to the student's department /
 *     faculty, with a service-level target in days,
 *   • an EFFECT applied by the desktop when the chain approves (status change, programme change, a letter
 *     published to the student's Documents, …) — so an approval is never "just a status".
 *
 * Nothing here touches a database: the callers pass rows and facts in and store what comes out.
 */

const OFFICES = {
  hod: 'Head of Department', target_hod: 'Receiving Head of Department', dean: 'Dean', registrar: 'Registry',
  accountant: 'Bursary', student_affairs: 'Student Affairs',
};
const PURPOSES = ['Visa / embassy', 'Bank account', 'Scholarship / sponsorship', 'Internship / employer', 'Travel', 'Other'];

/** The catalogue. `effect` is what the desktop does on final approval. `sla` = target days end to end. */
const TYPES = [
  { key: 'studentship_letter', name: 'Letter of studentship (proof of enrolment)', icon: '📄', group: 'Letters & documents', effect: 'letter', letter: 'studentship', workflow: ['registrar'], sla: 3,
    desc: 'An official letter confirming you are a registered student — for visas, banks, sponsors or employers.',
    fields: [{ key: 'purpose', label: 'What is it for?', type: 'select', options: PURPOSES, required: true }, { key: 'addressee', label: 'Addressed to (optional)', type: 'text', max: 160 }] },
  { key: 'introduction_letter', name: 'Letter of introduction (internship / research / attachment)', icon: '🤝', group: 'Letters & documents', effect: 'letter', letter: 'introduction', workflow: ['hod', 'registrar'], sla: 5,
    desc: 'Introduces you to an organisation for industrial training, an internship or research data collection.',
    fields: [{ key: 'organisation', label: 'Organisation', type: 'text', required: true, max: 160 }, { key: 'address', label: 'Organisation address', type: 'text', max: 240 },
      { key: 'activity', label: 'Activity', type: 'select', options: ['Industrial training / internship', 'Research / data collection', 'Excursion / field visit', 'Other'], required: true }, { key: 'start_date', label: 'Starting (date)', type: 'date' }] },
  { key: 'transcript_request', name: 'Official transcript', icon: '🎓', group: 'Letters & documents', effect: 'transcript', workflow: ['registrar'], sla: 10, needsClearFees: true,
    desc: 'Your official transcript, for you or sent directly to another institution, employer or evaluation body.',
    fields: [{ key: 'destination', label: 'Send it to', type: 'select', options: ['Myself (student copy)', 'Another university', 'An employer', 'An evaluation body (e.g. WES)', 'Other'], required: true },
      { key: 'recipient', label: 'Recipient name / institution', type: 'text', max: 160 }, { key: 'recipient_email', label: 'Recipient e-mail (electronic delivery)', type: 'email' },
      { key: 'delivery', label: 'Delivery', type: 'select', options: ['Electronic (secure e-mail)', 'Courier', 'Collect in person'], required: true }, { key: 'copies', label: 'Copies', type: 'number', min: 1, max: 5 }] },
  { key: 'deferment', name: 'Deferment / leave of absence', icon: '⏸', group: 'Studies', effect: 'defer', workflow: ['hod', 'dean', 'registrar'], sla: 14, needsStatus: ['active'],
    desc: 'Suspend your studies for one or two sessions (medical, financial, family or work reasons) and keep your place.',
    fields: [{ key: 'sessions', label: 'For how many sessions?', type: 'select', options: ['1', '2'], required: true }, { key: 'reason', label: 'Reason', type: 'select', options: ['Medical', 'Financial', 'Family', 'Employment', 'Other'], required: true },
      { key: 'explanation', label: 'Explain briefly', type: 'textarea', required: true, max: 1500 }] },
  { key: 'resumption', name: 'Resumption of studies', icon: '▶️', group: 'Studies', effect: 'resume', workflow: ['registrar'], sla: 7, needsStatus: ['deferred', 'suspended'],
    desc: 'Return to your studies after a deferment or suspension.',
    fields: [{ key: 'note', label: 'Anything the Registry should know', type: 'textarea', max: 1000 }] },
  { key: 'change_programme', name: 'Change of programme / department', icon: '🔀', group: 'Studies', effect: 'change_programme', workflow: ['hod', 'target_hod', 'dean', 'registrar'], sla: 21, needsStatus: ['active'],
    desc: 'Move to another programme. Both departments and the Registry decide; your earned courses are reviewed for credit.',
    fields: [{ key: 'to_department_id', label: 'Move to (department / programme)', type: 'department', required: true }, { key: 'reason', label: 'Why do you want to change?', type: 'textarea', required: true, max: 1500 }] },
  { key: 'withdrawal', name: 'Voluntary withdrawal', icon: '🚪', group: 'Studies', effect: 'withdraw', workflow: ['hod', 'accountant', 'registrar'], sla: 14, needsStatus: ['active', 'deferred'],
    desc: 'Leave the university. The Bursary settles refunds or balances before the Registry closes your record.',
    fields: [{ key: 'reason', label: 'Reason', type: 'select', options: ['Transfer to another institution', 'Financial', 'Health', 'Personal / family', 'Employment', 'Other'], required: true },
      { key: 'effective_date', label: 'From (date)', type: 'date', required: true }, { key: 'explanation', label: 'Details', type: 'textarea', max: 1500 }] },
  { key: 'extra_load', name: 'Extra credit load (overload)', icon: '➕', group: 'Studies', effect: 'overload', workflow: ['hod', 'dean'], sla: 7, needsStatus: ['active'], minCgpaSetting: 'overload_min_cgpa',
    desc: 'Register more credits than the normal maximum this term (usually for final-year students with good standing).',
    fields: [{ key: 'units', label: 'Extra credits needed', type: 'number', min: 1, max: 12, required: true }, { key: 'reason', label: 'Why?', type: 'textarea', required: true, max: 1000 }] },
  { key: 'remark', name: 'Re-marking of an examination script', icon: '🔎', group: 'Examinations', effect: 'none', workflow: ['hod', 'registrar'], sla: 21,
    desc: 'Ask for a script to be re-marked by another examiner. The outcome may raise, keep or lower the mark.',
    fields: [{ key: 'course_code', label: 'Course code', type: 'text', required: true, max: 20 }, { key: 'session', label: 'Session / term of the exam', type: 'text', max: 60 }, { key: 'reason', label: 'Why do you believe it was mis-marked?', type: 'textarea', required: true, max: 1500 }] },
  { key: 'exam_absence', name: 'Excused absence from an examination (deferred exam)', icon: '🩺', group: 'Examinations', effect: 'defer_exam', workflow: ['hod', 'dean'], sla: 10,
    desc: 'Missed (or will miss) an exam for a medical or emergency reason? If approved, the course shows DEF on your record — not a fail, not in your GPA — and you sit it later as a first attempt.',
    fields: [{ key: 'course_code', label: 'Course code', type: 'text', required: true, max: 20 }, { key: 'exam_date', label: 'Exam date', type: 'date', required: true },
      { key: 'reason', label: 'Reason', type: 'select', options: ['Medical', 'Bereavement', 'Emergency', 'Official university duty', 'Other'], required: true }, { key: 'explanation', label: 'Details (keep your medical note ready)', type: 'textarea', required: true, max: 1500 }] },
  { key: 'data_correction', name: 'Correction of my personal record', icon: '✏️', group: 'Records', effect: 'correct', workflow: ['registrar'], sla: 7,
    desc: 'A spelling mistake in your name, a wrong date of birth or gender on your record.',
    fields: [{ key: 'field', label: 'What is wrong?', type: 'select', options: ['First name', 'Middle name', 'Last name', 'Date of birth', 'Gender'], required: true },
      { key: 'new_value', label: 'Correct value', type: 'text', required: true, max: 80 }, { key: 'evidence', label: 'Evidence you can show (birth certificate, passport …)', type: 'text', required: true, max: 200 }] },
  { key: 'id_card', name: 'ID card replacement', icon: '🪪', group: 'Records', effect: 'idcard', workflow: ['student_affairs'], sla: 5,
    desc: 'Replace a lost or damaged student ID card.',
    fields: [{ key: 'reason', label: 'Reason', type: 'select', options: ['Lost', 'Stolen', 'Damaged', 'Details changed'], required: true }, { key: 'note', label: 'Details', type: 'textarea', max: 600 }] },
  { key: 'other', name: 'Another request to the Registry', icon: '📝', group: 'Records', effect: 'none', workflow: ['registrar'], sla: 7,
    desc: 'Anything else the Registry can help with.',
    fields: [{ key: 'subject', label: 'Subject', type: 'text', required: true, max: 120 }, { key: 'details', label: 'Details', type: 'textarea', required: true, max: 2000 }] },
];
const BY_KEY = Object.fromEntries(TYPES.map(t => [t.key, t]));
const FIELD_MAP = { 'First name': 'first_name', 'Middle name': 'middle_name', 'Last name': 'last_name', 'Date of birth': 'date_of_birth', 'Gender': 'gender' };
const OPEN = ['submitted', 'in_review', 'info_needed'];
const STATUS_LABEL = { submitted: 'Submitted', in_review: 'Under review', info_needed: 'More information needed', approved: 'Approved', rejected: 'Declined', withdrawn: 'Withdrawn by you', completed: 'Completed' };

/**
 * The catalogue as an institution configured it. cfg = { disabled:[keys], fees:{key:{amount,currency}}, sla:{key:days}, workflows:{key:[roles]} }
 * Returns plain objects safe to send to a browser.
 */
function catalog(cfg) {
  const c = cfg || {}; const off = new Set(Array.isArray(c.disabled) ? c.disabled : []);
  return TYPES.filter(t => !off.has(t.key)).map(t => {
    const fee = (c.fees || {})[t.key]; const wf = (c.workflows || {})[t.key];
    return Object.assign({}, t, {
      fee: fee && Number(fee.amount) > 0 ? { amount: Number(fee.amount), currency: String(fee.currency || '').toUpperCase() } : null,
      sla: Number((c.sla || {})[t.key]) > 0 ? Number(c.sla[t.key]) : t.sla,
      workflow: Array.isArray(wf) && wf.length && wf.every(r => OFFICES[r]) ? wf.slice(0, 6) : t.workflow,
      offices: (Array.isArray(wf) && wf.length ? wf : t.workflow).map(r => OFFICES[r] || r),
    });
  });
}
function typeOf(key, cfg) { return catalog(cfg).find(t => t.key === key) || null; }

/** Validate the form. ctx.departments = [{id,name}] for a department field. Returns problems (empty = fine). */
function validate(type, fields, ctx) {
  const t = typeof type === 'string' ? BY_KEY[type] : type;
  if (!t) return ['Unknown request type.'];
  const f = fields || {}; const e = [];
  for (const d of t.fields) {
    const raw = f[d.key]; const v = raw == null ? '' : String(raw).trim();
    if (d.required && !v) { e.push(`“${d.label}” is required.`); continue; }
    if (!v) continue;
    if (d.max && v.length > d.max) e.push(`“${d.label}” is too long (max ${d.max} characters).`);
    if (d.type === 'select' && !d.options.includes(v)) e.push(`Choose a valid option for “${d.label}”.`);
    if (d.type === 'number') { const n = Number(v); if (!Number.isFinite(n) || (d.min != null && n < d.min) || (d.max != null && n > d.max)) e.push(`“${d.label}” must be a number${d.min != null ? ' from ' + d.min : ''}${d.max != null ? ' to ' + d.max : ''}.`); }
    if (d.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) e.push(`“${d.label}” must be a date (YYYY-MM-DD).`);
    if (d.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) e.push(`“${d.label}” must be an e-mail address.`);
    if (d.type === 'department' && ctx && Array.isArray(ctx.departments) && !ctx.departments.some(x => x.id === v)) e.push(`Choose a department from the list for “${d.label}”.`);
  }
  if (t.key === 'transcript_request' && /^Electronic/.test(String(f.delivery || '')) && !/^Myself/.test(String(f.destination || '')) && !String(f.recipient_email || '').trim()) e.push('Give the recipient’s e-mail for electronic delivery.');
  if (t.key === 'change_programme' && ctx && ctx.student && f.to_department_id === ctx.student.department_id) e.push('That is already your department.');
  if (t.key === 'data_correction' && f.field === 'Date of birth' && f.new_value && !/^\d{4}-\d{2}-\d{2}$/.test(String(f.new_value).trim())) e.push('Write the date of birth as YYYY-MM-DD.');
  return e;
}

/**
 * The PRE-CHECK against the student's facts: { status, owing:{CUR:amount}, cgpa, standard:{max}, openOfSameType, settings:{overload_min_cgpa, transcript_requires_clearance} }.
 * Returns { blockers:[], warnings:[] } — blockers stop the request; warnings travel with it to every approver.
 */
function precheck(type, facts) {
  const t = typeof type === 'string' ? BY_KEY[type] : type; const x = facts || {};
  const blockers = []; const warnings = [];
  if (!t) return { blockers: ['Unknown request type.'], warnings };
  const status = String(x.status || 'active').toLowerCase();
  if (t.needsStatus && !t.needsStatus.includes(status)) blockers.push(`This request is for ${t.needsStatus.join(' or ')} students — your record shows “${status}”.`);
  if (x.openOfSameType) blockers.push('You already have an open request of this type — follow it in your Requests list.');
  const owing = Object.entries(x.owing || {}).filter(([, v]) => Number(v) > 0.009);
  const owingTxt = owing.map(([c, v]) => `${c} ${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`).join(', ');
  if (t.needsClearFees && owing.length) {
    const hard = (x.settings || {}).transcript_requires_clearance !== '0';
    (hard ? blockers : warnings).push(`You have an outstanding balance (${owingTxt}). ${hard ? 'Transcripts are released after fees are cleared — pay in Fees & Payments, then request again.' : 'The Registry may hold the transcript until it is paid.'}`);
  }
  if (t.key === 'withdrawal' && owing.length) warnings.push(`Outstanding balance ${owingTxt} — the Bursary settles it before your record is closed.`);
  if (t.minCgpaSetting) {
    const min = Number((x.settings || {})[t.minCgpaSetting]);
    const floor = Number.isFinite(min) && min > 0 ? min : (Number(x.standard && x.standard.max) ? Number(x.standard.max) * 0.6 : 3.0);
    if (x.cgpa == null) warnings.push('No cumulative GPA on record yet — the department decides on your transcript.');
    else if (Number(x.cgpa) < floor) blockers.push(`An overload needs a CGPA of at least ${floor.toFixed(2)} — yours is ${Number(x.cgpa).toFixed(2)}.`);
  }
  if (t.key === 'change_programme' && x.cgpa != null && Number(x.standard && x.standard.max) && Number(x.cgpa) < Number(x.standard.max) * 0.5) warnings.push(`CGPA ${Number(x.cgpa).toFixed(2)} is in the lower half of the scale — receiving departments often ask for good standing.`);
  if (t.key === 'deferment' && String(x.level || '').match(/^1\d\d$/) && x.firstTerm) warnings.push('Deferring in your first term: your admission is kept, but some programmes re-assess entry requirements on return.');
  return { blockers, warnings };
}

/** The initial chain for a request. */
function initialSteps(type) { const t = typeof type === 'string' ? BY_KEY[type] : type; return (t ? t.workflow : ['registrar']).map(r => ({ role: r, office: OFFICES[r] || r, status: 'pending' })); }
function currentStep(req) { const st = parseSteps(req && req.steps); const i = st.findIndex(s => s.status === 'pending'); return i < 0 ? null : Object.assign({ index: i }, st[i]); }
function parseSteps(v) { if (Array.isArray(v)) return v; try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }

/**
 * Apply one decision to a request — PURE. decision: approve | reject | info (ask the student for more) | reply (the student answered) | complete (fulfilled) | withdraw.
 * Returns { status, steps, done } ('done' = the chain just approved → apply the effect).
 */
function advance(req, d) {
  const steps = parseSteps(req.steps).map(s => Object.assign({}, s));
  const at = d.at || new Date().toISOString(); const note = String(d.note || '').slice(0, 1000);
  const cur = steps.findIndex(s => s.status === 'pending');
  const status = req.status;
  if (d.decision === 'withdraw') { if (!OPEN.includes(status)) throw new Error('Only an open request can be withdrawn.'); return { status: 'withdrawn', steps, done: false }; }
  if (d.decision === 'reply') { if (status !== 'info_needed') throw new Error('No information was requested.'); return { status: 'in_review', steps, done: false }; }
  if (d.decision === 'complete') { if (status !== 'approved') throw new Error('Only an approved request can be marked completed.'); return { status: 'completed', steps, done: false }; }
  if (!OPEN.includes(status)) throw new Error('This request is already ' + (STATUS_LABEL[status] || status).toLowerCase() + '.');
  if (cur < 0) throw new Error('Nobody is left to decide on this request.');
  if (d.decision === 'info') { steps[cur] = Object.assign(steps[cur], { asked: note || 'Please give more information.', asked_at: at, asked_by: d.by || null }); return { status: 'info_needed', steps, done: false }; }
  if (d.decision === 'reject') { if (!note) throw new Error('Tell the student why the request is declined.'); steps[cur] = Object.assign(steps[cur], { status: 'rejected', by: d.by || null, by_name: d.byName || null, at, note }); return { status: 'rejected', steps, done: false }; }
  if (d.decision !== 'approve') throw new Error('Unknown decision.');
  steps[cur] = Object.assign(steps[cur], { status: 'approved', by: d.by || null, by_name: d.byName || null, at, note });
  const more = steps.some(s => s.status === 'pending');
  return { status: more ? 'in_review' : 'approved', steps, done: !more };
}

/**
 * May this officer decide the CURRENT step? actor={role, department_id, faculty_id, campus_id, _caps}; student={department_id, faculty_id, campus_id};
 * target = the receiving department ({id, faculty_id}) for target_hod. Super administrators and campus administrators (own campus) may act on any step.
 */
function canAct(actor, req, student, target) {
  const a = actor || {}; const cur = currentStep(req); if (!cur || !OPEN.includes(req.status) || req.status === 'info_needed') return false;
  const roles = [a.role].concat(Array.isArray(a._caps) ? a._caps : []);
  if (roles.includes('admin')) return true;
  if (roles.includes('campus_admin')) return !a.campus_id || !student || !student.campus_id || a.campus_id === student.campus_id;
  const s = student || {};
  switch (cur.role) {
    case 'hod': return roles.includes('hod') && !!a.department_id && a.department_id === s.department_id;
    case 'target_hod': return roles.includes('hod') && !!a.department_id && !!target && a.department_id === target.id;
    case 'dean': return roles.includes('dean') && !!a.faculty_id && a.faculty_id === s.faculty_id;
    default: return roles.includes(cur.role);
  }
}

/** A reference derived from the row id — the portal and every desktop can mint one without ever colliding. */
function refFor(id, year) { return `RQ-${year || new Date().getFullYear()}-${String(id || '').replace(/[^a-z0-9]/gi, '').slice(0, 7).toUpperCase() || '0000000'}`; }
function slaDue(createdIso, days) { const t = Date.parse(createdIso || ''); if (!Number.isFinite(t)) return null; return new Date(t + Math.max(1, Number(days) || 7) * 864e5).toISOString().slice(0, 10); }
function overdue(req, todayYmd) { return OPEN.includes(req.status) && !!req.sla_due && String(req.sla_due) < String(todayYmd || new Date().toISOString().slice(0, 10)); }

/** A deterministic summary for approvers (the AI summary, when available, is shown ABOVE this — never instead of it). */
function summarize(req, type, facts) {
  const t = typeof type === 'string' ? BY_KEY[type] : type; const f = typeof req.fields === 'string' ? safeJson(req.fields) : (req.fields || {});
  const bits = [];
  if (t) for (const d of t.fields) { const v = f[d.key]; if (v != null && String(v).trim()) bits.push(`${d.label.replace(/\?$/, '')}: ${d.type === 'department' && facts && facts.targetName ? facts.targetName : String(v).slice(0, 200)}`); }
  const x = facts || {};
  const ctx = [x.status ? 'status ' + x.status : '', x.cgpa != null ? 'CGPA ' + Number(x.cgpa).toFixed(2) : '', x.owingTxt ? 'owes ' + x.owingTxt : 'no balance owed'].filter(Boolean).join(' · ');
  return `${t ? t.name : req.type}. ${bits.join(' · ')}${ctx ? ' — Student: ' + ctx + '.' : ''}`;
}
function safeJson(s) { try { return JSON.parse(s || '{}') || {}; } catch (_) { return {}; } }

/** What the student sees as "what happens next". */
function nextFor(req) {
  const cur = currentStep(req);
  if (req.status === 'info_needed') return 'The office asked for more information — answer below.';
  if (req.status === 'approved') return req.effect === 'transcript' ? 'Approved — the Registry is preparing your transcript.' : 'Approved.';
  if (req.status === 'completed') return 'Completed.';
  if (req.status === 'rejected') return 'Declined.';
  if (req.status === 'withdrawn') return 'You withdrew this request.';
  return cur ? `Waiting for the ${cur.office}.` : 'Being processed.';
}

module.exports = { TYPES, OFFICES, FIELD_MAP, OPEN, STATUS_LABEL, catalog, typeOf, validate, precheck, initialSteps, currentStep, parseSteps, advance, canAct, refFor, slaDue, overdue, summarize, nextFor };
