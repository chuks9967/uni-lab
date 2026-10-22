'use strict';
/**
 * 🙋 THE PRESENCE FOLD — how one "I am still in the class" event turns into accumulated time.
 *
 * ⚠ SHARED ON PURPOSE, and this is the whole reason the file exists. A student attends a live class
 * from the PORTAL (server/portal.js, and the Deno edge deployment of it) while the register is
 * proposed on the DESKTOP (electron/services/liveattendance.js). If the two sides folded events even
 * slightly differently, the minutes a student is credited would depend on which machine happened to
 * receive the ping — and the first anyone would learn of it is a student appealing being barred from
 * an exam. One function, both callers.
 *
 * Pure: no DB, no clock of its own, no I/O. Every event carries its own timestamp, so the same input
 * always folds to the same output and it can be tested directly.
 */

// How long a session with no ping is assumed to have lasted. A student who closes the lid or loses
// data sends no "leave", so the last ping is all we know: crediting the whole interval would reward
// dropping out, and crediting nothing would punish a bad connection. One ping interval is the honest
// middle — and it is exactly what the client is told to send.
const PING_SECONDS = 60;
// A gap longer than this means they were GONE, not merely between pings, so the time is not credited.
const GAP_TOLERANCE = 3 * PING_SECONDS;

/**
 * Fold one presence event into the running total. Never mutates its input; returns the new state.
 *
 *   join  — a (re)connection. `joins` is kept as a DATA-QUALITY signal: "this student reconnected
 *           seven times" is a fact about the network, not about the student, and a lecturer looking
 *           at a short total needs to see it before marking anyone absent.
 *   ping  — still here. Credits the time since we last heard from them, unless the gap is so long
 *           that they were plainly gone and came back without saying so.
 *   leave — credits the final stretch the same way.
 */
function fold(row, event) {
  const at = (event && event.at) || new Date().toISOString();
  const prev = row || { seconds: 0, joins: 0, first_seen: at, last_seen: null };
  const out = {
    seconds: Number(prev.seconds) || 0,
    joins: Number(prev.joins) || 0,
    first_seen: prev.first_seen || at,
    last_seen: at,
  };
  if (event && event.type === 'join') { out.joins += 1; return out; }
  const last = prev.last_seen ? Date.parse(prev.last_seen) : NaN;
  const now = Date.parse(at);
  if (Number.isFinite(last) && Number.isFinite(now) && now > last) {
    const gap = Math.round((now - last) / 1000);
    out.seconds += gap <= GAP_TOLERANCE ? gap : PING_SECONDS;
  } else if ((Number(prev.joins) || 0) > 0 && !Number.isFinite(last)) {
    out.seconds += PING_SECONDS;          // the first ping after a join
  }
  return out;
}

module.exports = { fold, PING_SECONDS, GAP_TOLERANCE };
