'use strict';
/**
 * ✉️ MESSAGING — pure rules shared by the desktop (officers) and the portal (officers, lecturers/staff, students),
 * wherever the portal runs (cloud edge, Node hub, LAN hub). Messages are ordinary synced rows, so every office
 * and every phone talks through the ONE central database — nobody needs to be on the same network.
 *
 * Participants are KEYS:  u:<userId> an officer account · st:<staffId> a lecturer / staff member ·
 *                         s:<studentId> a student · p:<studentId> that student's PARENT / GUARDIAN ·
 *                         r:<role> an office DESK (every officer holding that role).
 * A message may carry ONE file (a photo of a receipt, a letter, a form): stored in the object store when the
 * institution has one (file_key), otherwise inline up to 1 MB (file_data) — never in the list/thread payloads.
 * Three conversation kinds:
 *   • direct — two people. Its id is DERIVED from the pair, so two offices opening the same chat at the same
 *     moment on two computers produce ONE conversation after sync, never two.
 *   • desk   — a person ↔ an office (Bursary, Registry, Student Affairs…). Any officer of that role answers;
 *     one ongoing thread per person per desk (also a derived id).
 *   • group  — a named group created by an officer or a lecturer (a class, a committee).
 * Read state is one row per (conversation, reader), written only by that reader — no sync conflicts.
 */
const crypto = require('crypto');

const MAX_BODY = 4000;
const MAX_MEMBERS = 300;
const MAX_TITLE = 120;
// office desks a person can write to (role → the name people see)
const DESKS = {
  accountant: 'Bursary / Accounts', registrar: 'Registry', student_affairs: 'Student Affairs',
  ict: 'ICT Help Desk', dean: 'Dean’s Office', hod: 'Head of Department', admin: 'Administration',
};
// the desks a STUDENT sees in their directory (the rest are staff-facing offices)
const STUDENT_DESKS = ['accountant', 'registrar', 'student_affairs', 'ict', 'hod', 'dean'];
// the desks a PARENT / GUARDIAN may write to (fees, admission / records, welfare) — never a lecturer or a student
const PARENT_DESKS = ['accountant', 'registrar', 'student_affairs'];
// attachments: what may be sent, and how big (inline copies travel with the synced row, so they stay small)
const FILE_MAX = 10 * 1024 * 1024, FILE_INLINE_MAX = 1024 * 1024;
const FILE_TYPES = /^(image\/(png|jpe?g|gif|webp|heic|heif)|audio\/(webm|ogg|mpeg|mp4|aac|x-m4a|m4a|wav|3gpp|amr)|video\/(mp4|webm|3gpp)|application\/pdf|text\/(plain|csv)|application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint|zip|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)))$/i;
const DEFAULT_POLICY = {
  enabled: true,              // the whole messaging module
  students_peer: true,        // students may message classmates (same department + level)
  students_to_lecturers: true, // students may message lecturers (same campus)
  staff_to_students: true,    // lecturers may message students (same campus)
  parents_to_desks: true,     // parents / guardians may write to the Bursary, Registry and Student Affairs
  students_to_heads: true,    // students may write to (and call) THEIR OWN head of department and dean, in person
};
/** The reactions a message can get (one per person; tapping yours again takes it back). */
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const key = (kind, id) => String(kind) + ':' + String(id);
function parseKey(k) {
  const s = String(k || ''); const i = s.indexOf(':');
  if (i < 1) return null;
  const kind = s.slice(0, i), id = s.slice(i + 1);
  if (!['u', 'st', 's', 'p', 'r'].includes(kind) || !id) return null;
  if (kind === 'r' && !DESKS[id]) return null;
  return { kind, id };
}
const validKey = (k) => !!parseKey(k);

/** The deterministic id of the direct chat between two people (order-independent). */
function dmId(a, b) { return 'dm_' + sha([String(a), String(b)].sort().join('|')).slice(0, 28); }
/** The deterministic id of a person's ongoing thread with an office desk. */
function deskId(role, personKey) { return 'dk_' + sha(String(role) + '|' + String(personKey)).slice(0, 28); }
/** The deterministic id of a reader's read-marker for a conversation. */
function readId(convId, readerKey) { return 'rd_' + sha(String(convId) + '|' + String(readerKey)).slice(0, 28); }

/** Plain text only: strip control characters (keep newlines/tabs), trim, cap. */
function cleanBody(s) {
  // eslint-disable-next-line no-control-regex
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, MAX_BODY);
}
function cleanTitle(s) { return cleanBody(s).replace(/\s+/g, ' ').slice(0, MAX_TITLE); }
/** An attachment as uploaded ({ name, mime, base64 }) → checked and measured; storageOn = an object store is connected. */
function cleanFile(f, storageOn) {
  if (!f || !f.base64) return null;
  const b64 = String(f.base64).replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const size = Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  const mime = String(f.mime || '').toLowerCase().trim();
  if (!FILE_TYPES.test(mime)) throw new Error('That kind of file cannot be sent — photos, PDF, Word, Excel, PowerPoint, text or ZIP only.');
  const cap = storageOn ? FILE_MAX : FILE_INLINE_MAX;
  if (!(size > 0)) throw new Error('The file is empty.');
  if (size > cap) throw new Error('The file is too large — ' + Math.round(cap / 1048576) + ' MB at most' + (storageOn ? '' : ' (connect file storage for larger files)') + '.');
  // eslint-disable-next-line no-control-regex
  const name = String(f.name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'file';
  return { name, mime, size, base64: b64 };
}
const fileLabel = (m) => (m && m.file_name ? '📎 ' + m.file_name : '');
/** What a message looks like in one line (a list row, a notification): its text, else 📷 Photo / 🎤 Voice note / 🎬 Video / 📎 name / 📞 Call. */
function previewOf(m) {
  if (!m) return '';
  const b = String(m.body || ''); if (b && !m.poll_id) return b.slice(0, 160);
  if (m.call_id) return '📞 Call';
  if (m.poll_id) return '📊 ' + String(m.body || 'Poll').slice(0, 150);
  if (!m.file_name) return '';
  const mime = String(m.file_mime || '');
  if (mime.startsWith('image/')) return '📷 Photo';
  if (mime.startsWith('audio/')) return '🎤 Voice note';
  if (mime.startsWith('video/')) return '🎬 Video';
  return fileLabel(m);
}

function parseJSON(s, d) { if (s && typeof s === 'object') return s; try { const v = JSON.parse(s == null ? 'null' : s); return v == null ? d : v; } catch (_) { return d; } }
function membersOf(conv) { const m = parseJSON(conv && conv.members, []); return Array.isArray(m) ? m.filter(validKey) : []; }
function namesOf(conv) { const m = parseJSON(conv && conv.member_names, {}); return m && typeof m === 'object' ? m : {}; }
function policyOf(raw) { const p = parseJSON(raw, {}); return Object.assign({}, DEFAULT_POLICY, p && typeof p === 'object' ? p : {}); }

/** Is a participant (identified by ALL of its keys — an officer is both u:<id> and r:<role>) in this conversation? */
function isMember(conv, meKeys) {
  const set = new Set(meKeys || []);
  return membersOf(conv).some(k => set.has(k));
}

/**
 * May `me` START a conversation with `target`? `me` = { kind:'u'|'st'|'s', id, role?, campus_id?, department_id?, level_id?, staff_type? },
 * `target` = the other side's facts: { key, kind, campus_id?, department_id?, level_id?, staff_type?, active? }.
 * Replying inside an existing conversation is always allowed for members — this gate only governs NEW threads.
 */
function canStart(me, target, policyRaw) {
  const policy = policyOf(policyRaw);
  if (!policy.enabled) return { ok: false, error: 'Messaging is switched off by the institution.' };
  if (!me || !target || !target.key || !validKey(target.key)) return { ok: false, error: 'Choose who to write to.' };
  if (target.active === false) return { ok: false, error: 'That account is no longer active.' };
  if (key(me.kind, me.id) === target.key) return { ok: false, error: 'You cannot message yourself.' };
  const sameCampus = !me.campus_id || !target.campus_id || me.campus_id === target.campus_id;
  const t = target.kind;
  if (me.kind === 'u') {
    // officers reach everyone on their campus (a super admin with no campus reaches every campus)
    if (!sameCampus) return { ok: false, error: 'That person belongs to another campus.' };
    return { ok: true };
  }
  if (me.kind === 'p') {
    if (!policy.parents_to_desks) return { ok: false, error: 'Parents write to the university by e-mail at this institution.' };
    if (t === 'r' && PARENT_DESKS.includes(target.id || parseKey(target.key).id)) return { ok: true };
    return { ok: false, error: 'Parents and guardians write to the Bursary, the Registry or Student Affairs.' };
  }
  if (t === 'p' && me.kind !== 'u') return { ok: false, error: 'Only the university offices write to parents and guardians.' };
  if (me.kind === 'st') {
    if (t === 'u' || t === 'r' || t === 'st') return sameCampus || t === 'r' ? { ok: true } : { ok: false, error: 'That person belongs to another campus.' };
    if (t === 's') {
      if (!policy.staff_to_students) return { ok: false, error: 'Lecturers cannot start chats with students at this institution.' };
      return sameCampus ? { ok: true } : { ok: false, error: 'That student belongs to another campus.' };
    }
    return { ok: false, error: 'You cannot message that account.' };
  }
  if (me.kind === 's') {
    if (t === 'r') return STUDENT_DESKS.includes(target.id || parseKey(target.key).id) ? { ok: true } : { ok: false, error: 'Students can write to the Bursary, Registry, Student Affairs, ICT, the HOD or the Dean.' };
    if (t === 'st') {
      if (!policy.students_to_lecturers) return { ok: false, error: 'Please write to your department office instead.' };
      if (target.staff_type && target.staff_type !== 'lecturer') return { ok: false, error: 'You can message lecturers and the offices.' };
      return sameCampus ? { ok: true } : { ok: false, error: 'That lecturer belongs to another campus.' };
    }
    if (t === 'u') {
      // 🎓 their OWN head of department / dean, in person (the desks reach whoever holds the office)
      if (!policy.students_to_heads) return { ok: false, error: 'Write to the Head of Department or the Dean’s Office desk instead.' };
      if (target.role === 'hod' && target.department_id && target.department_id === me.department_id) return { ok: true };
      if (target.role === 'dean' && target.faculty_id && target.faculty_id === me.faculty_id) return { ok: true };
      return { ok: false, error: 'Students can write to their own head of department and dean, and to the office desks.' };
    }
    if (t === 's') {
      if (!policy.students_peer) return { ok: false, error: 'Student-to-student messaging is switched off at this institution.' };
      if (!me.department_id || me.department_id !== target.department_id || (me.level_id && target.level_id && me.level_id !== target.level_id)) return { ok: false, error: 'You can message classmates (same department and level).' };
      return { ok: true };
    }
    return { ok: false, error: 'Students write to an office desk — choose Bursary, Registry, Student Affairs or ICT.' };
  }
  return { ok: false, error: 'You cannot message that account.' };
}

/** May `me` create a named GROUP? Officers and lecturers only (keeps moderation manageable). */
function canCreateGroup(me) { return !!me && (me.kind === 'u' || (me.kind === 'st' && me.staff_type === 'lecturer')); }

/**
 * Build the new conversation row (caller persists it). For direct/desk the id is derived — if the row already
 * exists the caller simply reuses it.
 */
function newConversation({ kind, me, meName, targetKey, targetName, title, members, names, campus_id, now }) {
  const at = now || new Date().toISOString();
  const meKey = key(me.kind, me.id);
  if (kind === 'group') {
    const mem = [...new Set([meKey].concat(members || []))].filter(validKey).slice(0, MAX_MEMBERS);
    if (mem.length < 2) throw new Error('Add at least one other member.');
    const nm = Object.assign({}, names || {}, { [meKey]: meName || '' });
    return { id: 'gp_' + sha(meKey + '|' + at + '|' + Math.random()).slice(0, 28), kind: 'group', title: cleanTitle(title) || 'Group', members: JSON.stringify(mem), member_names: JSON.stringify(nm), created_by: meKey, campus_id: campus_id || null, created_at: at, updated_at: at, deleted: 0 };
  }
  const tk = parseKey(targetKey); if (!tk) throw new Error('Choose who to write to.');
  if (tk.kind === 'r') {
    return { id: deskId(tk.id, meKey), kind: 'desk', title: DESKS[tk.id], members: JSON.stringify([meKey, targetKey]), member_names: JSON.stringify({ [meKey]: meName || '', [targetKey]: DESKS[tk.id] }), created_by: meKey, campus_id: campus_id || null, created_at: at, updated_at: at, deleted: 0 };
  }
  return { id: dmId(meKey, targetKey), kind: 'direct', title: '', members: JSON.stringify([meKey, targetKey].sort()), member_names: JSON.stringify({ [meKey]: meName || '', [targetKey]: targetName || '' }), created_by: meKey, campus_id: campus_id || null, created_at: at, updated_at: at, deleted: 0 };
}

/** The title a given reader sees: group title, desk name (or the person, for the officer side), or the other person's name. */
function titleFor(conv, meKeys) {
  const set = new Set(meKeys || []); const names = namesOf(conv); const mem = membersOf(conv);
  if (conv.kind === 'group') return conv.title || 'Group';
  if (conv.kind === 'desk') {
    const desk = mem.find(k => k.startsWith('r:')); const person = mem.find(k => !k.startsWith('r:'));
    if (desk && set.has(desk)) return (names[person] || 'Someone') + ' → ' + (DESKS[desk.slice(2)] || 'Office');
    return DESKS[(desk || 'r:').slice(2)] || conv.title || 'Office';
  }
  const other = mem.find(k => !set.has(k));
  return names[other] || 'Conversation';
}

/**
 * Summarise the conversations a reader belongs to: last message, unread count, sorted by latest activity.
 * `messages` may be every message (it is grouped here); `reads` are chat_reads rows.
 */
function summarize(convs, messages, reads, meKeys, readerKey) {
  const set = new Set(meKeys || []);
  const byConv = new Map();
  for (const m of messages || []) { if (!m || m.deleted) continue; const a = byConv.get(m.conversation_id); if (a) a.push(m); else byConv.set(m.conversation_id, [m]); }
  const readAt = new Map();
  for (const r of reads || []) if (r && !r.deleted && r.member_key === readerKey) readAt.set(r.conversation_id, r);
  const out = [];
  for (const c of convs || []) {
    if (!c || c.deleted || !isMember(c, meKeys)) continue;
    const rd = readAt.get(c.id) || null;
    const ms = (byConv.get(c.id) || []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const last = ms[ms.length - 1] || null;
    // a hidden ("left") conversation comes back as soon as someone writes in it again
    if (rd && Number(rd.has_left) && !(last && String(last.created_at) > String(rd.updated_at || ''))) continue;
    const since = rd ? String(rd.last_read_at || '') : '';
    const unreadMs = ms.filter(m => !set.has(m.sender_key) && String(m.created_at) > since); const unread = unreadMs.length;
    const mention = unreadMs.some(m => m.mentions && parseJSON(m.mentions, []).some(k => set.has(k)));
    out.push({ id: c.id, kind: c.kind, title: titleFor(c, meKeys), members: membersOf(c).length, last_at: last ? last.created_at : c.created_at,
      last_preview: last ? previewOf(last).slice(0, 90) : '', last_from: last ? (set.has(last.sender_key) ? 'You' : (last.sender_name || '')) : '',
      unread: rd && Number(rd.muted) && !mention ? 0 : unread, muted: !!(rd && Number(rd.muted)), mention });
  }
  return out.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
}

/** A thread's messages for display (oldest first), each flagged `mine` for the reader. */
function thread(messages, convId, meKeys, sinceIso, nowIso) {
  const set = new Set(meKeys || []); const now = nowIso || new Date().toISOString();
  return (messages || []).filter(m => m && !m.deleted && m.conversation_id === convId && (!sinceIso || String(m.created_at) > sinceIso))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(m => ({ id: m.id, body: m.body, at: m.created_at, from: m.sender_name || '', mine: set.has(m.sender_key), sender_key: m.sender_key,
      file: m.file_name ? { name: m.file_name, mime: m.file_mime || '', size: Number(m.file_size) || 0 } : null, reply_to: m.reply_to || null, call_id: m.call_id || null, poll_id: m.poll_id || null,
      edited: !!m.edited_at, forwarded: !!Number(m.forwarded || 0), editable: set.has(m.sender_key) && canEdit(m, m.sender_key, now),
      mentions_me: !set.has(m.sender_key) && parseJSON(m.mentions, []).some(k => set.has(k)) }));
}
/** A reaction's row id: one per (message, person) — a new emoji replaces the old one. */
function reactionId(messageId, memberKey) { return 'rx_' + sha(String(messageId) + '|' + String(memberKey)).slice(0, 28); }
/**
 * Dress a thread for display: what each message replies to, its reactions, a call's summary, and — for the reader's
 * own messages — how many of the others have SEEN it (✓ sent · ✓✓ seen). reads = chat_reads rows of the conversation,
 * reactions = chat_reactions rows, callView(callId) → a call summary (callrules.summary) or null.
 */
function enrich(msgs, { reads, reactions, members, meKeys, callView, pollView: pv, stars } = {}) {
  const set = new Set(meKeys || []);
  const byId = new Map((msgs || []).map(m => [m.id, m]));
  const others = (members || []).filter(k => !set.has(k));
  const readAt = new Map(), gotAt = new Map();
  for (const r of reads || []) if (r && !Number(r.deleted)) {
    const rd = String(r.last_read_at || ''); if (rd > (readAt.get(r.member_key) || '')) readAt.set(r.member_key, rd);
    const dv = [rd, String(r.delivered_at || '')].sort().pop(); if (dv > (gotAt.get(r.member_key) || '')) gotAt.set(r.member_key, dv);
  }
  const starred = stars instanceof Set ? stars : new Set(stars || []);
  const rx = new Map(); for (const r of reactions || []) { if (!r || Number(r.deleted) || !r.emoji) continue; const a = rx.get(r.message_id) || []; a.push(r); rx.set(r.message_id, a); }
  return (msgs || []).map(m => {
    const out = Object.assign({}, m);
    if (m.reply_to) { const q = byId.get(m.reply_to); out.reply = q ? { id: q.id, from: q.mine ? 'You' : (q.from || ''), body: String(q.body || (q.file ? '📎 ' + q.file.name : '')).slice(0, 140) } : { id: m.reply_to, from: '', body: 'An earlier message' }; }
    const rs = rx.get(m.id) || [];
    if (rs.length) { const c = new Map(); for (const r of rs) { const x = c.get(r.emoji) || { emoji: r.emoji, n: 0, mine: false }; x.n++; if (set.has(r.member_key)) x.mine = true; c.set(r.emoji, x); } out.reactions = [...c.values()].sort((a, b) => b.n - a.n); }
    if (m.mine && others.length) {
      out.seen = others.filter(k => (readAt.get(k) || '') >= String(m.at)).length; out.seen_of = others.length;
      const got = others.filter(k => (gotAt.get(k) || '') >= String(m.at)).length;
      out.delivered = got; out.tick = out.seen >= others.length ? 'read' : got >= others.length ? 'delivered' : 'sent';
    }
    if (m.call_id && typeof callView === 'function') out.call = callView(m.call_id) || null;
    if (m.poll_id && typeof pv === 'function') out.poll = pv(m.poll_id) || null;
    if (starred.has(m.id)) out.starred = true;
    delete out.reply_to; delete out.call_id; delete out.poll_id; delete out.sender_key;
    return out;
  });
}

/** The message row (caller persists it). */
function newMessage({ convId, senderKey, senderName, body, now, file, replyTo, callId, mentions, pollId }) {
  const text = cleanBody(body); if (!text && !file && !callId && !pollId) throw new Error('Write a message first.');
  const at = now || new Date().toISOString();
  const row = { id: 'cm_' + sha(convId + '|' + senderKey + '|' + at + '|' + Math.random()).slice(0, 28), conversation_id: convId, sender_key: senderKey, sender_name: String(senderName || '').slice(0, 120), body: text, created_at: at, updated_at: at, deleted: 0 };
  // file = { name, mime, size, key?, data? } — already stored by the caller (object-store key, or inline base64)
  if (file) Object.assign(row, { file_name: file.name, file_mime: file.mime, file_size: file.size, file_key: file.key || null, file_data: file.key ? null : (file.data || null) });
  if (replyTo) row.reply_to = String(replyTo).slice(0, 64);
  if (callId) row.call_id = String(callId).slice(0, 64);
  if (Array.isArray(mentions) && mentions.length) row.mentions = JSON.stringify(mentions.slice(0, 50));
  if (pollId) row.poll_id = String(pollId).slice(0, 64);
  return row;
}

/** The read-marker row for (conversation, reader) — caller upserts it. */
function readMarker(convId, readerKey, at, extra) {
  const t = at || new Date().toISOString();
  const row = Object.assign({ id: readId(convId, readerKey), conversation_id: convId, member_key: readerKey, last_read_at: t, muted: 0, has_left: 0, created_at: t, updated_at: t, deleted: 0 }, extra || {});
  // ✓✓ a first "delivered" stamp is not a read — the member has not opened the conversation yet
  if (extra && extra.delivered_at && !Object.prototype.hasOwnProperty.call(extra, 'last_read_at')) row.last_read_at = '';
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🛡 SAFETY · ✏️ EDIT · 📌 PIN · ↪ FORWARD · 🔍 SEARCH · 📲 PUSH (2026-10). Rows are looked up through
// get(entity, id) — the portal passes its one(), the desktop db.get, the hub / edge their oneEntity — so every side
// applies the same blocks, pauses and mutes. Ids are derived, so a block or a pause is ONE row wherever it was made.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const EDIT_WINDOW_MS = 15 * 60 * 1000;
/** What a person can report (the moderator sees the label). */
const REPORT_REASONS = {
  harassment: 'Harassment or bullying', threat: 'Threats or violence', sexual: 'Sexual or inappropriate content',
  hate: 'Hate speech', spam: 'Spam or a scam', impersonation: 'Pretending to be someone else', other: 'Something else',
};
const RESTRICT_DAYS = [1, 3, 7, 30];
/** Who reviews reports: the administrators and Student Affairs (a campus admin / officer sees their own campus). */
const MODERATORS = ['admin', 'campus_admin', 'student_affairs'];
const FORWARD_MAX = 5;
const PERSON_KINDS = ['s', 'st', 'p', 'u'];
const alive = (r) => !!r && !Number(r.deleted);

function blockId(blockerKey, blockedKey) { return 'bk_' + sha(String(blockerKey) + '>' + String(blockedKey)).slice(0, 28); }
function restrictionId(memberKey) { return 'rs_' + sha('pause|' + String(memberKey)).slice(0, 28); }
/** One report per reporter per message (or per person) — reporting again updates it rather than piling up. */
function reportId(reporterKey, subject) { return 'rp_' + sha(String(reporterKey) + '|' + String(subject)).slice(0, 28); }

/** The other person in a direct chat (null for groups and office desks). */
function peerOf(conv, meKeys) {
  if (!conv || conv.kind !== 'direct') return null;
  const set = new Set(meKeys || []); return membersOf(conv).find(k => !set.has(k)) || null;
}
/** Has `a` blocked `b`? */
function hasBlocked(get, a, b) { return !!(a && b && typeof get === 'function' && alive(get('chat_blocks', blockId(a, b)))); }
/** The messaging pause on this person while it is in force, else null. */
function restrictionOf(get, memberKey, nowIso) {
  if (typeof get !== 'function' || !memberKey) return null;
  const r = get('chat_restrictions', restrictionId(memberKey));
  return alive(r) && String(r.until || '') > String(nowIso || new Date().toISOString()) ? r : null;
}
/** Only a person can be blocked — never an office desk, never yourself. */
function canBlock(meKey, targetKey) {
  const pk = parseKey(targetKey);
  if (!pk || !PERSON_KINDS.includes(pk.kind)) return { ok: false, error: 'You can block a person, not an office.' };
  if (targetKey === meKey) return { ok: false, error: 'You cannot block yourself.' };
  return { ok: true };
}
function blockRow(blockerKey, blockedKey, blockedName, nowIso) {
  const at = nowIso || new Date().toISOString();
  return { id: blockId(blockerKey, blockedKey), blocker_key: blockerKey, blocked_key: blockedKey, blocked_name: String(blockedName || '').slice(0, 160), created_at: at, updated_at: at, deleted: 0 };
}
/**
 * May this member write — or call — in this conversation now? → null, or why not. A paused account can still write to
 * an office DESK (to ask Student Affairs about the pause); a block closes a DIRECT chat in both directions.
 */
function sendBlock(conv, meKeys, get, nowIso) {
  const me = (meKeys || [])[0];
  if (conv && conv.kind !== 'desk') {
    const r = restrictionOf(get, me, nowIso);
    if (r) return 'Your messaging is paused until ' + String(r.until).slice(0, 10) + ' after a report was upheld. You can still write to an office desk such as Student Affairs.';
  }
  if (conv && conv.kind === 'group' && conv.post_mode === 'admins' && !isGroupAdmin(conv, meKeys)) return 'Only the group’s admins can send messages here.';
  const peer = peerOf(conv, meKeys);
  if (peer) {
    if (hasBlocked(get, me, peer)) return 'You blocked this person. Unblock them to write again.';
    if (hasBlocked(get, peer, me)) return 'This person is not accepting your messages.';
  }
  return null;
}
/** ✏️ Your own message (not a call, not one you forwarded), for 15 minutes after sending. */
function canEdit(msg, meKey, nowIso) {
  if (!alive(msg) || msg.sender_key !== meKey || msg.call_id || msg.poll_id || Number(msg.forwarded || 0)) return false;
  const t = Date.parse(msg.created_at || ''); const now = Date.parse(nowIso || new Date().toISOString());
  return isFinite(t) && isFinite(now) && now - t <= EDIT_WINDOW_MS;
}
/** The patch an edit writes (null when nothing changed). */
function editPatch(msg, meKey, body, nowIso) {
  const at = nowIso || new Date().toISOString();
  if (!canEdit(msg, meKey, at)) throw new Error('A message can be edited for 15 minutes after it was sent.');
  const text = cleanBody(body); if (!text && !msg.file_name) throw new Error('Write a message first.');
  if (text === String(msg.body || '')) return null;
  return { body: text, edited_at: at, updated_at: at };
}
/** 📌 Anyone in a direct chat or a desk thread; in a group, its creator, the offices and lecturers. */
function canPin(conv, me) {
  if (!conv || !me) return false;
  if (conv.kind !== 'group') return true;
  return conv.created_by === key(me.kind, me.id) || me.kind === 'u' || me.kind === 'st';
}
/** ↪ A copy of a message for another conversation (the file travels by reference — the same stored object). */
function forwardCopy(src, convId, senderKey, senderName, nowIso) {
  if (!alive(src) || src.call_id || src.poll_id) throw new Error('That message cannot be forwarded.');
  const file = src.file_name ? { name: src.file_name, mime: src.file_mime || '', size: Number(src.file_size) || 0, key: src.file_key || null, data: src.file_key ? null : (src.file_data || null) } : null;
  const m = newMessage({ convId, senderKey, senderName, body: src.body, now: nowIso, file });
  m.forwarded = 1; return m;
}
/** 🚩 A report on a message (or on a person, from a direct chat). The moderator sees the excerpt and a little context. */
function newReport({ reporterKey, reporterName, msg, conv, reportedKey, reportedName, reason, note, nowIso }) {
  if (!REPORT_REASONS[reason]) throw new Error('Choose what is wrong.');
  const who = msg ? msg.sender_key : reportedKey;
  if (!who) throw new Error('Choose what to report.');
  if (who === reporterKey) throw new Error(msg ? 'You cannot report your own message.' : 'You cannot report yourself.');
  const pk = parseKey(who); if (!pk || pk.kind === 'r') throw new Error('Only a person can be reported.');
  const at = nowIso || new Date().toISOString();
  return { id: reportId(reporterKey, msg ? msg.id : who), message_id: msg ? msg.id : null, conversation_id: conv ? conv.id : (msg ? msg.conversation_id : null),
    reporter_key: reporterKey, reporter_name: String(reporterName || '').slice(0, 160), reported_key: who, reported_name: String((msg ? msg.sender_name : reportedName) || '').slice(0, 160),
    reason, note: cleanBody(note).slice(0, 500), excerpt: msg ? (String(msg.body || '') || fileLabel(msg)).slice(0, 1000) : '', status: 'open', action: null,
    handled_by: null, handled_note: null, handled_at: null, campus_id: (conv && conv.campus_id) || null, created_at: at, updated_at: at, deleted: 0 };
}
/** May this officer review reports (and on which campus)? */
function canModerate(user) { return !!user && MODERATORS.includes(user.role); }
function moderatorSees(user, report) {
  if (!canModerate(user) || !alive(report)) return false;
  if (user.role === 'admin' || !user.campus_id) return true;
  return !report.campus_id || report.campus_id === user.campus_id;
}
/**
 * A moderator's decision → { patch (the report), restriction (a pause row) | null, removeMessage }.
 * dismiss = nothing wrong · remove = take the message down for everyone · restrict = take it down AND pause the
 * person's messaging (direct chats, groups, calls) for 1 / 3 / 7 / 30 days — office desks stay open to them.
 */
function decide(report, { action, days, note, byKey, byName, nowIso } = {}) {
  if (!alive(report)) throw new Error('Report not found.');
  if (report.status !== 'open') throw new Error('This report was already handled.');
  if (!['dismiss', 'remove', 'restrict'].includes(action)) throw new Error('Choose what to do.');
  const at = nowIso || new Date().toISOString();
  const patch = { status: action === 'dismiss' ? 'dismissed' : 'actioned', action, handled_by: String(byName || byKey || '').slice(0, 160), handled_note: cleanBody(note).slice(0, 500), handled_at: at, updated_at: at };
  let restriction = null;
  if (action === 'restrict') {
    const d = Number(days); if (!RESTRICT_DAYS.includes(d)) throw new Error('Choose how long: ' + RESTRICT_DAYS.join(', ') + ' days.');
    const pk = parseKey(report.reported_key); if (!pk || pk.kind === 'u') throw new Error('Office accounts are not paused here — raise it with the administrator.');
    restriction = { id: restrictionId(report.reported_key), member_key: report.reported_key, member_name: report.reported_name || '', until: new Date(Date.parse(at) + d * 86400000).toISOString(),
      reason: REPORT_REASONS[report.reason] || String(report.reason || ''), report_id: report.id, by_user: patch.handled_by, created_at: at, updated_at: at, deleted: 0 };
  }
  return { patch, restriction, removeMessage: action !== 'dismiss' && !!report.message_id };
}
/** The messages around a reported one (moderators only) — removed ones included, marked. */
function reportContext(messages, report, n) {
  const k = n == null ? 5 : n;
  const ms = (messages || []).filter(m => m && m.conversation_id === report.conversation_id && !m.call_id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  let i = report.message_id ? ms.findIndex(m => m.id === report.message_id) : -1; if (i < 0) i = ms.length - 1;
  return ms.slice(Math.max(0, i - k), Math.min(ms.length, i + k + 1)).map(m => ({ id: m.id, from: m.sender_name || '', key: m.sender_key, at: m.created_at, body: previewOf(m), reported: m.id === report.message_id, removed: !!Number(m.deleted) }));
}
/** 🔍 Search the reader's own conversations (text and file names), newest first. */
function search(messages, convs, meKeys, q, limit) {
  const term = String(q || '').trim().toLowerCase(); if (term.length < 2) return [];
  const byId = new Map(); for (const c of convs || []) if (alive(c) && isMember(c, meKeys)) byId.set(c.id, c);
  const set = new Set(meKeys || []); const out = [];
  for (const m of messages || []) {
    if (!alive(m) || m.call_id || !byId.has(m.conversation_id)) continue;
    const body = String(m.body || ''); const i = body.toLowerCase().indexOf(term);
    const onFile = i < 0 && String(m.file_name || '').toLowerCase().includes(term);
    if (i < 0 && !onFile) continue;
    const snippet = onFile ? fileLabel(m) : (i > 40 ? '…' : '') + body.slice(Math.max(0, i - 40), i + term.length + 60) + (i + term.length + 60 < body.length ? '…' : '');
    const c = byId.get(m.conversation_id);
    out.push({ id: m.id, conversation_id: c.id, kind: c.kind, title: titleFor(c, meKeys), from: set.has(m.sender_key) ? 'You' : (m.sender_name || ''), at: m.created_at, snippet });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit || 50);
}
/**
 * 📲 Who a new message is pushed to and what the phone shows: the members other than the sender, minus those who muted
 * the conversation or blocked the sender. → { members (conversation keys), title, body, data }. The data rides a
 * DATA-ONLY push so the app can group a conversation's messages and offer Reply / Mark as read on the notification.
 */
function pushPlan(msg, conv, get) {
  if (!msg || !conv || msg.call_id || Number(msg.deleted)) return { members: [], title: '', body: '', data: null };
  const sender = msg.sender_key; const members = []; const named = new Set(parseJSON(msg.mentions, []));
  for (const k of membersOf(conv)) {
    if (k === sender) continue;
    if (typeof get === 'function') {
      const rd = get('chat_reads', readId(conv.id, k)); if (alive(rd) && Number(rd.muted) && !named.has(k)) continue;
      if (hasBlocked(get, k, sender)) continue;
    }
    members.push(k);
  }
  const desk = conv.kind === 'desk' ? (membersOf(conv).find(k => k.startsWith('r:')) || '') : '';
  const where = conv.kind === 'group' ? (conv.title || 'Group') : desk ? (DESKS[desk.slice(2)] || 'Office') : '';
  const who = String(msg.sender_name || '').split(' (')[0] || 'Someone';
  const body = previewOf(msg);
  return { members, title: '💬 ' + who + (where ? ' · ' + where : ''), body,
    data: { type: 'message', seg: 'messages', id: conv.id, conversation_id: conv.id, message_id: msg.id, sender: who, conv_title: where, group: conv.kind === 'group' ? '1' : '', body, mentions: [...named].join(',') } };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 👥 GROUPS — admins are the creator, anyone an admin promotes, and the offices (u:) in the group. Admins rename,
// add (through the same canStart gate as starting a chat), remove, promote, and can make it "only admins can send"
// (a class notice board). Anyone may leave.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const POST_MODES = ['all', 'admins'];
function adminsOf(conv) {
  const a = parseJSON(conv && conv.admins, []); const out = new Set(Array.isArray(a) ? a.filter(validKey) : []);
  if (conv && conv.created_by) out.add(conv.created_by);
  return out;
}
/** Is this member an admin of the group? (the creator, a promoted member, or an office account in it) */
function isGroupAdmin(conv, meKeys) {
  if (!conv || conv.kind !== 'group' || !isMember(conv, meKeys)) return false;
  const ad = adminsOf(conv); return (meKeys || []).some(k => ad.has(k) || String(k).startsWith('u:'));
}
/** The group as its info screen shows it. */
function groupView(conv, meKeys) {
  if (!conv || conv.kind !== 'group') return null;
  const names = namesOf(conv); const ad = adminsOf(conv); const set = new Set(meKeys || []);
  const members = membersOf(conv).map(k => ({ key: k, name: String(names[k] || k).split(' (')[0], admin: ad.has(k) || k.startsWith('u:'), me: set.has(k) }))
    .sort((a, b) => (b.admin - a.admin) || a.name.localeCompare(b.name));
  return { admin: isGroupAdmin(conv, meKeys), post_mode: POST_MODES.includes(conv.post_mode) ? conv.post_mode : 'all', created_by: conv.created_by || null, members };
}
/**
 * The change an admin (or a leaving member) makes → { patch, added, removed }. `add` = [{ key, name }] already passed
 * through canStart by the caller; `remove` / `promote` / `demote` = member keys.
 */
function groupPatch(conv, meKeys, { title, add, remove, promote, demote, post_mode, leave } = {}, nowIso) {
  if (!conv || conv.kind !== 'group') throw new Error('Only groups can be changed.');
  if (!isMember(conv, meKeys)) throw new Error('You are not in this group.');
  const at = nowIso || new Date().toISOString();
  const mem = membersOf(conv); const names = namesOf(conv); const ad = adminsOf(conv);
  const set = new Set(meKeys || []);
  if (leave) {
    const left = mem.filter(k => !set.has(k)); if (!left.length) throw new Error('You are the last member — hide the group instead.');
    const adm = [...ad].filter(k => !set.has(k));
    return { patch: { members: JSON.stringify(left), admins: JSON.stringify(adm), updated_at: at }, added: [], removed: mem.filter(k => set.has(k)) };
  }
  if (!isGroupAdmin(conv, meKeys)) throw new Error('Only the group’s admins can change it.');
  const out = new Set(mem); const added = []; const removed = [];
  for (const p of Array.isArray(add) ? add : []) { if (p && validKey(p.key) && !p.key.startsWith('r:') && !out.has(p.key)) { out.add(p.key); names[p.key] = p.name || names[p.key] || ''; added.push(p.key); } }
  for (const k of Array.isArray(remove) ? remove : []) {
    if (!out.has(k)) continue;
    if (set.has(k)) throw new Error('To leave the group, use “Leave group”.');
    if (k === conv.created_by) throw new Error('The person who created the group cannot be removed.');
    out.delete(k); ad.delete(k); removed.push(k);
  }
  if (out.size > MAX_MEMBERS) throw new Error('A group can have at most ' + MAX_MEMBERS + ' members.');
  for (const k of Array.isArray(promote) ? promote : []) if (out.has(k) && !k.startsWith('r:')) ad.add(k);
  for (const k of Array.isArray(demote) ? demote : []) { if (k === conv.created_by) throw new Error('The person who created the group stays an admin.'); ad.delete(k); }
  const patch = { members: JSON.stringify([...out]), member_names: JSON.stringify(names), admins: JSON.stringify([...ad].filter(k => out.has(k) || k === conv.created_by)), updated_at: at };
  if (title != null) { const t = cleanTitle(title); if (!t) throw new Error('Give the group a name.'); patch.title = t; }
  if (post_mode != null) { if (!POST_MODES.includes(post_mode)) throw new Error('Choose who can send messages.'); patch.post_mode = post_mode; }
  return { patch, added, removed };
}
/** @ The members a message mentions (members only, never the sender or an office desk). */
function cleanMentions(conv, keys, senderKey) {
  const mem = new Set(membersOf(conv));
  return [...new Set((Array.isArray(keys) ? keys : []).map(String))].filter(k => mem.has(k) && k !== senderKey && !k.startsWith('r:')).slice(0, 50);
}
/** ℹ️ Who has seen MY message (and when), and who has not yet. A desk counts as read once any of its officers read. */
function messageInfo(msg, conv, reads, meKeys) {
  const set = new Set(meKeys || []); const names = namesOf(conv);
  const readAt = new Map(); for (const r of reads || []) if (r && !Number(r.deleted)) { const t = String(r.last_read_at || ''); if (t > (readAt.get(r.member_key) || '')) readAt.set(r.member_key, t); }
  const seen = [], waiting = [];
  for (const k of membersOf(conv)) {
    if (set.has(k) || k === msg.sender_key) continue;
    const t = readAt.get(k) || ''; const name = String(names[k] || DESKS[(k.startsWith('r:') ? k.slice(2) : '')] || k).split(' (')[0];
    if (t && t >= String(msg.created_at)) seen.push({ name, at: t }); else waiting.push(name);
  }
  return { seen: seen.sort((a, b) => String(a.at).localeCompare(String(b.at))), waiting: waiting.sort() };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🚩 ONE MODERATION ROUTINE — the desktop and the portal (office app) apply a decision through the same steps.
// store = { get(entity, id), update(entity, id, patch), create(entity, row), notify(targetKey, { title, body, type, payload }) }
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function moderate(store, report, opts) {
  const at = (opts && opts.nowIso) || new Date().toISOString();
  const d = decide(report, Object.assign({}, opts, { nowIso: at }));
  store.update('chat_reports', report.id, d.patch);
  if (d.removeMessage) { const m = store.get('chat_messages', report.message_id); if (alive(m)) store.update('chat_messages', m.id, { deleted: 1, updated_at: at }); }
  if (d.restriction) {
    const ex = store.get('chat_restrictions', d.restriction.id);
    if (ex) { const { id: rid, created_at: _c, ...rest } = d.restriction; store.update('chat_restrictions', rid, Object.assign(rest, { deleted: 0 })); }
    else store.create('chat_restrictions', Object.assign({}, d.restriction));
    store.notify(report.reported_key, { title: '⏸ Your messaging is paused', body: 'Until ' + d.restriction.until.slice(0, 10) + ' — a message you sent broke the community rules. You can still write to Student Affairs.', type: 'chat_moderation', payload: { seg: 'messages' } });
  }
  // the person who reported it hears that it was looked at (never what was decided about someone else)
  store.notify(report.reporter_key, { title: '🚩 Thank you — your report was reviewed', body: 'Student Affairs looked at what you reported.', type: 'chat_moderation', payload: { seg: 'messages' } });
  return d;
}
function liftPause(store, row, nowIso) {
  if (!alive(row)) throw new Error('That pause was already lifted.');
  store.update('chat_restrictions', row.id, { deleted: 1, updated_at: nowIso || new Date().toISOString() });
  store.notify(row.member_key, { title: '▶️ Your messaging is back on', body: 'Student Affairs lifted the pause on your messages.', type: 'chat_moderation', payload: { seg: 'messages' } });
  return { ok: true };
}
/** A report as the moderators' lists show it. */
function reportView(r) { return Object.assign({}, r, { reason_label: REPORT_REASONS[r.reason] || r.reason }); }

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 📊 POLLS — anyone who may post in a conversation can ask (2–10 answers, one or several choices, optionally
// anonymous); members vote, change or take back their vote; the person who asked (or a group admin) closes it.
// ⭐ STARS — a private bookmark on a message (one row per message per person).
// ✓✓ DELIVERED — a conversation is "delivered" to a member when their app / portal / desktop fetched it (or the
// phone received the push); read = they opened it. The sender sees ✓ sent · grey ✓✓ delivered · blue ✓✓ read.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const POLL_MAX = 10;
const pollVoteId = (pollId, memberKey) => 'pv_' + sha(String(pollId) + '|' + String(memberKey)).slice(0, 28);
const starId = (messageId, memberKey) => 'sr_' + sha(String(messageId) + '*' + String(memberKey)).slice(0, 28);
function newPoll({ convId, question, options, multi, anonymous, creatorKey, now }) {
  const q = cleanBody(question).replace(/\s+/g, ' ').slice(0, 300); if (!q) throw new Error('Ask a question.');
  const opts = []; const seen = new Set();
  for (const o of Array.isArray(options) ? options : []) {
    const t = cleanBody(o).replace(/\s+/g, ' ').slice(0, 120); if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); opts.push({ id: 'o' + (opts.length + 1), text: t });
  }
  if (opts.length < 2) throw new Error('Give at least two different answers.');
  if (opts.length > POLL_MAX) throw new Error('A poll can have at most ' + POLL_MAX + ' answers.');
  const at = now || new Date().toISOString();
  return { id: 'pl_' + sha(String(convId) + '|' + creatorKey + '|' + at + '|' + Math.random()).slice(0, 28), conversation_id: convId, question: q, options: JSON.stringify(opts),
    multi: multi ? 1 : 0, anonymous: anonymous ? 1 : 0, closed: 0, created_by: creatorKey, created_at: at, updated_at: at, deleted: 0 };
}
/** A member's vote (an empty choice takes it back). → the vote row to upsert */
function voteRow(poll, memberKey, choices, now) {
  if (!alive(poll)) throw new Error('Poll not found.');
  if (Number(poll.closed)) throw new Error('This poll is closed.');
  const ids = new Set(parseJSON(poll.options, []).map(o => o.id));
  const ch = [...new Set((Array.isArray(choices) ? choices : [choices]).filter(x => x != null).map(String))].filter(c => ids.has(c));
  if (!Number(poll.multi) && ch.length > 1) throw new Error('Choose one answer.');
  const at = now || new Date().toISOString();
  return { id: pollVoteId(poll.id, memberKey), poll_id: poll.id, conversation_id: poll.conversation_id, member_key: memberKey, choices: JSON.stringify(ch), created_at: at, updated_at: at, deleted: ch.length ? 0 : 1 };
}
function canClosePoll(poll, conv, meKeys) { return !!poll && ((meKeys || []).includes(poll.created_by) || isGroupAdmin(conv, meKeys)); }
/** The poll as a bubble shows it: each answer with its count / share / whether I chose it (and who, unless anonymous). */
function pollView(poll, votes, conv, meKeys) {
  if (!poll) return null;
  const set = new Set(meKeys || []); const names = namesOf(conv); const opts = parseJSON(poll.options, []);
  const by = new Map(opts.map(o => [o.id, []])); let voters = 0; let mine = [];
  for (const v of votes || []) {
    if (!alive(v) || v.poll_id !== poll.id) continue;
    const ch = parseJSON(v.choices, []); if (!ch.length) continue;
    voters++; if (set.has(v.member_key)) mine = ch;
    for (const c of ch) if (by.has(c)) by.get(c).push(String(names[v.member_key] || '').split(' (')[0]);
  }
  const anon = !!Number(poll.anonymous);
  return { id: poll.id, question: poll.question, multi: !!Number(poll.multi), anonymous: anon, closed: !!Number(poll.closed), voters, members: membersOf(conv).length,
    canClose: canClosePoll(poll, conv, meKeys) && !Number(poll.closed), voted: mine.length > 0,
    options: opts.map(o => { const n = by.get(o.id).length; return { id: o.id, text: o.text, votes: n, pct: voters ? Math.round(100 * n / voters) : 0, mine: mine.includes(o.id), who: anon ? [] : by.get(o.id).filter(Boolean).slice(0, 40) }; }) };
}
/** ⭐ The messages I starred, newest star first, with where they are. */
function starredList(stars, messages, convs, meKeys) {
  const set = new Set(meKeys || []); const byMsg = new Map((messages || []).map(m => [m.id, m]));
  const byConv = new Map((convs || []).filter(c => alive(c) && isMember(c, meKeys)).map(c => [c.id, c]));
  const out = [];
  for (const st of (stars || []).filter(alive).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))) {
    const m = byMsg.get(st.message_id); const c = m && byConv.get(m.conversation_id); if (!m || !alive(m) || !c) continue;
    out.push({ id: m.id, conversation_id: c.id, kind: c.kind, title: titleFor(c, meKeys), from: set.has(m.sender_key) ? 'You' : String(m.sender_name || '').split(' (')[0], at: m.created_at, snippet: previewOf(m) || fileLabel(m) });
  }
  return out.slice(0, 200);
}
/** Must this member's read marker be stamped "delivered" now? (something from someone else is newer than what they got) */
function needsDelivered(msgs, readRow, meKeys) {
  const set = new Set(meKeys || []);
  const got = [String((readRow && readRow.last_read_at) || ''), String((readRow && readRow.delivered_at) || '')].sort().pop();
  return (msgs || []).some(m => alive(m) && !set.has(m.sender_key) && String(m.created_at) > got);
}

module.exports = {
  MAX_BODY, MAX_MEMBERS, DESKS, STUDENT_DESKS, PARENT_DESKS, DEFAULT_POLICY, FILE_MAX, FILE_INLINE_MAX,
  key, parseKey, validKey, dmId, deskId, readId, cleanBody, cleanTitle, cleanFile, membersOf, namesOf, policyOf, isMember,
  canStart, canCreateGroup, newConversation, titleFor, summarize, thread, newMessage, readMarker, REACTIONS, reactionId, enrich,
  previewOf, EDIT_WINDOW_MS, REPORT_REASONS, RESTRICT_DAYS, MODERATORS, FORWARD_MAX, blockId, restrictionId, reportId, peerOf, hasBlocked, restrictionOf,
  canBlock, blockRow, sendBlock, canEdit, editPatch, canPin, forwardCopy, newReport, canModerate, moderatorSees, decide, reportContext, search, pushPlan,
  POST_MODES, adminsOf, isGroupAdmin, groupView, groupPatch, cleanMentions, messageInfo, moderate, liftPause, reportView,
  POLL_MAX, pollVoteId, starId, newPoll, voteRow, canClosePoll, pollView, starredList, needsDelivered,
};
