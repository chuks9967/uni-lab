'use strict';
/**
 * 🪪 THE LIVE DIGITAL STUDENT ID — ONE pure module (portal · edge; the app does the same arithmetic in Kotlin).
 *
 * 🐛 THE HOLES THIS FILLS
 *  • The app's ID card QR was a plain link with the matric number, and that public check returned the student's NAME and
 *    PHOTO for ANY matric number — anyone could walk the numbers and collect the class's faces. → a bare number now only
 *    confirms enrolment with initials (no photo), rate-limited; the full card needs a code the student's phone made.
 *  • A screenshot of an ID card worked for the whole session — passed around, it got anyone into an exam hall or a hostel.
 *    → the card shows a LIVE code that changes every 30 seconds, made ON THE PHONE (like an authenticator app, so it
 *    works with no signal): HMAC of (student, time window) with a key only that student's phone holds. A screenshot
 *    stops verifying within about a minute; the check page shows the photo for the gate to compare.
 *  • A lost phone kept a working card. → the Registry re-issues the card (a new key version); the old phone's codes stop.
 *
 *   liveKey(root, sid, ver) · windowOf(ms) · code(key, sid, w) · payload(key, sid, ms) · parse(text) · check(text, keyFor, ms) · initials(name)
 */
const crypto = require('crypto');
const PERIOD = 30;   // seconds a code lasts on screen
const SLACK = 2;     // windows either side still accepted (a clock a little off, the seconds it takes to scan)

/** The student's own key (hex), derived from the server's ID root key — the phone gets it once, over the signed-in API. */
const liveKey = (root, sid, ver) => crypto.createHmac('sha256', root).update('idlive|' + String(sid) + '|' + (Math.max(1, Number(ver) || 1))).digest('hex');
const windowOf = (ms) => Math.floor(Number(ms) / 1000 / PERIOD);
/** 12 characters of HMAC-SHA256(key as UTF-8 text, "sid.window"), base64url — the same in Kotlin (javax.crypto + Base64.URL_SAFE). */
const code = (key, sid, w) => crypto.createHmac('sha256', String(key)).update(String(sid) + '.' + String(w)).digest('base64url').slice(0, 12);
const payload = (key, sid, ms) => { const w = windowOf(ms); return String(sid) + '.' + w + '.' + code(key, sid, w); };

/** "sid.window.code" — on its own, or inside a link (…/verify-id?l=…). */
function parse(text) {
  let s = String(text || '').trim();
  const m = /[?&]l=([^&#\s]+)/.exec(s); if (m) { try { s = decodeURIComponent(m[1]); } catch (_) { s = m[1]; } }
  const p = /^([A-Za-z0-9-]{4,64})\.(\d{1,12})\.([A-Za-z0-9_-]{12})$/.exec(s);
  return p ? { sid: p[1], w: Number(p[2]), c: p[3] } : null;
}
/** → { ok, sid, fresh, age_s } | { ok:false, reason }. keyFor(sid) → the student's current key, or null (no such student). */
function check(text, keyFor, nowMs) {
  const x = parse(text); if (!x) return { ok: false, reason: 'This is not a student ID code.' };
  const key = keyFor(x.sid); if (!key) return { ok: false, reason: 'This ID code is not genuine.' };
  const want = code(key, x.sid, x.w);
  if (want.length !== x.c.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(x.c))) return { ok: false, reason: 'This ID code is not genuine (or the card was re-issued).' };
  const nowW = windowOf(nowMs == null ? Date.now() : nowMs);
  const age = Math.round(((nowMs == null ? Date.now() : nowMs) - x.w * PERIOD * 1000) / 1000);
  if (x.w > nowW + SLACK) return { ok: true, sid: x.sid, fresh: false, age_s: age, reason: 'The phone’s clock is wrong — ask the student to set the time automatically.' };
  return { ok: true, sid: x.sid, fresh: nowW - x.w <= SLACK, age_s: Math.max(0, age) };
}
/** "Amara Okoye" → "A. O." — what a bare matric number may reveal. */
const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + '.').join(' ');

module.exports = { PERIOD, SLACK, liveKey, windowOf, code, payload, parse, check, initials };
