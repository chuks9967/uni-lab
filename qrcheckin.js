'use strict';
/**
 * 📷 QR SELF CHECK-IN — the lecturer's screen shows a QR code (and the same 6-digit code in large type) that
 * CHANGES EVERY 20 SECONDS; a student scans it with the phone camera (or types the code) and is marked present
 * on that lecture's register. A code is accepted for its own window and the one before (≤ 40 s old), so a photo
 * of the screen forwarded to a friend at home is useless by the time it arrives.
 *
 * The code is an HMAC of (register id, time window) under the portal's own secret key — nothing is stored, every
 * portal instance computes the same code, and it cannot be guessed from earlier codes.
 */
const crypto = require('crypto');

const STEP_S = 20;
const windowOf = (ms) => Math.floor((Number(ms) || Date.now()) / 1000 / STEP_S);
function codeFor(key, registerId, win) {
  const h = crypto.createHmac('sha256', String(key || '')).update('qr|' + String(registerId) + '|' + String(win)).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}
function currentCode(key, registerId, nowMs) { const w = windowOf(nowMs); return { code: codeFor(key, registerId, w), expires_in: STEP_S - Math.floor(((Number(nowMs) || Date.now()) / 1000) % STEP_S) }; }
/** Accept the current window and the previous one. Constant-time compare. */
function verify(key, registerId, code, nowMs) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return false;
  const w = windowOf(nowMs);
  for (const x of [w, w - 1]) { const good = codeFor(key, registerId, x); if (crypto.timingSafeEqual(Buffer.from(good), Buffer.from(c))) return true; }
  return false;
}
/** Is the register still taking check-ins? */
function isOpen(reg, nowIso) { return !!reg && !Number(reg.deleted) && Number(reg.qr_open) === 1 && (!reg.qr_until || String(nowIso || new Date().toISOString()) <= String(reg.qr_until)); }
/** Pull a register id + code out of a scanned URL ("…/checkin?r=ID&c=123456") or plain input. */
function parseScan(text) {
  const s = String(text || '').trim();
  const r = /[?&]r=([^&#\s]+)/.exec(s), c = /[?&]c=(\d{6})/.exec(s);
  return { r: r ? decodeURIComponent(r[1]) : '', c: c ? c[1] : (/^\d{6}$/.test(s) ? s : '') };
}

module.exports = { STEP_S, windowOf, codeFor, currentCode, verify, isOpen, parseScan };
