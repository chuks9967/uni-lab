'use strict';
/**
 * 🎓 PAYMENT STATUS CENSUS — for one session, every current student: billed, paid, and where they stand — fully paid,
 * part paid, not paid, not billed, or overpaid — counted by faculty, department and level, with the students behind each
 * number. ONE set of rules shared by the desk (electron/services/acctreports.js, rows from SQL) and the portal / app
 * office mode (server/portal.js, synced rows), so a dean's phone and the Bursary's desk show the same counts.
 *
 * Pure: hand it the rows (students, the session's charges and payments, names), it hands back the census.
 * Money stays in its own currency; a student billed in two currencies is fully paid only when both are settled.
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const GONE = new Set(['alumni', 'graduated', 'withdrawn', 'expelled', 'deceased', 'inactive']);
const STATUSES = ['fully_paid', 'part_paid', 'not_paid', 'not_billed', 'overpaid'];
const LABEL = { fully_paid: 'Fully paid', part_paid: 'Part paid', not_paid: 'Not paid', not_billed: 'Not billed', overpaid: 'Overpaid (in credit)' };
const TOL = 0.5;   // half a unit of currency: rounding is not a debt

/** Is this a current student (counted in the census)? */
const current = (s) => s && !Number(s.deleted) && !GONE.has(String(s.status || 'active').toLowerCase());

/** One student's position for the session: per currency billed / paid / owing, and the status. */
function standing(billed, paid) {
  const curs = [...new Set([...Object.keys(billed), ...Object.keys(paid)])];
  const money = {}; let anyBill = false, anyPaid = false, allSettled = true, over = false;
  for (const c of curs) {
    const b = r2(billed[c]), p = r2(paid[c]); money[c] = { billed: b, paid: p, owing: r2(b - p) };
    if (b > TOL) anyBill = true; if (p > TOL) anyPaid = true;
    if (b - p > TOL) allSettled = false; if (p - b > TOL) over = true;
  }
  const status = !anyBill ? (anyPaid ? 'overpaid' : 'not_billed') : allSettled ? (over ? 'overpaid' : 'fully_paid') : anyPaid ? 'part_paid' : 'not_paid';
  return { status, money };
}

/**
 * rows: { students, charges, payments } (charges / payments already limited to the session — or pass session_id to
 *        filter here), names: { faculties, departments, levels } as id → name maps, deptFaculty: department id → faculty id.
 * opts: { session_id, scope: { faculty_id | department_id | campus_id }, group: 'faculty' | 'department' | 'level',
 *         listFor: { status, key } (the students behind one number), top: n (largest balances) }
 */
function census(rows = {}, opts = {}) {
  const names = opts.names || {}; const deptFac = opts.deptFaculty || {};
  const facOf = (s) => (s.department_id && deptFac[s.department_id]) || s.faculty_id || '';
  const sc = opts.scope || {};
  const inScope = (s) => current(s) && (!sc.faculty_id || facOf(s) === sc.faculty_id) && (!sc.department_id || s.department_id === sc.department_id) && (!sc.campus_id || s.campus_id === sc.campus_id);
  const studs = (rows.students || []).filter(inScope); const ids = new Set(studs.map(s => s.id));
  const sess = opts.session_id || null;
  const billed = {}, paid = {};
  for (const c of rows.charges || []) { if (!c || Number(c.deleted) || !ids.has(c.student_id) || (sess && c.session_id !== sess)) continue; const m = (billed[c.student_id] = billed[c.student_id] || {}); m[c.currency] = (m[c.currency] || 0) + Number(c.amount || 0); }
  for (const p of rows.payments || []) { if (!p || Number(p.deleted) || p.status !== 'completed' || !ids.has(p.student_id) || (sess && p.session_id !== sess)) continue; const m = (paid[p.student_id] = paid[p.student_id] || {}); m[p.currency] = (m[p.currency] || 0) + Number(p.amount || 0); }
  const group = ['faculty', 'department', 'level'].includes(opts.group) ? opts.group : (sc.department_id ? 'level' : sc.faculty_id ? 'department' : 'faculty');
  const keyOf = (s) => group === 'faculty' ? facOf(s) : group === 'department' ? (s.department_id || '') : (s.level_id || '');
  const nameOf = (k) => { const m = group === 'faculty' ? names.faculties : group === 'department' ? names.departments : names.levels; return k ? ((m && m[k]) || 'Unknown') : 'Not set'; };
  const blank = () => ({ students: 0, counts: Object.fromEntries(STATUSES.map(x => [x, 0])), money: {} });
  const add = (t, st) => { t.students++; t.counts[st.status]++; for (const [c, m] of Object.entries(st.money)) { const x = (t.money[c] = t.money[c] || { billed: 0, paid: 0, owing: 0 }); x.billed = r2(x.billed + m.billed); x.paid = r2(x.paid + m.paid); x.owing = r2(x.owing + Math.max(0, m.owing)); } };
  const total = blank(); const groups = new Map(); const per = [];
  for (const s of studs) {
    const st = standing(billed[s.id] || {}, paid[s.id] || {}); const k = keyOf(s);
    add(total, st); if (!groups.has(k)) groups.set(k, Object.assign(blank(), { key: k, label: nameOf(k) })); add(groups.get(k), st);
    per.push({ s, st, k });
  }
  const pct = (t) => Object.fromEntries(STATUSES.map(x => [x, t.students ? Math.round(t.counts[x] / t.students * 1000) / 10 : 0]));
  const shape = (t) => Object.assign(t, { pct: pct(t), rate: Object.fromEntries(Object.entries(t.money).map(([c, m]) => [c, m.billed > 0 ? r2(m.paid / m.billed) : null])) });
  const person = (x) => ({ id: x.s.id, name: [x.s.first_name, x.s.last_name].filter(Boolean).join(' '), matric_no: x.s.matric_no || '', department: (names.departments || {})[x.s.department_id] || '', level: (names.levels || {})[x.s.level_id] || '', phone: x.s.phone || x.s.parent_phone || '', status: x.st.status, money: x.st.money });
  const out = { session_id: sess, group, labels: LABEL, statuses: STATUSES, total: shape(total), groups: [...groups.values()].map(shape).sort((a, b) => a.label.localeCompare(b.label)) };
  if (opts.listFor) {
    const lf = opts.listFor; const list = per.filter(x => (!lf.status || x.st.status === lf.status) && (lf.key == null || x.k === lf.key)).map(person);
    list.sort((a, b) => Math.max(0, ...Object.values(b.money).map(m => m.owing)) - Math.max(0, ...Object.values(a.money).map(m => m.owing)) || a.name.localeCompare(b.name));
    out.list = list.slice(0, opts.listMax || 2000); out.list_total = list.length;
  }
  if (opts.top) {
    out.top_owing = per.filter(x => Object.values(x.st.money).some(m => m.owing > TOL)).map(person)
      .sort((a, b) => Math.max(...Object.values(b.money).map(m => m.owing)) - Math.max(...Object.values(a.money).map(m => m.owing))).slice(0, opts.top);
  }
  return out;
}

/** The current session from a list of sessions (the one marked current, else the latest that has started). */
function currentSession(sessions, today) {
  const t = today || new Date().toISOString().slice(0, 10); const live = (sessions || []).filter(x => x && !Number(x.deleted));
  return live.find(x => Number(x.is_current)) || live.filter(x => String(x.start_date || '') <= t).sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || '')))[0] || live[0] || null;
}

module.exports = { census, standing, currentSession, current, STATUSES, LABEL, TOL };
