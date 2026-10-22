'use strict';
/**
 * 🙋 THE REGISTER RULES — how measured presence becomes a PROPOSED attendance mark.
 *
 * ⚠ SHARED ON PURPOSE. The register is proposed in two places: on the DESKTOP desk
 * (electron/services/liveattendance.js, where the administration works) and on the STAFF PORTAL
 * (server/portal.js, where the LECTURER who actually taught the class works). If the two computed
 * the bar differently, the same student could be present on one screen and absent on the other — and
 * the first anyone would hear of it is an appeal against being barred from an exam.
 *
 * Pure: no DB, no clock, no I/O. Each caller does its own data access and hands the numbers in.
 */

const MIN_PER_HOUR = 60;

/**
 * The bar, resolved from raw setting values (which arrive as strings, or absent).
 *
 * ⚠ `Number(null)` is 0 and `0 >= 0` passes, so reading an unset setting straight through Number()
 * silently produced a floor of ZERO minutes — which would mark a student present for touching the
 * room for one second. An absent setting must fall back to the default, never to 0.
 */
function presenceRule(rawPct, rawMinMinutes) {
  const num = (v) => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const pct = num(rawPct);
  const floor = num(rawMinMinutes);
  return {
    pct: pct != null && pct > 0 && pct <= 100 ? pct : 60,
    minMinutes: floor != null && floor >= 0 ? floor : 5,
  };
}

/**
 * How many seconds a student must have been present for.
 *
 * Deliberately a PROPORTION of how long the class actually ran, not a fixed number of minutes: a
 * twenty-minute tutorial and a three-hour practical cannot share a threshold, and a fixed one would
 * mark an entire tutorial group absent. The FLOOR then stops the reverse absurdity — 60% of a class
 * that ran four minutes is not attendance either.
 */
function barFor(ranSeconds, rule) {
  const r = rule || presenceRule();
  return Math.max(r.minMinutes * 60, Math.round((Number(ranSeconds) || 0) * r.pct / 100));
}

/** A duration a human can read, for the officer's screen and the refusal messages. */
function fmtMins(s) {
  const m = Math.round((Number(s) || 0) / 60);
  if (m < MIN_PER_HOUR) return m + ' min';
  return Math.floor(m / MIN_PER_HOUR) + 'h ' + String(m % MIN_PER_HOUR).padStart(2, '0') + 'm';
}

/**
 * THE PROPOSED REGISTER.
 *
 * `roster` is EVERY student of the cohort — including those who never appeared, because a register is
 * about the whole class and a list of only the people who showed up is not a register.
 *
 * `presenceById` maps student id → { seconds, joins, first_seen, last_seen }.
 *
 * `partial` marks a student who was demonstrably in the class but short of the bar. That is the case
 * a lecturer must SEE rather than have silently marked absent: they were there, their connection may
 * not have been.
 */
function buildProposal({ ranSeconds, rule, roster, presenceById } = {}) {
  const r = rule || presenceRule();
  const needed = barFor(ranSeconds, r);
  const seen = presenceById || {};
  const rows = (roster || []).map(s => {
    const p = seen[s.id] || null;
    const secs = p ? Number(p.seconds) || 0 : 0;
    return {
      student_id: s.id, matric: s.matric || '', name: s.name || '',
      seconds: secs, minutes: fmtMins(secs), joins: p ? Number(p.joins) || 0 : 0,
      first_seen: p ? p.first_seen : null, last_seen: p ? p.last_seen : null,
      mark: secs >= needed && secs > 0 ? 'p' : 'a',
      partial: secs > 0 && secs < needed,
    };
  });
  return {
    rule: r,
    ranSeconds: Number(ranSeconds) || 0, ranLabel: fmtMins(ranSeconds),
    neededSeconds: needed, neededLabel: fmtMins(needed),
    rows,
    present: rows.filter(x => x.mark === 'p').length,
    absent: rows.filter(x => x.mark === 'a').length,
    partial: rows.filter(x => x.partial).length,
    // an honest caveat the UI shows: with no session recorded we cannot know how long the class ran,
    // so only the floor applies and the officer should check the marks before confirming
    measured: (Number(ranSeconds) || 0) > 0,
  };
}

/** How long a class RAN, summed over its sessions that day. Callers pass the rows they already hold. */
function ranSecondsFrom(sessions) {
  let total = 0;
  for (const s of (sessions || [])) {
    const a = Date.parse(s.started_at || ''), b = Date.parse(s.heartbeat_at || s.updated_at || s.started_at || '');
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) total += Math.round((b - a) / 1000);
  }
  return total;
}

module.exports = { presenceRule, barFor, buildProposal, ranSecondsFrom, fmtMins };
