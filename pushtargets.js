'use strict';
/**
 * 📲 PUSH TARGETS — who a phone belongs to, and which phones a record should reach. Pure; shared by the Node hub
 * (server/server.js) and the cloud edge (supabase/functions/server/index.ts) so both deliver to the same people.
 *
 * A phone registers as the account that signed in on it. Its TARGET KEY is what notifications and conversations
 * address:  a student → the student id · a lecturer / staff member → the staff id · a parent → 'p:' + the ward's
 * student id (a parent and their child sign in with the same student row, and must never get each other's pushes).
 *   notifications.target_user  is already one of these keys;
 *   a conversation member  s:<id> / st:<id> / p:<id>  maps onto them (offices u:… use the desktop bell, not a phone).
 */
const SEGS = new Set(['overview', 'fees', 'receipts', 'results', 'documents', 'clearance', 'finalclr', 'exam', 'messages', 'announcements', 'coursework', 'liveclasses',
  'timetable', 'attendance', 'forums', 'elections', 'adviser', 'requests', 'payreviews', 'money', 'hostel', 'registration', 'campuslife', 'facilities', 'appointments',
  'research', 'placement', 'evaluation', 'discipline', 'notifications', 'library', 'libloans', 'convocation', 'verifications', 'services', 'payslips', 'classes', 'advances', 'call', 'statement', 'report']);

/** The target key a registered phone answers to (null for an account that has no phone app). */
function deviceKey(acct) {
  if (!acct) return null;
  if (typeof acct === 'string') return acct || null;   // legacy: a bare student id
  const id = acct.id == null ? '' : String(acct.id); if (!id) return null;
  if (acct.kind === 'parent') return 'p:' + id;
  if (acct.kind === 'student' || acct.kind === 'staff' || acct.kind === 'user') return id;   // an office user on the app answers to their user id
  return null;
}
/** The phones (target keys) of a conversation's members, never the sender's own. */
function chatTargets(members, senderKey) {
  const out = [];
  for (const k of Array.isArray(members) ? members : []) {
    if (typeof k !== 'string' || k === senderKey) continue;
    if (k.startsWith('s:')) out.push(k.slice(2));
    else if (k.startsWith('st:')) out.push(k.slice(3));
    else if (k.startsWith('p:')) out.push(k);
    else if (k.startsWith('u:')) out.push(k.slice(2));   // an office user with the app
  }
  return [...new Set(out)];
}
/** A student's fee / payment news reaches the student and their parent's phone. */
function familyTargets(studentId) { return studentId ? [String(studentId), 'p:' + studentId] : []; }
/** Where a tapped notification opens: the section it names (payload.seg) when it is a known one, else by type. */
function segFor(type, payload) {
  let p = payload; try { if (typeof p === 'string') p = JSON.parse(p); } catch (_) { p = null; }
  if (p && p.clearance_id) return 'finalclr';
  if (p && typeof p.seg === 'string' && SEGS.has(p.seg)) return p.seg;
  if (type === 'call') return 'call';
  return ({ fee: 'fees', payment: 'receipts', result: 'results', clearance: 'clearance', document: 'documents', exam: 'exam', message: 'messages', announcement: 'announcements' })[type] || 'overview';
}

/**
 * 📞 How a notification row reaches a phone: an incoming call is a DATA-ONLY push that lives 45 s (the app rings with
 * Answer / Decline); everything else is an ordinary notification. → { data, opts }
 */
function pushFor(row) {
  let p = row && row.payload; try { if (typeof p === 'string') p = JSON.parse(p); } catch (_) { p = null; }
  if (row && row.type === 'call' && p && p.call_id) return { data: { type: 'call', seg: 'call', call_id: String(p.call_id), call_kind: String(p.call_kind || 'voice'), from: String(p.from || ''), conversation_id: String(p.conversation_id || '') }, opts: { dataOnly: true, ttl: 45 } };
  return { data: { seg: segFor(row && row.type, p) }, opts: {} };
}

module.exports = { deviceKey, chatTargets, familyTargets, segFor, pushFor };
