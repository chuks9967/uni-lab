'use strict';
/**
 * SINGLE SOURCE OF TRUTH for the live-class (Jitsi) room id.
 *
 * The desktop host (electron/services/liveclasses.js) and the student/staff portal
 * (server/portal.js) MUST derive the EXACT SAME room id for a course, or a host opens
 * one Jitsi room while the cohort joins another and the class silently "doesn't connect".
 *
 * Historically each side hand-rolled the derivation with its own fallback constants, which
 * drifted: the desktop fell back to secret `'unibursar'` / short `'WAUU'` while the embedded
 * portal (syncserver.js) and the cloud server (server/server.js) inject secret
 * `'unibursar-portal'` / short `'UBU'`. When `sync_token` / `institution_short` were unset
 * (the default — sync is OFF by default), the two sides computed DIFFERENT rooms.
 *
 * Both sides now call this one function, so the scheme + fallbacks are byte-identical by
 * construction. The canonical fallbacks below match what syncserver.js + server.js inject
 * for `secret` and `institution().short`, so a fresh install (no settings) still aligns.
 */
const crypto = require('crypto');

const SECRET_FALLBACK = 'unibursar-portal';
const SHORT_FALLBACK = 'UBU';

/** Normalise the institution short code into a room prefix (lowercase alphanumerics). */
function shortPrefix(short) {
  return String(short || SHORT_FALLBACK).replace(/[^A-Za-z0-9]/g, '').toLowerCase()
    || String(SHORT_FALLBACK).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/**
 * Deterministic room id: `<shortPrefix>-<sha256(secret|liveclass|...parts)[:28]>`.
 * @param {string} secret  the shared sync_token (or '' / undefined → SECRET_FALLBACK)
 * @param {string} short   the institution short code (or '' / undefined → SHORT_FALLBACK)
 * @param {Array}  parts   the scope tuple, e.g. [department_id, level_id, session_id, course_code]
 */
function classRoom(secret, short, parts) {
  const raw = [secret || SECRET_FALLBACK, 'liveclass'].concat((parts || []).map(x => String(x || ''))).join('|');
  return shortPrefix(short) + '-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 28);
}

module.exports = { classRoom, shortPrefix, SECRET_FALLBACK, SHORT_FALLBACK };
