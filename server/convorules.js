'use strict';
/**
 * 🎓 CONVOCATION LIST RULES — pure; shared by the desktop (the Registry publishes the list and sends the
 * congratulation e-mails) and the portal / cloud edge (every student sees the list; graduands find their name).
 *
 *   publicList     the list as students see it: grouped by faculty → department, ordered by class of degree then
 *                  name; graduands who asked to be left off (privacy) are not shown; the class of degree only when
 *                  the Registry chose to show it
 *   checks         what the Registry should look at BEFORE publishing (no e-mail on file, no class of degree,
 *                  not in the Alumni register, a correction still open, the same person twice)
 *   renderMail     the congratulation e-mail from the Registry's subject + message ({{first_name}}, {{programme}},
 *                  {{class}}, {{ceremony}}, {{date}}, {{venue}}, {{reply_by}}, {{portal}}) — every value escaped
 *   nextTry        the retry schedule of a failed e-mail (1 min, 5 min, 30 min, 2 h, 6 h — then it is "failed")
 *   listSig        a short signature of the list, so a phone that already has it downloads nothing
 */
const crypto = require('crypto');

const CLASS_ORDER = ['first', 'second class upper', 'second class (upper', 'upper', 'second class lower', 'second class (lower', 'lower', 'third', 'pass'];
function classRank(c) { const s = String(c || '').toLowerCase(); for (let i = 0; i < CLASS_ORDER.length; i++) if (s.includes(CLASS_ORDER[i])) return i; return CLASS_ORDER.length; }
const fullName = (s) => [s && s.first_name, s && s.middle_name, s && s.last_name].map(x => String(x || '').trim()).filter(Boolean).join(' ');
const alive = (r) => r && !Number(r.deleted);

/**
 * rows: graduands of ONE ceremony; lookups: { student(id), department(id), faculty(id) } → rows or null.
 * → { total, groups: [{ faculty, departments: [{ name, graduands: [{ id, name, classification?, me? }] }] }] }
 */
function publicList(rows, lookups, opts) {
  opts = opts || {};
  const L = lookups || {};
  const showClass = opts.showClass !== false;
  const items = [];
  for (const g of rows || []) {
    if (!alive(g) || Number(g.hide_from_list)) continue;
    const s = L.student ? L.student(g.student_id) : null; if (!alive(s)) continue;
    const d = s.department_id && L.department ? L.department(s.department_id) : null;
    const f = (s.faculty_id || (d && d.faculty_id)) && L.faculty ? L.faculty(s.faculty_id || d.faculty_id) : null;
    items.push({ id: g.id, name: fullName(s) || '—', classification: g.classification || '', dept: (d && d.name) || 'Other programmes', fac: (f && f.name) || 'Other faculties', me: !!(opts.meStudentId && g.student_id === opts.meStudentId) });
  }
  const facs = new Map();
  for (const it of items) { const fm = facs.get(it.fac) || new Map(); const dl = fm.get(it.dept) || []; dl.push(it); fm.set(it.dept, dl); facs.set(it.fac, fm); }
  const groups = [...facs.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([faculty, fm]) => ({
    faculty,
    departments: [...fm.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({
      name,
      graduands: list.sort((a, b) => classRank(a.classification) - classRank(b.classification) || a.name.localeCompare(b.name))
        .map(it => Object.assign({ id: it.id, name: it.name }, showClass && it.classification ? { classification: it.classification } : {}, it.me ? { me: true } : {})),
    })),
  }));
  return { total: items.length, groups };
}

/** A short, stable signature of what a viewer would download (the list + its version). */
function listSig(list, version) { return crypto.createHash('sha256').update(String(version || 0) + '|' + JSON.stringify(list)).digest('base64url').slice(0, 16); }

/**
 * Before publishing. rows: graduands joined with { email, first_name, last_name, matric_no, in_alumni }.
 * → { ready, total, problems: [{ kind, count, names, detail, blocking }] }
 */
function checks(rows) {
  const live = (rows || []).filter(alive);
  const problems = [];
  const add = (kind, list, detail, blocking) => { if (list.length) problems.push({ kind, count: list.length, names: list.slice(0, 8).map(r => fullName(r) + (r.matric_no ? ' (' + r.matric_no + ')' : '')), detail, blocking: !!blocking }); };
  add('no_email', live.filter(r => !/@/.test(String(r.email || ''))), 'no e-mail address on file — they see the list and a notification on the portal, but no congratulation e-mail');
  add('no_class', live.filter(r => !String(r.classification || '').trim()), 'no class of degree');
  add('not_alumni', live.filter(r => r.in_alumni === 0 || r.in_alumni === false), 'not in the Alumni register (added by hand) — check they have truly graduated');
  add('correction', live.filter(r => r.correction_status === 'open'), 'asked for a correction that is not answered yet');
  const seen = new Map(); const dup = [];
  for (const r of live) { const k = String(r.matric_no || '').trim().toLowerCase() || ('id:' + r.student_id); if (seen.has(k)) dup.push(r); else seen.set(k, r); }
  add('duplicate', dup, 'appear twice (same matric number)', true);
  if (!live.length) problems.push({ kind: 'empty', count: 0, names: [], detail: 'the list is empty — import the graduands first', blocking: true });
  return { ready: !problems.some(p => p.blocking), total: live.length, problems };
}

const DEFAULT_SUBJECT = '🎓 Congratulations, {{first_name}} — you are on the convocation list';
const DEFAULT_MESSAGE = 'Dear {{first_name}},\n\nCongratulations! On behalf of the Senate and the whole university community, we are delighted to tell you that your name is on the convocation list for the {{ceremony}}.\n\nProgramme: {{programme}}\nClass of degree: {{class}}\nCeremony: {{date}} · {{venue}}\n\nPlease sign in to the student portal to confirm whether you will attend (reply by {{reply_by}}), choose your gown size, and download your entry pass: {{portal}}\n\nWe are very proud of you.\n\nThe Registrar';
const PLACEHOLDERS = ['first_name', 'name', 'matric', 'programme', 'faculty', 'class', 'ceremony', 'date', 'venue', 'reply_by', 'portal', 'institution'];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (tpl, vars, escape) => String(tpl || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? (escape ? esc(vars[k]) : String(vars[k])) : m));
/** Ceremony date for people ("Saturday 12 December 2026, 10:00"). */
function niceDate(iso) {
  const s = String(iso || ''); const d = new Date(s.length <= 16 && s.includes('T') ? s + ':00' : s); if (isNaN(d)) return s;
  const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return s.includes('T') ? day + ', ' + s.slice(11, 16) : day;
}
/**
 * → { subject, text, html }. vars: { first_name, name, matric, programme, faculty, class, ceremony, date, venue,
 * reply_by, portal, institution }; brand: { name, primary, logo }.
 */
function renderMail(subjectTpl, messageTpl, vars, brand) {
  const v = Object.assign({}, vars); for (const k of PLACEHOLDERS) if (v[k] == null || v[k] === '') v[k] = k === 'class' ? '—' : (k === 'reply_by' ? 'the date shown on the portal' : '');
  const b = brand || {};
  const subject = fill(subjectTpl || DEFAULT_SUBJECT, v, false).replace(/\s+/g, ' ').trim().slice(0, 200);
  const text = fill(messageTpl || DEFAULT_MESSAGE, v, false);
  const body = esc(String(messageTpl || DEFAULT_MESSAGE)).split(/\r?\n/).map(line => fill(line, v, true)).map(line => line.trim() ? '<p style="margin:0 0 10px">' + line.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:' + esc(b.primary || '#1e3a8a') + '">$1</a>') + '</p>' : '').join('');
  const color = /^#[0-9a-f]{3,8}$/i.test(String(b.primary || '')) ? b.primary : '#1e3a8a';
  const logo = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(String(b.logo || '')) || /^https:\/\//.test(String(b.logo || '')) ? '<img src="' + esc(b.logo) + '" alt="" style="height:56px;margin-bottom:6px">' : '';
  const html = '<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">'
    + '<div style="max-width:600px;margin:0 auto;padding:24px 12px"><div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">'
    + '<div style="background:' + color + ';color:#fff;padding:22px;text-align:center">' + logo + '<div style="font-size:13px;opacity:.9">' + esc(b.name || v.institution || '') + '</div><div style="font-size:24px;font-weight:800;margin-top:4px">🎓 Congratulations!</div></div>'
    + '<div style="padding:22px 24px;font-size:15px;line-height:1.55">' + body + '</div>'
    + '<div style="padding:12px 24px;background:#f8fafc;color:#64748b;font-size:12px">You receive this because your name is on the convocation list of ' + esc(b.name || v.institution || 'the university') + '. If any detail is wrong, report a correction on the portal before the ceremony.</div>'
    + '</div></div></body></html>';
  return { subject, text, html };
}

/** When to try a failed e-mail again (ms from now), or null when it has failed for good. */
const RETRY_MIN = [1, 5, 30, 120, 360];
function nextTry(attempts, permanent) { if (permanent) return null; const i = Number(attempts) || 0; return i >= 1 && i <= RETRY_MIN.length ? RETRY_MIN[i - 1] * 60000 : null; }
/** An SMTP / address problem that retrying will not fix. */
const permanentError = (msg) => /reject|invalid|does not exist|unknown user|no such user|mailbox unavailable|5\.1\.[0-9]|\b55[0-9]\b|not configured|check the address/i.test(String(msg || ''));

/** A graduand's correction request (a misspelt name, a wrong class or programme). */
function cleanCorrection(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 5) throw new Error('Say what is wrong, and what it should be (e.g. “My middle name is spelt Chiamaka”).');
  return t.slice(0, 500);
}

module.exports = { classRank, publicList, listSig, checks, DEFAULT_SUBJECT, DEFAULT_MESSAGE, PLACEHOLDERS, renderMail, niceDate, RETRY_MIN, nextTry, permanentError, cleanCorrection };
