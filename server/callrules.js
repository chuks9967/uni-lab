'use strict';
/**
 * 📞 CALLS — pure rules for voice and video calls between the people of a conversation (a student and a classmate, a
 * student and a lecturer, a student and their head of department or dean, an office, a group…). Shared by the portal
 * (wherever it runs: cloud edge, Node hub, LAN hub) so every surface rings, answers and records calls the same way.
 *
 * A call belongs to a conversation, so whoever may talk in it may call in it (the messaging rules already decided who
 * may START a conversation). The media runs in a private video-meeting room (the same Jitsi / JaaS set-up as the live
 * classes); this module only decides the room, who rings, and what the call looked like afterwards ("Missed voice
 * call", "Video call · 4 min").
 *
 *   ringing → ongoing (someone answered) → ended          a 1:1 call nobody answers within RING_MS → missed
 *   ringing → declined (the only other person said no)    the caller hangs up before anyone answers → cancelled
 */
const crypto = require('crypto');

const RING_MS = 45 * 1000;            // how long a phone rings
const MAX_RING = 30;                  // a group call rings at most this many people (bigger groups use a live class)
const KINDS = ['voice', 'video'];
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const pj = (x, d) => { if (x && typeof x === 'object') return x; try { const v = JSON.parse(x == null ? 'null' : x); return v == null ? d : v; } catch (_) { return d; } };

/** A private, unguessable meeting room for one call. */
function roomFor(callId) { return 'ubu-call-' + sha('call|' + callId).slice(0, 20); }

/** The new call row (the caller persists it). members = the conversation's member keys. */
function newCall({ convId, members, callerKey, callerName, kind, now }) {
  const k = KINDS.includes(kind) ? kind : 'voice';
  const others = (members || []).filter(m => m !== callerKey);
  if (!others.length) throw new Error('There is nobody else in this conversation to call.');
  if (others.length > MAX_RING) throw new Error('This group is too big for a call — start a live class instead.');
  const at = now || new Date().toISOString();
  const id = 'call_' + crypto.randomBytes(12).toString('hex');
  return { id, conversation_id: convId, room: roomFor(id), kind: k, caller_key: callerKey, caller_name: String(callerName || '').slice(0, 120), status: 'ringing',
    started_at: at, answered_at: null, ended_at: null, participants: JSON.stringify([callerKey]), declined: JSON.stringify([]), ring: JSON.stringify(others), created_at: at, updated_at: at, deleted: 0 };
}
/** The call's real state now: an unanswered call stops ringing after RING_MS. */
function state(call, nowIso) {
  if (!call) return null;
  if (call.status !== 'ringing') return call.status;
  const now = Date.parse(nowIso || new Date().toISOString());
  return now - Date.parse(call.started_at) > RING_MS ? 'missed' : 'ringing';
}
/** Is this call ringing for this person right now (not the caller, has not declined)? */
function ringingFor(call, meKeys, nowIso) {
  if (!call || Number(call.deleted) || state(call, nowIso) !== 'ringing') return false;
  const me = new Set(meKeys || []);
  if (me.has(call.caller_key)) return false;
  if (pj(call.declined, []).some(k => me.has(k))) return false;
  return pj(call.ring, []).some(k => me.has(k));
}
/** Someone answered (or joined a call already going). → the patch to apply. */
function answer(call, key, nowIso) {
  const st = state(call, nowIso);
  if (!['ringing', 'ongoing'].includes(st)) throw new Error(st === 'missed' ? 'This call was missed.' : 'This call has ended.');
  const p = new Set(pj(call.participants, [])); p.add(key);
  return { status: 'ongoing', answered_at: call.answered_at || nowIso, participants: JSON.stringify([...p]), updated_at: nowIso };
}
/** Someone said no. A 1:1 call ends there; a group call keeps ringing the others. */
function decline(call, key, nowIso) {
  const d = new Set(pj(call.declined, [])); d.add(key);
  const ring = pj(call.ring, []);
  const everyone = ring.every(k => d.has(k));
  return Object.assign({ declined: JSON.stringify([...d]), updated_at: nowIso }, everyone && call.status === 'ringing' ? { status: 'declined', ended_at: nowIso } : {});
}
/** Someone hung up. The caller hanging up before an answer cancels it; otherwise the call ends when it is down to one. */
function hangUp(call, key, nowIso) {
  const st = state(call, nowIso);
  if (st === 'ringing') return key === call.caller_key ? { status: 'cancelled', ended_at: nowIso, updated_at: nowIso } : decline(call, key, nowIso);
  if (st === 'missed') return { status: 'missed', ended_at: call.ended_at || nowIso, updated_at: nowIso };
  if (st !== 'ongoing') return { updated_at: nowIso };
  const left = new Set(pj(call.left_keys, [])); left.add(key);
  const parts = pj(call.participants, []);
  const still = parts.filter(k => !left.has(k));
  return Object.assign({ left_keys: JSON.stringify([...left]), updated_at: nowIso }, still.length <= 1 ? { status: 'ended', ended_at: nowIso } : {});
}
/** How long it lasted (seconds) — from the answer to the end. */
function duration(call) { return call && call.answered_at && call.ended_at ? Math.max(0, Math.round((Date.parse(call.ended_at) - Date.parse(call.answered_at)) / 1000)) : 0; }
function fmtDuration(sec) { if (!sec) return ''; const m = Math.floor(sec / 60), s = sec % 60; return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m ? m + ' min' + (s && m < 5 ? ' ' + s + ' s' : '') : s + ' s'; }
/** What the call looks like in the conversation, for this reader. */
function summary(call, meKeys, nowIso) {
  const st = state(call, nowIso); const me = new Set(meKeys || []);
  const kind = call.kind === 'video' ? 'video' : 'voice'; const icon = kind === 'video' ? '🎥' : '📞';
  const mine = me.has(call.caller_key);
  let text;
  if (st === 'ringing') text = (mine ? 'Calling…' : 'Incoming ' + kind + ' call');
  else if (st === 'ongoing') text = (kind === 'video' ? 'Video' : 'Voice') + ' call in progress — tap to join';
  else if (st === 'ended') text = (kind === 'video' ? 'Video' : 'Voice') + ' call · ' + (fmtDuration(duration(call)) || 'under a minute');
  else if (st === 'declined') text = mine ? (kind === 'video' ? 'Video' : 'Voice') + ' call — declined' : 'You declined a ' + kind + ' call';
  else if (st === 'cancelled') text = mine ? 'Cancelled ' + kind + ' call' : 'Missed ' + kind + ' call';
  else text = mine ? 'No answer — ' + kind + ' call' : 'Missed ' + kind + ' call';
  return { id: call.id, kind, status: st, icon, text, mine, joinable: st === 'ringing' || st === 'ongoing', duration: duration(call), from: call.caller_name || '' };
}

module.exports = { RING_MS, MAX_RING, KINDS, roomFor, newCall, state, ringingFor, answer, decline, hangUp, duration, fmtDuration, summary };
