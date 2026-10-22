'use strict';
/**
 * 👪 PARENTS IN THE LOOP — ONE pure module (portal · edge · desk) for what a parent / guardian should know about their
 * ward, built from the SAME data the student sees (studentData), in plain words.
 *
 *   digest(d, { now }) → { attention: [item], good: [item], glance }
 *     item = { icon, title, sub, level, go, act }
 *       level: 0 act now · 1 soon · 2 good to know · 3 good news
 *       go:    the section that explains it (fees · results · attendance · research · exam · coursework · registration · liveclasses)
 *       act:   'pay' | 'more_time' | null — what the PARENT can do about it (they pay, and may ask for more time to pay)
 *     glance = { owed: {CUR: n}, cleared, cgpa, attendance (average %), standing }
 *   notice(kind, p) → { title, body } — the parent's own copy of news the student is told (late fee, more time, aid,
 *     the defence, results, attendance).
 *   wantsParent(student) → does this student have a parent / guardian to tell (a parent login or a parent e-mail)?
 *
 * Titles are "Fixed label — detail": the portal (tx) and the app (t on the first part) translate the fixed label, the
 * detail is the ward's own data.
 */

const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const money = (amount, cur) => (cur ? String(cur).toUpperCase() + ' ' : '') + n2(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyMap = (m) => Object.keys(m || {}).filter(k => Number(m[k]) > 0.009).map(k => money(m[k], k)).join(' + ');
const dayOf = (v) => String(v || '').slice(0, 10);
const todayOf = (now) => new Date(now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now))).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(dayOf(b) + 'T00:00:00Z') - Date.parse(dayOf(a) + 'T00:00:00Z')) / 864e5);
const addDays = (ymd, n) => new Date(Date.parse(dayOf(ymd) + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const when = (v) => String(v || '').replace('T', ' ').slice(0, 16);

/** Does this student have a parent / guardian to tell? */
function wantsParent(s) { return !!(s && (String(s.parent_portal_username || '').trim() || String(s.parent_email || '').trim())); }

/** What the parent should know, most urgent first — and the good news. */
function digest(d, opts) {
  const o = opts || {}; const today = todayOf(o.now); const nowMs = o.now == null ? Date.now() : (typeof o.now === 'number' ? o.now : Date.parse(o.now));
  const x = d || {}; const att = []; const good = [];
  const add = (icon, title, sub, level, go, act, extra) => att.push(Object.assign({ icon, title, sub: sub || '', level, go: go || 'overview', act: act || null }, extra || {}));
  const nice = (icon, title, sub, go) => good.push({ icon, title, sub: sub || '', level: 3, go: go || 'overview', act: null });

  // 💳 MONEY — what is owed, the deadlines, holds, installments, proofs the Bursary needs, aid
  const owed = {}; for (const [k, v] of Object.entries(x.balances || {})) if (Number(v) > 0.009) owed[k] = n2(v);
  const cl = x.examClearance || {};
  if (Object.keys(owed).length) add('💳', 'Fees outstanding — ' + moneyMap(owed), cl.cleared ? 'Pay from the Fees page' : 'Not yet cleared for exams — pay to clear', cl.cleared ? 1 : 0, 'fees', 'pay');
  else if (cl.cleared === false && cl.reason) add('🚫', 'Not cleared for exams', String(cl.reason), 0, 'fees');
  for (const f of x.feeDeadlines || []) {
    const t = f.title || 'Fees';
    const askable = f.can_ask ? 'more_time' : 'pay';
    if (f.state === 'late') add('⏰', 'Fee overdue — ' + t, money(f.owed, f.currency) + ' · ' + (f.days_late || 0) + ' day(s) late' + (Number(f.late_fee) > 0 ? ' — a late fee applies' : ''), 0, 'fees', askable, { rule_id: f.rule_id });
    else if (f.state === 'grace') add('⏰', 'Pay before the late fee — ' + t, money(f.owed, f.currency) + ' · grace until ' + (f.grace_until || ''), 0, 'fees', askable, { rule_id: f.rule_id });
    else if (f.state === 'due_soon') add('⏰', 'Fee due soon — ' + t, money(f.owed, f.currency) + ' · due ' + (f.due_date || ''), 1, 'fees', askable, { rule_id: f.rule_id });
    else if (f.state === 'deferred') nice('⏳', 'More time agreed — ' + t, 'until ' + (f.deferred_until || ''), 'fees');
    if (f.extension && f.extension.status === 'requested') add('⏳', 'More time asked — ' + t, 'The Bursary is deciding', 2, 'fees');
    if (f.extension && f.extension.status === 'declined' && f.state !== 'paid') add('⏳', 'More time not agreed — ' + t, f.extension.note || '', 1, 'fees', 'pay');
  }
  const h = x.holds || {};
  if (h.held) add('🔒', 'On hold until fees are paid — ' + (h.labels || []).join(', '), h.reason || '', 0, 'fees', 'pay');
  for (const p of ((x.money || {}).plans || [])) {
    const nx = p.next; if (!nx) continue;
    if (nx.overdue) add('🗓', 'Installment overdue — ' + (p.categoryName || p.category || ''), money(nx.due, p.currency) + ' · was due ' + (nx.due_date || ''), 0, 'fees', 'pay');
    else if (nx.due_date && daysBetween(today, nx.due_date) <= 7) add('🗓', 'Installment due — ' + (p.categoryName || p.category || ''), money(nx.due, p.currency) + ' · due ' + nx.due_date, 1, 'fees', 'pay');
  }
  for (const r of x.payReviews || []) if (r.status === 'awaiting_student') add('🔎', 'Proof needed for a payment — ' + (r.receipt_no || ''), money(r.amount, r.currency) + ' — upload the bank statement or receipt', 0, 'fees');
  for (const a of ((x.finAid || {}).mine || [])) {
    if (a.status === 'awarded') nice('🤝', 'Financial aid awarded — ' + money(a.awarded_amount, a.currency), 'credited to the fees', 'fees');
    else if (a.status === 'declined') add('🤝', 'Financial aid not awarded', a.decline_reason || '', 2, 'fees');
    else if (['submitted', 'recommended'].includes(a.status)) add('🤝', 'Financial aid — being reviewed', (a.ref || '') + ' · ' + money(a.requested, a.currency), 2, 'fees');
  }
  if (!Object.keys(owed).length && cl.cleared !== false && !h.held) nice('✅', 'All fees paid', cl.cleared ? 'cleared for exams' : '', 'fees');

  // 🙋 ATTENDANCE — barred from an exam, below the line, online classes missed
  const A = x.attendance || {}; const thr = Number(A.threshold) || 75;
  const courses = (A.courses || []).filter(c => Number(c.held) > 0);
  for (const c of courses) {
    if (c.eligible === false) add('🙋', 'Barred from an exam — ' + (c.course_code || ''), 'attendance ' + c.pct + '% · needs ' + thr + '%', 0, 'attendance');
    else if (Number(c.held) >= 3 && Number(c.pct) < thr) add('🙋', 'Low attendance — ' + (c.course_code || ''), c.pct + '% · needs ' + thr + '% to sit the exam', 1, 'attendance');
  }
  const avgAtt = courses.length ? Math.round(courses.reduce((s, c) => s + (Number(c.pct) || 0), 0) / courses.length) : null;
  if (courses.length && courses.every(c => c.eligible !== false && Number(c.pct) >= thr)) nice('🙋', 'Attendance on track — ' + avgAtt + '%', courses.length + ' course(s)', 'attendance');
  const missed = ((x.classPlan || {}).catchUp || []).filter(m => dayOf(m.date) >= addDays(today, -14));
  if (missed.length >= 2) add('🎥', 'Online classes missed — ' + missed.length + ' in two weeks', missed.filter(m => m.recording).length + ' recorded — they can catch up on the portal', 2, 'liveclasses');

  // 📊 RESULTS + STANDING + PROGRESS
  const sc = x.scores || {}; const sems = (sc.semesters || []).filter(s => s && s.gpa != null);
  const last = sems[sems.length - 1];
  if (last) {
    const prev = sems[sems.length - 2];
    const trend = prev && prev.gpa != null ? (last.gpa > prev.gpa + 0.009 ? ' · up from ' + prev.gpa.toFixed(2) : last.gpa < prev.gpa - 0.009 ? ' · down from ' + prev.gpa.toFixed(2) : '') : '';
    const line = [last.session, last.semester].filter(Boolean).join(' ') + (sc.cgpa != null ? ' · CGPA ' + Number(sc.cgpa).toFixed(2) : '');
    const title = 'Latest results — GPA ' + Number(last.gpa).toFixed(2) + trend;
    if (prev && last.gpa < prev.gpa - 0.5) add('📊', title, line, 2, 'results');   // a big drop is worth a word
    else nice('📊', title, line, 'results');
  }
  const st = sc.standing || {};
  if (st.status === 'probation') add('⚠️', 'On academic probation', 'a meeting with the adviser helps', 1, 'results');
  else if (st.status === 'withdraw') add('🚫', 'Below the minimum standard', 'see the Registrar', 0, 'results');
  if ((st.outstanding || []).length) add('📚', 'Courses to retake — ' + st.outstanding.slice(0, 6).join(', '), '', 2, 'results');
  if (st.honours) nice('🏅', 'On the honours list — ' + st.honours, '', 'results');
  const dg = x.degree || {};
  if (dg.projection && dg.projection.on_pace === false) add('🎓', 'Behind the expected pace', (dg.percent || 0) + '% of the degree done', 2, 'results');
  // 📝 assignments not handed in, online exams this week
  const notIn = (x.coursework || []).filter(c => !c.mine && (c.state === 'late' || c.state === 'closed'));
  if (notIn.length) add('📝', 'Assignments not handed in — ' + notIn.length, notIn.slice(0, 3).map(c => c.course_code || c.title).filter(Boolean).join(', '), notIn.length >= 3 ? 1 : 2, 'coursework');
  for (const e of x.exams || []) {
    const at = Date.parse(e.start_at || ''); if (!at || e.attempt) continue;
    if (at > nowMs && at - nowMs < 7 * 864e5) add('🖥', 'Online exam — ' + (e.title || e.course_code || ''), when(e.start_at), 2, 'exam');
  }
  if (x.registration && x.registration.open) add('🧾', 'Course registration is open', x.registration.to ? 'closes ' + dayOf(x.registration.to) : '', 1, 'registration');

  // 🎓 THE PROJECT — the defence, its result, corrections
  for (const th of ((x.campus || {}).research || [])) {
    const df = th.defense;
    if (df && !th.outcome) {
      const at = Date.parse(df.date || '');
      if (df.live) add('🎓', 'Project defence — now', [df.mode_label, df.venue].filter(Boolean).join(' · '), 1, 'research');
      else if (at && at > nowMs) add('🎓', 'Project defence — ' + when(df.date), [df.mode_label, df.venue].filter(Boolean).join(' · '), 2, 'research');
    }
    if (th.outcome) nice('🎓', 'Project defence result — ' + th.outcome, th.outcome_note || '', 'research');
    const co = th.corrections;
    if (co && co.state === 'overdue') add('✏️', 'Project corrections overdue', 'were due ' + (co.due || ''), 1, 'research');
    else if (co && co.state === 'due') add('✏️', 'Project corrections due', 'by ' + (co.due || ''), 2, 'research');
  }

  att.sort((a, b) => a.level - b.level);
  return { attention: att, good, glance: { owed, cleared: cl.cleared !== false, cgpa: sc.cgpa != null ? n2(sc.cgpa) : null, attendance: avgAtt, standing: st.status || null } };
}

/** The parent's copy of news the student is told. p.ward = the student's name. */
function notice(kind, p) {
  const q = p || {}; const w = q.ward || 'your ward';
  switch (kind) {
    case 'late_fee': return { title: '⏰ Late fee added — ' + w, body: (q.rule || 'Fees') + ': the deadline was ' + (q.due || '') + '. A late fee of ' + (q.fee || '') + ' was added. You can pay, or ask for more time, from the portal or the app.' };
    case 'more_time': return q.approved
      ? { title: '⏳ More time to pay — until ' + (q.until || ''), body: w + ' — ' + (q.rule || 'Fees') + ': no late fee and no hold until ' + (q.until || '') + '.' + (q.note ? ' ' + q.note : '') }
      : { title: '⏳ More time to pay — not agreed', body: w + ' — ' + (q.rule || 'Fees') + (q.note ? ': ' + q.note : '.') };
    case 'aid_awarded': return { title: '🤝 Financial aid awarded — ' + w, body: (q.amount || '') + ' was credited to the fees.' };
    case 'defense': return { title: (q.moved ? '🗓 Project defence moved — ' : '🎓 Project defence — ') + w, body: (q.when || '') + (q.where ? ' · ' + q.where : '') + (q.title ? ' — ' + q.title : '') };
    case 'defense_result': return { title: '🎓 Project defence result — ' + w, body: (q.outcome || '') + (q.due ? ' — corrections are due by ' + q.due + '.' : '.') };
    case 'attendance': return { title: '🙋 Attendance — ' + w, body: (q.course || '') + ': ' + (q.pct != null ? q.pct + '%' : '') + ' — below the ' + (q.threshold || 75) + '% needed to sit the exam.' };
    case 'results': return { title: '📊 Results released — ' + w, body: (q.line || 'New results are on the portal.') };
    default: return { title: '🔔 ' + w, body: q.body || '' };
  }
}

module.exports = { digest, notice, wantsParent, money, moneyMap };
