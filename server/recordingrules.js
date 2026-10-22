'use strict';
/**
 * 🎥 THE RULES A CLASS RECORDING OBEYS — object-storage key derivation, HTTP Range maths, a human
 * duration, and the short-lived HMAC UPLOAD TOKEN that lets the sandboxed desktop class window push
 * its chunks to the portal without a portal session.
 *
 * ⚠ SHARED ON PURPOSE, exactly like server/classmaterialrules.js. A recording is produced from TWO
 * host seats — the desktop class window (electron/services/liveclasses.js) and the staff portal
 * (server/portal.js) — and consumed by a THIRD (the hub / edge streaming routes). The key scheme and
 * especially the token check are security-relevant, so a second copy is a copy that eventually rots.
 *
 * Pure: no DB, no filesystem, no clock beyond Date.now() for token expiry. Unit-tested through
 * test/liveclass-suite.js ([recording] block).
 */
const crypto = require('crypto');

// A recording NEVER rides inline in a synced row — it is always in object storage. This ceiling is the
// object-storage one (matches classmaterialrules.OFFLOAD_MAX): a ~2h lecture at the low bitrate the
// recorder uses (~800 kbps) is ~700MB, so we cap the ASSEMBLED size here and the recorder warns as it
// approaches. Each uploaded CHUNK is bounded separately (CHUNK_MAX) so one part never blows the body cap.
const REC_MAX = 700 * 1024 * 1024;
const CHUNK_MAX = 6 * 1024 * 1024;      // one MediaRecorder timeslice; well under the portal body cap
const REC_STATES = ['recording', 'processing', 'ready', 'failed'];

/** The container extension for a recording, from its MIME (we record webm; mp4 kept for completeness). */
function recExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.indexOf('mp4') >= 0) return 'mp4';
  if (m.indexOf('ogg') >= 0) return 'ogg';
  return 'webm';
}

// Deterministic, re-derivable keys (mirrors blobstore's "prefix/<id>" convention). The assembled object,
// each in-flight part, the transcript and an optional poster each get their own namespace.
function recKey(id, mime) { return 'rec/' + String(id) + '.' + recExt(mime); }
function partKey(id, seq) { return 'recpart/' + String(id) + '/' + String(seq).padStart(6, '0'); }
function transcriptKey(id) { return 'rectxt/' + String(id) + '.vtt'; }
function posterKey(id) { return 'recposter/' + String(id) + '.jpg'; }

/** A human clock duration: 75 → "1:15", 3723 → "1:02:03". */
function humanDuration(sec) {
  let s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? (h + ':' + pad(m) + ':' + pad(s)) : (m + ':' + pad(s));
}

/**
 * Parse an HTTP `Range: bytes=…` header against a known content length.
 * Returns:
 *   null                         — no/invalid range → caller serves the whole thing (200)
 *   { satisfiable:false }        — the range lies past the end → caller replies 416
 *   { start, end, length }       — inclusive byte range → caller replies 206
 * Handles `bytes=START-END`, `bytes=START-` (to EOF) and `bytes=-SUFFIX` (last N bytes).
 */
function parseRange(header, size) {
  const total = Number(size) || 0;
  const h = String(header || '').trim();
  if (!h || !/^bytes=/i.test(h)) return null;
  const spec = h.replace(/^bytes=/i, '').split(',')[0].trim();   // single range only (all we need)
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {                                             // suffix: last N bytes
    const n = Number(m[2]);
    if (!n) return { satisfiable: false };
    start = Math.max(0, total - n); end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total - 1 : Number(m[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= total) return { satisfiable: false };
  if (end >= total) end = total - 1;
  return { start, end, length: end - start + 1 };
}

// ---- the short-lived HMAC upload token (the desktop-window capability) ------------------------------
// The desktop class window is a sandboxed BrowserWindow with no portal session, so it cannot sign chunk
// uploads with a normal login. Instead openLiveClass mints THIS token — an HMAC over {room,rid,exp}
// keyed by the shared sync_token — and embeds it in the page. The portal's recording routes accept it
// ONLY for the room it names and only until it expires, so it grants exactly "upload chunks for this one
// recording" and nothing else. Same construction shape as server/jitsi.js's JWT (base64url payload.sig).
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function unb64url(s) { try { return Buffer.from(String(s || ''), 'base64url'); } catch (_) { return Buffer.alloc(0); } }

function signUpload(secret, payload = {}, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    room: String(payload.room || ''),
    rid: String(payload.rid || payload.recordingId || ''),
    exp: Number(payload.exp) > 0 ? Number(payload.exp) : now + (Number(ttlSec) > 0 ? Number(ttlSec) : 6 * 60 * 60),
  };
  const enc = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', String(secret || '')).update(enc).digest();
  return enc + '.' + b64url(sig);
}

/** Verify an upload token. Returns the payload when the signature is valid, not expired, and (when
 *  `expect.room`/`expect.rid` are supplied) matches them. Constant-time signature compare. Else null. */
function verifyUpload(secret, token, expect = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [enc, sig] = parts;
  const want = crypto.createHmac('sha256', String(secret || '')).update(enc).digest();
  const got = unb64url(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let body; try { body = JSON.parse(unb64url(enc).toString('utf8')); } catch (_) { return null; }
  if (!body || typeof body !== 'object') return null;
  if (Number(body.exp) && Math.floor(Date.now() / 1000) > Number(body.exp)) return null;
  if (expect.room && String(expect.room) !== String(body.room)) return null;
  if (expect.rid && String(expect.rid) !== String(body.rid)) return null;
  return body;
}

module.exports = {
  REC_MAX, CHUNK_MAX, REC_STATES,
  recExt, recKey, partKey, transcriptKey, posterKey, humanDuration, parseRange,
  signUpload, verifyUpload,
};
