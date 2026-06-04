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
  const KEY = secret || 'unibursar-portal';

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
  const ROLE_OFFICE = { registrar: 'Office of the Registrar', accountant: 'Office of the Bursar', dean: 'Office of the Faculty Head', admin: 'Administration', student_affairs: 'Office of Student Affairs' };

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
    // exam clearance status: full clearance, else active partial, else not cleared
    const clr = (() => {
      const full = all('exam_clearances').find(c => c.student_id === s.id && c.status === 'completed');
      if (full) return { cleared: true, type: 'full' };
      const partial = all('partial_clearances').find(p => p.student_id === s.id && p.status === 'active');
      if (partial) return { cleared: true, type: 'partial', reason: partial.reason };
      const owes = Object.values(balancesFor(s.id)).some(v => v > 0.001);
      return { cleared: false, type: null, reason: owes ? 'Outstanding fees not cleared' : 'No examination clearance issued' };
    })();
    const validations = all('exam_validations').filter(v => v.student_id === s.id)
      .map(v => ({ status: v.status, reason: v.reason, exam_type: v.exam_type, date: v.created_at, session: nameOf('academic_sessions', v.session_id), semester: nameOf('semesters', v.semester_id) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return {
      profile: studentProfile(s),
      balances: balancesFor(s.id),
      examClearance: clr,
      validations,
      charges: charges.map(c => ({ id: c.id, category: c.category, description: c.description, currency: c.currency, amount: c.amount, date: c.created_at, by: userName(c.created_by) })),
      payments: pays.map(p => ({ id: p.id, receipt_no: p.receipt_no, category: p.category, currency: p.currency, amount: p.amount, method: p.method, date: p.decided_at || p.created_at, office: ROLE_OFFICE[p.raised_role] || 'Office of the Bursar', collector: userName(p.decided_by || p.raised_by) })),
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

  function officerData(u) {
    const role = u.role;
    const completed = all('payments').filter(p => p.status === 'completed');
    const out = { profile: { id: u.id, full_name: u.full_name, role, email: u.email } };
    if (role === 'accountant' || role === 'admin') {
      const collected = {}; const billed = {}; const expenses = {};
      for (const p of completed) collected[p.currency] = (collected[p.currency] || 0) + p.amount;
      for (const c of all('charges')) billed[c.currency] = (billed[c.currency] || 0) + c.amount;
      for (const e of all('expenses')) expenses[e.currency] = (expenses[e.currency] || 0) + e.amount;
      const students = all('students').filter(s => s.status !== 'alumni');
      let debtors = 0; for (const s of students) if (Object.values(balancesFor(s.id)).some(v => v > 0.001)) debtors++;
      out.kind = 'finance';
      out.cards = { collected, billed, expenses, students: students.length, debtors };
      out.recent = completed.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 20)
        .map(p => ({ receipt_no: p.receipt_no, student: studentName(p.student_id), category: p.category, amount: p.amount, currency: p.currency, date: p.decided_at || p.created_at }));
    } else if (role === 'registrar') {
      out.kind = 'registrar';
      out.collected = {}; const cat = {};
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) { out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount; }
      const ids = [...new Set(all('charges').filter(c => c.created_by === u.id).map(c => c.student_id))];
      out.students = ids.map(sid => billedSummary(sid, u.id)).filter(Boolean);
    } else if (role === 'dean') {
      out.kind = 'dean'; out.collected = {}; out.expenses = {};
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount;
      for (const e of all('expenses')) if (e.recorded_by === u.id) out.expenses[e.currency] = (out.expenses[e.currency] || 0) + e.amount;
      const inFac = all('students').filter(s => s.faculty_id === u.faculty_id && s.status !== 'alumni');
      out.debtors = [];
      for (const s of inFac) {
        const bal = {};
        for (const c of studentCharges(s.id)) if (['faculty_due', 'custom'].includes(c.category)) bal[c.currency] = (bal[c.currency] || 0) + c.amount;
        for (const p of studentPaymentsCompleted(s.id)) if (['faculty_due', 'custom'].includes(p.category)) bal[p.currency] = (bal[p.currency] || 0) - p.amount;
        const owing = {}; for (const k of Object.keys(bal)) if (bal[k] > 0.001) owing[k] = bal[k];
        if (Object.keys(owing).length) out.debtors.push({ full_name: studentName(s.id), matric_no: s.matric_no, department: nameOf('departments', s.department_id), owing });
      }
    } else { // student_affairs
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
    return {
      valid: true, completed: c.status === 'completed', status: c.status,
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

  // ---- documents (printable HTML) ----
  function inst() { return institution ? institution() : { name: 'UniBursar', short: 'UBU', logo: '', motto: '' }; }
  function docShell(title, body) {
    const i = inst();
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;margin:0;padding:24px;font-size:13px;background:#f1f5f9}
    .sheet{max-width:820px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:26px;box-shadow:0 8px 30px rgba(15,23,42,.08)}
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
    <body><div class="pbar"><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
    <div class="sheet"><div class="head">${i.logo ? `<img class="logo" src="${i.logo}">` : `<div class="mono">${esc((i.short || 'U').slice(0, 3))}</div>`}<h1>${esc(i.name)}</h1><div class="t">${esc(title)}</div></div>${body}</div></body></html>`;
  }

  function receiptHTML(p) {
    const s = one('students', p.student_id) || {};
    const cur = p.currency;
    const office = ROLE_OFFICE[p.raised_role] || 'Office of the Bursar';
    // line + balances in this currency
    const billedCat = studentCharges(p.student_id).filter(c => c.category === p.category && c.currency === cur).reduce((a, c) => a + c.amount, 0);
    const paidCat = studentPaymentsCompleted(p.student_id).filter(x => x.category === p.category && x.currency === cur).reduce((a, x) => a + x.amount, 0);
    const lineRate = billedCat > 0 ? billedCat : p.amount;
    const chargesCur = studentCharges(p.student_id).filter(c => c.currency === cur).reduce((a, c) => a + c.amount, 0);
    const paidCur = studentPaymentsCompleted(p.student_id).filter(x => x.currency === cur).reduce((a, x) => a + x.amount, 0);
    const newBal = chargesCur - paidCur; const prevBal = newBal + p.amount;
    const f = (l1, v1, l2, v2) => `<tr><td style="color:#64748b">${l1}</td><td><b>${esc(v1 || '—')}</b></td><td style="color:#64748b">${l2}</td><td><b>${esc(v2 || '—')}</b></td></tr>`;
    const body = `${s.photo ? `<img class="photo" src="${s.photo}">` : ''}
      <div class="grid" style="margin-bottom:8px"><div class="f"><span>Receipt No</span><b>${esc(p.receipt_no || '—')}</b></div><div class="f"><span>Issued By</span><b>${esc(office)}</b></div>
        <div class="f"><span>Date</span><b>${fmtDate(p.decided_at || p.created_at)}</b></div><div class="f"><span>Method</span><b>${esc(String(p.channel || p.method || 'cash').toUpperCase())}</b></div></div>
      <div class="bar">Student Details</div>
      <table><tbody>
        ${f("Student", `${s.first_name || ''} ${s.last_name || ''}`, 'Matric No', s.matric_no)}
        ${f('Faculty', nameOf('faculties', s.faculty_id), 'Department', nameOf('departments', s.department_id))}
        ${f('Level', nameOf('levels', s.level_id), 'Email', s.email)}
      </tbody></table>
      <div class="bar">Payment Breakdown</div>
      <table><thead><tr><th>Description</th><th class="r">Amount (${esc(cur)})</th><th class="r">Paid Now</th><th class="r">Balance After</th></tr></thead>
        <tbody><tr><td>${esc(p.description || (p.category[0].toUpperCase() + p.category.slice(1) + ' Fee'))}</td><td class="r">${money(lineRate, cur)}</td><td class="r"><b>${money(p.amount, cur)}</b></td><td class="r">${money(lineRate - paidCat, cur)}</td></tr></tbody></table>
      <div class="tot">TOTAL PAID: ${money(p.amount, cur)}</div>
      <div class="bar">Payment Summary</div>
      <table><tbody>
        <tr><td style="color:#64748b">Amount In Words</td><td class="words" colspan="3">${esc(amountWords(p.amount, cur))}</td></tr>
        ${f('Previous Balance', money(prevBal, cur), 'New Balance', money(newBal, cur))}
      </tbody></table>
      <p style="margin-top:26px;color:#64748b;font-size:11px">Received by ${esc(office)} • This is a computer-generated receipt and mirrors the official receipt issued in the bursary.</p>`;
    return docShell('Payment Receipt', body);
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

  function payslipHTML(slip) {
    const run = one('payroll_runs', slip.run_id) || {}; const s = one('staff', slip.staff_id) || {};
    const cur = slip.currency || s.currency;
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
      <p style="margin-top:8px" class="words">${esc(amountWords(slip.net, cur))}</p>`;
    return docShell((s.staff_type === 'lecturer' ? 'Lecturer' : 'Staff') + ' Payslip', body);
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

    if (p === '/' && method === 'GET') { H(res, 200, PAGE); return true; }
    if (p === '/api/version' && method === 'GET') { J(res, 200, { version: getVersion() }); return true; }
    if (p === '/api/branding' && method === 'GET') { const i = inst(); return J(res, 200, { ok: true, name: i.name, short: i.short, logo: i.logo, motto: i.motto }); }

    // ---- installable app assets + public clearance verification (no login) ----
    if (method === 'GET' && p === '/manifest.webmanifest') return S(res, 200, MANIFEST_PORTAL, 'application/manifest+json');
    if (method === 'GET' && p === '/scan-manifest.webmanifest') return S(res, 200, MANIFEST_SCAN, 'application/manifest+json');
    if (method === 'GET' && p === '/sw.js') return S(res, 200, SW_JS, 'application/javascript');
    if (method === 'GET' && p === '/icon.svg') return S(res, 200, ICON_SVG, 'image/svg+xml');
    if (method === 'GET' && p === '/scan') return H(res, 200, SCAN_PAGE);
    if (method === 'GET' && p === '/verify') return H(res, 200, VERIFY_PAGE);
    if (method === 'GET' && p === '/api/verify') {
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
      if (type === 'statement' && t.k === 'student') { const s = accountById('student', t.id); return H(res, 200, statementHTML(s)), true; }
      if (type === 'receipt') {
        const pay = one('payments', id);
        if (!pay) return H(res, 404, '<p>Receipt not found.</p>');
        if (t.k === 'student' && pay.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'staff') return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, receiptHTML(pay)), true;
      }
      if (type === 'payslip') {
        const slip = one('payslips', id);
        if (!slip) return H(res, 404, '<p>Payslip not found.</p>');
        if (t.k === 'staff' && slip.staff_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'student') return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, payslipHTML(slip)), true;
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
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1e3a8a"><link rel="icon" href="/icon.svg">
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
.pbanner{background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:12px;padding:11px 16px;margin-bottom:14px;font-size:13.5px}
.exbar{border-radius:12px;padding:13px 16px;margin-bottom:14px;font-weight:800;text-align:center;letter-spacing:.3px;font-size:15px}
.exbar.ok{background:#dcfce7;color:#166534;border:1px solid #86efac}
.exbar.warn{background:#fef9c3;color:#854d0e;border:1px solid #fde68a}
.exbar.bad{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}
@media(max-width:560px){.top .rl{display:none}}
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
  TIMER=setInterval(async()=>{try{const v=(await api('/api/version')).version;if(v!==VER){VER=v;renderApp();}}catch(_){}},5000);
}
function tbl(cols,rows,empty){if(!rows||!rows.length)return '<div class="empty">'+(empty||'Nothing to show.')+'</div>';return '<table><thead><tr>'+cols.map(c=>'<th class="'+(c.r?'r':'')+'">'+c.t+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+cols.map(c=>'<td class="'+(c.r?'r':'')+'">'+c.f(row)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';}
function doc(path){window.open(path+(path.includes('?')?'&':'?')+'t='+encodeURIComponent(TOKEN),'_blank');}

function studentView(w,d){
  const p=d.profile;
  if(d.parentView){w.appendChild($('<div class="pbanner">👨‍👩‍👧 Parent/Guardian view — you are viewing the records of <b>'+(p.full_name||'your ward')+'</b>.</div>'));}
  w.appendChild($('<div class="panel"><div class="prof">'+(p.photo?'<img src="'+p.photo+'">':'<div class="ph">🎓</div>')+'<div><div class="nm">'+p.full_name+'</div><div class="meta">'+(p.matric_no||'Matric pending')+' · '+(p.department||'—')+' · '+(p.level||'—')+'</div><div class="meta">'+(p.faculty||'')+' · '+(p.email||'')+'</div></div></div></div>'));
  // exam clearance status banner
  var clr=d.examClearance||{};
  var cls=clr.cleared?(clr.type==='partial'?'warn':'ok'):'bad';
  var ctxt=clr.cleared?(clr.type==='partial'?'⚠ PARTIALLY CLEARED for exams — you still owe fees':'✓ CLEARED for examinations'):('✗ NOT CLEARED for exams — '+(clr.reason||'no clearance'));
  w.appendChild($('<div class="exbar '+cls+'">'+ctxt+'</div>'));
  w.appendChild($('<div class="kpis"><div class="kpi"><div class="l">Outstanding Balance</div><div class="v neg">'+mapMoney(d.balances)+'</div></div><div class="kpi"><div class="l">Total Paid</div><div class="v">'+d.payments.length+' receipt(s)</div></div><div class="kpi"><div class="l">Exam Status</div><div class="v" style="font-size:15px">'+(clr.cleared?(clr.type==='partial'?'Partial':'Cleared'):'Not cleared')+'</div></div></div>'));
  w.appendChild($('<div style="margin-bottom:14px"><button class="btn sm" onclick="doc(\\'/doc/statement\\')">📄 Download full statement (all fees & payments)</button></div>'));
  w.appendChild($('<div class="panel"><h3>Outstanding Fees (charged by all offices)</h3>'+tbl([{t:'Fee Category',f:r=>cap(r.category)},{t:'Currency',f:r=>r.currency},{t:'Billed',r:1,f:r=>money(r.billed,r.currency)},{t:'Paid',r:1,f:r=>money(r.paid,r.currency)},{t:'Outstanding',r:1,f:r=>'<span class=neg>'+money(r.outstanding,r.currency)+'</span>'}],d.outstanding,'You owe nothing. 🎉')+'</div>'));
  w.appendChild($('<div class="panel"><h3>All Fees & Charges</h3>'+tbl([{t:'Date',f:r=>fmt(r.date)},{t:'Description',f:r=>r.description||cap(r.category)},{t:'Category',f:r=>cap(r.category)},{t:'Set By',f:r=>r.by||'—'},{t:'Amount',r:1,f:r=>money(r.amount,r.currency)}],d.charges,'No charges yet.')+'</div>'));
  w.appendChild($('<div class="panel"><h3>Payment History &amp; Receipts</h3>'+tbl([{t:'Receipt',f:r=>r.receipt_no||'—'},{t:'Date',f:r=>fmt(r.date)},{t:'For',f:r=>cap(r.category)},{t:'Collected By',f:r=>(r.collector?r.collector+'<br>':'')+'<span class="muted" style="font-size:11px">'+(r.office||'')+'</span>'},{t:'Amount',r:1,f:r=>money(r.amount,r.currency)},{t:'',r:1,f:r=>r.receipt_no?'<button class="btn sm" onclick="doc(\\'/doc/receipt/'+r.id+'\\')">Receipt</button>':''}],d.payments,'No payments yet.')+'</div>'));
  if(d.validations&&d.validations.length){
    w.appendChild($('<div class="panel"><h3>Exam Validation History</h3>'+tbl([{t:'Date',f:r=>fmt(r.date)},{t:'Type',f:r=>cap(r.exam_type||'exam')},{t:'Session',f:r=>(r.session||'—')+(r.semester?(' · '+r.semester):'')},{t:'Result',f:r=>'<span class="'+(r.status==='valid'?'pos':'neg')+'" style="font-weight:800">'+(r.status==='valid'?'CLEARED':'DENIED')+'</span>'},{t:'Reason',f:r=>r.reason||'—'}],d.validations,'No validations yet.')+'</div>'));
  }
}
function staffView(w,d){
  const p=d.profile;
  w.appendChild($('<div class="panel"><div class="prof">'+(p.photo?'<img src="'+p.photo+'">':'<div class="ph">👤</div>')+'<div><div class="nm">'+p.full_name+' <span class="badge">'+p.type+'</span></div><div class="meta">'+(p.staff_no||'—')+' · '+(p.position||p.title||'—')+'</div><div class="meta">'+(p.department||p.faculty||'')+' · '+(p.email||'')+'</div></div></div></div>'));
  w.appendChild($('<div class="kpis"><div class="kpi"><div class="l">Base / Default Pay</div><div class="v">'+money(p.base_salary,p.currency)+'</div></div><div class="kpi"><div class="l">Payslips</div><div class="v">'+d.payslips.length+'</div></div><div class="kpi"><div class="l">Bank</div><div class="v" style="font-size:15px">'+(p.bank_name||'—')+'</div></div></div>'));
  w.appendChild($('<div class="panel"><h3>My Payslips</h3>'+tbl([{t:'Period',f:r=>r.period||'—'},{t:'Type',f:r=>cap(r.run_type||'staff')},{t:'Status',f:r=>'<span class="badge">'+cap(r.status||'draft')+'</span>'},{t:'Net Pay',r:1,f:r=>money(r.net,r.currency)},{t:'',r:1,f:r=>'<button class="btn sm" onclick="doc(\\'/doc/payslip/'+r.id+'\\')">Payslip</button>'}],d.payslips,'No payslips yet.')+'</div>'));
}
function officerView(w,d){
  if(d.kind==='finance'){
    w.appendChild($('<div class="kpis">'+kpi('Collected',mapMoney(d.cards.collected))+kpi('Billed',mapMoney(d.cards.billed))+kpi('Expenses',mapMoney(d.cards.expenses))+kpi('Students',d.cards.students)+kpi('Debtors',d.cards.debtors)+'</div>'));
    w.appendChild($('<div class="panel"><h3>Recent Payments</h3>'+tbl([{t:'Receipt',f:r=>r.receipt_no||'—'},{t:'Student',f:r=>r.student},{t:'For',f:r=>cap(r.category)},{t:'Date',f:r=>fmt(r.date)},{t:'Amount',r:1,f:r=>money(r.amount,r.currency)}],d.recent,'No payments.')+'</div>'));
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
const MANIFEST_PORTAL = JSON.stringify({ name: 'UniBursar Portal', short_name: 'Portal', start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#0f1e3d', theme_color: '#1e3a8a', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] });
const MANIFEST_SCAN = JSON.stringify({ name: 'UniBursar Clearance Scanner', short_name: 'Scanner', start_url: '/scan', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#0f1e3d', theme_color: '#0f1e3d', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] });
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
function renderResult(el,d){
  if(!d||!d.valid){el.innerHTML='<div class="rcard invalid"><div class="big">✗ INVALID</div><p>This code does not match any clearance on record. The certificate may be forged, altered, or not yet issued.</p><button class="btn" onclick="resetView&&resetView()">Scan another</button></div>';return;}
  var s=d.student;var ok=d.completed;
  el.innerHTML='<div class="rcard '+(ok?'valid':'warn')+'">'+
   '<div class="big">'+(ok?'✓ CLEARED':'⚠ '+String(d.status||'NOT COMPLETE').toUpperCase())+'</div>'+
   '<div class="who">'+(s.photo?'<img src="'+s.photo+'" alt="photo">':'<div class="ph">🎓</div>')+'<div><div class="nm">'+esc(s.name)+'</div><div class="mt">'+esc(s.matric)+'</div></div></div>'+
   '<table>'+row('Faculty',s.faculty)+row('Department',s.department)+row('Level',s.level)+row('Gender',s.gender)+row('Student status',s.status)+row('Session',d.session)+row('Semester',d.semester)+row('Verification ref',d.ref)+'</table>'+
   '<div class="apps">'+(d.approvals||[]).map(function(a){return '<span class="ap '+(a.status==='approved'?'a':(a.status==='denied'?'x':'p'))+'">'+office(a.office)+': '+a.status+(a.by?(' ('+esc(a.by)+')'):'')+'</span>';}).join('')+'</div>'+
   (ok?'':'<p class="note">Not all offices have approved. Do NOT admit this student to the examination.</p>')+
   '<button class="btn" onclick="resetView&&resetView()">Scan another</button></div>';
}
async function doVerify(el,id){el.innerHTML='<div class="rcard"><div class="big">Checking…</div></div>';try{var r=await fetch('/api/verify?c='+encodeURIComponent(id));var d=await r.json();renderResult(el,d);}catch(e){renderResult(el,{valid:false});}}`;

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
<title>Clearance Scanner</title><link rel="manifest" href="/scan-manifest.webmanifest"><meta name="theme-color" content="#0f1e3d"><link rel="icon" href="/icon.svg">
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
function onCode(raw){stopCam();setStatus('Found code');doVerify($('result'),extractId(raw));}
$('start').onclick=startCam;$('stop').onclick=stopCam;
$('lk').onclick=function(){doVerify($('result'),extractId($('code').value));};
$('code').addEventListener('keydown',function(e){if(e.key==='Enter')doVerify($('result'),extractId($('code').value));});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(function(){});
</script></body></html>`;

const VERIFY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clearance Verification</title><link rel="icon" href="/icon.svg"><meta name="theme-color" content="#0f1e3d">
<style>*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:#eef2f8;color:#0f172a;min-height:100vh}
.bar{background:#0f1e3d;color:#fff;padding:14px 16px;font-weight:700}
#result{max-width:560px;margin:0 auto}
.lookup{max-width:560px;margin:14px auto;padding:0 14px;display:flex;gap:8px}
.lookup input{flex:1;padding:12px;border-radius:10px;border:1px solid #cbd5e1}
.lookup .b{background:#1e3a8a;color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:700}
${RESULT_CSS}
</style></head><body>
<div class="bar">🛡 Clearance Verification</div>
<div class="lookup"><input id="code" placeholder="Clearance code / link"><button class="b" id="lk">Verify</button></div>
<div id="result"></div>
<script>
${RESULT_JS}
function resetView(){location.href='/scan';}
var el=document.getElementById('result');
var q=new URLSearchParams(location.search);var c=q.get('c')||q.get('ref');
document.getElementById('lk').onclick=function(){doVerify(el,extractId(document.getElementById('code').value));};
if(c){document.getElementById('code').value=c;doVerify(el,extractId(c));}
</script></body></html>`;

