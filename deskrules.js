'use strict';
/**
 * 🏢 THE OFFICE DESKS AS A HELP DESK — pure; shared by the desktop (electron/services/chat.js), the portal and the
 * office app (server/portal.js) and the cloud edge. A desk conversation (kind 'desk', members [person, 'r:<role>'])
 * is one of:
 *   waiting  — the person wrote and the office has not answered since (the queue shows the oldest first)
 *   answered — the office replied last
 *   resolved — an officer closed it; it reopens by itself as soon as the person writes again
 * Around that: who handles it (assigned_to), quick replies, office hours with an automatic out-of-hours reply, a
 * 👍 / 👎 from the person once it is resolved, and the desk's numbers (open, waiting, first-reply time, satisfaction).
 */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const AUTO_GAP_MS = 12 * 3600000;          // at most one automatic reply per conversation every 12 hours
const DEFAULT_HOURS = { days: [1, 2, 3, 4, 5], from: '08:00', to: '16:00' };

const parse = (s, d) => { if (s && typeof s === 'object') return s; try { const v = JSON.parse(s == null ? 'null' : s); return v == null ? d : v; } catch (_) { return d; } };
const alive = (r) => !!r && !Number(r.deleted);
const membersOf = (c) => { const m = parse(c && c.members, []); return Array.isArray(m) ? m : []; };
const byAt = (a, b) => String(a.created_at).localeCompare(String(b.created_at));
const firstName = (n) => String(n || '').split(' (')[0].split(' — ')[0].trim().split(/\s+/)[0] || '';

/** The office role a desk conversation belongs to (null for anything else). */
function deskOf(conv) { if (!conv || conv.kind !== 'desk') return null; const k = membersOf(conv).find(x => typeof x === 'string' && x.startsWith('r:')); return k ? k.slice(2) : null; }
/** The person who wrote to the desk. */
function personOf(conv) { return membersOf(conv).find(x => typeof x === 'string' && !x.startsWith('r:')) || null; }

/** waiting / answered / resolved — and since when the person has been waiting. */
function statusOf(conv, msgs) {
  const person = personOf(conv);
  const real = (msgs || []).filter(m => alive(m) && m.conversation_id === conv.id && !m.call_id && !Number(m.auto)).sort(byAt);
  const last = real[real.length - 1] || null;
  let waitingSince = null;
  for (let i = real.length - 1; i >= 0; i--) { if (real[i].sender_key === person) waitingSince = real[i].created_at; else break; }
  const resolvedAt = String(conv.resolved_at || '');
  const reopened = !!(last && last.sender_key === person && String(last.created_at) > resolvedAt);
  const status = conv.desk_status === 'resolved' && !reopened ? 'resolved' : waitingSince ? 'waiting' : 'answered';
  return { status, waiting_since: status === 'waiting' ? waitingSince : null, last_at: last ? last.created_at : conv.created_at, person };
}
/** How long each request waited for its first answer (ms) — a request starts when the person writes after an answer. */
function firstReplies(conv, msgs) {
  const person = personOf(conv); const out = []; let start = null;
  for (const m of (msgs || []).filter(x => alive(x) && x.conversation_id === conv.id && !x.call_id && !Number(x.auto)).sort(byAt)) {
    if (m.sender_key === person) { if (start == null) start = Date.parse(m.created_at); }
    else if (start != null) { out.push(Math.max(0, Date.parse(m.created_at) - start)); start = null; }
  }
  return out;
}
/**
 * The desk queue for an officer: their desks' conversations, waiting ones first (oldest first), then answered (newest
 * first), resolved last. filter: waiting | mine | unassigned | answered | resolved | all.
 */
function queue(convs, msgsByConv, roles, { filter, meKey, nowIso } = {}) {
  const set = new Set(roles || []); const now = Date.parse(nowIso || new Date().toISOString());
  const rank = { waiting: 0, answered: 1, resolved: 2 };
  const rows = [];
  for (const c of convs || []) {
    if (!alive(c)) continue; const role = deskOf(c); if (!role || !set.has(role)) continue;
    const ms = (msgsByConv && msgsByConv.get ? msgsByConv.get(c.id) : (msgsByConv || {})[c.id]) || [];
    const st = statusOf(c, ms);
    const names = parse(c.member_names, {});
    const last = ms.filter(m => alive(m) && !m.call_id).sort(byAt).pop();
    const row = { id: c.id, desk: role, person: st.person, title: String(names[st.person] || 'Someone').split(' — ')[0], status: st.status, waiting_since: st.waiting_since,
      waiting_min: st.waiting_since ? Math.max(0, Math.round((now - Date.parse(st.waiting_since)) / 60000)) : null, last_at: st.last_at,
      last_preview: last ? (String(last.body || '') || (last.file_name ? '📎 ' + last.file_name : '')).slice(0, 90) : '',
      assigned_to: c.assigned_to || null, assigned_name: c.assigned_name || null, mine: !!(meKey && c.assigned_to === meKey), rating: c.rating == null ? null : Number(c.rating) };
    const f = filter || 'open';
    if (f === 'waiting' && row.status !== 'waiting') continue;
    if (f === 'answered' && row.status !== 'answered') continue;
    if (f === 'resolved' && row.status !== 'resolved') continue;
    if (f === 'open' && row.status === 'resolved') continue;
    if (f === 'mine' && (!row.mine || row.status === 'resolved')) continue;
    if (f === 'unassigned' && (row.assigned_to || row.status === 'resolved')) continue;
    rows.push(row);
  }
  return rows.sort((a, b) => (rank[a.status] - rank[b.status]) || (a.status === 'waiting' ? String(a.waiting_since).localeCompare(String(b.waiting_since)) : String(b.last_at).localeCompare(String(a.last_at))));
}
const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** The desk's numbers: open / waiting now, resolved and first-reply times since \`sinceIso\`, satisfaction from ratings. */
function stats(convs, msgsByConv, roles, sinceIso) {
  const set = new Set(roles || []); const since = String(sinceIso || '');
  let open = 0, waiting = 0, resolved = 0, up = 0, down = 0; const firsts = [];
  for (const c of convs || []) {
    if (!alive(c)) continue; const role = deskOf(c); if (!role || !set.has(role)) continue;
    const ms = (msgsByConv && msgsByConv.get ? msgsByConv.get(c.id) : (msgsByConv || {})[c.id]) || [];
    const st = statusOf(c, ms);
    if (st.status !== 'resolved') open++; if (st.status === 'waiting') waiting++;
    if (st.status === 'resolved' && String(c.resolved_at || '') >= since) resolved++;
    if (c.rating != null && String(c.rated_at || '') >= since) { if (Number(c.rating) > 0) up++; else if (Number(c.rating) < 0) down++; }
    // first replies to requests that started in the period
    const person = personOf(c); let start = null;
    for (const m of ms.filter(x => alive(x) && !x.call_id && !Number(x.auto)).sort(byAt)) {
      if (m.sender_key === person) { if (start == null) start = m.created_at; }
      else if (start != null) { if (String(start) >= since) firsts.push(Math.max(0, Date.parse(m.created_at) - Date.parse(start))); start = null; }
    }
  }
  const med = median(firsts); const avg = firsts.length ? firsts.reduce((a, b) => a + b, 0) / firsts.length : null;
  return { open, waiting, resolved, replies: firsts.length, first_reply_median_min: med == null ? null : Math.round(med / 60000), first_reply_avg_min: avg == null ? null : Math.round(avg / 60000),
    rated: up + down, up, down, satisfaction_pct: up + down ? Math.round(100 * up / (up + down)) : null };
}

// ---------------------------------------------------------------------------------------------------------------
// 🕘 OFFICE HOURS + the automatic out-of-hours reply. settings = a desk_settings row:
//   { id: role, hours: '{"days":[1,2,3,4,5],"from":"08:00","to":"16:00"}', auto_reply: 0|1, message: '' }
// tz = the institution's IANA time zone (its country pack); local time is read through Intl, like apptrules.localNow.
// ---------------------------------------------------------------------------------------------------------------
function local(tz, date) {
  const d = date || new Date();
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
    return { dow: DOW[p.weekday] == null ? d.getDay() : DOW[p.weekday], hm: String(p.hour).padStart(2, '0') + ':' + String(p.minute).padStart(2, '0') };
  } catch (_) { return { dow: d.getDay(), hm: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }; }
}
function hoursOf(settings) {
  const h = parse(settings && settings.hours, null);
  const ok = h && Array.isArray(h.days) && /^\d\d:\d\d$/.test(h.from || '') && /^\d\d:\d\d$/.test(h.to || '') && h.from < h.to;
  return ok ? { days: h.days.map(Number).filter(n => n >= 0 && n <= 6), from: h.from, to: h.to } : Object.assign({}, DEFAULT_HOURS);
}
function cleanSettings(p) {
  const days = [...new Set((Array.isArray(p && p.days) ? p.days : DEFAULT_HOURS.days).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const from = /^\d\d:\d\d$/.test((p && p.from) || '') ? p.from : DEFAULT_HOURS.from; const to = /^\d\d:\d\d$/.test((p && p.to) || '') ? p.to : DEFAULT_HOURS.to;
  if (!days.length) throw new Error('Choose the days the office is open.');
  if (from >= to) throw new Error('The closing time must be after the opening time.');
  return { hours: JSON.stringify({ days, from, to }), auto_reply: p && p.auto_reply ? 1 : 0, message: String((p && p.message) || '').replace(/\s+$/, '').slice(0, 600) };
}
function isOpen(settings, tz, date) { const h = hoursOf(settings); const l = local(tz, date); return h.days.includes(l.dow) && l.hm >= h.from && l.hm < h.to; }
/** "today at 08:00" · "tomorrow at 08:00" · "Monday at 08:00" */
function nextOpen(settings, tz, date) {
  const h = hoursOf(settings); const l = local(tz, date);
  if (h.days.includes(l.dow) && l.hm < h.from) return 'today at ' + h.from;
  for (let a = 1; a <= 7; a++) { const d = (l.dow + a) % 7; if (h.days.includes(d)) return (a === 1 ? 'tomorrow' : DAYS[d]) + ' at ' + h.from; }
  return 'soon';
}
/** Should the desk answer automatically now? (out of hours, the person wrote last, no automatic reply in 12 hours) */
function autoReplyDue(settings, tz, conv, msgs, date) {
  if (!settings || !Number(settings.auto_reply) || isOpen(settings, tz, date)) return false;
  const person = personOf(conv); const now = (date || new Date()).getTime();
  const ms = (msgs || []).filter(m => alive(m) && m.conversation_id === conv.id).sort(byAt);
  const last = ms[ms.length - 1]; if (!last || last.sender_key !== person) return false;
  return !ms.some(m => Number(m.auto) && now - Date.parse(m.created_at) < AUTO_GAP_MS);
}
function autoReplyText(settings, deskName, tz, date) {
  const next = nextOpen(settings, tz, date); const custom = String((settings && settings.message) || '').trim();
  if (custom) return custom.replace(/\{next\}/g, next).replace(/\{desk\}/g, deskName || 'office').slice(0, 800);
  return 'Thank you for your message. The ' + (deskName || 'office') + ' is closed right now — we open again ' + next + '. Your message is waiting for us and we will answer it then.';
}

// ---------------------------------------------------------------------------------------------------------------
// ⚡ QUICK REPLIES · 👤 ASSIGNMENT · ✅ RESOLVE · 👍 RATING
// ---------------------------------------------------------------------------------------------------------------
function cleanReply(p) {
  const title = String((p && p.title) || '').replace(/\s+/g, ' ').trim().slice(0, 80); const body = String((p && p.body) || '').trim().slice(0, 2000);
  if (!title) throw new Error('Give the quick reply a short name.'); if (!body) throw new Error('Write the reply.');
  return { title, body };
}
/** {name} → the person's first name · {desk} → the office · {officer} → who is answering */
function fillTemplate(body, { name, desk, officer } = {}) {
  return String(body || '').replace(/\{name\}/g, firstName(name) || 'there').replace(/\{desk\}/g, desk || 'office').replace(/\{officer\}/g, firstName(officer) || '');
}
function assignPatch(toKey, toName, nowIso) { return { assigned_to: toKey || null, assigned_name: toKey ? String(toName || '').slice(0, 120) : null, updated_at: nowIso || new Date().toISOString() }; }
function resolvePatch(on, byName, nowIso) {
  const at = nowIso || new Date().toISOString();
  return on ? { desk_status: 'resolved', resolved_at: at, resolved_by: String(byName || '').slice(0, 120), rating: null, rating_note: null, rated_at: null, updated_at: at }
    : { desk_status: 'open', resolved_at: null, updated_at: at };
}
/** The person rates a resolved request 👍 (1) or 👎 (-1). */
function ratePatch(conv, msgs, meKeys, rating, note, nowIso) {
  if (!deskOf(conv)) throw new Error('Only office requests can be rated.');
  if (!(meKeys || []).includes(personOf(conv))) throw new Error('Only the person who asked can rate it.');
  if (statusOf(conv, msgs).status !== 'resolved') throw new Error('You can rate a request once the office has marked it resolved.');
  const r = Number(rating); if (r !== 1 && r !== -1) throw new Error('Choose 👍 or 👎.');
  return { rating: r, rating_note: String(note || '').trim().slice(0, 500), rated_at: nowIso || new Date().toISOString() };
}
/** What the person sees about their request: status, who handles it, may they rate it. */
function personView(conv, msgs) {
  const st = statusOf(conv, msgs);
  return { status: st.status, assigned_name: conv.assigned_name ? firstName(conv.assigned_name) : null, resolved_by: conv.resolved_by ? firstName(conv.resolved_by) : null,
    can_rate: st.status === 'resolved' && conv.rating == null, rating: conv.rating == null ? null : Number(conv.rating) };
}

module.exports = { DAYS, AUTO_GAP_MS, DEFAULT_HOURS, deskOf, personOf, statusOf, firstReplies, queue, stats, local, hoursOf, cleanSettings, isOpen, nextOpen, autoReplyDue, autoReplyText,
  cleanReply, fillTemplate, assignPatch, resolvePatch, ratePatch, personView, firstName };
