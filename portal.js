'use strict';
/**
 * UniBursar Online Portal — served by the sync hub (server.js).
 *
 * Every account synced from the desktop app (officers, students, staff,
 * lecturers) can log in here from anywhere and see live data: students view
 * fees/payments/receipts, staff & lecturers view payslips, officers see their
 * reports. Data is read straight from the synced central store, so anything the
 * accountant (or any user) changes in the app appears here on the next sync.
 *
 * Pure Node — no dependencies. Mounted by server.js via createPortal().
 */
const crypto = require('crypto');
// pure-Node QR encoder (no npm deps — keeps the hub zero-dependency). Used to print a
// SCANNABLE verification QR on portal receipts & payslips.
let qrcode = null; try { qrcode = require('./qrcode'); } catch (_) { qrcode = null; }
function verifyQrSvg(targetUrl) {
  if (!qrcode || !targetUrl) return '';
  // force a fixed display size (viewBox keeps it crisp + scannable at any QR version)
  try { return qrcode.toSVG(targetUrl, { ec: 'M', cellSize: 3, margin: 1 }).replace(/width="\d+" height="\d+"/, 'width="104" height="104"'); } catch (_) { return ''; }
}

const SYM = { NGN: '₦', XOF: 'CFA', USD: '$', EUR: '€', GBP: '£', GHS: '₵', KES: 'KSh', ZAR: 'R', GMD: 'D', SLL: 'Le' };
function money(a, c) { const n = Number(a || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return `${SYM[c] || (c ? c + ' ' : '')}${n}`; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function fmtDate(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return '—'; } }

// pure-Node scrypt hash/verify (matches electron/services/portalcreds.js)
function hashPass(password) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(password), salt, 32);
  return `s2$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPass(password, stored) {
  try {
    const [tag, saltHex, hashHex] = String(stored || '').split('$');
    if (tag !== 's2' || !saltHex || !hashHex) return false;
    const h = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
    const a = Buffer.from(hashHex, 'hex');
    return a.length === h.length && crypto.timingSafeEqual(a, h);
  } catch (_) { return false; }
}

const WORDS_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const WORDS_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const WORD_CCY = { NGN: 'Naira', XOF: 'CFA Francs', USD: 'Dollars', EUR: 'Euros', GBP: 'Pounds', GHS: 'Cedis', KES: 'Shillings' };
function below(n) { let s = ''; if (n >= 100) { s += WORDS_ONES[Math.floor(n / 100)] + ' Hundred'; n %= 100; if (n) s += ' '; } if (n >= 20) { s += WORDS_TENS[Math.floor(n / 10)]; n %= 10; if (n) s += '-' + WORDS_ONES[n]; } else if (n > 0) s += WORDS_ONES[n]; return s; }
function numWords(num) { num = Math.floor(Number(num) || 0); if (num === 0) return 'Zero'; const scales = ['', ' Thousand', ' Million', ' Billion']; const parts = []; let i = 0; while (num > 0) { const c = num % 1000; if (c) parts.unshift(below(c) + scales[i]); num = Math.floor(num / 1000); i++; } return parts.join(' ').trim(); }
function amountWords(a, c) { const whole = Math.floor(Number(a) || 0); const k = Math.round((Number(a) - whole) * 100); let s = `${numWords(whole)} ${WORD_CCY[c] || c}`; if (k > 0) s += ` and ${numWords(k)}/100`; return s + ' only'; }

module.exports = function createPortal(deps) {
  const { all, one, getVersion, secret, institution, update } = deps;
  // the public base URL of THIS request (https://host) — used to print absolute,
  // scannable verification URLs in the QR on receipts/payslips. Set per request.
  let docBase = '';
  function buildBase(req) {
    try {
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket && req.socket.encrypted ? 'https' : 'http');
      const host = req.headers['x-forwarded-host'] || req.headers.host || '';
      return host ? `${proto}://${host}` : '';
    } catch (_) { return ''; }
  }
  // The session-token signing key. If no shared secret is configured we use a
  // strong RANDOM per-process key (never the old public default), so portal
  // tokens can never be forged. Set a SYNC_TOKEN to keep sessions across restarts.
  const KEY = (secret && String(secret).length >= 8) ? secret : crypto.randomBytes(32).toString('hex');
  if (!(secret && String(secret).length >= 8)) { try { console.warn('[UniBursar] No strong SYNC_TOKEN set — using a random session key (logins reset on restart). Set SYNC_TOKEN for persistent, secure sessions.'); } catch (_) {} }

  // ---- token (HMAC-signed, stateless) ----
  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
    return body + '.' + mac;
  }
  function verifyToken(tok) {
    try {
      const [body, mac] = String(tok || '').split('.');
      if (!body || !mac) return null;
      const exp = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
      if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (p.exp && Date.now() > p.exp) return null;
      return p;
    } catch (_) { return null; }
  }

  // ---- account resolution ----
  function findAccount(login) {
    const q = String(login || '').trim().toLowerCase();
    if (!q) return null;
    for (const u of all('users')) {
      if (u.is_active === 0) continue;
      if ([u.username, u.portal_username, u.email].some(v => (v || '').toLowerCase() === q)) return { kind: 'user', row: u, role: u.role };
    }
    for (const s of all('students')) {
      if ([s.portal_username, s.email, s.matric_no].some(v => (v || '').toLowerCase() === q)) return { kind: 'student', row: s, role: 'student' };
    }
    for (const s of all('students')) {
      if ([s.parent_portal_username, s.parent_email].some(v => (v || '').toLowerCase() === q)) return { kind: 'parent', row: s, role: 'parent' };
    }
    for (const s of all('staff')) {
      if (s.is_active === 0) continue;
      if ([s.portal_username, s.email, s.staff_no].some(v => (v || '').toLowerCase() === q)) return { kind: 'staff', row: s, role: s.staff_type === 'lecturer' ? 'lecturer' : 'staff' };
    }
    return null;
  }
  function accountById(kind, id) {
    const entity = kind === 'user' ? 'users' : (kind === 'student' || kind === 'parent') ? 'students' : 'staff';
    return one(entity, id);
  }
  function passField(kind, row) { return kind === 'parent' ? row.parent_portal_pass : row.portal_pass; }

  // ---- shared computations ----
  const nameOf = (entity, id) => { const r = id ? one(entity, id) : null; return r ? r.name : null; };
  function studentCharges(sid) { return all('charges').filter(c => c.student_id === sid); }
  function studentPaymentsCompleted(sid) { return all('payments').filter(p => p.student_id === sid && p.status === 'completed'); }
  function balancesFor(sid) {
    const bal = {};
    for (const c of studentCharges(sid)) bal[c.currency] = (bal[c.currency] || 0) + c.amount;
    for (const p of studentPaymentsCompleted(sid)) bal[p.currency] = (bal[p.currency] || 0) - p.amount;
    for (const k of Object.keys(bal)) if (Math.abs(bal[k]) < 0.001) delete bal[k];
    return bal;
  }
  // published per-course scores grouped by session+semester, with semester GPA + overall CGPA
  function scoresFor(sid) {
    const codeK = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const raw = all('student_scores').filter(r => r.student_id === sid && !r.deleted)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    // collapse duplicate course rows (same course in the same session+semester) — most recent wins
    const ddMap = {};
    for (const r of raw) ddMap[`${r.session_id || ''}|${r.semester_id || ''}|${codeK(r.course_code)}`] = r;
    const rows = Object.values(ddMap)
      .map(r => { const gp = Number(r.grade_point) || 0, cu = Number(r.credit_unit) || 0; return { course_code: r.course_code, course_title: r.course_title, credit_unit: cu, test_score: r.test_score, exam_score: r.exam_score, score: r.score, grade: r.grade, grade_point: gp, co: gp * cu, session_id: r.session_id, semester_id: r.semester_id, session: nameOf('academic_sessions', r.session_id), semester: nameOf('semesters', r.semester_id), date: r.created_at }; })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const gpaOf = (list) => { let qp = 0, u = 0; for (const s of list) { qp += s.grade_point * s.credit_unit; u += s.credit_unit; } return { gpa: u ? Math.round((qp / u) * 100) / 100 : 0, units: u }; };
    const groups = {};
    for (const r of rows) { const k = `${r.session_id || ''}|${r.semester_id || ''}`; (groups[k] = groups[k] || { session: r.session, semester: r.semester, session_id: r.session_id, semester_id: r.semester_id, list: [] }).list.push(r); }
    // chronological (ascending) so we can carry a running CGPA per semester
    const ordered = Object.values(groups).sort((a, b) => String((a.list[0] || {}).date).localeCompare(String((b.list[0] || {}).date)));
    let cumQp = 0, cumU = 0;
    const semesters = ordered.map(g => { const b = gpaOf(g.list); cumQp += g.list.reduce((x, c) => x + c.grade_point * c.credit_unit, 0); cumU += b.units; return { session: g.session, semester: g.semester, session_id: g.session_id, semester_id: g.semester_id, courses: g.list, ...b, cgpa: cumU ? Math.round((cumQp / cumU) * 100) / 100 : 0 }; });
    const overall = gpaOf(rows);
    return { courses: rows, semesters, cgpa: overall.gpa, totalUnits: overall.units };
  }
  const ROLE_OFFICE = { registrar: 'Office of the Registrar', accountant: 'Office of the Bursar', dean: 'Office of the Faculty Head', admin: 'Administration', student_affairs: 'Office of Student Affairs', hod: 'Office of the Head of Department' };
  // an HOD-issued receipt names the department; falls back to the plain office label
  const officeOf = (role, deptId) => role === 'hod' ? ('Office of the Head of Department' + (deptId && nameOf('departments', deptId) ? ' — ' + nameOf('departments', deptId) : '')) : (ROLE_OFFICE[role] || 'Office of the Bursar');

  function studentProfile(s) {
    return {
      id: s.id, full_name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), matric_no: s.matric_no,
      email: s.email, phone: s.phone, gender: s.gender, photo: s.photo, nationality: s.nationality,
      faculty: nameOf('faculties', s.faculty_id), department: nameOf('departments', s.department_id), level: nameOf('levels', s.level_id),
      status: s.status,
    };
  }

  function studentData(s) {
    const charges = studentCharges(s.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const pays = studentPaymentsCompleted(s.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const outstanding = {};
    // per category+currency
    const billed = {}; const paid = {};
    for (const c of charges) { const k = c.category + '|' + c.currency; billed[k] = (billed[k] || 0) + c.amount; }
    for (const p of pays) { const k = p.category + '|' + p.currency; paid[k] = (paid[k] || 0) + p.amount; }
    const owingRows = [];
    for (const k of Object.keys(billed)) {
      const [category, currency] = k.split('|'); const owed = billed[k] - (paid[k] || 0);
      if (owed > 0.001) owingRows.push({ category, currency, billed: billed[k], paid: paid[k] || 0, outstanding: owed });
    }
    const userName = (uid) => { const u = uid ? one('users', uid) : null; return u ? u.full_name : null; };
    // exam clearance status: full clearance, else active partial, else not cleared.
    // A student may hold BOTH a mid-semester and an examination clearance — list each
    // so the portal can offer a separate, correctly-labelled certificate per type.
    const clr = (() => {
      const completed = all('exam_clearances').filter(c => c.student_id === s.id && c.status === 'completed')
        .map(c => ({ id: c.id, type: c.clearance_type === 'midterm' ? 'midterm' : 'exam', typeName: c.clearance_type === 'midterm' ? 'Mid-Semester' : 'Examination' }));
      if (completed.length) {
        const exam = completed.find(c => c.type === 'exam') || completed[0];
        return { cleared: true, type: 'full', clearanceId: exam.id, certs: completed };
      }
      const partial = all('partial_clearances').find(p => p.student_id === s.id && p.status === 'active');
      if (partial) return { cleared: true, type: 'partial', reason: partial.reason, certs: [] };
      const owes = Object.values(balancesFor(s.id)).some(v => v > 0.001);
      return { cleared: false, type: null, reason: owes ? 'Outstanding fees not cleared' : 'No examination clearance issued', certs: [] };
    })();
    const validations = all('exam_validations').filter(v => v.student_id === s.id)
      .map(v => ({ status: v.status, reason: v.reason, exam_type: v.exam_type, date: v.created_at, session: nameOf('academic_sessions', v.session_id), semester: nameOf('semesters', v.semester_id) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const i = inst();
    // segment by office so the student sees exactly who they owe (and who collected)
    const roleOf = (uid) => { const u = uid ? one('users', uid) : null; return u ? u.role : null; };
    const offices = {};
    const bucket = (role) => { const k = role || 'accountant'; offices[k] = offices[k] || { role: k, office: officeOf(k, s.department_id), charged: {}, paid: {}, owing: {} }; return offices[k]; };
    for (const c of charges) { const b = bucket(roleOf(c.created_by) || 'accountant'); b.charged[c.currency] = (b.charged[c.currency] || 0) + c.amount; }
    for (const pmt of pays) { const b = bucket(pmt.raised_role || 'accountant'); b.paid[pmt.currency] = (b.paid[pmt.currency] || 0) + pmt.amount; }
    for (const k of Object.keys(offices)) { const o = offices[k]; for (const cur of new Set([...Object.keys(o.charged), ...Object.keys(o.paid)])) { const owe = (o.charged[cur] || 0) - (o.paid[cur] || 0); if (owe > 0.001) o.owing[cur] = owe; } }
    return {
      profile: studentProfile(s),
      byOffice: Object.values(offices),
      currentSession: i.session || nameOf('academic_sessions', s.current_session_id) || '',
      currentSemester: i.semester || '',
      balances: balancesFor(s.id),
      examClearance: clr,
      validations,
      results: all('results').filter(r => r.student_id === s.id).map(r => ({ id: r.id, title: r.title, level: nameOf('levels', r.level_id), semester: nameOf('semesters', r.semester_id), session: nameOf('academic_sessions', r.session_id), gpa: r.gpa, remark: r.remark, mime: r.mime, date: r.created_at })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      scores: scoresFor(s.id),
      documents: all('portal_documents').filter(d => (!d.faculty_id || d.faculty_id === s.faculty_id) && (!d.department_id || d.department_id === s.department_id) && (!d.level_id || d.level_id === s.level_id))
        .map(d => ({ id: d.id, title: d.title, category: d.category, office: d.office, by: userName(d.uploaded_by), mime: d.mime, date: d.created_at })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      misconduct: all('misconducts').filter(m => m.student_id === s.id && !m.deleted).map(m => ({ offense: m.offense, severity: m.severity, action: m.action, fine: m.penalty_amount || 0, currency: m.currency, status: m.status, date: m.occurred_at || m.created_at, note: m.resolution_note || m.description || '' })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      charges: charges.map(c => ({ id: c.id, category: c.category, description: c.description, currency: c.currency, amount: c.amount, date: c.created_at, by: userName(c.created_by), rollover: !!c.is_rolled_over, rolled_from: nameOf('academic_sessions', c.rolled_from_session) })),
      payments: pays.map(p => ({ id: p.id, receipt_no: p.receipt_no, category: p.category, currency: p.currency, amount: p.amount, method: p.method, date: p.decided_at || p.created_at, office: officeOf(p.raised_role, s.department_id), collector: userName(p.decided_by || p.raised_by) })),
      outstanding: owingRows,
    };
  }

  function staffProfile(s) {
    return {
      id: s.id, full_name: s.full_name, staff_no: s.staff_no, type: s.staff_type === 'lecturer' ? 'Lecturer' : 'Staff',
      title: s.title, position: s.position, department: s.department, faculty: s.faculty, qualification: s.qualification,
      email: s.email, phone: s.phone, photo: s.photo, bank_name: s.bank_name, bank_account: s.bank_account,
      base_salary: s.base_salary, currency: s.currency, date_employed: s.date_employed,
    };
  }
  function staffData(s) {
    const slips = all('payslips').filter(p => p.staff_id === s.id).map(p => {
      const run = one('payroll_runs', p.run_id) || {};
      return { id: p.id, period: run.period, status: run.status, run_type: run.run_type, gross: p.gross, allowances: p.allowances, bonus: p.bonus, deductions: p.deductions, loan_deduction: p.loan_deduction, net: p.net, currency: p.currency };
    }).sort((a, b) => String(b.period).localeCompare(String(a.period)));
    return { profile: staffProfile(s), payslips: slips };
  }

  // Build a period filter from query params: basis = day|week|month|semester|session|all
  function parsePeriod(sp) {
    const basis = sp.get('basis') || (sp.get('session') || sp.get('semester') ? 'session' : 'all');
    return { basis, day: sp.get('day') || '', weekStart: sp.get('weekStart') || '', month: sp.get('month') || '', session: sp.get('session') || '', semester: sp.get('semester') || '', office: sp.get('office') || '' };
  }
  function periodLabel(period) {
    if (!period) return 'All time';
    switch (period.basis) {
      case 'day': return period.day ? 'On ' + period.day : 'Daily';
      case 'week': return period.weekStart ? 'Week of ' + period.weekStart : 'Weekly';
      case 'month': return period.month ? 'Month of ' + period.month : 'Monthly';
      case 'semester': return (period.session ? (nameOf('academic_sessions', period.session) || 'session') : 'All sessions') + ' · ' + (period.semester ? (nameOf('semesters', period.semester) || 'semester') : 'All semesters');
      case 'session': return period.session ? (nameOf('academic_sessions', period.session) || 'Session') : 'All sessions';
      default: return 'All time';
    }
  }

  function officerData(u, period) {
    const role = u.role;
    const dstr = (r) => String(r.decided_at || r.created_at || '');
    const inP = (r) => {
      if (!period || !period.basis || period.basis === 'all') return true;
      if (period.basis === 'day') return !period.day || dstr(r).slice(0, 10) === period.day;
      if (period.basis === 'week') { if (!period.weekStart) return true; const e = new Date(period.weekStart + 'T00:00:00'); e.setDate(e.getDate() + 7); const end = e.toISOString().slice(0, 10); const d = dstr(r).slice(0, 10); return d >= period.weekStart && d < end; }
      if (period.basis === 'month') return !period.month || dstr(r).slice(0, 7) === period.month;
      // session / semester
      return (!period.session || (r.session_id || '') === period.session) && (!period.semester || (r.semester_id || '') === period.semester);
    };
    const completed = all('payments').filter(p => p.status === 'completed' && inP(p));
    const out = {
      profile: { id: u.id, full_name: u.full_name, role, email: u.email, photo: u.photo || '' },
      periods: { sessions: all('academic_sessions').map(s => ({ id: s.id, name: s.name })), semesters: all('semesters').map(s => ({ id: s.id, name: s.name, session_id: s.session_id })) },
      period: period || {},
    };
    if (role === 'accountant' || role === 'admin') {
      const collected = {}; const billed = {}; const expenses = {};
      for (const p of completed) collected[p.currency] = (collected[p.currency] || 0) + p.amount;
      for (const c of all('charges').filter(inP)) billed[c.currency] = (billed[c.currency] || 0) + c.amount;
      for (const e of all('expenses').filter(inP)) expenses[e.currency] = (expenses[e.currency] || 0) + e.amount;
      const students = all('students').filter(s => s.status !== 'alumni');
      let debtors = 0; for (const s of students) if (Object.values(balancesFor(s.id)).some(v => v > 0.001)) debtors++;
      out.kind = 'finance';
      out.canPickOffice = true;
      out.cards = { collected, billed, expenses, students: students.length, debtors };
      const OFFICE_LABEL = { accountant: 'Bursary / Accountant', registrar: 'Registrar', dean: 'Faculty Head (Dean)', student_affairs: 'Student Affairs', admin: 'Administration' };
      const userName = (id) => { const x = id ? one('users', id) : null; return x ? x.full_name : '—'; };
      // collections grouped by the office that collected them
      const byOffice = {};
      for (const p of completed) { const r = p.raised_role || 'accountant'; byOffice[r] = byOffice[r] || {}; byOffice[r][p.currency] = (byOffice[r][p.currency] || 0) + p.amount; }
      out.byOffice = Object.entries(byOffice).map(([r, m]) => ({ role: r, office: OFFICE_LABEL[r] || r, amounts: m })).sort((a, b) => a.office.localeCompare(b.office));
      // optional office filter (the accountant picks an office to drill into)
      const off = period && period.office;
      const filtered = off ? completed.filter(p => (p.raised_role || 'accountant') === off) : completed;
      out.officeFilter = off || '';
      out.recent = filtered.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 60)
        .map(p => ({ receipt_no: p.receipt_no, student: studentName(p.student_id), category: p.category, amount: p.amount, currency: p.currency, office: OFFICE_LABEL[p.raised_role || 'accountant'] || '—', by: userName(p.decided_by || p.raised_by), date: p.decided_at || p.created_at }));
      // expenses — ALL offices, with who recorded them
      const expRows = all('expenses').filter(inP);
      const expByOffice = {};
      for (const e of expRows) { const r = (one('users', e.recorded_by) || {}).role || 'accountant'; expByOffice[r] = expByOffice[r] || {}; expByOffice[r][e.currency] = (expByOffice[r][e.currency] || 0) + e.amount; }
      out.expensesByOffice = Object.entries(expByOffice).map(([r, m]) => ({ office: OFFICE_LABEL[r] || r, amounts: m }));
      out.expensesList = expRows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 60)
        .map(e => ({ category: e.category, description: e.description, amount: e.amount, currency: e.currency, by: userName(e.recorded_by), date: e.created_at }));
    } else if (role === 'registrar' || role === 'student_affairs') {
      out.kind = 'registrar';
      out.collected = {};
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) { out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount; }
      const ids = [...new Set(all('charges').filter(c => c.created_by === u.id && inP(c)).map(c => c.student_id))];
      out.students = ids.map(sid => billedSummary(sid, u.id)).filter(Boolean);
    } else if (role === 'dean') {
      out.kind = 'dean'; out.collected = {}; out.expenses = {};
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount;
      for (const e of all('expenses').filter(e => e.recorded_by === u.id && inP(e))) out.expenses[e.currency] = (out.expenses[e.currency] || 0) + e.amount;
      const inFac = all('students').filter(s => s.faculty_id === u.faculty_id && s.status !== 'alumni');
      out.debtors = [];
      for (const s of inFac) {
        const bal = {};
        for (const c of studentCharges(s.id)) if (['faculty_due', 'custom'].includes(c.category)) bal[c.currency] = (bal[c.currency] || 0) + c.amount;
        for (const p of studentPaymentsCompleted(s.id)) if (['faculty_due', 'custom'].includes(p.category)) bal[p.currency] = (bal[p.currency] || 0) - p.amount;
        const owing = {}; for (const k of Object.keys(bal)) if (bal[k] > 0.001) owing[k] = bal[k];
        if (Object.keys(owing).length) out.debtors.push({ full_name: studentName(s.id), matric_no: s.matric_no, department: nameOf('departments', s.department_id), owing });
      }
    } else if (role === 'hod') {
      // a Head of Department's portal view mirrors the dean's, scoped to ONE department
      out.kind = 'dean'; out.collected = {}; out.expenses = {}; out.scopeLabel = 'Department: ' + (nameOf('departments', u.department_id) || '—');
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount;
      for (const e of all('expenses').filter(e => e.recorded_by === u.id && inP(e))) out.expenses[e.currency] = (out.expenses[e.currency] || 0) + e.amount;
      const inDept = all('students').filter(s => s.department_id === u.department_id && s.status !== 'alumni');
      out.debtors = [];
      for (const s of inDept) {
        const bal = {};
        for (const c of studentCharges(s.id)) if (['faculty_due', 'custom'].includes(c.category)) bal[c.currency] = (bal[c.currency] || 0) + c.amount;
        for (const p of studentPaymentsCompleted(s.id)) if (['faculty_due', 'custom'].includes(p.category)) bal[p.currency] = (bal[p.currency] || 0) - p.amount;
        const owing = {}; for (const k of Object.keys(bal)) if (bal[k] > 0.001) owing[k] = bal[k];
        if (Object.keys(owing).length) out.debtors.push({ full_name: studentName(s.id), matric_no: s.matric_no, department: nameOf('departments', s.department_id), owing });
      }
    } else { // student_affairs (no collections role) — clearance + discipline summary
      out.kind = 'affairs';
      const aps = all('clearance_approvals').filter(a => a.office === 'student_affairs');
      out.clearance = { pending: aps.filter(a => a.status === 'pending').length, approved: aps.filter(a => a.status === 'approved').length, denied: aps.filter(a => a.status === 'denied').length };
      const mc = all('misconducts');
      out.misconduct = { total: mc.length, open: mc.filter(m => m.status === 'open').length, resolved: mc.filter(m => m.status === 'resolved').length };
    }
    return out;
  }
  function studentName(sid) { const s = one('students', sid); return s ? `${s.first_name || ''} ${s.last_name || ''}`.trim() : '—'; }
  function billedSummary(sid, uid) {
    const s = one('students', sid); if (!s) return null;
    const billed = {}; const paid = {}; const owing = {};
    for (const c of studentCharges(sid)) if (c.created_by === uid) billed[c.currency] = (billed[c.currency] || 0) + c.amount;
    for (const p of studentPaymentsCompleted(sid)) if (p.raised_by === uid || p.decided_by === uid) paid[p.currency] = (paid[p.currency] || 0) + p.amount;
    for (const k of new Set([...Object.keys(billed), ...Object.keys(paid)])) { const o = (billed[k] || 0) - (paid[k] || 0); if (o > 0.001) owing[k] = o; }
    return { full_name: studentName(sid), matric_no: s.matric_no, department: nameOf('departments', s.department_id), paid, owing };
  }

  // ---- clearance verification (public; staff scan the QR to confirm a student) ----
  function verifyClearance(idOrRef) {
    const key = String(idOrRef || '').trim();
    if (!key) return { valid: false };
    let c = one('exam_clearances', key);
    if (!c) { // accept a short ref (first hex chars of the id)
      const want = key.replace(/-/g, '').toLowerCase();
      if (want.length >= 6 && want.length <= 16) c = all('exam_clearances').find(x => String(x.id).replace(/-/g, '').toLowerCase().startsWith(want));
    }
    if (!c) return { valid: false };
    const s = one('students', c.student_id) || {};
    const approvals = all('clearance_approvals').filter(a => a.clearance_id === c.id)
      .map(a => ({ office: a.office, status: a.status, by: a.approver_id ? ((one('users', a.approver_id) || {}).full_name || null) : null, date: a.decided_at }));
    const isMid = c.clearance_type === 'midterm';
    return {
      valid: true, completed: c.status === 'completed', status: c.status,
      clearanceType: isMid ? 'midterm' : 'exam', typeName: isMid ? 'Mid-Semester' : 'Examination',
      ref: String(c.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      student: {
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown', matric: s.matric_no || '—', gender: s.gender || '—',
        photo: s.photo || '', faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—',
        level: nameOf('levels', s.level_id) || '—', status: s.status || '—',
      },
      session: nameOf('academic_sessions', c.session_id) || '—', semester: nameOf('semesters', c.semester_id) || '—',
      approvals, issued: c.created_at,
    };
  }

  // Public receipt authenticity check (no login). Resolves a payment by id, short
  // id-ref, OR its printed receipt number, and returns the genuine details so anyone
  // can confirm a receipt presented to them isn't forged or altered.
  function verifyReceipt(idOrRef) {
    const key = String(idOrRef || '').trim();
    if (!key) return { valid: false };
    let p = one('payments', key);
    if (!p) {
      const want = key.replace(/-/g, '').toLowerCase();
      if (want.length >= 6 && want.length <= 16) p = all('payments').find(x => String(x.id).replace(/-/g, '').toLowerCase().startsWith(want));
      if (!p) p = all('payments').find(x => String(x.receipt_no || '').toLowerCase() === key.toLowerCase());
    }
    if (!p || p.deleted || p.status !== 'completed') return { valid: false };
    const s = one('students', p.student_id) || {};
    const office = ROLE_OFFICE[p.raised_role] || 'Office of the Bursar';
    const receivedBy = (one('users', p.decided_by) || one('users', p.raised_by) || {}).full_name || office;
    const catRow = all('fee_categories').find(c => c.key === p.category && !c.deleted);
    const feeLabel = (catRow && catRow.name) || (p.category ? p.category[0].toUpperCase() + p.category.slice(1).replace(/_/g, ' ') + ' Fee' : '—');
    return {
      valid: true, kind: 'receipt',
      ref: String(p.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      receipt_no: p.receipt_no || '—',
      amountText: money(p.amount, p.currency),
      category: feeLabel, narration: p.narration || '',
      method: String(p.channel || p.method || 'cash').toUpperCase(),
      dateText: fmtDate(p.decided_at || p.created_at), office, receivedBy,
      student: {
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown',
        matric: s.matric_no || '—', photo: s.photo || '',
        faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—',
      },
    };
  }

  // Public payslip authenticity check (no login) — confirms a payslip presented to a
  // bank/landlord is genuine: who it's for, the period, and the NET pay.
  function verifyPayslip(idOrRef) {
    const key = String(idOrRef || '').trim();
    if (!key) return { valid: false };
    let ps = one('payslips', key);
    if (!ps) { const want = key.replace(/-/g, '').toLowerCase(); if (want.length >= 6 && want.length <= 16) ps = all('payslips').find(x => String(x.id).replace(/-/g, '').toLowerCase().startsWith(want)); }
    if (!ps || ps.deleted) return { valid: false };
    const st = one('staff', ps.staff_id) || {};
    const run = one('payroll_runs', ps.run_id) || {};
    const cur = ps.currency || st.currency;
    const isLect = st.staff_type === 'lecturer';
    return {
      valid: true, kind: 'payslip',
      ref: String(ps.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      staffType: isLect ? 'Lecturer' : 'Staff',
      net: money(ps.net, cur), gross: money(ps.gross, cur),
      period: run.period || '—', dateText: fmtDate(run.updated_at || run.created_at),
      staff: { name: st.full_name || 'Unknown', staffNo: st.staff_no || '—', photo: st.photo || '', department: st.department || st.faculty || '—' },
    };
  }

  // Public result authenticity check (no login) — confirms a statement of result is genuine:
  // the student, level and the GPA/CGPA. Key is the student id, optionally "id|session|semester".
  function verifyResult(idOrRef) {
    let key = String(idOrRef || '').trim(); let ses = '', sem = '';
    if (key.indexOf('|') >= 0) { const a = key.split('|'); key = a[0]; ses = a[1] || ''; sem = a[2] || ''; }
    const s = one('students', key);
    if (!s || s.deleted) return { valid: false };
    const sc = scoresFor(s.id);
    if (!sc.courses || !sc.courses.length) return { valid: false };
    let gpa = sc.cgpa, cgpa = sc.cgpa, units = sc.totalUnits, courses = sc.courses.length, sesName = '', semName = '';
    if (ses || sem) { const g = (sc.semesters || []).find(x => (!ses || x.session_id === ses) && (!sem || x.semester_id === sem)); if (g) { gpa = g.gpa; cgpa = g.cgpa; units = g.units; courses = g.courses.length; sesName = g.session || ''; semName = g.semester || ''; } }
    const stand = (x) => { x = Number(x) || 0; return x >= 4.5 ? 'First Class' : x >= 3.5 ? 'Second Class (Upper)' : x >= 2.4 ? 'Second Class (Lower)' : x >= 1.5 ? 'Third Class' : x >= 1 ? 'Pass' : '—'; };
    return {
      valid: true, kind: 'result', ref: String(s.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      session: sesName, semester: semName, gpa: gpa, cgpa: cgpa, totalUnits: units, courses: courses, standing: stand(cgpa),
      student: { name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown', matric: s.matric_no || '—', photo: s.photo || '', faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—', level: nameOf('levels', s.level_id) || '—', gender: s.gender || '—', status: s.status || 'active' },
    };
  }

  // ---- documents (printable HTML) ----
  function inst() { return institution ? institution() : { name: 'UniBursar', short: 'UBU', logo: '', motto: '' }; }
  function docShell(title, body, watermark, opts) {
    const i = inst();
    const fit = opts && opts.fit ? 'true' : 'false';
    const wm = watermark ? `<div class="wm"><span>${esc(watermark)}</span></div>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;margin:0;padding:24px;font-size:13px;background:#f1f5f9;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .sheet{position:relative;overflow:hidden;max-width:820px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:26px;box-shadow:0 8px 30px rgba(15,23,42,.08)}
    .wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:6}
    .wm span{font-size:62px;font-weight:900;color:rgba(30,58,138,.12);transform:rotate(-28deg);letter-spacing:9px;white-space:nowrap;border:7px solid rgba(30,58,138,.12);padding:12px 34px;border-radius:14px}
    .head{display:flex;align-items:center;gap:12px;border-bottom:3px solid #1e3a8a;padding-bottom:14px;margin-bottom:18px}
    .head .logo{width:50px;height:50px;object-fit:contain;border-radius:8px}
    .head .mono{width:50px;height:50px;border-radius:10px;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800}
    .head h1{margin:0;font-size:18px;color:#111827}.head .t{margin-left:auto;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#1e3a8a}
    table{width:100%;border-collapse:collapse;margin:10px 0}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef2f7}
    th{background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#64748b}
    .r{text-align:right}.bar{background:#1e3a8a;color:#fff;padding:6px 12px;border-radius:6px;font-weight:700;text-transform:uppercase;font-size:11px;margin:16px 0 6px}
    .tot{font-size:16px;font-weight:800;color:#065f46;text-align:right;margin-top:6px}.words{font-style:italic;font-weight:700}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px}.grid .f span{color:#64748b;font-size:11px;display:block}.grid .f b{font-size:13px}
    .pbar{margin:16px 0;text-align:center}.pbar button{background:#1e3a8a;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer}
    @media print{.pbar{display:none}body{background:#fff;padding:0}.sheet{box-shadow:none;border:0}}
    .neg{color:#b91c1c}.pos{color:#065f46}.photo{width:84px;height:96px;object-fit:cover;border:1.5px solid #1e3a8a;border-radius:6px;float:right}</style></head>
    <body><div class="pbar"><button onclick="window.print()">⬇️ Download PDF / Print</button></div>
    <div class="sheet">${wm}<div class="head">${i.logo ? `<img class="logo" src="${i.logo}">` : `<div class="mono">${esc((i.short || 'U').slice(0, 3))}</div>`}<h1>${esc(i.name)}</h1><div class="t">${esc(title)}</div></div>${body}</div>
    <script>(function(){var FIT=${fit};function fit(){if(!FIT)return;var sh=document.querySelector('.sheet');if(!sh)return;sh.style.zoom='';var maxH=1040;var hgt=sh.scrollHeight;if(hgt>maxH){sh.style.zoom=Math.max(0.35,(maxH/hgt));}}var done=false;function go(){if(done)return;done=true;fit();try{window.focus();window.print();}catch(e){}}window.addEventListener('load',function(){setTimeout(go,450);});window.addEventListener('beforeprint',fit);window.addEventListener('resize',fit);})();</script>
    </body></html>`;
  }

  function receiptHTML(p) {
    const s = one('students', p.student_id) || {};
    const cur = p.currency;
    const issuer = one('users', p.decided_by) || one('users', p.raised_by) || {};
    // issuing office = who COMPLETED it (decided_by) — a registrar-raised, accountant-verified
    // payment is issued by the Bursar, not the registrar.
    const office = officeOf(issuer.role || p.raised_role, issuer.department_id || s.department_id);
    const receivedBy = issuer.full_name || office;
    // the line DESCRIPTION is the FEE paid for (category), NOT the narration
    const catRow = all('fee_categories').find(c => c.key === p.category && !c.deleted);
    const feeLabel = (catRow && catRow.name) || (p.category ? p.category[0].toUpperCase() + p.category.slice(1).replace(/_/g, ' ') + ' Fee' : 'Fee');
    // scannable verification QR → opens this hub's /verify page (same as the desktop receipt)
    const verifyUrl = (docBase ? docBase : '') + '/verify?r=' + p.id;
    const qrSvg = verifyQrSvg(verifyUrl);
    // SCOPE to the issuing office (mirrors the desktop): admin/accountant = full account;
    // any other office's receipt reflects only that office's fees/collections.
    const officeRole = ['admin', 'accountant'].includes(p.raised_role) ? null : p.raised_role;
    const officeUsers = officeRole ? new Set(all('users').filter(u => u.role === officeRole).map(u => u.id)) : null;
    const myCharge = (c) => !officeUsers || officeUsers.has(c.created_by);
    const myPay = (x) => !officeRole || x.raised_role === officeRole || (officeUsers && (officeUsers.has(x.raised_by) || officeUsers.has(x.decided_by)));
    const billedCat = studentCharges(p.student_id).filter(c => c.category === p.category && c.currency === cur && myCharge(c)).reduce((a, c) => a + c.amount, 0);
    const paidCat = studentPaymentsCompleted(p.student_id).filter(x => x.category === p.category && x.currency === cur && myPay(x)).reduce((a, x) => a + x.amount, 0);
    const lineRate = billedCat > 0 ? billedCat : p.amount;
    const chargesCur = studentCharges(p.student_id).filter(c => c.currency === cur && myCharge(c)).reduce((a, c) => a + c.amount, 0);
    const paidCur = studentPaymentsCompleted(p.student_id).filter(x => x.currency === cur && myPay(x)).reduce((a, x) => a + x.amount, 0);
    const newBal = chargesCur - paidCur; const prevBal = newBal + p.amount;
    const f = (l1, v1, l2, v2) => `<tr><td style="color:#64748b">${l1}</td><td><b>${esc(v1 || '—')}</b></td><td style="color:#64748b">${l2}</td><td><b>${esc(v2 || '—')}</b></td></tr>`;
    const body = `${s.photo ? `<img class="photo" src="${s.photo}">` : ''}
      <div class="grid" style="margin-bottom:8px"><div class="f"><span>Receipt No</span><b>${esc(p.receipt_no || '—')}</b></div><div class="f"><span>Issued By</span><b>${esc(office)}</b></div>
        <div class="f"><span>Date</span><b>${fmtDate(p.decided_at || p.created_at)}</b></div><div class="f"><span>Method</span><b>${esc(String(p.channel || p.method || 'cash').toUpperCase())}</b></div></div>
      <div class="bar">Student Details</div>
      <table><tbody>
        ${f("Student", `${s.first_name || ''} ${s.last_name || ''}`, 'Matric No', s.matric_no)}
        ${f('Faculty', nameOf('faculties', s.faculty_id), 'Department', nameOf('departments', s.department_id))}
        ${f('Level', nameOf('levels', s.level_id), 'Received By', receivedBy)}
      </tbody></table>
      <div class="bar">Payment Details</div>
      <table><tbody>${f('Narration', p.narration || '—', 'Currency', cur)}</tbody></table>
      <div class="bar">Payment Breakdown</div>
      <table><thead><tr><th>Description</th><th class="r">Amount (${esc(cur)})</th><th class="r">Paid Now</th><th class="r">Balance After</th></tr></thead>
        <tbody><tr><td>${esc(feeLabel)}</td><td class="r">${money(lineRate, cur)}</td><td class="r"><b>${money(p.amount, cur)}</b></td><td class="r">${money(lineRate - paidCat, cur)}</td></tr></tbody></table>
      <div class="tot">TOTAL PAID: ${money(p.amount, cur)}</div>
      <div class="bar">Payment Summary</div>
      <table><tbody>
        <tr><td style="color:#64748b">Amount In Words</td><td class="words" colspan="3">${esc(amountWords(p.amount, cur))}</td></tr>
        ${f('Previous Net Balance', money(prevBal, cur), 'New Net Balance', money(newBal, cur))}
      </tbody></table>
      <div class="bar">Authenticity</div>
      <div style="display:flex;align-items:center;gap:14px;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 14px;margin-top:8px">
        ${qrSvg ? `<div style="width:104px;height:104px;flex:none">${qrSvg}</div>` : ''}
        <div style="font-size:11.5px;color:#475569;line-height:1.5">Scan to verify this receipt is genuine.<br>Verification ref <b style="letter-spacing:1px;color:#111827">${esc(String(p.id).replace(/-/g, '').slice(0, 8).toUpperCase())}</b><br>or visit <a href="${esc(verifyUrl)}">${esc((docBase || '') + '/verify')}</a></div>
      </div>
      <p style="margin-top:18px;color:#64748b;font-size:11px">Received by ${esc(receivedBy)} (${esc(office)}) • Student copy of a computer-generated receipt; it mirrors the official receipt issued in the office. Anyone can confirm it is genuine by scanning the QR above.</p>`;
    return docShell('Payment Receipt', body, 'STUDENT COPY');
  }

  function statementHTML(s) {
    const charges = studentCharges(s.id).map(c => ({ kind: 'charge', date: c.created_at, desc: c.description || c.category, currency: c.currency, debit: c.amount < 0 ? 0 : c.amount, credit: c.amount < 0 ? -c.amount : 0 }));
    const pays = studentPaymentsCompleted(s.id).map(p => ({ kind: 'payment', date: p.decided_at || p.created_at, desc: (p.description || p.category) + (p.receipt_no ? ` (${p.receipt_no})` : ''), currency: p.currency, debit: 0, credit: p.amount }));
    const entries = [...charges, ...pays].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const running = {}; const rows = entries.map(e => { running[e.currency] = (running[e.currency] || 0) + (e.debit - e.credit); return `<tr><td>${fmtDate(e.date)}</td><td>${e.kind === 'payment' ? '💰 ' : '📌 '}${esc(e.desc)}</td><td class="r">${e.debit ? money(e.debit, e.currency) : ''}</td><td class="r">${e.credit ? money(e.credit, e.currency) : ''}</td><td class="r ${running[e.currency] > 0 ? 'neg' : 'pos'}">${money(running[e.currency], e.currency)}</td></tr>`; }).join('');
    const bal = balancesFor(s.id); const balStr = Object.keys(bal).length ? Object.entries(bal).map(([c, v]) => money(v, c)).join(' • ') : money(0);
    const body = `<div class="grid" style="margin-bottom:8px"><div class="f"><span>Student</span><b>${esc(`${s.first_name || ''} ${s.last_name || ''}`)}</b></div><div class="f"><span>Matric</span><b>${esc(s.matric_no || '—')}</b></div>
      <div class="f"><span>Department</span><b>${esc(nameOf('departments', s.department_id) || '—')}</b></div><div class="f"><span>Outstanding</span><b class="neg">${balStr}</b></div></div>
      <div class="bar">Full Statement — All Fees & Payments</div>
      <table><thead><tr><th>Date</th><th>Description</th><th class="r">Debit (Fee)</th><th class="r">Credit (Paid)</th><th class="r">Balance</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No ledger entries.</td></tr>'}</tbody></table>`;
    return docShell('Student Financial Statement', body);
  }

  // Student statement of result (PDF via the browser print dialog) — mirrors the desktop slip.
  function resultSlipHTML(s, filter) {
    const sc = scoresFor(s.id);
    let sems = sc.semesters || [];
    let focused = null;
    if (filter && (filter.session || filter.semester)) {
      focused = sems.find(g => (!filter.session || g.session_id === filter.session) && (!filter.semester || g.semester_id === filter.semester));
      if (focused) sems = [focused];
    }
    const stand = (g) => { const x = Number(g) || 0; return x >= 4.5 ? 'First Class' : x >= 3.5 ? 'Second Class (Upper)' : x >= 2.4 ? 'Second Class (Lower)' : x >= 1.5 ? 'Third Class' : x >= 1 ? 'Pass' : '—'; };
    const cgpa = focused ? focused.cgpa : sc.cgpa;
    const photo = s.photo ? `<img class="photo" src="${s.photo}">` : '';
    const infoRows = [
      ['Matric Number', s.matric_no || '—'],
      ['Full Name', `${s.first_name || ''} ${s.last_name || ''}`.trim()],
      ['Faculty', nameOf('faculties', s.faculty_id) || '—'],
      ['Department', nameOf('departments', s.department_id) || '—'],
      ['Level', nameOf('levels', s.level_id) || '—'],
      ['Gender', s.gender || '—'],
    ];
    if (focused) { infoRows.push(['Session / Semester', `${focused.session || '—'} · ${focused.semester || '—'}`]); }
    // GPA / CGPA / Class Standing are shown at the BOTTOM of the sheet, not here.
    const infoTable = `<table class="info"><tbody>${infoRows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</tbody></table>`;
    const semBlocks = sems.map(g => {
      return `<div class="bar">${esc(g.semester || 'Semester')} · ${esc(g.session || '—')} &nbsp;—&nbsp; GPA ${esc(g.gpa)} · CGPA ${esc(g.cgpa)} · ${esc(g.units)} units</div>
        <table class="ctbl"><thead><tr><th class="c">#</th><th>CODE</th><th>COURSE TITLE</th><th class="c">CH</th><th class="c">TEST</th><th class="c">EXAM</th><th class="c">SCORE</th><th class="c">GRD</th><th class="c">CO</th></tr></thead><tbody>${(g.courses || []).map((r, i) => `<tr><td class="c">${i + 1}</td><td class="mono">${esc(r.course_code || '—')}</td><td>${esc(r.course_title || '—')}</td><td class="c">${esc(r.credit_unit)}</td><td class="c">${r.test_score == null ? '–' : esc(r.test_score)}</td><td class="c">${r.exam_score == null ? '–' : esc(r.exam_score)}</td><td class="c"><b>${r.score == null ? '–' : esc(r.score)}</b></td><td class="c"><b>${esc(r.grade || '–')}</b></td><td class="c">${r.co == null ? '–' : esc(r.co)}</td></tr>`).join('') || '<tr><td colspan="9" class="c" style="color:#94a3b8">No courses</td></tr>'}</tbody></table>`;
    }).join('') || '<p style="color:#94a3b8">No published results yet.</p>';
    // verification QR → public /verify page (no login) showing the student + GPA/CGPA
    const vurl = (docBase || '') + '/verify?res=' + s.id + (focused ? ('&ses=' + (focused.session_id || '') + '&sem=' + (focused.semester_id || '')) : '');
    const qr = verifyQrSvg(vurl);
    const ref = String(s.id).replace(/-/g, '').slice(0, 8).toUpperCase();
    const legend = `<table class="gtbl"><thead><tr><th colspan="3">GRADING SYSTEM</th></tr></thead><tbody>
      <tr><td>70–100</td><td class="c"><b>A</b></td><td class="c">5</td></tr><tr><td>60–69</td><td class="c"><b>B</b></td><td class="c">4</td></tr><tr><td>50–59</td><td class="c"><b>C</b></td><td class="c">3</td></tr>
      <tr><td>45–49</td><td class="c"><b>D</b></td><td class="c">2</td></tr><tr><td>40–44</td><td class="c"><b>E</b></td><td class="c">1</td></tr><tr><td>0–39</td><td class="c"><b>F</b></td><td class="c">0</td></tr></tbody></table>
      <div class="note">CH = Credit Unit · CO = Grade Point × CH · GPA = Σ CO ÷ Σ CH (semester) · CGPA = cumulative GPA.</div>`;
    // Only the QR is visible — the verify URL is kept in an invisible HTML comment (for tooling).
    const authBox = `<div class="auth">${qr ? `<div class="qr">${qr}</div>` : ''}<div class="amt">Scan to<br>verify result</div></div><!--verify ${esc(vurl)} ref ${esc(ref)}-->`;
    const summary = `<div class="summary">${focused ? `<div class="lab">Semester GPA</div><div class="mid">${esc(focused.gpa)}</div>` : ''}<div class="lab">Cumulative GPA (CGPA)</div><div class="big">${esc(cgpa)}</div><div class="lab">${esc(sc.totalUnits)} total credit units</div><div class="st">${esc(stand(cgpa))}</div></div>`;
    const sig = `<div class="sig"><div><div class="ln">Registrar / Examinations Officer</div></div><div><div class="ln" style="border-top-style:dashed">Official Stamp</div></div></div>`;
    const css = `<style>
      .sheet{font-size:11px}
      .info{width:100%;border-collapse:collapse;margin:3px 0}
      .info td{border:1px solid #d8dee9;padding:4px 9px;font-size:11.5px}
      .info td.k{background:#f1f5f9;font-weight:700;color:#334155;width:190px;text-transform:uppercase;font-size:9.5px;letter-spacing:.3px}
      .bar{margin:12px 0 4px;font-size:10.5px;padding:5px 10px}
      table.ctbl{width:100%;border-collapse:collapse;margin:0 0 4px}
      table.ctbl th{background:#eef2ff;border:1px solid #c7d2fe;padding:4px 6px;font-size:9px;text-transform:uppercase;letter-spacing:.2px;color:#1e3a8a;text-align:left}
      table.ctbl td{border:1px solid #d8dee9;padding:4px 6px;font-size:10.5px}
      .mono{font-family:Consolas,monospace;font-weight:700}.c{text-align:center}
      .foot{margin-top:14px;display:flex;gap:14px;align-items:flex-start;justify-content:space-between}
      table.gtbl{border-collapse:collapse;width:170px}
      table.gtbl th{background:#1e3a8a;color:#fff;padding:3px;font-size:9px;letter-spacing:1px}
      table.gtbl td{border:1px solid #d1d5db;padding:1px 8px;font-size:9px}
      .note{margin-top:5px;color:#64748b;font-size:8.5px;max-width:190px}
      .auth{display:flex;gap:8px;align-items:center}
      .auth .qr{width:84px;height:84px;flex:none}
      .auth .amt{font-size:9.5px;color:#475569;line-height:1.4}
      .auth .vurl{font-size:7.5px;color:#94a3b8;word-break:break-all}
      .summary{text-align:right;min-width:140px}
      .summary .lab{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;margin-top:4px}
      .summary .mid{font-size:17px;font-weight:800;color:#334155;line-height:1.05}
      .summary .big{font-size:26px;font-weight:800;color:#1e3a8a;line-height:1}
      .summary .st{display:inline-block;margin-top:4px;padding:3px 11px;border-radius:999px;background:#dcfce7;color:#166534;font-weight:700;font-size:10px}
      .sig{margin-top:22px;display:flex;justify-content:space-between}.sig div{width:42%;text-align:center}
      .sig .ln{border-top:1.5px solid #475569;padding-top:4px;color:#334155;font-size:10px;font-weight:600}
      @media print{@page{size:A4;margin:10mm}}
    </style>`;
    const body = `${photo}<div class="bar">Students Information</div>${infoTable}${semBlocks}<div class="foot">${legend}${authBox}${summary}</div>${sig}${css}`;
    return docShell('Statement of Result', body, null, { fit: true });
  }

  function payslipHTML(slip) {
    const run = one('payroll_runs', slip.run_id) || {}; const s = one('staff', slip.staff_id) || {};
    const cur = slip.currency || s.currency;
    const isLect = s.staff_type === 'lecturer';
    const wmText = isLect ? 'LECTURER PAYROLL' : 'STAFF PAYROLL';
    const psVerifyUrl = (docBase || '') + '/verify?p=' + slip.id;
    const psQr = verifyQrSvg(psVerifyUrl);
    const f = (l, v) => `<tr><td style="color:#64748b">${l}</td><td class="r"><b>${v}</b></td></tr>`;
    const body = `${s.photo ? `<img class="photo" src="${s.photo}">` : ''}
      <div class="grid" style="margin-bottom:8px"><div class="f"><span>Name</span><b>${esc(s.full_name)}</b></div><div class="f"><span>Staff No</span><b>${esc(s.staff_no || '—')}</b></div>
        <div class="f"><span>Type</span><b>${esc(s.staff_type === 'lecturer' ? 'Lecturer' : 'Staff')}</b></div><div class="f"><span>Period</span><b>${esc(run.period || '—')}</b></div>
        <div class="f"><span>Department</span><b>${esc(s.department || s.faculty || '—')}</b></div><div class="f"><span>Status</span><b>${esc(run.status || '—')}</b></div></div>
      <div class="bar">Earnings & Deductions</div>
      <table><tbody>
        ${f('Gross / Base', money(slip.gross, cur))}
        ${f('Allowances', money(slip.allowances, cur))}
        ${f('Bonus', money(slip.bonus, cur))}
        ${f('Deductions', money(slip.deductions, cur))}
        ${f('Loan / IOU Deduction', money(slip.loan_deduction, cur))}
      </tbody></table>
      <div class="tot">NET PAY: ${money(slip.net, cur)}</div>
      <p style="margin-top:8px" class="words">${esc(amountWords(slip.net, cur))}</p>
      <div class="bar">Authenticity</div>
      <div style="display:flex;align-items:center;gap:14px;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 14px;margin-top:8px">
        ${psQr ? `<div style="width:104px;height:104px;flex:none">${psQr}</div>` : ''}
        <div style="font-size:11.5px;color:#475569;line-height:1.5">Scan to verify this payslip is genuine.<br>Verification ref <b style="letter-spacing:1px;color:#111827">${esc(String(slip.id).replace(/-/g, '').slice(0, 8).toUpperCase())}</b><br>or visit <a href="${esc(psVerifyUrl)}">${esc((docBase || '') + '/verify')}</a></div>
      </div>`;
    return docShell((s.staff_type === 'lecturer' ? 'Lecturer' : 'Staff') + ' Payslip', body, wmText);
  }

  /** Printable examination-clearance certificate for the student (portal) — mirrors the
   *  desktop one, with a scannable QR (name, photo, department, level on the verify page). */
  function clearanceCertHTML(clearanceId) {
    const v = verifyClearance(clearanceId);
    const typeName = (v && v.typeName) || 'Examination';
    if (!v.valid) return docShell(typeName + ' Clearance', '<div class="empty" style="padding:30px;text-align:center">Clearance not found.</div>');
    const st = v.student;
    const isMid = v.clearanceType === 'midterm';
    const verifyUrl = (docBase || '') + '/verify?c=' + clearanceId;
    const qr = verifyQrSvg(verifyUrl);
    const apps = (v.approvals || []).map(a => `<tr><td>${esc(({ registrar: 'Registrar', dean: 'Faculty Head (Dean)', student_affairs: 'Student Affairs' })[a.office] || a.office)}</td><td><b style="color:${a.status === 'approved' ? '#166534' : a.status === 'denied' ? '#991b1b' : '#92400e'}">${esc(String(a.status || 'pending').toUpperCase())}</b></td><td>${esc(a.by || '—')}</td></tr>`).join('');
    const ok = v.completed;
    const okText = isMid ? '✓ CLEARED FOR MID-SEMESTER TESTS' : '✓ CLEARED FOR EXAMINATIONS';
    const body = `${st.photo ? `<img class="photo" src="${st.photo}">` : ''}
      <div class="exbar ${ok ? '' : ''}" style="background:${ok ? '#dcfce7' : '#fef9c3'};color:${ok ? '#166534' : '#854d0e'};border-radius:10px;padding:12px;text-align:center;font-weight:800;font-size:16px;margin-bottom:12px">${ok ? okText : '⚠ ' + esc(String(v.status || 'pending').toUpperCase())}</div>
      <div class="grid" style="margin-bottom:8px"><div class="f"><span>Student</span><b>${esc(st.name)}</b></div><div class="f"><span>Matric No</span><b>${esc(st.matric)}</b></div>
        <div class="f"><span>Faculty</span><b>${esc(st.faculty)}</b></div><div class="f"><span>Department</span><b>${esc(st.department)}</b></div>
        <div class="f"><span>Level</span><b>${esc(st.level)}</b></div><div class="f"><span>Clearance Type</span><b>${esc(typeName)} Clearance</b></div>
        <div class="f"><span>Session</span><b>${esc(v.session)} • ${esc(v.semester)}</b></div></div>
      <div class="bar">Office Approvals</div>
      <table><thead><tr><th>Office</th><th>Status</th><th>Approved By</th></tr></thead><tbody>${apps || '<tr><td colspan="3">—</td></tr>'}</tbody></table>
      <div class="bar">Authenticity</div>
      <div style="display:flex;align-items:center;gap:14px;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 14px;margin-top:8px">
        ${qr ? `<div style="width:104px;height:104px;flex:none">${qr}</div>` : ''}
        <div style="font-size:11.5px;color:#475569;line-height:1.5">Scan to verify this clearance — shows the student's name, photo, department & level.<br>Verification ref <b style="letter-spacing:1px;color:#111827">${esc(v.ref)}</b></div>
      </div>
      <p style="margin-top:18px;color:#64748b;font-size:11px">Student copy of a computer-generated ${esc(typeName.toLowerCase())} clearance. Anyone can confirm it is genuine by scanning the QR above.</p>`;
    return docShell(typeName + ' Clearance', body, 'STUDENT COPY');
  }

  function moneyMapHTML(m) { const e = Object.entries(m || {}); return e.length ? e.map(([c, v]) => money(v, c)).join(' · ') : money(0); }
  function officerReportHTML(data, periodLabel) {
    const ROLE = { finance: 'Bursary / Administration', registrar: data.role === 'student_affairs' ? 'Student Affairs' : 'Registrar', dean: 'Faculty Head', affairs: 'Student Affairs' };
    let body = `<div class="grid"><div class="f"><span>Officer</span><b>${esc(data.profile.full_name)}</b></div><div class="f"><span>Role</span><b>${esc(data.role)}</b></div><div class="f"><span>Period</span><b>${esc(periodLabel || 'All time')}</b></div><div class="f"><span>Generated</span><b>${fmtDate(new Date().toISOString())}</b></div></div>`;
    if (data.kind === 'finance') {
      body += `<div class="bar">Summary (per currency)</div><table><tbody><tr><td>Collected</td><td class="r">${moneyMapHTML(data.cards.collected)}</td></tr><tr><td>Billed</td><td class="r">${moneyMapHTML(data.cards.billed)}</td></tr><tr><td>Expenses</td><td class="r">${moneyMapHTML(data.cards.expenses)}</td></tr><tr><td>Students</td><td class="r">${data.cards.students}</td></tr><tr><td>Debtors</td><td class="r">${data.cards.debtors}</td></tr></tbody></table>`;
      body += `<div class="bar">Recent Payments</div><table><thead><tr><th>Receipt</th><th>Student</th><th>For</th><th>Date</th><th class="r">Amount</th></tr></thead><tbody>${(data.recent || []).map(p => `<tr><td>${esc(p.receipt_no || '—')}</td><td>${esc(p.student)}</td><td>${esc(p.category)}</td><td>${fmtDate(p.date)}</td><td class="r">${money(p.amount, p.currency)}</td></tr>`).join('') || '<tr><td colspan=5>No payments.</td></tr>'}</tbody></table>`;
    } else if (data.kind === 'registrar') {
      body += `<div class="bar">My Collections</div><div class="tot">${moneyMapHTML(data.collected)}</div>`;
      body += `<div class="bar">Students I Billed</div><table><thead><tr><th>Name</th><th>Matric</th><th class="r">Paid</th><th class="r">Owing</th></tr></thead><tbody>${(data.students || []).map(r => `<tr><td>${esc(r.full_name)}</td><td>${esc(r.matric_no || '—')}</td><td class="r">${moneyMapHTML(r.paid)}</td><td class="r neg">${moneyMapHTML(r.owing)}</td></tr>`).join('') || '<tr><td colspan=4>None.</td></tr>'}</tbody></table>`;
    } else if (data.kind === 'dean') {
      body += `<div class="bar">Faculty Collections / Expenditure</div><table><tbody><tr><td>Collected</td><td class="r">${moneyMapHTML(data.collected)}</td></tr><tr><td>Expenditure</td><td class="r">${moneyMapHTML(data.expenses)}</td></tr></tbody></table>`;
      body += `<div class="bar">Students Owing Faculty Fees</div><table><thead><tr><th>Name</th><th>Matric</th><th class="r">Owing</th></tr></thead><tbody>${(data.debtors || []).map(r => `<tr><td>${esc(r.full_name)}</td><td>${esc(r.matric_no || '—')}</td><td class="r neg">${moneyMapHTML(r.owing)}</td></tr>`).join('') || '<tr><td colspan=3>None.</td></tr>'}</tbody></table>`;
    }
    return docShell((ROLE[data.kind] || 'Officer') + ' Report', body);
  }

  // ---------------------------- HTTP ----------------------------
  function J(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(b); return true; }
  function H(res, code, html) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return true; }
  function S(res, code, body, type) { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }); res.end(body); return true; }
  function authOf(req, u) {
    const hdr = req.headers['authorization'] || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(hdr);
    const tok = (bearer && bearer[1]) || u.searchParams.get('t');
    return verifyToken(tok);
  }

  async function handle(req, res, u, method, readBody) {
    const p = u.pathname.replace(/\/+$/, '') || '/';
    docBase = buildBase(req); // so any document we render this request can build absolute verify URLs

    if (p === '/' && method === 'GET') { H(res, 200, PAGE); return true; }
    if (p === '/api/version' && method === 'GET') { J(res, 200, { version: getVersion() }); return true; }
    if (p === '/api/branding' && method === 'GET') { const i = inst(); return J(res, 200, { ok: true, name: i.name, short: i.short, logo: i.logo, motto: i.motto }); }

    // ---- installable app assets + public clearance verification (no login) ----
    if (method === 'GET' && p === '/manifest.webmanifest') return S(res, 200, MANIFEST_PORTAL, 'application/manifest+json');
    if (method === 'GET' && p === '/scan-manifest.webmanifest') return S(res, 200, MANIFEST_SCAN, 'application/manifest+json');
    if (method === 'GET' && p === '/sw.js') return S(res, 200, SW_JS, 'application/javascript');
    // Favicon / app icon = the university LOGO (falls back to a branded monogram).
    const monogramSvg = () => { const i = inst(); const init = String(i.short || i.name || 'U').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'U';
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#4338ca"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="41" font-family="Segoe UI,Arial,sans-serif" font-size="${init.length > 2 ? 20 : 26}" font-weight="800" fill="#fff" text-anchor="middle">${esc(init)}</text></svg>`; };
    if (method === 'GET' && (p === '/favicon' || p === '/favicon.ico' || p === '/favicon.png')) {
      const i = inst();
      const m = /^data:([^;]+);base64,(.+)$/.exec(i.logo || '');
      if (m) { res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'no-cache' }); res.end(Buffer.from(m[2], 'base64')); return true; }
      if (i.logo && /^https?:/i.test(i.logo)) { res.writeHead(302, { Location: i.logo }); res.end(); return true; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' }); res.end(monogramSvg()); return true;
    }
    if (method === 'GET' && p === '/icon.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' }); res.end(monogramSvg()); return true; }
    if (method === 'GET' && p === '/scan') return H(res, 200, SCAN_PAGE);
    if (method === 'GET' && p === '/verify') return H(res, 200, VERIFY_PAGE);
    if (method === 'GET' && p === '/api/verify') {
      let pid = u.searchParams.get('p') || '';
      if (pid) { // a payslip code/link
        const mp = /[?&]p=([^&\\s]+)/.exec(pid); if (mp) pid = decodeURIComponent(mp[1]);
        pid = pid.replace(/^UBU-PSL:/i, '').trim();
        return J(res, 200, { ok: true, ...verifyPayslip(pid) });
      }
      let sres = u.searchParams.get('res') || '';
      if (sres) { // a result statement link
        const ms = /[?&]res=([^&\\s]+)/.exec(sres); if (ms) sres = decodeURIComponent(ms[1]);
        const ses = u.searchParams.get('ses') || ''; const sem = u.searchParams.get('sem') || '';
        return J(res, 200, { ok: true, ...verifyResult(sres + ((ses || sem) ? ('|' + ses + '|' + sem) : '')) });
      }
      let rid = u.searchParams.get('r') || '';
      if (rid) { // a receipt code/link
        const mr = /[?&]r=([^&\\s]+)/.exec(rid); if (mr) rid = decodeURIComponent(mr[1]);
        rid = rid.replace(/^UBU-RCT:/i, '').trim();
        return J(res, 200, { ok: true, ...verifyReceipt(rid) });
      }
      let id = u.searchParams.get('c') || u.searchParams.get('ref') || '';
      const m = /[?&]c=([^&\\s]+)/.exec(id); if (m) id = decodeURIComponent(m[1]);   // a full URL was scanned
      id = id.replace(/^UBU-CLR:/i, '').trim();
      return J(res, 200, { ok: true, ...verifyClearance(id) });
    }

    if (p === '/api/login' && method === 'POST') {
      const body = await readBody();
      const acc = findAccount(body.login);
      if (!acc || !verifyPass(body.password, passField(acc.kind, acc.row))) return J(res, 200, { ok: false, error: 'Invalid login or password. (Officers: sign in to the desktop app once to activate your portal access.)' });
      const token = sign({ k: acc.kind, id: acc.row.id, role: acc.role, exp: Date.now() + 1000 * 60 * 60 * 12 });
      const name = (acc.kind === 'student') ? `${acc.row.first_name || ''} ${acc.row.last_name || ''}`.trim()
        : (acc.kind === 'parent') ? (acc.row.parent_name || 'Parent/Guardian') : acc.row.full_name;
      return J(res, 200, { ok: true, token, user: { role: acc.role, kind: acc.kind, name } });
    }

    if (p === '/api/reset-password' && method === 'POST') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      const body = await readBody();
      if (!verifyPass(body.oldPassword, passField(t.k, row))) return J(res, 200, { ok: false, error: 'Your current password is incorrect.' });
      if (!body.newPassword || String(body.newPassword).length < 5) return J(res, 200, { ok: false, error: 'New password must be at least 5 characters.' });
      if (typeof update !== 'function') return J(res, 200, { ok: false, error: 'Password reset is unavailable on this server.' });
      const field = t.k === 'parent' ? 'parent_portal_pass' : 'portal_pass';
      const entity = (t.k === 'student' || t.k === 'parent') ? 'students' : (t.k === 'user' ? 'users' : 'staff');
      const done = update(entity, t.id, { [field]: hashPass(body.newPassword) });
      return J(res, 200, { ok: !!done, error: done ? null : 'Could not save the new password.' });
    }

    if (p === '/api/me' && method === 'GET') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      const name = t.k === 'student' ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : row.full_name;
      return J(res, 200, { ok: true, user: { role: t.role, kind: t.k, name } });
    }

    if (p === '/api/officer-report' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'user') return J(res, 401, { ok: false });
      const row = accountById('user', t.id); if (!row) return J(res, 401, { ok: false });
      const data = officerData(row, parsePeriod(u.searchParams));
      data.role = t.role; data.institution = inst().name;
      return J(res, 200, { ok: true, data });
    }
    if (p === '/api/students' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'user') return J(res, 401, { ok: false });
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const rows = all('students').filter(s => s.status !== 'alumni' && (!q || (`${s.first_name || ''} ${s.last_name || ''}`.toLowerCase().includes(q) || (s.matric_no || '').toLowerCase().includes(q)))).slice(0, 25)
        .map(s => ({ id: s.id, name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), matric: s.matric_no, department: nameOf('departments', s.department_id) }));
      return J(res, 200, { ok: true, students: rows });
    }

    if (p === '/api/data' && method === 'GET') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      let data;
      if (t.k === 'student' || t.k === 'parent') { data = studentData(row); data.parentView = t.k === 'parent'; data.parentName = t.k === 'parent' ? (row.parent_name || 'Parent/Guardian') : null; data.kind = 'student'; }
      else if (t.k === 'staff') { data = staffData(row); data.kind = 'staff'; }
      else { data = officerData(row); } // officerData already sets data.kind = finance | registrar | dean | affairs
      data.institution = inst().name; data.role = t.role;
      return J(res, 200, { ok: true, data });
    }

    // documents (open in a tab; token via ?t=)
    if (p.startsWith('/doc/') && method === 'GET') {
      const t = authOf(req, u); if (!t) return H(res, 401, '<p>Session expired. Please sign in again.</p>');
      const parts = p.split('/'); const type = parts[2]; const id = parts[3];
      const studentish = (t.k === 'student' || t.k === 'parent'); // both view the student record
      if (type === 'statement' && studentish) { return H(res, 200, statementHTML(accountById('student', t.id))); }
      if (type === 'result-slip' && studentish) {
        const s = accountById('student', t.id) || one('students', t.id);
        if (!s) return H(res, 404, '<p>Student not found.</p>');
        return H(res, 200, resultSlipHTML(s, { session: u.searchParams.get('session') || '', semester: u.searchParams.get('semester') || '' }));
      }
      if (type === 'receipt') {
        const pay = one('payments', id);
        if (!pay) return H(res, 404, '<p>Receipt not found.</p>');
        if (studentish && pay.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'staff') return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, receiptHTML(pay));
      }
      if (type === 'payslip') {
        const slip = one('payslips', id);
        if (!slip) return H(res, 404, '<p>Payslip not found.</p>');
        if (t.k === 'staff' && slip.staff_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (studentish) return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, payslipHTML(slip));
      }
      if (type === 'clearance') {
        const c = one('exam_clearances', id);
        if (!c) return H(res, 404, '<p>Clearance not found.</p>');
        if (studentish && c.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'staff') return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, clearanceCertHTML(id));
      }
      if (type === 'officer-report' && t.k === 'user') {
        const row = accountById('user', t.id); if (!row) return H(res, 404, '<p>Not found.</p>');
        const period = parsePeriod(u.searchParams);
        return H(res, 200, officerReportHTML(officerData(row, period), periodLabel(period)));
      }
      if (type === 'student-statement' && t.k === 'user') {
        const s = one('students', id); if (!s) return H(res, 404, '<p>Student not found.</p>');
        return H(res, 200, statementHTML(s));
      }
      if (type === 'result') {
        const r = one('results', id);
        if (!r || !r.file) return H(res, 404, '<p>Result not found.</p>');
        if (studentish && r.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'staff') return H(res, 403, '<p>Not authorised.</p>');
        const buf = Buffer.from(r.file, 'base64');
        res.writeHead(200, { 'Content-Type': r.mime || 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + (r.filename || 'result') + '"' });
        res.end(buf); return true;
      }
      if (type === 'portal-document' || type === 'document') {
        const d = one('portal_documents', id);
        if (!d || !d.file) return H(res, 404, '<p>Document not found.</p>');
        const buf = Buffer.from(d.file, 'base64');
        res.writeHead(200, { 'Content-Type': d.mime || 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + (d.filename || 'document') + '"' });
        res.end(buf); return true;
      }
      return H(res, 404, '<p>Not found.</p>');
    }
    return false;
  }

  return { handle };
};

// ----------------------- single-page portal client -----------------------
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UniBursar Portal</title>
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1e3a8a"><link rel="icon" href="/favicon">
<style>
:root{--navy:#0f1e3d;--brand:#2563eb;--ink:#0f172a;--muted:#64748b;--line:#e6eaf0;--bg:#eef2f8}
*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand)}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(1200px 600px at 20% -10%,#1e3a8a22,transparent),var(--bg)}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 20px 60px rgba(15,23,42,.12)}
.lbox{width:380px;max-width:94vw;padding:30px}
.lbox h1{margin:0 0 2px;font-size:22px;color:var(--navy)}.lbox .sub{color:var(--muted);font-size:13px;margin-bottom:18px}
.brandhead{display:flex;gap:12px;align-items:center;margin-bottom:4px}
.blogo{width:58px;height:58px;object-fit:contain;border-radius:14px;background:#fff;border:1px solid var(--line);padding:4px;flex:none}
.blogo.mono{display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;font-weight:800;font-size:19px;border:0}
.uname{font-size:19px;font-weight:800;color:var(--navy);line-height:1.12}
.umotto{font-size:11px;color:var(--muted);font-style:italic;margin-top:2px}
.psub{font-size:13px;color:var(--brand);font-weight:700;margin:8px 0 16px}
.hintbar{font-size:12px;color:var(--muted);text-align:center;margin-top:12px;line-height:1.5}
.field{margin-bottom:12px}.field label{display:block;font-size:12px;font-weight:600;color:#334155;margin-bottom:5px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px}
.btn{background:linear-gradient(135deg,#2563eb,#4338ca);color:#fff;border:0;border-radius:10px;padding:12px;font-weight:700;width:100%;cursor:pointer;font-size:14px}
.btn.sm{width:auto;padding:8px 13px;font-size:12.5px;border-radius:8px}.btn.ghost{background:#fff;color:var(--brand);border:1px solid var(--line)}
.err{background:#fee2e2;color:#991b1b;padding:9px 12px;border-radius:9px;font-size:13px;margin-bottom:12px;display:none}
.top{background:var(--navy);color:#fff;display:flex;align-items:center;gap:12px;padding:12px 20px}
.top .nm{font-weight:800}.top .rl{margin-left:auto;opacity:.85;font-size:13px;text-transform:capitalize}
.wrap{max-width:1040px;margin:0 auto;padding:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px}
.kpi .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px}.kpi .v{font-size:22px;font-weight:800;margin-top:4px}
.panel{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:18px;overflow:hidden}
.panel h3{margin:0;padding:14px 18px;border-bottom:1px solid var(--line);font-size:15px}
table{width:100%;border-collapse:collapse}th,td{padding:11px 16px;text-align:left;border-bottom:1px solid #f1f5f9;font-size:13.5px}
th{background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted)}
.r{text-align:right}.neg{color:#b91c1c;font-weight:700}.pos{color:#065f46;font-weight:700}
.prof{display:flex;gap:16px;align-items:center;padding:18px}.prof img,.prof .ph{width:84px;height:96px;border-radius:10px;object-fit:cover;border:2px solid var(--brand)}
.prof .ph{background:#e2e8f0;display:flex;align-items:center;justify-content:center;color:#94a3b8}
.prof .nm{font-size:20px;font-weight:800}.prof .meta{color:var(--muted);font-size:13px;margin-top:3px}
.muted{color:var(--muted)}.badge{background:#eef2ff;color:#3730a3;border-radius:999px;padding:3px 9px;font-size:11px;font-weight:700}
.empty{padding:24px;text-align:center;color:var(--muted)}
.live{font-size:11px;color:#16a34a;margin-left:8px}
.tscroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
select{padding:9px 10px;border:1px solid var(--line);border-radius:9px;font-size:13.5px;background:#fff;max-width:100%}
.toolbarp{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pbanner{background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:12px;padding:11px 16px;margin-bottom:14px;font-size:13.5px}
.exbar{border-radius:12px;padding:13px 16px;margin-bottom:14px;font-weight:800;text-align:center;letter-spacing:.3px;font-size:15px}
.exbar.ok{background:#dcfce7;color:#166534;border:1px solid #86efac}
.exbar.warn{background:#fef9c3;color:#854d0e;border:1px solid #fde68a}
.exbar.bad{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}
/* ---- segmented student portal ---- */
/* single column: photo + info at the TOP, section tabs beneath, content below — the
   WHOLE page scrolls as one (no separate scrolling side panel). */
.shell{max-width:940px;margin:0 auto;padding:18px 16px}
.phead{background:linear-gradient(160deg,#1e3a8a,#4338ca);color:#fff;border-radius:18px;padding:20px 22px;display:flex;gap:18px;align-items:center;margin-bottom:14px;box-shadow:0 8px 26px rgba(30,58,138,.22)}
.phead img,.phead .ph{width:86px;height:86px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.55);flex:none}
.phead .ph{background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:34px}
.phead .nm{font-weight:800;font-size:21px;line-height:1.15}
.phead .mt{opacity:.92;font-size:13px;margin-top:4px}
.phead .bal{margin-left:8px;font-size:13px;opacity:.95}
.phead .chip{vertical-align:middle}
/* horizontal section tabs (sticky to the top of the page so they're always reachable) */
.nav{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;background:#fff;border:1px solid var(--line);border-radius:14px;padding:6px;margin-bottom:16px;position:sticky;top:8px;z-index:6;box-shadow:0 4px 16px rgba(15,23,42,.05)}
.nav a{display:inline-flex;gap:7px;align-items:center;padding:9px 14px;color:#334155;text-decoration:none;font-size:13.5px;font-weight:700;border-radius:10px;white-space:nowrap;cursor:pointer}
.nav a .ic{font-size:15px}
.nav a.active{background:var(--brand);color:#fff}
.nav a:hover{background:#f1f5f9}.nav a.active:hover{background:var(--brand)}
.nav a .pill{background:#ef4444;color:#fff;border-radius:999px;font-size:10px;font-weight:800;padding:1px 6px}
.content{min-width:0}
.hero{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:16px;display:flex;align-items:center;gap:16px;box-shadow:0 6px 22px rgba(15,23,42,.05)}
.hero .big{font-size:21px;font-weight:800}.hero .meta{color:var(--muted);font-size:13px;margin-top:3px}
.chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 12px;font-size:12.5px;font-weight:800}
.chip.ok{background:#dcfce7;color:#166534}.chip.warn{background:#fef9c3;color:#854d0e}.chip.bad{background:#fee2e2;color:#991b1b}
.seg{display:none}.seg.on{display:block}
.sectitle{font-size:18px;font-weight:800;margin:0 0 12px;color:var(--navy)}
.qa{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:16px}
/* phone — shrink the profile header; tabs become an icon strip that scrolls sideways */
@media(max-width:600px){
  .shell{padding:11px 9px}
  .phead{padding:14px;gap:12px;border-radius:14px}
  .phead img,.phead .ph{width:60px;height:60px;font-size:24px}
  .phead .nm{font-size:16px}.phead .mt{font-size:12px}
  .nav a{padding:9px 11px}
  .nav a .ic{font-size:18px}
  .nav a .lbl{display:none}   /* icons only on small phones; full labels on tablet+ */
  .tscroll table{min-width:520px}
}
@media(max-width:760px){
  .wrap{padding:12px}
  .top{padding:11px 14px;gap:9px}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
  .kpi{padding:13px}.kpi .v{font-size:19px}
  .panel h3{padding:12px 14px;font-size:14px}
  th,td{padding:9px 11px;font-size:13px;white-space:nowrap}
  .tscroll table{min-width:560px}
  .prof{flex-direction:column;text-align:center;gap:10px}
  .prof img,.prof .ph{width:96px;height:112px}
}
@media(max-width:560px){.top .rl{display:none}.lbox{padding:22px}}
</style></head>
<body>
<div id="app"></div>
<script>
const $=(h)=>{const d=document.createElement('div');d.innerHTML=h;return d.firstElementChild;};
let TOKEN=localStorage.getItem('ubu_token')||'';let VER=0;let TIMER=null;
const SYM={NGN:'₦',XOF:'CFA',USD:'$',EUR:'€',GBP:'£',GHS:'₵',KES:'KSh',ZAR:'R'};
function money(a,c){return (SYM[c]||(c?c+' ':''))+Number(a||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function mapMoney(m){const e=Object.entries(m||{});return e.length?e.map(([c,v])=>money(v,c)).join(' • '):money(0);}
function fmt(d){if(!d)return '—';try{return new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});}catch(_){return '—';}}
async function api(path,opts={}){opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});if(TOKEN)opts.headers.Authorization='Bearer '+TOKEN;const r=await fetch(path,opts);return r.json();}
function logout(){TOKEN='';localStorage.removeItem('ubu_token');if(TIMER)clearInterval(TIMER);renderLogin();}
async function changePassword(){
  const o=prompt('Enter your CURRENT password:'); if(o===null)return;
  const n=prompt('Enter your NEW password (at least 5 characters):'); if(n===null)return;
  if(!n||n.length<5){alert('New password must be at least 5 characters.');return;}
  const c2=prompt('Confirm your NEW password:'); if(c2===null)return;
  if(n!==c2){alert('The new passwords do not match.');return;}
  const r=await api('/api/reset-password',{method:'POST',body:JSON.stringify({oldPassword:o,newPassword:n})});
  alert(r.ok?'✓ Password changed. Use your new password next time you sign in. It also updates on the school system.':(r.error||'Could not change password.'));
}

function eh(s){return String(s==null?'':s).replace(/[&<>"]/g,function(m){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m];});}
async function renderLogin(msg){
  let b={};try{b=await(await fetch('/api/branding')).json();}catch(_){}
  const uname=eh(b.name||'University Portal');
  const logo=b.logo?'<img class="blogo" src="'+b.logo+'" alt="logo">':'<div class="blogo mono">'+eh((b.short||'UB').slice(0,3))+'</div>';
  document.getElementById('app').innerHTML='';
  const box=$('<div class="login"><div class="card lbox">'
    +'<div class="brandhead">'+logo+'<div><div class="uname">'+uname+'</div>'+(b.motto?('<div class="umotto">'+eh(b.motto)+'</div>'):'')+'</div></div>'
    +'<div class="psub">🎓 Student, Staff &amp; Lecturer Portal</div>'
    +'<div class="err"></div>'
    +'<div class="field"><label>Matric no · Staff no · Username · Email</label><input id="lg" autofocus autocomplete="username"></div>'
    +'<div class="field"><label>Password</label><input id="pw" type="password" autocomplete="current-password"></div>'
    +'<button class="btn" id="go">Sign In</button>'
    +'<div class="hintbar">Your login is emailed to you after registration. Forgot it? Ask the bursary or registrar to resend your portal login.</div>'
    +'<div class="sub" style="margin-top:10px;text-align:center"><a href="/scan">🛡 Staff: open the Clearance Scanner →</a></div>'
    +'</div></div>');
  document.getElementById('app').appendChild(box);
  if(msg){const e=box.querySelector('.err');e.textContent=msg;e.style.display='block';}
  const go=async()=>{const login=box.querySelector('#lg').value.trim();const password=box.querySelector('#pw').value;if(!login||!password)return;const btn=box.querySelector('#go');btn.disabled=true;btn.textContent='Signing in…';const r=await api('/api/login',{method:'POST',body:JSON.stringify({login,password})});btn.disabled=false;btn.textContent='Sign In';if(!r.ok){const e=box.querySelector('.err');e.textContent=r.error||'Login failed.';e.style.display='block';return;}TOKEN=r.token;localStorage.setItem('ubu_token',TOKEN);renderApp();};
  box.querySelector('#go').onclick=go;
  box.querySelectorAll('input').forEach(i=>i.addEventListener('keydown',function(e){if(e.key==='Enter')go();}));
}

async function renderApp(){
  const r=await api('/api/data');
  if(!r.ok){return logout();}
  const d=r.data;
  const app=document.getElementById('app');app.innerHTML='';
  app.appendChild($('<div class="top"><div class="nm">'+(d.institution||'UniBursar')+'</div><div class="rl">'+(d.profile&&d.profile.full_name?d.profile.full_name+' · ':'')+d.role+' <span class="live">● live</span></div><button class="btn sm ghost" style="margin-left:14px" onclick="changePassword()">🔑 Password</button><button class="btn sm ghost" style="margin-left:8px" onclick="logout()">Sign out</button></div>'));
  const w=$('<div class="wrap"></div>');app.appendChild(w);
  if(d.kind==='student')studentView(w,d);
  else if(d.kind==='staff')staffView(w,d);
  else officerView(w,d);
  VER=(await api('/api/version')).version||0;
  if(TIMER)clearInterval(TIMER);
  TIMER=setInterval(async()=>{try{const v=(await api('/api/version')).version;if(v!==VER){VER=v;var ae=document.activeElement;if(ae&&/^(SELECT|INPUT|TEXTAREA)$/.test(ae.tagName))return;renderApp();}}catch(_){}},2500);
}
function tbl(cols,rows,empty){if(!rows||!rows.length)return '<div class="empty">'+(empty||'Nothing to show.')+'</div>';return '<div class="tscroll"><table><thead><tr>'+cols.map(c=>'<th class="'+(c.r?'r':'')+'">'+c.t+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+cols.map(c=>'<td class="'+(c.r?'r':'')+'">'+c.f(row)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';}
function doc(path){window.open(path+(path.includes('?')?'&':'?')+'t='+encodeURIComponent(TOKEN),'_blank');}

function studentView(w,d){
  var p=d.profile;
  var clr=d.examClearance||{};
  var chip=clr.cleared?(clr.type==='partial'?'<span class="chip warn">⚠ Partially cleared</span>':'<span class="chip ok">✓ Cleared for exams</span>'):'<span class="chip bad">✗ Not cleared</span>';
  var owingCount=(d.outstanding||[]).length;
  var photo=p.photo?'<img src="'+p.photo+'">':'<div class="ph">🎓</div>';
  // --- section tabs ---
  var segs=[['overview','🏠','Overview',0],['fees','💳','Fees & Payments',owingCount],['receipts','🧾','Receipts',0],['results','📑','Results',0],['clearance','✅','Clearance',0],['documents','📂','Documents',0]];
  if(d.misconduct&&d.misconduct.length)segs.push(['discipline','⚖️','Discipline',d.misconduct.length]);
  segs.push(['profile','👤','Profile',0]);
  var navHtml=segs.map(function(s){return '<a data-seg="'+s[0]+'"><span class="ic">'+s[1]+'</span><span class="lbl">'+s[2]+'</span>'+(s[3]?'<span class="pill">'+s[3]+'</span>':'')+'</a>';}).join('');
  // --- profile + photo pinned at the TOP (full width) ---
  var head=$('<div class="phead">'+photo
    +'<div style="flex:1;min-width:0"><div class="nm">'+eh(p.full_name)+'</div>'
    +'<div class="mt">'+eh(p.matric_no||'Matric pending')+' · '+eh(p.department||'—')+' · '+eh(p.level||'—')+(p.faculty?(' · '+eh(p.faculty)):'')+'</div>'
    +'<div style="margin-top:9px">'+chip+'<span class="bal">Balance: <b>'+mapMoney(d.balances)+'</b></span></div></div></div>');
  // --- horizontal section tabs ---
  var navEl=$('<div class="nav">'+navHtml+'</div>');
  // --- content (segments) ---
  var content=$('<div class="content"></div>');
  if(d.parentView)content.appendChild($('<div class="pbanner">👨‍👩‍👧 Parent/Guardian view — records of <b>'+eh(p.full_name||'your ward')+'</b>.</div>'));

  function seg(id,html){return '<div class="seg" data-seg="'+id+'">'+html+'</div>';}
  function sevBadge(s){var c=s==='severe'?'background:#fee2e2;color:#991b1b':s==='major'?'background:#fef3c7;color:#92400e':'background:#e5e7eb;color:#374151';return '<span class="badge" style="'+c+'">'+cap(s||'minor')+'</span>';}
  function stBadge(s){var c=s==='resolved'?'background:#dcfce7;color:#166534':'background:#fee2e2;color:#991b1b';return '<span class="badge" style="'+c+'">'+cap(s||'open')+'</span>';}
  var clrCls=clr.cleared?(clr.type==='partial'?'warn':'ok'):'bad';
  var clrTxt=clr.cleared?(clr.type==='partial'?'⚠ PARTIALLY CLEARED for exams — you still owe fees':'✓ CLEARED for examinations'):('✗ NOT CLEARED for exams — '+eh(clr.reason||'no clearance'));

  var html='';
  // OVERVIEW
  html+=seg('overview',
    '<div class="kpis">'
    +'<div class="kpi"><div class="l">Outstanding Balance</div><div class="v neg">'+mapMoney(d.balances)+'</div></div>'
    +'<div class="kpi"><div class="l">Session</div><div class="v" style="font-size:16px">'+eh(d.currentSession||'—')+'</div></div>'
    +'<div class="kpi"><div class="l">Semester</div><div class="v" style="font-size:16px">'+eh(d.currentSemester||'—')+'</div></div>'
    +'<div class="kpi"><div class="l">Exam Status</div><div class="v" style="font-size:15px">'+(clr.cleared?(clr.type==='partial'?'Partial':'Cleared'):'Not cleared')+'</div></div></div>'
    +'<div class="exbar '+clrCls+'">'+clrTxt+'</div>'
    +'<div class="qa"><button class="btn sm" onclick="doc(\\'/doc/statement\\')">📄 Download full statement</button><button class="btn sm ghost" onclick="changePassword()">🔑 Change password</button></div>'
    +'<div class="panel"><h3>Who You Owe — by Office</h3>'+tbl([{t:'Office',f:function(r){return eh(r.office);}},{t:'Charged',r:1,f:function(r){return mapMoney(r.charged);}},{t:'Paid',r:1,f:function(r){return mapMoney(r.paid);}},{t:'Outstanding',r:1,f:function(r){return Object.keys(r.owing).length?'<span class=neg>'+mapMoney(r.owing)+'</span>':'<span class=pos>Cleared</span>';}}],d.byOffice,'No charges on your account.')+'</div>');
  // FEES
  html+=seg('fees',
    '<h2 class="sectitle">💳 Fees &amp; Payments</h2>'
    +'<div class="panel"><h3>Outstanding Fees</h3>'+tbl([{t:'Fee Category',f:function(r){return cap(r.category);}},{t:'Currency',f:function(r){return r.currency;}},{t:'Billed',r:1,f:function(r){return money(r.billed,r.currency);}},{t:'Paid',r:1,f:function(r){return money(r.paid,r.currency);}},{t:'Outstanding',r:1,f:function(r){return '<span class=neg>'+money(r.outstanding,r.currency)+'</span>';}}],d.outstanding,'You owe nothing. 🎉')+'</div>'
    +'<div class="panel"><h3>All Fees &amp; Charges</h3>'+tbl([{t:'Date',f:function(r){return fmt(r.date);}},{t:'Description',f:function(r){return (eh(r.description)||cap(r.category))+' '+(r.rollover?'<span class="badge" style="background:#fef3c7;color:#92400e">Rollover'+(r.rolled_from?' · '+eh(r.rolled_from):'')+'</span>':'<span class="badge" style="background:#dbeafe;color:#1e40af">Current</span>');}},{t:'Category',f:function(r){return cap(r.category);}},{t:'Set By',f:function(r){return eh(r.by||'—');}},{t:'Amount',r:1,f:function(r){return money(r.amount,r.currency);}}],d.charges,'No charges yet.')+'</div>');
  // RECEIPTS
  html+=seg('receipts',
    '<h2 class="sectitle">🧾 Payment History &amp; Receipts</h2>'
    +'<div class="panel">'+tbl([{t:'Receipt',f:function(r){return r.receipt_no||'—';}},{t:'Date',f:function(r){return fmt(r.date);}},{t:'For',f:function(r){return cap(r.category);}},{t:'Collected By',f:function(r){return (r.collector?eh(r.collector)+'<br>':'')+'<span class="muted" style="font-size:11px">'+eh(r.office||'')+'</span>';}},{t:'Amount',r:1,f:function(r){return money(r.amount,r.currency);}},{t:'',r:1,f:function(r){return r.receipt_no?'<button class="btn sm" onclick="doc(\\'/doc/receipt/'+r.id+'\\')">Download</button>':'';}}],d.payments,'No payments yet.')+'</div>');
  // RESULTS — list each level + semester with a downloadable PDF statement of result
  var sc=d.scores||{courses:[],semesters:[],cgpa:0,totalUnits:0};
  var myLevel=(d.profile&&d.profile.level)||'—';
  var resultsHtml=(sc.semesters&&sc.semesters.length)?(
    '<div class="panel"><h3>My Results</h3>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:8px">Your statement of result is generated as a PDF. Pick a semester and click <b>Download PDF</b> — the document opens ready to save/print.</div>'
    +tbl([
      {t:'Level',f:function(r){return eh(myLevel);}},
      {t:'Semester',f:function(r){return eh(r.semester||'—');}},
      {t:'Session',f:function(r){return eh(r.session||'—');}},
      {t:'',r:1,f:function(r){return '<button class="btn sm" onclick="doc(\\'/doc/result-slip?session='+encodeURIComponent(r.session_id||'')+'&semester='+encodeURIComponent(r.semester_id||'')+'\\')">⬇️ Download PDF</button>';}}
    ],sc.semesters,'No results published yet.')
    +'<div style="margin-top:10px"><button class="btn sm ghost" onclick="doc(\\'/doc/result-slip\\')">⬇️ Download full statement (all semesters)</button></div>'
    +'</div>'
  ):'<div class="empty">No results published yet. They will appear here once your results are released.</div>';
  html+=seg('results',
    '<h2 class="sectitle">📑 My Results</h2>'
    +resultsHtml
    +'<div class="panel"><h3>Other Result Documents</h3>'+tbl([{t:'Level',f:function(r){return eh(r.level||'—');}},{t:'Semester',f:function(r){return eh(r.semester||'—');}},{t:'Session',f:function(r){return eh(r.session||'—');}},{t:'Title',f:function(r){return eh(r.title||'Result');}},{t:'',r:1,f:function(r){return '<button class="btn sm" onclick="doc(\\'/doc/result/'+r.id+'\\')">Download</button>';}}],d.results,'No other result documents.')+'</div>');
  // CLEARANCE
  html+=seg('clearance',
    '<h2 class="sectitle">✅ Examination Clearance</h2>'
    +'<div class="exbar '+clrCls+'">'+clrTxt+'</div>'
    +(((clr.certs&&clr.certs.length))?('<div class="qa">'+clr.certs.map(function(ct){return '<button class="btn sm" onclick="doc(\\'/doc/clearance/'+ct.id+'\\')">📄 Download my '+eh(ct.typeName)+' clearance certificate</button>';}).join('')+'</div>'):'')
    +'<div class="panel"><h3>Exam Validation History</h3>'+tbl([{t:'Date',f:function(r){return fmt(r.date);}},{t:'Type',f:function(r){return cap(r.exam_type||'exam');}},{t:'Session',f:function(r){return eh(r.session||'—')+(r.semester?(' · '+eh(r.semester)):'');}},{t:'Result',f:function(r){return '<span class="'+(r.status==='valid'?'pos':'neg')+'" style="font-weight:800">'+(r.status==='valid'?'CLEARED':'DENIED')+'</span>';}},{t:'Reason',f:function(r){return eh(r.reason||'—');}}],d.validations,'No exam validations yet.')+'</div>');
  // DOCUMENTS
  html+=seg('documents',
    '<h2 class="sectitle">📂 University Documents</h2>'
    +'<div class="panel">'+tbl([{t:'Title',f:function(r){return eh(r.title||'Document');}},{t:'Type',f:function(r){return '<span class="badge">'+eh(r.category||'Document')+'</span>';}},{t:'From Office',f:function(r){return eh(r.office||'—')+(r.by?'<br><span class="muted" style="font-size:11px">'+eh(r.by)+'</span>':'');}},{t:'Date',f:function(r){return fmt(r.date);}},{t:'',r:1,f:function(r){return '<button class="btn sm" onclick="doc(\\'/doc/portal-document/'+r.id+'\\')">Download</button>';}}],d.documents,'No documents published yet.')+'</div>');
  // DISCIPLINE
  if(d.misconduct&&d.misconduct.length){
    html+=seg('discipline',
      '<h2 class="sectitle">⚖️ Disciplinary Records</h2>'
      +'<div class="panel">'+tbl([{t:'Date',f:function(r){return fmt(r.date);}},{t:'Offense',f:function(r){return eh(r.offense||'—');}},{t:'Severity',f:function(r){return sevBadge(r.severity);}},{t:'Action',f:function(r){return cap(r.action||'—');}},{t:'Fine',r:1,f:function(r){return r.fine>0?money(r.fine,r.currency):'—';}},{t:'Status',f:function(r){return stBadge(r.status);}},{t:'Note',f:function(r){return eh(r.note||'—');}}],d.misconduct,'No misconduct on record.')+'</div>');
  }
  // PROFILE
  html+=seg('profile',
    '<h2 class="sectitle">👤 My Profile</h2>'
    +'<div class="panel"><div class="prof">'+photo+'<div><div class="nm">'+eh(p.full_name)+'</div><div class="meta">'+eh(p.matric_no||'Matric pending')+'</div></div></div>'
    +'<table><tbody>'
    +'<tr><th>Faculty</th><td>'+eh(p.faculty||'—')+'</td><th>Department</th><td>'+eh(p.department||'—')+'</td></tr>'
    +'<tr><th>Level</th><td>'+eh(p.level||'—')+'</td><th>Email</th><td>'+eh(p.email||'—')+'</td></tr>'
    +'<tr><th>Session</th><td>'+eh(d.currentSession||'—')+'</td><th>Semester</th><td>'+eh(d.currentSemester||'—')+'</td></tr>'
    +'</tbody></table></div>'
    +'<div class="qa"><button class="btn sm" onclick="changePassword()">🔑 Change password</button></div>');

  var box=document.createElement('div');box.innerHTML=html;
  while(box.firstChild)content.appendChild(box.firstChild);
  var shell=$('<div class="shell"></div>');shell.appendChild(head);shell.appendChild(navEl);shell.appendChild(content);w.appendChild(shell);
  function show(s){
    Array.prototype.forEach.call(content.querySelectorAll('.seg'),function(el){el.classList.toggle('on',el.getAttribute('data-seg')===s);});
    Array.prototype.forEach.call(navEl.querySelectorAll('a'),function(a){a.classList.toggle('active',a.getAttribute('data-seg')===s);});
    window.__seg=s;
    try{window.scrollTo(0,0);}catch(_){}   // show the top of the chosen section
  }
  Array.prototype.forEach.call(navEl.querySelectorAll('a'),function(a){a.onclick=function(){show(a.getAttribute('data-seg'));};});
  var want=window.__seg||'overview';
  if(!content.querySelector('.seg[data-seg="'+want+'"]'))want='overview';
  show(want);
}
function staffView(w,d){
  const p=d.profile;
  w.appendChild($('<div class="panel"><div class="prof">'+(p.photo?'<img src="'+p.photo+'">':'<div class="ph">👤</div>')+'<div><div class="nm">'+p.full_name+' <span class="badge">'+p.type+'</span></div><div class="meta">'+(p.staff_no||'—')+' · '+(p.position||p.title||'—')+'</div><div class="meta">'+(p.department||p.faculty||'')+' · '+(p.email||'')+'</div></div></div></div>'));
  w.appendChild($('<div class="kpis"><div class="kpi"><div class="l">Base / Default Pay</div><div class="v">'+money(p.base_salary,p.currency)+'</div></div><div class="kpi"><div class="l">Payslips</div><div class="v">'+d.payslips.length+'</div></div><div class="kpi"><div class="l">Bank</div><div class="v" style="font-size:15px">'+(p.bank_name||'—')+'</div></div></div>'));
  w.appendChild($('<div class="panel"><h3>My Payslips</h3>'+tbl([{t:'Period',f:r=>r.period||'—'},{t:'Type',f:r=>cap(r.run_type||'staff')},{t:'Status',f:r=>'<span class="badge">'+cap(r.status||'draft')+'</span>'},{t:'Net Pay',r:1,f:r=>money(r.net,r.currency)},{t:'',r:1,f:r=>'<button class="btn sm" onclick="doc(\\'/doc/payslip/'+r.id+'\\')">Payslip</button>'}],d.payslips,'No payslips yet.')+'</div>'));
}
function officerControls(w,d){
  var per=d.period||{};var ps=d.periods||{sessions:[],semesters:[]};
  var today=new Date().toISOString().slice(0,10);var thisMonth=today.slice(0,7);
  function o(v,l,sel){return '<option value="'+v+'"'+(sel?' selected':'')+'>'+l+'</option>';}
  var basis=per.basis||'all';
  var basisOpts=[['all','All time'],['day','Daily'],['week','Weekly'],['month','Monthly'],['semester','Semester'],['session','Session']].map(function(x){return o(x[0],x[1],basis===x[0]);}).join('');
  var sessOpts='<option value="">All sessions</option>'+ps.sessions.map(function(s){return o(s.id,eh(s.name),s.id===per.session);}).join('');
  var semOpts='<option value="">All semesters</option>'+ps.semesters.map(function(sm){return o(sm.id,eh(sm.name),sm.id===per.semester);}).join('');
  // finance officers (accountant/admin) can drill into a specific office's collections
  var officeCtrl='';
  if(d.canPickOffice){var oo=per.office||'';officeCtrl='<span class="muted">Office:</span> <select id="of-office">'+[['','All offices'],['accountant','Bursary / Accountant'],['registrar','Registrar'],['dean','Faculty Head (Dean)'],['student_affairs','Student Affairs']].map(function(x){return o(x[0],x[1],oo===x[0]);}).join('')+'</select>';}
  var bar=$('<div class="panel"><div class="toolbarp" style="padding:14px 16px">'
    +'<b>📊 Report:</b> <select id="of-basis">'+basisOpts+'</select> <span id="of-valwrap"></span>'
    +officeCtrl
    +'<button class="btn sm" id="of-dl" style="width:auto">📄 Download</button>'
    +'<span style="flex:1"></span>'
    +'<input id="of-find" placeholder="🔎 Find a student…" style="min-width:200px;width:auto">'
    +'</div><div id="of-find-res" style="padding:0 16px 14px"></div></div>');
  w.appendChild(bar);
  var basisSel=bar.querySelector('#of-basis'),valwrap=bar.querySelector('#of-valwrap');
  var officeSel=bar.querySelector('#of-office');if(officeSel)officeSel.onchange=apply;
  function buildVal(){
    var b=basisSel.value;
    if(b==='day')valwrap.innerHTML='<input type="date" id="of-day" value="'+(per.day||today)+'">';
    else if(b==='week')valwrap.innerHTML='week of <input type="date" id="of-week" value="'+(per.weekStart||today)+'">';
    else if(b==='month')valwrap.innerHTML='<input type="month" id="of-month" value="'+(per.month||thisMonth)+'">';
    else if(b==='session')valwrap.innerHTML='<select id="of-sess">'+sessOpts+'</select>';
    else if(b==='semester')valwrap.innerHTML='<select id="of-sess">'+sessOpts+'</select> <select id="of-sem">'+semOpts+'</select>';
    else valwrap.innerHTML='';
    Array.prototype.forEach.call(valwrap.querySelectorAll('input,select'),function(el){el.onchange=apply;});
  }
  function gather(){
    var b=basisSel.value,p={basis:b},e;
    if(b==='day'){e=valwrap.querySelector('#of-day');p.day=e?e.value:today;}
    else if(b==='week'){e=valwrap.querySelector('#of-week');p.weekStart=e?e.value:today;}
    else if(b==='month'){e=valwrap.querySelector('#of-month');p.month=e?e.value:thisMonth;}
    else if(b==='session'){e=valwrap.querySelector('#of-sess');p.session=e?e.value:'';}
    else if(b==='semester'){var s=valwrap.querySelector('#of-sess'),m=valwrap.querySelector('#of-sem');p.session=s?s.value:'';p.semester=m?m.value:'';}
    if(officeSel&&officeSel.value)p.office=officeSel.value;
    return p;
  }
  function qstr(p){return Object.keys(p).map(function(k){return k+'='+encodeURIComponent(p[k]||'');}).join('&');}
  function apply(){officerReload(gather());}
  basisSel.onchange=function(){buildVal();apply();};
  buildVal();
  bar.querySelector('#of-dl').onclick=function(){doc('/doc/officer-report?'+qstr(gather()));};
  var find=bar.querySelector('#of-find'),fres=bar.querySelector('#of-find-res');var ft;
  find.addEventListener('input',function(){clearTimeout(ft);ft=setTimeout(async function(){
    var q=find.value.trim();fres.innerHTML='';if(q.length<2)return;
    var r=await api('/api/students?q='+encodeURIComponent(q));
    (r.students||[]).forEach(function(s){var c=$('<div class="ev-card" style="display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid #e6eaf0;border-radius:10px;margin-top:6px;cursor:pointer"><div style="flex:1"><b>'+eh(s.name)+'</b><div class="muted" style="font-size:12px">'+eh(s.matric||'—')+' · '+eh(s.department||'—')+'</div></div><span class="badge">Statement →</span></div>');c.onclick=function(){doc('/doc/student-statement/'+s.id);};fres.appendChild(c);});
    if(!(r.students||[]).length)fres.innerHTML='<div class="muted">No match.</div>';
  },200);});
}
function officerReload(period){
  var qs=Object.keys(period||{}).map(function(k){return k+'='+encodeURIComponent(period[k]||'');}).join('&');
  api('/api/officer-report?'+qs).then(function(r){
    if(!r.ok)return;var d=r.data;var w=document.querySelector('.wrap');w.innerHTML='';officerView(w,d);
  });
}
function officerView(w,d){
  var pp=d.profile||{};
  w.appendChild($('<div class="panel"><div class="prof">'+(pp.photo?'<img src="'+pp.photo+'">':'<div class="ph">👤</div>')+'<div><div class="nm">'+eh(pp.full_name||'Officer')+'</div><div class="meta" style="text-transform:capitalize">'+eh((d.role||'').replace("_"," "))+' • '+eh(pp.email||'')+'</div></div></div></div>'));
  officerControls(w,d);
  if(d.kind==='finance'){
    w.appendChild($('<div class="kpis">'+kpi('Collected',mapMoney(d.cards.collected))+kpi('Billed',mapMoney(d.cards.billed))+kpi('Expenses',mapMoney(d.cards.expenses))+kpi('Students',d.cards.students)+kpi('Debtors',d.cards.debtors)+'</div>'));
    // collections grouped by office (who collected)
    if(d.byOffice&&d.byOffice.length){
      w.appendChild($('<div class="panel"><h3>💰 Collections by Office</h3>'+tbl([{t:'Office',f:r=>eh(r.office)},{t:'Collected',r:1,f:r=>mapMoney(r.amounts)}],d.byOffice,'No collections.')+'</div>'));
    }
    var rtitle = d.officeFilter ? 'Payments — '+eh((d.byOffice.find(function(o){return o.role===d.officeFilter;})||{}).office||'office') : 'Recent Payments (all offices)';
    w.appendChild($('<div class="panel"><h3>'+rtitle+'</h3>'+tbl([{t:'Receipt',f:r=>r.receipt_no||'—'},{t:'Student',f:r=>eh(r.student)},{t:'For',f:r=>cap(r.category)},{t:'Office',f:r=>eh(r.office||'—')},{t:'By',f:r=>eh(r.by||'—')},{t:'Date',f:r=>fmt(r.date)},{t:'Amount',r:1,f:r=>money(r.amount,r.currency)}],d.recent,'No payments.')+'</div>'));
    // expenses — all offices
    if(d.expensesByOffice&&d.expensesByOffice.length){
      w.appendChild($('<div class="panel"><h3>📉 Expenses by Office</h3>'+tbl([{t:'Office',f:r=>eh(r.office)},{t:'Spent',r:1,f:r=>mapMoney(r.amounts)}],d.expensesByOffice,'No expenses.')+'</div>'));
    }
    w.appendChild($('<div class="panel"><h3>Expense Records (all offices)</h3>'+tbl([{t:'Category',f:r=>cap(r.category)},{t:'Description',f:r=>eh(r.description||'—')},{t:'Recorded By',f:r=>eh(r.by||'—')},{t:'Date',f:r=>fmt(r.date)},{t:'Amount',r:1,f:r=>money(r.amount,r.currency)}],d.expensesList||[],'No expenses recorded yet.')+'</div>'));
  } else if(d.kind==='registrar'){
    w.appendChild($('<div class="kpis">'+kpi('My Collections',mapMoney(d.collected))+kpi('Students I Billed',d.students.length)+'</div>'));
    w.appendChild($('<div class="panel"><h3>Students I Billed — paid vs owing</h3>'+tbl([{t:'Name',f:r=>r.full_name},{t:'Matric',f:r=>r.matric_no||'—'},{t:'Department',f:r=>r.department||'—'},{t:'Paid',r:1,f:r=>mapMoney(r.paid)},{t:'Owing',r:1,f:r=>'<span class=neg>'+mapMoney(r.owing)+'</span>'}],d.students,'You have not billed anyone yet.')+'</div>'));
  } else if(d.kind==='dean'){
    w.appendChild($('<div class="kpis">'+kpi('Faculty Collections',mapMoney(d.collected))+kpi('My Expenditure',mapMoney(d.expenses))+kpi('Students Owing',d.debtors.length)+'</div>'));
    w.appendChild($('<div class="panel"><h3>Students Owing Faculty Fees</h3>'+tbl([{t:'Name',f:r=>r.full_name},{t:'Matric',f:r=>r.matric_no||'—'},{t:'Department',f:r=>r.department||'—'},{t:'Owing',r:1,f:r=>'<span class=neg>'+mapMoney(r.owing)+'</span>'}],d.debtors,'No student owes faculty fees.')+'</div>'));
  } else if(d.kind==='affairs'&&d.clearance){
    w.appendChild($('<div class="kpis">'+kpi('Clearance Pending',d.clearance.pending)+kpi('Approved',d.clearance.approved)+kpi('Misconduct (open)',d.misconduct.open)+kpi('Misconduct (total)',d.misconduct.total)+'</div>'));
    w.appendChild($('<div class="panel"><h3>Student Affairs</h3><div class="empty">Clearance approvals and discipline are summarised above. Use the desktop app to action items.</div></div>'));
  } else {
    w.appendChild($('<div class="panel"><div class="prof"><div class="ph">👤</div><div><div class="nm">'+((d.profile&&d.profile.full_name)||'Welcome')+'</div><div class="meta" style="text-transform:capitalize">'+(d.role||'staff')+' account</div></div></div></div>'));
    w.appendChild($('<div class="panel"><h3>Dashboard</h3><div class="empty">You are signed in. Your reports and tools are available in the desktop app.</div></div>'));
  }
}
function kpi(l,v){return '<div class="kpi"><div class="l">'+l+'</div><div class="v">'+v+'</div></div>';}
function cap(s){s=String(s||'');return s.charAt(0).toUpperCase()+s.slice(1).replace(/_/g,' ');}
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{});}
if(TOKEN){renderApp().catch(()=>renderLogin());}else{renderLogin();}
</script></body></html>`;

// ----------------------- installable app assets -----------------------
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="104" fill="#1e3a8a"/><text x="50%" y="55%" font-family="Segoe UI,Arial,sans-serif" font-size="220" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">UB</text></svg>`;
const MANIFEST_PORTAL = JSON.stringify({ name: 'UniBursar Portal', short_name: 'Portal', start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#0f1e3d', theme_color: '#1e3a8a', icons: [{ src: '/favicon', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }] });
const MANIFEST_SCAN = JSON.stringify({ name: 'UniBursar Clearance Scanner', short_name: 'Scanner', start_url: '/scan', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#0f1e3d', theme_color: '#0f1e3d', icons: [{ src: '/favicon', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }] });
const SW_JS = `const C='ubu-portal-v2';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/scan','/verify','/icon.svg']).catch(()=>{})).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(Promise.all([caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))),self.clients.claim()]));});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))));});`;

// shared client renderer for verification results (used by /scan and /verify)
const RESULT_JS = `
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(m){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m];});}
function office(o){return ({registrar:'Registrar',dean:'Dean / Faculty Head',student_affairs:'Student Affairs'})[o]||o;}
function row(k,v){return '<tr><td>'+k+'</td><td>'+esc(v||'—')+'</td></tr>';}
function extractId(raw){raw=String(raw||'').trim();var m=/[?&]c=([^&\\s]+)/.exec(raw);if(m)return decodeURIComponent(m[1]);return raw.replace(/^UBU-CLR:/i,'').trim();}
function extractCode(raw){raw=String(raw||'').trim();var m=/[?&]r=([^&\\s]+)/.exec(raw);if(m)return{type:'r',id:decodeURIComponent(m[1])};if(/^UBU-RCT:/i.test(raw))return{type:'r',id:raw.replace(/^UBU-RCT:/i,'').trim()};m=/[?&]c=([^&\\s]+)/.exec(raw);if(m)return{type:'c',id:decodeURIComponent(m[1])};return{type:'c',id:raw.replace(/^UBU-CLR:/i,'').trim()};}
function renderResult(el,d){
  if(!d||!d.valid){el.innerHTML='<div class="rcard invalid"><div class="big">✗ INVALID</div><p>This code does not match any record on file. The document may be forged, altered, or not yet issued.</p><button class="btn" onclick="resetView&&resetView()">Check another</button></div>';return;}
  if(d.kind==='receipt'){var rs=d.student;
    el.innerHTML='<div class="rcard valid">'+
     '<div class="big">✓ GENUINE RECEIPT</div>'+
     '<div class="who">'+(rs.photo?'<img src="'+rs.photo+'" alt="photo">':'<div class="ph">🧾</div>')+'<div><div class="nm">'+esc(rs.name)+'</div><div class="mt">'+esc(rs.matric)+'</div></div></div>'+
     '<table>'+row('Receipt No',d.receipt_no)+row('Amount paid',d.amountText)+row('Paid for',d.category)+row('Narration',d.narration)+row('Method',d.method)+row('Date',d.dateText)+row('Issued by',d.office)+row('Received by',d.receivedBy)+row('Faculty',rs.faculty)+row('Department',rs.department)+row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  if(d.kind==='payslip'){var ps=d.staff;
    el.innerHTML='<div class="rcard valid">'+
     '<div class="big">✓ GENUINE PAYSLIP</div>'+
     '<div class="who">'+(ps.photo?'<img src="'+ps.photo+'" alt="photo">':'<div class="ph">💼</div>')+'<div><div class="nm">'+esc(ps.name)+'</div><div class="mt">'+esc(ps.staffNo)+'</div></div></div>'+
     '<table>'+row('Type',d.staffType)+row('Department',ps.department)+row('Pay period',d.period)+row('Net pay',d.net)+row('Gross',d.gross)+row('Pay date',d.dateText)+row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  if(d.kind==='result'){var rs=d.student;
    el.innerHTML='<div class="rcard valid">'+
     '<div class="big">✓ GENUINE RESULT</div>'+
     '<div class="who">'+(rs.photo?'<img src="'+rs.photo+'" alt="photo">':'<div class="ph">🎓</div>')+'<div><div class="nm">'+esc(rs.name)+'</div><div class="mt">'+esc(rs.matric)+'</div></div></div>'+
     '<table>'+row('Faculty',rs.faculty)+row('Department',rs.department)+row('Level',rs.level)+(d.session?row('Session',d.session):'')+(d.semester?row('Semester',d.semester):'')+row('Courses',String(d.courses))+row('GPA',String(d.gpa))+row('CGPA',String(d.cgpa))+row('Class standing',d.standing)+row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  var s=d.student;var ok=d.completed;var tn=d.typeName||'Examination';var mid=d.clearanceType==='midterm';
  el.innerHTML='<div class="rcard '+(ok?'valid':'warn')+'">'+
   '<div class="big">'+(ok?'✓ CLEARED — '+tn.toUpperCase():'⚠ '+String(d.status||'NOT COMPLETE').toUpperCase())+'</div>'+
   '<div class="who">'+(s.photo?'<img src="'+s.photo+'" alt="photo">':'<div class="ph">🎓</div>')+'<div><div class="nm">'+esc(s.name)+'</div><div class="mt">'+esc(s.matric)+'</div></div></div>'+
   '<table>'+row('Clearance type',tn+' Clearance')+row('Faculty',s.faculty)+row('Department',s.department)+row('Level',s.level)+row('Gender',s.gender)+row('Student status',s.status)+row('Session',d.session)+row('Semester',d.semester)+row('Verification ref',d.ref)+'</table>'+
   '<div class="apps">'+(d.approvals||[]).map(function(a){return '<span class="ap '+(a.status==='approved'?'a':(a.status==='denied'?'x':'p'))+'">'+office(a.office)+': '+a.status+(a.by?(' ('+esc(a.by)+')'):'')+'</span>';}).join('')+'</div>'+
   (ok?'':'<p class="note">Not all offices have approved. Do NOT admit this student to the '+(mid?'mid-semester test':'examination')+'.</p>')+
   '<button class="btn" onclick="resetView&&resetView()">Scan another</button></div>';
}
async function doVerify(el,code){var q=(code&&code.type)?code.type:'c';var id=(code&&code.id!=null)?code.id:code;el.innerHTML='<div class="rcard"><div class="big">Checking…</div></div>';try{var r=await fetch('/api/verify?'+q+'='+encodeURIComponent(id));var d=await r.json();renderResult(el,d);}catch(e){renderResult(el,{valid:false});}}`;

const RESULT_CSS = `
.rcard{background:#fff;border-radius:16px;padding:18px;margin:14px;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.rcard .big{font-size:24px;font-weight:900;text-align:center;padding:8px;border-radius:10px;margin-bottom:12px}
.rcard.valid .big{background:#dcfce7;color:#166534}.rcard.invalid .big{background:#fee2e2;color:#991b1b}.rcard.warn .big{background:#fef9c3;color:#854d0e}
.who{display:flex;gap:14px;align-items:center;margin-bottom:12px}
.who img{width:90px;height:104px;object-fit:cover;border-radius:10px;border:2px solid #1e3a8a}
.who .ph{width:90px;height:104px;border-radius:10px;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:34px}
.who .nm{font-size:20px;font-weight:800}.who .mt{color:#64748b;font-family:monospace;font-weight:700}
.rcard table{width:100%;border-collapse:collapse}.rcard td{padding:7px 4px;border-bottom:1px solid #eef2f7;font-size:14px}
.rcard td:first-child{color:#64748b;width:42%}.rcard td:last-child{font-weight:600}
.apps{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.ap{font-size:11px;font-weight:700;border-radius:999px;padding:4px 10px}.ap.a{background:#dcfce7;color:#166534}.ap.x{background:#fee2e2;color:#991b1b}.ap.p{background:#fff7ed;color:#9a6300}
.note{color:#991b1b;font-weight:700;margin:10px 0}
.btn{display:block;width:100%;margin-top:14px;background:linear-gradient(135deg,#2563eb,#4338ca);color:#fff;border:0;border-radius:10px;padding:13px;font-weight:800;font-size:15px;cursor:pointer}`;

const SCAN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Clearance Scanner</title><link rel="manifest" href="/scan-manifest.webmanifest"><meta name="theme-color" content="#0f1e3d"><link rel="icon" href="/favicon">
<style>*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:#0f1e3d;color:#fff;min-height:100vh}
.bar{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#0b1730;font-size:15px}
.bar #st{font-size:12px;opacity:.85}
.stage{padding:8px}
video{width:100%;max-width:520px;display:block;margin:0 auto;border-radius:14px;background:#000;aspect-ratio:1/1;object-fit:cover}
.controls{display:flex;gap:10px;justify-content:center;margin:12px}
.controls .b{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:800;font-size:15px;cursor:pointer}
.controls .b.ghost{background:#1b2c4d}
.manual{display:flex;gap:8px;max-width:520px;margin:0 auto 6px;padding:0 12px}
.manual input{flex:1;padding:12px;border-radius:10px;border:0;font-size:14px}
.manual .b{background:#1b2c4d;color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:700}
.hint{max-width:520px;margin:6px auto;padding:0 16px;font-size:12.5px;opacity:.8;text-align:center}
#result{max-width:520px;margin:0 auto;color:#0f172a}
${RESULT_CSS}
</style></head><body>
<div class="bar"><b>🛡 Clearance Scanner</b><span id="st">Ready</span></div>
<div class="stage"><video id="v" playsinline muted></video></div>
<div class="controls"><button class="b" id="start">▶ Start camera</button><button class="b ghost" id="stop" style="display:none">■ Stop</button></div>
<div class="manual"><input id="code" placeholder="Or paste the code / link from the certificate" autocomplete="off"><button class="b" id="lk">Verify</button></div>
<div class="hint" id="hint">Point the camera at the QR code on the clearance certificate. The student's photo and details will appear so you can confirm them in person.</div>
<div id="result"></div>
<script>
${RESULT_JS}
var $=function(id){return document.getElementById(id);};
var stream=null,scanning=false,det=null,raf=null;
function setStatus(t){$('st').textContent=t;}
function resetView(){$('result').innerHTML='';setStatus('Ready');}
async function startCam(){
  try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});var v=$('v');v.srcObject=stream;await v.play();$('start').style.display='none';$('stop').style.display='';setStatus('Scanning…');loop();}
  catch(e){setStatus('No camera');$('hint').textContent='Could not open the camera ('+e.message+'). Tip: scan the QR with your phone\\'s built-in camera — it opens the verification page directly — or paste the code below.';}
}
function stopCam(){scanning=false;if(raf)cancelAnimationFrame(raf);if(stream){stream.getTracks().forEach(function(t){t.stop();});stream=null;}$('start').style.display='';$('stop').style.display='none';}
async function loop(){
  if(!stream)return;scanning=true;
  if('BarcodeDetector' in window){
    if(!det)det=new BarcodeDetector({formats:['qr_code']});
    var v=$('v');
    var tick=async function(){if(!scanning)return;try{var codes=await det.detect(v);if(codes&&codes.length){onCode(codes[0].rawValue);return;}}catch(_){}raf=requestAnimationFrame(tick);};
    tick();
  } else {
    $('hint').textContent='In-app scanning is not supported by this browser. Scan the QR with your phone camera (it opens the verification page automatically), or paste the code below.';
    setStatus('Manual mode');
  }
}
function onCode(raw){stopCam();setStatus('Found code');doVerify($('result'),extractCode(raw));}
$('start').onclick=startCam;$('stop').onclick=stopCam;
$('lk').onclick=function(){doVerify($('result'),extractCode($('code').value));};
$('code').addEventListener('keydown',function(e){if(e.key==='Enter')doVerify($('result'),extractCode($('code').value));});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(function(){});
</script></body></html>`;

const VERIFY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Document Verification</title><link rel="icon" href="/favicon"><meta name="theme-color" content="#0f1e3d">
<style>*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:#eef2f8;color:#0f172a;min-height:100vh}
.bar{background:#0f1e3d;color:#fff;padding:14px 16px;font-weight:700}
#result{max-width:560px;margin:0 auto}
.lookup{max-width:560px;margin:14px auto;padding:0 14px;display:flex;gap:8px}
.lookup input{flex:1;padding:12px;border-radius:10px;border:1px solid #cbd5e1}
.lookup .b{background:#1e3a8a;color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:700}
${RESULT_CSS}
</style></head><body>
<div class="bar">🛡 Document Verification</div>
<div class="lookup"><input id="code" placeholder="Clearance or receipt code / link"><button class="b" id="lk">Verify</button></div>
<div id="result"></div>
<script>
${RESULT_JS}
function resetView(){location.href='/scan';}
var el=document.getElementById('result');
var q=new URLSearchParams(location.search);var rr=q.get('r');var pp=q.get('p');var c=q.get('c')||q.get('ref');
document.getElementById('lk').onclick=function(){doVerify(el,extractCode(document.getElementById('code').value));};
if(pp){document.getElementById('code').value=pp;doVerify(el,{type:'p',id:pp});}
else if(rr){document.getElementById('code').value=rr;doVerify(el,{type:'r',id:rr});}
else if(c){document.getElementById('code').value=c;doVerify(el,extractCode(c));}
</script></body></html>`;

