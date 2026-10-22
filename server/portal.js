'use strict';
/**
 * UniBursar Online Portal — served by the sync hub (server.js).
 *
 * Every account synced from the desktop app (officers, students, staff,
 * lecturers) can log in here from anywhere and see live data: students view
 * fees/payments/receipts, staff & lecturers view payslips, officers see their
 * reports. Data is read straight from the synced central store, so anything the
 * accountant (or any user) changes in the app appears here on the next sync.
 *
 * Pure Node — no dependencies. Mounted by server.js via createPortal().
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// pure-Node QR encoder (no npm deps — keeps the hub zero-dependency). Used to print a
// SCANNABLE verification QR on portal receipts & payslips.
let qrcode = null; try { qrcode = require('./qrcode'); } catch (_) { qrcode = null; }
// 8x8 JaaS / self-host JWT helper (zero-dep) — removes the meet.jit.si Google-login wall for live classes.
let jitsi = null; try { jitsi = require('./jitsi'); } catch (_) { jitsi = null; }
// SINGLE SOURCE OF TRUTH for the live-class room id — shared byte-for-byte with the desktop host
// (electron/services/liveclasses.js) so a host and the cohort always land in the SAME room.
const roomid = require('./roomid');
function verifyQrSvg(targetUrl) {
  if (!qrcode || !targetUrl) return '';
  // force a fixed display size (viewBox keeps it crisp + scannable at any QR version)
  try { return qrcode.toSVG(targetUrl, { ec: 'M', cellSize: 3, margin: 1 }).replace(/width="\d+" height="\d+"/, 'width="104" height="104"'); } catch (_) { return ''; }
}

const SYM = { NGN: '₦', XOF: 'CFA', USD: '$', EUR: '€', GBP: '£', GHS: '₵', KES: 'KSh', ZAR: 'R', GMD: 'D', SLL: 'Le' };
// zero-decimal currencies (CFA franc, yen, …) have no subunit — never show ".00" for them.
const ZERO_DEC_CUR = new Set(['JPY', 'KRW', 'VND', 'CLP', 'XOF', 'XAF', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'PYG', 'RWF', 'UGX', 'VUV', 'XPF']);
function money(a, c) { const d = ZERO_DEC_CUR.has(String(c || '').toUpperCase()) ? 0 : 2; const n = Number(a || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); return `${SYM[c] || (c ? c + ' ' : '')}${n}`; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function fmtDate(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return '—'; } }

// pure-Node scrypt hash/verify (matches electron/services/portalcreds.js)
function hashPass(password) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(password), salt, 32);
  return `s2$${salt.toString('hex')}$${h.toString('hex')}`;
}
// minimal RFC 6238 TOTP verify (officer MFA) — mirrors electron/services/totp.js, zero-dep
const TOTP_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totpDecode(s) { s = String(s || '').toUpperCase().replace(/=+$/, '').replace(/\s/g, ''); let bits = ''; for (const c of s) { const v = TOTP_B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); } const b = []; for (let i = 0; i + 8 <= bits.length; i += 8) b.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(b); }
function totpAt(secret, counter) { const buf = Buffer.alloc(8); let c = counter; for (let i = 7; i >= 0; i--) { buf[i] = c & 0xff; c = Math.floor(c / 256); } const h = crypto.createHmac('sha1', totpDecode(secret)).update(buf).digest(); const o = h[h.length - 1] & 0xf; const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff); return String(code % 1000000).padStart(6, '0'); }
function totpVerify(secret, code) { code = String(code || '').replace(/\D/g, ''); if (code.length !== 6 || !secret) return false; const step = Math.floor(Date.now() / 1000 / 30); for (let w = -1; w <= 1; w++) if (totpAt(secret, step + w) === code) return true; return false; }
function verifyPass(password, stored) {
  try {
    const [tag, saltHex, hashHex] = String(stored || '').split('$');
    if (tag !== 's2' || !saltHex || !hashHex) return false;
    const h = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
    const a = Buffer.from(hashHex, 'hex');
    return a.length === h.length && crypto.timingSafeEqual(a, h);
  } catch (_) { return false; }
}

const WORDS_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const WORDS_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const WORD_CCY = { NGN: 'Naira', XOF: 'CFA Francs', USD: 'Dollars', EUR: 'Euros', GBP: 'Pounds', GHS: 'Cedis', KES: 'Shillings' };
function below(n) { let s = ''; if (n >= 100) { s += WORDS_ONES[Math.floor(n / 100)] + ' Hundred'; n %= 100; if (n) s += ' '; } if (n >= 20) { s += WORDS_TENS[Math.floor(n / 10)]; n %= 10; if (n) s += '-' + WORDS_ONES[n]; } else if (n > 0) s += WORDS_ONES[n]; return s; }
function numWords(num) { num = Math.floor(Number(num) || 0); if (num === 0) return 'Zero'; const scales = ['', ' Thousand', ' Million', ' Billion']; const parts = []; let i = 0; while (num > 0) { const c = num % 1000; if (c) parts.unshift(below(c) + scales[i]); num = Math.floor(num / 1000); i++; } return parts.join(' ').trim(); }
function amountWords(a, c) { const whole = Math.floor(Number(a) || 0); const k = Math.round((Number(a) - whole) * 100); let s = `${numWords(whole)} ${WORD_CCY[c] || c}`; if (k > 0) s += ` and ${numWords(k)}/100`; return s + ' only'; }

module.exports = function createPortal(deps) {
  const { all, one, getVersion, secret, institution, update, create, registerDevice, jitsiConfig, onLiveStart, blobFetch, blobUrl, sendMail } = deps;
  // Multi-provider online-payment gateway (Paystack/Flutterwave). Injected by the hub; falls back to the
  // bundled module so it always works. Tests inject a MOCK so the money path runs without a live gateway.
  const gateway = (deps && deps.paymentGateway) || (function () { try { return require('./payments-gateway'); } catch (_) { return null; } })();
  // Resolve a row's binary: inline base64 (legacy) → Buffer, else fetch the offloaded object by key
  // (services/blobstore.js / server/blobstore.js, injected as blobFetch). Returns a Buffer or null.
  const resolveBlob = async (inlineB64, key) => {
    if (inlineB64) return Buffer.from(inlineB64, 'base64');
    if (key && typeof blobFetch === 'function') { try { return await blobFetch(key); } catch (_) { return null; } }
    return null;
  };
  // Live-class video config (8x8 JaaS app id/key, or a self-hosted Jitsi domain). On the hosted hub
  // this comes from server env; on the embedded desktop portal it comes from app settings.
  const jitsiCfg = () => { try { return (typeof jitsiConfig === 'function' ? jitsiConfig() : {}) || {}; } catch (_) { return {}; } };
  // ---- Online-exam proctor frames (transient, in-memory; never synced) ----
  // examFrames[examId][studentId] = { jpeg(base64), audioLevel, ts, ring:[base64,…] }
  const examFrames = {};
  const lastFrameTs = {};                         // per-student client-upload rate-limit
  const lastRelayTs = {};                         // per-student SHARED-relay write throttle (cuts cost on Cloud Run)
  const frameClient = {};                         // examId:studentId → { id, seen, conflicts, flagged } (concurrent-device detection)
  // A per-process id so the officer monitor can DETECT a multi-instance host (Cloud Run autoscaling),
  // which silently splits the in-memory relay — students upload to one instance, the officer reads
  // another, and no camera reaches the monitor. Surfaced in /api/exam/monitor.
  const INSTANCE_ID = crypto.randomBytes(4).toString('hex');
  // Optional SHARED relay (injected by server.js when EXAM_RELAY is on + Supabase is configured) so the
  // live camera survives multi-instance autoscaling: the in-memory examFrames becomes a fast local cache
  // and this store is the cross-instance source of truth. Absent (LAN desktop / pinned single instance)
  // ⇒ pure in-memory, unchanged. All methods are async + best-effort (any failure degrades gracefully).
  const frameRelay = (deps && deps.frameStore) || null;
  function efGet(examId, sid) { examFrames[examId] = examFrames[examId] || {}; return examFrames[examId][sid] || { ring: [], away: 0 }; }
  /** Store a student's frame record locally AND (best-effort) push the given fields to the shared relay. */
  function efPut(examId, sid, cur, relayFields) {
    examFrames[examId] = examFrames[examId] || {}; examFrames[examId][sid] = cur;
    if (frameRelay && relayFields) { try { Promise.resolve(frameRelay.put(examId, sid, relayFields)).catch(() => {}); } catch (_) {} }
  }
  /** Pull all students' LIGHTWEIGHT state for an exam from the relay into the local cache (no byte blobs),
   *  so the officer's monitor roster reflects students whose frames landed on OTHER instances. */
  async function efHydrate(examId) {
    if (!frameRelay) return;
    try {
      const rows = await frameRelay.listMeta(examId); if (!Array.isArray(rows)) return;
      examFrames[examId] = examFrames[examId] || {};
      for (const r of rows) {
        if (!r || !r.student_id) continue;
        const cur = examFrames[examId][r.student_id] || { ring: [], away: 0 };
        const remoteTs = Number(r.ts) || 0;
        if (remoteTs >= (cur.ts || 0)) {   // remote is newer (this instance isn't the writer) → adopt its state
          if (r.state && typeof r.state === 'object') Object.assign(cur, r.state);
          cur.ts = remoteTs || cur.ts;
          cur.remoteJpeg = !!r.has_jpeg; cur.remoteKyc = !!r.has_kyc; cur.remoteAudio = !!r.has_audio; cur.remoteClip = !!r.has_clip;
          if (r.audio_ts) cur.audioTs = r.audio_ts; if (r.clip_ts) cur.clipTs = r.clip_ts;
        }
        examFrames[examId][r.student_id] = cur;
      }
    } catch (_) { /* best-effort */ }
  }
  /** Resolve one student's bytes (jpeg|kyc|audio|clip): local cache first, else pull from the relay. */
  async function efBytes(examId, sid, kind) {
    const cur = (examFrames[examId] || {})[sid] || {};
    const localKey = kind === 'jpeg' ? 'jpeg' : kind;
    if (cur[localKey]) return { data: cur[localKey], mime: kind === 'audio' ? (cur.audioMime || 'audio/webm') : kind === 'clip' ? (cur.clipMime || 'video/webm') : 'image/jpeg' };
    if (frameRelay) { try { const b = await frameRelay.getBytes(examId, sid, kind); if (b && b.data) return b; } catch (_) {} }
    return null;
  }
  // GC the per-exam in-memory proctoring maps. Each holds up to 20 base64 frames × N students; without
  // this they accumulate for EVERY exam ever run and never free — a slow memory leak on a long-running hub
  // (a real low-RAM / production concern). Runs on the 180s reconcile cycle; drops anything idle > 3h.
  const FRAME_TTL_MS = 3 * 60 * 60 * 1000;
  function gcExamFrames() {
    const now = Date.now();
    for (const examId in examFrames) {
      const studs = examFrames[examId]; let newest = 0;
      for (const sid in studs) { const tts = (studs[sid] && studs[sid].ts) || 0; if (tts > newest) newest = tts; }
      if (!newest || now - newest > FRAME_TTL_MS) delete examFrames[examId];
    }
    for (const k in lastFrameTs) if (now - lastFrameTs[k] > FRAME_TTL_MS) delete lastFrameTs[k];
    for (const k in lastRelayTs) if (now - lastRelayTs[k] > FRAME_TTL_MS) delete lastRelayTs[k];
    for (const k in frameClient) { const fc = frameClient[k]; if (!fc || now - (fc.seen || 0) > FRAME_TTL_MS) delete frameClient[k]; }
  }

  // ---- login brute-force throttle (in-memory; keyed per login+IP) ----
  // The portal is network-facing and its HMAC tokens are stateless (no server session store to lean on),
  // so this small limiter is the main thing between the login and an online password-guessing attack.
  // After LOGIN_MAX failures inside LOGIN_WINDOW a login+IP is locked for LOGIN_BLOCK; a success clears it.
  // Keying on login+IP (not IP alone) means one student fat-fingering their password can never lock out
  // the rest of a shared campus connection.
  const LOGIN_MAX = 8, LOGIN_WINDOW = 15 * 60 * 1000, LOGIN_BLOCK = 15 * 60 * 1000;
  const loginFails = new Map();                    // key -> { n, first, until }
  // Short-lived password-reset codes (emailed to the address on file). Kept IN MEMORY — like the
  // login throttle and proctor frames — so it works identically whether the portal runs on the cloud
  // hub or embedded in the desktop app (whose SQLite has a fixed schema and no place for a temp column).
  const pwResets = new Map();                       // studentId -> { h, exp, role }
  const RESET_TTL = 15 * 60 * 1000;
  function pruneResets() { const now = Date.now(); for (const [k, v] of pwResets) if (!v || now > v.exp) pwResets.delete(k); }
  function clientIp(req) { return String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || ''); }
  function loginKey(req, login) { return String(login || '').trim().toLowerCase() + '|' + clientIp(req); }
  /** Seconds remaining on a lock, or 0 if not blocked (clears an elapsed lock as a side effect). */
  function loginBlocked(key) {
    const e = loginFails.get(key); if (!e || !e.until) return 0;
    if (Date.now() < e.until) return Math.ceil((e.until - Date.now()) / 1000);
    loginFails.delete(key); return 0;              // cooldown elapsed → reset
  }
  function loginFailed(key) {
    const now = Date.now();
    let e = loginFails.get(key);
    if (!e || (now - e.first) > LOGIN_WINDOW) e = { n: 0, first: now, until: 0 };
    e.n++; if (e.n >= LOGIN_MAX) e.until = now + LOGIN_BLOCK;
    loginFails.set(key, e);
    if (loginFails.size > 5000) for (const [k, v] of loginFails) if ((!v.until || now >= v.until) && (now - v.first) > LOGIN_WINDOW) loginFails.delete(k);
    return e;
  }
  function loginOk(key) { loginFails.delete(key); }

  // 🛡 anti-enumeration throttle for the PUBLIC credential-verification desk. A verifier confirms ONE
  // graduate they already know; a scraper walks the matric space and harvests the whole student body's
  // name, photo, DOB, nationality and programme — the endpoint needs no password, so the cap IS the lock.
  // Keyed on IP ALONE (unlike loginKey, which keys on login+IP): here the attacker varies the matric on
  // every request, so folding the matric into the key would drop each attempt in its own empty bucket
  // and the limiter would never fire.
  const VERIFY_MAX = 25, VERIFY_WINDOW = 10 * 60 * 1000;
  const verifyHits = new Map();                    // ip -> { n, first }
  /** Count this verification attempt. Returns 0 when allowed, else minutes until the window rolls over. */
  function verifyThrottle(req) {
    const ip = clientIp(req) || 'unknown', now = Date.now();
    let e = verifyHits.get(ip);
    if (!e || (now - e.first) > VERIFY_WINDOW) e = { n: 0, first: now };
    e.n++; verifyHits.set(ip, e);
    if (verifyHits.size > 5000) for (const [k, v] of verifyHits) if ((now - v.first) > VERIFY_WINDOW) verifyHits.delete(k);
    return e.n > VERIFY_MAX ? (Math.ceil((VERIFY_WINDOW - (now - e.first)) / 60000) || 1) : 0;
  }

  // ---- Face Biometric (pure-maths 1:1 / identity-hold; mirrors electron/services/face.js) ----
  // The 128-D descriptors are computed in the student's browser (face-api.js, served below from
  // server/face/) and POSTed here; matching is Euclidean distance, so it runs with zero deps and
  // works identically on the cloud hub, the LAN desktop-hosted portal, and the APK WebView.
  const FACE = {
    verifyThreshold: 0.50,   // 1:1 check-in — distance ≤ this ⇒ same person (strict, low false-accept)
    examThreshold: 0.56,     // continuous identity-hold during the exam (a touch looser to avoid nuisance flags)
    misses: 3,               // consecutive failed live checks before an impersonation flag is raised
  };
  function faceDist(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
  function faceConfidence(dist) { if (!isFinite(dist)) return 0; const c = 1 - (dist / 0.62); return Math.max(0, Math.min(1, Math.round(c * 100) / 100)); }
  // The student's enrolled descriptor set (array of 128-float arrays), or [] if not enrolled.
  function faceTemplateFor(studentId) {
    const rows = all('face_templates').filter(r => !r.deleted && r.student_id === studentId);
    rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const r = rows[0]; if (!r) return { enrolled: false, descriptors: [], row: null };
    let d = []; try { d = JSON.parse(r.descriptors || '[]'); } catch (_) { d = []; }
    d = (Array.isArray(d) ? d : []).filter(v => Array.isArray(v) && v.length >= 64);
    return { enrolled: d.length > 0, descriptors: d, row: r };
  }
  // Best (smallest) distance from any probe descriptor to any enrolled sample.
  function faceBest(probes, descriptors) {
    let best = Infinity;
    for (const p of (probes || [])) { if (!Array.isArray(p)) continue; for (const d of descriptors) { const dist = faceDist(p, d); if (dist < best) best = dist; } }
    return best;
  }
  // 1:N — rank the whole student body against a probe (used by the officer's "verify check-in" tool).
  function faceRank(probes, opts = {}) {
    const out = [];
    for (const r of all('face_templates')) {
      if (r.deleted) continue;
      let d = []; try { d = JSON.parse(r.descriptors || '[]'); } catch (_) { d = []; }
      d = (Array.isArray(d) ? d : []).filter(v => Array.isArray(v) && v.length >= 64);
      if (!d.length) continue;
      const dist = faceBest(probes, d);
      if (!isFinite(dist)) continue;
      out.push({ student_id: r.student_id, distance: Math.round(dist * 1000) / 1000, confidence: faceConfidence(dist) });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, opts.topK || 5);
  }
  const faceMiss = {};                            // examId:studentId → consecutive live-check miss count

  // Serve the vendored face-api.js engine + ResNet model weights (offline; no CDN) so the
  // student's browser can compute descriptors. Resolves from the bundled server/face/ dir,
  // falling back to the repo's src/vendor + assets/models when running unpacked.
  const faceRoots = [path.join(__dirname, 'face'), path.join(__dirname, '..', 'src', 'vendor', 'faceapi'), path.join(__dirname, '..', 'assets')];
  function faceFile(rel) { for (const root of faceRoots) { const fp = path.join(root, rel); try { if (fs.existsSync(fp)) return fp; } catch (_) {} } return null; }
  function winState(now, start, end) { const n = now || Date.now(); const s = start ? Date.parse(start) : null, e = end ? Date.parse(end) : null; if (s && n < s) return 'upcoming'; if (e && n > e) return 'closed'; return 'open'; }
  function seededShuffle(seed, arr) { const a = (arr || []).slice(); let s = 0; const str = String(seed || ''); for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0; s = s || 1; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  // Combine saved answers with an incoming autosave/submit. When the client sends its COMPLETE current set
  // (`full:true`) we REPLACE — so "Clear response" actually removes the answer server-side (a plain merge
  // can never delete a key, so a cleared question silently stayed answered and got graded). Legacy clients
  // without the flag keep the safe delta-merge so a partial save never wipes existing answers.
  function mergeExamAnswers(at, body) {
    const incoming = (body && body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)) ? body.answers : {};
    if (body && body.full === true) return incoming;
    let ans = {}; try { ans = JSON.parse((at && at.answers) || '{}'); } catch (_) {}
    Object.assign(ans, incoming); return ans;
  }
  // the public base URL of THIS request (https://host) — used to print absolute,
  // scannable verification URLs in the QR on receipts/payslips. Set per request.
  let docBase = '';
  function buildBase(req) {
    try {
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket && req.socket.encrypted ? 'https' : 'http');
      const host = req.headers['x-forwarded-host'] || req.headers.host || '';
      return host ? `${proto}://${host}` : '';
    } catch (_) { return ''; }
  }
  // The session-token signing key. If no shared secret is configured we use a
  // strong RANDOM per-process key (never the old public default), so portal
  // tokens can never be forged. Set a SYNC_TOKEN to keep sessions across restarts.
  const KEY = (secret && String(secret).length >= 8) ? secret : crypto.randomBytes(32).toString('hex');
  if (!(secret && String(secret).length >= 8)) { try { console.warn('[UniBursar] No strong SYNC_TOKEN set — using a random session key (logins reset on restart). Set SYNC_TOKEN for persistent, secure sessions.'); } catch (_) {} }

  // ---- token (HMAC-signed, stateless) ----
  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
    return body + '.' + mac;
  }
  function verifyToken(tok) {
    try {
      const [body, mac] = String(tok || '').split('.');
      if (!body || !mac) return null;
      const exp = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
      if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (p.exp && Date.now() > p.exp) return null;
      return p;
    } catch (_) { return null; }
  }

  // ---- account resolution ----
  function findAccount(login) {
    const q = String(login || '').trim().toLowerCase();
    if (!q) return null;
    for (const u of all('users')) {
      if (u.is_active === 0) continue;
      if ([u.username, u.portal_username, u.email].some(v => (v || '').toLowerCase() === q)) return { kind: 'user', row: u, role: u.role };
    }
    for (const s of all('students')) {
      if ([s.portal_username, s.email, s.matric_no].some(v => (v || '').toLowerCase() === q)) return { kind: 'student', row: s, role: 'student' };
    }
    for (const s of all('students')) {
      if ([s.parent_portal_username, s.parent_email].some(v => (v || '').toLowerCase() === q)) return { kind: 'parent', row: s, role: 'parent' };
    }
    for (const s of all('staff')) {
      if (s.is_active === 0) continue;
      if ([s.portal_username, s.email, s.staff_no].some(v => (v || '').toLowerCase() === q)) return { kind: 'staff', row: s, role: s.staff_type === 'lecturer' ? 'lecturer' : 'staff' };
    }
    return null;
  }
  function accountById(kind, id) {
    const entity = kind === 'user' ? 'users' : (kind === 'student' || kind === 'parent') ? 'students' : 'staff';
    return one(entity, id);
  }
  function passField(kind, row) { return kind === 'parent' ? row.parent_portal_pass : row.portal_pass; }

  // Is a published portal document visible to this student?
  // A document ADDRESSED TO A SPECIFIC STUDENT (student_id set) is always theirs and must NEVER be
  // hidden just because their faculty/department/level later changed (promotion, transfer, session
  // roll-over) — that regression is what made "uploaded documents disappear". Only BROADCAST
  // documents (no student_id) are scoped by faculty/department/level.
  function docVisibleTo(d, s) {
    if (!d || d.deleted) return false;
    if (d.student_id) return d.student_id === s.id;
    return (!d.faculty_id || d.faculty_id === s.faculty_id)
      && (!d.department_id || d.department_id === s.department_id)
      && (!d.level_id || d.level_id === s.level_id);
  }
  // Mask an email for a recovery hint ("ada.obi@gmail.com" → "ad••••@gm•••.com") — enough to recognise
  // your own address without exposing it.
  function maskEmail(e) {
    e = String(e || '').trim(); const at = e.indexOf('@'); if (at < 1) return '';
    const user = e.slice(0, at), dom = e.slice(at + 1), dot = dom.lastIndexOf('.');
    const host = dot > 0 ? dom.slice(0, dot) : dom, tld = dot > 0 ? dom.slice(dot) : '';
    const mask = (str, keep) => str.length <= keep ? str : str.slice(0, keep) + '•'.repeat(Math.min(4, str.length - keep));
    return mask(user, 2) + '@' + mask(host, 2) + tld;
  }

  // ---- shared computations ----
  const nameOf = (entity, id) => { const r = id ? one(entity, id) : null; return r ? r.name : null; };

  // ---- live classes (Jitsi) -------------------------------------------------
  // A class room name is DETERMINISTIC: the lecturer and every enrolled student derive the SAME
  // hard-to-guess id from the (already-synced) allocation scope, so no writable state is needed.
  // Knowing the id (only shown to the cohort + the lecturer) is the capability to join.
  function classRoom(parts) {
    // SHARED derivation (server/roomid.js) — byte-identical to the desktop host's so they share the room.
    return roomid.classRoom(secret, inst().short, parts);
  }
  // next scheduled time for a course, taken from the cohort's published LECTURE timetable (if any)
  function classWhen(s, code) {
    if (!code) return '';
    const tts = all('timetables').filter(t => !t.deleted && t.status === 'published' && t.type === 'lecture' &&
      (t.scope === 'faculty' ? t.faculty_id === s.faculty_id : (t.department_id === s.department_id && (!t.level_id || t.level_id === s.level_id))));
    for (const t of tts) {
      const sl = all('timetable_slots').find(x => x.timetable_id === t.id && !x.deleted && x.kind !== 'holiday' && String(x.course_code || '').toUpperCase() === String(code).toUpperCase());
      if (sl) return [sl.day_or_date, (sl.start_time || '') + (sl.end_time ? '–' + sl.end_time : '')].filter(Boolean).join(' ');
    }
    return '';
  }
  function dedupeRooms(list) { const seen = {}; return list.filter(c => seen[c.room] ? false : (seen[c.room] = true)); }
  /** A student's joinable live classes — one per course in their published course allocations. */
  function liveClassesForStudent(s) {
    const sets = all('allocation_sets').filter(a => !a.deleted && a.status === 'published' && a.department_id === s.department_id && a.level_id === s.level_id);
    const out = [];
    for (const a of sets) for (const r of all('course_allocations').filter(r => r.set_id === a.id && !r.deleted)) {
      out.push({ code: r.course_code, title: r.course_title, lecturer: r.lecturer_name || '', moderator: false, live: false,
        room: classRoom([a.department_id, a.level_id, a.session_id, r.course_code]), subject: [r.course_code, r.course_title].filter(Boolean).join(' '),
        session: nameOf('academic_sessions', a.session_id), semester: nameOf('semesters', a.semester_id), when: classWhen(s, r.course_code) });
    }
    // Merge LIVE-NOW sessions a host just started (≤3h): mark matching allocation classes live, and add
    // any cohort/ad-hoc session whose room isn't an allocation class — so a class a lecturer started
    // REFLECTS on the student app immediately and is joinable, even without a course allocation.
    const liveSessions = all('live_sessions').filter(v => v.department_id === s.department_id && v.level_id === s.level_id && isSessionLive(v));
    const liveRooms = new Set(liveSessions.map(v => v.room));
    for (const c of out) if (liveRooms.has(c.room)) { c.live = true; c.when = 'Live now'; }
    for (const v of liveSessions) {
      if (out.find(c => c.room === v.room)) continue;
      out.push({ code: v.course_code || '', title: v.course_title || v.subject || 'Live class', lecturer: '', moderator: false, live: true,
        room: v.room, subject: v.subject || v.course_title || 'Live Class', session: nameOf('academic_sessions', v.session_id), semester: '', when: 'Live now' });
    }
    out.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0)); // live classes first
    return dedupeRooms(out);
  }
  /** A lecturer's classes (they host) — courses they are allocated to teach. Same room ids as students. */
  function liveClassesForLecturer(staff) {
    const rows = all('course_allocations').filter(r => !r.deleted && (r.lecturer_id === staff.id ||
      (r.lecturer_name && staff.full_name && String(r.lecturer_name).toLowerCase() === String(staff.full_name).toLowerCase())));
    const out = [];
    for (const r of rows) {
      const a = one('allocation_sets', r.set_id);
      if (!a || a.deleted || a.status !== 'published') continue;
      out.push({ code: r.course_code, title: r.course_title, moderator: true,
        room: classRoom([a.department_id, a.level_id, a.session_id, r.course_code]), subject: [r.course_code, r.course_title].filter(Boolean).join(' '),
        department: nameOf('departments', a.department_id), level: nameOf('levels', a.level_id),
        session: nameOf('academic_sessions', a.session_id), semester: nameOf('semesters', a.semester_id) });
    }
    return dedupeRooms(out);
  }
  /** Resolve a course class's cohort scope (dept/level/session) from its room id. The room is a one-way
   *  hash of the allocation scope, so we MATCH it against every published allocation rather than reverse
   *  it. Used when a lecturer starts a class from the portal so the cohort can be notified + auto-ended.
   *  Returns null for ad-hoc/cohort rooms that aren't a course allocation (nothing to notify). */
  function scopeForRoom(room) {
    if (!room) return null;
    const sets = all('allocation_sets').filter(a => !a.deleted && a.status === 'published');
    for (const a of sets) {
      for (const r of all('course_allocations').filter(r => r.set_id === a.id && !r.deleted)) {
        if (classRoom([a.department_id, a.level_id, a.session_id, r.course_code]) === room)
          return { department_id: a.department_id, level_id: a.level_id, session_id: a.session_id,
            course_code: r.course_code, course_title: r.course_title,
            subject: [r.course_code, r.course_title].filter(Boolean).join(' ') };
      }
    }
    return null;
  }
  /** Standalone page that embeds Jitsi Meet for one class room (capability URL: the room id is a secret). */
  function classPageHTML(room, name, subject, host, principal) {
    const dn = esc(String(name || 'Guest').slice(0, 60));
    const subj = esc(String(subject || 'Live Class').slice(0, 80));
    const isHost = !!host;
    // JaaS/self-host aware: mint a per-user JWT (moderator ONLY for the verified lecturer/host) so there is
    // NO Google login and students join reliably. The moderator claim is server-signed from the caller's
    // authenticated role — not the client — so a student cannot mint themselves a moderator token.
    const emb = jitsi ? jitsi.classEmbed(jitsiCfg(), { room, displayName: String(name || 'Guest').slice(0, 60), moderator: isHost, userId: (principal && principal.id) || 'u' })
      : { domain: 'meet.jit.si', roomName: String(room || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80), jwt: '', scriptUrl: 'https://meet.jit.si/external_api.js', mode: 'public' };
    const domain = emb.domain;
    const r = emb.roomName;
    // MODERATOR LOCK: the lecturer (host) is the moderator and auto-enables the LOBBY, so students
    // must be ADMITTED before they can join — the lecturer controls the class. Students get a
    // restricted toolbar (no moderation / recording / security), join muted, and cannot start
    // screen-share over the host. (On the public meet.jit.si moderator status is best-effort;
    // for cryptographic enforcement self-host Jitsi and set institution setting `jitsi_domain`
    // + issue a JWT with a moderator claim — the page already passes the role through.)
    const HOST_TOOLBAR = "['microphone','camera','desktop','chat','raisehand','participants-pane','tileview','toggle-camera','select-background','security','recording','mute-everyone','mute-video-everyone','settings','fullscreen','hangup','invite','sharedvideo']";
    const STUDENT_TOOLBAR = "['microphone','camera','chat','raisehand','tileview','toggle-camera','select-background','settings','fullscreen','hangup']";
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${subj} — Live Class</title>
<style>html,body{height:100%;margin:0;background:#0b1220;font-family:'Segoe UI',Arial,sans-serif;color:#fff}
#bar{height:46px;display:flex;align-items:center;gap:10px;padding:0 14px;background:#0f1e3d}
#bar b{font-size:14px}#bar .role{font-size:11px;background:${isHost ? '#16a34a' : '#334155'};padding:3px 9px;border-radius:999px;font-weight:700}#bar .sp{flex:1}#bar a{color:#bcd;font-size:13px;text-decoration:none;background:#1e3a8a;padding:7px 12px;border-radius:8px}
#meet{position:absolute;top:46px;left:0;right:0;bottom:0}
#wait{position:absolute;top:46px;left:0;right:0;bottom:0;display:none;align-items:center;justify-content:center;text-align:center;padding:24px}
#err{padding:24px;max-width:520px;margin:40px auto;background:#111c33;border-radius:12px;line-height:1.6}
</style></head><body>
<div id="bar"><b>🎥 ${subj}</b> <span class="role">${isHost ? 'Lecturer (Host)' : 'Student'}</span><span class="sp"></span><a href="/">⤺ Back to portal</a></div>
<div id="meet"></div>
<div id="wait"><div><div style="font-size:40px">⏳</div><h3>Waiting for the lecturer to admit you…</h3><p style="opacity:.8">The class opens once your lecturer starts it and lets you in.</p></div></div>
<div id="err" style="display:none"><h3>Could not start the class</h3><p>Check your internet connection and that the app has camera & microphone permission, then reopen the class.</p><p><a href="/" style="color:#9bd">Back to portal</a></p></div>
<script src="${emb.scriptUrl}"></script>
<script>
(function(){
  var isHost=${isHost ? 'true' : 'false'};
  var LC_ROOM=${JSON.stringify(String(room || ''))};
  var LC_SUBJ=${JSON.stringify(subj)};
  function lcTok(){try{return new URLSearchParams(location.search).get('t')||localStorage.getItem('ubu_token')||'';}catch(e){return '';}}
  // The host ENDS the class for the whole cohort when they leave/close, so it stops on the students' APK
  // too. sendBeacon survives the page unload; the token comes from ?t= (native app) or localStorage (web).
  var lcEndSent=false,lcHbT=null;
  function lcEndClass(){if(lcEndSent||!isHost||!LC_ROOM)return;lcEndSent=true;try{clearInterval(lcHbT);}catch(e){}try{navigator.sendBeacon('/api/class-end?t='+encodeURIComponent(lcTok())+'&room='+encodeURIComponent(LC_ROOM));}catch(e){}}
  function fail(){var e=document.getElementById('err');if(e)e.style.display='block';var m=document.getElementById('meet');if(m)m.style.display='none';}
  if(typeof JitsiMeetExternalAPI!=='function'){fail();return;}
  try{
    var api=new JitsiMeetExternalAPI(${JSON.stringify(domain)},{
      roomName:${JSON.stringify(r)},
      ${emb.jwt ? 'jwt:' + JSON.stringify(emb.jwt) + ',' : ''}
      parentNode:document.getElementById('meet'),
      userInfo:{displayName:${JSON.stringify(dn)}},
      configOverwrite:{prejoinPageEnabled:true,startWithAudioMuted:${isHost ? 'false' : 'true'},startWithVideoMuted:false,disableDeepLinking:true,subject:${JSON.stringify(subj)},disableReactions:false},
      interfaceConfigOverwrite:{MOBILE_APP_PROMO:false,SHOW_JITSI_WATERMARK:false,DEFAULT_BACKGROUND:'#0b1220',TOOLBAR_BUTTONS:${isHost ? HOST_TOOLBAR : STUDENT_TOOLBAR}}
    });
    api.addEventListener('readyToClose',function(){lcEndClass();location.href=(window.__B||'')+'/';});
    if(isHost){
      // The lecturer hosts: enable the lobby so students must be admitted, label the room, and MARK the
      // class live for the cohort (so it shows "Live now", the app can join, and there is a session to
      // AUTO-END when the host leaves — which is what stops the class on the students' APK).
      window.addEventListener('pagehide',lcEndClass);
      window.addEventListener('beforeunload',lcEndClass);
      api.addEventListener('videoConferenceJoined',function(){
        try{api.executeCommand('subject',LC_SUBJ);}catch(e){}
        try{api.executeCommand('toggleLobby',true);}catch(e){}
        if(LC_ROOM){
          try{fetch('/api/class-start?t='+encodeURIComponent(lcTok())+'&room='+encodeURIComponent(LC_ROOM)+'&subject='+encodeURIComponent(LC_SUBJ),{method:'POST'});}catch(e){}
          // HEARTBEAT: keep the session alive every 30s so "Live now" clears within ~2min of the host
          // leaving even if the end-beacon is missed (crash / tab killed). hb=1 only refreshes; never re-notifies.
          try{clearInterval(lcHbT);}catch(e){}
          lcHbT=setInterval(function(){try{fetch('/api/class-start?t='+encodeURIComponent(lcTok())+'&room='+encodeURIComponent(LC_ROOM)+'&hb=1',{method:'POST'});}catch(e){}},30000);
        }
      });
    } else {
      // A student knocks; show a waiting message until the lecturer admits them.
      var w=document.getElementById('wait');
      api.addEventListener('videoConferenceJoined',function(){ if(w)w.style.display='none'; });
      api.addEventListener('knockingParticipant',function(){});
      setTimeout(function(){ /* if still not joined, the lobby waiting screen is Jitsi's own */ },1500);
      // AUTO-LEAVE when the host ends the class. The APK keeps this page open, so without a signal the
      // Jitsi room kept running after the lecturer ended it. Poll the live-session state and, once the
      // session that made this class live has ended, dispose Jitsi and return to the portal.
      var lcDone=false;
      function lcEnded(){
        if(lcDone)return; lcDone=true;
        try{api.dispose();}catch(e){}
        var m=document.getElementById('meet'); if(m)m.style.display='none';
        if(w){w.style.display='flex';w.innerHTML='<div><div style="font-size:40px">\\uD83D\\uDCF4</div><h3>The class has ended</h3><p style="opacity:.8">Your lecturer ended this live class.</p><p><a href="/" style="color:#9bd">Back to portal</a></p></div>';}
        setTimeout(function(){location.href=(window.__B||'')+'/';},4000);
      }
      if(LC_ROOM){
        var lcPoll=setInterval(function(){
          fetch('/api/class-live?room='+encodeURIComponent(LC_ROOM)).then(function(r){return r.json();}).then(function(d){
            if(d&&d.ended){clearInterval(lcPoll);lcEnded();}
          }).catch(function(){});
        },12000);
      }
    }
  }catch(e){fail();}
})();
</script>
</body></html>`;
  }

  // ---- student notification feed (derived from synced data — no writable state needed) ----
  // Surfaces every important update so a student never misses anything: receipts, new fees,
  // results, documents, timetables, course allocations, clearance and disciplinary updates.
  function catLabel(key) { const c = all('fee_categories').find(x => x.key === key && !x.deleted); return c ? c.name : (key ? String(key)[0].toUpperCase() + String(key).slice(1).replace(/_/g, ' ') : 'Fee'); }
  function buildNotifications(s) {
    const out = [];
    const add = (type, icon, title, text, date, seg, docUrl) => { if (!date) return; out.push({ id: type + ':' + (docUrl || date), type, icon, title, text: text || '', date, seg: seg || null, doc: docUrl || null }); };
    for (const p of all('payments').filter(p => p.student_id === s.id && p.status === 'completed'))
      add('receipt', '🧾', 'Payment receipt issued', `${p.receipt_no ? 'Receipt ' + p.receipt_no + ' · ' : ''}${money(p.amount, p.currency)} for ${catLabel(p.category)}`, p.decided_at || p.created_at, 'receipts', p.receipt_no ? '/doc/receipt/' + p.id : null);
    for (const c of all('charges').filter(c => c.student_id === s.id))
      add('fee', '💳', 'New fee on your account', `${catLabel(c.category)} — ${money(c.amount, c.currency)}`, c.created_at, 'fees', null);
    for (const r of all('results').filter(r => r.student_id === s.id))
      add('result', '📑', 'Result published', r.title || 'A new statement of result is available', r.created_at, 'results', null);
    for (const d of all('portal_documents').filter(d => docVisibleTo(d, s)))
      add('document', '📂', 'New document available', d.title || 'A document was published for you', d.created_at, 'documents', '/doc/portal-document/' + d.id);
    for (const t of all('timetables').filter(t => !t.deleted && t.status === 'published' && (t.scope === 'faculty' ? t.faculty_id === s.faculty_id : (t.department_id === s.department_id && (!t.level_id || t.level_id === s.level_id)))))
      add('timetable', '🗓', 'Timetable published', t.title || 'A new timetable is available', t.published_at, 'timetable', '/doc/timetable/' + t.id);
    for (const a of all('allocation_sets').filter(a => !a.deleted && a.status === 'published' && a.department_id === s.department_id && a.level_id === s.level_id))
      add('allocation', '👩‍🏫', 'Course allocation published', a.title || 'Lecturers have been assigned to your courses', a.published_at, 'liveclasses', null);
    // a class that is live right now — surfaces in Updates with a tap-through to Live Classes
    for (const v of all('live_sessions').filter(v => v.department_id === s.department_id && v.level_id === s.level_id && isSessionLive(v)))
      add('liveclass', '🔴', 'Live class started', (v.subject || v.course_code || 'A class') + ' is live now — open Live Classes to join', v.started_at, 'liveclasses', null);
    for (const v of all('exam_validations').filter(v => v.student_id === s.id))
      add('clearance', '✅', 'Examination clearance update', (v.status === 'valid' ? 'You have been cleared for exams' : 'Your clearance status changed') + (v.reason ? ' — ' + v.reason : ''), v.created_at, 'clearance', null);
    for (const m of all('misconducts').filter(m => m.student_id === s.id && !m.deleted))
      add('discipline', '⚖️', 'Disciplinary record update', m.offense || 'A disciplinary record was updated', m.occurred_at || m.created_at, null, null);
    for (const f of all('malpractice_flags').filter(f => f.student_id === s.id && !f.deleted))
      add('surveillance', '🛡️', 'Exam conduct notice', (MALPRACTICE_LABELS[f.type] || 'A conduct alert was recorded') + ' — tap to see the evidence and appeal if it was a mistake', f.occurred_at || f.created_at, 'surveillance', null);
    for (const e of all('online_exams').filter(e => examVisibleTo(e, s)))
      add('exam', '📝', 'Online exam: ' + (e.title || e.course_code || 'Exam'), (e.start_at ? 'Scheduled ' + fmtDate(e.start_at) : 'Open now') + ' — tap to open it in the Exams tab', e.published_at || e.created_at, 'exam', null);
    // 🎫 ticket progress (missing results / payments not reflecting) — every timeline event surfaces
    // here so the student follows the fix in Updates even without device push.
    {
      const tnoOf = (rid, pfx) => pfx + '-' + String(rid || '').replace(/-/g, '').slice(-6).toUpperCase();
      const myReq = new Map(); // request_id → {pfx, label}
      for (const r of all('result_fix_requests')) if (!r.deleted && r.student_id === s.id) myReq.set(r.id, { pfx: 'RT', label: r.course_code || 'result' });
      for (const r of all('payment_fix_requests')) if (!r.deleted && r.student_id === s.id) myReq.set(r.id, { pfx: 'PT', label: 'payment' });
      if (myReq.size) {
        const TICON = { open: '🎫', auto_fixed: '✅', recorded: '✅', resolved: '✅', not_found: '👤', rejected: '🎫', not_uploaded: '⏳' };
        for (const e of all('ticket_events')) {
          if (e.deleted || !myReq.has(e.request_id)) continue;
          const m = myReq.get(e.request_id);
          out.push({ id: 'ticket:' + e.id, type: 'ticket', icon: TICON[e.status] || '🎫', title: `Ticket ${tnoOf(e.request_id, m.pfx)} (${m.label})`, text: e.message || e.status || 'Updated', date: e.created_at, seg: 'results', doc: null });
        }
      }
    }
    // Graduation FINAL CLEARANCE — request, every completed step, and the outcome (also pushed to the device).
    const fcl = all('grad_clearances').filter(c => !c.deleted && c.student_id === s.id).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    if (fcl) {
      add('finalclr', '🎓', 'Final clearance requested', 'Your final-clearance request was sent to the Bursary.', fcl.requested_at, 'finalclr', null);
      if (fcl.status === 'denied') add('finalclr', '🎓', 'Final-clearance request declined', fcl.deny_reason || 'Your request was not approved at this time.', fcl.decided_at, 'finalclr', null);
      else if (fcl.status !== 'requested') add('finalclr', '🎓', 'Final clearance started', 'Your request was accepted — begin with financial clearance.', fcl.decided_at, 'finalclr', null);
      for (const it of all('grad_clearance_items').filter(i => !i.deleted && i.clearance_id === fcl.id && i.status === 'cleared' && i.cleared_at))
        out.push({ id: 'finalclr-item:' + it.id, type: 'finalclr', icon: '✅', title: (it.name || 'A requirement') + ' cleared', text: 'One more step done on your final clearance — tap to see your progress.', date: it.cleared_at, seg: 'finalclr', doc: null });
      if (fcl.status === 'completed') add('finalclr', '🎓', 'Final clearance complete', 'Congratulations — you are now an alumnus/alumna. Download your documents from the Graduation tab.', fcl.completed_at, 'finalclr', null);
    }
    out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return out.slice(0, 80);
  }

  // ---- E-library -----------------------------------------------------------
  // Books the student may see: global, or matching their faculty/department/level.
  function libraryForStudent(s) {
    return all('library_books').filter(b => !b.deleted &&
      (!b.faculty_id || b.faculty_id === s.faculty_id) &&
      (!b.department_id || b.department_id === s.department_id) &&
      (!b.level_id || b.level_id === s.level_id))
      .map(b => ({ id: b.id, title: b.title, author: b.author || '', category: b.category || 'General', description: b.description || '', cover: b.cover || '', mime: b.mime || '', pages: b.pages || 0, filename: b.filename || 'book', readable: /pdf$/i.test(b.mime || '') || /^image\//i.test(b.mime || ''), date: b.created_at }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }
  function libraryVisibleTo(b, s) {
    return b && !b.deleted && (!b.faculty_id || b.faculty_id === s.faculty_id) && (!b.department_id || b.department_id === s.department_id) && (!b.level_id || b.level_id === s.level_id);
  }

  // ---- Exam Surveillance: the student's own attendance + any malpractice flag + evidence ----
  const MALPRACTICE_LABELS = { multiple_faces: 'Another person in your frame', absence: 'You left your seat', left_seat: 'You left your seat', looking_away: 'Looking away from your paper', talking: 'Talking during the exam', phone: 'Phone use', earbuds: 'Earbuds / earphones detected', neck_movement: 'Head/neck turning to a neighbour', notes: 'Unauthorised notes / material', unknown_face: 'Unrecognised face', impersonation: 'Possible impersonation', left_app: 'You left the exam app', left_exam: 'You left the exam app — your exam was ended (no score)', disqualified: 'Disqualified by the exam officer (exam voided)', connection_lost: 'You dropped offline during the exam', multiple_devices: 'Exam open on two devices at once', manual: 'Flagged by an exam officer',
    smartwatch: 'Smartwatch / smart band use', smart_glasses: 'Smart / camera glasses', calculator: 'Unauthorised calculator / electronics', second_device: 'Laptop / second screen detected', book: 'Textbook / notebook detected', body_writing: 'Writing on the body', desk_writing: 'Writing on the desk / objects', hidden_material: 'Concealed material', mirror: 'Mirror / reflective surface', copying: 'Copying a neighbour', signaling: 'Hand signals / coded gestures', passing_object: 'Passing notes / objects', script_swap: 'Swapping scripts / papers', suspicious_posture: 'Repeated under-desk / lap glances', face_hidden: 'Face covered / obscured', camera_obstruction: 'Camera covered / blocked' };
  function examTitleOf(examId) { const e = examId ? one('surveillance_sessions', examId) : null; return e ? (e.title || e.course_code || 'Exam') : 'Exam'; }
  function surveillanceForStudent(s) {
    const attendance = all('surveillance_attendance').filter(a => !a.deleted && a.student_id === s.id)
      .map(a => ({ exam: examTitleOf(a.exam_id), status: a.status, method: a.method, date: a.last_seen_at || a.created_at }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const appealsByFlag = {};
    for (const ap of all('malpractice_appeals').filter(a => !a.deleted && a.student_id === s.id)) appealsByFlag[ap.flag_id] = { status: ap.status, filed_at: ap.filed_at };
    const flags = all('malpractice_flags').filter(f => !f.deleted && f.student_id === s.id)
      .map(f => ({
        id: f.id, exam: examTitleOf(f.exam_id), type: f.type, label: MALPRACTICE_LABELS[f.type] || f.type,
        severity: f.severity, detail: f.detail || '', status: f.status, date: f.occurred_at || f.created_at,
        evidence: all('malpractice_evidence').filter(e => !e.deleted && e.flag_id === f.id).map(e => ({ id: e.id, kind: e.kind, mime: e.mime, filename: e.filename, bytes: e.bytes })),
        appeal: appealsByFlag[f.id] || null,
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { attendance, flags };
  }

  // ---- Online exams the student can see/sit (matched to their cohort) ----
  function examVisibleTo(e, s) {
    return e && !e.deleted && (e.status === 'published' || e.status === 'live') &&
      (!e.department_id || e.department_id === s.department_id) &&
      (!e.level_id || e.level_id === s.level_id) &&
      (!e.faculty_id || e.faculty_id === s.faculty_id);
  }
  function examsForStudent(s) {
    const now = Date.now();
    const attempted = (e) => all('exam_attempts').some(a => !a.deleted && a.exam_id === e.id && a.student_id === s.id);
    return all('online_exams').filter(e => !e.deleted && (examVisibleTo(e, s) || (e.status === 'ended' && attempted(e)))).map(e => {
      const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === e.id && a.student_id === s.id);
      return {
        id: e.id, title: e.title || e.course_code, course_code: e.course_code, course_title: e.course_title,
        instructions: e.instructions || '', duration_min: e.duration_min || 60, start_at: e.start_at, end_at: e.end_at,
        question_count: all('exam_questions').filter(q => !q.deleted && q.exam_id === e.id).length,
        total_marks: e.total_marks || 0, require_camera: e.require_camera !== 0, window: winState(now, e.start_at, e.end_at),
        status: e.status, live: e.status === 'live',
        attempt: at ? { id: at.id, status: at.status, score: at.score, max_score: at.max_score, submitted_at: at.submitted_at } : null,
      };
    }).sort((a, b) => String(a.start_at || '').localeCompare(String(b.start_at || '')));
  }
  /** Advanced in-app e-book reader (PDF via pdf.js with lazy page rendering + zoom; images inline). */
  function libraryReaderHTML(book, token) {
    const isPdf = /pdf$/i.test(book.mime || '');
    const isImg = /^image\//i.test(book.mime || '');
    const fileUrl = '/library/file/' + book.id + '?t=' + encodeURIComponent(token || '');
    const dl = '/library/download/' + book.id + '?t=' + encodeURIComponent(token || '');
    const title = esc(book.title || 'Book');
    const head = `<div id="bar"><b>📖 ${title}</b><span class="au">${esc(book.author || '')}</span><span class="sp"></span>`
      + (isPdf ? `<button onclick="zo(-1)">−</button><span id="zl">100%</span><button onclick="zo(1)">+</button>` : '')
      + `<a href="${dl}">⬇ Download</a><a href="/">⤺ Back</a></div>`;
    if (isImg) {
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>html,body{margin:0;background:#0b1220;color:#fff;font-family:'Segoe UI',Arial,sans-serif}#bar{height:46px;display:flex;align-items:center;gap:10px;padding:0 14px;background:#0f1e3d}#bar .au{opacity:.7;font-size:12px}#bar .sp{flex:1}#bar a{color:#bcd;text-decoration:none;background:#1e3a8a;padding:7px 12px;border-radius:8px;font-size:13px}img{display:block;max-width:100%;margin:16px auto}</style></head>
<body>${head}<img src="${fileUrl}"></body></html>`;
    }
    if (!isPdf) {
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;background:#0f1e3d;color:#fff;font-family:'Segoe UI',Arial,sans-serif;text-align:center;padding:60px 20px}a{color:#9bd}</style></head>
<body><h2>📘 ${title}</h2><p>This file type can't be read in the browser. Please download it to open in a reader app.</p><p><a href="${dl}">⬇ Download book</a> &nbsp; <a href="/">⤺ Back to portal</a></p></body></html>`;
    }
    // PDF reader (pdf.js, lazy per-page canvas rendering)
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title>
<style>html,body{margin:0;background:#1f2733;color:#fff;font-family:'Segoe UI',Arial,sans-serif}
#bar{position:sticky;top:0;z-index:5;height:46px;display:flex;align-items:center;gap:8px;padding:0 12px;background:#0f1e3d}
#bar b{font-size:14px}#bar .au{opacity:.7;font-size:12px}#bar .sp{flex:1}
#bar button{background:#1e3a8a;color:#fff;border:0;width:30px;height:30px;border-radius:7px;font-size:16px;cursor:pointer}
#bar #zl{font-size:12px;min-width:42px;text-align:center}
#bar a{color:#bcd;text-decoration:none;background:#1e3a8a;padding:7px 11px;border-radius:8px;font-size:13px}
#doc{padding:16px 8px 60px;display:flex;flex-direction:column;align-items:center;gap:14px}
.pg{background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.4);max-width:100%}
#msg{padding:40px;text-align:center;opacity:.85}
</style></head><body>
${head}
<div id="doc"><div id="msg">Loading book…</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
(function(){
  var FILE=${JSON.stringify(fileUrl)};
  if(!window['pdfjsLib']){document.getElementById('msg').textContent='Could not load the reader. Check your connection and try again, or download the book.';return;}
  pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var scale=1.2, pdf=null, doc=document.getElementById('doc'), io;
  function setZoom(){document.getElementById('zl').textContent=Math.round(scale/1.2*100)+'%';}
  window.zo=function(d){scale=Math.min(3,Math.max(0.5,scale+ d*0.2));setZoom();render(true);};
  function makeCanvases(){
    doc.innerHTML='';
    io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){draw(e.target);io.unobserve(e.target);}});},{rootMargin:'600px'});
    for(var i=1;i<=pdf.numPages;i++){var cv=document.createElement('canvas');cv.className='pg';cv.dataset.p=i;doc.appendChild(cv);io.observe(cv);}
  }
  function draw(cv){
    var n=+cv.dataset.p;
    pdf.getPage(n).then(function(page){
      var vp=page.getViewport({scale:scale});
      var ratio=window.devicePixelRatio||1;
      cv.width=vp.width*ratio;cv.height=vp.height*ratio;cv.style.width=vp.width+'px';cv.style.height=vp.height+'px';
      var ctx=cv.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);
      page.render({canvasContext:ctx,viewport:vp});
    });
  }
  function render(re){ if(!pdf)return; if(re){makeCanvases();} }
  pdfjsLib.getDocument(FILE).promise.then(function(p){pdf=p;setZoom();makeCanvases();}).catch(function(){document.getElementById('msg').textContent='Could not open this book. Try downloading it instead.';});
})();
</script>
</body></html>`;
  }

  /** Standalone, full-screen ONLINE-EXAM taking page (browser: laptop + phone). Self-contained — it
   *  drives the camera/mic, KYC selfie, server-timed countdown, questions, autosave, integrity lockdown
   *  (warn+log) and the proctor upload loop, all against the existing /api/exam/* endpoints. Served like
   *  the pdf reader / class page so it owns the whole tab (no SPA contention). */
  function examTakeHTML(e, token, s) {
    const faceEnrolled = s ? faceTemplateFor(s.id).enrolled : false;
    const cfg = JSON.stringify({ id: e.id, title: e.title || e.course_code || 'Exam', instructions: e.instructions || '', requireCam: e.require_camera !== 0, faceEnrolled });
    const tk = JSON.stringify(token || '');
    const title = esc(e.title || e.course_code || 'Exam');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title>
<style>
:root{--bg:#0b1220;--card:#111c33;--line:#1e2b48;--accent:#2563eb;--ok:#16a34a;--warn:#f59e0b;--bad:#ef4444}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:#e7eefc;font-family:'Segoe UI',Arial,sans-serif}
.scr{display:none;min-height:100vh}.scr.on{display:block}
.wrap{max-width:860px;margin:0 auto;padding:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}
h1{font-size:20px;margin:.2em 0}h2{font-size:16px}.muted{color:#9fb2d6;font-size:13px}
button{font:inherit;border:0;border-radius:10px;padding:11px 16px;cursor:pointer;background:var(--accent);color:#fff;font-weight:700}
button.sec{background:#22304f}button:disabled{opacity:.5;cursor:not-allowed}
video#cam{width:220px;max-width:42vw;border-radius:10px;background:#000;transform:scaleX(-1)}
.selfie{position:fixed;right:10px;bottom:10px;width:128px;border-radius:10px;border:2px solid var(--accent);background:#000;z-index:40;transform:scaleX(-1)}
#bar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:12px;padding:10px 14px;background:#0f1e3d;border-bottom:1px solid var(--line)}
#bar .t{font-weight:800;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#clock{font-variant-numeric:tabular-nums;font-weight:800;font-size:18px;background:#0b1220;padding:6px 10px;border-radius:8px}
#clock.low{color:var(--bad)}
.live{background:#7f1d1d;color:#fecaca;font-size:11px;font-weight:800;padding:4px 8px;border-radius:6px}
#banner{display:none;background:#7f1d1d;color:#fff;padding:10px 14px;font-size:13px;text-align:center}
.q{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0}
.q .qt{font-weight:600;margin-bottom:8px}.q img{max-width:100%;border-radius:8px;margin:6px 0}
.opt{display:block;padding:9px 12px;border:1px solid var(--line);border-radius:9px;margin:6px 0;cursor:pointer}
.opt.sel{border-color:var(--accent);background:#16224a}
textarea,input[type=text]{width:100%;background:#0b1220;color:#e7eefc;border:1px solid var(--line);border-radius:9px;padding:10px;font:inherit}
textarea.code{font-family:'Consolas','Courier New',monospace;font-size:13px;line-height:1.45;tab-size:2;white-space:pre;min-height:220px}
input[type=file]{color:#e7eefc;font-size:13px}
.status{font-size:13px;margin:8px 0}.ok{color:#86efac}.bad{color:#fca5a5}
.sp{display:inline-block;width:16px;height:16px;border:2px solid #fff5;border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite;vertical-align:-3px}
@keyframes spin{to{transform:rotate(360deg)}}
/* ---- advanced CBT shell ---- */
body{font-size:var(--fs,15px)}
body.hc{--bg:#000;--card:#0a0a0a;--line:#555}body.hc{color:#fff}
#bar{flex-wrap:wrap;gap:8px}
.chip{font-size:12px;font-weight:700;background:#0b1220;border:1px solid var(--line);padding:5px 9px;border-radius:8px}
.chip.ok{color:#86efac}.chip.warn{color:#fcd34d}
.dot{width:12px;height:12px;border-radius:50%;background:#22c55e;display:inline-block}
button.icon{padding:6px 9px;background:#22304f;font-size:13px;font-weight:700}
#examwrap{display:flex;gap:14px;max-width:1180px;margin:0 auto;padding:14px;align-items:flex-start}
#main{flex:1;min-width:0}#qcard{margin:0}
.qhead{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:10px}
.qnum{font-weight:800;font-size:15px}.qmeta{color:#9fb2d6;font-size:12px}
.qt{font-size:16px;line-height:1.55;margin-bottom:10px}
.qfig{max-width:100%;max-height:340px;border-radius:8px;margin:6px 0;cursor:zoom-in;border:1px solid var(--line)}
.opt:focus,button:focus,input:focus,textarea:focus,.pcell:focus{outline:2px solid #60a5fa;outline-offset:1px}
#actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;position:sticky;bottom:0;background:var(--bg);padding:10px 0}
button.warnbtn{background:#7c3aed;margin-left:auto}
#palette{width:280px;flex-shrink:0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;position:sticky;top:64px}
.pcounts{font-size:12px;color:#9fb2d6;margin-bottom:8px;line-height:1.6}
.pgrid{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;max-height:46vh;overflow:auto}
.pcell{aspect-ratio:1;min-height:34px;display:flex;align-items:center;justify-content:center;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;border:2px solid transparent;background:#475569;color:#fff;position:relative}
.pcell.ans{background:#16a34a}.pcell.noans{background:#dc2626}.pcell.mark,.pcell.ansmark{background:#7c3aed}.pcell.ansmark:after{content:"✓";position:absolute;top:-5px;right:2px;font-size:10px;color:#bbf7d0}.pcell.cur{border-color:#fbbf24}
.plegend{margin-top:10px;font-size:11px;color:#9fb2d6;display:grid;gap:3px}
.plegend i{width:11px;height:11px;border-radius:3px;display:inline-block;margin-right:5px;vertical-align:-1px}
.overlay{position:fixed;inset:0;background:rgba(2,6,23,.93);z-index:60;overflow:auto;padding:24px}
.overlay .rcard{max-width:680px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.rrow{display:inline-block;min-width:40px;height:40px;line-height:40px;text-align:center;border-radius:8px;font-weight:800;margin:4px;cursor:pointer;color:#fff;padding:0 6px}
#zoom{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:70;display:none;align-items:center;justify-content:center;cursor:zoom-out}#zoom img{max-width:96vw;max-height:96vh;border-radius:8px}
.calc{background:#0b1220;border:1px solid var(--line);border-radius:10px;padding:8px;margin-top:10px;max-width:300px}
.calc .disp{width:100%;background:#000;color:#7CFC00;font-family:monospace;font-size:16px;text-align:right;padding:7px;border-radius:6px;border:1px solid var(--line);margin-bottom:6px;min-height:32px;overflow:auto}
.calc .keys{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}.calc button{padding:9px 0;font-size:13px;background:#22304f}
.mprev{margin-top:6px;min-height:22px;color:#cbd5e1;font-size:15px}
.CodeMirror{height:auto;min-height:240px;border:1px solid var(--line);border-radius:9px;font-size:13.5px}
@media(max-width:820px){#palette{position:fixed;top:0;right:0;bottom:0;width:80%;max-width:320px;z-index:50;transform:translateX(106%);transition:transform .25s;border-radius:0;overflow:auto}#palette.open{transform:none;box-shadow:-8px 0 30px rgba(0,0,0,.55)}#examwrap{padding:10px}.pgrid{grid-template-columns:repeat(8,1fr);max-height:60vh}}
@media(min-width:821px){#paltoggle{display:none}}
</style></head><body>
<div id="err" class="scr"><div class="wrap"><div class="card"><h1>⚠ Problem</h1><p id="errmsg" class="muted"></p><a href="/"><button class="sec">⤺ Back to portal</button></a></div></div></div>

<div id="pre" class="scr on"><div class="wrap">
  <div class="card"><h1>📝 ${title}</h1><div id="instr" class="muted"></div></div>
  <div class="card"><h2>Identity & proctoring check</h2>
    <p class="muted">This exam is monitored. We use your <b>camera and microphone</b> for live invigilation — please sit in good light, alone, and stay in view. Your activity is recorded for review.</p>
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center"><video id="cam" autoplay muted playsinline></video>
      <div style="flex:1;min-width:200px"><div id="camstat" class="status muted">Camera & microphone not started.</div>
        <button id="cambtn" onclick="EX.startCam()">🎥 Enable camera & microphone</button>
        <button id="kycbtn" class="sec" style="display:none" onclick="EX.captureKyc()">📸 Capture my photo</button>
      </div></div>
  </div>
  <div class="wrap" style="padding:0"><button id="beginbtn" onclick="EX.begin()" disabled>▶ Begin exam</button>
    <div id="prestat" class="status muted"></div></div>
</div></div>

<div id="wait" class="scr"><div class="wrap"><div class="card" style="text-align:center">
  <h1>⏳ Waiting room</h1><p class="muted">The invigilator has not started this exam yet. <span class="sp"></span><br>It will begin automatically the moment they do — keep this page open.</p>
</div></div></div>

<div id="exam" class="scr">
  <div id="bar">
    <button id="paltoggle" class="icon" onclick="EX.togglePalette()" aria-label="Question navigator">☰ Questions</button>
    <span class="t">📝 ${title}</span>
    <span id="prog" class="chip" title="Answered">0/0</span>
    <span id="conn" class="dot" title="Connection"></span>
    <span id="saved" class="chip">—</span>
    <button class="icon" onclick="EX.fs(-1)" aria-label="Smaller text">A−</button>
    <button class="icon" onclick="EX.fs(1)" aria-label="Larger text">A+</button>
    <button class="icon" onclick="EX.contrast()" aria-label="High contrast">◐</button>
    <span id="livebadge" class="live" style="display:none">🔴 LIVE</span>
    <span id="clock">--:--</span>
  </div>
  <div id="banner"></div>
  <div id="examwrap">
    <div id="main">
      <div id="qcard" class="card" aria-live="polite"></div>
      <div id="actions">
        <button class="sec" onclick="EX.prev()">‹ Previous</button>
        <button class="sec" onclick="EX.clearResp()">Clear response</button>
        <button class="sec" onclick="EX.markNext()">🚩 Mark for review &amp; Next</button>
        <button onclick="EX.saveNext()">Save &amp; Next ›</button>
        <button class="warnbtn" onclick="EX.openReview()">Review &amp; Submit</button>
      </div>
    </div>
    <aside id="palette" aria-label="Question palette">
      <div class="pcounts" id="pcounts"></div>
      <div class="pgrid" id="pgrid"></div>
      <div class="plegend">
        <div><i style="background:#16a34a"></i>Answered</div>
        <div><i style="background:#dc2626"></i>Not answered</div>
        <div><i style="background:#7c3aed"></i>Marked for review</div>
        <div><i style="background:#475569"></i>Not visited</div>
      </div>
    </aside>
  </div>
  <div id="review" class="overlay" style="display:none"></div>
  <div id="zoom" onclick="this.style.display='none'"><img alt="figure"></div>
  <video id="self" class="selfie" autoplay muted playsinline></video>
</div>

<div id="done" class="scr"><div class="wrap"><div class="card" style="text-align:center">
  <h1>✅ Submitted</h1><p class="muted">Your answers were recorded. You may close this page.</p>
  <a href="/"><button>⤺ Back to portal</button></a>
</div></div></div>

<canvas id="cv" style="display:none"></canvas>
${faceEnrolled ? '<script>var fes=document.createElement("script");fes.defer=true;fes.src=(window.__B||"")+"/vendor/face-api.min.js";document.head.appendChild(fes)</script>' : ''}
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" id="MathJax-script" async></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/python/python.min.js"></script>
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/clike/clike.min.js"></script>
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/javascript/javascript.min.js"></script>
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/sql/sql.min.js"></script>
<script>
var EXAM=${cfg}, TOKEN=${tk};
var EX=(function(){
  var stream=null, attemptId=null, endsAt=0, questions=[], answers={}, away=0, live=false;
  var CLIENT_ID=(Math.random().toString(36).slice(2)+Date.now().toString(36));   // session nonce → concurrent-device detection
  var proctorT=null, clockT=null, saveT=null, audioCtx=null, analyser=null, pendingAudio=null, recBusy=false, started=false;
  var cur=0, marked={}, visited={}, editors={};   // CBT navigation state (current index, flagged, visited, code editors)
  function qs(id){return document.getElementById(id);}
  function show(id){['pre','wait','exam','done','err'].forEach(function(s){qs(s).classList.toggle('on',s===id);});var rv=qs('review');if(rv&&id!=='exam')rv.style.display='none';}
  function fail(m){qs('errmsg').textContent=m||'Something went wrong.';show('err');stopAll();}
  function api(path,body){var o={method:body?'POST':'GET',headers:{'Content-Type':'application/json'}};if(TOKEN)o.headers.Authorization='Bearer '+TOKEN;if(body)o.body=JSON.stringify(body);return fetch(path,o).then(function(r){return r.json();});}
  // ---- face biometric (offline face-api.js → 128-D descriptor; matched 1:1 on the server) ----
  var FACE={loaded:false,loading:null,ok:(typeof EXAM!=='undefined'&&EXAM.faceEnrolled)};
  function faceLoad(){
    if(FACE.loaded)return Promise.resolve(true);
    if(FACE.loading)return FACE.loading;
    if(typeof faceapi==='undefined')return Promise.resolve(false);
    FACE.loading=(async function(){
      try{
        try{if(faceapi.tf&&faceapi.tf.setBackend){await faceapi.tf.setBackend('webgl');await faceapi.tf.ready();}}catch(_){}
        await faceapi.nets.tinyFaceDetector.loadFromUri('/face-models');
        await faceapi.nets.faceLandmark68Net.loadFromUri('/face-models');
        await faceapi.nets.faceRecognitionNet.loadFromUri('/face-models');
        FACE.loaded=true;return true;
      }catch(e){FACE.loading=null;return false;}
    })();
    return FACE.loading;
  }
  // compute up to n descriptors from the live, on-screen video (a few frames → robustness to a bad frame)
  async function faceDescriptors(n){
    if(!await faceLoad())return [];
    var v=vidReady(qs('self'))?qs('self'):(vidReady(qs('cam'))?qs('cam'):qs('cam'));
    if(!v||!v.videoWidth)return [];
    var opts=new faceapi.TinyFaceDetectorOptions({inputSize:320,scoreThreshold:0.4});var out=[];
    for(var i=0;i<(n||1);i++){
      try{var det=await faceapi.detectSingleFace(v,opts).withFaceLandmarks().withFaceDescriptor();
        if(det&&det.descriptor)out.push(Array.from(det.descriptor));}catch(_){}
      if(i<(n||1)-1)await new Promise(function(r){setTimeout(r,250);});
    }
    return out;
  }
  // ---- camera / mic ----
  // Play a <video> once its metadata is ready; muted-as-a-property (set in startCam) keeps autoplay from
  // being blocked (the usual cause of a black preview). Never rejects.
  function camPlay(v){return new Promise(function(res){if(!v){res();return;}var done=false;var go=function(){if(done)return;done=true;try{var p=v.play();if(p&&p.catch)p.catch(function(){});}catch(_){}res();};if(v.readyState>=1)go();else v.onloadedmetadata=go;setTimeout(go,1500);});}
  function camErr(e){var n=(e&&(e.name||e.message))||'';if(/NotAllowed|Permission|Security/i.test(n))return 'Please allow camera access in your browser and reload.';if(/NotFound|not found/i.test(n))return 'No camera was found on this device.';if(/NotReadable|in use|TrackStart/i.test(n))return 'The camera is busy in another app — close it and reload.';return 'Please allow access and reload.';}
  async function startCam(){
    qs('camstat').textContent='Requesting camera & microphone…';
    var c=qs('cam'),s=qs('self');
    // muted/playsInline as PROPERTIES so the preview autoplays instead of showing a black frame
    [c,s].forEach(function(el){if(el){el.muted=true;el.playsInline=true;el.setAttribute('muted','');el.setAttribute('playsinline','');}});
    // soft front-camera hint (won't hard-fail a desktop webcam) + a video-only fallback if the mic is blocked
    var tries=[{video:{facingMode:{ideal:'user'},width:{ideal:640},height:{ideal:480}},audio:true},{video:true,audio:true},{video:{facingMode:{ideal:'user'}},audio:false},{video:true,audio:false}];
    var err=null,gotAudio=false;stream=null;
    for(var i=0;i<tries.length;i++){try{stream=await navigator.mediaDevices.getUserMedia(tries[i]);gotAudio=(tries[i].audio===true)&&stream.getAudioTracks().length>0;break;}catch(e){err=e;}}
    if(!stream){
      if(EXAM.requireCam){qs('camstat').innerHTML='<span class="bad">✗ This exam requires a working camera & microphone. '+camErr(err)+'</span>';qs('beginbtn').disabled=true;}
      else{qs('camstat').innerHTML='<span class="bad">Camera unavailable — you may continue, but this will be noted. ('+camErr(err)+')</span>';qs('beginbtn').disabled=false;}
      return;
    }
    if(c)c.srcObject=stream;if(s)s.srcObject=stream;
    await camPlay(c);await camPlay(s);
    if(gotAudio){try{audioCtx=new (window.AudioContext||window.webkitAudioContext)();var src=audioCtx.createMediaStreamSource(stream);analyser=audioCtx.createAnalyser();analyser.fftSize=512;src.connect(analyser);}catch(_){}}
    qs('camstat').innerHTML='<span class="ok">✓ Camera'+(gotAudio?' & microphone':'')+' ready.</span>'+(gotAudio?'':' <span class="muted">(microphone unavailable — audio monitoring is off)</span>');
    qs('cambtn').style.display='none';qs('kycbtn').style.display='';qs('beginbtn').disabled=false;
    if(FACE.ok){faceLoad();qs('camstat').innerHTML+=' <span class="muted">Face verification is enabled for this exam.</span>';}
  }
  // a <video> inside a display:none screen stops yielding frames — so always grab from whichever
  // video is CURRENTLY ON-SCREEN: the #cam preview during pre-flight, the #self PiP during the exam.
  function vidReady(v){try{if(!v||!v.videoWidth)return false;var r=v.getBoundingClientRect();return r.width>1&&r.height>1;}catch(_){return false;}}
  function frameJpeg(){try{
    var v=vidReady(qs('self'))?qs('self'):(vidReady(qs('cam'))?qs('cam'):(qs('self')&&qs('self').videoWidth?qs('self'):qs('cam')));
    if(!v||!v.videoWidth)return '';
    var cv=qs('cv'),w=320,h=Math.round(320*(v.videoHeight/v.videoWidth||0.75));cv.width=w;cv.height=h;var c=cv.getContext('2d');c.drawImage(v,0,0,w,h);return cv.toDataURL('image/jpeg',0.5);
  }catch(_){return '';}}
  function micLevel(){if(!analyser)return 0;var a=new Uint8Array(analyser.fftSize);analyser.getByteTimeDomainData(a);var s=0;for(var i=0;i<a.length;i++){var d=(a[i]-128)/128;s+=d*d;}return Math.min(100,Math.round(Math.sqrt(s/a.length)*300));}
  async function captureKyc(){
    var img=frameJpeg();if(!img)return alert('Camera not ready yet.');
    qs('kycbtn').disabled=true;qs('kycbtn').textContent='Sending…';
    try{await api('/api/exam/frame',{exam_id:EXAM.id,kyc:true,image_base64:img,client_id:CLIENT_ID});}catch(_){qs('kycbtn').disabled=false;qs('kycbtn').textContent='📸 Capture my photo';return;}
    if(!FACE.ok){qs('kycbtn').textContent='✓ Photo captured';return;}
    // face-enrolled: verify this is really them (1:1) before they may begin
    qs('kycbtn').textContent='🔍 Verifying your face…';
    try{
      var descs=await faceDescriptors(3);
      if(!descs.length){qs('camstat').innerHTML='<span class="bad">✗ We could not see your face clearly. Face the camera in good light and tap again.</span>';qs('kycbtn').disabled=false;qs('kycbtn').textContent='📸 Try again';return;}
      var r=await api('/api/exam/face-verify',{exam_id:EXAM.id,descriptors:descs});
      if(r&&r.enrolled===false){qs('kycbtn').textContent='✓ Photo captured';return;}
      if(r&&r.match){FACE.verified=true;var pct=Math.round((r.confidence||0)*100);qs('camstat').innerHTML='<span class="ok">✓ Identity verified by face ('+pct+'% match). You may begin.</span>';qs('kycbtn').textContent='✓ Face verified';}
      else{FACE.verified=false;qs('camstat').innerHTML='<span class="bad">✗ Your face does not match our records. You may continue, but the invigilator has been alerted to review you live.</span>';qs('kycbtn').disabled=false;qs('kycbtn').textContent='📸 Re-verify';}
    }catch(_){qs('kycbtn').textContent='✓ Photo captured';}
  }
  function recordClip(){
    if(recBusy||!stream)return;var at=stream.getAudioTracks?stream.getAudioTracks():[];if(!at.length)return;
    try{
      var mime=(window.MediaRecorder&&MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))?'audio/webm;codecs=opus':'';
      var mr=new MediaRecorder(new MediaStream(at),mime?{mimeType:mime}:undefined);var chunks=[];recBusy=true;
      mr.ondataavailable=function(ev){if(ev.data&&ev.data.size)chunks.push(ev.data);};
      mr.onstop=function(){recBusy=false;if(!chunks.length)return;var b=new Blob(chunks,{type:mr.mimeType||'audio/webm'});if(b.size>3500000)return;var rd=new FileReader();rd.onload=function(){pendingAudio={b64:String(rd.result).replace(/^data:[^;]+;base64,/,''),mime:mr.mimeType||'audio/webm'};};rd.readAsDataURL(b);};
      mr.start();setTimeout(function(){try{if(mr.state!=='inactive')mr.stop();}catch(_){recBusy=false;}},3500);
    }catch(_){recBusy=false;}
  }
  // record a ~15s VIDEO evidence clip (uploaded when a proctoring violation fires) so the officer can
  // attach it to the flag. A fresh recorder per event guarantees a valid standalone webm.
  var clipBusy=false;
  function recordEvidenceClip(){
    if(clipBusy||!stream)return;var vt=stream.getVideoTracks?stream.getVideoTracks():[];if(!vt.length)return;
    try{
      var mime=(window.MediaRecorder&&MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus'))?'video/webm;codecs=vp8,opus':'video/webm';
      var mr=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:400000});var chunks=[];clipBusy=true;
      mr.ondataavailable=function(ev){if(ev.data&&ev.data.size)chunks.push(ev.data);};
      mr.onstop=function(){clipBusy=false;if(!chunks.length)return;var b=new Blob(chunks,{type:mime});if(b.size>13000000)return;var rd=new FileReader();rd.onload=function(){api('/api/exam/clip',{exam_id:EXAM.id,video_base64:String(rd.result).replace(/^data:[^;]+;base64,/,''),video_mime:mime}).catch(function(){});};rd.readAsDataURL(b);};
      mr.start();setTimeout(function(){try{if(mr.state!=='inactive')mr.stop();}catch(_){clipBusy=false;}},15000);
    }catch(_){clipBusy=false;}
  }
  // ---- start / waiting room ----
  async function begin(){
    if(EXAM.requireCam&&!stream)return alert('Please enable your camera and microphone first.');
    qs('beginbtn').disabled=true;qs('prestat').textContent='Starting…';
    try{var r=await api('/api/exam/start',{exam_id:EXAM.id});
      if(r.waiting){show('wait');setTimeout(begin,4000);return;}
      if(!r.ok)return fail(r.error||'Could not start the exam.');
      initExam(r);
    }catch(e){qs('beginbtn').disabled=false;qs('prestat').textContent='';fail('Could not reach the server. Check your connection.');}
  }
  function initExam(r){
    started=true;attemptId=r.attempt_id;endsAt=Date.parse(r.endsAt||'')||0;questions=r.questions||[];
    var local=loadLocal();answers=Object.assign({},r.answers||{},(local&&local.a)||{});marked=(local&&local.m)||{};cur=0;   // prefer the device's latest (resilient to a dropped connection)
    restoreA11y();setConn();renderQuestion();show('exam');enterFs();startClock();startProctor();bindIntegrity();saveAnswers();
    window.addEventListener('online',function(){setConn();saveAnswers();});window.addEventListener('offline',setConn);
    document.addEventListener('keydown',navKeys);
  }
  function navKeys(e){
    if(!started||qs('review').style.display==='block')return;
    var t=(e.target&&e.target.tagName||'').toLowerCase();var typing=t==='input'||t==='textarea'||(e.target&&e.target.isContentEditable);
    if(typing)return;
    if(e.key==='ArrowRight'){if(cur<questions.length-1)goTo(cur+1);}
    else if(e.key==='ArrowLeft'){if(cur>0)goTo(cur-1);}
    else if((e.key||'').toLowerCase()==='f'){markNext();}
    else if(/^[1-9]$/.test(e.key)){var q=questions[cur];if(q&&(q.type==='mcq'||q.type==='truefalse')){var opts=q.type==='truefalse'?['True','False']:(q.options||[]);var o=opts[parseInt(e.key,10)-1];if(o!=null){answers[q.id]=o;renderQuestion();onAns();}}}
  }
  // ---- CBT engine: one question per page + palette + review ----
  function typeLabel(t){return {mcq:'Multiple choice',truefalse:'True / False',short:'Short answer',essay:'Essay',coding:'Coding',math:'Mathematics',diagram:'Diagram'}[t]||'Question';}
  function isAnswered(q){var a=answers[q.id];return a!=null&&String(a).trim()!=='';}
  function onAns(){scheduleSave();renderPalette();updateProgress();}
  function zoom(src){var z=qs('zoom');z.querySelector('img').src=src;z.style.display='flex';}
  function updateProgress(){var n=questions.filter(isAnswered).length;var p=qs('prog');if(p)p.textContent=n+'/'+questions.length+' answered';}
  function renderQuestion(){
    var q=questions[cur];if(!q)return;visited[q.id]=1;
    var card=qs('qcard');card.innerHTML='';
    var head=document.createElement('div');head.className='qhead';
    head.innerHTML='<span class="qnum">Question '+(cur+1)+' of '+questions.length+'</span><span class="qmeta">'+typeLabel(q.type)+' · '+(q.marks||1)+' mark'+((q.marks||1)>1?'s':'')+(marked[q.id]?' · 🚩 marked':'')+'</span>';
    card.appendChild(head);
    var qt=document.createElement('div');qt.className='qt';qt.innerHTML=esc(q.text||'');card.appendChild(qt);
    if(q.image){var im=document.createElement('img');im.className='qfig';im.src=q.image;im.alt='Question figure';im.title='Click to zoom';im.onclick=function(){zoom(q.image);};card.appendChild(im);}
    var box=document.createElement('div');card.appendChild(box);buildInput(q,box);
    try{if(window.MathJax&&MathJax.typesetPromise)MathJax.typesetPromise([card]).catch(function(){});}catch(_){}
    renderPalette();updateProgress();try{card.scrollIntoView({block:'start'});}catch(_){}
  }
  function buildInput(q,box){
    if(q.type==='mcq'||q.type==='truefalse'){
      var opts=q.type==='truefalse'?['True','False']:(q.options||[]);
      opts.forEach(function(o,oi){var el=document.createElement('label');el.className='opt';el.setAttribute('role','radio');el.tabIndex=0;el.textContent=String.fromCharCode(65+oi)+'. '+o;
        if(answers[q.id]===o){el.classList.add('sel');el.setAttribute('aria-checked','true');}
        var pick=function(){answers[q.id]=o;Array.prototype.forEach.call(box.querySelectorAll('.opt'),function(x){x.classList.remove('sel');x.setAttribute('aria-checked','false');});el.classList.add('sel');el.setAttribute('aria-checked','true');onAns();};
        el.onclick=pick;el.onkeydown=function(e){if(e.key===' '||e.key==='Enter'){e.preventDefault();pick();}};box.appendChild(el);});
    }else if(q.type==='math'){
      var inp=document.createElement('input');inp.type='text';inp.value=answers[q.id]||'';inp.setAttribute('aria-label','Your answer');inp.placeholder='Your answer (number, expression or LaTeX)';
      var prev=document.createElement('div');prev.className='mprev';
      var renderPrev=function(){var v=(inp.value||'').trim();prev.innerHTML=v?('Preview: \\('+v.replace(/</g,'&lt;')+'\\)'):'';try{if(window.MathJax&&MathJax.typesetPromise)MathJax.typesetPromise([prev]).catch(function(){});}catch(_){}};
      inp.oninput=function(){answers[q.id]=inp.value;onAns();renderPrev();};
      box.appendChild(inp);box.appendChild(prev);renderPrev();
      box.appendChild(buildCalc(function(val){inp.value=(inp.value||'')+val;answers[q.id]=inp.value;onAns();renderPrev();}));
    }else if(q.type==='short'){
      var s=document.createElement('input');s.type='text';s.value=answers[q.id]||'';s.setAttribute('aria-label','Your answer');s.oninput=function(){answers[q.id]=s.value;onAns();};box.appendChild(s);
    }else if(q.type==='coding'){
      if(q.language){var lh=document.createElement('div');lh.className='muted';lh.style.fontSize='11px';lh.textContent='Language: '+q.language;box.appendChild(lh);}
      var ta=document.createElement('textarea');ta.className='code';ta.spellcheck=false;ta.value=answers[q.id]||'';box.appendChild(ta);
      ta.addEventListener('keydown',function(e){if(e.key==='Tab'){e.preventDefault();var st=ta.selectionStart,en=ta.selectionEnd;ta.value=ta.value.slice(0,st)+'  '+ta.value.slice(en);ta.selectionStart=ta.selectionEnd=st+2;answers[q.id]=ta.value;onAns();}});
      ta.oninput=function(){answers[q.id]=ta.value;onAns();};
      if(window.CodeMirror){try{var cm=CodeMirror.fromTextArea(ta,{lineNumbers:true,mode:cmMode(q.language),matchBrackets:true,indentUnit:2,tabSize:2});cm.setSize('100%','auto');cm.on('change',function(){answers[q.id]=cm.getValue();onAns();});editors[q.id]=cm;}catch(_){}}
    }else if(q.type==='diagram'){
      var hint=document.createElement('div');hint.className='muted';hint.style.fontSize='11px';hint.textContent='Upload or photograph your diagram / working.';
      var pv=document.createElement('img');pv.style.maxWidth='100%';pv.style.borderRadius='8px';pv.style.margin='6px 0';
      var showPv=function(){if(answers[q.id]){pv.src=answers[q.id];pv.style.display='';pv.style.cursor='zoom-in';pv.onclick=function(){zoom(answers[q.id]);};}else pv.style.display='none';};showPv();
      var fi=document.createElement('input');fi.type='file';fi.accept='image/*';fi.capture='environment';
      fi.onchange=function(){var f=fi.files&&fi.files[0];if(!f)return;var rd=new FileReader();rd.onload=function(){answers[q.id]=String(rd.result);showPv();onAns();};rd.readAsDataURL(f);};
      box.appendChild(hint);box.appendChild(fi);box.appendChild(pv);
    }else{
      var es=document.createElement('textarea');es.rows=8;es.value=answers[q.id]||'';es.setAttribute('aria-label','Your answer');es.oninput=function(){answers[q.id]=es.value;onAns();};box.appendChild(es);
    }
  }
  function cmMode(lang){var l=String(lang||'').toLowerCase();if(l.indexOf('py')>=0)return 'python';if(l.indexOf('sql')>=0)return 'sql';if(l.indexOf('js')>=0||l.indexOf('javascript')>=0||l.indexOf('type')>=0||l.indexOf('node')>=0)return 'javascript';if(l.indexOf('c')>=0||l.indexOf('java')>=0||l.indexOf('kotlin')>=0)return 'text/x-c++src';return 'python';}
  // safe scientific calculator (recursive-descent, NO eval): + - * / ^ ( ) and sin/cos/tan/sqrt/ln/log/etc
  function calcEval(expr){var s=String(expr).replace(/\\s+/g,'').replace(/×/g,'*').replace(/÷/g,'/').replace(/π/g,'PI');var i=0;
    function num(){var st=i;while(i<s.length&&/[0-9.]/.test(s[i]))i++;return parseFloat(s.slice(st,i));}
    function ident(){var st=i;while(i<s.length&&/[a-zA-Z]/.test(s[i]))i++;return s.slice(st,i);}
    function fnc(f,a){f=f.toLowerCase();var m={sin:Math.sin,cos:Math.cos,tan:Math.tan,asin:Math.asin,acos:Math.acos,atan:Math.atan,sqrt:Math.sqrt,ln:Math.log,log:function(x){return Math.log(x)/Math.LN10;},abs:Math.abs,exp:Math.exp};return m[f]?m[f](a):NaN;}
    function factor(){if(s[i]==='('){i++;var v=add();if(s[i]===')')i++;return v;}if(s[i]==='-'){i++;return -factor();}if(s[i]==='+'){i++;return factor();}if(/[a-zA-Z]/.test(s[i])){var id=ident();if(id==='PI')return Math.PI;if(id==='E'||id==='e')return Math.E;if(s[i]==='('){i++;var a=add();if(s[i]===')')i++;return fnc(id,a);}return NaN;}return num();}
    function powf(){var b=factor();if(s[i]==='^'){i++;return Math.pow(b,powf());}return b;}
    function mul(){var v=powf();while(s[i]==='*'||s[i]==='/'){var op=s[i++];var r=powf();v=op==='*'?v*r:v/r;}return v;}
    function add(){var v=mul();while(s[i]==='+'||s[i]==='-'){var op=s[i++];var r=mul();v=op==='+'?v+r:v-r;}return v;}
    try{var res=add();return isFinite(res)?res:NaN;}catch(_){return NaN;}}
  function buildCalc(insert){
    var wrap=document.createElement('div');wrap.className='calc';
    var disp=document.createElement('input');disp.className='disp';disp.readOnly=true;disp.value='';wrap.appendChild(disp);
    var keys=document.createElement('div');keys.className='keys';
    ['7','8','9','/','sqrt(','4','5','6','*','^','1','2','3','-','(','0','.','π',')','+','sin(','cos(','tan(','ln(','log(','C','⌫','=','→ ans',''].forEach(function(k){
      if(k===''){keys.appendChild(document.createElement('span'));return;}
      var b=document.createElement('button');b.type='button';b.textContent=k;b.onclick=function(){
        if(k==='C')disp.value='';
        else if(k==='⌫')disp.value=disp.value.slice(0,-1);
        else if(k==='='){var r=calcEval(disp.value);disp.value=isNaN(r)?'Error':String(Math.round(r*1e10)/1e10);}
        else if(k==='→ ans'){var r2=calcEval(disp.value);if(!isNaN(r2)&&insert)insert(String(Math.round(r2*1e10)/1e10));}
        else disp.value+=k;
      };keys.appendChild(b);});
    wrap.appendChild(keys);return wrap;
  }
  function renderPalette(){
    var grid=qs('pgrid'),counts=qs('pcounts');if(!grid)return;grid.innerHTML='';var ans=0,flg=0;
    questions.forEach(function(q,i){var a=isAnswered(q),m=!!marked[q.id];if(a)ans++;if(m)flg++;
      var cell=document.createElement('div');cell.className='pcell'+(i===cur?' cur':'')+(m&&a?' ansmark':m?' mark':a?' ans':(visited[q.id]?' noans':''));
      cell.textContent=(i+1);cell.tabIndex=0;cell.setAttribute('aria-label','Question '+(i+1)+(a?' answered':' not answered')+(m?' marked':''));
      cell.onclick=function(){goTo(i);};cell.onkeydown=function(e){if(e.key==='Enter')goTo(i);};grid.appendChild(cell);});
    if(counts)counts.innerHTML='✅ '+ans+' answered · 🚩 '+flg+' marked · ⬜ '+(questions.length-ans)+' left';
  }
  function goTo(i){if(i<0||i>=questions.length)return;cur=i;renderQuestion();if(window.innerWidth<=820)qs('palette').classList.remove('open');}
  function prev(){if(cur>0)goTo(cur-1);}
  function clearResp(){var q=questions[cur];if(!q)return;delete answers[q.id];renderQuestion();onAns();}
  function markNext(){var q=questions[cur];if(q)marked[q.id]=!marked[q.id];scheduleSave();if(cur<questions.length-1)goTo(cur+1);else renderQuestion();}
  function saveNext(){saveAnswers();if(cur<questions.length-1)goTo(cur+1);else openReview();}
  function togglePalette(){qs('palette').classList.toggle('open');}
  function openReview(){
    var ans=questions.filter(isAnswered).length,flg=questions.filter(function(q){return marked[q.id];}).length,un=questions.length-ans;
    var html='<div class="rcard"><h1>Review &amp; Submit</h1><p class="muted">'+ans+' answered · '+un+' unanswered · '+flg+' marked for review. Tap a number to go back, or submit your exam.</p>';
    var chips=function(label,filt,col){var list=questions.map(function(q,i){return {q:q,i:i};}).filter(filt);if(!list.length)return '';return '<h2>'+label+'</h2><div>'+list.map(function(o){return '<span class="rrow" style="background:'+col+'" onclick="EX.jump('+o.i+')">'+(o.i+1)+'</span>';}).join('')+'</div>';};
    html+=chips('Unanswered',function(o){return !isAnswered(o.q);},'#dc2626');
    html+=chips('Marked for review',function(o){return marked[o.q.id];},'#7c3aed');
    html+='<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap"><button class="sec" onclick="EX.closeReview()">‹ Back to exam</button><button class="warnbtn" style="margin-left:auto" onclick="EX.submit(false)">✅ Submit exam</button></div></div>';
    var ov=qs('review');ov.innerHTML=html;ov.style.display='block';
  }
  function closeReview(){qs('review').style.display='none';}
  function jump(i){closeReview();goTo(i);}
  // ---- accessibility ----
  function fs(d){var v=Math.max(13,Math.min(22,(parseInt((window.localStorage&&localStorage.getItem('ubu_fs'))||'15',10))+d));try{localStorage.setItem('ubu_fs',v);}catch(_){}document.body.style.setProperty('--fs',v+'px');}
  function contrast(){document.body.classList.toggle('hc');try{localStorage.setItem('ubu_hc',document.body.classList.contains('hc')?'1':'0');}catch(_){}}
  function restoreA11y(){try{var v=parseInt(localStorage.getItem('ubu_fs')||'15',10);document.body.style.setProperty('--fs',v+'px');if(localStorage.getItem('ubu_hc')==='1')document.body.classList.add('hc');}catch(_){}}
  // ---- connection + resilient autosave ----
  function setConn(){var d=qs('conn');if(!d)return;var on=navigator.onLine;d.style.background=on?'#22c55e':'#ef4444';d.title=on?'Online':'Offline — answers are saved on this device and sync when you reconnect';}
  function markSaved(t,c){var s=qs('saved');if(s){s.textContent=t;s.className='chip'+(c?' '+c:'');}}
  function lsKey(){return 'ubuexam_'+EXAM.id;}
  function persistLocal(){try{localStorage.setItem(lsKey(),JSON.stringify({a:answers,m:marked,t:Date.now()}));}catch(_){}}
  function loadLocal(){try{var raw=localStorage.getItem(lsKey());return raw?JSON.parse(raw):null;}catch(_){return null;}}
  function scheduleSave(){persistLocal();markSaved('Saving…');if(saveT)return;saveT=setTimeout(function(){saveT=null;saveAnswers();},1500);}
  function saveAnswers(){persistLocal();if(!attemptId)return;markSaved('Saving…');api('/api/exam/answer',{attempt_id:attemptId,answers:answers,full:true}).then(function(r){if(r&&r.expired){return submit(true);}markSaved(r&&r.ok?'Saved ✓':'Saved on device','ok');}).catch(function(){markSaved('Offline — saved on device','warn');setConn();});}
  // ---- clock ----
  function startClock(){tick();clockT=setInterval(tick,1000);}
  function tick(){var ms=endsAt-Date.now();if(ms<=0){ms=0;qs('clock').textContent='00:00';return submit(true);}var s=Math.floor(ms/1000),m=Math.floor(s/60);qs('clock').textContent=(m<10?'0':'')+m+':'+((s%60)<10?'0':'')+(s%60);if(ms<60000)qs('clock').classList.add('low');}
  // ---- proctor loop ----
  function startProctor(){var since=0;
    var loop=function(){
      var body={exam_id:EXAM.id,image_base64:frameJpeg(),audioLevel:micLevel(),client_id:CLIENT_ID};
      if(pendingAudio){body.audio_base64=pendingAudio.b64;body.audio_mime=pendingAudio.mime;pendingAudio=null;}
      api('/api/exam/frame',body).then(function(r){if(r&&typeof r.live==='boolean'&&r.live!==live){live=r.live;qs('livebadge').style.display=live?'':'none';}}).catch(function(){});
      since++;var audioEvery=live?2:5;if(since%audioEvery===0)recordClip();
      var faceEvery=live?6:6;if(FACE.ok&&since%faceEvery===0)faceCheck();   // continuous identity-hold ≈ every 18-36s
      proctorT=setTimeout(loop,live?1200:3000);
    };
    recordClip();loop();
  }
  // continuous identity-hold: confirm the SAME person is still sitting. A run of misses raises an
  // impersonation flag server-side; here we just warn the candidate (never auto-kick).
  var faceBusy=false;
  async function faceCheck(){
    if(faceBusy||!started)return;faceBusy=true;
    try{var descs=await faceDescriptors(1);if(!descs.length){faceBusy=false;return;}
      var r=await api('/api/exam/face-check',{exam_id:EXAM.id,descriptors:descs});
      if(r&&r.enrolled&&r.match===false)flash('⚠ The face on camera does not match the enrolled candidate. Keep your full face in view, alone and well-lit — the invigilator is reviewing this.');
    }catch(_){}
    faceBusy=false;
  }
  // ---- integrity (warn + log; never auto-kick) ----
  function flash(m){var b=qs('banner');b.textContent=m;b.style.display='block';clearTimeout(b._t);b._t=setTimeout(function(){b.style.display='none';},6000);}
  function reportEvent(type){away++;api('/api/exam/event',{exam_id:EXAM.id,type:type||'left_app'}).catch(function(){});recordEvidenceClip();flash('⚠ Leaving the exam screen is recorded and shown to the invigilator. Stay on this page. ('+away+')');}
  function enterFs(){try{var el=document.documentElement;if(el.requestFullscreen)el.requestFullscreen().catch(function(){});}catch(_){}}
  function bindIntegrity(){
    document.addEventListener('visibilitychange',function(){if(document.hidden&&started)reportEvent('left_app');});
    window.addEventListener('blur',function(){if(started)reportEvent('blur');});
    document.addEventListener('fullscreenchange',function(){if(started&&!document.fullscreenElement){flash('⚠ Please stay in full screen.');var b=qs('banner');b.innerHTML='⚠ You left full screen. <button class="sec" style="padding:4px 10px" onclick="EX.refs()">Return to full screen</button>';b.style.display='block';}});
    ['contextmenu','copy','cut','paste','dragstart'].forEach(function(ev){document.addEventListener(ev,function(e){e.preventDefault();});});
    document.addEventListener('keydown',function(e){var k=(e.key||'').toLowerCase();if((e.ctrlKey||e.metaKey)&&['c','v','x','p','s','u'].indexOf(k)>=0){e.preventDefault();flash('⚠ That shortcut is disabled during the exam.');}if(k==='f12'||(e.ctrlKey&&e.shiftKey&&['i','j','c'].indexOf(k)>=0)){e.preventDefault();}});
  }
  // ---- submit / cleanup ----
  function submit(auto){
    if(!attemptId)return;if(!auto&&!confirm('Submit your exam now? You will not be able to change your answers.'))return;
    started=false;var was=attemptId;attemptId=null;
    api('/api/exam/submit',{attempt_id:was,answers:answers,auto:!!auto,full:true}).then(function(){}).catch(function(){});
    stopAll();show('done');
  }
  function stopAll(){try{clearInterval(clockT);}catch(_){}try{clearTimeout(proctorT);}catch(_){}try{if(document.fullscreenElement)document.exitFullscreen();}catch(_){}try{if(stream)stream.getTracks().forEach(function(t){t.stop();});}catch(_){}}
  window.addEventListener('beforeunload',function(e){if(started){e.preventDefault();e.returnValue='';}});
  return {startCam:startCam,captureKyc:captureKyc,begin:begin,submit:submit,refs:enterFs,
    prev:prev,clearResp:clearResp,markNext:markNext,saveNext:saveNext,openReview:openReview,closeReview:closeReview,jump:jump,
    togglePalette:togglePalette,fs:fs,contrast:contrast};
})();
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(m){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m];});}
document.getElementById('instr').textContent=EXAM.instructions||'Read each question carefully. Your answers save automatically. Click Submit when finished.';
</script>
</body></html>`;
  }

  function studentCharges(sid) { return all('charges').filter(c => c.student_id === sid); }
  function studentPaymentsCompleted(sid) { return all('payments').filter(p => p.student_id === sid && p.status === 'completed'); }
  function balancesFor(sid) {
    const bal = {};
    for (const c of studentCharges(sid)) bal[c.currency] = (bal[c.currency] || 0) + c.amount;
    for (const p of studentPaymentsCompleted(sid)) bal[p.currency] = (bal[p.currency] || 0) - p.amount;
    for (const k of Object.keys(bal)) if (Math.abs(bal[k]) < 0.001) delete bal[k];
    return bal;
  }
  // published per-course scores grouped by session+semester, with semester GPA + overall CGPA
  function scoresFor(sid) {
    const codeK = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Results-release gate: a withheld score is flagged released=0 and stays hidden from the student
    // until an examination-board release publishes it. Legacy rows have no `released` field → visible.
    const raw = all('student_scores').filter(r => r.student_id === sid && !r.deleted && Number(r.released) !== 0)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    // collapse duplicate course rows (same course in the same session+semester) — most recent wins
    const ddMap = {};
    for (const r of raw) ddMap[`${r.session_id || ''}|${r.semester_id || ''}|${codeK(r.course_code)}`] = r;
    const rows = Object.values(ddMap)
      .map(r => { const gp = Number(r.grade_point) || 0, cu = Number(r.credit_unit) || 0; return { course_code: r.course_code, course_title: r.course_title, credit_unit: cu, test_score: r.test_score, exam_score: r.exam_score, score: r.score, grade: r.grade, grade_point: gp, co: gp * cu, session_id: r.session_id, semester_id: r.semester_id, session: nameOf('academic_sessions', r.session_id), semester: nameOf('semesters', r.semester_id), date: r.created_at }; })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    // a blank/ungraded course (grade null — student did not sit, or the mark is not yet recorded) is
    // EXCLUDED from GPA/CGPA; counting its units at zero points would silently penalise it as an F.
    const graded = (s) => s && s.grade != null && String(s.grade).trim() !== '';
    const gpaOf = (list) => { let qp = 0, u = 0; for (const s of list) { if (!graded(s)) continue; qp += s.grade_point * s.credit_unit; u += s.credit_unit; } return { gpa: u ? Math.round((qp / u) * 100) / 100 : 0, units: u }; };
    const groups = {};
    for (const r of rows) { const k = `${r.session_id || ''}|${r.semester_id || ''}`; (groups[k] = groups[k] || { session: r.session, semester: r.semester, session_id: r.session_id, semester_id: r.semester_id, list: [] }).list.push(r); }
    // chronological (ascending) so we can carry a running CGPA per semester
    const ordered = Object.values(groups).sort((a, b) => String((a.list[0] || {}).date).localeCompare(String((b.list[0] || {}).date)));
    let cumQp = 0, cumU = 0;
    const semesters = ordered.map(g => { const b = gpaOf(g.list); cumQp += g.list.reduce((x, c) => x + (graded(c) ? c.grade_point * c.credit_unit : 0), 0); cumU += b.units; return { session: g.session, semester: g.semester, session_id: g.session_id, semester_id: g.semester_id, courses: g.list, ...b, cgpa: cumU ? Math.round((cumQp / cumU) * 100) / 100 : 0 }; });
    const overall = gpaOf(rows);
    return { courses: rows, semesters, cgpa: overall.gpa, totalUnits: overall.units };
  }
  // The courses a student is REGISTERED to offer (auto-linked from Academic Planning) + which of those
  // still have no released result (awaiting). Lets the student see their course list and track which
  // results are still to come. Borrowed/dropped rows are excluded from "awaiting".
  function registeredCoursesFor(sid) {
    const codeK = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const regs = all('course_registrations').filter(r => r.student_id === sid && !r.deleted && r.status === 'registered');
    if (!regs.length) return { courses: [], awaiting: [] };
    const scores = all('student_scores').filter(r => r.student_id === sid && !r.deleted);
    const releasedByCode = {}; const unreleased = new Set();
    for (const s of scores) { const k = codeK(s.course_code); if (Number(s.released) !== 0) releasedByCode[k] = s; else if (s.batch_id !== 'autogen') unreleased.add(k); }
    // per-course status so the student can SEE which results are published, recorded, uploaded-but-not-
    // yet-linked, or simply not uploaded — and report anything wrong. Batch→course code via the courses
    // table; an entry LINKED to me = recorded; any batch for the course = uploaded.
    const courseCodeById = new Map(all('courses').map(c => [c.id, codeK(c.code)]));
    const uploadedCodes = new Set(); const publishedCodes = new Set();
    for (const b of all('result_batches')) { if (b.deleted) continue; const cc = courseCodeById.get(b.course_id); if (cc) { uploadedCodes.add(cc); if (b.status === 'published') publishedCodes.add(cc); } }
    const myLinkedCodes = new Set();
    // resolve my linked entries → their course code (via batch → course)
    const batchCode = new Map(all('result_batches').map(b => [b.id, courseCodeById.get(b.course_id)]));
    for (const e of all('result_entries')) { if (e.deleted || e.student_id !== sid) continue; const cc = batchCode.get(e.batch_id); if (cc) myLinkedCodes.add(cc); }
    const tnoOf = (id, pfx) => (pfx || 'RT') + '-' + String(id || '').replace(/-/g, '').slice(-6).toUpperCase();
    const reqByCode = {};
    for (const r of all('result_fix_requests')) { if (r.deleted || r.student_id !== sid) continue; const k = codeK(r.course_code); if (!reqByCode[k] || String(r.updated_at) > String(reqByCode[k].updated_at)) reqByCode[k] = r; }
    const byCode = {};
    for (const r of regs) { const k = codeK(r.course_code) || r.course_id; if (!k || byCode[k]) continue; byCode[k] = r; }
    const courses = Object.values(byCode).map(r => {
      const ck = codeK(r.course_code);
      let status;
      if (releasedByCode[ck]) status = 'published';
      else if (myLinkedCodes.has(ck) || unreleased.has(ck)) status = 'recorded';
      // the course's sheet was uploaded — if that sheet is already PUBLISHED and this student is not
      // on it, their row is definitively MISSING (absent / not written / misread), not "processing"
      else if (uploadedCodes.has(ck)) status = publishedCodes.has(ck) ? 'missing' : 'uploaded';
      else status = 'not_uploaded';
      const rq = reqByCode[ck];
      const pub = releasedByCode[ck];
      return { course_code: r.course_code, course_title: r.course_title, credit_unit: Number(r.credit_unit) || 0, kind: r.kind, status, hasResult: status === 'published', score: pub ? pub.score : null, grade: pub ? pub.grade : null, request: rq ? { status: rq.status, resolution: rq.resolution, kind: rq.kind, ticket_no: tnoOf(rq.id, 'RT') } : null };
    }).sort((a, b) => String(a.course_code).localeCompare(String(b.course_code)));
    // "awaiting" = a REQUIRED course (core/carry-over) with no released result yet
    const awaiting = courses.filter(c => (c.kind === 'core' || c.kind === 'carryover') && !c.hasResult);
    return { courses, awaiting };
  }
  const ROLE_OFFICE = { registrar: 'Office of the Registrar', accountant: 'Office of the Bursar', dean: 'Office of the Faculty Head', admin: 'Administration', student_affairs: 'Office of Student Affairs', hod: 'Office of the Head of Department' };
  // an HOD-issued receipt names the department; falls back to the plain office label
  const officeOf = (role, deptId) => role === 'hod' ? ('Office of the Head of Department' + (deptId && nameOf('departments', deptId) ? ' — ' + nameOf('departments', deptId) : '')) : (ROLE_OFFICE[role] || 'Office of the Bursar');

  function studentProfile(s) {
    return {
      id: s.id, full_name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), matric_no: s.matric_no,
      email: s.email, phone: s.phone, gender: s.gender, photo: s.photo, nationality: s.nationality,
      faculty: nameOf('faculties', s.faculty_id), department: nameOf('departments', s.department_id), level: nameOf('levels', s.level_id),
      campus: nameOf('campuses', s.campus_id),
      status: s.status,
    };
  }

  // OPEN evaluation surveys for a student's cohort (faculty/department/level; NULL = any) that the
  // student has not already answered. The questions are sent so the portal can render the form.
  function openSurveysForStudent(s) {
    return all('eval_surveys').filter(sv => !sv.deleted && sv.status === 'open'
        && (!sv.faculty_id || sv.faculty_id === s.faculty_id)
        && (!sv.department_id || sv.department_id === s.department_id)
        && (!sv.level_id || sv.level_id === s.level_id))
      .filter(sv => !all('eval_responses').some(r => !r.deleted && r.survey_id === sv.id && r.student_id === s.id))
      .map(sv => { let qs = []; try { qs = JSON.parse(sv.questions || '[]'); } catch (_) {} return { id: sv.id, title: sv.title, description: sv.description, course: sv.course_code, lecturer: sv.lecturer_name, questions: Array.isArray(qs) ? qs : [] }; });
  }

  function studentData(s) {
    const charges = studentCharges(s.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const pays = studentPaymentsCompleted(s.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const outstanding = {};
    // per category+currency
    const billed = {}; const paid = {};
    for (const c of charges) { const k = c.category + '|' + c.currency; billed[k] = (billed[k] || 0) + c.amount; }
    for (const p of pays) { const k = p.category + '|' + p.currency; paid[k] = (paid[k] || 0) + p.amount; }
    const owingRows = [];
    for (const k of Object.keys(billed)) {
      const [category, currency] = k.split('|'); const owed = billed[k] - (paid[k] || 0);
      if (owed > 0.001) owingRows.push({ category, currency, billed: billed[k], paid: paid[k] || 0, outstanding: owed });
    }
    const userName = (uid) => { const u = uid ? one('users', uid) : null; return u ? u.full_name : null; };
    // exam clearance status: full clearance, else active partial, else not cleared.
    // A student may hold BOTH a mid-semester and an examination clearance — list each
    // so the portal can offer a separate, correctly-labelled certificate per type.
    const clr = (() => {
      const completed = all('exam_clearances').filter(c => c.student_id === s.id && c.status === 'completed')
        .map(c => ({ id: c.id, type: c.clearance_type === 'midterm' ? 'midterm' : 'exam', typeName: c.clearance_type === 'midterm' ? 'Mid-Semester' : 'Examination' }));
      if (completed.length) {
        const exam = completed.find(c => c.type === 'exam') || completed[0];
        return { cleared: true, type: 'full', clearanceId: exam.id, certs: completed };
      }
      const partial = all('partial_clearances').find(p => p.student_id === s.id && p.status === 'active');
      if (partial) return { cleared: true, type: 'partial', reason: partial.reason, certs: [] };
      const owes = Object.values(balancesFor(s.id)).some(v => v > 0.001);
      return { cleared: false, type: null, reason: owes ? 'Outstanding fees not cleared' : 'No examination clearance issued', certs: [] };
    })();
    const validations = all('exam_validations').filter(v => v.student_id === s.id)
      .map(v => ({ status: v.status, reason: v.reason, exam_type: v.exam_type, date: v.created_at, session: nameOf('academic_sessions', v.session_id), semester: nameOf('semesters', v.semester_id) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    // published timetables for this student's cohort (lecture for dept+level; exams dept- or
    // faculty-wide, with faculty-wide sittings filtered down to the student's own cohort).
    const myTimetables = all('timetables').filter(t => !t.deleted && t.status === 'published')
      .filter(t => t.scope === 'faculty' ? t.faculty_id === s.faculty_id : (t.department_id === s.department_id && (!t.level_id || t.level_id === s.level_id)))
      .map(t => {
        let slots = all('timetable_slots').filter(sl => sl.timetable_id === t.id && !sl.deleted);
        if (t.scope === 'faculty') slots = slots.filter(sl => sl.kind === 'holiday' || (sl.department_id === s.department_id && (!sl.level_id || sl.level_id === s.level_id)));
        slots = slots.map(sl => ({ course_code: sl.course_code, course_title: sl.course_title, lecturer: sl.lecturer_name, day: sl.day_or_date, start: sl.start_time, end: sl.end_time, venue: sl.venue, kind: sl.kind }))
          .sort((a, b) => String(a.day).localeCompare(String(b.day)) || String(a.start || '').localeCompare(String(b.start || '')));
        return { id: t.id, title: t.title, type: t.type, level: nameOf('levels', t.level_id), department: nameOf('departments', t.department_id), faculty: nameOf('faculties', t.faculty_id), session: nameOf('academic_sessions', t.session_id), semester: nameOf('semesters', t.semester_id), date: t.published_at, slots };
      }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    // published course allocations (which lecturer teaches each course) for dept+level
    const myAllocations = all('allocation_sets').filter(a => !a.deleted && a.status === 'published' && a.department_id === s.department_id && a.level_id === s.level_id)
      .map(a => ({ id: a.id, title: a.title, department: nameOf('departments', a.department_id), level: nameOf('levels', a.level_id), session: nameOf('academic_sessions', a.session_id), semester: nameOf('semesters', a.semester_id), date: a.published_at,
        courses: all('course_allocations').filter(r => r.set_id === a.id && !r.deleted).map(r => ({ code: r.course_code, title: r.course_title, ch: r.credit_unit, lecturer: r.lecturer_name })) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const i = inst();
    // segment by office so the student sees exactly who they owe (and who collected)
    const roleOf = (uid) => { const u = uid ? one('users', uid) : null; return u ? u.role : null; };
    const offices = {};
    const bucket = (role) => { const k = role || 'accountant'; offices[k] = offices[k] || { role: k, office: officeOf(k, s.department_id), charged: {}, paid: {}, owing: {} }; return offices[k]; };
    for (const c of charges) { const b = bucket(roleOf(c.created_by) || 'accountant'); b.charged[c.currency] = (b.charged[c.currency] || 0) + c.amount; }
    for (const pmt of pays) { const b = bucket(pmt.raised_role || 'accountant'); b.paid[pmt.currency] = (b.paid[pmt.currency] || 0) + pmt.amount; }
    for (const k of Object.keys(offices)) { const o = offices[k]; for (const cur of new Set([...Object.keys(o.charged), ...Object.keys(o.paid)])) { const owe = (o.charged[cur] || 0) - (o.paid[cur] || 0); if (owe > 0.001) o.owing[cur] = owe; } }
    return {
      profile: studentProfile(s),
      byOffice: Object.values(offices),
      currentSession: i.session || nameOf('academic_sessions', s.current_session_id) || '',
      currentSemester: i.semester || '',
      balances: balancesFor(s.id),
      examClearance: clr,
      finalClearance: finalClearanceView(s),
      validations,
      results: all('results').filter(r => r.student_id === s.id).map(r => ({ id: r.id, title: r.title, level: nameOf('levels', r.level_id), semester: nameOf('semesters', r.semester_id), session: nameOf('academic_sessions', r.session_id), gpa: r.gpa, remark: r.remark, mime: r.mime, date: r.created_at })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      scores: scoresFor(s.id),
      registeredCourses: registeredCoursesFor(s.id),
      timetables: myTimetables,
      allocations: myAllocations,
      liveClasses: liveClassesForStudent(s),
      notifications: buildNotifications(s),
      library: libraryForStudent(s),
      surveillance: surveillanceForStudent(s),
      exams: examsForStudent(s),
      documents: all('portal_documents').filter(d => docVisibleTo(d, s))
        .map(d => ({ id: d.id, title: d.title, category: d.category, office: d.office, by: userName(d.uploaded_by), mime: d.mime, date: d.created_at })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      transcriptRequests: all('transcript_requests').filter(r => r.student_id === s.id && !r.deleted)
        .map(r => ({ id: r.id, kind: r.kind, purpose: r.purpose, status: r.status, note: r.note, date: r.created_at })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      // 📨 GRADUATE DOCUMENT DISPATCH — can this student send their credentials to an organization,
      // and which issued documents are available to send? (graduates only; registrar's email sends)
      dispatch: (() => {
        const al2 = all('alumni').find(a => a.student_id === s.id && !a.deleted);
        const graduated = !!al2 || ['alumni', 'graduated'].includes(String(s.status || '').toLowerCase());
        const byKind = (k) => all('portal_documents').some(x => !x.deleted && x.student_id === s.id && x.auto_kind === k);
        const docs = CREDENTIAL_DOCS.map(spec => ({ key: spec.key, label: spec.label, available: (!spec.gradOnly || graduated) && spec.kinds.some(byKind) }));
        return { graduated, docs, ready: graduated && ['transcript', 'certificate'].every(k => (docs.find(x => x.key === k) || {}).available) };
      })(),
      // OPEN evaluation surveys for this student's cohort that they have NOT yet answered
      surveys: openSurveysForStudent(s),
      // any score withheld by the examinations board (released=0) → the results tab shows a notice.
      // Auto-transcript DRAFTS are also released=0 but must stay completely silent (they are not a
      // "withhold" — the officer simply hasn't published yet), so they are excluded here.
      resultsWithheld: all('student_scores').some(r => r.student_id === s.id && !r.deleted && Number(r.released) === 0 && r.batch_id !== 'autogen'),
      // fee invoices issued to this student (download the PDF from the Documents tab)
      invoices: all('invoices').filter(iv => iv.student_id === s.id && !iv.deleted).map(iv => ({ invoice_no: iv.invoice_no, amount: iv.amount, currency: iv.currency, due_date: iv.due_date, status: iv.status, date: iv.created_at })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      misconduct: all('misconducts').filter(m => m.student_id === s.id && !m.deleted).map(m => ({ offense: m.offense, severity: m.severity, action: m.action, fine: m.penalty_amount || 0, currency: m.currency, status: m.status, date: m.occurred_at || m.created_at, note: m.resolution_note || m.description || '' })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      charges: charges.map(c => ({ id: c.id, category: c.category, description: c.description, currency: c.currency, amount: c.amount, date: c.created_at, by: userName(c.created_by), rollover: !!c.is_rolled_over, rolled_from: nameOf('academic_sessions', c.rolled_from_session) })),
      payments: pays.map(p => ({ id: p.id, receipt_no: p.receipt_no, category: p.category, currency: p.currency, amount: p.amount, method: p.method, date: p.decided_at || p.created_at, office: officeOf(p.raised_role, s.department_id), collector: userName(p.decided_by || p.raised_by) })),
      outstanding: owingRows,
    };
  }

  // ---- student assistant (deterministic intent engine over the student's own data) ----
  // Answers the common portal questions ("my results", "how much do I owe", "when are my exams",
  // "am I cleared") from the SAME data the dashboard shows. No AI key needed — works on any portal.
  function sumByCur(items) { const m = {}; for (const it of items) m[it.currency] = (m[it.currency] || 0) + it.amount; return Object.keys(m).map(c => money(m[c], c)).join(' + ') || money(0); }
  function studentAssistant(s, message, isParent) {
    const d = studentData(s);
    const q = String(message || '').toLowerCase().trim();
    const who = isParent ? 'your ward' : 'you'; const has = (s2) => isParent ? (s2 + 's') : s2; // verb agreement helper
    const fname = s.first_name || (d.profile && (d.profile.full_name || '').split(' ')[0]) || 'there';
    const re = (rx) => rx.test(q);

    if (re(/\b(owe|owing|balance|outstanding|debt|arrears)\b/) || (/how much/.test(q) && /(owe|pay|fee|balance|left)/.test(q))) {
      const owe = (d.outstanding || []).filter(o => o.outstanding > 0.001);
      if (!owe.length) return `Good news — ${who} ${isParent ? 'has' : 'have'} no outstanding balance. ✅`;
      const lines = owe.map(o => '• ' + catLabel(o.category) + ': ' + money(o.outstanding, o.currency) + ' outstanding (of ' + money(o.billed, o.currency) + ' billed)').join('\n');
      return `Here is what ${who} currently ${has('owe')}:\n${lines}\nTotal: ${sumByCur(owe.map(o => ({ currency: o.currency, amount: o.outstanding })))}\nOpen the Fees tab to pay or download a statement.`;
    }
    if (re(/\b(my fees|school fees|tuition|charges|fee breakdown|bill)\b/) || (/what.*fee/.test(q))) {
      const ch = d.charges || [];
      if (!ch.length) return `No fees have been billed to ${who} yet.`;
      const g = {}; for (const c of ch) { const k = c.category + '|' + c.currency; g[k] = (g[k] || 0) + c.amount; }
      const lines = Object.keys(g).map(k => { const [cat, cur] = k.split('|'); return '• ' + catLabel(cat) + ': ' + money(g[k], cur); }).join('\n');
      return `Fees billed to ${who}:\n${lines}\nSee the Fees tab for the full statement and to pay.`;
    }
    if (re(/\b(result|results|score|scores|gpa|cgpa|grade|grades|my marks?|how did i do)\b/)) {
      const sc = d.scores || [], rs = d.results || [];
      if (!sc.length && !rs.length) return `No results have been published for ${who} yet. ${isParent ? 'They' : 'You'} will be notified when they are ready, and can download them from the Results tab.`;
      const sems = new Set(sc.map(x => (x.session || '') + '|' + (x.semester || ''))).size;
      let msg = `${isParent ? 'Your ward has' : 'You have'} published results in ${sems || rs.length} semester(s).`;
      if (rs[0] && rs[0].gpa) msg += ' Most recent GPA: ' + rs[0].gpa + '.';
      return msg + ' Open the Results tab to view or download each statement.';
    }
    if (re(/\b(exam|exams|test|paper|timetable|time table|schedule|class|classes|lecture|lectures)\b/) || /when (is|are|do)/.test(q)) {
      const examSlots = [];
      for (const t of (d.timetables || []).filter(t => t.type === 'exam')) for (const sl of (t.slots || [])) if (sl.kind !== 'holiday' && sl.course_code) examSlots.push(sl);
      examSlots.sort((a, b) => String(a.day).localeCompare(String(b.day)));
      if (/exam|test|paper/.test(q) && examSlots.length) {
        const next = examSlots.slice(0, 4).map(sl => '• ' + sl.course_code + (sl.course_title ? (' ' + sl.course_title) : '') + ': ' + fmtDate(sl.day) + (sl.start ? (' at ' + sl.start) : '') + (sl.venue ? (' — ' + sl.venue) : '')).join('\n');
        return 'Upcoming exams:\n' + next + '\nFull details are in the Timetable tab.';
      }
      const lectures = (d.timetables || []).filter(t => t.type === 'lecture');
      if (lectures.length) return 'Your lecture timetable is published — open the Timetable tab for your weekly classes.' + (examSlots.length ? ' Your exam timetable is there too.' : '');
      if (examSlots.length) return 'Your exam timetable is published — open the Timetable tab.';
      return 'No timetable has been published yet. You will be notified when it is out.';
    }
    if (re(/\b(clearance|cleared|exam card)\b/)) {
      const clr = d.examClearance || {};
      return clr.cleared ? `${isParent ? 'Your ward is' : 'You are'} cleared for exams ✅. Download the certificate from the Clearance tab.` : `${isParent ? 'Your ward is' : 'You are'} not cleared for exams yet${clr.reason ? (': ' + clr.reason) : ''}. Clear any outstanding fees, then check with the bursary.`;
    }
    if (re(/\b(document|documents|admission letter|transcript|certificate|library|book|e-?book)\b/)) return 'Your documents (admission letter, transcript, etc.) are in the Documents tab, and e-books are in the Library tab.';
    if (re(/\b(help|what can you|how do i|navigate|where|menu|guide|assist)\b/)) return `I can help ${who} with:\n• Results & GPA — “show my results”\n• School fees & balance — “how much do I owe?”\n• Exam clearance — “am I cleared?”\n• Timetable & exams — “when are my exams?”\nUse the tabs at the top for Fees, Results, Timetable, Documents and Library.`;
    if (re(/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/)) return `Hi ${fname}! I can help you check your results, school fees, balance, clearance and timetable. What would you like to know?`;
    return 'I can help with your results, school fees, how much you owe, exam clearance and timetable. Try “How much do I owe?”, “Show my results”, or “When are my exams?”.';
  }

  function staffProfile(s) {
    return {
      id: s.id, full_name: s.full_name, staff_no: s.staff_no, type: s.staff_type === 'lecturer' ? 'Lecturer' : 'Staff',
      title: s.title, position: s.position, department: s.department, faculty: s.faculty, qualification: s.qualification,
      email: s.email, phone: s.phone, photo: s.photo, bank_name: s.bank_name, bank_account: s.bank_account,
      base_salary: s.base_salary, currency: s.currency, date_employed: s.date_employed,
    };
  }
  function staffData(s) {
    const slips = all('payslips').filter(p => p.staff_id === s.id).map(p => {
      const run = one('payroll_runs', p.run_id) || {};
      return { id: p.id, period: run.period, status: run.status, run_type: run.run_type, gross: p.gross, allowances: p.allowances, bonus: p.bonus, deductions: p.deductions, loan_deduction: p.loan_deduction, net: p.net, currency: p.currency };
    }).sort((a, b) => String(b.period).localeCompare(String(a.period)));
    // invigilation duties assigned to this staff member on PUBLISHED exam schedules
    const invigilations = [];
    for (const sg of all('exam_seatings')) {
      if (sg.deleted) continue;
      let inv = []; try { inv = JSON.parse(sg.invigilators || '[]'); } catch (_) {}
      if (!inv.some(x => x && x.id === s.id)) continue;
      const t = one('timetables', sg.timetable_id);
      if (!t || t.status !== 'published') continue;
      invigilations.push({ date: sg.date, start: sg.start_time, end: sg.end_time, room: sg.room_name, course: sg.course_code, department: nameOf('departments', sg.department_id), level: nameOf('levels', sg.level_id) });
    }
    invigilations.sort((a, b) => String((a.date || '') + (a.start || '')).localeCompare(String((b.date || '') + (b.start || ''))));
    return { profile: staffProfile(s), payslips: slips, invigilations, liveClasses: s.staff_type === 'lecturer' ? liveClassesForLecturer(s) : [] };
  }

  // Build a period filter from query params: basis = day|week|month|semester|session|all
  function parsePeriod(sp) {
    const basis = sp.get('basis') || (sp.get('session') || sp.get('semester') ? 'session' : 'all');
    return { basis, day: sp.get('day') || '', weekStart: sp.get('weekStart') || '', month: sp.get('month') || '', session: sp.get('session') || '', semester: sp.get('semester') || '', office: sp.get('office') || '' };
  }
  function periodLabel(period) {
    if (!period) return 'All time';
    switch (period.basis) {
      case 'day': return period.day ? 'On ' + period.day : 'Daily';
      case 'week': return period.weekStart ? 'Week of ' + period.weekStart : 'Weekly';
      case 'month': return period.month ? 'Month of ' + period.month : 'Monthly';
      case 'semester': return (period.session ? (nameOf('academic_sessions', period.session) || 'session') : 'All sessions') + ' · ' + (period.semester ? (nameOf('semesters', period.semester) || 'semester') : 'All semesters');
      case 'session': return period.session ? (nameOf('academic_sessions', period.session) || 'Session') : 'All sessions';
      default: return 'All time';
    }
  }

  function officerData(u, period) {
    const role = u.role;
    const dstr = (r) => String(r.decided_at || r.created_at || '');
    const inP = (r) => {
      if (!period || !period.basis || period.basis === 'all') return true;
      if (period.basis === 'day') return !period.day || dstr(r).slice(0, 10) === period.day;
      if (period.basis === 'week') { if (!period.weekStart) return true; const e = new Date(period.weekStart + 'T00:00:00'); e.setDate(e.getDate() + 7); const end = e.toISOString().slice(0, 10); const d = dstr(r).slice(0, 10); return d >= period.weekStart && d < end; }
      if (period.basis === 'month') return !period.month || dstr(r).slice(0, 7) === period.month;
      // session / semester
      return (!period.session || (r.session_id || '') === period.session) && (!period.semester || (r.semester_id || '') === period.semester);
    };
    // a campus-pinned officer (e.g. a campus accountant) only sees their campus; the super admin (no
    // campus_id) sees every campus. This mirrors campus.scopeFor on the desktop.
    const oc = u.campus_id || null;
    const inC = (r) => !oc || r.campus_id === oc;
    const completed = all('payments').filter(p => p.status === 'completed' && inP(p) && inC(p));
    const out = {
      profile: { id: u.id, full_name: u.full_name, role, email: u.email, photo: u.photo || '' },
      periods: { sessions: all('academic_sessions').map(s => ({ id: s.id, name: s.name })), semesters: all('semesters').map(s => ({ id: s.id, name: s.name, session_id: s.session_id })) },
      period: period || {},
    };
    if (role === 'accountant' || role === 'admin' || role === 'campus_admin') {
      const collected = {}; const billed = {}; const expenses = {};
      for (const p of completed) collected[p.currency] = (collected[p.currency] || 0) + p.amount;
      for (const c of all('charges').filter(c => inP(c) && inC(c))) billed[c.currency] = (billed[c.currency] || 0) + c.amount;
      for (const e of all('expenses').filter(e => inP(e) && inC(e))) expenses[e.currency] = (expenses[e.currency] || 0) + e.amount;
      const students = all('students').filter(s => s.status !== 'alumni' && inC(s));
      let debtors = 0; for (const s of students) if (Object.values(balancesFor(s.id)).some(v => v > 0.001)) debtors++;
      out.kind = 'finance';
      out.canPickOffice = true;
      out.cards = { collected, billed, expenses, students: students.length, debtors };
      // per-campus student headcount — only meaningful for the super admin (a campus officer sees one)
      const camps = all('campuses');
      if (camps.length > 1 && !oc) {
        const rows = camps.map(c => ({ name: c.name, students: students.filter(s => s.campus_id === c.id).length }));
        const unassigned = students.filter(s => !s.campus_id).length;
        if (unassigned) rows.push({ name: 'Unassigned', students: unassigned });
        out.campuses = rows;
      }
      const OFFICE_LABEL = { accountant: 'Bursary / Accountant', registrar: 'Registrar', dean: 'Faculty Head (Dean)', student_affairs: 'Student Affairs', admin: 'Administration' };
      const userName = (id) => { const x = id ? one('users', id) : null; return x ? x.full_name : '—'; };
      // collections grouped by the office that collected them
      const byOffice = {};
      for (const p of completed) { const r = p.raised_role || 'accountant'; byOffice[r] = byOffice[r] || {}; byOffice[r][p.currency] = (byOffice[r][p.currency] || 0) + p.amount; }
      out.byOffice = Object.entries(byOffice).map(([r, m]) => ({ role: r, office: OFFICE_LABEL[r] || r, amounts: m })).sort((a, b) => a.office.localeCompare(b.office));
      // optional office filter (the accountant picks an office to drill into)
      const off = period && period.office;
      const filtered = off ? completed.filter(p => (p.raised_role || 'accountant') === off) : completed;
      out.officeFilter = off || '';
      out.recent = filtered.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 60)
        .map(p => ({ receipt_no: p.receipt_no, student: studentName(p.student_id), category: p.category, amount: p.amount, currency: p.currency, office: OFFICE_LABEL[p.raised_role || 'accountant'] || '—', by: userName(p.decided_by || p.raised_by), date: p.decided_at || p.created_at }));
      // expenses — ALL offices, with who recorded them
      const expRows = all('expenses').filter(inP);
      const expByOffice = {};
      for (const e of expRows) { const r = (one('users', e.recorded_by) || {}).role || 'accountant'; expByOffice[r] = expByOffice[r] || {}; expByOffice[r][e.currency] = (expByOffice[r][e.currency] || 0) + e.amount; }
      out.expensesByOffice = Object.entries(expByOffice).map(([r, m]) => ({ office: OFFICE_LABEL[r] || r, amounts: m }));
      out.expensesList = expRows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 60)
        .map(e => ({ category: e.category, description: e.description, amount: e.amount, currency: e.currency, by: userName(e.recorded_by), date: e.created_at }));
    } else if (role === 'registrar' || role === 'student_affairs') {
      out.kind = 'registrar';
      out.collected = {};
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) { out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount; }
      const ids = [...new Set(all('charges').filter(c => c.created_by === u.id && inP(c)).map(c => c.student_id))];
      out.students = ids.map(sid => billedSummary(sid, u.id)).filter(Boolean);
    } else if (role === 'dean') {
      out.kind = 'dean'; out.collected = {}; out.expenses = {};
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount;
      for (const e of all('expenses').filter(e => e.recorded_by === u.id && inP(e))) out.expenses[e.currency] = (out.expenses[e.currency] || 0) + e.amount;
      const inFac = all('students').filter(s => s.faculty_id === u.faculty_id && s.status !== 'alumni' && (!u.campus_id || s.campus_id === u.campus_id));
      out.debtors = [];
      for (const s of inFac) {
        const bal = {};
        for (const c of studentCharges(s.id)) if (['faculty_due', 'custom'].includes(c.category)) bal[c.currency] = (bal[c.currency] || 0) + c.amount;
        for (const p of studentPaymentsCompleted(s.id)) if (['faculty_due', 'custom'].includes(p.category)) bal[p.currency] = (bal[p.currency] || 0) - p.amount;
        const owing = {}; for (const k of Object.keys(bal)) if (bal[k] > 0.001) owing[k] = bal[k];
        if (Object.keys(owing).length) out.debtors.push({ full_name: studentName(s.id), matric_no: s.matric_no, department: nameOf('departments', s.department_id), owing });
      }
    } else if (role === 'hod') {
      // a Head of Department's portal view mirrors the dean's, scoped to ONE department
      out.kind = 'dean'; out.collected = {}; out.expenses = {}; out.scopeLabel = 'Department: ' + (nameOf('departments', u.department_id) || '—');
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount;
      for (const e of all('expenses').filter(e => e.recorded_by === u.id && inP(e))) out.expenses[e.currency] = (out.expenses[e.currency] || 0) + e.amount;
      const inDept = all('students').filter(s => s.department_id === u.department_id && s.status !== 'alumni' && (!u.campus_id || s.campus_id === u.campus_id));
      out.debtors = [];
      for (const s of inDept) {
        const bal = {};
        for (const c of studentCharges(s.id)) if (['faculty_due', 'custom'].includes(c.category)) bal[c.currency] = (bal[c.currency] || 0) + c.amount;
        for (const p of studentPaymentsCompleted(s.id)) if (['faculty_due', 'custom'].includes(p.category)) bal[p.currency] = (bal[p.currency] || 0) - p.amount;
        const owing = {}; for (const k of Object.keys(bal)) if (bal[k] > 0.001) owing[k] = bal[k];
        if (Object.keys(owing).length) out.debtors.push({ full_name: studentName(s.id), matric_no: s.matric_no, department: nameOf('departments', s.department_id), owing });
      }
    } else { // student_affairs (no collections role) — clearance + discipline summary
      out.kind = 'affairs';
      const aps = all('clearance_approvals').filter(a => a.office === 'student_affairs');
      out.clearance = { pending: aps.filter(a => a.status === 'pending').length, approved: aps.filter(a => a.status === 'approved').length, denied: aps.filter(a => a.status === 'denied').length };
      const mc = all('misconducts');
      out.misconduct = { total: mc.length, open: mc.filter(m => m.status === 'open').length, resolved: mc.filter(m => m.status === 'resolved').length };
    }
    return out;
  }
  function studentName(sid) { const s = one('students', sid); return s ? `${s.first_name || ''} ${s.last_name || ''}`.trim() : '—'; }
  function billedSummary(sid, uid) {
    const s = one('students', sid); if (!s) return null;
    const billed = {}; const paid = {}; const owing = {};
    for (const c of studentCharges(sid)) if (c.created_by === uid) billed[c.currency] = (billed[c.currency] || 0) + c.amount;
    for (const p of studentPaymentsCompleted(sid)) if (p.raised_by === uid || p.decided_by === uid) paid[p.currency] = (paid[p.currency] || 0) + p.amount;
    for (const k of new Set([...Object.keys(billed), ...Object.keys(paid)])) { const o = (billed[k] || 0) - (paid[k] || 0); if (o > 0.001) owing[k] = o; }
    return { full_name: studentName(sid), matric_no: s.matric_no, department: nameOf('departments', s.department_id), paid, owing };
  }

  // ---- clearance verification (public; staff scan the QR to confirm a student) ----
  function verifyClearance(idOrRef) {
    const key = String(idOrRef || '').trim();
    if (!key) return { valid: false };
    let c = one('exam_clearances', key);
    if (!c) { // accept a short ref (first hex chars of the id)
      const want = key.replace(/-/g, '').toLowerCase();
      if (want.length >= 6 && want.length <= 16) c = all('exam_clearances').find(x => String(x.id).replace(/-/g, '').toLowerCase().startsWith(want));
    }
    if (!c) return { valid: false };
    const s = one('students', c.student_id) || {};
    const approvals = all('clearance_approvals').filter(a => a.clearance_id === c.id)
      .map(a => ({ office: a.office, status: a.status, by: a.approver_id ? ((one('users', a.approver_id) || {}).full_name || null) : null, date: a.decided_at }));
    const isMid = c.clearance_type === 'midterm';
    return {
      valid: true, completed: c.status === 'completed', status: c.status,
      clearanceType: isMid ? 'midterm' : 'exam', typeName: isMid ? 'Mid-Semester' : 'Examination',
      ref: String(c.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      student: {
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown', matric: s.matric_no || '—', gender: s.gender || '—',
        photo: s.photo || '', faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—',
        level: nameOf('levels', s.level_id) || '—', status: s.status || '—',
      },
      session: nameOf('academic_sessions', c.session_id) || '—', semester: nameOf('semesters', c.semester_id) || '—',
      approvals, issued: c.created_at,
    };
  }

  // Public STUDENT identity check (no login) — backs the digital student ID card's QR. Resolves a
  // student by matric number (preferred) or id and returns ONLY public identity (name/faculty/dept/
  // level/status/photo) — never any financials — so security/gate staff can confirm enrolment.
  function verifyStudent(matricOrId) {
    const key = String(matricOrId || '').trim();
    if (!key) return { valid: false };
    let s = all('students').find(x => !x.deleted && String(x.matric_no || '').toLowerCase() === key.toLowerCase());
    if (!s) s = one('students', key);
    if (!s || s.deleted) return { valid: false };
    return {
      valid: true, kind: 'student',
      ref: String(s.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      student: {
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown',
        matric: s.matric_no || '—', photo: s.photo || '',
        faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—',
        level: nameOf('levels', s.level_id) || '—', status: s.status || 'active',
      },
      session: nameOf('academic_sessions', s.session_id) || (inst().session || '—'),
    };
  }

  // Public receipt authenticity check (no login). Resolves a payment by id, short
  // id-ref, OR its printed receipt number, and returns the genuine details so anyone
  // can confirm a receipt presented to them isn't forged or altered.
  function verifyReceipt(idOrRef) {
    const key = String(idOrRef || '').trim();
    if (!key) return { valid: false };
    let p = one('payments', key);
    if (!p) {
      const want = key.replace(/-/g, '').toLowerCase();
      if (want.length >= 6 && want.length <= 16) p = all('payments').find(x => String(x.id).replace(/-/g, '').toLowerCase().startsWith(want));
      if (!p) p = all('payments').find(x => String(x.receipt_no || '').toLowerCase() === key.toLowerCase());
    }
    if (!p || p.deleted || p.status !== 'completed') return { valid: false };
    const s = one('students', p.student_id) || {};
    const office = ROLE_OFFICE[p.raised_role] || 'Office of the Bursar';
    const receivedBy = (one('users', p.decided_by) || one('users', p.raised_by) || {}).full_name || office;
    const catRow = all('fee_categories').find(c => c.key === p.category && !c.deleted);
    const feeLabel = (catRow && catRow.name) || (p.category ? p.category[0].toUpperCase() + p.category.slice(1).replace(/_/g, ' ') + ' Fee' : '—');
    return {
      valid: true, kind: 'receipt',
      ref: String(p.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      receipt_no: p.receipt_no || '—',
      amountText: money(p.amount, p.currency),
      category: feeLabel, narration: p.narration || '',
      method: String(p.channel || p.method || 'cash').toUpperCase(),
      dateText: fmtDate(p.decided_at || p.created_at), office, receivedBy,
      student: {
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown',
        matric: s.matric_no || '—', photo: s.photo || '',
        faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—',
      },
    };
  }

  // Public payslip authenticity check (no login) — confirms a payslip presented to a
  // bank/landlord is genuine: who it's for, the period, and the NET pay.
  function verifyPayslip(idOrRef) {
    const key = String(idOrRef || '').trim();
    if (!key) return { valid: false };
    let ps = one('payslips', key);
    if (!ps) { const want = key.replace(/-/g, '').toLowerCase(); if (want.length >= 6 && want.length <= 16) ps = all('payslips').find(x => String(x.id).replace(/-/g, '').toLowerCase().startsWith(want)); }
    if (!ps || ps.deleted) return { valid: false };
    const st = one('staff', ps.staff_id) || {};
    const run = one('payroll_runs', ps.run_id) || {};
    const cur = ps.currency || st.currency;
    const isLect = st.staff_type === 'lecturer';
    return {
      valid: true, kind: 'payslip',
      ref: String(ps.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      staffType: isLect ? 'Lecturer' : 'Staff',
      net: money(ps.net, cur), gross: money(ps.gross, cur),
      period: run.period || '—', dateText: fmtDate(run.updated_at || run.created_at),
      staff: { name: st.full_name || 'Unknown', staffNo: st.staff_no || '—', photo: st.photo || '', department: st.department || st.faculty || '—' },
    };
  }

  // Public result authenticity check (no login) — confirms a statement of result is genuine:
  // the student, level and the GPA/CGPA. Key is the student id, optionally "id|session|semester".
  function verifyResult(idOrRef) {
    let key = String(idOrRef || '').trim(); let ses = '', sem = '';
    if (key.indexOf('|') >= 0) { const a = key.split('|'); key = a[0]; ses = a[1] || ''; sem = a[2] || ''; }
    const s = one('students', key);
    if (!s || s.deleted) return { valid: false };
    const sc = scoresFor(s.id);
    if (!sc.courses || !sc.courses.length) return { valid: false };
    let gpa = sc.cgpa, cgpa = sc.cgpa, units = sc.totalUnits, courses = sc.courses.length, sesName = '', semName = '';
    if (ses || sem) { const g = (sc.semesters || []).find(x => (!ses || x.session_id === ses) && (!sem || x.semester_id === sem)); if (g) { gpa = g.gpa; cgpa = g.cgpa; units = g.units; courses = g.courses.length; sesName = g.session || ''; semName = g.semester || ''; } }
    const stand = (x) => { x = Number(x) || 0; return x >= 4.5 ? 'First Class' : x >= 3.5 ? 'Second Class (Upper)' : x >= 2.4 ? 'Second Class (Lower)' : x >= 1.5 ? 'Third Class' : x >= 1 ? 'Pass' : '—'; };
    // graduation authenticity — an alumni record makes this an authentic CERTIFICATE/graduate check,
    // carrying the official class of degree + graduation session from the released finalist batch.
    const al = all('alumni').find(a => a.student_id === s.id && !a.deleted);
    return {
      valid: true, kind: 'result', ref: String(s.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      session: sesName, semester: semName, gpa: gpa, cgpa: cgpa, totalUnits: units, courses: courses, standing: stand(cgpa),
      graduated: !!al || String(s.status || '').toLowerCase() === 'alumni',
      classification: (al && al.classification) || (al ? stand(cgpa) : ''),
      graduationSession: al ? (nameOf('academic_sessions', al.graduation_session) || '') : '',
      student: { name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown', matric: s.matric_no || '—', photo: s.photo || '', faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—', level: nameOf('levels', s.level_id) || '—', gender: s.gender || '—', status: s.status || 'active' },
    };
  }

  // ---- 🔎 external credential verification (university / government / employer) ----
  // A DD/MM/YYYY DOB formatted from its parts (never `new Date`, which would shift the day by a zone).
  function dobText(v) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : (v || '—'); }
  function classOf(cgpa) { const x = Number(cgpa) || 0; return x >= 4.5 ? 'First Class' : x >= 3.5 ? 'Second Class (Upper Division)' : x >= 2.4 ? 'Second Class (Lower Division)' : x >= 1.5 ? 'Third Class' : x >= 1 ? 'Pass' : '—'; }
  /** The institution's public contact block (shown when a matric can't be verified → manual route). */
  function instContact() {
    const i = inst();
    return { name: i.name || 'the University', email: i.email || '', phone: i.phone || '', address: i.address || '', website: i.website || (i.portal_url || '') };
  }
  /** Matric normaliser: verifiers type matrics with spaces, dots, dashes or different separators
   *  ("021 / 0205 / 004", "021-0205-004") — compare on the alphanumeric skeleton so a valid matric
   *  is never rejected over formatting. */
  function normMatric(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  /**
   * Find a student by matric number across the ENTIRE student body — active students AND alumni
   * (graduates keep their students row with status='alumni'; nothing here filters on status).
   * Match order: exact (case-insensitive) → normalised skeleton → raw id. The alumni table is also
   * walked as a safety net for any legacy record whose student row lost its matric.
   */
  function findStudentByMatric(key) {
    const k = String(key || '').trim(); if (!k) return null;
    const kl = k.toLowerCase(); const kn = normMatric(k);
    const rows = all('students');
    let s = rows.find(x => String(x.matric_no || '').toLowerCase() === kl)
      || (kn ? rows.find(x => normMatric(x.matric_no) === kn) : null)
      || one('students', k);
    if (s && !s.deleted) return s;
    // legacy safety net: an alumni row whose linked student still matches by id/matric skeleton
    const al = all('alumni').find(a => normMatric(a.matric_no) === kn || a.student_id === k);
    if (al) { const st = one('students', al.student_id); if (st && !st.deleted) return st; }
    return null;
  }
  /** The credential documents an external verifier may request. Each maps to the auto_kind(s) the
   *  publish pipeline stores (first match wins), so the list grows with the document suite. */
  const CREDENTIAL_DOCS = [
    { key: 'transcript', label: 'Academic Transcript', kinds: ['transcript_copy', 'transcript'], gradOnly: false },
    { key: 'certificate', label: 'Degree Certificate', kinds: ['certificate_copy', 'certificate'], gradOnly: true },
    { key: 'recommendation', label: 'Letter of Recommendation', kinds: ['recommendation'], gradOnly: false },
    { key: 'english_proficiency', label: 'English Proficiency Letter', kinds: ['english_proficiency'], gradOnly: false },
    { key: 'accreditation_status', label: 'Accreditation Status Confirmation', kinds: ['accreditation_status'], gradOnly: false },
    { key: 'programme_accreditation', label: 'Accredited Programme Confirmation', kinds: ['programme_accreditation'], gradOnly: false },
  ];
  // ---- 🔐 document authenticity (tamper-evidence) --------------------------------------------
  /** SHA-256 of a buffer/string → lowercase hex. */
  function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
  /** A stable, public verification CODE for an issued document (safe to print on the document and to
   *  show a verifier) derived from its internal id — never reveals the id itself. */
  function docCode(id) { return 'UB-' + sha256Hex('doccode:' + String(id)).slice(0, 10).toUpperCase(); }
  /** Group a hex fingerprint into readable quads: "A1B2C3D4E5F60718" → "A1B2 C3D4 E5F6 0718". */
  function groupFp(hex) { return String(hex || '').replace(/(.{4})(?=.)/g, '$1 '); }
  /** Normalise a verification code a human typed or read off paper. They arrive as "ub 1a2b3c4d5e",
   *  "UB-1A2B-3C4D-5E", "1a2b3c4d5e" — compare on the bare hex so a valid code is never rejected over
   *  formatting (the same tolerance normMatric() gives matric numbers). '' when it isn't a code shape. */
  function normCode(v) {
    const s = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^UB/, '');
    return /^[0-9A-F]{10}$/.test(s) ? 'UB-' + s : '';
  }
  function isCredentialKind(k) { return CREDENTIAL_DOCS.some(s => s.kinds.includes(String(k || ''))); }
  /** Every issued credential document row — the universe a code/file lookup searches. */
  function credentialDocs() { return all('portal_documents').filter(x => !x.deleted && isCredentialKind(x.auto_kind)); }
  /** code → document row, so a verifier can verify straight from the code PRINTED ON the document without
   *  knowing the matric number at all. Cheap (docCode hashes the id — no bytes fetched) but O(rows), so the
   *  index is memoised briefly rather than rebuilt per request. */
  let _codeIx = null, _codeIxAt = 0;
  function docByCode(code) {
    const c = normCode(code); if (!c) return null;
    if (!_codeIx || (Date.now() - _codeIxAt) > 60000) {
      _codeIx = new Map(); _codeIxAt = Date.now();
      for (const d of credentialDocs()) _codeIx.set(docCode(d.id), d);
    }
    return _codeIx.get(c) || null;
  }
  // An ISSUED document is immutable — a re-issue writes a NEW row rather than rewriting these bytes — so a
  // fingerprint, once computed, can be cached for the life of the process. This is what keeps the registry-
  // wide file lookup below affordable: only the first pass pays the blob fetches.
  const _fpMemo = new Map();                       // docId -> sha256 hex
  /** The SHA-256 fingerprint of an issued document's actual bytes (file inline or in blob storage),
   *  or '' when the bytes aren't retrievable. This is what makes a forged/altered copy detectable:
   *  the same document always hashes to the same value; a single changed grade changes the hash. */
  async function fingerprintOfDoc(docId) {
    if (_fpMemo.has(docId)) return _fpMemo.get(docId);
    const d = one('portal_documents', docId); if (!d || d.deleted) return '';
    let fp = '';
    if (d.file) { try { fp = sha256Hex(Buffer.from(String(d.file), 'base64')); } catch (_) { fp = ''; } }
    else if (d.file_key) { const buf = await blobFetchLocal(d.file_key); if (buf) fp = sha256Hex(buf); }
    // only a SUCCESSFUL hash is cached — a blob fetch that failed transiently must be retried, not
    // remembered as "this document has no bytes".
    if (fp) { if (_fpMemo.size > 4000) _fpMemo.clear(); _fpMemo.set(docId, fp); }
    return fp;
  }
  /** Find the issued document whose bytes hash to `hash`, across the WHOLE registry. This is what lets a
   *  verifier drop in a PDF with NO matric number and be told whose credential it is — or that it matches
   *  nothing the institution ever issued. Newest-first so a re-issued document identifies as the current one. */
  async function docByHash(hash) {
    if (!hash) return null;
    const rows = credentialDocs().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    for (const d of rows) { if (await fingerprintOfDoc(d.id) === hash) return d; }
    return null;
  }
  /** The newer row that has REPLACED `d`, if the registry has since re-issued that credential. A verifier
   *  holding a superseded transcript holds a genuine-but-outdated document — materially different from a
   *  forgery, and reporting the two the same way would be wrong in both directions. */
  function supersededBy(d) {
    if (!d) return null;
    return all('portal_documents')
      .filter(x => !x.deleted && x.student_id === d.student_id && x.auto_kind === d.auto_kind && String(x.created_at || '') > String(d.created_at || ''))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
  }
  /** The label CREDENTIAL_DOCS gives an auto_kind ('transcript_copy' → 'Academic Transcript'). */
  function labelOfKind(k) { const s = CREDENTIAL_DOCS.find(x => x.kinds.includes(String(k || ''))); return s ? s.label : 'Official Document'; }
  // ---- 🫥 invisible document seal --------------------------------------------------------------
  // Every PDF the registry issues carries a hidden `%UBSEAL1 <keyid>.<payload>.<hmac>` trailer line
  // (written by electron/services/docseal.js): invisible in every viewer, but readable here. The HMAC
  // key is the SAME stable portal secret this desk already runs on, so a seal validates online with
  // no database lookup — and then binds to the registry row for the identity report. This is what
  // lets an ALTERED copy of a genuine document be recognised as exactly that (its bytes no longer
  // match any issued file, but its seal still proves what it started life as).
  function sealOfBuffer(buf) {
    try {
      const tail = buf.slice(Math.max(0, buf.length - 4096)).toString('latin1');
      const m = /%UBSEAL1 ([0-9a-f]{8})\.([A-Za-z0-9_-]+)\.([0-9a-f]{64})/.exec(tail);
      if (!m) return { present: false };
      const key = String(secret || '');
      const keyId = crypto.createHash('sha256').update('ubseal|' + key).digest('hex').slice(0, 8);
      if (m[1] !== keyId) return { present: true, valid: false, reason: 'foreign-key' };
      if (crypto.createHmac('sha256', key).update(m[2]).digest('hex') !== m[3]) return { present: true, valid: false, reason: 'signature' };
      const p = JSON.parse(Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      return { present: true, valid: true, docId: p.d || '', studentId: p.s || '', kind: p.k || '', issuedAt: p.t || '' };
    } catch (_) { return { present: false }; }
  }
  /** Fill each available document with its content fingerprint (awaits blob fetches); strips the
   *  internal id afterwards. Mutates + returns the verification record. */
  async function enrichFingerprints(v) {
    if (!v || !v.valid || !Array.isArray(v.documents)) return v;
    for (const d of v.documents) {
      if (d._docId) { const fp = await fingerprintOfDoc(d._docId); d.fingerprint = fp ? groupFp(fp.slice(0, 16).toUpperCase()) : ''; }
      delete d._docId;
    }
    return v;
  }

  /**
   * Look up a student by matric and return everything an external verifier legitimately needs to
   * confirm a transcript/certificate: identity, programme, entry & graduation years, CGPA + class,
   * whether the student has actually GRADUATED (an active-but-not-graduated student is reported
   * as such, never as a graduate), and which issued documents are available — each with its issue
   * date, a public verification CODE and (after enrichFingerprints) a tamper-evident fingerprint.
   * Returns { valid:false } when the matric matches no record.
   */
  /**
   * Resolve whatever the verifier typed to a student. They hold a DOCUMENT, not necessarily a matric
   * number — so a verification code printed on that document identifies the record just as well, and is
   * the stronger signal of the two (it proves possession of an issued credential rather than a guess at
   * an id). Matric first (the common case), then code.
   * → { student, viaDoc } — viaDoc is the document row when a code resolved the lookup.
   */
  function resolveSubject(key) {
    const s = findStudentByMatric(key);
    if (s) return { student: s, viaDoc: null };
    const d = docByCode(key);
    if (d) { const st = one('students', d.student_id); if (st && !st.deleted) return { student: st, viaDoc: d }; }
    return { student: null, viaDoc: null };
  }
  function verifyCredentials(matric) {
    const { student: s, viaDoc } = resolveSubject(matric);
    if (!s) return { valid: false };
    const sc = scoresFor(s.id);
    const al = all('alumni').find(a => a.student_id === s.id && !a.deleted);
    const graduated = !!al || ['alumni', 'graduated'].includes(String(s.status || '').toLowerCase());
    const fullName = [s.first_name, s.middle_name, s.last_name].map(x => String(x || '').trim()).filter(Boolean).join(' ') || 'Unknown';
    // Academic summary: the LIVE released scores when they're on the store, else the FINAL summary
    // stamped on the alumni row at graduation/publication (bulk-imported alumni and paper-issued
    // records have no per-course rows here — reporting them as "CGPA 0.00" was simply wrong).
    let cgpa = Number(sc.cgpa) || 0, units = sc.totalUnits || 0, courses = (sc.courses || []).length, recordSource = 'live';
    if (!units && al && Number(al.cgpa) > 0) {
      cgpa = Number(al.cgpa); units = Number(al.total_units) || 0; courses = Number(al.courses) || 0; recordSource = 'registry';
    }
    const hasRecord = units > 0 || cgpa > 0;
    // the most recent issued row of a given credential (for its code + issue date + fingerprint)
    const docRowOf = (spec) => {
      for (const k of spec.kinds) {
        const rows = all('portal_documents').filter(x => !x.deleted && x.student_id === s.id && x.auto_kind === k)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        if (rows[0]) return rows[0];
      }
      return null;
    };
    /** How many times this credential has been issued for the student — >1 means every copy but the
     *  newest is superseded, which a verifier holding an older printout needs to be told. */
    const issueCountOf = (spec) => all('portal_documents')
      .filter(x => !x.deleted && x.student_id === s.id && spec.kinds.includes(x.auto_kind)).length;
    const documents = CREDENTIAL_DOCS.map(spec => {
      const row = (!spec.gradOnly || graduated) ? docRowOf(spec) : null;
      const issues = row ? issueCountOf(spec) : 0;
      return {
        key: spec.key, label: spec.label, available: !!row,
        code: row ? docCode(row.id) : '',
        issuedAt: row ? row.created_at : '',
        office: row ? (row.office || 'Office of the Registrar') : '',
        issues,                               // 1 = issued once; >1 = re-issued, older copies are superseded
        reissued: issues > 1,
        _docId: row ? row.id : '',            // internal — enrichFingerprints() strips this before responding
      };
    });
    return {
      valid: true, graduated,
      ref: String(s.id).replace(/-/g, '').slice(0, 10).toUpperCase(),
      verifiedAt: new Date().toISOString(),
      // how the record was found: 'code' proves the verifier holds an issued document, 'matric' is a
      // lookup by identifier. The report says which — they are not equally strong evidence.
      matchedBy: viaDoc ? 'code' : 'matric',
      matchedDocument: viaDoc ? { label: labelOfKind(viaDoc.auto_kind), code: docCode(viaDoc.id), issuedAt: viaDoc.created_at || '' } : null,
      institution: (() => { const i = inst(); return { name: i.name || '', short: i.short || '', logo: i.logo || '' }; })(),
      student: {
        name: fullName, matric: s.matric_no || '—', photo: s.photo || '',
        dob: dobText(s.date_of_birth), gender: s.gender || '—', nationality: s.nationality || '—',
        email: '', // identity only — never leak the student's private contacts to a verifier
        faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—',
        level: nameOf('levels', s.level_id) || '—', status: graduated ? 'alumni' : (s.status || 'active'),
        programme: nameOf('departments', s.department_id) || '—',
        campus: nameOf('campuses', s.campus_id) || '',
      },
      entryYear: nameOf('academic_sessions', s.entry_session_id) || '—',
      gradYear: (al && nameOf('academic_sessions', al.graduation_session)) || (graduated ? '—' : ''),
      // hasRecord=false → the metrics are UNKNOWN here (Registry holds the detail) — never "0.00"
      hasRecord, recordSource,
      cgpa: hasRecord ? cgpa.toFixed(2) : null,
      totalUnits: hasRecord ? units : null,
      courses: hasRecord ? courses : null,
      classification: (al && al.classification) || (graduated && hasRecord ? classOf(cgpa) : ''),
      standing: hasRecord ? classOf(cgpa) : '',
      documents,
      hasTranscript: documents.find(d => d.key === 'transcript').available,
      hasCertificate: documents.find(d => d.key === 'certificate').available,
      _sid: s.id,
    };
  }
  /** Record a verification request (synced back to the registry). Best-effort. */
  function logVerification(body, result) {
    try {
      const now = new Date().toISOString();
      create('verification_requests', {
        id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('vr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
        verifier_type: String((body && body.verifierType) || 'other').slice(0, 40),
        verifier_name: String((body && body.name) || '').slice(0, 120),
        verifier_email: String((body && body.email) || '').slice(0, 160),
        matric: String((body && body.matric) || '').slice(0, 60),
        student_id: (result && result._sid) || null,
        found: result && result.valid ? 1 : 0, emailed: 0,
        // audit trail: the verifier's stated purpose + consent attestation + how they verified
        note: [
          (body && body.purpose) ? ('purpose: ' + String(body.purpose).slice(0, 80)) : '',
          (body && body.consent) ? 'consent: attested' : '',
          (body && body.channel) ? ('via: ' + String(body.channel).slice(0, 24)) : '',
        ].filter(Boolean).join(' · ').slice(0, 220),
        created_at: now, updated_at: now, deleted: 0, origin_node: 'portal',
      });
    } catch (_) { /* logging is best-effort */ }
  }
  /** The registrar's sending identity: the documents go out AS the Office of the Registrar — the
   *  registrar user's email is the reply-to, and the relay is asked to send through the registrar's
   *  own configured mailbox (senderRole) when one exists, falling back to the institution's SMTP. */
  function registrarSender() {
    const u = all('users').find(x => !x.deleted && x.role === 'registrar' && x.email) || null;
    const i = inst();
    return {
      email: (u && u.email) || i.email || '',
      userId: u ? u.id : null,
      name: `Office of the Registrar${i.name ? ' — ' + i.name : ''}`,
    };
  }
  /** E-mail the requested STUDENT COPY documents to the verifier as attachments.
   *  `docKeys` = CREDENTIAL_DOCS keys the verifier ticked; omitted/empty → every available one. */
  async function emailCredentialCopies(matric, to, name, docKeys) {
    const v = verifyCredentials(matric);
    if (!v.valid) return { ok: false, error: 'not-found' };
    const wanted = Array.isArray(docKeys) && docKeys.length ? docKeys.map(String) : null;
    const atts = []; const sentLabels = [];
    const safe = String(v.student.matric || 'student').replace(/[^a-z0-9]+/gi, '-');
    for (const spec of CREDENTIAL_DOCS) {
      if (wanted && !wanted.includes(spec.key)) continue;
      if (spec.gradOnly && !v.graduated) continue;
      for (const k of spec.kinds) {
        const d = all('portal_documents').find(x => !x.deleted && x.student_id === v._sid && x.auto_kind === k);
        if (!d) continue;
        let b64 = d.file;
        if (!b64 && d.file_key) { const buf = await blobFetchLocal(d.file_key); if (buf) b64 = buf.toString('base64'); }
        if (b64) { atts.push({ filename: `${spec.label.replace(/[^a-z0-9]+/gi, '-')}-${safe}.pdf`, contentBase64: b64 }); sentLabels.push(spec.label); break; }
      }
    }
    if (!atts.length) return { ok: false, error: 'no-documents' };
    const i = inst();
    const from = registrarSender();
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
      <p>Dear ${esc(name || 'Verifier')},</p>
      <p>Attached ${atts.length > 1 ? 'are the following documents' : 'is the following document'} for
      <b>${esc(v.student.name)}</b> (Matric ${esc(v.student.matric)}), released by the Office of the Registrar, ${esc(i.name || 'the University')}, for verification purposes:</p>
      <ul>${sentLabels.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      <p>Student-copy documents carry a “STUDENT COPY” watermark. For a certified original, please contact the Registry${from.email ? ` at ${esc(from.email)}` : ''}.</p>
      <p style="color:#64748b;font-size:12.5px">Verification reference ${esc(v.ref)} · ${esc(i.name || '')}${from.email ? ' · ' + esc(from.email) : ''}</p></div>`;
    let sent = false;
    try {
      const r = await Promise.resolve(sendMail({
        to, subject: `Academic credentials — ${v.student.name} (${v.student.matric})`, html, attachments: atts,
        fromName: from.name, replyTo: from.email, senderRole: 'registrar', senderUserId: from.userId,
      }));
      sent = !!(r && r.ok !== false);
    } catch (_) { sent = false; }
    return { ok: sent, attached: atts.length, labels: sentLabels };
  }
  /** blobFetch alias resolved to the injected helper (server + edge both provide it). */
  async function blobFetchLocal(key) { try { return (typeof blobFetch === 'function') ? await blobFetch(key) : null; } catch (_) { return null; } }

  // ---- documents (printable HTML) ----
  function inst() { return institution ? institution() : { name: 'UniBursar', short: 'UBU', logo: '', motto: '' }; }

  // ---------------------------------------------------------------------------------------------
  // CRYPTOGRAPHIC LICENSE ENFORCEMENT (v2) — the desktop pushes SIGNED licensing artifacts (a "site"
  // standing token + the latest heartbeat verdict, both Ed25519-signed by the vendor) and the portal
  // verifies them itself with the embedded vendor PUBLIC keys. A modified hub/server can no longer
  // fake `licensed:true`: without a genuine signed token the portal locks. The portal ALSO
  // self-validates directly against the vendor's enforcement server (fingerprint "portal:<lid>",
  // which never counts toward the university's install cap) so a revocation reaches the portal even
  // when the university's desktop is switched off. The license KEY itself never reaches this server.
  // ---------------------------------------------------------------------------------------------
  const LIC_MASTER_KEY_B64 = 'MCowBQYDK2VwAyEAbqdQ6677mlegHcgtxZpsm9fkoD9Rgu4dthaz9Y5A1bk=';
  const LIC_ENFORCE_KEY_B64 = '';   // optional dedicated online-verdict key ('' = master signs verdicts)
  const LIC_GRACE_DAYS = 14;
  let licKeys = null;
  function licKeyring() {
    if (licKeys) return licKeys;
    licKeys = [];
    for (const b64 of [LIC_MASTER_KEY_B64, LIC_ENFORCE_KEY_B64]) {
      if (!b64) continue;
      try { licKeys.push(crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })); } catch (_) {}
    }
    return licKeys;
  }
  /** Verify a vendor-signed `body.sig` token → {valid, payload}. Never throws. */
  function licVerify(token) {
    try {
      const clean = String(token || '').replace(/\s+/g, '');
      const dot = clean.indexOf('.');
      if (dot < 1) return { valid: false };
      const body = clean.slice(0, dot);
      const sig = Buffer.from(clean.slice(dot + 1).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const ok = licKeyring().some(k => { try { return crypto.verify(null, Buffer.from(body), k, sig); } catch (_) { return false; } });
      if (!ok) return { valid: false };
      return { valid: true, payload: JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) };
    } catch (_) { return { valid: false }; }
  }
  // CAPABILITY PROBE — the cloud edge runs on Deno, whose node:crypto compat MAY NOT implement the
  // one-shot Ed25519 `crypto.verify` we rely on. We test the PRIMITIVE with the fixed, KEY-INDEPENDENT
  // RFC 8032 §7.1 test vector (NOT a vendor-signed token — so rotating the vendor key never breaks this
  // probe). If it does NOT verify, the runtime can't do Ed25519, so we must NOT lock anyone on a token we
  // can't check (that would wrongly lock a paying customer on the cloud portal); we fall back to the
  // desktop-computed boolean — which the desktop derives from the SAME signed verdicts, and where the
  // self-hosted (Node) hub, the actual mod target, verifies cryptographically. Memoised once.
  const LIC_PROBE_SPKI = 'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';
  const LIC_PROBE_SIG = '5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc+bRr0lv18FlbviRlUUFDjnoQCw==';
  let _licCrypto;
  function licCryptoOk() {
    if (_licCrypto !== undefined) return _licCrypto;
    try {
      const k = crypto.createPublicKey({ key: Buffer.from(LIC_PROBE_SPKI, 'base64'), format: 'der', type: 'spki' });
      _licCrypto = crypto.verify(null, Buffer.from(''), k, Buffer.from(LIC_PROBE_SIG, 'base64')) === true;
    } catch (_) { _licCrypto = false; }
    return _licCrypto;
  }
  // portal self-heartbeat — refreshed at most every 6h (10 min after a failure), non-blocking
  const licSelf = { token: '', at: 0, triedAt: 0 };
  function licSelfRefresh(i) {
    try {
      const enf = String(i.license_enf || '').replace(/\/+$/, ''), lid = String(i.license_lid || '');
      if (!enf || !lid || typeof fetch !== 'function') return;
      const now = Date.now();
      const wait = licSelf.token && now - licSelf.at < 6 * 3600000;
      if (wait || now - licSelf.triedAt < 10 * 60 * 1000) return;
      licSelf.triedAt = now;
      fetch(enf + '/heartbeat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lid, inst: i.name || '', fingerprint: 'portal:' + lid, version: 2, plat: 'portal' }),
      }).then(r => r.json()).then(j => {
        if (j && j.token && licVerify(j.token).valid) { licSelf.token = j.token; licSelf.at = Date.now(); }
      }).catch(() => {});
    } catch (_) {}
  }
  /** The portal's own licensed verdict: the FRESHEST valid signed artifact wins; only installs that
   *  never pushed any artifact (legacy/offline-only) fall back to the plain boolean. */
  function licenseState() {
    const i = inst();
    const lid = String(i.license_lid || '');
    const now = Date.now();
    // If this runtime can't verify Ed25519 (some Deno edge builds), we cannot safely judge a signed
    // token — trust the desktop-computed boolean instead of risking a wrong lock. The signed-token path
    // still fully protects the self-hosted Node hub (the real mod target), where verify works.
    if (!licCryptoOk()) {
      return { licensed: (typeof i.licensed === 'boolean') ? i.licensed : true, status: 'boolean', token: '', lid };
    }
    licSelfRefresh(i);
    const verdicts = [];
    for (const [src, tok] of [['self', licSelf.token], ['site', i.license_site], ['hb', i.license_hb]]) {
      if (!tok) continue;
      const v = licVerify(tok);
      if (!v.valid || !v.payload) continue;
      const p = v.payload;
      if (p.t !== 'hb' && p.t !== 'site') continue;
      if (lid && p.lid && p.lid !== lid) continue;
      const issued = p.issued ? Date.parse(p.issued) : 0;
      // freshness: site tokens live until their exp; heartbeat verdicts count for the grace window
      if (p.t === 'site' && p.exp && now > Date.parse(p.exp)) continue;
      if (p.t === 'hb' && issued && now - issued > LIC_GRACE_DAYS * 86400000) continue;
      verdicts.push({ src, status: String(p.status || 'unknown'), issued: issued || 0, token: tok });
    }
    if (verdicts.length) {
      verdicts.sort((a, b) => b.issued - a.issued);
      const top = verdicts[0];
      const licensed = top.status === 'active';
      return { licensed, status: top.status, token: top.token, lid };
    }
    // artifacts expected (online-enforced customer) but none valid/fresh → locked
    if (i.license_enf || i.license_site || i.license_hb) return { licensed: false, status: 'unverified', token: '', lid };
    // legacy / offline-only install → the desktop-pushed boolean (default true for older hubs)
    return { licensed: (typeof i.licensed === 'boolean') ? i.licensed : true, status: 'legacy', token: '', lid };
  }
  function licenseOk() { try { return licenseState().licensed; } catch (_) { return true; } }
  function docShell(title, body, watermark, opts) {
    const i = inst();
    const fit = opts && opts.fit ? 'true' : 'false';
    const wm = watermark ? `<div class="wm"><span>${esc(watermark)}</span></div>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;margin:0;padding:24px;font-size:13px;background:#f1f5f9;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .sheet{position:relative;overflow:hidden;max-width:820px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:26px;box-shadow:0 8px 30px rgba(15,23,42,.08)}
    .wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:6}
    .wm span{font-size:62px;font-weight:900;color:rgba(30,58,138,.12);transform:rotate(-28deg);letter-spacing:9px;white-space:nowrap;border:7px solid rgba(30,58,138,.12);padding:12px 34px;border-radius:14px}
    .head{display:flex;align-items:center;gap:12px;border-bottom:3px solid #1e3a8a;padding-bottom:14px;margin-bottom:18px}
    .head .logo{width:50px;height:50px;object-fit:contain;border-radius:8px}
    .head .mono{width:50px;height:50px;border-radius:10px;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800}
    .head h1{margin:0;font-size:18px;color:#111827}.head .t{margin-left:auto;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#1e3a8a}
    table{width:100%;border-collapse:collapse;margin:10px 0}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef2f7}
    th{background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#64748b}
    .r{text-align:right}.bar{background:#1e3a8a;color:#fff;padding:6px 12px;border-radius:6px;font-weight:700;text-transform:uppercase;font-size:11px;margin:16px 0 6px}
    .tot{font-size:16px;font-weight:800;color:#065f46;text-align:right;margin-top:6px}.words{font-style:italic;font-weight:700}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px}.grid .f span{color:#64748b;font-size:11px;display:block}.grid .f b{font-size:13px}
    .pbar{margin:16px 0;text-align:center}.pbar button{background:#1e3a8a;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer}
    @media print{.pbar{display:none}body{background:#fff;padding:0}.sheet{box-shadow:none;border:0}}
    .neg{color:#b91c1c}.pos{color:#065f46}.photo{width:84px;height:96px;object-fit:cover;border:1.5px solid #1e3a8a;border-radius:6px;float:right}</style></head>
    <body><div class="pbar"><button onclick="window.print()">⬇️ Download PDF / Print</button></div>
    <div class="sheet">${wm}<div class="head">${i.logo ? `<img class="logo" src="${i.logo}">` : `<div class="mono">${esc((i.short || 'U').slice(0, 3))}</div>`}<h1>${esc(i.name)}</h1><div class="t">${esc(title)}</div></div>${body}</div>
    <script>(function(){var FIT=${fit};function fit(){if(!FIT)return;var sh=document.querySelector('.sheet');if(!sh)return;sh.style.zoom='';var maxH=1040;var hgt=sh.scrollHeight;if(hgt>maxH){sh.style.zoom=Math.max(0.35,(maxH/hgt));}}var done=false;function go(){if(done)return;done=true;fit();try{window.focus();window.print();}catch(e){}}window.addEventListener('load',function(){setTimeout(go,450);});window.addEventListener('beforeprint',fit);window.addEventListener('resize',fit);})();</script>
    </body></html>`;
  }

  function receiptHTML(p) {
    const s = one('students', p.student_id) || {};
    const cur = p.currency;
    const issuer = one('users', p.decided_by) || one('users', p.raised_by) || {};
    // issuing office = who COMPLETED it (decided_by) — a registrar-raised, accountant-verified
    // payment is issued by the Bursar, not the registrar.
    const office = officeOf(issuer.role || p.raised_role, issuer.department_id || s.department_id);
    const receivedBy = issuer.full_name || office;
    // the line DESCRIPTION is the FEE paid for (category), NOT the narration
    const catRow = all('fee_categories').find(c => c.key === p.category && !c.deleted);
    const feeLabel = (catRow && catRow.name) || (p.category ? p.category[0].toUpperCase() + p.category.slice(1).replace(/_/g, ' ') + ' Fee' : 'Fee');
    // scannable verification QR → opens this hub's /verify page (same as the desktop receipt)
    const verifyUrl = (docBase ? docBase : '') + '/verify?r=' + p.id;
    const qrSvg = verifyQrSvg(verifyUrl);
    // SCOPE to the issuing office (mirrors the desktop): admin/accountant = full account;
    // any other office's receipt reflects only that office's fees/collections.
    const officeRole = ['admin', 'accountant'].includes(p.raised_role) ? null : p.raised_role;
    const officeUsers = officeRole ? new Set(all('users').filter(u => u.role === officeRole).map(u => u.id)) : null;
    const myCharge = (c) => !officeUsers || officeUsers.has(c.created_by);
    const myPay = (x) => !officeRole || x.raised_role === officeRole || (officeUsers && (officeUsers.has(x.raised_by) || officeUsers.has(x.decided_by)));
    const billedCat = studentCharges(p.student_id).filter(c => c.category === p.category && c.currency === cur && myCharge(c)).reduce((a, c) => a + c.amount, 0);
    const paidCat = studentPaymentsCompleted(p.student_id).filter(x => x.category === p.category && x.currency === cur && myPay(x)).reduce((a, x) => a + x.amount, 0);
    const lineRate = billedCat > 0 ? billedCat : p.amount;
    const chargesCur = studentCharges(p.student_id).filter(c => c.currency === cur && myCharge(c)).reduce((a, c) => a + c.amount, 0);
    const paidCur = studentPaymentsCompleted(p.student_id).filter(x => x.currency === cur && myPay(x)).reduce((a, x) => a + x.amount, 0);
    const newBal = chargesCur - paidCur; const prevBal = newBal + p.amount;
    const f = (l1, v1, l2, v2) => `<tr><td style="color:#64748b">${l1}</td><td><b>${esc(v1 || '—')}</b></td><td style="color:#64748b">${l2}</td><td><b>${esc(v2 || '—')}</b></td></tr>`;
    const body = `${s.photo ? `<img class="photo" src="${s.photo}">` : ''}
      <div class="grid" style="margin-bottom:8px"><div class="f"><span>Receipt No</span><b>${esc(p.receipt_no || '—')}</b></div><div class="f"><span>Issued By</span><b>${esc(office)}</b></div>
        <div class="f"><span>Date</span><b>${fmtDate(p.decided_at || p.created_at)}</b></div><div class="f"><span>Method</span><b>${esc(String(p.channel || p.method || 'cash').toUpperCase())}</b></div></div>
      <div class="bar">Student Details</div>
      <table><tbody>
        ${f("Student", `${s.first_name || ''} ${s.last_name || ''}`, 'Matric No', s.matric_no)}
        ${f('Faculty', nameOf('faculties', s.faculty_id), 'Department', nameOf('departments', s.department_id))}
        ${f('Level', nameOf('levels', s.level_id), 'Received By', receivedBy)}
      </tbody></table>
      <div class="bar">Payment Details</div>
      <table><tbody>${f('Narration', p.narration || '—', 'Currency', cur)}</tbody></table>
      <div class="bar">Payment Breakdown</div>
      <table><thead><tr><th>Description</th><th class="r">Amount (${esc(cur)})</th><th class="r">Paid Now</th><th class="r">Balance After</th></tr></thead>
        <tbody><tr><td>${esc(feeLabel)}</td><td class="r">${money(lineRate, cur)}</td><td class="r"><b>${money(p.amount, cur)}</b></td><td class="r">${money(lineRate - paidCat, cur)}</td></tr></tbody></table>
      <div class="tot">TOTAL PAID: ${money(p.amount, cur)}</div>
      <div class="bar">Payment Summary</div>
      <table><tbody>
        <tr><td style="color:#64748b">Amount In Words</td><td class="words" colspan="3">${esc(amountWords(p.amount, cur))}</td></tr>
        ${f('Previous Net Balance', money(prevBal, cur), 'New Net Balance', money(newBal, cur))}
      </tbody></table>
      <div class="bar">Authenticity</div>
      <div style="display:flex;align-items:center;gap:14px;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 14px;margin-top:8px">
        ${qrSvg ? `<div style="width:104px;height:104px;flex:none">${qrSvg}</div>` : ''}
        <div style="font-size:11.5px;color:#475569;line-height:1.5">Scan to verify this receipt is genuine.<br>Verification ref <b style="letter-spacing:1px;color:#111827">${esc(String(p.id).replace(/-/g, '').slice(0, 8).toUpperCase())}</b><br>or visit <a href="${esc(verifyUrl)}">${esc((docBase || '') + '/verify')}</a></div>
      </div>
      <p style="margin-top:18px;color:#64748b;font-size:11px">Received by ${esc(receivedBy)} (${esc(office)}) • Student copy of a computer-generated receipt; it mirrors the official receipt issued in the office. Anyone can confirm it is genuine by scanning the QR above.</p>`;
    return docShell('Payment Receipt', body, 'STUDENT COPY');
  }

  function statementHTML(s) {
    const charges = studentCharges(s.id).map(c => ({ kind: 'charge', date: c.created_at, desc: c.description || c.category, currency: c.currency, debit: c.amount < 0 ? 0 : c.amount, credit: c.amount < 0 ? -c.amount : 0 }));
    const pays = studentPaymentsCompleted(s.id).map(p => ({ kind: 'payment', date: p.decided_at || p.created_at, desc: (p.description || p.category) + (p.receipt_no ? ` (${p.receipt_no})` : ''), currency: p.currency, debit: 0, credit: p.amount }));
    const entries = [...charges, ...pays].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const running = {}; const rows = entries.map(e => { running[e.currency] = (running[e.currency] || 0) + (e.debit - e.credit); return `<tr><td>${fmtDate(e.date)}</td><td>${e.kind === 'payment' ? '💰 ' : '📌 '}${esc(e.desc)}</td><td class="r">${e.debit ? money(e.debit, e.currency) : ''}</td><td class="r">${e.credit ? money(e.credit, e.currency) : ''}</td><td class="r ${running[e.currency] > 0 ? 'neg' : 'pos'}">${money(running[e.currency], e.currency)}</td></tr>`; }).join('');
    const bal = balancesFor(s.id); const balStr = Object.keys(bal).length ? Object.entries(bal).map(([c, v]) => money(v, c)).join(' • ') : money(0);
    const body = `<div class="grid" style="margin-bottom:8px"><div class="f"><span>Student</span><b>${esc(`${s.first_name || ''} ${s.last_name || ''}`)}</b></div><div class="f"><span>Matric</span><b>${esc(s.matric_no || '—')}</b></div>
      <div class="f"><span>Department</span><b>${esc(nameOf('departments', s.department_id) || '—')}</b></div><div class="f"><span>Outstanding</span><b class="neg">${balStr}</b></div></div>
      <div class="bar">Full Statement — All Fees & Payments</div>
      <table><thead><tr><th>Date</th><th>Description</th><th class="r">Debit (Fee)</th><th class="r">Credit (Paid)</th><th class="r">Balance</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No ledger entries.</td></tr>'}</tbody></table>`;
    return docShell('Student Financial Statement', body);
  }

  // Student statement of result (PDF via the browser print dialog) — mirrors the desktop slip.
  function resultSlipHTML(s, filter) {
    const sc = scoresFor(s.id);
    let sems = sc.semesters || [];
    let focused = null;
    if (filter && (filter.session || filter.semester)) {
      focused = sems.find(g => (!filter.session || g.session_id === filter.session) && (!filter.semester || g.semester_id === filter.semester));
      if (focused) sems = [focused];
    }
    const stand = (g) => { const x = Number(g) || 0; return x >= 4.5 ? 'First Class' : x >= 3.5 ? 'Second Class (Upper)' : x >= 2.4 ? 'Second Class (Lower)' : x >= 1.5 ? 'Third Class' : x >= 1 ? 'Pass' : '—'; };
    const cgpa = focused ? focused.cgpa : sc.cgpa;
    const photo = s.photo ? `<img class="photo" src="${s.photo}">` : '';
    const infoRows = [
      ['Matric Number', s.matric_no || '—'],
      ['Full Name', `${s.first_name || ''} ${s.last_name || ''}`.trim()],
      ['Faculty', nameOf('faculties', s.faculty_id) || '—'],
      ['Department', nameOf('departments', s.department_id) || '—'],
      ['Level', nameOf('levels', s.level_id) || '—'],
      ['Gender', s.gender || '—'],
    ];
    if (focused) { infoRows.push(['Session / Semester', `${focused.session || '—'} · ${focused.semester || '—'}`]); }
    // GPA / CGPA / Class Standing are shown at the BOTTOM of the sheet, not here.
    const infoTable = `<table class="info"><tbody>${infoRows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</tbody></table>`;
    const semBlocks = sems.map(g => {
      return `<div class="bar">${esc(g.semester || 'Semester')} · ${esc(g.session || '—')} &nbsp;—&nbsp; GPA ${esc(g.gpa)} · CGPA ${esc(g.cgpa)} · ${esc(g.units)} units</div>
        <table class="ctbl"><thead><tr><th class="c">#</th><th>CODE</th><th>COURSE TITLE</th><th class="c">CH</th><th class="c">TEST</th><th class="c">EXAM</th><th class="c">SCORE</th><th class="c">GRD</th><th class="c">CO</th></tr></thead><tbody>${(g.courses || []).map((r, i) => `<tr><td class="c">${i + 1}</td><td class="mono">${esc(r.course_code || '—')}</td><td>${esc(r.course_title || '—')}</td><td class="c">${esc(r.credit_unit)}</td><td class="c">${r.test_score == null ? '–' : esc(r.test_score)}</td><td class="c">${r.exam_score == null ? '–' : esc(r.exam_score)}</td><td class="c"><b>${r.score == null ? '–' : esc(r.score)}</b></td><td class="c"><b>${esc(r.grade || '–')}</b></td><td class="c">${r.co == null ? '–' : esc(r.co)}</td></tr>`).join('') || '<tr><td colspan="9" class="c" style="color:#94a3b8">No courses</td></tr>'}</tbody></table>`;
    }).join('') || '<p style="color:#94a3b8">No published results yet.</p>';
    // verification QR → public /verify page (no login) showing the student + GPA/CGPA
    const vurl = (docBase || '') + '/verify?res=' + s.id + (focused ? ('&ses=' + (focused.session_id || '') + '&sem=' + (focused.semester_id || '')) : '');
    const qr = verifyQrSvg(vurl);
    const ref = String(s.id).replace(/-/g, '').slice(0, 8).toUpperCase();
    const legend = `<table class="gtbl"><thead><tr><th colspan="3">GRADING SYSTEM</th></tr></thead><tbody>
      <tr><td>70–100</td><td class="c"><b>A</b></td><td class="c">5</td></tr><tr><td>60–69</td><td class="c"><b>B</b></td><td class="c">4</td></tr><tr><td>50–59</td><td class="c"><b>C</b></td><td class="c">3</td></tr>
      <tr><td>45–49</td><td class="c"><b>D</b></td><td class="c">2</td></tr><tr><td>40–44</td><td class="c"><b>E</b></td><td class="c">1</td></tr><tr><td>0–39</td><td class="c"><b>F</b></td><td class="c">0</td></tr></tbody></table>
      <div class="note">CH = Credit Unit · CO = Grade Point × CH · GPA = Σ CO ÷ Σ CH (semester) · CGPA = cumulative GPA.</div>`;
    // Only the QR is visible — the verify URL is kept in an invisible HTML comment (for tooling).
    const authBox = `<div class="auth">${qr ? `<div class="qr">${qr}</div>` : ''}<div class="amt">Scan to<br>verify result</div></div><!--verify ${esc(vurl)} ref ${esc(ref)}-->`;
    const summary = `<div class="summary">${focused ? `<div class="lab">Semester GPA</div><div class="mid">${esc(focused.gpa)}</div>` : ''}<div class="lab">Cumulative GPA (CGPA)</div><div class="big">${esc(cgpa)}</div><div class="lab">${esc(sc.totalUnits)} total credit units</div><div class="st">${esc(stand(cgpa))}</div></div>`;
    const sig = `<div class="sig"><div><div class="ln">Registrar / Examinations Officer</div></div><div><div class="ln" style="border-top-style:dashed">Official Stamp</div></div></div>`;
    const css = `<style>
      .sheet{font-size:11px}
      .info{width:100%;border-collapse:collapse;margin:3px 0}
      .info td{border:1px solid #d8dee9;padding:4px 9px;font-size:11.5px}
      .info td.k{background:#f1f5f9;font-weight:700;color:#334155;width:190px;text-transform:uppercase;font-size:9.5px;letter-spacing:.3px}
      .bar{margin:12px 0 4px;font-size:10.5px;padding:5px 10px}
      table.ctbl{width:100%;border-collapse:collapse;margin:0 0 4px}
      table.ctbl th{background:#eef2ff;border:1px solid #c7d2fe;padding:4px 6px;font-size:9px;text-transform:uppercase;letter-spacing:.2px;color:#1e3a8a;text-align:left}
      table.ctbl td{border:1px solid #d8dee9;padding:4px 6px;font-size:10.5px}
      .mono{font-family:Consolas,monospace;font-weight:700}.c{text-align:center}
      .foot{margin-top:14px;display:flex;gap:14px;align-items:flex-start;justify-content:space-between}
      table.gtbl{border-collapse:collapse;width:170px}
      table.gtbl th{background:#1e3a8a;color:#fff;padding:3px;font-size:9px;letter-spacing:1px}
      table.gtbl td{border:1px solid #d1d5db;padding:1px 8px;font-size:9px}
      .note{margin-top:5px;color:#64748b;font-size:8.5px;max-width:190px}
      .auth{display:flex;gap:8px;align-items:center}
      .auth .qr{width:84px;height:84px;flex:none}
      .auth .amt{font-size:9.5px;color:#475569;line-height:1.4}
      .auth .vurl{font-size:7.5px;color:#94a3b8;word-break:break-all}
      .summary{text-align:right;min-width:140px}
      .summary .lab{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;margin-top:4px}
      .summary .mid{font-size:17px;font-weight:800;color:#334155;line-height:1.05}
      .summary .big{font-size:26px;font-weight:800;color:#1e3a8a;line-height:1}
      .summary .st{display:inline-block;margin-top:4px;padding:3px 11px;border-radius:999px;background:#dcfce7;color:#166534;font-weight:700;font-size:10px}
      .sig{margin-top:22px;display:flex;justify-content:space-between}.sig div{width:42%;text-align:center}
      .sig .ln{border-top:1.5px solid #475569;padding-top:4px;color:#334155;font-size:10px;font-weight:600}
      @media print{@page{size:A4;margin:10mm}}
    </style>`;
    const body = `${photo}<div class="bar">Students Information</div>${infoTable}${semBlocks}<div class="foot">${legend}${authBox}${summary}</div>${sig}${css}`;
    return docShell('Statement of Result', body, null, { fit: true });
  }

  function payslipHTML(slip) {
    const run = one('payroll_runs', slip.run_id) || {}; const s = one('staff', slip.staff_id) || {};
    const cur = slip.currency || s.currency;
    const isLect = s.staff_type === 'lecturer';
    const wmText = isLect ? 'LECTURER PAYROLL' : 'STAFF PAYROLL';
    const psVerifyUrl = (docBase || '') + '/verify?p=' + slip.id;
    const psQr = verifyQrSvg(psVerifyUrl);
    const f = (l, v) => `<tr><td style="color:#64748b">${l}</td><td class="r"><b>${v}</b></td></tr>`;
    const body = `${s.photo ? `<img class="photo" src="${s.photo}">` : ''}
      <div class="grid" style="margin-bottom:8px"><div class="f"><span>Name</span><b>${esc(s.full_name)}</b></div><div class="f"><span>Staff No</span><b>${esc(s.staff_no || '—')}</b></div>
        <div class="f"><span>Type</span><b>${esc(s.staff_type === 'lecturer' ? 'Lecturer' : 'Staff')}</b></div><div class="f"><span>Period</span><b>${esc(run.period || '—')}</b></div>
        <div class="f"><span>Department</span><b>${esc(s.department || s.faculty || '—')}</b></div><div class="f"><span>Status</span><b>${esc(run.status || '—')}</b></div></div>
      <div class="bar">Earnings & Deductions</div>
      <table><tbody>
        ${f('Gross / Base', money(slip.gross, cur))}
        ${f('Allowances', money(slip.allowances, cur))}
        ${f('Bonus', money(slip.bonus, cur))}
        ${f('Deductions', money(slip.deductions, cur))}
        ${f('Loan / IOU Deduction', money(slip.loan_deduction, cur))}
      </tbody></table>
      <div class="tot">NET PAY: ${money(slip.net, cur)}</div>
      <p style="margin-top:8px" class="words">${esc(amountWords(slip.net, cur))}</p>
      <div class="bar">Authenticity</div>
      <div style="display:flex;align-items:center;gap:14px;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 14px;margin-top:8px">
        ${psQr ? `<div style="width:104px;height:104px;flex:none">${psQr}</div>` : ''}
        <div style="font-size:11.5px;color:#475569;line-height:1.5">Scan to verify this payslip is genuine.<br>Verification ref <b style="letter-spacing:1px;color:#111827">${esc(String(slip.id).replace(/-/g, '').slice(0, 8).toUpperCase())}</b><br>or visit <a href="${esc(psVerifyUrl)}">${esc((docBase || '') + '/verify')}</a></div>
      </div>`;
    return docShell((s.staff_type === 'lecturer' ? 'Lecturer' : 'Staff') + ' Payslip', body, wmText);
  }

  /** Printable examination-clearance certificate for the student (portal) — mirrors the
   *  desktop one, with a scannable QR (name, photo, department, level on the verify page). */
  function clearanceCertHTML(clearanceId) {
    const v = verifyClearance(clearanceId);
    const typeName = (v && v.typeName) || 'Examination';
    if (!v.valid) return docShell(typeName + ' Clearance', '<div class="empty" style="padding:30px;text-align:center">Clearance not found.</div>');
    const st = v.student;
    const isMid = v.clearanceType === 'midterm';
    const verifyUrl = (docBase || '') + '/verify?c=' + clearanceId;
    const qr = verifyQrSvg(verifyUrl);
    const apps = (v.approvals || []).map(a => `<tr><td>${esc(({ registrar: 'Registrar', dean: 'Faculty Head (Dean)', student_affairs: 'Student Affairs' })[a.office] || a.office)}</td><td><b style="color:${a.status === 'approved' ? '#166534' : a.status === 'denied' ? '#991b1b' : '#92400e'}">${esc(String(a.status || 'pending').toUpperCase())}</b></td><td>${esc(a.by || '—')}</td></tr>`).join('');
    const ok = v.completed;
    const okText = isMid ? '✓ CLEARED FOR MID-SEMESTER TESTS' : '✓ CLEARED FOR EXAMINATIONS';
    const body = `${st.photo ? `<img class="photo" src="${st.photo}">` : ''}
      <div class="exbar ${ok ? '' : ''}" style="background:${ok ? '#dcfce7' : '#fef9c3'};color:${ok ? '#166534' : '#854d0e'};border-radius:10px;padding:12px;text-align:center;font-weight:800;font-size:16px;margin-bottom:12px">${ok ? okText : '⚠ ' + esc(String(v.status || 'pending').toUpperCase())}</div>
      <div class="grid" style="margin-bottom:8px"><div class="f"><span>Student</span><b>${esc(st.name)}</b></div><div class="f"><span>Matric No</span><b>${esc(st.matric)}</b></div>
        <div class="f"><span>Faculty</span><b>${esc(st.faculty)}</b></div><div class="f"><span>Department</span><b>${esc(st.department)}</b></div>
        <div class="f"><span>Level</span><b>${esc(st.level)}</b></div><div class="f"><span>Clearance Type</span><b>${esc(typeName)} Clearance</b></div>
        <div class="f"><span>Session</span><b>${esc(v.session)} • ${esc(v.semester)}</b></div></div>
      <div class="bar">Office Approvals</div>
      <table><thead><tr><th>Office</th><th>Status</th><th>Approved By</th></tr></thead><tbody>${apps || '<tr><td colspan="3">—</td></tr>'}</tbody></table>
      <div class="bar">Authenticity</div>
      <div style="display:flex;align-items:center;gap:14px;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 14px;margin-top:8px">
        ${qr ? `<div style="width:104px;height:104px;flex:none">${qr}</div>` : ''}
        <div style="font-size:11.5px;color:#475569;line-height:1.5">Scan to verify this clearance — shows the student's name, photo, department & level.<br>Verification ref <b style="letter-spacing:1px;color:#111827">${esc(v.ref)}</b></div>
      </div>
      <p style="margin-top:18px;color:#64748b;font-size:11px">Student copy of a computer-generated ${esc(typeName.toLowerCase())} clearance. Anyone can confirm it is genuine by scanning the QR above.</p>`;
    return docShell(typeName + ' Clearance', body, 'STUDENT COPY');
  }

  /** Resolve a published timetable + the slots that apply to THIS student (cohort-scoped),
   *  mirroring the dashboard's myTimetables logic. Returns null if the student is out of scope. */
  function studentTimetable(t, s) {
    if (!t || t.deleted || t.status !== 'published') return null;
    const inScope = t.scope === 'faculty' ? t.faculty_id === s.faculty_id
      : (t.department_id === s.department_id && (!t.level_id || t.level_id === s.level_id));
    if (!inScope) return null;
    let slots = all('timetable_slots').filter(sl => sl.timetable_id === t.id && !sl.deleted);
    if (t.scope === 'faculty') slots = slots.filter(sl => sl.kind === 'holiday' || (sl.department_id === s.department_id && (!sl.level_id || sl.level_id === s.level_id)));
    return { t, slots };
  }
  const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  /** Clean, downloadable TABULAR timetable for the student portal. Lectures render as a
   *  days × time grid (the familiar timetable layout); exams/tests as a chronological table. */
  function timetableHTML(t, slots) {
    const ttName = t.type === 'lecture' ? 'Lecture Timetable' : t.type === 'midsemester' ? 'Mid-Semester Test Timetable' : 'Examination Timetable';
    const meta = [['Department', nameOf('departments', t.department_id)], ['Faculty', nameOf('faculties', t.faculty_id)], ['Level', nameOf('levels', t.level_id)], ['Session', nameOf('academic_sessions', t.session_id)], ['Semester', nameOf('semesters', t.semester_id)]]
      .filter(x => x[1]).map(x => `<div class="f"><span>${esc(x[0])}</span><b>${esc(x[1])}</b></div>`).join('');
    const classes = (slots || []).filter(s => s.kind !== 'holiday');
    const holidays = (slots || []).filter(s => s.kind === 'holiday');
    const timeLabel = (s) => esc((s.start_time || '') + (s.end_time ? '–' + s.end_time : ''));
    const courseCell = (s) => `<b>${esc(s.course_code || '')}</b>${s.course_title ? '<br><span style="font-size:10.5px;color:#475569">' + esc(s.course_title) + '</span>' : ''}${s.venue ? '<br><span style="font-size:10px;color:#64748b">📍 ' + esc(s.venue) + '</span>' : ''}${s.lecturer_name ? '<br><span style="font-size:10px;color:#64748b">👤 ' + esc(s.lecturer_name) + '</span>' : ''}`;
    let bodyTable;
    if (t.type === 'lecture') {
      // build a days × time grid
      const days = []; for (const c of classes) { const d = String(c.day_or_date || '').trim(); if (d && !days.includes(d)) days.push(d); }
      days.sort((a, b) => (DAY_ORDER.indexOf(a.toLowerCase()) + 100) % 1000 - (DAY_ORDER.indexOf(b.toLowerCase()) + 100) % 1000 || a.localeCompare(b));
      const times = []; for (const c of classes) { const k = (c.start_time || '') + '|' + (c.end_time || ''); if (!times.find(x => x.k === k)) times.push({ k, start: c.start_time || '', end: c.end_time || '', label: timeLabel(c) }); }
      times.sort((a, b) => String(a.start).localeCompare(String(b.start)));
      if (!days.length || !times.length) {
        bodyTable = `<table><thead><tr><th>Day</th><th>Time</th><th>Course</th><th>Venue</th><th>Lecturer</th></tr></thead><tbody>${classes.map(s => `<tr><td>${esc(s.day_or_date || '—')}</td><td>${timeLabel(s) || '—'}</td><td><b>${esc(s.course_code || '')}</b> ${esc(s.course_title || '')}</td><td>${esc(s.venue || '—')}</td><td>${esc(s.lecturer_name || '—')}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#94a3b8">No classes scheduled.</td></tr>'}</tbody></table>`;
      } else {
        const head = `<tr><th style="background:#1e3a8a;color:#fff">Time</th>${days.map(d => `<th style="background:#1e3a8a;color:#fff">${esc(d)}</th>`).join('')}</tr>`;
        const rows = times.map(tm => {
          const cells = days.map(d => {
            const hit = classes.find(c => String(c.day_or_date || '').trim() === d && (c.start_time || '') === tm.start && (c.end_time || '') === tm.end);
            return `<td style="vertical-align:top">${hit ? courseCell(hit) : '<span style="color:#cbd5e1">—</span>'}</td>`;
          }).join('');
          return `<tr><td style="font-weight:700;white-space:nowrap;background:#f8fafc">${tm.label || '—'}</td>${cells}</tr>`;
        }).join('');
        bodyTable = `<table style="table-layout:fixed">${head}${rows}</table>`;
      }
    } else {
      const sorted = classes.slice().sort((a, b) => String(a.day_or_date || '').localeCompare(String(b.day_or_date || '')) || String(a.start_time || '').localeCompare(String(b.start_time || '')));
      bodyTable = `<table><thead><tr><th>Date</th><th>Time</th><th>Course</th><th>Venue</th><th>Invigilator</th></tr></thead><tbody>${sorted.map(s => `<tr><td>${esc(s.day_or_date || '—')}</td><td>${timeLabel(s) || '—'}</td><td><b>${esc(s.course_code || '')}</b> ${esc(s.course_title || '')}</td><td>${esc(s.venue || '—')}</td><td>${esc(s.lecturer_name || '—')}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#94a3b8">No sittings scheduled.</td></tr>'}</tbody></table>`;
    }
    const holHtml = holidays.length ? `<div class="bar">Breaks / Holidays</div><table><tbody>${holidays.map(h => `<tr><td>${esc(h.day_or_date || '—')}</td><td>${esc(h.course_title || h.venue || 'Holiday / Break')}</td></tr>`).join('')}</tbody></table>` : '';
    const body = `<div class="grid" style="margin-bottom:6px">${meta}</div>
      <div class="bar">${esc(t.title || ttName)}</div>
      ${bodyTable}${holHtml}
      <p style="margin-top:14px;color:#64748b;font-size:11px">Computer-generated ${esc(ttName.toLowerCase())} from ${esc(inst().name)}. Times are shown in the institution's local time.</p>`;
    return docShell(t.title || ttName, body, null, { fit: true });
  }

  function moneyMapHTML(m) { const e = Object.entries(m || {}); return e.length ? e.map(([c, v]) => money(v, c)).join(' · ') : money(0); }
  function officerReportHTML(data, periodLabel) {
    const ROLE = { finance: 'Bursary / Administration', registrar: data.role === 'student_affairs' ? 'Student Affairs' : 'Registrar', dean: 'Faculty Head', affairs: 'Student Affairs' };
    let body = `<div class="grid"><div class="f"><span>Officer</span><b>${esc(data.profile.full_name)}</b></div><div class="f"><span>Role</span><b>${esc(data.role)}</b></div><div class="f"><span>Period</span><b>${esc(periodLabel || 'All time')}</b></div><div class="f"><span>Generated</span><b>${fmtDate(new Date().toISOString())}</b></div></div>`;
    if (data.kind === 'finance') {
      body += `<div class="bar">Summary (per currency)</div><table><tbody><tr><td>Collected</td><td class="r">${moneyMapHTML(data.cards.collected)}</td></tr><tr><td>Billed</td><td class="r">${moneyMapHTML(data.cards.billed)}</td></tr><tr><td>Expenses</td><td class="r">${moneyMapHTML(data.cards.expenses)}</td></tr><tr><td>Students</td><td class="r">${data.cards.students}</td></tr><tr><td>Debtors</td><td class="r">${data.cards.debtors}</td></tr></tbody></table>`;
      body += `<div class="bar">Recent Payments</div><table><thead><tr><th>Receipt</th><th>Student</th><th>For</th><th>Date</th><th class="r">Amount</th></tr></thead><tbody>${(data.recent || []).map(p => `<tr><td>${esc(p.receipt_no || '—')}</td><td>${esc(p.student)}</td><td>${esc(p.category)}</td><td>${fmtDate(p.date)}</td><td class="r">${money(p.amount, p.currency)}</td></tr>`).join('') || '<tr><td colspan=5>No payments.</td></tr>'}</tbody></table>`;
    } else if (data.kind === 'registrar') {
      body += `<div class="bar">My Collections</div><div class="tot">${moneyMapHTML(data.collected)}</div>`;
      body += `<div class="bar">Students I Billed</div><table><thead><tr><th>Name</th><th>Matric</th><th class="r">Paid</th><th class="r">Owing</th></tr></thead><tbody>${(data.students || []).map(r => `<tr><td>${esc(r.full_name)}</td><td>${esc(r.matric_no || '—')}</td><td class="r">${moneyMapHTML(r.paid)}</td><td class="r neg">${moneyMapHTML(r.owing)}</td></tr>`).join('') || '<tr><td colspan=4>None.</td></tr>'}</tbody></table>`;
    } else if (data.kind === 'dean') {
      body += `<div class="bar">Faculty Collections / Expenditure</div><table><tbody><tr><td>Collected</td><td class="r">${moneyMapHTML(data.collected)}</td></tr><tr><td>Expenditure</td><td class="r">${moneyMapHTML(data.expenses)}</td></tr></tbody></table>`;
      body += `<div class="bar">Students Owing Faculty Fees</div><table><thead><tr><th>Name</th><th>Matric</th><th class="r">Owing</th></tr></thead><tbody>${(data.debtors || []).map(r => `<tr><td>${esc(r.full_name)}</td><td>${esc(r.matric_no || '—')}</td><td class="r neg">${moneyMapHTML(r.owing)}</td></tr>`).join('') || '<tr><td colspan=3>None.</td></tr>'}</tbody></table>`;
    }
    return docShell((ROLE[data.kind] || 'Officer') + ' Report', body);
  }

  // ---------------------------- HTTP ----------------------------
  // API JSON is live data — never let a browser/proxy serve a STALE copy from its HTTP cache (that made
  // /api/data return outdated fees/documents after a change, and broke the version-driven live refresh).
  function J(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' }); res.end(b); return true; }
  // Base-path shim: when the portal is hosted under a path PREFIX (Supabase Edge Functions serve it
  // at /functions/v1/server), every absolute '/api/…' fetch, href and navigation in the pages would
  // miss the app. This script (injected into every HTML page's <head>) derives the prefix from the
  // page's own URL, patches fetch(), fixes href/src attributes (initial + click-time for dynamic
  // anchors), and exposes window.__B for the explicit location.href sites. On a normal host (Node
  // hub / desktop / LAN) the derived prefix is '' and the whole shim is a no-op.
  // NOTE: 'verify-credentials' must be stripped too (and listed BEFORE 'verify' so the alternation
  // can't half-match) — without it the credential-verification page hosted on Supabase derived a base
  // of '…/server/verify-credentials', every /api call missed the app and answered the edge 404
  // ("not found"), which the page then showed for EVERY matric number.
  const BASE_SHIM = "<script>(function(){var b=location.pathname.replace(/\\/(apply|scan|verify-credentials|verify|library\\/read\\/[^/]*|exam\\/take\\/[^/]*|class\\/[^/]*)\\/?$/,'').replace(/\\/+$/,'');window.__B=b;if(!b)return;var f=window.fetch.bind(window);window.fetch=function(u,o){if(typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.indexOf(b+'/')!==0)u=b+u;return f(u,o)};var fx=function(){var i,n,a,v,els=document.querySelectorAll('[href^=\"/\"],[src^=\"/\"]');for(i=0;i<els.length;i++){n=els[i];a=n.hasAttribute('href')?'href':'src';v=n.getAttribute(a);if(v&&v.charAt(0)==='/'&&v.charAt(1)!=='/'&&v.indexOf(b+'/')!==0&&v!==b)n.setAttribute(a,b+v)}};if(document.readyState!=='loading')fx();else document.addEventListener('DOMContentLoaded',fx);document.addEventListener('click',function(e){var t=e.target;while(t&&t!==document&&!(t.tagName==='A'&&t.getAttribute('href')))t=t.parentNode;if(t&&t!==document&&t.tagName==='A'){var v=t.getAttribute('href');if(v&&v.charAt(0)==='/'&&v.charAt(1)!=='/'&&v.indexOf(b+'/')!==0)t.setAttribute('href',b+v)}},true)})();</" + "script>";
  function H(res, code, html) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(String(html).replace('<head>', '<head>' + BASE_SHIM)); return true; }
  function S(res, code, body, type) { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }); res.end(body); return true; }
  function rawBearer(req, u) { const hdr = req.headers['authorization'] || ''; const b = /^Bearer\s+(.+)$/i.exec(hdr); return (b && b[1]) || u.searchParams.get('t') || ''; }
  function authOf(req, u) { return verifyToken(rawBearer(req, u)); }
  // Roles that may monitor an exam — MUST match the desktop surveillance/online-exam officer gate
  // (electron/services/surveillance.js + onlineexams.js). A logged-in staff user who is NOT one of these
  // (e.g. an accountant or a bursary clerk) must NOT be able to watch students' cameras / audio.
  const EXAM_OFFICER_ROLES = ['admin', 'campus_admin', 'registrar', 'dean', 'hod', 'ict'];
  // Exam-monitor caller = a portal OFFICER (a user with an exam-officer role) OR the trusted desktop
  // sync node presenting the sync token (so an officer needn't have a separate portal login to monitor).
  function isExamOfficer(req, u) {
    const t = authOf(req, u); if (t && t.k === 'user' && EXAM_OFFICER_ROLES.includes(t.role)) return t;
    const raw = rawBearer(req, u); if (raw && secret && raw === secret) return { k: 'sync', role: 'officer', id: 'sync' };
    return null;
  }

  // ---------------------------------------------------------------------------
  // ONLINE ADMISSIONS — public application portal (/apply). Applicants are NOT accounts; they
  // authenticate with a temporary pass (application number + passcode) which mints a short-lived
  // 'applicant' token. Applications are WRITTEN here via the create/update hooks and sync to the
  // registrar's desktop. Payment rails (Paystack secret / bank details) are read from server env —
  // the FEE AMOUNT itself rides on the synced application (set by the registrar's Offer).
  function genAppNo() {
    const short = String(inst().short || 'WAUU').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'WAUU';
    // Monotonic over the HIGHEST existing number, not the COUNT: `all` excludes deleted rows, so a
    // count+1 would reuse a number after any application is deleted — and app_no is the applicant's
    // login key (apply/login finds by it), so a reused number locks the newer applicant out.
    let max = 0;
    for (const a of all('admission_applications')) { const m = /(\d+)\s*$/.exec(String(a.app_no || '')); if (m) max = Math.max(max, Number(m[1])); }
    return `${short}/APP/${new Date().getFullYear()}/${String(max + 1).padStart(5, '0')}`;
  }
  const genPasscode = () => crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
  const applicantToken = (id) => sign({ k: 'applicant', id, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }); // 30-day temp pass
  function applicantFrom(req, u) { const t = authOf(req, u); if (!t || t.k !== 'applicant') return null; const a = one('admission_applications', t.id); return (a && !a.deleted) ? a : null; }
  function appPublic(a) {
    if (!a) return null;
    const docs = all('admission_documents').filter(d => d.application_id === a.id && !d.deleted).map(d => ({ id: d.id, kind: d.kind, filename: d.filename, uploaded_at: d.uploaded_at }));
    const { passcode_hash, ...rest } = a; // never expose the passcode hash to the client
    return Object.assign(rest, { department_name: nameOf('departments', a.department_id), faculty_name: nameOf('faculties', a.faculty_id), campus_name: nameOf('campuses', a.campus_id), level_name: nameOf('levels', a.level_id), documents: docs });
  }
  // ---- applicant emails (application confirmation + status), sent via the hub's SMTP relay (best-effort) ----
  function applicantEmailHTML(a, bodyHtml) {
    const i = inst();
    const logo = i.logo ? `<img src="${esc(i.logo)}" alt="" style="height:46px;margin-bottom:8px">` : '';
    const link = docBase ? `${docBase}/apply` : '';
    return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">`
      + `<div style="text-align:center;border-bottom:2px solid #1e3a8a;padding-bottom:10px;margin-bottom:14px">${logo}<div style="font-size:18px;font-weight:800;color:#1e3a8a">${esc(i.name || 'University')}</div><div style="font-size:12px;color:#64748b">Office of Admissions</div></div>`
      + bodyHtml
      + `<div style="margin-top:18px;border-top:1px solid #e5e7eb;padding-top:10px;color:#94a3b8;font-size:11px">This is an automated message from the ${esc(i.name || 'University')} admissions portal.${link ? ` You can continue your application or check your status anytime at <a href="${esc(link)}">${esc(link)}</a>.` : ''}</div></div>`;
  }
  function applicantSummary(a) {
    const rows = [['Application No.', a.app_no], ['Name', `${a.first_name || ''} ${a.last_name || ''}`.trim()],
      ['Campus', nameOf('campuses', a.campus_id)], ['Programme', nameOf('departments', a.department_id)],
      ['Faculty', nameOf('faculties', a.faculty_id)], ['Level', nameOf('levels', a.level_id)]].filter(([, v]) => v);
    return `<table style="width:100%;border-collapse:collapse;font-size:13px">${rows.map(([k, v]) => `<tr><td style="padding:5px 8px;color:#64748b;border-bottom:1px solid #f1f5f9">${esc(k)}</td><td style="padding:5px 8px;font-weight:600;border-bottom:1px solid #f1f5f9">${esc(v)}</td></tr>`).join('')}</table>`;
  }
  function mailApplicant(a, subject, bodyHtml) {
    if (typeof sendMail !== 'function' || !a || !a.email) return;
    try {
      const html = applicantEmailHTML(a, bodyHtml);
      const text = String(bodyHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      Promise.resolve(sendMail({ to: a.email, subject, html, text })).catch(() => {});
    } catch (_) { /* email is best-effort — never block the apply flow */ }
  }

  function programmesPayload() {
    const faculties = all('faculties').filter(f => !f.deleted);
    const departments = all('departments').filter(d => !d.deleted);
    const levels = all('levels').filter(l => !l.deleted).sort((a, b) => (a.rank || 0) - (b.rank || 0)).map(l => ({ id: l.id, name: l.name }));
    // Multi-campus: applicants pick the campus they're applying to. Each faculty carries its campus_id so
    // the form can show only that campus's programmes. (A single-campus institution sends an empty list.)
    const campuses = all('campuses').filter(c => !c.deleted).sort((a, b) => (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0)).map(c => ({ id: c.id, name: c.name }));
    const grouped = faculties.map(f => ({ id: f.id, name: f.name, campus_id: f.campus_id || null, departments: departments.filter(d => d.faculty_id === f.id).map(d => ({ id: d.id, name: d.name })) })).filter(f => f.departments.length);
    const orphans = departments.filter(d => !faculties.some(f => f.id === d.faculty_id));
    if (orphans.length) grouped.push({ id: '_other', name: 'Other Programmes', campus_id: null, departments: orphans.map(d => ({ id: d.id, name: d.name })) });
    return { faculties: grouped, levels, campuses, open: (String(process.env.ADMISSIONS_OPEN || '1') !== '0') };
  }
  // ---- Online payment: record + alert + email (shared by the redirect callback AND the webhook) ----
  // Idempotent on provider:reference. Records a COMPLETED payment (reuses the normal ledger so it shows as
  // a receipt + reduces the chosen fee's balance), alerts the fee office, and emails the student a
  // provisional receipt. NEVER trusts the client — only ever called AFTER gateway.verify() succeeds.
  function notifyFeeOffice(s, category, amt, cur, receiptNo) {
    if (typeof create !== 'function') return;
    const nm = `${s.first_name || ''} ${s.last_name || ''}`.trim();
    const roles = new Set(['accountant', 'admin']);
    try { all('charges').filter(c => !c.deleted && c.student_id === s.id && c.category === category).forEach(c => { if (c.raised_role) roles.add(c.raised_role); }); } catch (_) {}
    const now = new Date().toISOString();
    for (const role of roles) {
      try { create('notifications', { id: crypto.randomUUID(), target_user: null, target_role: role, title: '💰 Online payment received', body: `${nm} paid ${money(amt, cur)} for ${category} online — receipt ${receiptNo}.`, type: 'system', payload: JSON.stringify({ student_id: s.id, receipt_no: receiptNo, category }), is_read: 0, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' }); } catch (_) {}
    }
  }
  function emailReceipt(s, r) {
    if (typeof sendMail !== 'function' || !s.email) return;
    const i = inst();
    const logo = i.logo ? `<img src="${esc(i.logo)}" alt="" style="height:42px;margin-bottom:6px">` : '';
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">`
      + `<div style="text-align:center;border-bottom:2px solid #1e3a8a;padding-bottom:10px;margin-bottom:14px">${logo}<div style="font-size:18px;font-weight:800;color:#1e3a8a">${esc(i.name || 'University')}</div><div style="font-size:12px;color:#64748b">Office of the Bursar</div></div>`
      + `<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:12px 14px;text-align:center;margin-bottom:14px"><div style="font-size:30px">✅</div><b>Payment received</b></div>`
      + `<p>Dear ${esc(`${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Student')},</p>`
      + `<p>We have received your online payment. This is your <b>provisional receipt</b> — the official receipt is also on your portal under <b>Fees</b>.</p>`
      + `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 14px">`
      + `<tr><td style="padding:7px 0;color:#64748b;width:150px">Receipt no.</td><td style="padding:7px 0;font-weight:700">${esc(r.receiptNo)}</td></tr>`
      + `<tr><td style="padding:7px 0;color:#64748b">Paid for</td><td style="padding:7px 0;font-weight:700">${esc(r.category)}</td></tr>`
      + `<tr><td style="padding:7px 0;color:#64748b">Amount</td><td style="padding:7px 0;font-weight:700">${esc(money(r.amt, r.cur))}</td></tr>`
      + `<tr><td style="padding:7px 0;color:#64748b">Method</td><td style="padding:7px 0;font-weight:700">Online · ${esc(r.provider)}</td></tr>`
      + `<tr><td style="padding:7px 0;color:#64748b">Date</td><td style="padding:7px 0;font-weight:700">${esc(new Date(r.date).toLocaleString())}</td></tr></table>`
      + `<div style="color:#94a3b8;font-size:11px;border-top:1px solid #e5e7eb;padding-top:10px">Keep this receipt. If your balance is not updated within a few minutes, contact the Bursary with the receipt number above.</div></div>`;
    try { Promise.resolve(sendMail({ to: s.email, subject: `Payment receipt ${r.receiptNo} — ${i.name || ''}`, html })).catch(() => {}); } catch (_) {}
  }
  async function recordOnlinePayment(provider, verified, ctx) {
    ctx = ctx || {};
    const md = (verified && verified.metadata) || {};
    // TRUST the server-built intent (ctx) over any provider/client metadata — student/category/charge
    // come from what WE created at checkout-start, never from the browser.
    const sid = ctx.student_id || md.student_id; if (!sid) return { ok: false, error: 'no student in metadata' };
    const s = one('students', sid); if (!s) return { ok: false, error: 'student not found' };
    const reference = String(verified.reference || ctx.reference || md.reference || '');
    const tag = provider + ':' + reference;
    const dup = all('payments').find(x => !x.deleted && String(x.decision_note || '') === tag);
    if (dup) return { ok: true, already: true, payment: dup };                      // idempotent
    const amt = Math.round((Number(verified.amount) || 0) * 100) / 100;
    const cur = String(verified.currency || ctx.currency || md.currency || 'NGN').toUpperCase();
    const category = String(ctx.category || md.category || 'tuition').slice(0, 40);
    if (!(amt > 0) || typeof create !== 'function') return { ok: false, error: 'invalid amount' };
    // FRAUD GUARD: when we have the expected intent, the gateway-verified currency MUST match it, and
    // the amount cannot exceed what we asked for (a provider should never report MORE than the order).
    if (ctx.expectCurrency && cur !== String(ctx.expectCurrency).toUpperCase()) return { ok: false, error: 'currency mismatch' };
    if (ctx.expectAmount != null && amt > Number(ctx.expectAmount) + 1) return { ok: false, error: 'amount exceeds the order' };
    const now = new Date().toISOString();
    const receiptNo = 'ONL-' + now.slice(0, 7).replace('-', '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const pid = crypto.randomUUID();
    create('payments', {
      id: pid, receipt_no: receiptNo, student_id: sid, charge_id: md.charge_id || null, category,
      description: 'Online payment (' + provider + ')', currency: cur, amount: amt,
      method: 'online', channel: provider, status: 'completed',
      raised_by: null, raised_role: md.raised_role || 'accountant', decided_by: null, decided_at: now,
      decision_note: tag, session_id: md.session_id || null, semester_id: md.semester_id || null,
      created_at: now, updated_at: now, deleted: 0, origin_node: 'portal',
    });
    notifyFeeOffice(s, category, amt, cur, receiptNo);
    emailReceipt(s, { receiptNo, category, amt, cur, provider, date: now });
    return { ok: true, payment: { id: pid, receipt_no: receiptNo, amount: amt, currency: cur, category } };
  }
  // Resolve the requested provider to one this deployment actually has keys for (default = first configured).
  function pickProvider(x) {
    if (!gateway) return null;
    const list = gateway.providers(); if (!list.length) return null;
    const id = String(x || '').toLowerCase().trim();
    return (id && list.some(p => p.id === id)) ? id : list[0].id;
  }
  // Re-derive what the student still owes for a fee straight from the ledger, so we can refuse an overpay
  // (auto-debit the chosen fee, not more). Returns null when the fee is unknown here (don't block then).
  function outstandingFor(s, category, currency) {
    try {
      const cur = String(currency || 'NGN').toUpperCase();
      const charges = all('charges').filter(c => !c.deleted && c.student_id === s.id && c.category === category && String(c.currency || 'NGN').toUpperCase() === cur);
      if (!charges.length) return null;
      const billed = charges.reduce((a, c) => a + (Number(c.amount) || 0), 0);
      const paid = all('payments').filter(x => !x.deleted && x.student_id === s.id && x.category === category && String(x.currency || 'NGN').toUpperCase() === cur && x.status === 'completed').reduce((a, x) => a + (Number(x.amount) || 0), 0);
      return Math.max(0, Math.round((billed - paid) * 100) / 100);
    } catch (_) { return null; }
  }
  // After a VERIFIED transaction, route it to the right place: a student fee payment, or an admission
  // fee. `intent` (when present) is the server-built record we trust for student/amount/currency; the
  // verified provider data is the source of truth for "was it actually paid + how much".
  async function settlePayment(provider, verified, intent) {
    const md = (verified && verified.metadata) || {};
    const appId = (intent && intent.application_id) || md.application_id;
    if (appId) {
      const a = one('admission_applications', appId);
      if (a && typeof update === 'function') {
        // FRAUD GUARD: when we have the expected intent, the gateway-verified currency must match it and
        // the paid amount cannot fall short of the admission fee (so a tampered/underpaid checkout never
        // marks the fee paid).
        if (intent) {
          const vcur = String(verified.currency || '').toUpperCase();
          const vamt = Math.round((Number(verified.amount) || 0) * 100) / 100;
          if ((intent.currency && vcur && vcur !== String(intent.currency).toUpperCase()) || (intent.amount && vamt > 0 && vamt + 1 < Number(intent.amount))) return { ok: false, error: 'amount/currency mismatch' };
        }
        if (!a.admission_fee_paid) update('admission_applications', a.id, { admission_fee_paid: 1, payment_ref: verified.reference, status: a.status === 'admitted' ? 'admitted' : 'fee_paid' });
        if (intent) markIntent(intent.id, { status: 'paid' });
        return { ok: true, kind: 'admission' };
      }
      return { ok: false, error: 'application not found' };
    }
    const sid = (intent && intent.student_id) || md.student_id;
    if (sid) {
      const ctx = intent
        ? { student_id: intent.student_id, category: intent.category, reference: intent.reference, expectAmount: intent.amount, expectCurrency: intent.currency }
        : {};
      const out = await recordOnlinePayment(provider, verified, ctx);
      if (intent && out && out.ok) markIntent(intent.id, { status: 'paid', payment_id: out.payment && out.payment.id });
      return Object.assign({ kind: 'student' }, out);
    }
    return { ok: false, error: 'unknown payment target' };
  }
  function payResultPage(okPaid, paidText) {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#fff;text-align:center;padding:60px 20px"><div style="font-size:54px">${okPaid ? '✅' : '⚠️'}</div><h2>${okPaid ? 'Payment received' : 'Payment not confirmed'}</h2><p style="opacity:.8">${okPaid ? ('Your payment' + (paidText ? ' of ' + esc(paidText) : '') + ' has been recorded. Your receipt is now in the app under Fees, and a copy has been emailed to you.') : 'We could not confirm your payment yet. If you were debited, it will reflect automatically once the bank confirms — or contact the Bursary with your transaction reference.'}</p><p style="opacity:.6;font-size:13px">You can close this window and return to the app.</p></body>`;
  }

  // ---- Online-payment INTENTS + smart reconciliation -----------------------
  // An intent is created the moment a checkout STARTS, correlating OUR reference to the provider's id.
  // It lets the redirect callback, the webhook AND a periodic sweep all verify+settle the SAME payment
  // (idempotently), so a payment is recorded even if the student closes the tab before redirecting.
  function paymentsTestMode() { try { return !!(gateway && gateway.isTestMode && gateway.isTestMode()); } catch (_) { return false; } }
  function createIntent(o) {
    if (typeof create !== 'function') return null;
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    const row = { id, reference: o.reference, provider: o.provider, provider_ref: o.provider_ref || o.reference || null,
      student_id: o.student_id || null, application_id: o.application_id || null, category: o.category || null,
      amount: Math.round((Number(o.amount) || 0) * 100) / 100, currency: String(o.currency || 'NGN').toUpperCase(),
      status: 'initiated', payment_id: null, test_mode: o.test_mode ? 1 : 0, ip: (o.ip || '').slice(0, 60), attempts: 0,
      last_checked_at: null, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' };
    create('payment_intents', row); return row;
  }
  function intentByReference(ref) { if (!ref) return null; try { return all('payment_intents').find(x => !x.deleted && x.reference === ref) || null; } catch (_) { return null; } }
  function markIntent(id, patch) { if (typeof update === 'function' && id) update('payment_intents', id, Object.assign({ updated_at: new Date().toISOString() }, patch)); }
  /** How many checkouts this student STARTED in the last `minutes` (velocity / anti-abuse guard). */
  function recentIntentCount(studentId, minutes) {
    if (!studentId) return 0; const since = Date.now() - (minutes || 60) * 60000;
    try { return all('payment_intents').filter(x => !x.deleted && x.student_id === studentId && new Date(x.created_at || 0).getTime() >= since).length; } catch (_) { return 0; }
  }
  /** The id we must hand to gateway.verify(), per provider — from the redirect query and/or the intent. */
  function resolveVerifyRef(provider, query, intent) {
    const ir = intent && intent.provider_ref;
    if (provider === 'flutterwave') return query.transaction_id || ir || query.tx_ref || query.reference;
    if (provider === 'stripe') return query.session_id || ir;
    if (provider === 'paypal') return query.token || ir;
    if (provider === 'razorpay') return query.razorpay_payment_link_id || ir;
    if (provider === 'mollie') return ir;
    if (provider === 'momopay') return query.id || ir; // FedaPay redirects with ?id=<transactionId>&status=approved
    return query.reference || query.trxref || ir; // paystack + default
  }
  /** Periodic sweep: re-verify checkouts that never came back (closed tab / dropped webhook) and settle
   *  the ones that actually paid; give up on very old ones. Safe to call on an interval. Idempotent. */
  async function reconcileIntents(opts) {
    opts = opts || {};
    try { gcExamFrames(); } catch (_) {}   // free idle proctoring frames every cycle (prevents a slow leak)
    if (!gateway || typeof all !== 'function') return { checked: 0, settled: 0 };
    const now = Date.now();
    const minAge = (opts.minAgeMin != null ? opts.minAgeMin : 2) * 60000;   // let callback/webhook try first
    const maxAge = (opts.maxAgeMin != null ? opts.maxAgeMin : 720) * 60000; // give up after 12h
    const recheck = (opts.recheckMin != null ? opts.recheckMin : 5) * 60000;
    let checked = 0, settled = 0;
    let pending;
    try { pending = all('payment_intents').filter(x => !x.deleted && x.status === 'initiated'); } catch (_) { return { checked: 0, settled: 0 }; }
    for (const it of pending) {
      const age = now - new Date(it.created_at || 0).getTime();
      if (age < minAge) continue;
      if (age > maxAge) { markIntent(it.id, { status: 'abandoned' }); continue; }
      if (it.last_checked_at && (now - new Date(it.last_checked_at).getTime()) < recheck) continue;
      markIntent(it.id, { attempts: (it.attempts || 0) + 1, last_checked_at: new Date().toISOString() });
      if (!it.provider_ref) continue;
      checked++;
      let v = null; try { v = await gateway.verify(it.provider, it.provider_ref); } catch (_) {}
      if (v && v.ok) { try { const out = await settlePayment(it.provider, v, it); if (out && out.ok) settled++; } catch (_) {} }
    }
    return { checked, settled };
  }

  // ---- Final-clearance view helpers (assembled from the SYNCED tables; owed computed live) ----
  const FC_STAGES = ['financial', 'academic', 'project', 'results', 'physical'];
  const FC_STAGE_LABEL = { request: 'Request', financial: 'Financial clearance', academic: 'Academic clearance', project: 'Project defence', results: 'Results, transcript & certificate', physical: 'Physical certificate & transcript', done: 'Completed' };
  const FC_ROLE_LABEL = { accountant: 'Bursary / Accountant', registrar: 'Registrar', dean: 'Faculty Head (Dean)', student_affairs: 'Student Affairs', hod: 'Head of Department', ict: 'ICT', library: 'Library', project_committee: 'Project committee' };
  function finalEligible(s) {
    const lvlName = (one('levels', s.level_id) || {}).name || '';
    const mm = String(lvlName).match(/\d{3,}/); const ln = mm ? Number(mm[0]) : null;
    if (ln != null) return ln >= 300;
    const lv = all('levels').slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
    return lv.findIndex(l => l.id === s.level_id) >= 2;
  }
  function fcBalLive(sid) {
    const bal = {};
    for (const c of all('charges')) if (!c.deleted && c.student_id === sid) bal[c.currency] = (bal[c.currency] || 0) + Number(c.amount || 0);
    for (const pm of all('payments')) if (!pm.deleted && pm.student_id === sid && pm.status === 'completed') bal[pm.currency] = (bal[pm.currency] || 0) - Number(pm.amount || 0);
    const out = {}; for (const k of Object.keys(bal)) if (bal[k] > 0.001) out[k] = Math.round(bal[k] * 100) / 100; return out;
  }
  function fcOwedCat(sid, cat) {
    if (!cat) return {}; const ch = {}, pd = {};
    for (const c of all('charges')) if (!c.deleted && c.student_id === sid && c.category === cat) ch[c.currency] = (ch[c.currency] || 0) + Number(c.amount || 0);
    for (const pm of all('payments')) if (!pm.deleted && pm.student_id === sid && pm.category === cat && pm.status === 'completed') pd[pm.currency] = (pd[pm.currency] || 0) + Number(pm.amount || 0);
    const out = {}; for (const k of new Set([...Object.keys(ch), ...Object.keys(pd)])) { const o = Math.round(((ch[k] || 0) - (pd[k] || 0)) * 100) / 100; if (o > 0.001) out[k] = o; } return out;
  }
  function fcItemOwed(it, sid) {
    if (it.type === 'financial_all') return fcBalLive(sid);
    if ((it.type === 'office_fees' || it.type === 'manual') && it.pay_category) return fcOwedCat(sid, it.pay_category);
    return {};
  }
  function finalClearanceView(s) {
    const eligible = finalEligible(s);
    const clr = all('grad_clearances').filter(c => !c.deleted && c.student_id === s.id).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    if (!clr) return { exists: false, eligible, minLevel: 300 };
    const allItems = all('grad_clearance_items').filter(i => !i.deleted && i.clearance_id === clr.id);
    const stages = FC_STAGES.map((st, i) => {
      const its = (clr.status === 'denied') ? [] : allItems.filter(x => x.stage === st).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map(it => {
        const owed = fcItemOwed(it, s.id);
        let status = it.status;
        if (status !== 'cleared' && Object.keys(owed).length) status = 'owing';
        let detail = null; try { detail = it.detail ? JSON.parse(it.detail) : null; } catch (_) {}
        return { id: it.id, name: it.name, type: it.type, stage: it.stage, status, oversee_label: FC_ROLE_LABEL[it.oversee_role] || it.oversee_role || '—', owed, online_pay: !!it.online_pay, pay_category: it.pay_category || null, detail, note: it.note };
      });
      const reached = FC_STAGES.indexOf(clr.stage) > i || clr.status === 'completed';
      return { key: st, label: FC_STAGE_LABEL[st], items: its, current: clr.stage === st && clr.status === 'active', done: (its.length && its.every(x => x.status === 'cleared')) || reached };
    });
    const docByKind = (k) => { const d = all('portal_documents').find(x => !x.deleted && x.student_id === s.id && x.auto_kind === k); return d ? { id: d.id, title: d.title, filename: d.filename } : null; };
    // a single 0–100 figure the portal/APK render as a progress bar (mirrors finalclearance.progressOf)
    const fcProgress = () => {
      const total = FC_STAGES.length;
      if (clr.status === 'completed') return { percent: 100, stageIndex: total, totalStages: total, label: 'Completed' };
      if (clr.status === 'denied') return { percent: 0, stageIndex: 0, totalStages: total, label: 'Declined' };
      if (clr.status === 'requested') return { percent: 0, stageIndex: 0, totalStages: total, label: 'Awaiting approval' };
      const idx = Math.max(0, FC_STAGES.indexOf(clr.stage));
      const cur = stages.find(st => st.key === clr.stage); const items = (cur && cur.items) || [];
      const cleared = items.filter(i => i.status === 'cleared').length;
      const within = items.length ? cleared / items.length : 0; const per = 100 / total;
      return { percent: Math.max(1, Math.min(99, Math.round(idx * per + within * per))), stageIndex: idx, totalStages: total, label: FC_STAGE_LABEL[clr.stage] || clr.stage, cleared, total: items.length };
    };
    return {
      exists: true, eligible, id: clr.id, status: clr.status, stage: clr.stage, stage_label: FC_STAGE_LABEL[clr.stage] || clr.stage,
      progress: fcProgress(),
      deny_reason: clr.deny_reason, cgpa: clr.cgpa, classification: clr.classification, stages,
      documents: { project: docByKind('project'), transcript: docByKind('transcript'), certificate: docByKind('certificate'), scanned_transcript: docByKind('scanned_transcript'), scanned_certificate: docByKind('scanned_certificate') },
    };
  }

  // Server-side safety net: finalise any attempt whose personal time has passed but that was never
  // submitted (the student closed the app/lost connection at the buzzer). Without this its autosaved
  // answers would stay 'in_progress' forever — never graded — unless an officer manually ends the
  // sitting. Marks it 'auto_submitted' (keeping the saved answers) so it enters the grading queue.
  // Authoritative end-of-time for ONE attempt (epoch ms): started_at + (duration + per-student extension),
  // capped by the exam's hard window end. SINGLE SOURCE OF TRUTH for the clock — the client countdown is
  // only a mirror, so a tampered device clock can't buy extra time. Returns 0 if it can't be computed.
  function attemptDeadlineMs(e, at) {
    if (!e || !at) return 0;
    let st = {}; try { st = JSON.parse(e.settings || '{}'); } catch (_) {}
    const startedMs = Date.parse(at.started_at || at.created_at || '') || 0; if (!startedMs) return 0;
    const extraMin = (st.extensions && Number(st.extensions[at.student_id])) || 0;
    const durEnd = startedMs + ((Number(e.duration_min) || 60) + extraMin) * 60000;
    const winEnd = e.end_at ? Date.parse(e.end_at) + extraMin * 60000 : durEnd;
    return Math.min(durEnd, winEnd);
  }
  const DEADLINE_GRACE_MS = 10000;   // tolerate clock skew / an in-flight autosave at the buzzer
  function autoCloseExpiredAttempts(e) {
    if (!e || !e.id || typeof update !== 'function') return 0;
    const now = Date.now(); let closed = 0;
    for (const a of all('exam_attempts')) {
      if (a.deleted || a.exam_id !== e.id || a.status !== 'in_progress') continue;
      const deadline = attemptDeadlineMs(e, a); if (!deadline) continue;
      if (now > deadline + DEADLINE_GRACE_MS) {
        update('exam_attempts', a.id, { status: 'auto_submitted', submitted_at: new Date().toISOString() });
        closed++;
      }
    }
    return closed;
  }
  // Auto-end "ghost" live classes: a host who closes their tab/loses connection never calls endSession,
  // so the live_sessions row stays active=1 forever. Mark any active session older than the live window
  // (3h) inactive at the SOURCE, so the lecturer's desktop, the sync state and pushes never treat a long-
  // abandoned class as still live. Idempotent.
  const LIVE_WINDOW_MS = 3 * 60 * 60 * 1000;   // legacy fallback for a host that doesn't heartbeat
  const HB_STALE_MS = 110 * 1000;              // a heartbeating host is "gone" ~110s after its last beat (≈3 missed)
  // Is a live_sessions row REALLY live right now? A host that sends heartbeats (the portal /class page pings
  // every ~30s) is judged by its LAST heartbeat, so "Live now" clears within ~2min of the host leaving even
  // when the best-effort end-beacon was missed (crash / tab killed / phone died) — the live-class analog of
  // the exam's server-authoritative timeout. A session with no heartbeat (desktop-hosted / an older host)
  // keeps the legacy 3h window, so nothing regresses.
  function isSessionLive(v, now) {
    if (!v || v.deleted || !v.active) return false;
    now = now || Date.now();
    if (v.heartbeat_at) return (now - (Date.parse(v.heartbeat_at) || 0)) < HB_STALE_MS;
    return (now - (Date.parse(v.started_at || '') || 0)) < LIVE_WINDOW_MS;
  }
  function sweepStaleLive() {
    if (typeof update !== 'function') return 0;
    const now = Date.now(); let n = 0;
    // end any session that is no longer live AT THE SOURCE, so active=0 syncs to the desktop + APK and the
    // students' /class page auto-leaves. Covers both a heartbeat that stopped and the legacy 3h cap.
    for (const v of all('live_sessions')) { if (!v.deleted && v.active && !isSessionLive(v, now)) { update('live_sessions', v.id, { active: 0 }); n++; } }
    return n;
  }

  async function handle(req, res, u, method, readBody) {
    const p = u.pathname.replace(/\/+$/, '') || '/';
    docBase = buildBase(req); // so any document we render this request can build absolute verify URLs

    if (p === '/' && method === 'GET') { H(res, 200, PAGE); return true; }
    // Live class room (Jitsi). The room id is a secret capability shown only to the cohort + lecturer.
    if (method === 'GET' && p.startsWith('/class/')) {
      const room = p.slice('/class/'.length);
      const t = authOf(req, u);
      // Must be signed in to join a class (room ids are a capability, but we still require a valid session).
      if (!t || (t.k !== 'student' && t.k !== 'staff' && t.k !== 'user')) {
        return H(res, 401, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#fff;text-align:center;padding:60px 20px"><div style="font-size:48px">🔒</div><h2>Please sign in to join the class</h2><p style="opacity:.8">Open this class from your portal or the app after signing in.</p><a href="/" style="display:inline-block;margin-top:18px;background:#1e3a8a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Go to portal</a></body>');
      }
      // MODERATOR LOCK: host/moderator status is derived from the AUTHENTICATED role — only teaching staff /
      // management may host. A student can never self-promote by passing ?host=1 (which would otherwise hand
      // them a moderator JWT: recording, lobby control, mute-everyone). Students always join as students.
      const isHost = (u.searchParams.get('host') === '1') && (t.k === 'staff' || t.k === 'user');
      return H(res, 200, classPageHTML(room, u.searchParams.get('n') || 'Guest', u.searchParams.get('s') || 'Live Class', isHost, t));
    }
    // E-library: read online (in-app pdf.js viewer), stream the file, or download. Student-scoped.
    if (method === 'GET' && p.startsWith('/library/')) {
      const t = authOf(req, u); if (!t) return H(res, 401, '<p>Session expired. Please sign in again.</p>');
      const parts = p.split('/'); const action = parts[2]; const id = parts[3];
      const s = (t.k === 'student' || t.k === 'parent') ? (one('students', t.id)) : null;
      const book = id ? one('library_books', id) : null;
      if (!book || book.deleted) return H(res, 404, '<p>Book not found.</p>');
      if (s && !libraryVisibleTo(book, s)) return H(res, 403, '<p>This book is not available to you.</p>');
      if (action === 'read') return H(res, 200, libraryReaderHTML(book, u.searchParams.get('t') || ''));
      if (action === 'file' || action === 'download') {
        const buf = await resolveBlob(book.file, book.file_key);
        if (!buf) return H(res, 404, '<p>This book file is unavailable.</p>');
        const disp = action === 'download' ? 'attachment' : 'inline';
        res.writeHead(200, { 'Content-Type': book.mime || 'application/octet-stream', 'Content-Disposition': disp + '; filename="' + String(book.filename || 'book').replace(/[\\/:*?"<>|]+/g, '-') + '"', 'Cache-Control': 'private, max-age=3600' });
        res.end(buf); return true;
      }
      return H(res, 404, '<p>Not found.</p>');
    }
    // Online exam — full-screen, proctored taking page (browser: laptop + phone). Standalone page so
    // it owns the camera/mic/timer/lockdown without fighting the SPA.
    if (method === 'GET' && p.startsWith('/exam/take/')) {
      const t = authOf(req, u); if (!t || t.k !== 'student') return H(res, 401, '<p>Please sign in as a student to take this exam.</p>');
      const id = p.split('/')[3]; const s = one('students', t.id);
      const e = id ? one('online_exams', id) : null;
      if (!e || e.deleted || !s || !examVisibleTo(e, s)) return H(res, 404, '<p>Exam not found or not available to you.</p>');
      return H(res, 200, examTakeHTML(e, u.searchParams.get('t') || '', s));
    }
    // Exam-conduct evidence: the flagged student downloads the video/audio/image clip that was
    // recorded — full transparency, so they can see exactly what was captured and appeal if wrong.
    if (method === 'GET' && p.startsWith('/surveillance/evidence/')) {
      const t = authOf(req, u); if (!t) return H(res, 401, '<p>Session expired. Please sign in again.</p>');
      const id = p.split('/')[3];
      const ev = id ? one('malpractice_evidence', id) : null;
      if (!ev || ev.deleted) return H(res, 404, '<p>Evidence not found.</p>');
      // a student may only fetch evidence attached to their OWN flag
      if ((t.k === 'student' || t.k === 'parent') && ev.student_id !== t.id) return H(res, 403, '<p>This evidence is not available to you.</p>');
      if (!ev.data) return H(res, 404, '<p>This evidence has no file.</p>');
      const dl = u.searchParams.get('dl') === '1';
      res.writeHead(200, { 'Content-Type': ev.mime || 'application/octet-stream', 'Content-Disposition': (dl ? 'attachment' : 'inline') + '; filename="' + String(ev.filename || 'evidence').replace(/[\\/:*?"<>|]+/g, '-') + '"', 'Cache-Control': 'private, max-age=3600' });
      res.end(Buffer.from(ev.data, 'base64')); return true;
    }
    if (p === '/api/version' && method === 'GET') { J(res, 200, { version: getVersion() }); return true; }
    // 📧 recruitment-email OPEN TRACKING pixel: an <img> in the outreach email hits this; we flip
    // email_opened on the outreach_recipients row (syncs back to the desktop report) and return a
    // 1×1 transparent GIF. No auth — it's a pixel; it only ever SETS a boolean flag.
    if (method === 'GET' && p === '/api/track/open') {
      try {
        const rid = u.searchParams.get('r');
        if (rid && typeof update === 'function') { const rec = one('outreach_recipients', rid); if (rec && !rec.email_opened) update('outreach_recipients', rid, { email_opened: 1, email_opened_at: new Date().toISOString() }); }
      } catch (_) { /* never let tracking break */ }
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Content-Length': gif.length });
      res.end(gif); return true;
    }
    // Serve the offline face-recognition engine to the student's browser (no CDN — works on LAN / APK).
    // Disk first (Node hub / desktop); OBJECT STORAGE fallback (key face/…) for serverless hosts whose
    // filesystem can't carry the ~13 MB engine — the one-click deploy uploads the assets to R2 so face
    // check-in works on the cloud portal too.
    // faceAsset: disk (Node hub / desktop) → 302 to a presigned storage URL (serverless: the browser
    // pulls the ~13 MB engine straight from R2/Storage, never through the isolate) → proxy fallback.
    const faceAsset = async (rel, mime) => {
      const fp = faceFile(rel);
      if (fp) { try { const buf = fs.readFileSync(fp); res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=604800' }); res.end(buf); return true; } catch (_) {} }
      const key = 'face/' + rel.split(path.sep).join('/');
      if (typeof blobUrl === 'function') {
        try { let url = blobUrl(key); if (url && typeof url.then === 'function') url = await url; if (url) { res.writeHead(302, { 'Location': url, 'Cache-Control': 'public, max-age=3000' }); res.end(); return true; } } catch (_) {}
      }
      const buf = await resolveBlob(null, key);
      if (!buf) return J(res, 404, { ok: false, error: 'face asset not available' });
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=604800' }); res.end(buf); return true;
    };
    // Serve the offline face-recognition engine to the student's browser (no CDN — works on LAN / APK).
    if (method === 'GET' && p === '/vendor/face-api.min.js') return faceAsset('face-api.min.js', 'application/javascript; charset=utf-8');
    // Serve a model weight/manifest file.
    if (method === 'GET' && p.startsWith('/face-models/')) {
      const name = path.basename(p.slice('/face-models/'.length));   // basename = no path traversal
      if (!/^[\w.\-]+$/.test(name)) return J(res, 400, { ok: false });
      return faceAsset(path.join('models', name), name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    }
    // Is a live class still running? The (already-open) student class page polls this and auto-leaves the
    // moment the host ends it — otherwise the class kept running on the APK after the lecturer ended it.
    // `ended` is true only once a session for this room existed and is no longer active, so a scheduled
    // class a student opened with no host session is never force-closed. (Room id is a secret capability.)
    if (p === '/api/class-live' && method === 'GET') {
      const room = u.searchParams.get('room') || '';
      sweepStaleLive();   // end any abandoned (heartbeat stopped, or >3h) live session at the source
      const now = Date.now();
      const recentCut = new Date(now - 12 * 60 * 60 * 1000).toISOString();
      const rows = all('live_sessions').filter(v => !v.deleted && v.room === room && String(v.started_at || '') >= recentCut);
      const live = rows.some(v => isSessionLive(v, now));
      const ended = !live && rows.length > 0;
      return J(res, 200, { ok: true, live, ended });
    }
    if (p === '/api/branding' && method === 'GET') {
      const i = inst();
      // expose the campus list publicly so the login page can let a student pick the campus they belong to
      const campuses = all('campuses').filter(c => !c.deleted).sort((a, b) => (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0)).map(c => ({ id: c.id, name: c.name }));
      // licensed — v2: CRYPTOGRAPHICALLY computed from vendor-signed artifacts (licenseState), not a
      // trusted boolean. The signed token is exposed so the mobile app verifies it independently too.
      const licState = licenseState();
      const licensed = licState.licensed;
      // SLIM mode (?slim=1): return the heavy images (logo/login_bg/favicon can be 100s of KB of
      // base64) as tiny CACHEABLE URLs instead of inline blobs, so the JSON is small and the NAME
      // appears instantly even on a slow link — the images then load as normal cached images. The
      // portal page uses this; the mobile app (Coil) does too. The default (inline) stays for any
      // older client. A ?v= cache-buster keyed to the branding version busts the CDN on rebrand.
      const slim = u.searchParams.get('slim') === '1';
      const ver = String(getVersion() || 0);
      const assetUrl = (field, val) => (val ? ('/api/branding/asset/' + field + '?v=' + ver) : '');
      const logo = slim ? assetUrl('logo', i.logo) : (i.logo || '');
      const login_bg = slim ? assetUrl('login_bg', i.login_bg) : (i.login_bg || '');
      const favicon = slim ? assetUrl('favicon', i.favicon) : (i.favicon || '');
      return J(res, 200, { ok: true, name: i.name, short: i.short, logo, motto: i.motto, language: i.language || '', i18n_custom: i.i18n_custom || '', i18n_langs: i.i18n_langs || '', campuses, licensed,
        // signed licensing proof for the mobile app (it verifies the Ed25519 signature itself)
        license_lid: licState.lid || '', license_token: licState.token || '', license_status: licState.status || '',
        // per-university theme so the web portal + APK colour their UI to match the institution
        primary: i.primary || '', accent: i.accent || '', login_bg, favicon });
    }
    // Cacheable branding image (logo / login_bg / favicon) decoded from the branding blob — lets the
    // slim /api/branding stay tiny while the image loads once and caches for a day.
    if (method === 'GET' && p.startsWith('/api/branding/asset/')) {
      const field = p.slice('/api/branding/asset/'.length);
      if (!['logo', 'login_bg', 'favicon', 'seal', 'signature', 'letterhead', 'watermark'].includes(field)) return J(res, 404, { ok: false });
      const val = inst()[field];
      const m = /^data:([^;]+);base64,(.*)$/.exec(String(val || ''));
      if (!m) return J(res, 404, { ok: false, error: 'not set' });
      res.writeHead(200, { 'Content-Type': m[1] || 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      res.end(Buffer.from(m[2], 'base64')); return true;
    }

    // ---- installable app assets + public clearance verification (no login) ----
    if (method === 'GET' && p === '/manifest.webmanifest') return S(res, 200, MANIFEST_PORTAL, 'application/manifest+json');
    if (method === 'GET' && p === '/scan-manifest.webmanifest') return S(res, 200, MANIFEST_SCAN, 'application/manifest+json');
    if (method === 'GET' && p === '/sw.js') return S(res, 200, SW_JS, 'application/javascript');
    // Favicon / app icon = the university LOGO (falls back to a branded monogram).
    const monogramSvg = () => { const i = inst(); const init = String(i.short || i.name || 'U').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'U';
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#4338ca"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="41" font-family="Segoe UI,Arial,sans-serif" font-size="${init.length > 2 ? 20 : 26}" font-weight="800" fill="#fff" text-anchor="middle">${esc(init)}</text></svg>`; };
    if (method === 'GET' && (p === '/favicon' || p === '/favicon.ico' || p === '/favicon.png')) {
      const i = inst();
      const m = /^data:([^;]+);base64,(.+)$/.exec(i.logo || '');
      if (m) { res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'no-cache' }); res.end(Buffer.from(m[2], 'base64')); return true; }
      if (i.logo && /^https?:/i.test(i.logo)) { res.writeHead(302, { Location: i.logo }); res.end(); return true; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' }); res.end(monogramSvg()); return true;
    }
    if (method === 'GET' && p === '/icon.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' }); res.end(monogramSvg()); return true; }
    if (method === 'GET' && p === '/scan') return H(res, 200, SCAN_PAGE);
    if (method === 'GET' && p === '/verify') return H(res, 200, VERIFY_PAGE);
    if (method === 'GET' && p === '/api/verify') {
      let sid = u.searchParams.get('student') || '';
      if (sid) { // a student ID-card link/QR
        const msd = /[?&]student=([^&\\s]+)/.exec(sid); if (msd) sid = decodeURIComponent(msd[1]);
        return J(res, 200, { ok: true, ...verifyStudent(sid.trim()) });
      }
      let pid = u.searchParams.get('p') || '';
      if (pid) { // a payslip code/link
        const mp = /[?&]p=([^&\\s]+)/.exec(pid); if (mp) pid = decodeURIComponent(mp[1]);
        pid = pid.replace(/^UBU-PSL:/i, '').trim();
        return J(res, 200, { ok: true, ...verifyPayslip(pid) });
      }
      let sres = u.searchParams.get('res') || '';
      if (sres) { // a result statement link
        const ms = /[?&]res=([^&\\s]+)/.exec(sres); if (ms) sres = decodeURIComponent(ms[1]);
        const ses = u.searchParams.get('ses') || ''; const sem = u.searchParams.get('sem') || '';
        return J(res, 200, { ok: true, ...verifyResult(sres + ((ses || sem) ? ('|' + ses + '|' + sem) : '')) });
      }
      let rid = u.searchParams.get('r') || '';
      if (rid) { // a receipt code/link
        const mr = /[?&]r=([^&\\s]+)/.exec(rid); if (mr) rid = decodeURIComponent(mr[1]);
        rid = rid.replace(/^UBU-RCT:/i, '').trim();
        return J(res, 200, { ok: true, ...verifyReceipt(rid) });
      }
      let id = u.searchParams.get('c') || u.searchParams.get('ref') || '';
      const m = /[?&]c=([^&\\s]+)/.exec(id); if (m) id = decodeURIComponent(m[1]);   // a full URL was scanned
      id = id.replace(/^UBU-CLR:/i, '').trim();
      return J(res, 200, { ok: true, ...verifyClearance(id) });
    }

    // 🔎 external CREDENTIAL verification (transcript + certificate) — public, no login
    if (method === 'GET' && p === '/verify-credentials') return H(res, 200, VERIFY_CREDENTIALS_PAGE);
    if (method === 'POST' && p === '/api/verify-credentials') {
      const body = await readBody();
      // 🛡 throttle BEFORE the lookup — the whole point is to stop a scraper walking the matric space, so
      // it must cost the same whether the matric exists or not.
      const vWait = verifyThrottle(req);
      if (vWait) return J(res, 200, { ok: false, error: `Too many verification attempts from this connection. Please try again in about ${vWait} minute(s), or contact the Registry directly for bulk verification.` });
      const vKey = String((body && body.matric) || '').trim().slice(0, 80);
      if (!vKey) return J(res, 200, { ok: false, error: 'Enter the student matric number, or the verification code printed on the document.' });
      if (!String((body && body.email) || '').trim() || !/@/.test(String(body.email))) return J(res, 200, { ok: false, error: 'Enter a valid e-mail address so the record of this verification reaches you.' });
      // consent / lawful-basis attestation (data-protection best practice — verifiers confirm they
      // have the graduate's consent or another lawful basis before pulling their academic record).
      if (!body.consent) return J(res, 200, { ok: false, error: 'Please confirm you have the student’s consent or another lawful basis to verify their credentials.' });
      const r = verifyCredentials(vKey);
      logVerification(Object.assign({}, body, { channel: normCode(vKey) ? 'code' : 'matric' }), r);
      if (!r.valid) return J(res, 200, { ok: true, valid: false, contact: instContact() });
      const out = Object.assign({}, r); delete out._sid;                              // never leak the internal id
      await enrichFingerprints(out);                                                  // tamper-evident document fingerprints
      return J(res, 200, { ok: true, ...out });
    }
    // 🔐 TAMPER CHECK — a verifier uploads the transcript/certificate FILE they received and we confirm
    // whether that EXACT file was issued by the registry (its SHA-256 matches an issued document), or
    // whether it has been altered / was never issued. This is how a forged grade is caught.
    if (method === 'POST' && p === '/api/verify-credentials/check-file') {
      const body = await readBody();
      const wait = verifyThrottle(req);
      if (wait) return J(res, 200, { ok: false, error: `Too many verification attempts from this connection. Please try again in about ${wait} minute(s).` });
      // The matric is now OPTIONAL: the document's own bytes identify it. A verifier who was handed a PDF
      // and nothing else can still authenticate it — which is the situation they are actually in.
      const matric = String((body && body.matric) || '').trim().slice(0, 80);
      const fileB64 = String((body && body.file) || '').replace(/^data:[^;]+;base64,/, '');
      if (!fileB64) return J(res, 200, { ok: false, error: 'Upload the document file you received.' });
      // Size cap BEFORE decoding — the client's check is not a security boundary, and a huge base64 body
      // would otherwise be decoded straight into memory here.
      // 21e6 base64 chars ≈ 15 MB of file. This ceiling is NOT arbitrary: server.js's readBody destroys
      // the request at 24 MB of raw body, so anything above that never reaches this handler at all — the
      // verifier just sees a dead connection. Base64 inflates a file by ~4/3, so the largest file that can
      // survive the transport is ~17 MB; 15 MB keeps a margin and lets us fail with a SENTENCE instead of
      // a reset. Raising it here alone would only move the silent failure, not fix it.
      if (fileB64.length > 21e6) return J(res, 200, { ok: false, error: 'That file is too large (maximum 15 MB). If the document is genuinely larger, please contact the Registry.' });
      let hash = '', fileBuf = null;
      try {
        fileBuf = Buffer.from(fileB64, 'base64');
        if (!fileBuf.length) throw new Error('empty');
        hash = sha256Hex(fileBuf);
      } catch (_) { return J(res, 200, { ok: false, error: 'That file could not be read — upload the original PDF you received.' }); }
      const shown = groupFp(hash.slice(0, 16).toUpperCase());
      // 🫥 the invisible seal travels IN the bytes — read it regardless of what the hash says
      const seal = sealOfBuffer(fileBuf);
      const sealOut = seal.present ? { present: true, valid: !!seal.valid, reason: seal.reason || '' } : { present: false };

      // 1️⃣ identify the FILE against the whole registry — authoritative, and needs no matric.
      const hit = await docByHash(hash);
      const v = matric ? verifyCredentials(matric) : { valid: false };
      logVerification(Object.assign({}, body, { channel: matric ? 'file-check' : 'file-only' }), hit ? { valid: true, _sid: hit.student_id } : v);

      if (hit) {
        const st = one('students', hit.student_id);
        const holder = st ? ([st.first_name, st.middle_name, st.last_name].map(x => String(x || '').trim()).filter(Boolean).join(' ') || 'Unknown') : 'Unknown';
        const newer = supersededBy(hit);
        // 2️⃣ cross-check: the file IS genuine, but is it the person the verifier was told it belongs to?
        // A real transcript presented under someone else's matric is a specific, serious fraud — and it
        // would read as "genuine" if we only ever asked whether the bytes were issued.
        const mismatch = !!(matric && v.valid && v._sid !== hit.student_id);
        return J(res, 200, {
          ok: true, valid: true, match: !mismatch, identified: true, mismatch,
          superseded: !!newer,
          supersededAt: newer ? (newer.created_at || '') : '',
          document: { label: labelOfKind(hit.auto_kind), issuedAt: hit.created_at || '', code: docCode(hit.id), office: hit.office || 'Office of the Registrar' },
          student: { name: holder, matric: (st && st.matric_no) || '—' },
          claimed: mismatch ? { name: v.student.name, matric: v.student.matric } : null,
          fingerprint: shown, seal: sealOut,
        });
      }
      // 2️⃣b no byte-exact match, but a VALID invisible seal — the origin is cryptographically proven.
      // Two sub-cases, distinguished so we never cry "altered" at a legitimate copy:
      //   • the seal names a SPECIFIC issued row (doc_id) → the bytes should have matched it but didn't
      //     → that exact document was ALTERED (edited grade, re-saved). The sharp fraud signal.
      //   • the seal has NO doc_id (an officer's directly-saved/emailed copy, a translation) → the file
      //     is GENUINE and origin-verified; there is simply no single stored row to byte-compare against.
      if (seal.valid) {
        const st = seal.studentId ? one('students', seal.studentId) : null;
        const holder = st ? ([st.first_name, st.middle_name, st.last_name].map(x => String(x || '').trim()).filter(Boolean).join(' ') || 'Unknown') : '';
        const row = seal.docId ? one('portal_documents', seal.docId) : null;
        const altered = !!(row && !row.deleted);                     // a real issued row, but the bytes differ
        return J(res, 200, {
          ok: true, valid: true, match: false, identified: false, sealIdentified: true, altered,
          document: { label: labelOfKind(seal.kind), issuedAt: seal.issuedAt || '', code: seal.docId ? docCode(seal.docId) : '' },
          student: st ? { name: holder, matric: st.matric_no || '—' } : null,
          fingerprint: shown, seal: sealOut, contact: instContact(),
        });
      }
      // 3️⃣ the bytes match nothing this institution ever issued.
      if (matric && !v.valid) return J(res, 200, { ok: true, valid: false, contact: instContact(), fingerprint: shown, seal: sealOut });
      return J(res, 200, {
        ok: true, valid: true, match: false, identified: false, superseded: false,
        document: null,
        student: v.valid ? { name: v.student.name, matric: v.student.matric } : null,
        fingerprint: shown, seal: sealOut, contact: instContact(),
      });
    }
    if (method === 'POST' && p === '/api/verify-credentials/copy') {
      const body = await readBody();
      // this endpoint MAILS real credential documents — it is throttled on the same budget as the lookups
      // so it can't be turned into a bulk document tap (or a mail-flood aimed at a third party).
      const cWait = verifyThrottle(req);
      if (cWait) return J(res, 200, { ok: false, error: `Too many requests from this connection. Please try again in about ${cWait} minute(s).` });
      const matric = String((body && body.matric) || '').trim().slice(0, 80);
      const to = String((body && body.email) || '').trim().slice(0, 160);
      if (!matric || !to || !/@/.test(to)) return J(res, 200, { ok: false, error: 'A matric number and a valid e-mail are required.' });
      const r = await emailCredentialCopies(matric, to, (body && body.name) || '', body && body.docs);
      if (r.ok) { try { const row = all('verification_requests').filter(x => x.matric === matric).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]; if (row) update('verification_requests', row.id, { emailed: 1, updated_at: new Date().toISOString() }); } catch (_) {} }
      return J(res, 200, r.ok
        ? { ok: true, attached: r.attached, message: `Sent ${r.attached} document(s) to ${to}.` }
        : { ok: false, error: r.error === 'no-documents' ? 'The published documents for this student are not available yet — please contact the Registry.' : (r.error === 'not-found' ? 'That matric number could not be verified.' : 'The mail service is not available right now. Please try again later.') });
    }

    if (p === '/api/login' && method === 'POST') {
      const body = await readBody();
      // license gate: an unactivated institution can't serve the portal/APK (defense-in-depth, not just UI)
      if (!licenseOk()) return J(res, 200, { ok: false, error: 'This institution’s software has not been activated. Please contact your administrator.' });
      const key = loginKey(req, body.login);
      const wait = loginBlocked(key);
      if (wait) return J(res, 200, { ok: false, error: `Too many failed attempts. Please wait about ${Math.ceil(wait / 60)} minute(s) and try again.` });
      const acc = findAccount(body.login);
      if (!acc || !verifyPass(body.password, passField(acc.kind, acc.row))) { loginFailed(key); return J(res, 200, { ok: false, error: 'Incorrect login or password. Students/parents: tap “First time or forgot password?” below to set your password using the matric number + email/phone on your record. Officers: sign in to the desktop app once first.', canRecover: acc ? (acc.kind === 'student' || acc.kind === 'parent') : true }); }
      // officer MFA: a 6-digit authenticator code is required after the password when enrolled
      if (acc.kind === 'user' && acc.row.mfa_enabled) {
        if (!body.code) return J(res, 200, { ok: false, mfaRequired: true, error: 'Enter the 6-digit code from your authenticator app.' });
        if (!totpVerify(acc.row.mfa_secret, body.code)) { loginFailed(key); return J(res, 200, { ok: false, mfaRequired: true, error: 'Incorrect authenticator code — try again.' }); }
      }
      loginOk(key);
      // Campus allocation: a student may pick the campus they belong to at login. We only SET it when the
      // student has no campus yet (allocates legacy/unassigned students); a student already pinned to a
      // campus keeps it (only an admin can move them). This ensures every student is allocated to a campus.
      if (acc.kind === 'student' && body.campus_id && !(acc.row.campus_id) && typeof update === 'function') {
        const camp = one('campuses', String(body.campus_id));
        if (camp && !camp.deleted) { try { update('students', acc.row.id, { campus_id: camp.id }); acc.row.campus_id = camp.id; } catch (_) {} }
      }
      const token = sign({ k: acc.kind, id: acc.row.id, role: acc.role, exp: Date.now() + 1000 * 60 * 60 * 12 });
      const name = (acc.kind === 'student') ? `${acc.row.first_name || ''} ${acc.row.last_name || ''}`.trim()
        : (acc.kind === 'parent') ? (acc.row.parent_name || 'Parent/Guardian') : acc.row.full_name;
      const campusName = acc.kind === 'student' && acc.row.campus_id ? nameOf('campuses', acc.row.campus_id) : null;
      return J(res, 200, { ok: true, token, user: { role: acc.role, kind: acc.kind, name, campus: campusName } });
    }

    // ---- SELF-SERVICE first-time / forgot password (students + parents) ----
    // A student/parent who never got (or lost) their emailed password can set one themselves by proving
    // identity with the email/phone on their record — so nobody is locked out when SMTP isn't set up.
    if (p === '/api/portal/recover' && method === 'POST') {
      const body = await readBody();
      if (!licenseOk()) return J(res, 200, { ok: false, error: 'This institution’s software has not been activated. Please contact your administrator.' });
      const key = loginKey(req, 'recover:' + (body.login || ''));
      if (loginBlocked(key)) return J(res, 200, { ok: false, error: 'Too many attempts — please wait a few minutes and try again.' });
      const login = String(body.login || '').trim().toLowerCase();
      const verify = String(body.verify || '').trim().toLowerCase();
      const newPassword = String(body.password || '');
      const asParent = body.role === 'parent';
      if (!login || !verify) return J(res, 200, { ok: false, error: 'Enter your matric number and the email or phone on your record.' });
      if (newPassword.length < 5) return J(res, 200, { ok: false, error: 'Your new password must be at least 5 characters.' });
      let stu = null;
      for (const s of all('students')) { if (s.deleted) continue; if ([s.matric_no, s.portal_username, s.email, s.parent_portal_username, s.parent_email].some(v => (v || '').toLowerCase() === login)) { stu = s; break; } }
      // GENERIC failure for BOTH "no such matric" and "contact mismatch" — never leak which matric numbers
      // exist or which contact field is correct (anti-enumeration). Rate-limited above.
      const fail = () => { loginFailed(key); return J(res, 200, { ok: false, error: 'We could not verify those details. Check your matric number and the exact email or phone the school has on your record, or contact the school office.' }); };
      if (!stu) return fail();
      // identity proof: the value they typed must match a contact field on file (student or parent set)
      const known = (asParent ? [stu.parent_email, stu.parent_phone, stu.parent_whatsapp] : [stu.email, stu.phone, stu.whatsapp, stu.parent_email])
        .map(v => (v || '').replace(/\s/g, '').toLowerCase()).filter(Boolean);
      if (!known.includes(verify.replace(/\s/g, ''))) return fail();
      if (typeof update !== 'function') return J(res, 200, { ok: false, error: 'Password reset is unavailable on this server — try again when online.' });
      loginOk(key);
      if (asParent) {
        const username = stu.parent_portal_username || (stu.matric_no ? 'p-' + stu.matric_no : 'par-' + String(stu.id).slice(0, 8));
        update('students', stu.id, { parent_portal_username: username, parent_portal_pass: hashPass(newPassword) });
        return J(res, 200, { ok: true, username, role: 'parent' });
      }
      const username = stu.portal_username || stu.matric_no || stu.email;
      update('students', stu.id, { portal_username: username, portal_pass: hashPass(newPassword) });
      return J(res, 200, { ok: true, username, role: 'student' });
    }

    // ================= EMAIL-BASED SELF-SERVICE RECOVERY (code to your inbox) =================
    // A student/parent who has forgotten BOTH their username AND password recovers using only the
    // email address on their record: we email a 6-digit code, they enter it with a new password, and
    // we sign them in and show their username. Deno/Node safe (no crypto.randomInt), rate-limited,
    // anti-enumeration. The code is stored (hashed, 15-min expiry) on the student row.
    const genResetCode = () => String(parseInt(crypto.randomBytes(4).toString('hex'), 16) % 1000000).padStart(6, '0');
    // Find the student row + role for a login that may be a matric no, username OR an email address.
    const findAccountFor = (login) => {
      login = String(login || '').trim().toLowerCase(); if (!login) return null;
      for (const s of all('students')) {
        if (s.deleted) continue;
        if ([s.matric_no, s.portal_username, s.email].some(v => (v || '').toLowerCase() === login)) return { s, role: 'student' };
        if ([s.parent_portal_username, s.parent_email].some(v => (v || '').toLowerCase() === login)) return { s, role: 'parent' };
      }
      return null;
    };
    const emailOf = (s, role) => (role === 'parent' ? s.parent_email : s.email) || '';
    const usernameOf = (s, role) => role === 'parent'
      ? (s.parent_portal_username || (s.matric_no ? 'p-' + s.matric_no : 'par-' + String(s.id).slice(0, 8)))
      : (s.portal_username || s.matric_no || s.email);

    // STEP 1 — email a reset code to the address on file.
    if (p === '/api/portal/reset-request' && method === 'POST') {
      const body = await readBody();
      if (!licenseOk()) return J(res, 200, { ok: false, error: 'This institution’s software has not been activated. Please contact your administrator.' });
      const key = loginKey(req, 'reset');
      if (loginBlocked(key)) return J(res, 200, { ok: false, error: 'Too many attempts — please wait a few minutes and try again.' });
      const login = String(body.login || '').trim();
      if (!login) return J(res, 200, { ok: false, error: 'Enter your matric number, username or email address.' });
      const hit = findAccountFor(login);
      const email = hit ? emailOf(hit.s, hit.role) : '';
      if (!hit || !email) { loginFailed(key); return J(res, 200, { ok: false, error: 'We could not find an account with an email on record for those details. Please contact your school office to recover your account.' }); }
      if (typeof update !== 'function' || typeof sendMail !== 'function') return J(res, 200, { ok: false, error: 'Email recovery is unavailable on this server. Use “I know my matric number” below, or contact your school office.' });
      const code = genResetCode();
      pruneResets();
      pwResets.set(hit.s.id, { h: hashPass(code), exp: Date.now() + RESET_TTL, role: hit.role });
      const i = inst();
      const nm = hit.role === 'parent' ? 'Parent/Guardian' : ((hit.s.first_name || '') + ' ' + (hit.s.last_name || '')).trim();
      const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;max-width:520px;margin:0 auto">`
        + `<div style="background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;padding:18px 22px;border-radius:14px 14px 0 0"><div style="font-weight:800;font-size:17px">${esc(i.name || 'University Portal')}</div><div style="opacity:.85;font-size:13px">Account recovery</div></div>`
        + `<div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 14px 14px;padding:22px">`
        + `<p>Dear ${esc(nm || 'Student')},</p><p>Use this code to reset your portal password. It expires in <b>15 minutes</b>.</p>`
        + `<div style="text-align:center;margin:18px 0"><div style="display:inline-block;background:#f1f5f9;border-radius:12px;padding:14px 26px;font-size:30px;font-weight:800;letter-spacing:8px;color:#1e3a8a">${esc(code)}</div></div>`
        + `<p style="color:#64748b;font-size:12.5px">If you did not request this, you can safely ignore this email — your password will not change.</p></div></div>`;
      try { await Promise.resolve(sendMail({ to: email, subject: `Your ${i.short || i.name || 'portal'} password reset code: ${code}`, html, text: `Your password reset code is ${code}. It expires in 15 minutes.` })); } catch (_) {}
      loginOk(key);
      return J(res, 200, { ok: true, sent: true, hint: maskEmail(email), role: hit.role });
    }

    // STEP 2 — verify the code and set a new password; signs them in on the client.
    if (p === '/api/portal/reset-confirm' && method === 'POST') {
      const body = await readBody();
      const key = loginKey(req, 'reset');
      if (loginBlocked(key)) return J(res, 200, { ok: false, error: 'Too many attempts — please wait a few minutes and try again.' });
      const login = String(body.login || '').trim();
      const code = String(body.code || '').replace(/\D/g, '');
      const newPassword = String(body.password || '');
      if (!login || !code) return J(res, 200, { ok: false, error: 'Enter the code we emailed you.' });
      if (newPassword.length < 5) return J(res, 200, { ok: false, error: 'Your new password must be at least 5 characters.' });
      const hit = findAccountFor(login);
      const fail = () => { loginFailed(key); return J(res, 200, { ok: false, error: 'That code is incorrect or has expired. Request a new one and try again.' }); };
      if (!hit) return fail();
      const saved = pwResets.get(hit.s.id);
      if (!saved || !saved.h || !saved.exp || Date.now() > saved.exp) { if (saved) pwResets.delete(hit.s.id); return fail(); }
      if (!verifyPass(code, saved.h)) return fail();
      const role = saved.role === 'parent' ? 'parent' : 'student';
      const username = usernameOf(hit.s, role);
      const patch = role === 'parent'
        ? { parent_portal_username: username, parent_portal_pass: hashPass(newPassword) }
        : { portal_username: username, portal_pass: hashPass(newPassword) };
      update('students', hit.s.id, patch);
      pwResets.delete(hit.s.id);                     // single-use
      loginOk(key);
      return J(res, 200, { ok: true, username, role });
    }

    // Forgot your USERNAME? Email it to the address on record (never revealed in the HTTP response).
    if (p === '/api/portal/username-reminder' && method === 'POST') {
      const body = await readBody();
      const key = loginKey(req, 'reset');
      if (loginBlocked(key)) return J(res, 200, { ok: false, error: 'Too many attempts — please wait a few minutes and try again.' });
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return J(res, 200, { ok: false, error: 'Enter the email address on your record.' });
      // collect every account (student + parent) that uses this email — a family may share one inbox
      const accounts = [];
      for (const s of all('students')) {
        if (s.deleted) continue;
        if ((s.email || '').toLowerCase() === email) accounts.push({ label: 'Student', username: usernameOf(s, 'student'), name: ((s.first_name || '') + ' ' + (s.last_name || '')).trim(), matric: s.matric_no || '' });
        if ((s.parent_email || '').toLowerCase() === email) accounts.push({ label: 'Parent/Guardian', username: usernameOf(s, 'parent'), name: ((s.first_name || '') + ' ' + (s.last_name || '')).trim(), matric: s.matric_no || '' });
      }
      if (accounts.length && typeof sendMail === 'function') {
        const i = inst();
        const rowsHtml = accounts.map(a => `<tr><td style="padding:7px 10px;border-bottom:1px solid #eef2f7">${esc(a.label)}${a.name ? ' — ' + esc(a.name) : ''}${a.matric ? ' (' + esc(a.matric) + ')' : ''}</td><td style="padding:7px 10px;border-bottom:1px solid #eef2f7;font-weight:800;color:#1e3a8a">${esc(a.username)}</td></tr>`).join('');
        const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;max-width:520px;margin:0 auto"><div style="background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;padding:18px 22px;border-radius:14px 14px 0 0"><div style="font-weight:800;font-size:17px">${esc(i.name || 'University Portal')}</div><div style="opacity:.85;font-size:13px">Your portal username</div></div><div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 14px 14px;padding:22px"><p>Here ${accounts.length > 1 ? 'are the usernames' : 'is the username'} linked to this email:</p><table style="width:100%;border-collapse:collapse;font-size:13.5px"><tbody>${rowsHtml}</tbody></table><p style="color:#64748b;font-size:12.5px;margin-top:14px">Forgot your password too? Use “Email me a reset code” on the sign-in screen.</p></div></div>`;
        try { await Promise.resolve(sendMail({ to: email, subject: `Your ${i.short || i.name || 'portal'} username`, html, text: accounts.map(a => a.label + ': ' + a.username).join('\n') })); } catch (_) {}
      }
      // generic response either way (anti-enumeration): don't reveal whether the email exists
      return J(res, 200, { ok: true, sent: true });
    }

    // ---- Online Admissions (public application portal, temporary-pass auth) ----
    if (p === '/apply' && method === 'GET') { return H(res, 200, APPLY_PAGE); }
    if (p === '/api/apply/programmes' && method === 'GET') { return J(res, 200, Object.assign({ ok: true }, programmesPayload())); }

    if (p === '/api/apply/start' && method === 'POST') {
      if (String(process.env.ADMISSIONS_OPEN || '1') === '0') return J(res, 200, { ok: false, error: 'Online admissions are currently closed.' });
      const body = await readBody();
      const first = String(body.first_name || '').trim(), last = String(body.last_name || '').trim(), email = String(body.email || '').trim();
      if (!first || !last) return J(res, 200, { ok: false, error: 'Enter your first and last name.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return J(res, 200, { ok: false, error: 'Enter a valid email address.' });
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Applications are not available on this server.' });
      const dept = body.department_id ? one('departments', body.department_id) : null;
      const fac = dept ? one('faculties', dept.faculty_id) : null;
      // the applicant's chosen campus; fall back to the campus of the programme's faculty when not picked
      const campusId = body.campus_id || (fac ? (fac.campus_id || null) : null);
      const id = crypto.randomUUID(); const passcode = genPasscode(); const now = new Date().toISOString();
      create('admission_applications', {
        id, app_no: genAppNo(), passcode_hash: hashPass(passcode),
        first_name: first, last_name: last, email, phone: String(body.phone || '').trim(),
        campus_id: campusId, faculty_id: dept ? dept.faculty_id : null, department_id: dept ? dept.id : (body.department_id || null), level_id: body.level_id || null, session_id: null,
        status: 'draft', stage: 1, admission_fee_paid: 0, deleted: 0, created_at: now, updated_at: now, origin_node: 'portal',
      });
      const startedApp = one('admission_applications', id);
      // email the applicant their application number + passcode + chosen programme/campus, so they have
      // their details on record and can log back in to finish + track their admission status.
      mailApplicant(startedApp, `Your application to ${inst().name || 'University'} — ${startedApp.app_no}`,
        `<p>Dear ${esc(first)},</p><p>Thank you for starting your application. Please keep your details below safe — you will use the application number and passcode to log back in, complete your form, upload documents, and check your admission status at any time.</p>`
        + applicantSummary(startedApp)
        + `<div style="margin:14px 0;padding:12px 14px;background:#f1f5f9;border-radius:10px"><div style="font-size:11px;color:#64748b;letter-spacing:.04em">APPLICATION NUMBER</div><div style="font-size:18px;font-weight:800;color:#1e3a8a">${esc(startedApp.app_no)}</div><div style="font-size:11px;color:#64748b;letter-spacing:.04em;margin-top:8px">PASSCODE</div><div style="font-size:18px;font-weight:800;letter-spacing:.08em">${esc(passcode)}</div></div>`
        + `<p style="color:#64748b;font-size:12px">If you did not start this application, you can safely ignore this email.</p>`);
      return J(res, 200, { ok: true, app_no: startedApp.app_no, passcode, token: applicantToken(id), application: appPublic(startedApp) });
    }

    if (p === '/api/apply/login' && method === 'POST') {
      const body = await readBody();
      const appNo = String(body.app_no || '').trim().toUpperCase();
      const key = loginKey(req, 'apply:' + appNo);
      const wait = loginBlocked(key);
      if (wait) return J(res, 200, { ok: false, error: `Too many failed attempts. Please wait about ${Math.ceil(wait / 60)} minute(s) and try again.` });
      const a = all('admission_applications').find(x => !x.deleted && String(x.app_no || '').toUpperCase() === appNo);
      if (!a || !verifyPass(body.passcode, a.passcode_hash)) { loginFailed(key); return J(res, 200, { ok: false, error: 'Invalid application number or passcode.' }); }
      loginOk(key);
      return J(res, 200, { ok: true, token: applicantToken(a.id), application: appPublic(a) });
    }

    if (p === '/api/apply/me' && method === 'GET') { const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false }); return J(res, 200, { ok: true, application: appPublic(a) }); }

    if (p === '/api/apply/save' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      if (a.status !== 'draft' && a.status !== 'submitted') return J(res, 200, { ok: false, error: 'This application can no longer be edited.' });
      const body = await readBody();
      const allowed = ['first_name', 'last_name', 'middle_name', 'email', 'phone', 'gender', 'date_of_birth', 'address', 'nationality', 'state_of_origin', 'campus_id', 'department_id', 'level_id', 'jamb_no', 'jamb_score', 'olevel', 'prev_school', 'qualifications', 'guardian_name', 'guardian_email', 'guardian_phone', 'guardian_relation', 'stage'];
      const patch = {}; for (const k of allowed) if (k in body) patch[k] = body[k];
      if (patch.department_id) { const d = one('departments', patch.department_id); if (d) { patch.faculty_id = d.faculty_id; const f = one('faculties', d.faculty_id); if (f && !patch.campus_id) patch.campus_id = f.campus_id || null; } }
      if (patch.olevel && typeof patch.olevel !== 'string') patch.olevel = JSON.stringify(patch.olevel);
      if (patch.qualifications && typeof patch.qualifications !== 'string') patch.qualifications = JSON.stringify(patch.qualifications);
      if (typeof update === 'function') update('admission_applications', a.id, patch);
      return J(res, 200, { ok: true, application: appPublic(one('admission_applications', a.id)) });
    }

    if (p === '/api/apply/doc' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      const body = await readBody();
      if (!body.content || !/^data:/.test(String(body.content))) return J(res, 200, { ok: false, error: 'No file received.' });
      if (String(body.content).length > 8 * 1024 * 1024) return J(res, 200, { ok: false, error: 'File too large (about 6MB max).' });
      const id = crypto.randomUUID(); const now = new Date().toISOString();
      const prior = all('admission_documents').find(d => d.application_id === a.id && d.kind === body.kind && !d.deleted);
      if (prior && typeof update === 'function') update('admission_documents', prior.id, { deleted: 1 });
      if (typeof create === 'function') create('admission_documents', { id, application_id: a.id, kind: String(body.kind || 'other'), filename: String(body.filename || 'upload'), content: String(body.content), uploaded_at: now, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      return J(res, 200, { ok: true, application: appPublic(one('admission_applications', a.id)) });
    }

    if (p === '/api/apply/doc/delete' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      const body = await readBody(); const d = body.id ? one('admission_documents', body.id) : null;
      if (d && d.application_id === a.id && typeof update === 'function') update('admission_documents', d.id, { deleted: 1 });
      return J(res, 200, { ok: true, application: appPublic(one('admission_applications', a.id)) });
    }

    if (p === '/api/apply/submit' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      if (!a.first_name || !a.last_name || !a.email || !a.department_id) return J(res, 200, { ok: false, error: 'Please complete your name, email and chosen programme before submitting.' });
      const now = new Date().toISOString();
      const firstSubmit = a.status !== 'submitted'; // only alert the desk on the first submission
      if (typeof update === 'function') update('admission_applications', a.id, { status: 'submitted', submitted_at: a.submitted_at || now, stage: 6 });
      // Notify the admissions desk (registrar + admin). The notification is a normal SYNCED row, so it
      // shows up in the officer's 🔔 bell on the desktop (and any other signed-in machine) the moment it
      // syncs — no extra wiring needed. create() mirrors it to the cloud so it reaches cloud-sync desktops.
      if (firstSubmit && typeof create === 'function') {
        try {
          const dept = a.department_id ? nameOf('departments', a.department_id) : '';
          const who = `${a.first_name || ''} ${a.last_name || ''}`.trim() || 'A new applicant';
          const body = who + (dept ? ` applied to ${dept}` : ' submitted an admission application') + (a.app_no ? ` (App. No. ${a.app_no})` : '');
          for (const role of ['registrar', 'admin']) {
            create('notifications', { id: crypto.randomUUID(), target_user: null, target_role: role, title: 'New admission application 🎓', body, type: 'admission', payload: JSON.stringify({ application_id: a.id, app_no: a.app_no }), is_read: 0, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
          }
        } catch (_) { /* notification is best-effort — never block the submission */ }
      }
      const submitted = one('admission_applications', a.id);
      // confirmation email on first submission: the applicant gets their full application summary and is
      // told they will be emailed when there is an update (offer / decision).
      if (firstSubmit) mailApplicant(submitted, `Application submitted — ${submitted.app_no}`,
        `<p>Dear ${esc(a.first_name || '')},</p><p>Your application has been <b>submitted successfully</b> and is now under review by the admissions office. Here is a summary of your application:</p>`
        + applicantSummary(submitted)
        + `<p style="margin-top:14px">We will email you as soon as there is an update on your application (for example, an offer of admission). You can also check your status anytime by logging back in with your application number and passcode.</p>`);
      return J(res, 200, { ok: true, application: appPublic(submitted) });
    }

    if (p === '/api/apply/pay' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      if (!(Number(a.admission_fee_amount) > 0)) return J(res, 200, { ok: false, error: 'No admission fee has been set yet. Please wait for your offer.' });
      const amount = Number(a.admission_fee_amount), currency = a.admission_fee_currency || 'NGN';
      const body = await readBody();
      const provider = pickProvider(body && body.provider);
      if (provider && gateway && gateway.providerAllowedForCurrency && !gateway.providerAllowedForCurrency(provider, currency)) {
        return J(res, 200, { ok: false, error: `That payment method is not accepted for ${currency}. Please choose another.` });
      }
      if (provider && gateway && a.email) {
        // anti-abuse: cap how many admission-fee checkouts ONE application can start in an hour
        try { const since = Date.now() - 60 * 60000; if (all('payment_intents').filter(x => !x.deleted && x.application_id === a.id && new Date(x.created_at || 0).getTime() >= since).length >= 12) return J(res, 200, { ok: false, error: 'Too many payment attempts. Please wait a little, or contact the Bursary.' }); } catch (_) {}
        const reference = 'ADM-' + provider.slice(0, 3).toUpperCase() + '-' + String(a.id).slice(0, 8) + '-' + Date.now();
        const base = buildBase(req);
        const r = await gateway.init(provider, {
          email: a.email, name: `${a.first_name || ''} ${a.last_name || ''}`.trim(),
          amount, currency, reference,
          callback_url: `${base}/api/apply/pay/callback?provider=${provider}&reference=${encodeURIComponent(reference)}`,
          webhook_url: `${base}/api/pay/webhook/${provider}`,
          title: `${inst().name || 'School'} — Admission fee`, metadata: { application_id: a.id, app_no: a.app_no, reference },
        });
        if (r.ok) {
          if (typeof update === 'function') update('admission_applications', a.id, { payment_ref: r.reference });
          // an intent makes the admission payment as robust as a student fee: the redirect, the webhook
          // AND the reconciliation sweep all settle the SAME payment (idempotent), so a closed tab can't
          // lose a paid admission fee.
          createIntent({ reference: r.reference || reference, provider, provider_ref: r.provider_ref || r.reference || reference, application_id: a.id, category: 'admission', amount, currency, test_mode: paymentsTestMode(), ip: (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '') });
          return J(res, 200, { ok: true, mode: provider, provider, authorization_url: r.url, reference: r.reference, test_mode: paymentsTestMode() });
        }
        return J(res, 200, { ok: false, error: r.error || 'Could not start the online payment right now. Please try again later.' });
      }
      return J(res, 200, { ok: true, mode: 'manual', amount, currency, providers: gateway ? ((gateway.providersForCurrency) ? gateway.providersForCurrency(currency) : gateway.providers()) : [], bank: process.env.ADMISSION_BANK || 'Contact the Bursary for the bank account details, then declare your payment below.' });
    }

    if (p === '/api/apply/pay/declare' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      const body = await readBody();
      if (typeof update === 'function') update('admission_applications', a.id, { payment_ref: 'DECLARED:' + String(body.ref || 'bank transfer').slice(0, 60) });
      return J(res, 200, { ok: true, application: appPublic(one('admission_applications', a.id)) });
    }

    if (p === '/api/apply/pay/callback' && method === 'GET') {
      const provider = pickProvider(u.searchParams.get('provider'));
      const query = {}; u.searchParams.forEach((val, key) => { query[key] = val; });
      const intent = intentByReference(query.reference);
      const ref = resolveVerifyRef(provider, query, intent);
      let okPaid = false;
      if (provider && gateway && ref) {
        const v = await gateway.verify(provider, ref);
        if (v.ok) { const out = await settlePayment(provider, v, intent); okPaid = !!out.ok; }
      }
      return H(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#fff;text-align:center;padding:60px 20px"><div style="font-size:54px">${okPaid ? '✅' : '⚠️'}</div><h2>${okPaid ? 'Payment received' : 'Payment not confirmed'}</h2><p style="opacity:.8">${okPaid ? 'Your admission fee has been received. Your admission will be finalized shortly.' : 'We could not confirm your payment yet. If you were debited, it will reflect automatically once the bank confirms — or contact the Bursary.'}</p><a href="/apply" style="display:inline-block;margin-top:18px;background:#1e3a8a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Back to application</a></body>`);
    }

    // ---- Student fee payment (multi-provider: Paystack / Flutterwave / …) ----
    // providers → which gateways this deployment has configured, so the app/portal offers the right choices.
    if (p === '/api/pay/providers' && method === 'GET') {
      // a currency may accept only some gateways (admin-assigned) — offer the student exactly those.
      const cur = String(u.searchParams.get('currency') || '').toUpperCase();
      const list = gateway ? ((cur && gateway.providersForCurrency) ? gateway.providersForCurrency(cur) : gateway.providers()) : [];
      return J(res, 200, { ok: true, providers: list, enabled: list.length > 0, currency: cur || null, bank: process.env.FEES_BANK || inst().fees_bank || process.env.ADMISSION_BANK || '' });
    }

    // init → start a checkout with the chosen provider (the app/WebView opens the returned URL), or return
    // manual bank details when no gateway is configured. The student picks WHICH fee (category) to pay and
    // the amount is auto-debited from that fee — we re-derive what's owed and refuse an overpay.
    if (p === '/api/pay/init' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student to pay.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      const body = await readBody();
      const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
      const currency = String(body.currency || 'NGN').toUpperCase();
      const category = String(body.category || 'tuition').slice(0, 40);
      const provider = pickProvider(body.provider);
      if (!(amount > 0)) return J(res, 200, { ok: false, error: 'Enter a valid amount to pay.' });
      // accepted-method guard: the admin can restrict which gateways may take a given currency
      if (provider && gateway && gateway.providerAllowedForCurrency && !gateway.providerAllowedForCurrency(provider, currency)) {
        return J(res, 200, { ok: false, error: `That payment method is not accepted for ${currency}. Please choose another.` });
      }
      if (provider && gateway && s.email) {
        // auto-debit guard: never let an online payment exceed what the chosen fee still owes
        const owed = outstandingFor(s, category, currency);
        if (owed != null && amount > owed + 0.01) return J(res, 200, { ok: false, error: `You owe ${money(owed, currency)} for ${category}. Please enter ${money(owed, currency)} or less.` });
        // velocity / anti-abuse: cap how many checkouts a student can START in a short window
        if (recentIntentCount(s.id, 60) >= 12) return J(res, 200, { ok: false, error: 'Too many payment attempts in the last hour. Please wait a little, or contact the Bursary.' });
        const reference = 'STU-' + provider.slice(0, 3).toUpperCase() + '-' + String(s.id).slice(0, 8) + '-' + Date.now();
        const base = buildBase(req);
        // our reference rides on the callback URL so the redirect can find the intent for ANY provider
        const r = await gateway.init(provider, {
          email: s.email, name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), phone: s.phone || '',
          amount, currency, reference,
          callback_url: `${base}/api/pay/callback?provider=${provider}&reference=${encodeURIComponent(reference)}`,
          webhook_url: `${base}/api/pay/webhook/${provider}`,
          title: `${inst().name || 'School'} — ${category}`,
          metadata: { student_id: s.id, category, currency, charge_id: body.charge_id || null, reference },
        });
        if (r.ok) {
          createIntent({ reference: r.reference || reference, provider, provider_ref: r.provider_ref || r.reference || reference, student_id: s.id, category, amount, currency, test_mode: paymentsTestMode(), ip: (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '') });
          return J(res, 200, { ok: true, mode: provider, provider, authorization_url: r.url, reference: r.reference, test_mode: paymentsTestMode() });
        }
        return J(res, 200, { ok: false, error: r.error || 'Could not start the online payment right now. Please try again later.' });
      }
      return J(res, 200, { ok: true, mode: 'manual', amount, currency, bank: process.env.FEES_BANK || inst().fees_bank || process.env.ADMISSION_BANK || 'Online card payment is not enabled. Contact the Bursary for the bank account to pay into.' });
    }

    // callback → the provider redirects the WebView/browser here after payment. We VERIFY server-side (the
    // ONLY source of truth) and settle (record the student payment + email a temporary receipt + alert the
    // fee office), idempotently on the provider reference.
    if (p === '/api/pay/callback' && method === 'GET') {
      const provider = pickProvider(u.searchParams.get('provider'));
      const query = {}; u.searchParams.forEach((val, key) => { query[key] = val; });
      const intent = intentByReference(query.reference);
      const ref = resolveVerifyRef(provider, query, intent);
      let okPaid = false; let paidText = '';
      if (provider && gateway && ref) {
        const v = await gateway.verify(provider, ref);
        if (v.ok) { const out = await settlePayment(provider, v, intent); if (out.ok) { okPaid = true; if (out.payment) paidText = money(out.payment.amount, out.payment.currency); } }
      }
      return H(res, 200, payResultPage(okPaid, paidText));
    }

    // 📱 PAY STATUS (native app poll) → after the checkout WebView closes, the app polls this with its
    // reference to CONFIRM the payment reliably: it returns the settled receipt if one exists, else
    // actively RE-VERIFIES the intent against the gateway (so a payment settles even if the student
    // closed the WebView before the redirect, or the webhook is slow). Student-scoped + idempotent.
    if (p === '/api/pay/status' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      const reference = u.searchParams.get('reference') || '';
      const intent = intentByReference(reference);
      if (!intent || intent.student_id !== s.id) return J(res, 200, { ok: true, status: 'unknown' });
      const receiptFor = (pid) => { const pm = pid ? one('payments', pid) : null; return pm && !pm.deleted ? { id: pm.id, receipt_no: pm.receipt_no, amount: pm.amount, currency: pm.currency, category: pm.category } : null; };
      // already settled → return the receipt straight away
      if (intent.payment_id) { const rc = receiptFor(intent.payment_id); if (rc) return J(res, 200, { ok: true, status: 'paid', receipt: rc }); }
      // not settled yet → actively verify with the provider (the same source of truth the callback uses)
      const provider = pickProvider(intent.provider);
      if (provider && gateway) {
        const ref = resolveVerifyRef(provider, {}, intent);
        try {
          const v = await gateway.verify(provider, ref);
          if (v && v.ok) {
            const out = await settlePayment(provider, v, intent);
            if (out && out.ok) { const fresh = intentByReference(reference); const rc = receiptFor(fresh && fresh.payment_id); return J(res, 200, { ok: true, status: 'paid', receipt: rc || (out.payment ? { id: out.payment.id, receipt_no: out.payment.receipt_no, amount: out.payment.amount, currency: out.payment.currency } : null) }); }
          }
        } catch (_) { /* provider unreachable — report pending, the webhook/sweep will settle it */ }
      }
      return J(res, 200, { ok: true, status: String(intent.status) === 'paid' ? 'paid' : 'pending', reference });
    }

    // webhook → the provider's server-to-server notification (the robust confirmation path: it fires even
    // if the student closes the WebView before the redirect). We re-verify via the gateway API before
    // settling, so a forged/replayed webhook can never create or duplicate a payment. Always ack 200.
    if (p.startsWith('/api/pay/webhook/') && method === 'POST') {
      const provider = pickProvider(p.slice('/api/pay/webhook/'.length));
      let bodyObj = null; try { bodyObj = await readBody(); } catch (_) {}
      if (provider && gateway) {
        // SECURITY: the webhook body is only a TRIGGER. We pull the provider reference out of it and
        // ALWAYS re-verify the transaction against the provider's API with our secret key before
        // recording — so a forged/replayed webhook can neither create nor duplicate a payment. (Each
        // provider also ships a webhook-signature check in payments-gateway.js for deployments that
        // forward the raw body; the API re-verify here is the hard guarantee regardless.)
        const ref = gateway.webhookRef(provider, bodyObj);
        if (ref) {
          const v = await gateway.verify(provider, ref);
          if (v.ok) { const intent = intentByReference(v.reference); try { await settlePayment(provider, v, intent); } catch (_) {} }
        }
      }
      return J(res, 200, { ok: true });
    }

    if (p === '/api/reset-password' && method === 'POST') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      const body = await readBody();
      if (!verifyPass(body.oldPassword, passField(t.k, row))) return J(res, 200, { ok: false, error: 'Your current password is incorrect.' });
      if (!body.newPassword || String(body.newPassword).length < 5) return J(res, 200, { ok: false, error: 'New password must be at least 5 characters.' });
      if (typeof update !== 'function') return J(res, 200, { ok: false, error: 'Password reset is unavailable on this server.' });
      const field = t.k === 'parent' ? 'parent_portal_pass' : 'portal_pass';
      const entity = (t.k === 'student' || t.k === 'parent') ? 'students' : (t.k === 'user' ? 'users' : 'staff');
      const done = update(entity, t.id, { [field]: hashPass(body.newPassword) });
      return J(res, 200, { ok: !!done, error: done ? null : 'Could not save the new password.' });
    }

    // A graduate/student requests an official transcript or certificate. Creates a synced
    // transcript_requests row (reverse-syncs to the desktop Registry desk) + notifies the registrar.
    if (p === '/api/transcript-request' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student to request a document.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Document requests are not available on this server.' });
      const body = await readBody();
      const kind = (String(body.kind || 'transcript') === 'certificate') ? 'certificate' : 'transcript';
      // one open request per kind at a time
      const open = all('transcript_requests').find(r => r.student_id === s.id && r.kind === kind && !r.deleted && (r.status === 'pending' || r.status === 'approved'));
      if (open) return J(res, 200, { ok: false, error: `You already have a ${kind} request in progress.` });
      const id = crypto.randomUUID(); const now = new Date().toISOString();
      create('transcript_requests', { id, student_id: s.id, kind, purpose: String(body.purpose || '').slice(0, 200), delivery: 'email', recipient_email: String(body.recipient_email || s.email || '').slice(0, 120), status: 'pending', requested_by: 'portal', created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      const nm = `${s.first_name || ''} ${s.last_name || ''}`.trim();
      for (const role of ['registrar', 'admin', 'ict']) create('notifications', { id: crypto.randomUUID(), target_user: null, target_role: role, title: 'New transcript request 📜', body: `${nm} requested an official ${kind}.`, type: 'system', payload: JSON.stringify({ request_id: id }), is_read: 0, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      return J(res, 200, { ok: true, request: { id, kind, status: 'pending', date: now } });
    }

    // 📨 GRADUATE DOCUMENT DISPATCH — a GRADUATE sends their transcript / certificate / letters to a
    // government agency, university or employer. The documents go out from the OFFICE OF THE
    // REGISTRAR's email (never the student's), the send is logged for the registry, and the whole
    // feature is gated: graduates only, and the issued transcript + certificate must both exist —
    // otherwise the student is told to contact the Registrar.
    if (p === '/api/my/send-documents' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      const body = await readBody();
      // — graduate gate —
      const al = all('alumni').find(a => a.student_id === s.id && !a.deleted);
      const graduated = !!al || ['alumni', 'graduated'].includes(String(s.status || '').toLowerCase());
      if (!graduated) return J(res, 200, { ok: false, error: 'Only graduates of the university can send credentials to organizations. If you have graduated and still see this, please contact the Office of the Registrar.' });
      // — the transcript AND certificate must both be issued before ANY dispatch —
      const rowOf = (spec) => { for (const k of spec.kinds) { const d = all('portal_documents').filter(x => !x.deleted && x.student_id === s.id && x.auto_kind === k).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]; if (d) return d; } return null; };
      const core = ['transcript', 'certificate'].map(k => CREDENTIAL_DOCS.find(x => x.key === k));
      const missing = core.filter(spec => !rowOf(spec)).map(spec => spec.label);
      if (missing.length) return J(res, 200, { ok: false, error: `Your ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not yet available on your record. Please contact the Office of the Registrar for help before sending documents to an organization.` });
      // — validate the organization + selection —
      const ORG_TYPES = { government: 'Government agency', university: 'University / higher institution', institution: 'Other institution', employer: 'Employer', other: 'Organization' };
      const orgType = ORG_TYPES[String(body.orgType || '').toLowerCase()] ? String(body.orgType).toLowerCase() : 'other';
      const orgName = String(body.orgName || '').trim().slice(0, 140);
      const orgEmail = String(body.orgEmail || '').trim().slice(0, 160);
      if (!orgName) return J(res, 200, { ok: false, error: 'Enter the organization’s name.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(orgEmail)) return J(res, 200, { ok: false, error: 'Enter a valid email address for the organization.' });
      const wanted = (Array.isArray(body.docs) && body.docs.length ? body.docs.map(String) : ['transcript', 'certificate']).filter(k => CREDENTIAL_DOCS.some(x => x.key === k));
      if (!wanted.length) return J(res, 200, { ok: false, error: 'Select at least one document to send.' });
      // every SELECTED document must actually be issued
      const unavailable = wanted.map(k => CREDENTIAL_DOCS.find(x => x.key === k)).filter(spec => !rowOf(spec)).map(spec => spec.label);
      if (unavailable.length) return J(res, 200, { ok: false, error: `${unavailable.join(', ')} ${unavailable.length > 1 ? 'are' : 'is'} not yet issued on your record — untick ${unavailable.length > 1 ? 'them' : 'it'} or contact the Office of the Registrar for help.` });
      // — anti-abuse throttle: max 5 dispatches per day per student —
      const today = new Date().toISOString().slice(0, 10);
      const sentToday = all('verification_requests').filter(r => !r.deleted && r.student_id === s.id && r.verifier_type === 'graduate-dispatch' && String(r.created_at || '').slice(0, 10) === today).length;
      if (sentToday >= 5) return J(res, 200, { ok: false, error: 'You have reached today’s limit of 5 document dispatches. Try again tomorrow, or contact the Office of the Registrar.' });
      // — build the attachments (student-copy PDFs; inline file or blob storage) —
      const nmFull = [s.first_name, s.middle_name, s.last_name].map(x => String(x || '').trim()).filter(Boolean).join(' ');
      const safe = String(s.matric_no || 'graduate').replace(/[^a-z0-9]+/gi, '-');
      const atts = []; const sentLabels = [];
      for (const k of wanted) {
        const spec = CREDENTIAL_DOCS.find(x => x.key === k);
        const d = rowOf(spec); if (!d) continue;
        let b64 = d.file;
        if (!b64 && d.file_key) { const buf = await blobFetchLocal(d.file_key); if (buf) b64 = buf.toString('base64'); }
        if (b64) { atts.push({ filename: `${spec.label.replace(/[^a-z0-9]+/gi, '-')}-${safe}.pdf`, contentBase64: b64 }); sentLabels.push(spec.label); }
      }
      if (!atts.length) return J(res, 200, { ok: false, error: 'Your documents could not be retrieved right now — please try again shortly or contact the Office of the Registrar.' });
      // — send AS the Office of the Registrar —
      const i = inst();
      const from = registrarSender();
      const ref = 'GD-' + String(crypto.randomUUID()).replace(/-/g, '').slice(0, 8).toUpperCase();
      const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
        <p>Dear ${esc(orgName)},</p>
        <p>At the request of our graduate <b>${esc(nmFull)}</b> (Matric No. ${esc(s.matric_no || '—')}), the Office of the Registrar,
        <b>${esc(i.name || 'the University')}</b>, transmits the following official document${atts.length > 1 ? 's' : ''} for your records:</p>
        <ul>${sentLabels.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
        <p>These are watermarked student copies issued by this Office. To independently confirm their authenticity — or to request
        certified originals — please use the university's credential verification portal or contact this Office${from.email ? ` at ${esc(from.email)}` : ''},
        quoting reference <b>${esc(ref)}</b>.</p>
        <p style="color:#64748b;font-size:12.5px">Office of the Registrar · ${esc(i.name || '')}${from.email ? ' · ' + esc(from.email) : ''} · Ref ${esc(ref)}</p></div>`;
      let sent = false;
      try {
        const r = await Promise.resolve(sendMail({ to: orgEmail, subject: `Academic credentials of ${nmFull} (${s.matric_no || ''}) — ${i.short || i.name || 'University'} [${ref}]`, html, attachments: atts, fromName: from.name, replyTo: from.email, senderRole: 'registrar', senderUserId: from.userId }));
        sent = !!(r && r.ok !== false);
      } catch (_) { sent = false; }
      if (!sent) return J(res, 200, { ok: false, error: 'The mail service is not available right now. Please try again later or contact the Office of the Registrar.' });
      // — confirmation copy to the graduate (best-effort) + registry log + registrar notification —
      try { if (s.email) await Promise.resolve(sendMail({ to: s.email, subject: `Your documents were sent to ${orgName} [${ref}]`, html: `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a"><p>Dear ${esc(s.first_name || nmFull)},</p><p>As you requested, the Office of the Registrar has sent your ${esc(sentLabels.join(', '))} to <b>${esc(orgName)}</b> (${esc(orgEmail)}). Reference <b>${esc(ref)}</b>.</p><p>If you did not make this request, contact the Registrar immediately.</p></div>`, fromName: from.name, replyTo: from.email, senderRole: 'registrar', senderUserId: from.userId })); } catch (_) {}
      const now = new Date().toISOString();
      try {
        create('verification_requests', { id: crypto.randomUUID(), verifier_type: 'graduate-dispatch', verifier_name: `${ORG_TYPES[orgType]}: ${orgName}`.slice(0, 120), verifier_email: orgEmail, matric: s.matric_no || '', student_id: s.id, found: 1, emailed: 1, note: `ref ${ref} · sent: ${sentLabels.join(', ')}`.slice(0, 220), created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
        for (const role of ['registrar', 'admin']) create('notifications', { id: crypto.randomUUID(), target_user: null, target_role: role, title: '📨 Graduate document dispatch', body: `${nmFull} sent ${sentLabels.join(', ')} to ${orgName} (${orgEmail}). Ref ${ref}.`, type: 'system', payload: JSON.stringify({ student_id: s.id, ref }), is_read: 0, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      } catch (_) { /* logging is best-effort */ }
      return J(res, 200, { ok: true, ref, sent: sentLabels, message: `Sent ${sentLabels.join(', ')} to ${orgName} from the Office of the Registrar. Reference ${ref} — a confirmation copy is in your email.` });
    }

    // 🔎 A student reports a MISSING result or a WRONG score for a registered course. Creates a synced
    // result_fix_requests row (reverse-syncs to the desktop) where the AI locates the uploaded row and
    // auto-links it (or flags it for a human). Notifies the registrar/ICT.
    if (p === '/api/result-issue' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student to report a result.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Result reports are not available on this server.' });
      const body = await readBody();
      const ck = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const code = String(body.course_code || '').trim();
      if (!code) return J(res, 200, { ok: false, error: 'Pick the course you are reporting.' });
      // must be a course the student actually registered (never let a student conjure a random course)
      const reg = all('course_registrations').find(r => r.student_id === s.id && !r.deleted && r.status === 'registered' && ck(r.course_code) === ck(code));
      if (!reg) return J(res, 200, { ok: false, error: 'That course is not on your registered course list for this semester.' });
      const kind = String(body.kind || 'missing') === 'wrong_score' ? 'wrong_score' : 'missing';
      const now = new Date().toISOString();
      const tnoOf = (rid, pfx) => (pfx || 'RT') + '-' + String(rid || '').replace(/-/g, '').slice(-6).toUpperCase();
      const open = all('result_fix_requests').find(r => r.student_id === s.id && !r.deleted && ck(r.course_code) === ck(code) && (r.status === 'open' || r.status === 'not_found' || r.status === 'not_uploaded'));
      let id;
      if (open) { id = open.id; update('result_fix_requests', open.id, { kind, note: String(body.note || '').slice(0, 400), status: 'open', updated_at: now }); }
      else {
        id = crypto.randomUUID();
        create('result_fix_requests', { id, student_id: s.id, course_code: code, course_title: reg.course_title || '', session_id: s.current_session_id || null, semester_id: null, kind, note: String(body.note || '').slice(0, 400), status: 'open', confidence: 0, created_at: now, updated_at: now, resolved_at: null, resolved_by: null, deleted: 0, origin_node: 'portal' });
      }
      // 🎫 the ticket timeline starts HERE (visible on the portal instantly); the desktop AI adds the
      // "checked" step within minutes of sync and emails the student at every transition.
      create('ticket_events', { id: crypto.randomUUID(), kind: 'result', request_id: id, status: 'open', message: `Ticket opened for ${code} (${kind === 'wrong_score' ? 'wrong score' : 'missing result'}). The AI will check the uploaded sheets shortly.`, actor: 'portal', created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      const nm = `${s.first_name || ''} ${s.last_name || ''}`.trim();
      for (const role of ['registrar', 'ict', 'admin']) create('notifications', { id: crypto.randomUUID(), target_user: null, target_role: role, title: `🎫 ${tnoOf(id)} — result issue`, body: `${nm} reported a ${kind === 'wrong_score' ? 'wrong score' : 'missing result'} for ${code}.`, type: 'result', payload: JSON.stringify({ request_id: id, student_id: s.id, course: code, ticket: tnoOf(id) }), is_read: 0, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      return J(res, 200, { ok: true, ticket_no: tnoOf(id), message: `Ticket ${tnoOf(id)} opened. The AI is locating your ${code} result — you will be emailed at every update, and you can follow it under “My tickets” below.` });
    }

    // 🎫 the student's TICKETS (result + payment) with their full timelines — the portal/APK "My
    // tickets" view. Read from the synced tables, so desktop AI/staff updates appear on next sync.
    if (p === '/api/my-tickets' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      const tnoOf = (rid, pfx) => (pfx || 'RT') + '-' + String(rid || '').replace(/-/g, '').slice(-6).toUpperCase();
      const evByReq = {};
      for (const e of all('ticket_events')) { if (e.deleted) continue; const k = e.kind + '|' + e.request_id; (evByReq[k] = evByReq[k] || []).push({ status: e.status, message: e.message, at: e.created_at }); }
      const sortEv = (a, b) => String(a.at).localeCompare(String(b.at));
      const tickets = [];
      for (const r of all('result_fix_requests')) {
        if (r.deleted || r.student_id !== s.id) continue;
        tickets.push({ kind: 'result', id: r.id, ticket_no: tnoOf(r.id, 'RT'), title: `${r.course_code} — ${r.kind === 'wrong_score' ? 'wrong score' : 'missing result'}`, status: r.status, resolution: r.resolution || '', created_at: r.created_at, updated_at: r.updated_at, events: (evByReq['result|' + r.id] || []).sort(sortEv) });
      }
      for (const r of all('payment_fix_requests')) {
        if (r.deleted || r.student_id !== s.id) continue;
        tickets.push({ kind: 'payment', id: r.id, ticket_no: tnoOf(r.id, 'PT'), title: `Payment ${String(r.currency || 'NGN').toUpperCase()} ${Number(r.amount || 0).toLocaleString()}${r.reference ? ' · ref ' + r.reference : ''}`, status: r.status, resolution: r.resolution || '', created_at: r.created_at, updated_at: r.updated_at, events: (evByReq['payment|' + r.id] || []).sort(sortEv) });
      }
      // 🏦 manual bank-transfer claims ride the same timeline UI
      for (const r of all('manual_payments')) {
        if (r.deleted || r.student_id !== s.id) continue;
        tickets.push({ kind: 'manualpay', id: r.id, ticket_no: r.ticket_no || tnoOf(r.id, 'MP'), title: `Bank transfer ${String(r.currency || 'NGN').toUpperCase()} ${Number(r.amount || 0).toLocaleString()}${r.reference ? ' · ref ' + r.reference : ''}`, status: r.status, resolution: r.flag_reason || '', created_at: r.created_at, updated_at: r.updated_at, events: (evByReq['manualpay|' + r.id] || []).sort(sortEv) });
      }
      tickets.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return J(res, 200, { ok: true, tickets });
    }

    // 🏦 MANUAL BANK TRANSFER — the student sees the university's bank details, transfers, then
    // files a claim (payer/bank/amount/date/reference + a receipt upload). The DESKTOP AI reconciles
    // it against the bank's alert inbox every 30 minutes, the accountant gives second-layer approval,
    // and only then is the receipt issued. Everything lands on the 🎫 My Tickets timeline.
    if (p === '/api/manualpay/info' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const bank = inst().fees_bank || '';
      return J(res, 200, { ok: true, enabled: !!bank, bank, note: 'Put the ticket code you get after submitting — or your matric number — in the transfer narration so the bank alert matches instantly.' });
    }
    if (p === '/api/manualpay/submit' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Manual payments are not available on this server.' });
      const body = await readBody();
      const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
      if (!(amount > 0)) return J(res, 200, { ok: false, error: 'Enter the exact amount you transferred.' });
      if (!String(body.payer_name || '').trim()) return J(res, 200, { ok: false, error: 'Enter the name on the account that made the transfer.' });
      let receipt = String(body.receipt_base64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!receipt) return J(res, 200, { ok: false, error: 'Upload your payment receipt (photo or PDF).' });
      if (receipt.length > 8 * 1024 * 1024) return J(res, 200, { ok: false, error: 'The receipt file is too large (max ~6 MB).' });
      const rid = crypto.randomUUID();
      const ticketNo = 'MP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const now = new Date().toISOString();
      create('manual_payments', {
        id: rid, ticket_no: ticketNo, student_id: s.id,
        category: String(body.category || 'tuition').slice(0, 60), currency: String(body.currency || 'NGN').toUpperCase().slice(0, 6), amount,
        payer_name: String(body.payer_name || '').slice(0, 120), payer_bank: String(body.payer_bank || '').slice(0, 80),
        paid_at: String(body.paid_at || '').slice(0, 30), reference: String(body.reference || '').slice(0, 80), note: String(body.note || '').slice(0, 400),
        receipt, receipt_mime: String(body.receipt_mime || 'image/jpeg').slice(0, 60), receipt_name: String(body.receipt_name || 'receipt').slice(0, 120),
        status: 'submitted', created_at: now, updated_at: now, deleted: 0,
      });
      create('ticket_events', { id: crypto.randomUUID(), kind: 'manualpay', request_id: rid, status: 'submitted', message: 'Claim submitted from the portal — receipt attached. The AI reconciles it against the bank inbox every 30 minutes.', actor: 'student', created_at: now, updated_at: now, deleted: 0 });
      return J(res, 200, { ok: true, id: rid, ticket_no: ticketNo, message: 'Submitted! Ticket ' + ticketNo + ' — put this code (or your matric number) in your transfer narration next time for instant matching. You will get an email at every step, and your receipt appears here once verified.' });
    }

    // 💳 A student reports a PAYMENT that is not reflecting on their app/portal. Creates a synced
    // payment_fix_requests row; the desktop AI traces it (ledger → gateway intents → live verify) and
    // either credits it automatically or escalates to the bursary — emailing the student throughout.
    if (p === '/api/payment-issue' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student to report a payment.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Payment reports are not available on this server.' });
      const body = await readBody();
      const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
      if (!(amount > 0)) return J(res, 200, { ok: false, error: 'Enter the amount you paid.' });
      const now = new Date().toISOString();
      const tnoOf = (rid) => 'PT-' + String(rid || '').replace(/-/g, '').slice(-6).toUpperCase();
      // one open payment ticket per student at a time (a re-file updates the claim, keeping one thread)
      const open = all('payment_fix_requests').find(r => !r.deleted && r.student_id === s.id && (r.status === 'open' || r.status === 'not_found'));
      let id;
      if (open) { id = open.id; update('payment_fix_requests', open.id, { amount, currency: String(body.currency || 'NGN').toUpperCase().slice(0, 6), reference: String(body.reference || '').slice(0, 80), method: String(body.method || '').slice(0, 40), paid_at: body.paid_at || null, note: String(body.note || '').slice(0, 400), status: 'open', updated_at: now }); }
      else {
        id = crypto.randomUUID();
        create('payment_fix_requests', { id, student_id: s.id, amount, currency: String(body.currency || 'NGN').toUpperCase().slice(0, 6), reference: String(body.reference || '').slice(0, 80), method: String(body.method || '').slice(0, 40), paid_at: body.paid_at || null, note: String(body.note || '').slice(0, 400), status: 'open', resolution: null, matched_payment_id: null, created_at: now, updated_at: now, resolved_at: null, resolved_by: null, deleted: 0, origin_node: 'portal' });
      }
      create('ticket_events', { id: crypto.randomUUID(), kind: 'payment', request_id: id, status: 'open', message: `Ticket opened — ${String(body.currency || 'NGN').toUpperCase()} ${amount.toLocaleString()} reported as paid but not reflecting. The AI will trace it shortly.`, actor: 'portal', created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      const nm = `${s.first_name || ''} ${s.last_name || ''}`.trim();
      for (const role of ['accountant', 'admin']) create('notifications', { id: crypto.randomUUID(), target_user: null, target_role: role, title: `🎫 ${tnoOf(id)} — payment not reflecting`, body: `${nm}: ${String(body.currency || 'NGN').toUpperCase()} ${amount.toLocaleString()}${body.reference ? ' · ref ' + body.reference : ''}.`, type: 'payment', payload: JSON.stringify({ request_id: id, student_id: s.id, ticket: tnoOf(id) }), is_read: 0, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      return J(res, 200, { ok: true, ticket_no: tnoOf(id), message: `Ticket ${tnoOf(id)} opened. The system is tracing your payment — you will be emailed at every update, and you can follow it under “My tickets”.` });
    }

    // ---- Graduation FINAL CLEARANCE (student request + live progress tracking + project upload) ----
    // The portal reads the SYNCED clearance tables and computes the student's live owed so the desktop
    // never has to be online for the student to track progress, pay (reuses /api/pay) and upload.
    if (p === '/api/final-clearance' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      return J(res, 200, { ok: true, clearance: finalClearanceView(s) });
    }
    if (p === '/api/final-clearance/request' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Final clearance is unavailable on this server.' });
      if (s.status === 'alumni' || s.status === 'graduated') return J(res, 200, { ok: false, error: 'You have already graduated.' });
      if (!finalEligible(s)) return J(res, 200, { ok: false, error: 'Final clearance is only open to students in 300 level and above.' });
      const open = all('grad_clearances').find(c => !c.deleted && c.student_id === s.id && (c.status === 'requested' || c.status === 'active'));
      if (open) return J(res, 200, { ok: false, error: open.status === 'requested' ? 'Your request is already awaiting the Bursary.' : 'Your final clearance is already in progress.' });
      const id = crypto.randomUUID(); const now = new Date().toISOString();
      create('grad_clearances', { id, student_id: s.id, status: 'requested', stage: 'request', requested_at: now, requested_via: 'portal', created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      const nm = `${s.first_name || ''} ${s.last_name || ''}`.trim();
      create('notifications', { id: crypto.randomUUID(), target_user: null, target_role: 'accountant', title: '🎓 Final-clearance request', body: `${nm} (${s.matric_no || 'matric pending'}) requested final clearance.`, type: 'clearance', payload: JSON.stringify({ student_id: s.id, clearance_id: id }), is_read: 0, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      return J(res, 200, { ok: true, clearance: finalClearanceView(s) });
    }
    if (p === '/api/final-clearance/project' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      if (typeof create !== 'function' || typeof update !== 'function') return J(res, 200, { ok: false, error: 'Uploads are unavailable on this server.' });
      const clr = all('grad_clearances').find(c => !c.deleted && c.student_id === s.id && c.status === 'active');
      if (!clr) return J(res, 200, { ok: false, error: 'You have no active final clearance.' });
      const body = await readBody();
      let file = String(body.file || ''); const m = /^data:([^;]+);base64,(.*)$/.exec(file);
      const mime = body.mime || (m ? m[1] : 'application/octet-stream');
      if (m) file = m[2];
      if (!file) return J(res, 200, { ok: false, error: 'Attach your project document (PDF or Word).' });
      if (file.length > 11 * 1024 * 1024) return J(res, 200, { ok: false, error: 'File too large (about 8 MB max).' });
      if (!/pdf|word|officedocument|msword|octet-stream/i.test(mime) && !/\.(pdf|docx?)$/i.test(body.filename || '')) return J(res, 200, { ok: false, error: 'Upload a PDF, DOC or DOCX file.' });
      // one current project per student
      for (const old of all('portal_documents').filter(d => !d.deleted && d.student_id === s.id && d.auto_kind === 'project')) update('portal_documents', old.id, { deleted: 1 });
      const id = crypto.randomUUID(); const now = new Date().toISOString();
      create('portal_documents', { id, title: 'Final Year Project', category: 'Other', file, file_key: null, mime, filename: String(body.filename || 'project.pdf').slice(0, 120), faculty_id: s.faculty_id || null, department_id: s.department_id || null, level_id: s.level_id || null, student_id: s.id, auto_kind: 'project', uploaded_by: 'student', office: 'Student', session_id: null, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      update('grad_clearances', clr.id, { project_doc_id: id });
      create('notifications', { id: crypto.randomUUID(), target_user: null, target_role: 'registrar', title: 'Project submitted', body: `${(s.first_name || '') + ' ' + (s.last_name || '')} uploaded their final project.`, type: 'clearance', payload: JSON.stringify({ student_id: s.id }), is_read: 0, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      return J(res, 200, { ok: true, clearance: finalClearanceView(s) });
    }

    // A student appeals a malpractice flag ("the AI got the wrong person / it wasn't me"). Creates an
    // appeal row + marks the flag 'appealed' + notifies the exam officers — all of which sync to the
    // desktop so the officer reviews it. Ensures a wrongly-flagged student is never penalised silently.
    if (p === '/api/surveillance/appeal' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody();
      const flag = body.flag_id ? one('malpractice_flags', body.flag_id) : null;
      if (!flag || flag.deleted || flag.student_id !== t.id) return J(res, 404, { ok: false, error: 'Flag not found.' });
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Appeals are unavailable on this server.' });
      const existing = all('malpractice_appeals').find(a => !a.deleted && a.flag_id === flag.id && a.student_id === t.id && a.status === 'pending');
      if (existing) return J(res, 200, { ok: true, already: true });
      const now = new Date().toISOString();
      const id = 'mpa-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
      create('malpractice_appeals', { id, flag_id: flag.id, exam_id: flag.exam_id, student_id: t.id,
        reason: String(body.reason || 'misidentification').slice(0, 40), message: String(body.message || '').slice(0, 1500),
        status: 'pending', filed_at: now, created_at: now, updated_at: now, deleted: 0 });
      if (typeof update === 'function') update('malpractice_flags', flag.id, { status: 'appealed' });
      // notify the exam officers (shows on the desktop bell + sync)
      try {
        const sn = one('students', t.id); const nm = sn ? `${sn.first_name || ''} ${sn.last_name || ''}`.trim() : 'A student';
        create('notifications', { id: 'ntf-' + Math.random().toString(16).slice(2) + Date.now().toString(16), target_user: null, target_role: 'registrar',
          title: '📨 Exam-conduct appeal filed', body: nm + ' is appealing a malpractice flag (' + examTitleOf(flag.exam_id) + ')', type: 'system',
          payload: JSON.stringify({ appeal_flag: flag.id }), is_read: 0, created_at: now, updated_at: now, deleted: 0 });
      } catch (_) {}
      return J(res, 200, { ok: true });
    }

    // A student submits an evaluation survey. Writes an eval_responses row (reverse-syncs to the
    // desktop for anonymous aggregation). One response per student per survey; survey must be open
    // and for the student's cohort. The student_id is stored ONLY to dedupe — never shown in results.
    if (p === '/api/survey/submit' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student to submit an evaluation.' });
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Evaluations are not available on this server.' });
      const s = one('students', t.id); if (!s) return J(res, 401, { ok: false });
      const body = await readBody();
      const sv = body.survey_id ? one('eval_surveys', body.survey_id) : null;
      if (!sv || sv.deleted || sv.status !== 'open') return J(res, 404, { ok: false, error: 'Survey not found or closed.' });
      if ((sv.faculty_id && sv.faculty_id !== s.faculty_id) || (sv.department_id && sv.department_id !== s.department_id) || (sv.level_id && sv.level_id !== s.level_id))
        return J(res, 403, { ok: false, error: 'This survey is not for your cohort.' });
      if (all('eval_responses').some(r => !r.deleted && r.survey_id === sv.id && r.student_id === s.id)) return J(res, 200, { ok: true, already: true });
      // sanitize answers against the survey's own questions: ratings clamped to 1–5, text capped
      let questions = []; try { questions = JSON.parse(sv.questions || '[]'); } catch (_) {}
      const byId = {}; for (const q of (Array.isArray(questions) ? questions : [])) byId[q.id] = q;
      const raw = (body && body.answers) || {}; const answers = {};
      for (const qid of Object.keys(raw)) {
        const q = byId[qid]; if (!q) continue;
        if (q.type === 'text') { const v = String(raw[qid] || '').slice(0, 1500); if (v.trim()) answers[qid] = v; }
        else { const n = Math.round(Number(raw[qid])); if (n >= 1 && n <= 5) answers[qid] = n; }
      }
      const now = new Date().toISOString(); const id = crypto.randomUUID();
      create('eval_responses', { id, survey_id: sv.id, student_id: s.id, answers: JSON.stringify(answers), comment: String((body && body.comment) || '').slice(0, 1500), created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      return J(res, 200, { ok: true });
    }

    // ===== Online examinations =====
    // Student: list the exams available to them (also in /api/data.exams; this is for polling).
    if (p === '/api/exam/active' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const s = one('students', t.id); if (!s) return J(res, 401, { ok: false });
      // sweep this student's own attempts so a self-paced exam they closed at the buzzer is still finalised
      for (const a of all('exam_attempts')) { if (!a.deleted && a.student_id === t.id && a.status === 'in_progress') { const e = one('online_exams', a.exam_id); if (e) autoCloseExpiredAttempts(e); } }
      return J(res, 200, { ok: true, exams: examsForStudent(s) });
    }
    // Student: start (or resume) an attempt → shuffled questions (NO answers) + a server-authoritative end time.
    if (p === '/api/exam/start' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const s = one('students', t.id);
      const e = body.exam_id ? one('online_exams', body.exam_id) : null;
      if (!e || !examVisibleTo(e, s)) return J(res, 404, { ok: false, error: 'Exam not found.' });
      const win = winState(Date.now(), e.start_at, e.end_at);
      if (win === 'upcoming') return J(res, 200, { ok: false, error: 'This exam has not started yet.' });
      if (win === 'closed' || e.status === 'ended') return J(res, 200, { ok: false, error: 'This exam has closed.' });
      // WAITING ROOM: the invigilator must START the live session before students can begin.
      if (e.status !== 'live') {
        const resume = all('exam_attempts').find(a => !a.deleted && a.exam_id === e.id && a.student_id === t.id && a.status === 'in_progress');
        if (!resume) return J(res, 200, { ok: false, waiting: true, error: 'The invigilator has not started this exam yet. Please wait — it will begin shortly.' });
      }
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Exams are unavailable on this server.' });
      let at = all('exam_attempts').find(a => !a.deleted && a.exam_id === e.id && a.student_id === t.id);
      const now = new Date().toISOString();
      if (at && at.status === 'voided') return J(res, 200, { ok: false, error: 'This exam was ended because you left the exam app. It was voided and cannot be retaken — contact the exam officer if you believe this is a mistake.' });
      if (at && (at.status === 'submitted' || at.status === 'auto_submitted' || at.status === 'graded')) return J(res, 200, { ok: false, error: 'You have already submitted this exam.' });
      var st = {}; try { st = JSON.parse(e.settings || '{}'); } catch (_) {}
      // late-entry grace: a NEW attempt can't begin more than `late_grace_min` after start_at
      if (!at && st.late_grace_min && e.start_at && Date.now() > Date.parse(e.start_at) + st.late_grace_min * 60000)
        return J(res, 200, { ok: false, error: 'The entry window for this exam has closed (late-entry grace passed).' });
      if (!at) { const id = 'att-' + Math.random().toString(16).slice(2) + Date.now().toString(16); at = { id, exam_id: e.id, student_id: t.id, status: 'in_progress', started_at: now, answers: '{}', live_requested: 0, created_at: now, updated_at: now, deleted: 0 }; create('exam_attempts', at); }
      const endsAt = new Date(attemptDeadlineMs(e, at)).toISOString();   // server-authoritative deadline
      let qs = all('exam_questions').filter(q => !q.deleted && q.exam_id === e.id)
        .map(q => ({ id: q.id, seq: q.seq, type: q.type, text: q.text, options: (function () { try { return JSON.parse(q.options || '[]'); } catch (_) { return []; } })(), marks: q.marks, image: q.image || null, language: q.language || null }));
      if (st.pick && st.pick > 0 && st.pick < qs.length) qs = seededShuffle(e.id + ':pick:' + t.id, qs).slice(0, st.pick);   // each student gets a random N-of-total subset
      if (e.shuffle !== 0) qs = seededShuffle(e.id + ':' + t.id, qs); else qs.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      let answers = {}; try { answers = JSON.parse(at.answers || '{}'); } catch (_) {}
      return J(res, 200, { ok: true, attempt_id: at.id, endsAt, duration_min: e.duration_min || 60, room: 'exam-' + e.id, exam: { id: e.id, title: e.title || e.course_code, instructions: e.instructions || '', require_camera: e.require_camera !== 0, lockdown: st.lockdown !== false }, answers, questions: qs });
    }
    // Student: autosave answers (during the exam).
    if (p === '/api/exam/answer' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const at = body.attempt_id ? one('exam_attempts', body.attempt_id) : null;
      if (!at || at.student_id !== t.id) return J(res, 404, { ok: false });
      if (at.status !== 'in_progress') return J(res, 200, { ok: false, error: 'This attempt is closed.' });
      // SERVER is authoritative on time: once the deadline passes (+grace) no NEW answers are accepted and
      // the attempt is finalised, so a tampered client clock can never keep editing after time is up.
      const e = one('online_exams', at.exam_id);
      if (e && e.id) { const dl = attemptDeadlineMs(e, at); if (dl && Date.now() > dl + DEADLINE_GRACE_MS) { if (typeof update === 'function') update('exam_attempts', at.id, { status: 'auto_submitted', submitted_at: new Date().toISOString() }); return J(res, 200, { ok: false, expired: true, error: 'Time is up — your exam has been submitted automatically.' }); } }
      if (typeof update === 'function') update('exam_attempts', at.id, { answers: JSON.stringify(mergeExamAnswers(at, body)) });
      return J(res, 200, { ok: true });
    }
    // Student: submit (final / auto). Grading is done on the desktop, not here.
    if (p === '/api/exam/submit' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const at = body.attempt_id ? one('exam_attempts', body.attempt_id) : null;
      if (!at || at.student_id !== t.id) return J(res, 404, { ok: false });
      // a voided (forfeited) attempt is final — never let a late submit resurrect it with a score
      if (at.status === 'voided') return J(res, 200, { ok: false, error: 'This exam was ended.' });
      // already submitted/graded — idempotent ack so a retry/double-tap doesn't error or re-open it
      if (at.status !== 'in_progress') return J(res, 200, { ok: true, already: true });
      // a submit arriving past the deadline is recorded as an auto-submit (time ran out before it landed)
      const e = one('online_exams', at.exam_id);
      const late = !!(e && e.id && (function () { const dl = attemptDeadlineMs(e, at); return dl && Date.now() > dl + DEADLINE_GRACE_MS; })());
      if (typeof update === 'function') update('exam_attempts', at.id, { answers: JSON.stringify(mergeExamAnswers(at, body)), status: (body.auto || late) ? 'auto_submitted' : 'submitted', submitted_at: new Date().toISOString() });
      return J(res, 200, { ok: true });
    }
    // Student: upload a proctor frame (camera JPEG + mic level). Returns whether the officer wants live A/V.
    if (p === '/api/exam/frame' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const examId = String(body.exam_id || ''); if (!examId) return J(res, 400, { ok: false });
      const now = Date.now(); const key = examId + ':' + t.id;
      // CONCURRENT-DEVICE detection — runs BEFORE the rate-limit so it sees BOTH devices' streams. Each
      // client sends a stable session nonce; two different nonces alternating within ~8s means the exam is
      // open on 2+ devices (a second screen for notes, or someone else signed in as this candidate). A
      // clean device-switch (the old device goes silent) is tolerated. Raises a synced high-severity flag.
      const clientId = String(body.client_id || '').slice(0, 40);
      if (clientId) {
        const fc = frameClient[key] || {};
        if (fc.id && fc.id !== clientId && fc.seen && (now - fc.seen) < 8000) {
          fc.conflicts = (fc.conflicts || 0) + 1;
          if (fc.conflicts >= 2 && !fc.flagged && typeof create === 'function') {
            fc.flagged = true;
            const e2 = one('online_exams', examId) || {}; const svId = e2.surveillance_id || examId;
            const ni = new Date().toISOString(); const fid = 'flg-' + crypto.randomBytes(6).toString('hex');
            create('malpractice_flags', { id: fid, exam_id: svId, student_id: t.id, camera_id: null, type: 'multiple_devices',
              severity: 'high', confidence: 0.9, detail: 'The exam was streamed from TWO devices at the same time (a second screen, or another device signed in as this candidate).',
              auto: 1, status: 'open', flagged_by: 'proctor', occurred_at: ni, created_at: ni, updated_at: ni, deleted: 0, origin_node: 'portal' });
          }
        }
        fc.id = clientId; fc.seen = now; frameClient[key] = fc;
      }
      if (!body.kyc && lastFrameTs[key] && now - lastFrameTs[key] < 1000) return J(res, 200, { ok: true, throttled: true });  // KYC selfie bypasses the rate-limit
      lastFrameTs[key] = now;
      const cur = efGet(examId, t.id);
      const relayFields = { ts: now };
      const jpeg = String(body.image_base64 || '').replace(/^data:[^;]+;base64,/, '');
      // Cap the stored frame (a real webcam JPEG is well under this; bigger ⇒ malformed/abusive). Without
      // this an oversized base64 image ×20-frame ring ×N students could exhaust the portal's memory.
      if (jpeg && jpeg.length <= 1500000) { cur.jpeg = jpeg; cur.ts = now; cur.ring = (cur.ring || []).concat([jpeg]).slice(-20); relayFields.jpeg = jpeg; if (body.kyc) { cur.kyc = jpeg; relayFields.kyc = jpeg; } }
      if (body.audioLevel != null) { cur.audioLevel = Number(body.audioLevel) || 0; cur.ts = now; relayFields.audioLevel = cur.audioLevel; }
      // a short captured audio clip (webm/opus) so the officer can actually HEAR the student, not just see a level bar
      const aud = String(body.audio_base64 || '').replace(/^data:[^;]+;base64,/, '');
      if (aud && aud.length < 4 * 1024 * 1024) { cur.audio = aud; cur.audioMime = String(body.audio_mime || 'audio/webm'); cur.audioTs = now; relayFields.audio = aud; relayFields.audioMime = cur.audioMime; relayFields.audioTs = now; }
      const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === examId && a.student_id === t.id);
      const liveBoost = !!(at && at.live_requested);
      // SHARED-RELAY write throttle: routine frames write to the relay at most ~1/2.5s per student (the
      // monitor refreshes each tile slower than that), which cuts the Supabase write/egress cost massively
      // at class scale. A KYC selfie + a student the officer is viewing LIVE always relay every frame.
      let push = relayFields;
      if (frameRelay && !body.kyc && !liveBoost) {
        const rk = examId + ':' + t.id;
        if (lastRelayTs[rk] && now - lastRelayTs[rk] < 2500) push = null; else lastRelayTs[rk] = now;
      }
      efPut(examId, t.id, cur, push);
      // `live` tells the client to BOOST its capture cadence (≈1s frames + continuous audio) for true
      // near-real-time monitoring — without a second camera consumer (avoids getUserMedia contention).
      return J(res, 200, { ok: true, live_requested: liveBoost, live: liveBoost, room: 'exam-' + examId });
    }
    // Student: upload a short (~15s) VIDEO evidence clip when a proctoring event fires — the officer
    // monitor attaches it to the flag. Transient in-memory (never synced); the flag's evidence is.
    if (p === '/api/exam/clip' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const examId = String(body.exam_id || ''); if (!examId) return J(res, 400, { ok: false });
      const clip = String(body.video_base64 || '').replace(/^data:[^;]+;base64,/, '');
      if (clip && clip.length < 14 * 1024 * 1024) {
        const cur = efGet(examId, t.id); const cts = Date.now();
        cur.clip = clip; cur.clipMime = String(body.video_mime || 'video/webm'); cur.clipTs = cts;
        efPut(examId, t.id, cur, { clip, clipMime: cur.clipMime, clipTs: cts });
      }
      return J(res, 200, { ok: true });
    }
    // Student: report a proctoring EVENT (left the app / lost focus). Counted for the officer/AI.
    if (p === '/api/exam/event' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const examId = String(body.exam_id || ''); if (!examId) return J(res, 400, { ok: false });
      const cur = efGet(examId, t.id);
      if ((body.type || 'left_app') === 'left_app') cur.away = (cur.away || 0) + 1;
      cur.lastEvent = { type: body.type || 'left_app', ts: Date.now() };
      efPut(examId, t.id, cur, { away: cur.away || 0, lastEvent: cur.lastEvent, ts: cur.ts || Date.now() });
      return J(res, 200, { ok: true, away: cur.away || 0 });
    }
    // Student: FORFEIT — the proctored app reports the candidate LEFT it (minimised / switched away /
    // killed the app) while writing. Policy: leaving a proctored exam ENDS it with NO score. We void
    // the attempt (final, score 0), raise a high-severity malpractice flag (last camera frame as
    // evidence) on the exam's surveillance session, and mark the roster so the officer monitor + the
    // student's Exam Conduct both show it. Idempotent: a finished/voided attempt is never resurrected.
    if (p === '/api/exam/forfeit' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const examId = String(body.exam_id || ''); if (!examId) return J(res, 400, { ok: false });
      const reason = String(body.reason || 'left_app').slice(0, 60);
      const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === examId && a.student_id === t.id && a.status === 'in_progress');
      if (!at) return J(res, 200, { ok: true, voided: false });   // already submitted/ended — nothing to void
      const e = one('online_exams', examId) || {};
      const total = Number(e.total_marks) || 0;
      if (typeof update === 'function') update('exam_attempts', at.id, { status: 'voided', score: 0, max_score: total, autograded: 1, submitted_at: new Date().toISOString() });
      const cur = efGet(examId, t.id);
      cur.away = (cur.away || 0) + 1; cur.forfeited = true; cur.lastEvent = { type: 'left_exam', ts: Date.now() };
      efPut(examId, t.id, cur, { away: cur.away, forfeited: true, lastEvent: cur.lastEvent, ts: cur.ts || Date.now() });
      let evJpeg = cur.jpeg; if (!evJpeg) { try { const b = await efBytes(examId, t.id, 'jpeg'); if (b) evJpeg = b.data; } catch (_) {} }  // frame may be on another instance
      if (typeof create === 'function') {
        const svId = e.surveillance_id || examId;
        const now = new Date().toISOString(); const fid = 'flg-' + crypto.randomBytes(6).toString('hex');
        create('malpractice_flags', { id: fid, exam_id: svId, student_id: t.id, camera_id: null, type: 'left_exam',
          severity: 'high', confidence: 1, detail: 'The candidate left the exam app during a proctored exam (' + reason + ') — the exam was ended and the attempt voided with no score.',
          auto: 1, status: 'open', flagged_by: 'proctor', occurred_at: now, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
        if (evJpeg && evJpeg.length < 3 * 1024 * 1024) {
          const eid = 'evd-' + crypto.randomBytes(6).toString('hex');
          create('malpractice_evidence', { id: eid, flag_id: fid, exam_id: svId, student_id: t.id, kind: 'image', mime: 'image/jpeg', filename: 'left-exam.jpg', data: evJpeg, bytes: Math.round(evJpeg.length * 0.75), camera_id: null, captured_at: now, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
        }
      }
      return J(res, 200, { ok: true, voided: true });
    }
    // Officer: monitor roster — who is online, audio level, last-seen, status.
    if (p === '/api/exam/monitor' && method === 'GET') {
      const t = isExamOfficer(req, u); if (!t) return J(res, 401, { ok: false, error: 'Not authorised — connect the monitor with the sync token or an officer login.' });
      const examId = u.searchParams.get('exam_id') || ''; const now = Date.now();
      await efHydrate(examId);   // pull cross-instance state so the roster reflects students on other instances
      const frames = examFrames[examId] || {};
      const e = one('online_exams', examId) || {};
      if (e.id) autoCloseExpiredAttempts(e);   // finalise anyone whose time elapsed (closed app at the buzzer)
      const attempts = all('exam_attempts').filter(a => !a.deleted && a.exam_id === examId);
      // build the grid from the COHORT roster (so the officer sees the whole class, even before anyone
      // uploads a frame) unioned with any attempt that isn't in the cohort.
      const hasCohort = !!(e.department_id || e.level_id);
      const cohort = hasCohort ? all('students').filter(s => !s.deleted && s.status !== 'alumni'
        && (!e.department_id || s.department_id === e.department_id) && (!e.level_id || s.level_id === e.level_id) && (!e.faculty_id || s.faculty_id === e.faculty_id)) : [];
      const ids = new Set(cohort.map(s => s.id)); attempts.forEach(a => ids.add(a.student_id));
      const rows = Array.from(ids).map(sid => {
        const st = one('students', sid) || {}; const a = attempts.find(x => x.student_id === sid) || {}; const f = frames[sid];
        return { student_id: sid, name: `${st.first_name || ''} ${st.last_name || ''}`.trim(), matric: st.matric_no || '', status: a.status || 'not_started', score: a.score,
          live_requested: !!a.live_requested, identity: a.identity_verified || (f && f.kyc ? 'pending' : 'none'),
          hasFrame: !!(f && (f.jpeg || f.remoteJpeg)), hasKyc: !!(f && (f.kyc || f.remoteKyc)), away: f ? (f.away || 0) : 0, audioLevel: f ? f.audioLevel : 0,
          hasAudio: !!(f && (f.audio || f.remoteAudio)), audioTs: f ? (f.audioTs || 0) : 0,
          hasClip: !!(f && (f.clip || f.remoteClip)), clipTs: f ? (f.clipTs || 0) : 0,
          risk: (f && f.risk != null) ? f.risk : (a.risk_score != null ? a.risk_score : null),
          riskLevel: (f && f.riskLevel) || a.risk_level || null,
          lastSeen: f ? f.ts : 0, online: !!(f && f.ts && now - f.ts < 8000) };
      }).sort((x, y) => (y.online - x.online) || String(x.name).localeCompare(String(y.name)));
      const onlineN = rows.filter(r => r.online).length;
      // `relay` = a shared cross-instance relay is wired; `relayError` = it's wired but FAILING (e.g. the
      // exam_live table isn't created) — so the monitor never falsely claims "relay on" while it's broken.
      return J(res, 200, { ok: true, room: 'exam-' + examId, status: e.status, students: rows, onlineCount: onlineN, frameCount: rows.filter(r => r.hasFrame).length, instanceId: INSTANCE_ID, relay: !!frameRelay, relayError: (frameRelay && frameRelay.lastError) || '' });
    }
    // Officer: latest frame JPEG for a student tile in the live grid. (Pulls from the shared relay if the
    // student's frame landed on another instance.)
    if (method === 'GET' && p === '/api/exam/frame') {
      const t = isExamOfficer(req, u); if (!t) return H(res, 401, '<p>Unauthorized.</p>');
      const examId = u.searchParams.get('exam_id') || ''; const sid = u.searchParams.get('student_id') || '';
      const b = await efBytes(examId, sid, (u.searchParams.get('kyc') === '1') ? 'kyc' : 'jpeg');
      if (!b || !b.data) return H(res, 404, '<p>No frame.</p>');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); res.end(Buffer.from(b.data, 'base64')); return true;
    }
    // Officer: latest captured audio clip for a student (so the monitor can HEAR them, not just a level bar).
    if (method === 'GET' && p === '/api/exam/audio') {
      const t = isExamOfficer(req, u); if (!t) return H(res, 401, '<p>Unauthorized.</p>');
      const examId = u.searchParams.get('exam_id') || ''; const sid = u.searchParams.get('student_id') || '';
      const b = await efBytes(examId, sid, 'audio');
      if (!b || !b.data) return H(res, 404, '<p>No audio.</p>');
      res.writeHead(200, { 'Content-Type': b.mime || 'audio/webm', 'Cache-Control': 'no-store' }); res.end(Buffer.from(b.data, 'base64')); return true;
    }
    // Officer: the student's latest ~15s video evidence clip (to attach to a flag).
    if (method === 'GET' && p === '/api/exam/clip') {
      const t = isExamOfficer(req, u); if (!t) return H(res, 401, '<p>Unauthorized.</p>');
      const examId = u.searchParams.get('exam_id') || ''; const sid = u.searchParams.get('student_id') || '';
      const b = await efBytes(examId, sid, 'clip');
      if (!b || !b.data) return H(res, 404, '<p>No clip.</p>');
      res.writeHead(200, { 'Content-Type': b.mime || 'video/webm', 'Cache-Control': 'no-store' }); res.end(Buffer.from(b.data, 'base64')); return true;
    }
    // Officer: recent malpractice flags for a live exam — so the monitor's LIVE alerts feed shows the
    // SERVER-side flags (forfeit / multiple-devices / browser impersonation) immediately, not only after
    // they sync to the desktop or when the officer drills into one student. `exam_id` = the surveillance id.
    if (method === 'GET' && p === '/api/exam/flags') {
      const t = isExamOfficer(req, u); if (!t) return J(res, 401, { ok: false });
      const svId = u.searchParams.get('exam_id') || ''; const since = u.searchParams.get('since') || '';
      const rows = all('malpractice_flags').filter(f => !f.deleted && f.exam_id === svId && (!since || String(f.occurred_at || f.created_at) > since))
        .sort((a, b) => String(b.occurred_at || b.created_at).localeCompare(String(a.occurred_at || a.created_at))).slice(0, 50)
        .map(f => { const s = f.student_id ? one('students', f.student_id) : null; return { id: f.id, student_id: f.student_id, name: s ? `${s.first_name || ''} ${s.last_name || ''}`.trim() : (f.matched_name || null), type: f.type, severity: f.severity, detail: f.detail, occurred_at: f.occurred_at || f.created_at, flagged_by: f.flagged_by }; });
      return J(res, 200, { ok: true, flags: rows });
    }
    // Officer: push a live AI-proctoring RISK score (0–100) for a student → roster + synced attempt.
    if (p === '/api/exam/risk' && method === 'POST') {
      const t = isExamOfficer(req, u); if (!t) return J(res, 401, { ok: false });
      const body = await readBody(); const examId = String(body.exam_id || ''); const sid = String(body.student_id || '');
      const score = Math.max(0, Math.min(100, Math.round(Number(body.score) || 0)));
      const level = body.level || (score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low');
      const cur = efGet(examId, sid);
      cur.risk = score; cur.riskLevel = level;
      efPut(examId, sid, cur, { risk: score, riskLevel: level, ts: cur.ts || Date.now() });
      const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === examId && a.student_id === sid);
      if (at && typeof update === 'function') update('exam_attempts', at.id, { risk_score: score, risk_level: level });  // syncs back to the desktop
      return J(res, 200, { ok: true });
    }
    // Officer: DISQUALIFY (void) a candidate's attempt live — the invigilator witnessed malpractice on
    // the monitor / live A-V. Ends the attempt with NO score (final, voided) and raises a high-severity
    // flag with the last camera frame as evidence. Works for APK AND browser takers; can void an
    // already-submitted attempt (caught after the fact). Idempotent.
    if (p === '/api/exam/void' && method === 'POST') {
      const t = isExamOfficer(req, u); if (!t) return J(res, 401, { ok: false });
      const body = await readBody(); const examId = String(body.exam_id || ''); const sid = String(body.student_id || '');
      if (!examId || !sid) return J(res, 400, { ok: false });
      const reason = String(body.reason || 'officer_disqualified').slice(0, 120);
      const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === examId && a.student_id === sid);
      if (!at) return J(res, 404, { ok: false, error: 'No attempt for this candidate yet.' });
      if (at.status === 'voided') return J(res, 200, { ok: true, voided: true, already: true });
      const e = one('online_exams', examId) || {};
      const total = Number(e.total_marks) || 0;
      if (typeof update === 'function') update('exam_attempts', at.id, { status: 'voided', score: 0, max_score: total, autograded: 1, submitted_at: at.submitted_at || new Date().toISOString() });
      const cur = efGet(examId, sid);
      cur.forfeited = true; cur.lastEvent = { type: 'disqualified', ts: Date.now() };
      efPut(examId, sid, cur, { forfeited: true, lastEvent: cur.lastEvent, ts: cur.ts || Date.now() });
      let evJpeg = cur.jpeg; if (!evJpeg) { try { const b = await efBytes(examId, sid, 'jpeg'); if (b) evJpeg = b.data; } catch (_) {} }  // frame may be on another instance
      if (typeof create === 'function') {
        const svId = e.surveillance_id || examId;
        const now = new Date().toISOString(); const fid = 'flg-' + crypto.randomBytes(6).toString('hex');
        create('malpractice_flags', { id: fid, exam_id: svId, student_id: sid, camera_id: null, type: 'disqualified',
          severity: 'high', confidence: 1, detail: 'Disqualified by the exam officer — ' + reason + '. The attempt was voided (no score).',
          auto: 0, status: 'open', flagged_by: 'officer', occurred_at: now, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
        if (evJpeg && evJpeg.length < 3 * 1024 * 1024) {
          const eid = 'evd-' + crypto.randomBytes(6).toString('hex');
          create('malpractice_evidence', { id: eid, flag_id: fid, exam_id: svId, student_id: sid, kind: 'image', mime: 'image/jpeg', filename: 'disqualified.jpg', data: evJpeg, bytes: Math.round(evJpeg.length * 0.75), camera_id: null, captured_at: now, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
        }
      }
      return J(res, 200, { ok: true, voided: true });
    }
    // Officer/desktop: record the KYC identity-match result (verified | rejected) for a student's attempt.
    if (p === '/api/exam/identity' && method === 'POST') {
      const t = isExamOfficer(req, u); if (!t) return J(res, 401, { ok: false });
      const body = await readBody();
      const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === body.exam_id && a.student_id === body.student_id);
      if (!at) return J(res, 404, { ok: false });
      if (typeof update === 'function') update('exam_attempts', at.id, { identity_verified: body.result === 'verified' ? 'verified' : 'rejected' });
      return J(res, 200, { ok: true });
    }
    // Student: FACE check-in (1:1). The browser computed descriptor(s) from the live camera; we match
    // them against the student's enrolled face template. On a match we mark the attempt identity_verified;
    // on a mismatch we record 'rejected' so the officer sees it live. Not enrolled ⇒ fall through to the
    // officer's manual photo review (never hard-locks a legitimate student out of an exam).
    if (p === '/api/exam/face-verify' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const examId = String(body.exam_id || '');
      const probes = Array.isArray(body.descriptors) ? body.descriptors : (Array.isArray(body.descriptor) ? [body.descriptor] : []);
      const tpl = faceTemplateFor(t.id);
      if (!tpl.enrolled) return J(res, 200, { ok: true, enrolled: false, match: null });
      if (!probes.length) return J(res, 400, { ok: false, error: 'No face captured. Look straight at the camera in good light.' });
      const dist = faceBest(probes, tpl.descriptors);
      const match = isFinite(dist) && dist <= FACE.verifyThreshold;
      const confidence = faceConfidence(dist);
      const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === examId && a.student_id === t.id);
      if (at && typeof update === 'function') update('exam_attempts', at.id, { identity_verified: match ? 'verified' : 'rejected' });
      examFrames[examId] = examFrames[examId] || {}; const cur = examFrames[examId][t.id] || { ring: [], away: 0 };
      cur.faceConfidence = confidence; cur.faceVerified = match; cur.ts = Date.now(); examFrames[examId][t.id] = cur;
      return J(res, 200, { ok: true, enrolled: true, match, confidence, distance: Math.round((isFinite(dist) ? dist : 9) * 1000) / 1000 });
    }
    // Student: continuous identity-HOLD during the exam. Called every ~15-20s with a fresh descriptor.
    // A run of consecutive misses (someone swapped in) raises an `impersonation` malpractice flag through
    // the same surveillance pipeline the officer monitor reads — and resets the attempt to 'rejected'.
    if (p === '/api/exam/face-check' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const examId = String(body.exam_id || '');
      const probes = Array.isArray(body.descriptors) ? body.descriptors : (Array.isArray(body.descriptor) ? [body.descriptor] : []);
      const tpl = faceTemplateFor(t.id);
      if (!tpl.enrolled || !probes.length) return J(res, 200, { ok: true, enrolled: tpl.enrolled, match: null });
      const dist = faceBest(probes, tpl.descriptors);
      const match = isFinite(dist) && dist <= FACE.examThreshold;
      const confidence = faceConfidence(dist);
      const key = examId + ':' + t.id;
      examFrames[examId] = examFrames[examId] || {}; const cur = examFrames[examId][t.id] || { ring: [], away: 0 };
      cur.faceConfidence = confidence; cur.faceVerified = match; cur.ts = Date.now();
      let flagged = false;
      if (match) { faceMiss[key] = 0; }
      else {
        faceMiss[key] = (faceMiss[key] || 0) + 1;
        if (faceMiss[key] >= FACE.misses && !cur.faceFlagged && typeof create === 'function') {
          // raise an impersonation flag on the exam's surveillance session (synced → desktop + officer monitor)
          const e = one('online_exams', examId) || {}; const svId = e.surveillance_id || examId;
          const now = new Date().toISOString(); const fid = 'flg-' + crypto.randomBytes(6).toString('hex');
          create('malpractice_flags', { id: fid, exam_id: svId, student_id: t.id, camera_id: null, type: 'impersonation',
            severity: 'high', confidence: Math.round((1 - confidence) * 100) / 100, detail: 'Face no longer matches the enrolled student (continuous identity-hold failed ' + faceMiss[key] + '× in a row).',
            auto: 1, status: 'open', flagged_by: 'face_biometric', occurred_at: now, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
          // attach the current frame as evidence, if we have one
          if (cur.jpeg && cur.jpeg.length < 3 * 1024 * 1024) {
            const eid = 'evd-' + crypto.randomBytes(6).toString('hex');
            create('malpractice_evidence', { id: eid, flag_id: fid, exam_id: svId, student_id: t.id, kind: 'image', mime: 'image/jpeg', filename: 'identity-hold.jpg', data: cur.jpeg, bytes: Math.round(cur.jpeg.length * 0.75), camera_id: null, captured_at: now, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
          }
          const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === examId && a.student_id === t.id);
          if (at && typeof update === 'function') update('exam_attempts', at.id, { identity_verified: 'rejected' });
          cur.faceFlagged = true; flagged = true;
        }
      }
      examFrames[examId][t.id] = cur;
      return J(res, 200, { ok: true, enrolled: true, match, confidence, flagged });
    }
    // Officer: 1:N face SEARCH at check-in — capture a face on the monitor and find which student it is.
    if (p === '/api/exam/face-search' && method === 'POST') {
      const t = isExamOfficer(req, u); if (!t) return J(res, 401, { ok: false });
      const body = await readBody();
      const probes = Array.isArray(body.descriptors) ? body.descriptors : (Array.isArray(body.descriptor) ? [body.descriptor] : []);
      if (!probes.length) return J(res, 400, { ok: false, error: 'No face captured.' });
      const ranked = faceRank(probes, { topK: 5 }).map(r => {
        const s = one('students', r.student_id) || {};
        return { student_id: r.student_id, name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), matric: s.matric_no || '', confidence: r.confidence, distance: r.distance };
      });
      const top = ranked[0];
      return J(res, 200, { ok: true, match: top && top.distance <= FACE.verifyThreshold ? top : null, candidates: ranked });
    }
    // Officer: request (or stop) a student's real-time camera+mic (they then join the exam Jitsi room).
    if (p === '/api/exam/request-live' && method === 'POST') {
      const t = isExamOfficer(req, u); if (!t) return J(res, 401, { ok: false });
      const body = await readBody();
      const at = body.attempt_id ? one('exam_attempts', body.attempt_id) : all('exam_attempts').find(a => !a.deleted && a.exam_id === body.exam_id && a.student_id === body.student_id);
      if (!at) return J(res, 404, { ok: false });
      if (typeof update === 'function') update('exam_attempts', at.id, { live_requested: body.clear ? 0 : 1 });
      return J(res, 200, { ok: true, room: 'exam-' + at.exam_id });
    }

    if (p === '/api/me' && method === 'GET') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      const name = t.k === 'student' ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : row.full_name;
      return J(res, 200, { ok: true, user: { role: t.role, kind: t.k, name } });
    }

    // Native app registers its Firebase Cloud Messaging token here so the server can push it a
    // notification when a document is posted (etc.). No-op if the host has no FCM credentials.
    if (p === '/api/register-device' && method === 'POST') {
      const t = authOf(req, u); if (!t || (t.k !== 'student' && t.k !== 'parent')) return J(res, 401, { ok: false });
      const body = await readBody();
      const tok = body && (body.token || body.fcm || body.fcmToken);
      if (!tok) return J(res, 400, { ok: false, error: 'No device token.' });
      if (registerDevice) { try { registerDevice(String(tok), { kind: t.k, id: t.id, platform: String((body && body.platform) || 'android') }); } catch (_) {} }
      return J(res, 200, { ok: true });
    }

    if (p === '/api/officer-report' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'user') return J(res, 401, { ok: false });
      const row = accountById('user', t.id); if (!row) return J(res, 401, { ok: false });
      const data = officerData(row, parsePeriod(u.searchParams));
      data.role = t.role; data.institution = inst().name;
      return J(res, 200, { ok: true, data });
    }
    if (p === '/api/students' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'user') return J(res, 401, { ok: false });
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const rows = all('students').filter(s => s.status !== 'alumni' && (!q || (`${s.first_name || ''} ${s.last_name || ''}`.toLowerCase().includes(q) || (s.matric_no || '').toLowerCase().includes(q)))).slice(0, 25)
        .map(s => ({ id: s.id, name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), matric: s.matric_no, department: nameOf('departments', s.department_id) }));
      return J(res, 200, { ok: true, students: rows });
    }

    if (p === '/api/data' && method === 'GET') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      let data;
      if (t.k === 'student' || t.k === 'parent') { data = studentData(row); data.parentView = t.k === 'parent'; data.parentName = t.k === 'parent' ? (row.parent_name || 'Parent/Guardian') : null; data.kind = 'student'; }
      else if (t.k === 'staff') { data = staffData(row); data.kind = 'staff'; }
      else { data = officerData(row); } // officerData already sets data.kind = finance | registrar | dean | affairs
      data.institution = inst().name; data.role = t.role;
      return J(res, 200, { ok: true, data });
    }

    // student/parent assistant — deterministic answers from their own data (no AI key needed)
    if (p === '/api/assistant' && method === 'POST') {
      const t = authOf(req, u); if (!t || (t.k !== 'student' && t.k !== 'parent')) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      const body = await readBody();
      return J(res, 200, { ok: true, reply: studentAssistant(row, (body && body.message) || '', t.k === 'parent') });
    }

    // Native app: mint a per-user live-class JWT (8x8 JaaS / self-host) so the app can join the Jitsi
    // room in-app with NO Google login. The room id is an unguessable capability the student already
    // holds (it comes from /api/data → liveClasses), so we mint for whatever room they ask for.
    // Students join as guests; staff/officers as moderators. An empty jwt => plain meet.jit.si.
    if (p === '/api/class-jwt' && method === 'GET') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      const room = u.searchParams.get('room') || '';
      if (!room) return J(res, 200, { ok: false, error: 'No room specified.' });
      const name = t.k === 'student' ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : (row.full_name || 'Guest');
      const moderator = (t.k === 'staff' || t.k === 'user');
      const emb = jitsi ? jitsi.classEmbed(jitsiCfg(), { room, displayName: name, email: row.email || '', moderator, userId: t.id })
        : { domain: 'meet.jit.si', roomName: String(room).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80), jwt: '', mode: 'public' };
      return J(res, 200, { ok: true, domain: emb.domain, roomName: emb.roomName, jwt: emb.jwt, mode: emb.mode });
    }

    // A lecturer started hosting a class FROM THE PORTAL → mark it LIVE for the cohort, exactly like the
    // desktop host does. This records a live_session so the class shows "Live now" + is joinable on the
    // students' app AND — crucially — gives the host's leave something to AUTO-END, which is what stops
    // the class on the students' APK (without this, a portal-hosted class kept running there). The room is
    // a one-way hash, so we resolve the cohort by MATCHING it against the lecturer's published allocations.
    if (p === '/api/class-start' && method === 'POST') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      if (t.k !== 'staff' && t.k !== 'user') return J(res, 403, { ok: false, error: 'Only teaching staff can start a class.' });
      const room = u.searchParams.get('room') || '';
      if (!room) return J(res, 200, { ok: false, error: 'No room specified.' });
      const isHb = !!u.searchParams.get('hb');   // a periodic keep-alive from the host page, not a fresh start
      const sc = scopeForRoom(room);
      if (!sc || !sc.department_id || !sc.level_id) return J(res, 200, { ok: true, started: false }); // ad-hoc room: nobody to notify
      const now = new Date().toISOString();
      const recentCut = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const existing = all('live_sessions').find(v => v.room === room && !v.deleted && String(v.started_at || '') >= recentCut);
      if (existing) { // re-host within the window (or the desktop already started it) → refresh, don't duplicate
        // a heartbeat only refreshes the keep-alive (keeps the original start time + no re-notify); a genuine
        // (re)start also bumps started_at + re-activates.
        if (typeof update === 'function') update('live_sessions', existing.id, isHb ? { active: 1, heartbeat_at: now } : { active: 1, started_at: now, heartbeat_at: now });
        return J(res, 200, { ok: true, started: true, id: existing.id });
      }
      // a heartbeat for a session that no longer exists (already ended/swept) must NOT resurrect it or
      // re-push a "class is live" notification — only a real start creates a session.
      if (isHb) return J(res, 200, { ok: true, started: false });
      if (typeof create !== 'function') return J(res, 200, { ok: true, started: false }); // LAN portal w/o create hook
      const id = crypto.randomUUID();
      const row = { id, room, subject: u.searchParams.get('subject') || sc.subject, course_code: sc.course_code, course_title: sc.course_title,
        department_id: sc.department_id, level_id: sc.level_id, session_id: sc.session_id || null, started_by: t.id,
        started_at: now, heartbeat_at: now, active: 1, deleted: 0, created_at: now, updated_at: now, origin_node: 'portal' };
      create('live_sessions', row);
      // notify the cohort (FCM push) — ONLY for this genuinely-new session, mirroring the desktop host
      try { if (typeof onLiveStart === 'function') onLiveStart(row); } catch (_) {}
      return J(res, 200, { ok: true, started: true, id });
    }
    // The host left/closed the class on the portal → END every active session for the room so it stops on
    // the cohort's app/APK (the student class page polls /api/class-live and leaves). Sent via sendBeacon.
    if (p === '/api/class-end' && method === 'POST') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      if (t.k !== 'staff' && t.k !== 'user') return J(res, 403, { ok: false });
      const room = u.searchParams.get('room') || '';
      if (!room) return J(res, 200, { ok: false, error: 'No room specified.' });
      let ended = 0;
      if (typeof update === 'function')
        for (const v of all('live_sessions').filter(v => v.room === room && !v.deleted && v.active))
          if (update('live_sessions', v.id, { active: 0 })) ended++;
      return J(res, 200, { ok: true, ended });
    }

    // documents (open in a tab; token via ?t=)
    if (p.startsWith('/doc/') && method === 'GET') {
      const t = authOf(req, u); if (!t) return H(res, 401, '<p>Session expired. Please sign in again.</p>');
      const parts = p.split('/'); const type = parts[2]; const id = parts[3];
      const studentish = (t.k === 'student' || t.k === 'parent'); // both view the student record
      if (type === 'statement' && studentish) { return H(res, 200, statementHTML(accountById('student', t.id))); }
      if (type === 'result-slip' && studentish) {
        const s = accountById('student', t.id) || one('students', t.id);
        if (!s) return H(res, 404, '<p>Student not found.</p>');
        return H(res, 200, resultSlipHTML(s, { session: u.searchParams.get('session') || '', semester: u.searchParams.get('semester') || '' }));
      }
      if (type === 'receipt') {
        const pay = one('payments', id);
        if (!pay) return H(res, 404, '<p>Receipt not found.</p>');
        if (studentish && pay.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'staff') return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, receiptHTML(pay));
      }
      if (type === 'payslip') {
        const slip = one('payslips', id);
        if (!slip) return H(res, 404, '<p>Payslip not found.</p>');
        if (t.k === 'staff' && slip.staff_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (studentish) return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, payslipHTML(slip));
      }
      if (type === 'clearance') {
        const c = one('exam_clearances', id);
        if (!c) return H(res, 404, '<p>Clearance not found.</p>');
        if (studentish && c.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'staff') return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, clearanceCertHTML(id));
      }
      if (type === 'officer-report' && t.k === 'user') {
        const row = accountById('user', t.id); if (!row) return H(res, 404, '<p>Not found.</p>');
        const period = parsePeriod(u.searchParams);
        return H(res, 200, officerReportHTML(officerData(row, period), periodLabel(period)));
      }
      if (type === 'student-statement' && t.k === 'user') {
        const s = one('students', id); if (!s) return H(res, 404, '<p>Student not found.</p>');
        return H(res, 200, statementHTML(s));
      }
      if (type === 'result') {
        const r = one('results', id);
        if (!r || !r.file) return H(res, 404, '<p>Result not found.</p>');
        if (studentish && r.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'staff') return H(res, 403, '<p>Not authorised.</p>');
        const buf = Buffer.from(r.file, 'base64');
        res.writeHead(200, { 'Content-Type': r.mime || 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + (r.filename || 'result') + '"' });
        res.end(buf); return true;
      }
      if (type === 'timetable' && studentish) {
        const s = accountById('student', t.id) || one('students', t.id);
        if (!s) return H(res, 404, '<p>Student not found.</p>');
        const tt = one('timetables', id);
        const scoped = tt && studentTimetable(tt, s);
        if (!scoped) return H(res, 404, '<p>Timetable not found or not for your cohort.</p>');
        return H(res, 200, timetableHTML(scoped.t, scoped.slots));
      }
      if (type === 'portal-document' || type === 'document') {
        const d = one('portal_documents', id);
        if (!d) return H(res, 404, '<p>Document not found.</p>');
        // personalised docs (admission letter, certificate, transcript) are private to one student
        if (d.student_id && studentish && d.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        const buf = await resolveBlob(d.file, d.file_key);
        if (!buf) return H(res, 404, '<p>This document is unavailable.</p>');
        res.writeHead(200, { 'Content-Type': d.mime || 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + (d.filename || 'document') + '"' });
        res.end(buf); return true;
      }
      return H(res, 404, '<p>Not found.</p>');
    }
    return false;
  }

  return { handle, reconcile: reconcileIntents };
};

// ----------------------- single-page portal client -----------------------
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UniBursar Portal</title>
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1e3a8a"><link rel="icon" href="/favicon">
<style>
:root{--navy:#0f1e3d;--brand:#2563eb;--brand-rgb:37,99,235;--ink:#0f172a;--muted:#64748b;--line:#e6eaf0;--bg:#eef2f8;--card:#ffffff;--th:#f8fafc;--rowline:#f1f5f9;--input-bg:#ffffff}
/* 🌙 dark theme — the whole UI is painted from the variables above, so overriding them here
   re-skins every surface. Chosen for AA contrast on OLED-friendly deep navy. */
html[data-theme=dark]{--navy:#0b1428;--ink:#e6edf7;--muted:#94a7c4;--line:#1d2b45;--bg:#0b1220;--card:#111d33;--th:#0e1930;--rowline:#18263f;--input-bg:#0d1830}
html[data-theme=dark] .btn.ghost{color:#9db8e8}
html[data-theme=dark] .lbox h1,html[data-theme=dark] .uname,html[data-theme=dark] .sectitle{color:#dbe7fb}
*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand)}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(1200px 600px at 20% -10%,rgba(var(--brand-rgb,30,58,138),.13),transparent),var(--login-bg-img,linear-gradient(transparent,transparent)) center/cover no-repeat,var(--bg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:0 20px 60px rgba(15,23,42,.12)}
.lbox{width:380px;max-width:94vw;padding:30px}
.lbox h1{margin:0 0 2px;font-size:22px;color:var(--navy)}.lbox .sub{color:var(--muted);font-size:13px;margin-bottom:18px}
.brandhead{display:flex;gap:12px;align-items:center;margin-bottom:4px}
.blogo{width:58px;height:58px;object-fit:contain;border-radius:14px;background:#fff;border:1px solid var(--line);padding:4px;flex:none}
.blogo.mono{display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;font-weight:800;font-size:19px;border:0}
.uname{font-size:19px;font-weight:800;color:var(--navy);line-height:1.12}
.umotto{font-size:11px;color:var(--muted);font-style:italic;margin-top:2px}
.psub{font-size:13px;color:var(--brand);font-weight:700;margin:8px 0 16px}
.hintbar{font-size:12px;color:var(--muted);text-align:center;margin-top:12px;line-height:1.5}
/* ===================== WIDE SPLIT-SCREEN SIGN-IN (homepage) =====================
   Desktop: a branded hero (left) fills the width + a focused sign-in card (right).
   Tablet/phone: collapses to one column — compact hero banner on top, card below.
   Everything is themeable (CSS vars) + RTL-aware (grid auto-mirrors under dir=rtl). */
.authwrap{min-height:100vh;display:grid;grid-template-columns:1.05fr .95fr;background:var(--bg)}
@supports(min-height:100dvh){.authwrap{min-height:100dvh}}
.authhero{position:relative;overflow:hidden;color:#fff;padding:clamp(30px,5vw,60px);display:flex;flex-direction:column;justify-content:center;gap:22px;
  background:var(--navy);
  background:linear-gradient(150deg,var(--navy),var(--brand) 175%),var(--login-bg-img,linear-gradient(transparent,transparent)) center/cover no-repeat}
.authhero::before{content:"";position:absolute;inset:0;background:radial-gradient(760px 420px at 88% -12%,rgba(255,255,255,.16),transparent),radial-gradient(620px 520px at -12% 112%,rgba(255,255,255,.10),transparent);pointer-events:none}
.authhero>*{position:relative;z-index:1}
.authhero .hbrand{display:flex;align-items:center;gap:14px}
.authhero .hbrand img,.authhero .hbrand .mono{width:62px;height:62px;border-radius:16px;background:#fff;padding:6px;object-fit:contain;flex:none;box-shadow:0 8px 24px rgba(0,0,0,.22)}
.authhero .hbrand .mono{display:flex;align-items:center;justify-content:center;color:var(--navy);font-weight:800;font-size:22px}
.authhero .hname{font-size:22px;font-weight:800;line-height:1.15}
.authhero .hmotto{opacity:.85;font-size:12.5px;font-style:italic;margin-top:2px}
.authhero h1{font-size:clamp(26px,3.2vw,38px);line-height:1.1;margin:4px 0 0;font-weight:800;max-width:15ch;letter-spacing:-.5px}
.authhero .hsub{opacity:.9;font-size:clamp(14px,1.3vw,16px);max-width:46ch;line-height:1.5}
.authfeat{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:540px;margin-top:4px}
.authfeat .f{display:flex;gap:11px;align-items:flex-start;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:14px;padding:13px 14px;backdrop-filter:blur(4px)}
.authfeat .f .fi{font-size:20px;line-height:1;flex:none}
.authfeat .f .ft{font-weight:700;font-size:13.5px}
.authfeat .f .fd{opacity:.82;font-size:11.5px;margin-top:2px;line-height:1.35}
.authhero .hverify{margin-top:6px;font-size:12.5px;opacity:.9}.authhero .hverify a{color:#fff;font-weight:700}
.authpanel{background:var(--card);display:flex;align-items:center;justify-content:center;padding:clamp(22px,3vw,40px);min-width:0}
.authcard{width:100%;max-width:404px}
@media(max-width:900px){
  .authwrap{grid-template-columns:1fr}
  .authhero{padding:24px 20px;gap:12px;text-align:center;align-items:center}
  .authhero .hbrand{flex-direction:column;gap:8px}
  .authhero h1{font-size:22px;max-width:22ch}.authhero .hsub{font-size:13.5px;max-width:40ch}
  .authfeat,.authhero .hverify{display:none}          /* keep the mobile top compact */
  .authpanel{padding:22px 16px}
}
@media(max-width:900px) and (max-height:640px){.authhero{display:none}}   /* very short phones → straight to the card */
.field{margin-bottom:12px}.field label{display:block;font-size:12px;font-weight:600;color:var(--ink);margin-bottom:5px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px;background:var(--input-bg);color:var(--ink)}
textarea{background:var(--input-bg);color:var(--ink);border:1px solid var(--line);border-radius:10px}
.btn{background:linear-gradient(135deg,#2563eb,#4338ca);color:#fff;border:0;border-radius:10px;padding:12px;font-weight:700;width:100%;cursor:pointer;font-size:14px}
.btn.sm{width:auto;padding:8px 13px;font-size:12.5px;border-radius:8px}.btn.ghost{background:var(--card);color:var(--brand);border:1px solid var(--line)}
.err{background:#fee2e2;color:#991b1b;padding:9px 12px;border-radius:9px;font-size:13px;margin-bottom:12px;display:none}
.top{background:var(--navy);color:#fff;display:flex;align-items:center;gap:12px;padding:12px 20px}
.top .nm{font-weight:800}.top .rl{margin-left:auto;opacity:.85;font-size:13px;text-transform:capitalize}
.wrap{max-width:1040px;margin:0 auto;padding:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:18px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.kpi .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px}.kpi .v{font-size:22px;font-weight:800;margin-top:4px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:18px;overflow:hidden}
.panel h3{margin:0;padding:14px 18px;border-bottom:1px solid var(--line);font-size:15px}
table{width:100%;border-collapse:collapse}th,td{padding:11px 16px;text-align:left;border-bottom:1px solid var(--rowline);font-size:13.5px}
th{background:var(--th);font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted)}
.r{text-align:right}.neg{color:#b91c1c;font-weight:700}.pos{color:#065f46;font-weight:700}
.prof{display:flex;gap:16px;align-items:center;padding:18px}.prof img,.prof .ph{width:84px;height:96px;border-radius:10px;object-fit:cover;border:2px solid var(--brand)}
.prof .ph{background:#e2e8f0;display:flex;align-items:center;justify-content:center;color:#94a3b8}
.prof .nm{font-size:20px;font-weight:800}.prof .meta{color:var(--muted);font-size:13px;margin-top:3px}
.muted{color:var(--muted)}.badge{background:#eef2ff;color:#3730a3;border-radius:999px;padding:3px 9px;font-size:11px;font-weight:700}
.empty{padding:24px;text-align:center;color:var(--muted)}
.live{font-size:11px;color:#16a34a;margin-left:8px}
.tscroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
select{padding:9px 10px;border:1px solid var(--line);border-radius:9px;font-size:13.5px;background:var(--input-bg);color:var(--ink);max-width:100%}
.toolbarp{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pbanner{background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:12px;padding:11px 16px;margin-bottom:14px;font-size:13.5px}
.exbar{border-radius:12px;padding:13px 16px;margin-bottom:14px;font-weight:800;text-align:center;letter-spacing:.3px;font-size:15px}
.exbar.ok{background:#dcfce7;color:#166534;border:1px solid #86efac}
.exbar.warn{background:#fef9c3;color:#854d0e;border:1px solid #fde68a}
.exbar.bad{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}
/* ---- final-clearance progress bar + stepper ---- */
.fcprog{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin-bottom:16px;box-shadow:0 4px 16px rgba(15,23,42,.06)}
.fcprog .top{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px}
.fcprog .pct{font-size:30px;font-weight:900;background:linear-gradient(135deg,#2563eb,#4338ca);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;line-height:1}
.fcprog .lbl{font-size:12.5px;color:var(--muted);font-weight:700;text-align:right}
.fcbar{height:12px;border-radius:999px;background:#eef2f8;overflow:hidden;position:relative}
.fcbar>span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#2563eb,#4338ca,#7c3aed);background-size:200% 100%;transition:width .9s cubic-bezier(.22,1,.36,1);animation:fcsheen 2.4s linear infinite}
.fcprog.done .fcbar>span{background:linear-gradient(90deg,#059669,#10b981)}
@keyframes fcsheen{0%{background-position:0 0}100%{background-position:200% 0}}
.fcsteps{display:flex;gap:4px;margin-top:14px}
.fcstep{flex:1;text-align:center;font-size:10px;color:var(--muted);position:relative}
.fcstep .dot{width:26px;height:26px;border-radius:50%;margin:0 auto 5px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;background:#eef2f8;color:#94a3b8;border:2px solid #e2e8f0;transition:.3s}
.fcstep.done .dot{background:#10b981;color:#fff;border-color:#10b981}
.fcstep.current .dot{background:#2563eb;color:#fff;border-color:#2563eb;box-shadow:0 0 0 4px rgba(37,99,235,.18)}
.fcstep.current{color:#2563eb;font-weight:800}
.fcstep.done{color:#059669;font-weight:700}
/* ---- segmented student portal ---- */
/* single column: photo + info at the TOP, section tabs beneath, content below — the
   WHOLE page scrolls as one (no separate scrolling side panel). */
.shell{max-width:940px;margin:0 auto;padding:18px 16px}
.phead{background:linear-gradient(160deg,#1e3a8a,#4338ca);color:#fff;border-radius:18px;padding:20px 22px;display:flex;gap:18px;align-items:center;margin-bottom:14px;box-shadow:0 8px 26px rgba(30,58,138,.22)}
.phead img,.phead .ph{width:86px;height:86px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.55);flex:none}
.phead .ph{background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:34px}
.phead .nm{font-weight:800;font-size:21px;line-height:1.15}
.phead .mt{opacity:.92;font-size:13px;margin-top:4px}
.phead .bal{margin-left:8px;font-size:13px;opacity:.95}
.phead .chip{vertical-align:middle}
/* horizontal section tabs (sticky to the top of the page so they're always reachable) */
.nav{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px;margin-bottom:16px;position:sticky;top:8px;z-index:6;box-shadow:0 4px 16px rgba(15,23,42,.05)}
.nav a{display:inline-flex;gap:7px;align-items:center;padding:9px 14px;color:var(--ink);text-decoration:none;font-size:13.5px;font-weight:700;border-radius:10px;white-space:nowrap;cursor:pointer}
.nav a .ic{font-size:15px}
.nav a.active{background:var(--brand);color:#fff}
.nav a:hover{background:var(--rowline)}.nav a.active:hover{background:var(--brand)}
.nav a .pill{background:#ef4444;color:#fff;border-radius:999px;font-size:10px;font-weight:800;padding:1px 6px}
.content{min-width:0}
.hero{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:16px;display:flex;align-items:center;gap:16px;box-shadow:0 6px 22px rgba(15,23,42,.05)}
.hero .big{font-size:21px;font-weight:800}.hero .meta{color:var(--muted);font-size:13px;margin-top:3px}
.chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 12px;font-size:12.5px;font-weight:800}
.chip.ok{background:#dcfce7;color:#166534}.chip.warn{background:#fef9c3;color:#854d0e}.chip.bad{background:#fee2e2;color:#991b1b}
.seg{display:none}.seg.on{display:block}
.sectitle{font-size:18px;font-weight:800;margin:0 0 12px;color:var(--navy)}
.qa{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:16px}
/* phone — shrink the profile header; tabs become an icon strip that scrolls sideways */
@media(max-width:600px){
  .shell{padding:11px 9px}
  .phead{padding:14px;gap:12px;border-radius:14px}
  .phead img,.phead .ph{width:60px;height:60px;font-size:24px}
  .phead .nm{font-size:16px}.phead .mt{font-size:12px}
  .nav a{padding:9px 11px}
  .nav a .ic{font-size:18px}
  .nav a .lbl{display:none}   /* icons only on small phones; full labels on tablet+ */
  .tscroll table{min-width:520px}
}
@media(max-width:760px){
  .wrap{padding:12px}
  .top{padding:11px 14px;gap:9px}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
  .kpi{padding:13px}.kpi .v{font-size:19px}
  .panel h3{padding:12px 14px;font-size:14px}
  th,td{padding:9px 11px;font-size:13px;white-space:nowrap}
  .tscroll table{min-width:560px}
  .prof{flex-direction:column;text-align:center;gap:10px}
  .prof img,.prof .ph{width:96px;height:112px}
}
@media(max-width:560px){.top .rl{display:none}.lbox{padding:22px}}
/* Right-to-left (Arabic) — PI18N sets <html dir=rtl>, which auto-mirrors flexbox/text flow; these
   override the few PHYSICAL properties the layout uses so the UI reads correctly right-to-left. */
html[dir=rtl] body,html[dir=rtl] .wrap,html[dir=rtl] .card,html[dir=rtl] .seg,html[dir=rtl] .phead,html[dir=rtl] .lbox{text-align:right}
html[dir=rtl] input,html[dir=rtl] textarea,html[dir=rtl] select{text-align:right}
html[dir=rtl] .bal{margin-left:0;margin-right:8px}
html[dir=rtl] .tscroll th,html[dir=rtl] .tscroll td{text-align:right}
html[dir=rtl] .tscroll th.r,html[dir=rtl] .tscroll td.r{text-align:left}
/* ============================================================================
   ✨ 2026 UI UPGRADE — native-app polish for the web portal + the Capacitor APK.
   Additive only (no DOM/JS changes): press feedback, smoother motion, safe-area
   insets for notched phones, refined depth + typography. ==================== */
:root{--radius:16px;--shadow-sm:0 2px 8px rgba(15,23,42,.06);--shadow-md:0 10px 30px rgba(15,23,42,.09);--ease:cubic-bezier(.22,1,.36,1)}
body{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
/* honour the phone's notch / home-indicator when the APK runs full-bleed */
.top{padding-top:calc(12px + env(safe-area-inset-top))}
.shell,.wrap{padding-bottom:calc(24px + env(safe-area-inset-bottom))}
/* every card/panel/kpi lifts on a consistent, softer shadow and animates in */
.panel,.kpi,.hero,.fcprog{box-shadow:var(--shadow-sm);transition:box-shadow .25s var(--ease),transform .25s var(--ease)}
.panel:hover,.kpi:hover,.hero:hover{box-shadow:var(--shadow-md)}
.seg.on>*{animation:portalIn .34s var(--ease) both}
@keyframes portalIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.seg.on>*{animation:none}}
/* a silent live refresh (data changed in the background) swaps the DOM in place — never replay the
   entrance animation, so the page doesn't visibly "reload" every few seconds */
#app.bgswap .seg.on>*{animation:none!important}
/* tactile press feedback everywhere a finger lands (the native-app "tap" feel) */
.btn,.nav a,.qa button,button,.chip,.lib-card{transition:transform .12s var(--ease),background .18s,box-shadow .18s,color .18s}
.btn:active,.qa button:active,button:active{transform:scale(.96)}
.nav a:active{transform:scale(.94)}
.btn{box-shadow:0 6px 16px rgba(37,99,235,.24)}
.btn.ghost{box-shadow:var(--shadow-sm)}
.btn.sm{box-shadow:none}
/* KPI cards get an accent spine + tighter numerals */
.kpi{position:relative;overflow:hidden}
.kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,#2563eb,#4338ca)}
.kpi .v{font-variant-numeric:tabular-nums;letter-spacing:-.5px}
/* the sticky section tabs read as a floating pill bar; the active tab lifts */
.nav{backdrop-filter:saturate(1.2) blur(6px);box-shadow:var(--shadow-sm)}
.nav a.active{box-shadow:0 6px 16px rgba(var(--brand-rgb,37,99,235),.32)}
/* rows highlight on touch so a tap target is obvious on a phone */
tbody tr{transition:background .15s}
tbody tr:active{background:rgba(var(--brand-rgb,37,99,235),.06)}
/* the profile hero gets a subtle depth pattern + crisper avatar ring */
.phead{position:relative;overflow:hidden}
.phead::after{content:"";position:absolute;inset:0;background:radial-gradient(600px 200px at 90% -20%,rgba(255,255,255,.14),transparent);pointer-events:none}
/* pills/badges a touch rounder + bolder for legibility at arm's length */
.badge,.chip{font-weight:800;letter-spacing:.2px}
/* inputs feel modern: soft focus ring in the brand colour */
input:focus,select:focus,textarea:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px rgba(var(--brand-rgb,37,99,235),.16)}
/* phone: bigger tap targets, comfortable spacing, snappier sticky tabs */
@media(max-width:600px){
  .btn{padding:13px 16px;font-size:14.5px}
  .nav{top:calc(6px + env(safe-area-inset-top))}
  .nav a{padding:10px 13px;border-radius:12px}
  .sectitle{font-size:19px}
  .panel{border-radius:14px}
  /* the top account bar must never overflow: let it wrap, truncate the long institution name,
     and shrink the header action buttons */
  .top{padding:10px 12px;gap:8px;flex-wrap:wrap}
  .top .nm{font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
  .top .rl{font-size:11px}
  .top .btn.sm{padding:7px 10px;font-size:12px}
}
/* ============================================================================
   📱💻 RESPONSIVE / DEVICE-FIT — the portal adapts to phone, tablet and desktop
   from ONE codebase. The viewport meta already maps CSS px to device px; these
   rules make each size band comfortable and prevent the classic mobile pitfalls
   (input-focus zoom, browser-chrome clipping, sideways scroll). ============= */
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
img{max-width:100%;height:auto}
.wrap,.shell,.content{max-width:100%}
/* use the DYNAMIC viewport height so the mobile address bar never clips the login */
@supports(height:100dvh){.login{min-height:100dvh}}
/* inputs render at 16px on phones/tablets so iOS Safari does NOT auto-zoom the whole
   page when a field is focused (the #1 cause of a "broken" mobile fit) */
@media(max-width:820px){input,select,textarea{font-size:16px}}
/* Tablet band (portrait + landscape): full labels, roomier grids, edge-to-edge shell */
@media(min-width:601px) and (max-width:1024px){
  .shell{max-width:100%;padding:16px 20px}
  .nav a .lbl{display:inline}
  .nav a{padding:9px 13px}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
  .qa{gap:10px}
}
/* Large desktop: let the reading column breathe a little wider on big monitors */
@media(min-width:1280px){.shell{max-width:1080px}.wrap{max-width:1160px}}
/* Small phones: tighten everything so nothing overflows on a 320–360px screen */
@media(max-width:380px){
  .shell{padding:9px 7px}
  .phead{padding:12px;gap:10px}.phead .nm{font-size:15px}
  .sectitle{font-size:17px}.lbox{padding:18px}
  th,td{padding:8px 9px;font-size:12.5px}
  .kpi .v{font-size:18px}
}
/* Landscape phone: reclaim vertical space (short viewport) */
@media(max-height:480px) and (orientation:landscape){
  .phead{padding:10px 14px}
  .nav{position:static}
}
</style></head>
<body>
<div id="app"><div class="bootsplash" style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#64748b;font-family:'Segoe UI',system-ui,Arial,sans-serif"><div style="width:44px;height:44px;border-radius:50%;border:4px solid #e2e8f0;border-top-color:#2563eb;animation:ubuspin 1s linear infinite"></div><div style="font-size:14px;font-weight:600">Loading portal…</div><style>@keyframes ubuspin{to{transform:rotate(360deg)}}</style></div></div>
<script>
const $=(h)=>{const d=document.createElement('div');d.innerHTML=h;return d.firstElementChild;};
let TOKEN=localStorage.getItem('ubu_token')||'';let VER=0;let TIMER=null;
// Branding, cached: paint the login INSTANTLY from the last-seen branding (localStorage) instead of
// blocking the first paint on /api/branding — on a cold serverless host that call can take 10+ s,
// which used to leave the page BLANK. The fetch still runs (time-capped) and refreshes the cache;
// a changed name/logo repaints once it lands.
function brandCache(){try{return JSON.parse(localStorage.getItem('ubu_branding')||'null')||null;}catch(_){return null;}}
// slim branding returns logo/login_bg/favicon as tiny cacheable URLs — absolutize them under any
// path prefix (Supabase Edge serves the portal at /functions/v1/server) so <img src> resolves.
function absBrand(b){if(!b)return b;var B=window.__B||'';['logo','login_bg','favicon'].forEach(function(k){if(b[k]&&b[k].charAt(0)==='/'&&b[k].charAt(1)!=='/'&&b[k].indexOf(B+'/')!==0)b[k]=B+b[k];});return b;}
function fetchBranding(capMs){
  var f=fetch('/api/branding?slim=1').then(function(r){return r.json();}).then(function(b){b=absBrand(b||{});try{localStorage.setItem('ubu_branding',JSON.stringify(b));}catch(_){}return b;});
  if(!capMs)return f.catch(function(){return brandCache()||{};});
  return Promise.race([f,new Promise(function(res){setTimeout(function(){res(null);},capMs);})])
    .then(function(b){return b||brandCache()||{};}).catch(function(){return brandCache()||{};});
}
const SYM={NGN:'₦',XOF:'CFA',USD:'$',EUR:'€',GBP:'£',GHS:'₵',KES:'KSh',ZAR:'R'};
const ZERO_DEC_CUR=new Set(['JPY','KRW','VND','CLP','XOF','XAF','BIF','DJF','GNF','KMF','MGA','PYG','RWF','UGX','VUV','XPF']);
function money(a,c){var d=ZERO_DEC_CUR.has(String(c||'').toUpperCase())?0:2;return (SYM[c]||(c?c+' ':''))+Number(a||0).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});}
function mapMoney(m){const e=Object.entries(m||{});return e.length?e.map(([c,v])=>money(v,c)).join(' • '):money(0);}
function fmt(d){if(!d)return '—';try{return new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});}catch(_){return '—';}}
// NEVER throws: a network/parse failure returns {ok:false,__net:true} and the HTTP status rides along
// as __status — so callers can tell "offline" (keep the session, show cached data) apart from
// "session rejected" (401 → sign in again). Throwing here used to LOG THE STUDENT OUT on a flaky
// connection, which is the worst possible answer to a dropped packet.
async function api(path,opts={}){
  opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});
  if(TOKEN)opts.headers.Authorization='Bearer '+TOKEN;
  opts.cache='no-store';
  try{
    const r=await fetch(path,opts);
    const j=await r.json();
    if(j&&typeof j==='object'&&!Array.isArray(j)){try{j.__status=r.status;}catch(_){}}
    return j;
  }catch(e){return {ok:false,__net:true,error:'Network error.'};}
}
// ---- last-good data cache: paints the portal INSTANTLY on the next open (a cold serverless hub can
// take seconds) and keeps it usable offline. Cleared on sign-out so nothing lingers on a shared PC.
function dataCache(){try{return JSON.parse(localStorage.getItem('ubu_cache')||'null');}catch(_){return null;}}
function saveCache(d){try{localStorage.setItem('ubu_cache',JSON.stringify(d));}catch(_){}}
function setOffline(on){
  var b=document.getElementById('offbar');
  if(on){
    if(b)return;
    b=document.createElement('div');b.id='offbar';
    b.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:9700;background:#7c2d12;color:#fff;padding:9px 16px;border-radius:999px;font-size:12.5px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:92vw;text-align:center';
    b.textContent='📡 You are offline — showing your last saved data. Reconnecting…';
    document.body.appendChild(b);
    try{PI18N.translate(b);}catch(_){}
  } else if(b)b.remove();
}
function logout(msg){TOKEN='';localStorage.removeItem('ubu_token');localStorage.removeItem('ubu_cache');if(TIMER)clearInterval(TIMER);setOffline(false);renderLogin(msg);}
// ---- 🌗 light / dark / system theme --------------------------------------
function themePref(){try{return localStorage.getItem('ubu_theme')||'system';}catch(_){return 'system';}}
function applyThemeMode(){
  var p=themePref();
  var dark=p==='dark'||(p==='system'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme',dark?'dark':'light');
  var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',dark?'#0b1220':'#1e3a8a');
}
function themeIcon(){var p=themePref();return p==='dark'?'🌙':(p==='light'?'☀️':'🌗');}
function cycleTheme(btn){
  var order=['system','light','dark'];var n=order[(order.indexOf(themePref())+1)%3];
  try{localStorage.setItem('ubu_theme',n);}catch(_){}
  applyThemeMode();
  if(btn){btn.textContent=themeIcon();btn.title='Theme: '+n;}
}
function themeBtn(extra){return '<button class="btn sm ghost" data-noi18n onclick="cycleTheme(this)" title="Theme: '+themePref()+'" style="'+(extra||'')+'">'+themeIcon()+'</button>';}
applyThemeMode();
try{if(window.matchMedia)matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyThemeMode);}catch(_){}
// Proper modal (replaces the old prompt() chain — which could not be translated, styled or cancelled
// cleanly, and prompt() is blocked entirely inside some WebViews).
function changePassword(){
  if(document.getElementById('pwModal'))return;
  var ov=document.createElement('div');ov.id='pwModal';
  ov.style.cssText='position:fixed;inset:0;z-index:9600;background:rgba(2,6,23,.55);display:flex;align-items:center;justify-content:center;padding:16px';
  ov.innerHTML='<div class="card" style="width:360px;max-width:96vw;padding:22px">'
    +'<h3 style="margin:0 0 4px;font-size:17px">🔑 Change password</h3>'
    +'<div style="font-size:12.5px;color:var(--muted);margin-bottom:12px">It updates here and on the school system.</div>'
    +'<div class="err" id="pwErr"></div>'
    +'<div class="ok2" id="pwOk" style="display:none;color:#166534;background:#dcfce7;border-radius:9px;padding:10px 12px;margin-bottom:10px;font-size:13px"></div>'
    +'<div class="field"><label>Current password</label><input id="pwOld" type="password" autocomplete="current-password"></div>'
    +'<div class="field"><label>New password</label><input id="pwNew" type="password" autocomplete="new-password"></div>'
    +'<div class="field"><label>Confirm new password</label><input id="pwCf" type="password" autocomplete="new-password"></div>'
    +'<label style="display:flex;gap:7px;align-items:center;font-size:12.5px;color:var(--muted);margin-bottom:12px;cursor:pointer"><input type="checkbox" id="pwShow" style="width:auto"> Show passwords</label>'
    +'<div style="display:flex;gap:8px"><button class="btn" id="pwGo" style="flex:1">Save new password</button><button class="btn ghost" id="pwX" style="width:auto;padding:12px 16px">Cancel</button></div>'
    +'</div>';
  document.body.appendChild(ov);
  try{PI18N.translate(ov);}catch(_){}
  var q=function(s){return ov.querySelector(s);};
  var close=function(){ov.remove();};
  q('#pwX').onclick=close;
  ov.addEventListener('click',function(e){if(e.target===ov)close();});
  q('#pwShow').onchange=function(){var t=this.checked?'text':'password';q('#pwOld').type=t;q('#pwNew').type=t;q('#pwCf').type=t;};
  var go=async function(){
    var e=q('#pwErr');e.style.display='none';
    var o=q('#pwOld').value,n=q('#pwNew').value,c2=q('#pwCf').value;
    var showErr=function(m){e.textContent=m;e.style.display='block';};
    if(!o||!n){showErr('Fill in every field.');return;}
    if(n.length<5){showErr('New password must be at least 5 characters.');return;}
    if(n!==c2){showErr('The new passwords do not match.');return;}
    var btn=q('#pwGo');btn.disabled=true;btn.textContent='Saving…';
    var r=await api('/api/reset-password',{method:'POST',body:JSON.stringify({oldPassword:o,newPassword:n})});
    btn.disabled=false;btn.textContent='Save new password';
    if(!r||!r.ok){showErr((r&&r.error)||'Could not change password.');return;}
    var okb=q('#pwOk');okb.textContent='✓ Password changed. Use it next time you sign in.';okb.style.display='block';
    setTimeout(close,1600);
  };
  q('#pwGo').onclick=go;
  ov.querySelectorAll('input').forEach(function(i){i.addEventListener('keydown',function(e){if(e.key==='Enter')go();if(e.key==='Escape')close();});});
  q('#pwOld').focus();
}

function eh(s){return String(s==null?'':s).replace(/[&<>"]/g,function(m){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m];});}

/* ---- Multi-language (i18n) for the portal / APK ----
 * Dictionary keyed by the English source string, applied by walking the DOM after each render.
 * EXACT-MATCH (the whole trimmed text must equal a key) so names/matric/amounts/codes are never
 * touched; a leading emoji/symbol prefix is tolerated ("🔔 Updates" → emoji + translated "Updates").
 * English is the base; missing phrases fall back to English. Arabic flips the page to RTL. */
var PI18N=(function(){
  var KEY='ubu_lang';
  var LANGS={en:{n:'English',dir:'ltr'},fr:{n:'Français',dir:'ltr'},es:{n:'Español',dir:'ltr'},ar:{n:'العربية',dir:'rtl'},ha:{n:'Hausa',dir:'ltr'}};
  var D={
    fr:{'Overview':'Aperçu','Updates':'Mises à jour','Fees & Payments':'Frais et paiements','Receipts':'Reçus','Timetable':'Emploi du temps','Live Classes':'Cours en direct','Exams':'Examens','Library':'Bibliothèque','Results':'Résultats','Clearance':'Quitus','Documents':'Documents','Discipline':'Discipline','Exam Conduct':'Conduite d’examen','Evaluation':'Évaluation','Profile':'Profil',
      'Sign In':'Se connecter','Sign Up':'S’inscrire','Sign out':'Se déconnecter','Password':'Mot de passe','Balance':'Solde','Outstanding Balance':'Solde impayé','Download':'Télécharger','Status':'Statut','Campus':'Campus','Department':'Département','Faculty':'Faculté','Level':'Niveau','Welcome':'Bienvenue','Apply for Admission':'Demander l’admission','Date':'Date','Amount':'Montant','Category':'Catégorie','Receipt':'Reçu','Session':'Session','Semester':'Semestre','Course':'Cours','Courses':'Cours','Paid':'Payé','Outstanding':'Impayé','Email':'Courriel','Phone':'Téléphone','Gender':'Genre','Name':'Nom','Language':'Langue','Notifications':'Notifications','Logout':'Déconnexion','Pay Now':'Payer maintenant','My Results':'Mes résultats'},
    es:{'Overview':'Resumen','Updates':'Novedades','Fees & Payments':'Tasas y pagos','Receipts':'Recibos','Timetable':'Horario','Live Classes':'Clases en vivo','Exams':'Exámenes','Library':'Biblioteca','Results':'Resultados','Clearance':'Habilitación','Documents':'Documentos','Discipline':'Disciplina','Exam Conduct':'Conducta de examen','Evaluation':'Evaluación','Profile':'Perfil',
      'Sign In':'Iniciar sesión','Sign Up':'Registrarse','Sign out':'Cerrar sesión','Password':'Contraseña','Balance':'Saldo','Outstanding Balance':'Saldo pendiente','Download':'Descargar','Status':'Estado','Campus':'Campus','Department':'Departamento','Faculty':'Facultad','Level':'Nivel','Welcome':'Bienvenido','Apply for Admission':'Solicitar admisión','Date':'Fecha','Amount':'Importe','Category':'Categoría','Receipt':'Recibo','Session':'Sesión','Semester':'Semestre','Course':'Curso','Courses':'Cursos','Paid':'Pagado','Outstanding':'Pendiente','Email':'Correo','Phone':'Teléfono','Gender':'Género','Name':'Nombre','Language':'Idioma','Notifications':'Notificaciones','Logout':'Cerrar sesión','Pay Now':'Pagar ahora','My Results':'Mis resultados'},
    ar:{'Overview':'نظرة عامة','Updates':'التحديثات','Fees & Payments':'الرسوم والمدفوعات','Receipts':'الإيصالات','Timetable':'الجدول','Live Classes':'حصص مباشرة','Exams':'الامتحانات','Library':'المكتبة','Results':'النتائج','Clearance':'إخلاء الطرف','Documents':'المستندات','Discipline':'الانضباط','Exam Conduct':'سلوك الامتحان','Evaluation':'التقييم','Profile':'الملف الشخصي',
      'Sign In':'تسجيل الدخول','Sign Up':'إنشاء حساب','Sign out':'تسجيل الخروج','Password':'كلمة المرور','Balance':'الرصيد','Outstanding Balance':'الرصيد المستحق','Download':'تنزيل','Status':'الحالة','Campus':'الحرم الجامعي','Department':'القسم','Faculty':'الكلية','Level':'المستوى','Welcome':'مرحبًا','Apply for Admission':'تقديم طلب التحاق','Date':'التاريخ','Amount':'المبلغ','Category':'الفئة','Receipt':'إيصال','Session':'العام الدراسي','Semester':'الفصل الدراسي','Course':'مقرر','Courses':'المقررات','Paid':'مدفوع','Outstanding':'مستحق','Email':'البريد الإلكتروني','Phone':'الهاتف','Gender':'الجنس','Name':'الاسم','Language':'اللغة','Notifications':'الإشعارات','Logout':'تسجيل الخروج','Pay Now':'ادفع الآن','My Results':'نتائجي'},
    ha:{'Overview':'Bayani','Updates':'Sabuntawa','Fees & Payments':'Kuɗi da biya','Receipts':'Rasidi','Timetable':'Jadawali','Live Classes':'Azuzuwa kai tsaye','Exams':'Jarrabawa','Library':'Ɗakin karatu','Results':'Sakamako','Clearance':'Tabbatarwa','Documents':'Takardu','Discipline':'Ladabtarwa','Profile':'Bayanin sirri',
      'Sign In':'Shiga','Sign out':'Fita','Password':'Kalmar sirri','Balance':'Saura','Outstanding Balance':'Saurar bashi','Download':'Sauke','Status':'Matsayi','Campus':'Cibiya','Department':'Sashe','Faculty':'Faculty','Level':'Matakin','Welcome':'Barka da zuwa','Apply for Admission':'Nemi shiga','Date':'Kwanan wata','Amount':'Adadi','Receipt':'Rasidi','Course':'Darasi','Paid':'An biya','Email':'Imel','Phone':'Waya','Gender':'Jinsi','Name':'Suna','Language':'Harshe','Notifications':'Sanarwa','Logout':'Fita'},
  };
  var lang=(function(){try{return localStorage.getItem(KEY)||'';}catch(e){return '';}})(); if(!LANGS[lang])lang='en';
  function t(s){if(lang==='en')return s;var d=D[lang];if(!d)return s;var v=d[s];return v==null?s:v;}
  // translate ONE segment: exact match, else tolerate a leading emoji/symbol prefix ("📂 Documents").
  // NOTE the DOUBLE backslashes: this whole client script lives in a template literal, where a single
  // "\\p" collapses to "p" — which silently broke the emoji-prefix match (so most section titles and
  // emoji-labelled buttons never translated). \\p{L}\\p{N} emits the correct \\p{L}\\p{N} regex.
  function txseg(str){
    var d=D[lang]; if(!d)return str; var k=str.trim(); if(!k)return str;
    if(d[k]!=null)return str.replace(k,d[k]);
    try{var m=/^([^\\p{L}\\p{N}]+)(.+)$/u.exec(k);if(m){var rest=m[2].trim();if(d[rest]!=null)return str.replace(rest,d[rest]);}}catch(e){}
    return str;
  }
  function tx(s){
    if(lang==='en'||!D[lang])return s;
    var whole=txseg(s); if(whole!==s)return whole;
    // dynamic "Fixed label — detail" lines (e.g. the exam-clearance banner): translate each side
    if(s.indexOf(' — ')>=0){
      var parts=s.split(' — '),any=false;
      var out=parts.map(function(p){var t=txseg(p);if(t!==p)any=true;return t;});
      if(any)return out.join(' — ');
    }
    return s;
  }
  var SKIP={SCRIPT:1,STYLE:1,CODE:1,INPUT:1,TEXTAREA:1,SELECT:1,OPTION:1};
  function translate(root){
    if(lang==='en'||!D[lang]||!root)return;
    try{
      var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null);var nodes=[],n;
      while((n=w.nextNode())){var p=n.parentNode;if(!p||SKIP[p.nodeName])continue;if(p.closest&&p.closest('[data-noi18n]'))continue;if(!n.nodeValue||!n.nodeValue.trim())continue;nodes.push(n);}
      for(var i=0;i<nodes.length;i++){var o=tx(nodes[i].nodeValue);if(o!==nodes[i].nodeValue)nodes[i].nodeValue=o;}
      var ph=root.querySelectorAll?root.querySelectorAll('input[placeholder]'):[];
      for(var j=0;j<ph.length;j++){var pv=tx(ph[j].getAttribute('placeholder')||'');if(pv!==ph[j].getAttribute('placeholder'))ph[j].setAttribute('placeholder',pv);}
    }catch(e){}
  }
  function applyDir(){try{document.documentElement.setAttribute('dir',(LANGS[lang]||{}).dir||'ltr');document.documentElement.setAttribute('lang',lang);}catch(e){}}
  function use(l){if(!LANGS[l])return;lang=l;try{localStorage.setItem(KEY,l);}catch(e){}applyDir();}
  function setLang(l){if(!LANGS[l])l='en';use(l);try{if(typeof TOKEN!=='undefined'&&TOKEN)renderApp();else renderLogin();}catch(e){}}
  function hasPref(){try{return !!localStorage.getItem(KEY);}catch(e){return false;}}
  function options(){return Object.keys(LANGS).map(function(c){return '<option value="'+c+'"'+(c===lang?' selected':'')+'>'+LANGS[c].n+'</option>';}).join('');}
  function picker(extraStyle){return '<select data-noi18n onchange="PI18N.setLang(this.value)" title="Language" style="border:1px solid rgba(148,163,184,.5);background:rgba(255,255,255,.12);color:inherit;border-radius:8px;padding:4px 6px;font-size:12px;cursor:pointer;'+(extraStyle||'')+'">'+options()+'</select>';}
  applyDir();
  /* Register DOWNLOADED languages (from the synced i18n_langs pack list) with their real display name
     and text direction, so a pack like Urdu shows as "اردو" in the picker AND flips the page to RTL.
     Without this the strings would exist but PI18N.use()/setLang() would reject the unknown code. */
  function addLangs(list){if(!list||!list.length)return;for(var i=0;i<list.length;i++){var L=list[i];if(!L||!L.code)continue;LANGS[L.code]={n:(L.native||L.name||L.code),dir:(L.dir==='rtl'?'rtl':'ltr')};}}
  return {t:t,tx:tx,translate:translate,setLang:setLang,use:use,hasPref:hasPref,applyDir:applyDir,options:options,picker:picker,addLangs:addLangs,merge:function(c){if(!c)return;for(var l in c){D[l]=Object.assign(D[l]||{},c[l]);if(!LANGS[l])LANGS[l]={n:l,dir:'ltr'};}},get lang(){return lang;}};
})();
/* ---- Comprehensive UI termbase ----------------------------------------------------------------
 * The base dictionary only covered the section tabs; everything else (headings, table headers,
 * buttons, statuses, empty states, login prompts) stayed in English after switching language. This
 * supplement translates the whole fixed chrome of the portal for the built-in languages. It is merged
 * BEFORE any institution i18n_custom pack, so a school can still override any term. */
try{PI18N.merge({
  fr:{
    'Graduation':'Fin d’études','University Documents':'Documents universitaires','Online Exams':'Examens en ligne','E-Library':'Bibliothèque numérique','My Results':'Mes résultats','Examination Clearance':'Autorisation d’examen','Final Clearance (Graduation)':'Quitus final (fin d’études)','Exam Conduct':'Conduite d’examen','Course & Lecturer Evaluation':'Évaluation des cours et enseignants','Disciplinary Records':'Dossiers disciplinaires','Updates & Notifications':'Mises à jour et notifications','My Profile':'Mon profil','My Timetable & Course Allocation':'Mon emploi du temps et mes cours','Payment History & Receipts':'Historique des paiements et reçus','My Academic Progress':'Ma progression académique','My Tickets':'Mes tickets',
    'Office':'Bureau','Charged':'Facturé','Billed':'Facturé','Fee Category':'Catégorie de frais','Currency':'Devise','Description':'Description','Set By':'Défini par','Collected By':'Encaissé par','Day':'Jour','Time':'Heure','Lecturer':'Enseignant','Venue':'Salle','Title':'Titre','Type':'Type','From Office':'Bureau émetteur','Offense':'Infraction','Severity':'Gravité','Action':'Sanction','Fine':'Amende','Note':'Remarque','Purpose':'Objet','Requested':'Demandé','For':'Pour','Grade':'Note','Units':'Unités','Credit Units':'Unités de valeur','Score':'Score','Total':'Total','Bank':'Banque','Period':'Période','Net Pay':'Net à payer','Base / Default Pay':'Salaire de base','Payslips':'Bulletins de paie','Position':'Poste','Invoice':'Facture','Due':'Échéance',
    'Who You Owe — by Office':'Ce que vous devez — par bureau','Outstanding Fees':'Frais impayés','All Fees & Charges':'Tous les frais','Fee Invoices':'Factures','Other Result Documents':'Autres relevés','Exam Validation History':'Historique de validation des examens','Request an Official Document':'Demander un document officiel','Send My Documents to an Organization':'Envoyer mes documents à un organisme','My Documents':'Mes documents','Ready to graduate?':'Prêt à obtenir votre diplôme ?','My Payslips':'Mes bulletins de paie',
    'Download':'Télécharger','Download PDF':'Télécharger le PDF','Download full statement':'Télécharger le relevé complet','Download full statement (all semesters)':'Télécharger le relevé complet (tous les semestres)','Change password':'Changer le mot de passe','Pay online':'Payer en ligne','Read':'Lire','Request Transcript':'Demander un relevé','Request Certificate':'Demander un diplôme','Submit Evaluation':'Envoyer l’évaluation','Join':'Rejoindre','Appeal':'Contester','Payment not showing?':'Paiement non affiché ?','Set my password':'Définir mon mot de passe','Back to sign in':'Retour à la connexion','Set your password':'Définir votre mot de passe','Set your password →':'Définir votre mot de passe →','Verify a Transcript or Certificate':'Vérifier un relevé ou un diplôme','New password':'Nouveau mot de passe','Confirm':'Confirmer','Continue':'Continuer','Save & Continue':'Enregistrer et continuer','Back':'Retour','Next':'Suivant','Submit':'Envoyer','Email me a reset code':'M’envoyer un code de réinitialisation','I forgot my username':'J’ai oublié mon identifiant','Send code':'Envoyer le code','Verify & set password':'Vérifier et définir le mot de passe','Email me my username':'M’envoyer mon identifiant',
    'Cleared for exams':'Autorisé aux examens','Not cleared':'Non autorisé','Partially cleared':'Partiellement autorisé','Under review':'En cours d’examen','Pending':'En attente','Owing':'Dû','Cleared':'Réglé','Not approved':'Non approuvé','Resolved':'Résolu','Open':'Ouvert','Available':'Disponible','Not issued':'Non délivré','current':'en cours','Current':'En cours','Withheld':'Retenu','Released':'Publié',
    'Balance':'Solde','Balance:':'Solde :','Exam Status':'Statut d’examen','Welcome':'Bienvenue','Yes':'Oui','No':'Non','Loading…':'Chargement…','Cancel':'Annuler','Close':'Fermer','Search':'Rechercher','All':'Tout','Optional':'Facultatif','Required':'Obligatoire','minor':'mineur','major':'majeur','severe':'grave','I am a':'Je suis','Student':'Étudiant','Parent / Guardian':'Parent / Tuteur',
    'No documents published yet.':'Aucun document publié pour l’instant.','No requests yet.':'Aucune demande pour l’instant.','Nothing to show.':'Rien à afficher.','No invoices.':'Aucune facture.','No other result documents.':'Aucun autre relevé.','No exam validations yet.':'Aucune validation d’examen pour l’instant.','No misconduct on record.':'Aucune infraction enregistrée.','No payslips yet.':'Aucun bulletin de paie pour l’instant.',
    'Matric pending':'Matricule en attente','Set / reset your password':'Définir / réinitialiser votre mot de passe','Student, Staff & Lecturer Portal':'Portail étudiants, personnel et enseignants','First time here, or forgot your password?':'Première visite ou mot de passe oublié ?','New here? Not yet a student?':'Nouveau ? Pas encore étudiant ?'
  },
  es:{
    'Graduation':'Graduación','University Documents':'Documentos universitarios','Online Exams':'Exámenes en línea','E-Library':'Biblioteca digital','My Results':'Mis resultados','Examination Clearance':'Habilitación de examen','Final Clearance (Graduation)':'Habilitación final (graduación)','Exam Conduct':'Conducta de examen','Course & Lecturer Evaluation':'Evaluación de cursos y profesores','Disciplinary Records':'Registros disciplinarios','Updates & Notifications':'Novedades y notificaciones','My Profile':'Mi perfil','My Timetable & Course Allocation':'Mi horario y asignación de cursos','Payment History & Receipts':'Historial de pagos y recibos','My Academic Progress':'Mi progreso académico','My Tickets':'Mis tickets',
    'Office':'Oficina','Charged':'Cargado','Billed':'Facturado','Fee Category':'Categoría de tasa','Currency':'Moneda','Description':'Descripción','Set By':'Establecido por','Collected By':'Cobrado por','Day':'Día','Time':'Hora','Lecturer':'Profesor','Venue':'Aula','Title':'Título','Type':'Tipo','From Office':'Oficina emisora','Offense':'Falta','Severity':'Gravedad','Action':'Sanción','Fine':'Multa','Note':'Nota','Purpose':'Propósito','Requested':'Solicitado','For':'Por','Grade':'Calificación','Units':'Unidades','Credit Units':'Créditos','Score':'Puntuación','Total':'Total','Bank':'Banco','Period':'Período','Net Pay':'Pago neto','Base / Default Pay':'Salario base','Payslips':'Nóminas','Position':'Cargo','Invoice':'Factura','Due':'Vencimiento',
    'Who You Owe — by Office':'Lo que debes — por oficina','Outstanding Fees':'Tasas pendientes','All Fees & Charges':'Todas las tasas','Fee Invoices':'Facturas','Other Result Documents':'Otros documentos de resultados','Exam Validation History':'Historial de validación de exámenes','Request an Official Document':'Solicitar un documento oficial','Send My Documents to an Organization':'Enviar mis documentos a una organización','My Documents':'Mis documentos','Ready to graduate?':'¿Listo para graduarte?','My Payslips':'Mis nóminas',
    'Download':'Descargar','Download PDF':'Descargar PDF','Download full statement':'Descargar estado completo','Download full statement (all semesters)':'Descargar estado completo (todos los semestres)','Change password':'Cambiar contraseña','Pay online':'Pagar en línea','Read':'Leer','Request Transcript':'Solicitar expediente','Request Certificate':'Solicitar título','Submit Evaluation':'Enviar evaluación','Join':'Unirse','Appeal':'Apelar','Payment not showing?':'¿Pago no reflejado?','Set my password':'Establecer mi contraseña','Back to sign in':'Volver a iniciar sesión','Set your password':'Establece tu contraseña','Set your password →':'Establece tu contraseña →','Verify a Transcript or Certificate':'Verificar un expediente o título','New password':'Nueva contraseña','Confirm':'Confirmar','Continue':'Continuar','Save & Continue':'Guardar y continuar','Back':'Atrás','Next':'Siguiente','Submit':'Enviar','Email me a reset code':'Enviarme un código de restablecimiento','I forgot my username':'Olvidé mi usuario','Send code':'Enviar código','Verify & set password':'Verificar y establecer contraseña','Email me my username':'Enviarme mi usuario',
    'Cleared for exams':'Habilitado para exámenes','Not cleared':'No habilitado','Partially cleared':'Parcialmente habilitado','Under review':'En revisión','Pending':'Pendiente','Owing':'Adeuda','Cleared':'Saldado','Not approved':'No aprobado','Resolved':'Resuelto','Open':'Abierto','Available':'Disponible','Not issued':'No emitido','current':'actual','Current':'Actual','Withheld':'Retenido','Released':'Publicado',
    'Balance':'Saldo','Balance:':'Saldo:','Exam Status':'Estado del examen','Welcome':'Bienvenido','Yes':'Sí','No':'No','Loading…':'Cargando…','Cancel':'Cancelar','Close':'Cerrar','Search':'Buscar','All':'Todo','Optional':'Opcional','Required':'Obligatorio','minor':'leve','major':'grave','severe':'muy grave','I am a':'Soy','Student':'Estudiante','Parent / Guardian':'Padre / Tutor',
    'No documents published yet.':'Aún no hay documentos publicados.','No requests yet.':'Aún no hay solicitudes.','Nothing to show.':'Nada que mostrar.','No invoices.':'Sin facturas.','No other result documents.':'No hay otros documentos de resultados.','No exam validations yet.':'Aún no hay validaciones de examen.','No misconduct on record.':'Sin faltas registradas.','No payslips yet.':'Aún no hay nóminas.',
    'Matric pending':'Matrícula pendiente','Set / reset your password':'Establecer / restablecer tu contraseña','Student, Staff & Lecturer Portal':'Portal de estudiantes, personal y profesores','First time here, or forgot your password?':'¿Primera vez o olvidaste tu contraseña?','New here? Not yet a student?':'¿Nuevo? ¿Aún no eres estudiante?'
  },
  ar:{
    'Graduation':'التخرّج','University Documents':'الوثائق الجامعية','Online Exams':'الامتحانات الإلكترونية','E-Library':'المكتبة الإلكترونية','My Results':'نتائجي','Examination Clearance':'إخلاء طرف الامتحان','Final Clearance (Graduation)':'الإخلاء النهائي (التخرّج)','Exam Conduct':'سلوك الامتحان','Course & Lecturer Evaluation':'تقييم المقرر والمحاضر','Disciplinary Records':'السجلات التأديبية','Updates & Notifications':'التحديثات والإشعارات','My Profile':'ملفي الشخصي','My Timetable & Course Allocation':'جدولي وتوزيع المقررات','Payment History & Receipts':'سجل المدفوعات والإيصالات','My Academic Progress':'تقدّمي الأكاديمي','My Tickets':'تذاكري',
    'Office':'المكتب','Charged':'المستحق','Billed':'المفوتر','Fee Category':'فئة الرسوم','Currency':'العملة','Description':'الوصف','Set By':'حُدِّد بواسطة','Collected By':'حُصِّل بواسطة','Day':'اليوم','Time':'الوقت','Lecturer':'المحاضر','Venue':'القاعة','Title':'العنوان','Type':'النوع','From Office':'المكتب المُصدِر','Offense':'المخالفة','Severity':'الخطورة','Action':'الإجراء','Fine':'الغرامة','Note':'ملاحظة','Purpose':'الغرض','Requested':'تاريخ الطلب','For':'مقابل','Grade':'التقدير','Units':'الوحدات','Credit Units':'الوحدات المعتمدة','Score':'الدرجة','Total':'المجموع','Bank':'البنك','Period':'الفترة','Net Pay':'صافي الراتب','Base / Default Pay':'الراتب الأساسي','Payslips':'قسائم الراتب','Position':'المنصب','Invoice':'الفاتورة','Due':'الاستحقاق',
    'Who You Owe — by Office':'ما عليك دفعه — حسب المكتب','Outstanding Fees':'الرسوم المستحقة','All Fees & Charges':'جميع الرسوم','Fee Invoices':'الفواتير','Other Result Documents':'وثائق نتائج أخرى','Exam Validation History':'سجل اعتماد الامتحانات','Request an Official Document':'طلب وثيقة رسمية','Send My Documents to an Organization':'إرسال وثائقي إلى جهة','My Documents':'وثائقي','Ready to graduate?':'جاهز للتخرّج؟','My Payslips':'قسائم راتبي',
    'Download':'تنزيل','Download PDF':'تنزيل PDF','Download full statement':'تنزيل الكشف الكامل','Download full statement (all semesters)':'تنزيل الكشف الكامل (كل الفصول)','Change password':'تغيير كلمة المرور','Pay online':'ادفع إلكترونيًا','Read':'قراءة','Request Transcript':'طلب كشف الدرجات','Request Certificate':'طلب الشهادة','Submit Evaluation':'إرسال التقييم','Join':'انضمام','Appeal':'اعتراض','Payment not showing?':'الدفع لا يظهر؟','Set my password':'تعيين كلمة المرور','Back to sign in':'العودة لتسجيل الدخول','Set your password':'عيّن كلمة المرور','Set your password →':'عيّن كلمة المرور →','Verify a Transcript or Certificate':'التحقق من كشف درجات أو شهادة','New password':'كلمة مرور جديدة','Confirm':'تأكيد','Continue':'متابعة','Save & Continue':'حفظ ومتابعة','Back':'رجوع','Next':'التالي','Submit':'إرسال','Email me a reset code':'أرسل لي رمز إعادة تعيين','I forgot my username':'نسيت اسم المستخدم','Send code':'إرسال الرمز','Verify & set password':'تحقّق وعيّن كلمة المرور','Email me my username':'أرسل لي اسم المستخدم',
    'Cleared for exams':'مسموح بدخول الامتحان','Not cleared':'غير مسموح','Partially cleared':'مسموح جزئيًا','Under review':'قيد المراجعة','Pending':'قيد الانتظار','Owing':'مستحق','Cleared':'مُسدَّد','Not approved':'غير معتمد','Resolved':'تم الحل','Open':'مفتوح','Available':'متاح','Not issued':'غير صادر','current':'الحالي','Current':'الحالي','Withheld':'محجوب','Released':'منشور',
    'Balance':'الرصيد','Balance:':'الرصيد:','Exam Status':'حالة الامتحان','Welcome':'مرحبًا','Yes':'نعم','No':'لا','Loading…':'جارٍ التحميل…','Cancel':'إلغاء','Close':'إغلاق','Search':'بحث','All':'الكل','Optional':'اختياري','Required':'مطلوب','minor':'بسيط','major':'كبير','severe':'خطير','I am a':'أنا','Student':'طالب','Parent / Guardian':'ولي الأمر',
    'No documents published yet.':'لا توجد وثائق منشورة بعد.','No requests yet.':'لا توجد طلبات بعد.','Nothing to show.':'لا يوجد ما يُعرض.','No invoices.':'لا توجد فواتير.','No other result documents.':'لا توجد وثائق نتائج أخرى.','No exam validations yet.':'لا توجد اعتمادات امتحان بعد.','No misconduct on record.':'لا توجد مخالفات مسجلة.','No payslips yet.':'لا توجد قسائم راتب بعد.',
    'Matric pending':'الرقم الجامعي قيد الإصدار','Set / reset your password':'تعيين / إعادة تعيين كلمة المرور','Student, Staff & Lecturer Portal':'بوابة الطلاب والموظفين والمحاضرين','First time here, or forgot your password?':'أول مرة هنا أو نسيت كلمة المرور؟','New here? Not yet a student?':'جديد هنا؟ لست طالبًا بعد؟'
  },
  ha:{
    'Graduation':'Kammala karatu','University Documents':'Takardun jami’a','Online Exams':'Jarrabawar kan layi','E-Library':'Ɗakin karatu na dijital','My Results':'Sakamakona','Examination Clearance':'Izinin jarrabawa','Final Clearance (Graduation)':'Izini na ƙarshe (kammalawa)','Exam Conduct':'Halin jarrabawa','Course & Lecturer Evaluation':'Kimanta darasi da malami','Disciplinary Records':'Bayanan ladabtarwa','Updates & Notifications':'Sabuntawa da sanarwa','My Profile':'Bayanina','My Timetable & Course Allocation':'Jadawali da rabon darussa','Payment History & Receipts':'Tarihin biya da rasidi','My Academic Progress':'Cigabana na ilimi','My Tickets':'Koke-koke na',
    'Office':'Ofis','Charged':'An caji','Billed':'An caji','Fee Category':'Nau’in kuɗi','Currency':'Kuɗi','Description':'Bayani','Set By':'Wanda ya kafa','Collected By':'Wanda ya karɓa','Day':'Rana','Time':'Lokaci','Lecturer':'Malami','Venue':'Wuri','Title':'Take','Type':'Nau’i','From Office':'Daga ofis','Offense':'Laifi','Severity':'Girman laifi','Action':'Mataki','Fine':'Tara','Note':'Bayani','Purpose':'Dalili','Requested':'An nema','For':'Domin','Grade':'Daraja','Units':'Raka’o’i','Credit Units':'Raka’o’in kiredit','Score':'Maki','Total':'Jimla','Bank':'Banki','Period':'Lokaci','Net Pay':'Albashi na ƙarshe','Base / Default Pay':'Albashin asali','Payslips':'Takardun albashi','Position':'Muƙami','Invoice':'Takardar kuɗi','Due':'Ranar biya',
    'Who You Owe — by Office':'Abin da kake bin bashi — bisa ofis','Outstanding Fees':'Kuɗin da ba a biya ba','All Fees & Charges':'Dukkan kuɗi','Fee Invoices':'Takardun kuɗi','Other Result Documents':'Sauran takardun sakamako','Exam Validation History':'Tarihin tabbatar da jarrabawa','Request an Official Document':'Nemi takarda ta hukuma','Send My Documents to an Organization':'Aika takarduna zuwa ƙungiya','My Documents':'Takarduna','Ready to graduate?':'A shirye don kammala karatu?','My Payslips':'Takardun albashina',
    'Download':'Sauke','Download PDF':'Sauke PDF','Download full statement':'Sauke cikakken bayani','Download full statement (all semesters)':'Sauke cikakken bayani (dukkan sassa)','Change password':'Canza kalmar sirri','Pay online':'Biya kan layi','Read':'Karanta','Request Transcript':'Nemi kwafin sakamako','Request Certificate':'Nemi shaida','Submit Evaluation':'Aika kimantawa','Join':'Shiga','Appeal':'Ƙara','Payment not showing?':'Biya bai bayyana ba?','Set my password':'Kafa kalmar sirri','Back to sign in':'Koma shiga','Set your password':'Kafa kalmar sirrin ka','Set your password →':'Kafa kalmar sirrin ka →','Verify a Transcript or Certificate':'Tabbatar da sakamako ko shaida','New password':'Sabuwar kalmar sirri','Confirm':'Tabbatar','Continue':'Ci gaba','Save & Continue':'Ajiye ka ci gaba','Back':'Baya','Next':'Na gaba','Submit':'Aika','Email me a reset code':'Aiko min lambar sake saiti','I forgot my username':'Na manta sunan mai amfani','Send code':'Aika lamba','Verify & set password':'Tabbatar ka kafa kalmar sirri','Email me my username':'Aiko min sunan mai amfani na',
    'Cleared for exams':'An bar ka jarrabawa','Not cleared':'Ba a bari ba','Partially cleared':'An bar wani ɓangare','Under review':'Ana dubawa','Pending':'Ana jira','Owing':'Ana bin bashi','Cleared':'An biya','Not approved':'Ba a amince ba','Resolved':'An warware','Open':'A buɗe','Available':'Akwai','Not issued':'Ba a bayar ba','current':'na yanzu','Current':'Na yanzu','Withheld':'An riƙe','Released':'An fitar',
    'Balance':'Saura','Balance:':'Saura:','Exam Status':'Matsayin jarrabawa','Welcome':'Barka da zuwa','Yes':'Ee','No':'A’a','Loading…':'Ana ɗaukarwa…','Cancel':'Soke','Close':'Rufe','Search':'Nema','All':'Duka','Optional':'Na zaɓi','Required':'Wajibi','minor':'ƙarami','major':'babba','severe':'mai tsanani','I am a':'Ni','Student':'Ɗalibi','Parent / Guardian':'Iyaye / Mai kula',
    'No documents published yet.':'Ba a buga takardu ba tukuna.','No requests yet.':'Babu buƙata tukuna.','Nothing to show.':'Babu abin nunawa.','No invoices.':'Babu takardun kuɗi.','No other result documents.':'Babu sauran takardun sakamako.','No exam validations yet.':'Babu tabbatar da jarrabawa tukuna.','No misconduct on record.':'Babu laifi a rikodi.','No payslips yet.':'Babu takardun albashi tukuna.',
    'Matric pending':'Lambar rajista tana jira','Set / reset your password':'Kafa / sake kafa kalmar sirri','Student, Staff & Lecturer Portal':'Tashar ɗalibai, ma’aikata da malamai','First time here, or forgot your password?':'Sabon shiga ne, ko ka manta kalmar sirri?','New here? Not yet a student?':'Sabo ne? Ba ɗalibi tukuna?'
  }
});}catch(_){}
/* exam-clearance banner (a dynamic "LABEL — reason" line) + the reason phrases, so tx()'s " — " split
   can translate both halves */
try{PI18N.merge({
  fr:{'CLEARED for examinations':'AUTORISÉ aux examens','PARTIALLY CLEARED for exams':'PARTIELLEMENT AUTORISÉ aux examens','NOT CLEARED for exams':'NON AUTORISÉ aux examens','you still owe fees':'vous avez encore des frais impayés','Outstanding fees not cleared':'Frais impayés non réglés','No examination clearance issued':'Aucune autorisation d’examen délivrée','no clearance':'aucune autorisation'},
  es:{'CLEARED for examinations':'HABILITADO para exámenes','PARTIALLY CLEARED for exams':'PARCIALMENTE HABILITADO para exámenes','NOT CLEARED for exams':'NO HABILITADO para exámenes','you still owe fees':'aún debes tasas','Outstanding fees not cleared':'Tasas pendientes sin pagar','No examination clearance issued':'No se ha emitido habilitación de examen','no clearance':'sin habilitación'},
  ar:{'CLEARED for examinations':'مسموح بدخول الامتحانات','PARTIALLY CLEARED for exams':'مسموح جزئيًا بدخول الامتحانات','NOT CLEARED for exams':'غير مسموح بدخول الامتحانات','you still owe fees':'لا تزال عليك رسوم مستحقة','Outstanding fees not cleared':'رسوم مستحقة غير مسددة','No examination clearance issued':'لم يصدر إخلاء طرف للامتحان','no clearance':'لا يوجد إخلاء طرف'},
  ha:{'CLEARED for examinations':'AN BAR ka shiga jarrabawa','PARTIALLY CLEARED for exams':'AN BAR wani ɓangare na jarrabawa','NOT CLEARED for exams':'BA A BAR ka shiga jarrabawa ba','you still owe fees':'har yanzu kana bin kuɗi','Outstanding fees not cleared':'Kuɗin da ba a biya ba','No examination clearance issued':'Ba a bayar da izinin jarrabawa ba','no clearance':'babu izini'}
});}catch(_){}
/* password-change modal, offline banner, retry screen (the resilience UI added 2026-07) */
try{PI18N.merge({
  fr:{'Current password':'Mot de passe actuel','Confirm new password':'Confirmer le nouveau mot de passe','Show passwords':'Afficher les mots de passe','Save new password':'Enregistrer le nouveau mot de passe','It updates here and on the school system.':'Il est mis à jour ici et dans le système de l’école.','You are offline — showing your last saved data. Reconnecting…':'Vous êtes hors ligne — affichage de vos dernières données. Reconnexion…','Cannot reach the server':'Impossible de joindre le serveur','Check your connection. We will keep retrying automatically.':'Vérifiez votre connexion. Nouvel essai automatique.','Retry now':'Réessayer maintenant','Your session has expired — please sign in again.':'Votre session a expiré — veuillez vous reconnecter.'},
  es:{'Current password':'Contraseña actual','Confirm new password':'Confirmar la nueva contraseña','Show passwords':'Mostrar contraseñas','Save new password':'Guardar la nueva contraseña','It updates here and on the school system.':'Se actualiza aquí y en el sistema de la escuela.','You are offline — showing your last saved data. Reconnecting…':'Estás sin conexión — mostrando tus últimos datos guardados. Reconectando…','Cannot reach the server':'No se puede conectar con el servidor','Check your connection. We will keep retrying automatically.':'Revisa tu conexión. Seguiremos reintentando automáticamente.','Retry now':'Reintentar ahora','Your session has expired — please sign in again.':'Tu sesión ha expirado — inicia sesión de nuevo.'},
  ar:{'Current password':'كلمة المرور الحالية','Confirm new password':'تأكيد كلمة المرور الجديدة','Show passwords':'إظهار كلمات المرور','Save new password':'حفظ كلمة المرور الجديدة','It updates here and on the school system.':'يتم تحديثها هنا وفي نظام الجامعة.','You are offline — showing your last saved data. Reconnecting…':'أنت غير متصل — نعرض آخر بياناتك المحفوظة. جارٍ إعادة الاتصال…','Cannot reach the server':'تعذر الوصول إلى الخادم','Check your connection. We will keep retrying automatically.':'تحقق من اتصالك. سنواصل المحاولة تلقائيًا.','Retry now':'أعد المحاولة الآن','Your session has expired — please sign in again.':'انتهت صلاحية جلستك — يرجى تسجيل الدخول مجددًا.'},
  ha:{'Current password':'Kalmar sirri ta yanzu','Confirm new password':'Tabbatar da sabuwar kalmar sirri','Show passwords':'Nuna kalmomin sirri','Save new password':'Ajiye sabuwar kalmar sirri','It updates here and on the school system.':'Ana sabunta ta a nan da kuma tsarin makaranta.','You are offline — showing your last saved data. Reconnecting…':'Ba ka da haɗi — muna nuna bayanan da aka ajiye. Ana sake haɗawa…','Cannot reach the server':'Ba a iya kaiwa uwar garke ba','Check your connection. We will keep retrying automatically.':'Duba haɗin ka. Za mu ci gaba da sake gwadawa.','Retry now':'Sake gwadawa yanzu','Your session has expired — please sign in again.':'Zamanka ya ƙare — ka sake shiga.'}
});}catch(_){}
/* wide split-screen sign-in hero (homepage) */
try{PI18N.merge({
  fr:{'Your whole campus, in one place.':'Tout votre campus, au même endroit.','Results, fees, timetable, live classes and official documents — one secure portal for students, staff and lecturers.':'Résultats, frais, emploi du temps, cours en direct et documents officiels — un portail sécurisé pour étudiants, personnel et enseignants.','Results & GPA':'Résultats et moyenne','Grades, transcripts and your live CGPA.':'Notes, relevés et votre moyenne en direct.','Fees & Receipts':'Frais et reçus','Check your balance and pay online instantly.':'Consultez votre solde et payez en ligne instantanément.','Timetable & Classes':'Emploi du temps et cours','Lectures, exams and live video classes.':'Cours, examens et classes vidéo en direct.','Documents':'Documents','Admission letter, transcripts & certificates.':'Lettre d’admission, relevés et diplômes.','Employer, university or agency?':'Employeur, université ou administration ?','Verify a Transcript or Certificate →':'Vérifier un relevé ou un diplôme →'},
  es:{'Your whole campus, in one place.':'Todo tu campus, en un solo lugar.','Results, fees, timetable, live classes and official documents — one secure portal for students, staff and lecturers.':'Resultados, tasas, horario, clases en vivo y documentos oficiales — un portal seguro para estudiantes, personal y profesores.','Results & GPA':'Resultados y promedio','Grades, transcripts and your live CGPA.':'Notas, expedientes y tu promedio en vivo.','Fees & Receipts':'Tasas y recibos','Check your balance and pay online instantly.':'Consulta tu saldo y paga en línea al instante.','Timetable & Classes':'Horario y clases','Lectures, exams and live video classes.':'Clases, exámenes y clases por vídeo en vivo.','Documents':'Documentos','Admission letter, transcripts & certificates.':'Carta de admisión, expedientes y títulos.','Employer, university or agency?':'¿Empleador, universidad o agencia?','Verify a Transcript or Certificate →':'Verificar un expediente o título →'},
  ar:{'Your whole campus, in one place.':'حرمك الجامعي كله في مكان واحد.','Results, fees, timetable, live classes and official documents — one secure portal for students, staff and lecturers.':'النتائج والرسوم والجدول والحصص المباشرة والوثائق الرسمية — بوابة آمنة واحدة للطلاب والموظفين والمحاضرين.','Results & GPA':'النتائج والمعدل','Grades, transcripts and your live CGPA.':'الدرجات وكشوف الدرجات ومعدلك التراكمي مباشرة.','Fees & Receipts':'الرسوم والإيصالات','Check your balance and pay online instantly.':'تحقق من رصيدك وادفع إلكترونيًا فورًا.','Timetable & Classes':'الجدول والحصص','Lectures, exams and live video classes.':'المحاضرات والامتحانات والحصص المرئية المباشرة.','Documents':'الوثائق','Admission letter, transcripts & certificates.':'خطاب القبول وكشوف الدرجات والشهادات.','Employer, university or agency?':'صاحب عمل أو جامعة أو جهة؟','Verify a Transcript or Certificate →':'تحقّق من كشف درجات أو شهادة →'},
  ha:{'Your whole campus, in one place.':'Dukkan makarantarka, wuri ɗaya.','Results, fees, timetable, live classes and official documents — one secure portal for students, staff and lecturers.':'Sakamako, kuɗi, jadawali, azuzuwa kai tsaye da takardu na hukuma — tasha ɗaya mai tsaro ga ɗalibai, ma’aikata da malamai.','Results & GPA':'Sakamako da GPA','Grades, transcripts and your live CGPA.':'Darajoji, kwafin sakamako da CGPA kai tsaye.','Fees & Receipts':'Kuɗi da rasidi','Check your balance and pay online instantly.':'Duba saura ka biya kan layi nan take.','Timetable & Classes':'Jadawali da azuzuwa','Lectures, exams and live video classes.':'Laccoci, jarrabawa da azuzuwan bidiyo kai tsaye.','Documents':'Takardu','Admission letter, transcripts & certificates.':'Wasiƙar shiga, kwafin sakamako da shaidu.','Employer, university or agency?':'Ma’aikaci, jami’a ko hukuma?','Verify a Transcript or Certificate →':'Tabbatar da sakamako ko shaida →'}
});}catch(_){}
/* the "verify a credential" footer that sits at the bottom of every signed-in page (a sentence split
   by an inline link — each half is its own text node) */
try{PI18N.merge({
  fr:{'Employers & institutions can':'Les employeurs et institutions peuvent','verify a transcript or certificate here':'vérifier un relevé ou un diplôme ici'},
  es:{'Employers & institutions can':'Los empleadores e instituciones pueden','verify a transcript or certificate here':'verificar un expediente o título aquí'},
  ar:{'Employers & institutions can':'يمكن لأصحاب العمل والمؤسسات','verify a transcript or certificate here':'التحقق من كشف الدرجات أو الشهادة هنا'},
  ha:{'Employers & institutions can':'Masu ɗaukar aiki da cibiyoyi za su iya','verify a transcript or certificate here':'tabbatar da sakamako ko shaida a nan'}
});}catch(_){}

async function renderLogin(msg){
  // paint instantly: race the branding fetch against 1.2s, fall back to the cached/last-seen
  // branding, and repaint once the real branding lands if we painted stale defaults.
  var bp=fetchBranding(0);
  let b=await Promise.race([bp,new Promise(function(res){setTimeout(function(){res(null);},1200);})]);
  var paintedStale=!b; b=b||brandCache()||{};
  if(paintedStale)bp.then(function(nb){try{if(nb&&document.querySelector('.authwrap')&&JSON.stringify(nb)!==JSON.stringify(b))renderLogin(msg);}catch(_){}});
  const uname=eh(b.name||'University Portal');
  const heroLogo=b.logo?'<img src="'+b.logo+'" alt="logo">':'<div class="mono">'+eh((b.short||'UB').slice(0,3))+'</div>';
  // multi-campus: a student picks the campus they belong to at login (so they're allocated to it)
  const campusField=(b.campuses&&b.campuses.length)?('<div class="field"><label>🏫 Your campus</label><select id="cmp"><option value="">Select your campus…</option>'+b.campuses.map(function(c){return '<option value="'+c.id+'">'+eh(c.name)+'</option>';}).join('')+'</select></div>'):'';
  const locked=b.licensed===false;
  const lockBanner=locked?('<div style="background:#fee2e2;color:#991b1b;border-radius:9px;padding:10px 12px;margin-bottom:10px;font-size:13px">🔒 This institution\\'s software has not been activated. Please contact your administrator.</div>'):'';
  const feat=function(ic,t,dsc){return '<div class="f"><div class="fi">'+ic+'</div><div><div class="ft">'+t+'</div><div class="fd">'+dsc+'</div></div></div>';};
  // LEFT — branded hero that fills the desktop width (collapses to a compact banner on phones)
  const hero='<div class="authhero">'
    +'<div class="hbrand">'+heroLogo+'<div><div class="hname">'+uname+'</div>'+(b.motto?('<div class="hmotto">'+eh(b.motto)+'</div>'):'')+'</div></div>'
    +'<h1>Your whole campus, in one place.</h1>'
    +'<div class="hsub">Results, fees, timetable, live classes and official documents — one secure portal for students, staff and lecturers.</div>'
    +'<div class="authfeat">'
      +feat('📊','Results &amp; GPA','Grades, transcripts and your live CGPA.')
      +feat('💳','Fees &amp; Receipts','Check your balance and pay online instantly.')
      +feat('🗓','Timetable &amp; Classes','Lectures, exams and live video classes.')
      +feat('🎓','Documents','Admission letter, transcripts &amp; certificates.')
    +'</div>'
    +'<div class="hverify">🏛 Employer, university or agency? <a href="/verify-credentials">Verify a Transcript or Certificate →</a></div>'
  +'</div>';
  // RIGHT — the focused sign-in card
  const panel='<div class="authpanel"><div class="authcard">'
    +'<div class="psub" style="margin-top:0">🎓 Student, Staff &amp; Lecturer Portal</div>'
    +lockBanner
    +'<div class="err"></div>'
    +'<div class="field"><label>Matric no · Staff no · Username · Email</label><input id="lg" autofocus autocomplete="username"></div>'
    +'<div class="field"><label>Password</label><input id="pw" type="password" autocomplete="current-password"></div>'
    +campusField
    +'<button class="btn" id="go">Sign In</button>'
    +'<div class="hintbar">First time here, or forgot your password? <a href="#" id="recover" style="color:var(--brand);font-weight:700;text-decoration:none">Set your password →</a></div>'
    +'<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line);text-align:center"><div class="sub" style="margin-bottom:8px">New here? Not yet a student?</div><a href="/apply" style="display:inline-block;background:var(--navy);color:#fff;padding:10px 18px;border-radius:9px;text-decoration:none;font-weight:700">🎓 Apply for Admission</a></div>'
    // verify-credentials entrance — visible on phones too (the hero link is desktop-only)
    +'<div style="margin-top:12px;background:#f0fdf4;border:1.5px solid #86efac;border-radius:12px;padding:11px 14px;text-align:center">'
    +'<div style="font-weight:800;color:#14532d;font-size:13px;margin-bottom:6px">🏛 Employer · University · Government agency?</div>'
    +'<a href="/verify-credentials" style="display:inline-block;background:#15803d;color:#fff;padding:9px 16px;border-radius:9px;text-decoration:none;font-weight:700;font-size:13px">🎓 Verify a Transcript or Certificate</a></div>'
    +'<div class="sub" style="margin-top:8px;text-align:center"><a href="/scan">🛡 Staff: open the Clearance Scanner →</a></div>'
    +'<div style="margin-top:12px;text-align:center;display:flex;gap:8px;align-items:center;justify-content:center">🌐 '+PI18N.picker('color:inherit')+themeBtn('')+'</div>'
    +'</div></div>';
  document.getElementById('app').innerHTML='';
  const box=$('<div class="authwrap">'+hero+panel+'</div>');
  document.getElementById('app').appendChild(box);
  try{PI18N.translate(box);}catch(_){}
  if(msg){const e=box.querySelector('.err');e.textContent=msg;e.style.display='block';}
  const go=async()=>{if(locked){const e=box.querySelector('.err');e.textContent='This institution\\'s software is not activated. Contact your administrator.';e.style.display='block';return;}const login=box.querySelector('#lg').value.trim();const password=box.querySelector('#pw').value;if(!login||!password)return;const cmpEl=box.querySelector('#cmp');const campus_id=cmpEl?cmpEl.value:undefined;const btn=box.querySelector('#go');btn.disabled=true;btn.textContent='Signing in…';const r=await api('/api/login',{method:'POST',body:JSON.stringify({login,password,campus_id})});btn.disabled=false;btn.textContent='Sign In';if(!r.ok){const e=box.querySelector('.err');e.textContent=r.error||'Login failed.';e.style.display='block';return;}TOKEN=r.token;localStorage.setItem('ubu_token',TOKEN);renderApp();};
  box.querySelector('#go').onclick=go;
  var rec=box.querySelector('#recover');if(rec)rec.onclick=function(e){e.preventDefault();recoverPassword();};
  box.querySelectorAll('input').forEach(i=>i.addEventListener('keydown',function(e){if(e.key==='Enter')go();}));
}

// Self-service first-time / forgot-password for students & parents — proves identity with the email/phone
// on record (no reliance on the welcome email being received), then sets a password and signs them in.
async function recoverPassword(){
  let b=await fetchBranding(1200);
  const logo=b.logo?'<img class="blogo" src="'+b.logo+'" alt="logo">':'<div class="blogo mono">'+eh((b.short||'UB').slice(0,3))+'</div>';
  document.getElementById('app').innerHTML='';
  const box=$('<div class="login"><div class="card lbox">'
    +'<div class="brandhead">'+logo+'<div><div class="uname">'+eh(b.name||'University Portal')+'</div><div class="umotto">Set / reset your password</div></div></div>'
    // two recovery methods: a code emailed to you (forgot everything), or prove identity with a contact on file
    +'<div class="rtabs" style="display:flex;gap:5px;background:#f1f5f9;border-radius:11px;padding:4px;margin:12px 0 14px">'
      +'<button type="button" class="rtab" data-m="code" style="flex:1;border:0;background:#fff;border-radius:8px;padding:9px 6px;font-weight:700;font-size:12px;cursor:pointer;box-shadow:0 1px 4px rgba(15,23,42,.08)">📧 Email me a code</button>'
      +'<button type="button" class="rtab" data-m="know" style="flex:1;border:0;background:transparent;border-radius:8px;padding:9px 6px;font-weight:700;font-size:12px;cursor:pointer;color:#475569">🔑 I have my details</button>'
    +'</div>'
    +'<div class="err"></div><div class="ok2" style="display:none;color:#166534;background:#dcfce7;border-radius:9px;padding:10px 12px;margin-bottom:10px;font-size:13px"></div>'
    // --- METHOD A: email a reset code (works even if you forgot your username too) ---
    +'<div class="m-code">'
      +'<div class="sub" style="margin-bottom:10px;font-size:12.5px">Forgot your username too? Enter your matric number, username or email and we will email a 6-digit code to the address the school has on file.</div>'
      +'<div class="field"><label>Matric no · Username · Email</label><input id="clg" autocomplete="username"></div>'
      +'<button class="btn" id="csend">Send code</button>'
      +'<div class="codestep" style="display:none;margin-top:14px;border-top:1px solid rgba(148,163,184,.3);padding-top:14px">'
        +'<div class="sub" id="chint" style="margin-bottom:10px;font-size:12.5px"></div>'
        +'<div class="field"><label>6-digit code</label><input id="ccode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="••••••"></div>'
        +'<div class="field"><label>New password</label><input id="cpw" type="password" autocomplete="new-password"></div>'
        +'<button class="btn" id="cverify">Verify &amp; set password</button>'
        +'<div class="sub" style="margin-top:8px;text-align:center"><a href="#" id="cresend">Didn’t get it? Send again</a></div>'
      +'</div>'
    +'</div>'
    // --- METHOD B: instant recovery by proving a contact on file ---
    +'<div class="m-know" style="display:none">'
      +'<div class="sub" style="margin-bottom:10px;font-size:12.5px">Prove it is you with the email or phone number the school has on file, then choose a new password.</div>'
      +'<div class="field"><label>I am a</label><select id="who"><option value="student">Student</option><option value="parent">Parent / Guardian</option></select></div>'
      +'<div class="field"><label>Matric number / username</label><input id="rlg"></div>'
      +'<div class="field"><label>Email or phone on your record</label><input id="rvf" placeholder="email or phone the school has for you"></div>'
      +'<div class="field"><label>New password</label><input id="rpw" type="password" autocomplete="new-password"></div>'
      +'<button class="btn" id="rgo">Set my password</button>'
    +'</div>'
    +'<div class="sub" style="margin-top:14px;text-align:center;line-height:1.9"><a href="#" id="fuser">Forgot your username?</a><br><a href="#" id="rback">← Back to sign in</a></div>'
    +'</div></div>');
  document.getElementById('app').appendChild(box);
  const err=box.querySelector('.err'),ok=box.querySelector('.ok2');
  const showErr=(m)=>{ok.style.display='none';err.textContent=m;err.style.display='block';};
  const clearMsg=()=>{err.style.display='none';ok.style.display='none';};
  // sign the recovered account in and open the portal
  const finishLogin=async(username,password)=>{
    ok.style.display='none';ok.textContent='✓ Done! Your username is '+username+'. Signing you in…';ok.style.display='block';
    const lr=await api('/api/login',{method:'POST',body:JSON.stringify({login:username,password:password})});
    if(lr.ok){TOKEN=lr.token;localStorage.setItem('ubu_token',TOKEN);setTimeout(renderApp,700);}else{setTimeout(function(){renderLogin('Password set — please sign in.');},1200);}
  };
  // method switch
  box.querySelectorAll('.rtab').forEach(function(t){t.onclick=function(){
    clearMsg();
    box.querySelectorAll('.rtab').forEach(function(x){var on=x===t;x.style.background=on?'#fff':'transparent';x.style.color=on?'':'#475569';x.style.boxShadow=on?'0 1px 4px rgba(15,23,42,.08)':'none';});
    box.querySelector('.m-code').style.display=t.getAttribute('data-m')==='code'?'':'none';
    box.querySelector('.m-know').style.display=t.getAttribute('data-m')==='know'?'':'none';
  };});
  // METHOD A — send code
  const sendCode=async()=>{
    clearMsg();
    const login=box.querySelector('#clg').value.trim();
    if(!login){showErr('Enter your matric number, username or email.');return;}
    const btn=box.querySelector('#csend');btn.disabled=true;btn.textContent='Sending…';
    const r=await api('/api/portal/reset-request',{method:'POST',body:JSON.stringify({login:login})});
    btn.disabled=false;btn.textContent='Send code';
    if(!r.ok){showErr(r.error||'Could not send a code.');return;}
    box.querySelector('.codestep').style.display='block';
    box.querySelector('#chint').textContent='We emailed a 6-digit code to '+(r.hint||'the address on your record')+'. Enter it below with a new password.';
    box.querySelector('#ccode').focus();
  };
  box.querySelector('#csend').onclick=sendCode;
  box.querySelector('#cresend').onclick=function(ev){ev.preventDefault();sendCode();};
  // METHOD A — verify code + set password
  box.querySelector('#cverify').onclick=async()=>{
    clearMsg();
    const login=box.querySelector('#clg').value.trim(),code=box.querySelector('#ccode').value.trim(),password=box.querySelector('#cpw').value;
    if(!code||!password){showErr('Enter the code and a new password.');return;}
    const btn=box.querySelector('#cverify');btn.disabled=true;btn.textContent='Verifying…';
    const r=await api('/api/portal/reset-confirm',{method:'POST',body:JSON.stringify({login:login,code:code,password:password})});
    btn.disabled=false;btn.textContent='Verify & set password';
    if(!r.ok){showErr(r.error||'Could not reset your password.');return;}
    finishLogin(r.username,password);
  };
  // METHOD B — instant recovery
  box.querySelector('#rgo').onclick=async()=>{
    clearMsg();
    const login=box.querySelector('#rlg').value.trim(),verify=box.querySelector('#rvf').value.trim(),password=box.querySelector('#rpw').value,role=box.querySelector('#who').value;
    if(!login||!verify||!password){showErr('Please fill in all the fields.');return;}
    const btn=box.querySelector('#rgo');btn.disabled=true;btn.textContent='Setting…';
    const r=await api('/api/portal/recover',{method:'POST',body:JSON.stringify({login:login,verify:verify,password:password,role:role})});
    btn.disabled=false;btn.textContent='Set my password';
    if(!r.ok){showErr(r.error||'Could not set your password.');return;}
    finishLogin(r.username,password);
  };
  // Forgot username → email it to the address on file
  box.querySelector('#fuser').onclick=async function(ev){
    ev.preventDefault();clearMsg();
    const email=prompt('Enter the email address the school has on your record — we will email your username to it:');
    if(email===null)return;
    if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email.trim())){showErr('Enter a valid email address.');return;}
    await api('/api/portal/username-reminder',{method:'POST',body:JSON.stringify({email:email.trim()})});
    ok.textContent='✓ If that email is on our records, we have emailed your username to it. Check your inbox (and spam).';ok.style.display='block';
  };
  box.querySelector('#rback').onclick=function(ev){ev.preventDefault();renderLogin();};
  box.querySelectorAll('input').forEach(i=>i.addEventListener('keydown',function(e){if(e.key!=='Enter')return;
    // Enter triggers the primary action of the visible method
    if(box.querySelector('.m-code').style.display!=='none'){ if(box.querySelector('.codestep').style.display!=='none')box.querySelector('#cverify').click(); else box.querySelector('#csend').click(); }
    else box.querySelector('#rgo').click();
  }));
  try{PI18N.translate(box);}catch(_){}
}

// ---- NATIVE NOTIFICATIONS (Android/iOS app) -------------------------------
// When this portal runs INSIDE the mobile app (Capacitor WebView), fire a real OS notification
// (heads-up + sound) for every NEW item in the student's derived feed, so they are alerted even
// when they are not staring at the screen. On the plain web there is no Capacitor bridge → this is
// a silent no-op (the in-app 🔔 Updates tab still shows everything). renderApp() re-runs whenever the
// data version changes (every ~2.5s poll), so new receipts/results/fees trigger a notification within
// seconds of syncing. A per-account marker prevents the same item from notifying twice.
var NATIVE=(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.LocalNotifications)||null;
function isNativeApp(){return !!(window.Capacitor&&(window.Capacitor.isNativePlatform?window.Capacitor.isNativePlatform():window.Capacitor.platform&&window.Capacitor.platform!=='web'));}
var _notifReady=null;
function ensureNotif(){
  if(_notifReady)return _notifReady;
  _notifReady=(async function(){
    if(!NATIVE)return false;
    try{
      var pe=await NATIVE.checkPermissions();var granted=pe&&pe.display==='granted';
      if(!granted){var rq=await NATIVE.requestPermissions();granted=rq&&rq.display==='granted';}
      if(!granted)return false;
      try{ if(NATIVE.createChannel) await NATIVE.createChannel({id:'ubu-updates',name:'Portal Updates',description:'Fees, results, receipts and announcements',importance:5,visibility:1}); }catch(_){}
      return true;
    }catch(_){return false;}
  })();
  return _notifReady;
}
async function nativeNotify(notifs,key){
  if(!NATIVE||!notifs||!notifs.length)return;
  var ok=await ensureNotif();if(!ok)return;
  var markKey='ubu_notified_'+key;var last=localStorage.getItem(markKey)||'';var newest=String((notifs[0]&&notifs[0].date)||'');
  if(!newest)return;
  if(!last){localStorage.setItem(markKey,newest);return;} // first run on this device → set baseline, don't spam
  var fresh=notifs.filter(function(n){return String(n.date||'')>last;});
  if(!fresh.length)return;
  var toFire=fresh.slice(0,5).reverse();var base=Date.now()%2000000000;
  var arr=toFire.map(function(n,i){return {id:base+i,title:((n.icon?n.icon+' ':'')+(n.title||'Update')).slice(0,80),body:String(n.text||'').slice(0,180),channelId:'ubu-updates',extra:{seg:n.seg||null,doc:n.doc||null}};});
  try{await NATIVE.schedule({notifications:arr});}catch(_){}
  localStorage.setItem(markKey,newest);
}
// Tapping a notification opens the relevant section once the app is focused.
if(NATIVE&&NATIVE.addListener){try{NATIVE.addListener('localNotificationActionPerformed',function(ev){try{var ex=ev&&ev.notification&&ev.notification.extra;if(ex&&ex.seg&&window.__goSeg)window.__goSeg(ex.seg);}catch(_){}});}catch(_){}}
// Android hardware BACK button: navigate within the app (back to Overview) instead of closing it.
(function(){var A=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App;if(!A||!A.addListener)return;try{A.addListener('backButton',function(){try{var seg=window.__seg||'overview';if(seg&&seg!=='overview'&&window.__goSeg){window.__goSeg('overview');return;}if(A.minimizeApp)A.minimizeApp();else if(A.exitApp)A.exitApp();}catch(_){}});}catch(_){}})();

// Signature of the last-rendered data — a live "version" bump is GLOBAL (any change anywhere in the
// institution bumps it), so most bumps are irrelevant to this one student. We only rebuild the DOM
// when the data THIS user actually sees has changed, which stops the constant full-page reloads.
let LAST_SIG='';
function dataSig(d){try{return JSON.stringify(d);}catch(_){return String(Date.now());}}
// opts.data — pre-fetched payload (skips a round-trip); opts.bg — silent live refresh (no scroll jump,
// no entrance animation); opts.keepVer — caller already set VER.
let RETRY_T=null;
// Shown when there is no session data to paint AND the server is unreachable — the student is NOT
// logged out (their token is fine); we keep retrying until the connection returns.
function renderRetry(){
  const app=document.getElementById('app');
  app.innerHTML='<div class="login"><div class="card lbox" style="text-align:center"><div style="font-size:44px">📡</div><h2 style="margin:8px 0 4px;font-size:18px">Cannot reach the server</h2><div class="sub" style="margin-bottom:14px">Check your connection. We will keep retrying automatically.</div><button class="btn" onclick="renderApp()">Retry now</button></div></div>';
  try{PI18N.translate(app);}catch(_){}
  if(RETRY_T)clearTimeout(RETRY_T);
  RETRY_T=setTimeout(function(){renderApp();},6000);
}
async function renderApp(opts){
  opts=opts||{};
  if(RETRY_T){clearTimeout(RETRY_T);RETRY_T=null;}
  let d=opts.data;
  if(!d){
    const r=await api('/api/data');
    if(r&&r.ok){ d=r.data; saveCache(d); setOffline(false); }
    else if(r&&r.__status===401){ return logout('Your session has expired — please sign in again.'); }
    else { // offline or a server hiccup: fall back to the last-good data instead of kicking the student out
      const c=dataCache();
      if(c){ d=c; setOffline(true); }
      else return renderRetry();
    }
  }
  LAST_SIG=dataSig(d);
  window.__renderBg=!!opts.bg;   // studentView.show() reads this to avoid scroll-jumping on a live refresh
  const app=document.getElementById('app');
  if(opts.bg)app.classList.add('bgswap'); else app.classList.remove('bgswap');
  app.innerHTML='';
  app.appendChild($('<div class="top"><div class="nm">'+eh(d.institution||'UniBursar')+'</div><div class="rl">'+(d.profile&&d.profile.full_name?eh(d.profile.full_name)+' · ':'')+eh(d.role||'')+' <span class="live">● live</span></div>'+PI18N.picker('margin-left:14px')+themeBtn('margin-left:8px')+'<button class="btn sm ghost" style="margin-left:8px" onclick="changePassword()">🔑 Password</button><button class="btn sm ghost" style="margin-left:8px" onclick="logout()">Sign out</button></div>'));
  const w=$('<div class="wrap"></div>');app.appendChild(w);
  if(d.kind==='student')studentView(w,d);
  else if(d.kind==='staff')staffView(w,d);
  else officerView(w,d);
  w.appendChild($('<div style="margin:18px 0 8px;text-align:center;font-size:12px;color:#64748b">🏛 Employers &amp; institutions can <a href="/verify-credentials" style="color:#15803d;font-weight:700">verify a transcript or certificate here</a>.</div>'));
  try{PI18N.translate(app);}catch(_){}
  if(d.kind==='student'){mountChat();try{nativeNotify(d.notifications,(d.profile&&(d.profile.matric_no||d.profile.full_name))||'me');}catch(_){}}
  window.__renderBg=false;
  if(opts.bg)setTimeout(function(){try{app.classList.remove('bgswap');}catch(_){}},520);
  if(!opts.keepVer){try{VER=(await api('/api/version')).version||0;}catch(_){}}
  startPoll();
}
let POLLING=false;
async function pollOnce(){
  if(POLLING)return; POLLING=true;
  try{
    // Tab backgrounded → skip WITHOUT consuming the version, so we still catch up the moment the
    // student returns to the tab (below, on visibilitychange). Also never fight a form being typed in.
    if(document.hidden)return;
    var ae=document.activeElement;
    if(ae&&/^(SELECT|INPUT|TEXTAREA)$/.test(ae.tagName))return;
    const vr=await api('/api/version');
    if(vr&&vr.__net){setOffline(true);return;}                     // offline: keep the page, show the pill, retry next tick
    setOffline(false);
    if(vr.version===VER)return;                                    // nothing changed anywhere → nothing to do
    const r=await api('/api/data');
    if(r&&r.__status===401)return logout('Your session has expired — please sign in again.');
    if(!r||!r.ok)return;
    VER=vr.version;
    saveCache(r.data);
    if(dataSig(r.data)===LAST_SIG)return;                          // this student's data is unchanged → NO reload
    const y=window.scrollY||window.pageYOffset||0;
    await renderApp({data:r.data,bg:true,keepVer:true});
    try{window.scrollTo(0,y);}catch(_){}                           // stay exactly where the student was
  }catch(_){}finally{POLLING=false;}
}
// After painting from the local cache, pull fresh data ONCE in the background and swap it in
// silently if anything changed (the cache may be hours old; the poll only reacts to version bumps
// AFTER this baseline).
async function refreshFromServer(){
  try{
    const r=await api('/api/data');
    if(r&&r.__status===401)return logout('Your session has expired — please sign in again.');
    if(r&&r.__net){setOffline(true);return;}
    if(!r||!r.ok)return;
    setOffline(false);saveCache(r.data);
    if(dataSig(r.data)!==LAST_SIG){
      const y=window.scrollY||window.pageYOffset||0;
      await renderApp({data:r.data,bg:true});
      try{window.scrollTo(0,y);}catch(_){}
    }
  }catch(_){}
}
function startPoll(){
  if(TIMER)clearInterval(TIMER);
  TIMER=setInterval(pollOnce,4000);
}
// Coming back to the tab? Check for updates immediately instead of waiting out the interval.
if(!window.__visWired){window.__visWired=true;try{document.addEventListener('visibilitychange',function(){if(!document.hidden&&TOKEN)pollOnce();});}catch(_){}}
function tbl(cols,rows,empty){if(!rows||!rows.length)return '<div class="empty">'+(empty||'Nothing to show.')+'</div>';return '<div class="tscroll"><table><thead><tr>'+cols.map(c=>'<th class="'+(c.r?'r':'')+'">'+c.t+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+cols.map(c=>'<td class="'+(c.r?'r':'')+'">'+c.f(row)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';}
function doc(path){window.open(path+(path.includes('?')?'&':'?')+'t='+encodeURIComponent(TOKEN),'_blank');}
async function reqTranscript(kind){
  var purpose=prompt('Purpose of the official '+kind+' (e.g. further studies, employment):','');
  if(purpose===null)return;
  try{var r=await api('/api/transcript-request',{method:'POST',body:JSON.stringify({kind:kind,purpose:purpose})});
    if(r&&r.ok){alert('Request submitted. The Registry will process it, email you a signed copy and place it here for download.');renderApp();}
    else{alert((r&&r.error)||'Could not submit the request.');}}catch(e){alert('Could not submit the request right now.');}
}
// 📨 GRADUATE ONLY — send the selected documents to an organization via the Office of the Registrar.
async function sendToOrg(){
  var el=function(id){return document.getElementById(id);};
  var orgType=el('orgType').value, orgName=el('orgName').value.trim(), orgEmail=el('orgEmail').value.trim();
  var docs=[].slice.call(document.querySelectorAll('.odck:checked')).map(function(x){return x.value;});
  var msg=el('orgMsg'); msg.innerHTML='';
  var err=function(t){msg.innerHTML='<div class="empty" style="color:#b91c1c;border-color:#fecaca;background:#fef2f2;margin-top:8px">'+t+'</div>';};
  if(!orgName)return err('Enter the organization’s name.');
  if(!orgEmail||orgEmail.indexOf('@')<0)return err('Enter a valid email address for the organization.');
  if(!docs.length)return err('Tick at least one document to send.');
  if(!confirm('Send your '+docs.join(', ')+' to '+orgName+' ('+orgEmail+')?\\n\\nThe documents are emailed by the Office of the Registrar and the send is logged.'))return;
  el('orgSend').disabled=true; el('orgSend').textContent='Sending…';
  try{
    var r=await api('/api/my/send-documents',{method:'POST',body:JSON.stringify({orgType:orgType,orgName:orgName,orgEmail:orgEmail,docs:docs})});
    if(r&&r.ok){msg.innerHTML='<div class="empty" style="color:#065f46;border-color:#a7f3d0;background:#ecfdf5;margin-top:8px">✓ '+(r.message||'Sent.')+'</div>';el('orgName').value='';el('orgEmail').value='';}
    else err((r&&r.error)||'Could not send right now.');
  }catch(e){err('Could not send right now — check your connection and try again.');}
  el('orgSend').disabled=false; el('orgSend').textContent='📨 Send via the Office of the Registrar';
}
// Report a MISSING result or a WRONG score for a registered course. The desktop AI then locates the
// uploaded row and auto-links it (or hands it to a staff member) — the outcome shows back here.
async function reportResult(codeEnc,kind){
  var code=decodeURIComponent(codeEnc);
  var note=prompt((kind==='wrong_score'?'Report a WRONG score for ':'Report a MISSING result for ')+code+'.\\n\\n'+(kind==='wrong_score'?'What score did you expect? (optional)':'Add a note for staff (optional):'),'');
  if(note===null)return;
  try{var r=await api('/api/result-issue',{method:'POST',body:JSON.stringify({course_code:code,kind:kind,note:note})});
    if(r&&r.ok){alert(r.message||'Reported. We will locate your result and update it here.');renderApp();}
    else{alert((r&&r.error)||'Could not report this right now.');}}catch(e){alert('Could not report this right now.');}
}
// 🎫 MY TICKETS — every result/payment report with its live timeline (result section, lazy-loaded).
async function loadTickets(){
  var box=document.getElementById('tixBody'); if(!box)return; if(box.getAttribute('data-busy'))return; box.setAttribute('data-busy','1');
  var r; try{ r=await api('/api/my-tickets'); }catch(e){ r=null; }
  box.removeAttribute('data-busy');
  if(!r||!r.ok){ box.innerHTML='<div class="empty">Tickets are unavailable right now.</div>'; return; }
  var tix=r.tickets||[];
  if(!tix.length){ box.innerHTML='<div class="empty">No tickets yet. Report a missing result (above) or a payment that didn’t reflect (My Fees) and follow it here.</div>'; return; }
  var stBadge=function(s){var m={open:['⏳ Being checked','muted'],auto_fixed:['✓ Fixed automatically','pos'],recorded:['✓ Recorded','pos'],not_uploaded:['⏳ Awaiting upload','muted'],not_found:['👤 With a staff member','neg'],resolved:['✓ Resolved','pos'],rejected:['Closed','muted']}[s]||[s,'muted'];return '<span class="'+m[1]+'" style="font-weight:800">'+m[0]+'</span>';};
  box.innerHTML=tix.map(function(t){
    var tl=(t.events||[]).map(function(e){return '<div style="display:flex;gap:8px;font-size:12px;margin:4px 0"><span class="muted" style="white-space:nowrap">'+String(e.at||'').slice(0,16).replace('T',' ')+'</span><span>'+eh(e.message||e.status)+'</span></div>';}).join('');
    return '<div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 13px;margin-bottom:9px">'
      +'<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center"><div><b>'+eh(t.ticket_no)+'</b> · '+eh(t.title)+'</div>'+stBadge(t.status)+'</div>'
      +(t.resolution?('<div style="font-size:12.5px;color:#334155;margin-top:4px">'+eh(t.resolution)+'</div>'):'')
      +(tl?('<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px;color:#2563eb">Timeline ('+(t.events||[]).length+')</summary>'+tl+'</details>'):'')
      +'</div>';
  }).join('');
}
// 💳 report a payment that is NOT reflecting — files a ticket the AI traces (ledger → gateway),
// with email updates at every step.
async function reportPayment(currency){
  var ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:9500;background:rgba(2,6,23,.55);display:flex;align-items:center;justify-content:center;padding:16px';
  ov.innerHTML='<div style="background:#fff;border-radius:16px;max-width:430px;width:100%;padding:20px;box-shadow:0 24px 60px rgba(2,6,23,.4)">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><h3 style="margin:0">💬 Payment not showing?</h3><span id="pfX" style="cursor:pointer;font-size:22px;color:#64748b">×</span></div>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:12px">Tell us about the payment and the system will trace it through the ledger and the payment gateway — you’ll get an email at every update.</div>'
    +'<label style="font-size:12px;color:#64748b">Amount paid ('+eh(currency||'NGN')+') *</label>'
    +'<input id="pfAmt" type="number" min="1" step="0.01" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 10px;box-sizing:border-box">'
    +'<label style="font-size:12px;color:#64748b">Payment reference / teller no. (from your bank alert or receipt — optional but speeds things up)</label>'
    +'<input id="pfRef" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 10px;box-sizing:border-box">'
    +'<label style="font-size:12px;color:#64748b">When did you pay?</label>'
    +'<input id="pfDate" type="date" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 10px;box-sizing:border-box">'
    +'<label style="font-size:12px;color:#64748b">How did you pay? (card online, bank transfer, POS, cash at the bank…)</label>'
    +'<input id="pfHow" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 10px;box-sizing:border-box">'
    +'<label style="font-size:12px;color:#64748b">Anything else? (optional)</label>'
    +'<textarea id="pfNote" rows="2" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 10px;box-sizing:border-box"></textarea>'
    +'<div id="pfErr" style="color:#b91c1c;font-size:13px;margin-top:2px"></div>'
    +'<button id="pfGo" class="btn full" style="margin-top:8px">Open ticket</button></div>';
  document.body.appendChild(ov);
  function close(){try{document.body.removeChild(ov);}catch(_){}}
  ov.querySelector('#pfX').onclick=close;
  ov.addEventListener('click',function(e){if(e.target===ov)close();});
  ov.querySelector('#pfGo').onclick=async function(){
    var amt=parseFloat(ov.querySelector('#pfAmt').value||'0');
    var ee=ov.querySelector('#pfErr');ee.textContent='';
    if(!(amt>0)){ee.textContent='Enter the amount you paid.';return;}
    var go=ov.querySelector('#pfGo');go.disabled=true;go.textContent='Opening ticket…';
    var r;try{r=await api('/api/payment-issue',{method:'POST',body:JSON.stringify({amount:amt,currency:currency||'NGN',reference:ov.querySelector('#pfRef').value,paid_at:ov.querySelector('#pfDate').value||null,method:ov.querySelector('#pfHow').value,note:ov.querySelector('#pfNote').value})});}catch(e){r={ok:false,error:'Network error.'};}
    go.disabled=false;go.textContent='Open ticket';
    if(!r||!r.ok){ee.textContent=(r&&r.error)||'Could not open the ticket.';return;}
    close();alert(r.message||'Ticket opened — you will be emailed at every update.');renderApp();
  };
}
// Pay an outstanding fee online: pick a gateway + amount, then hand off to the provider's secure checkout.
// On return the /api/pay/callback verifies the payment server-side, issues the receipt and emails it.
async function payFee(catEnc,currency,outstanding){
  var category=decodeURIComponent(catEnc);
  var pr;try{pr=await api('/api/pay/providers?currency='+encodeURIComponent(currency||''));}catch(e){pr={ok:false};}
  var providers=(pr&&pr.providers)||[];
  var ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;z-index:9500;background:rgba(2,6,23,.55);display:flex;align-items:center;justify-content:center;padding:16px';
  var provHtml=providers.length?providers.map(function(p,i){return '<label style="display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:8px;cursor:pointer"><input type="radio" name="payprov" value="'+eh(p.id)+'"'+(i===0?' checked':'')+'><span style="font-weight:600">'+eh(p.label)+'</span></label>';}).join(''):'<div class="muted" style="font-size:13px">Online card payment is not enabled here yet. Continue to see the bank account to pay into.</div>';
  ov.innerHTML='<div style="background:#fff;border-radius:16px;max-width:430px;width:100%;padding:20px;box-shadow:0 24px 60px rgba(2,6,23,.4)">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><h3 style="margin:0">💳 Pay '+eh(cap(category))+'</h3><span id="payX" style="cursor:pointer;font-size:22px;color:#64748b">×</span></div>'
    +'<div class="muted" style="font-size:13px;margin-bottom:12px">Outstanding: <b>'+money(outstanding,currency)+'</b></div>'
    +'<label style="font-size:12px;color:#64748b">Amount to pay ('+eh(currency)+')</label>'
    +'<input id="payAmt" type="number" min="1" step="0.01" max="'+Number(outstanding)+'" value="'+Number(outstanding)+'" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 14px;font-size:15px;box-sizing:border-box">'
    +(providers.length?'<div style="font-size:12px;color:#64748b;margin-bottom:6px">Choose a payment method</div>':'')+provHtml
    +'<div id="payErr" style="color:#b91c1c;font-size:13px;margin-top:6px"></div>'
    +'<button id="payGo" class="btn full" style="margin-top:12px">Pay now</button>'
    +'<button id="payBank" class="btn full ghost" style="margin-top:8px;background:#fff;color:#1e3a8a;border:1px solid #cbd5e1">🏦 Pay by bank transfer instead</button>'
    +'<div id="payManual" style="margin-top:10px"></div>'
    +'<div class="muted" style="font-size:11px;margin-top:10px;text-align:center">🔒 Payments are processed securely by the gateway. We never see your card details.</div></div>';
  document.body.appendChild(ov);
  function close(){try{document.body.removeChild(ov);}catch(_){}}
  ov.querySelector('#payX').onclick=close;
  ov.addEventListener('click',function(e){if(e.target===ov)close();});
  // 🏦 manual bank transfer: bank details + claim form (payer, bank, date, reference, receipt upload).
  // The AI reconciles the claim against the bank's alert emails; the receipt is issued after the
  // accountant's second-layer approval — the student is emailed at every step.
  ov.querySelector('#payBank').onclick=async function(){
    var amt=parseFloat(ov.querySelector('#payAmt').value||'0')||Number(outstanding);
    var info;try{info=await api('/api/manualpay/info');}catch(e){info={ok:false};}
    var box=ov.firstElementChild;
    box.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><h3 style="margin:0">🏦 Bank transfer — '+eh(cap(category))+'</h3><span id="mpX" style="cursor:pointer;font-size:22px;color:#64748b">×</span></div>'
      +(info.enabled?('<div class="ok" style="text-align:left;font-size:13px;margin-bottom:10px"><b>Transfer to:</b><br>'+eh(info.bank).replace(/\\n/g,'<br>')+'</div>'):'<div class="muted" style="font-size:13px;margin-bottom:10px">Ask the Bursary for the bank account details, then declare your transfer below.</div>')
      +'<div class="muted" style="font-size:12px;margin-bottom:10px">After transferring, fill this in EXACTLY as it appears on your bank receipt. 💡 Put your <b>matric number</b> in the transfer narration — payments match instantly.</div>'
      +'<label style="font-size:12px;color:#64748b">Amount transferred ('+eh(currency)+') *</label><input id="mpAmt" type="number" min="1" step="0.01" value="'+amt+'" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 10px;box-sizing:border-box">'
      +'<label style="font-size:12px;color:#64748b">Name on the account that paid *</label><input id="mpPayer" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 10px;box-sizing:border-box">'
      +'<label style="font-size:12px;color:#64748b">Bank transferred from</label><input id="mpBank" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 10px;box-sizing:border-box">'
      +'<label style="font-size:12px;color:#64748b">Date of transfer</label><input id="mpDate" type="date" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 10px;box-sizing:border-box">'
      +'<label style="font-size:12px;color:#64748b">Transaction reference / session ID (from your bank alert)</label><input id="mpRef" style="width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin:4px 0 10px;box-sizing:border-box">'
      +'<label style="font-size:12px;color:#64748b">Payment receipt (photo or PDF) *</label><input id="mpFile" type="file" accept="image/*,.pdf" style="width:100%;margin:4px 0 10px">'
      +'<div id="mpErr" style="color:#b91c1c;font-size:13px;margin-top:2px"></div>'
      +'<button id="mpGo" class="btn full" style="margin-top:8px">Submit for verification</button>'
      +'<div class="muted" style="font-size:11px;margin-top:8px;text-align:center">The AI checks the bank\\'s alerts every 30 minutes and emails you at every step. Your receipt appears here once the Bursary approves.</div>';
    box.querySelector('#mpX').onclick=close;
    box.querySelector('#mpGo').onclick=async function(){
      var ee=box.querySelector('#mpErr');ee.textContent='';
      var a2=parseFloat(box.querySelector('#mpAmt').value||'0');
      var payer=box.querySelector('#mpPayer').value.trim();
      var f=box.querySelector('#mpFile').files&&box.querySelector('#mpFile').files[0];
      if(!(a2>0)){ee.textContent='Enter the exact amount you transferred.';return;}
      if(!payer){ee.textContent='Enter the name on the account that made the transfer.';return;}
      if(!f){ee.textContent='Attach your payment receipt (photo or PDF).';return;}
      if(f.size>6*1024*1024){ee.textContent='That file is larger than 6MB — take a clearer, smaller photo.';return;}
      var go=box.querySelector('#mpGo');go.disabled=true;go.textContent='Submitting…';
      // mpCompress: photos are downscaled to ≤1600px JPEG in the browser (a 6MB camera shot becomes
      // ~300KB) so uploads are fast and the cloud store stays light; PDFs/small files pass through.
      var mpCompress=function(file,cb){
        var raw=function(){var rd=new FileReader();rd.onload=function(){cb(String(rd.result),file.type||'image/jpeg');};rd.readAsDataURL(file);};
        if(!/^image\\//.test(file.type||'')||file.size<600000)return raw();
        var url=URL.createObjectURL(file);var img=new Image();
        img.onload=function(){try{var sc=Math.min(1,1600/Math.max(img.width,img.height));var cv=document.createElement('canvas');cv.width=Math.round(img.width*sc);cv.height=Math.round(img.height*sc);cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);var out=cv.toDataURL('image/jpeg',0.82);URL.revokeObjectURL(url);cb(out,'image/jpeg');}catch(e){URL.revokeObjectURL(url);raw();}};
        img.onerror=function(){URL.revokeObjectURL(url);raw();};
        img.src=url;
      };
      mpCompress(f,async function(dataUrl,mime){
        var r;try{r=await api('/api/manualpay/submit',{method:'POST',body:JSON.stringify({category:category,currency:currency,amount:a2,payer_name:payer,payer_bank:box.querySelector('#mpBank').value,paid_at:box.querySelector('#mpDate').value||null,reference:box.querySelector('#mpRef').value,receipt_base64:dataUrl,receipt_mime:mime,receipt_name:f.name})});}catch(e){r={ok:false,error:'Network error.'};}
        go.disabled=false;go.textContent='Submit for verification';
        if(!r||!r.ok){ee.textContent=(r&&r.error)||'Could not submit.';return;}
        close();alert(r.message||'Submitted — track it under 🎫 My Tickets.');renderApp();
      });
    };
  };
  ov.querySelector('#payGo').onclick=async function(){
    var amt=parseFloat(ov.querySelector('#payAmt').value||'0');
    var sel=ov.querySelector('input[name=payprov]:checked');
    var provider=sel?sel.value:'';
    var ee=ov.querySelector('#payErr');ee.textContent='';
    if(!(amt>0)){ee.textContent='Enter a valid amount to pay.';return;}
    if(amt>Number(outstanding)+0.01){ee.textContent='You cannot pay more than the outstanding amount.';return;}
    var go=ov.querySelector('#payGo');go.disabled=true;go.textContent='Starting secure checkout…';
    var r;try{r=await api('/api/pay/init',{method:'POST',body:JSON.stringify({provider:provider,category:category,currency:currency,amount:amt})});}catch(e){r={ok:false,error:'Network error.'};}
    go.disabled=false;go.textContent='Pay now';
    if(!r||!r.ok){ee.textContent=(r&&r.error)||'Could not start the payment.';return;}
    if(r.authorization_url){location.href=r.authorization_url;return;}
    ov.querySelector('#payManual').innerHTML='<div class="ok" style="text-align:left;font-size:13px">Pay by bank transfer:<br><b>'+eh(r.bank||'Contact the Bursary for the bank details.')+'</b><br><span class="muted">Your receipt is issued once the Bursary confirms your transfer.</span></div>';
    go.style.display='none';
  };
}
// ---- Final Clearance (Graduation) — lazy-loaded tab ----
async function loadFinalClearance(){
  var box=document.getElementById('fcBody'); if(!box)return; if(box.getAttribute('data-busy'))return; box.setAttribute('data-busy','1');
  var r; try{ r=await api('/api/final-clearance'); }catch(e){ r=null; }
  box.removeAttribute('data-busy');
  if(!r||!r.ok||!r.clearance){ box.innerHTML='<div class="empty">Final clearance is unavailable right now.</div>'; return; }
  box.innerHTML=renderFinalClearance(r.clearance);
}
function fcStageIcon(done,current){return done?'✓':(current?'➤':'○');}
function fcProgressBar(c){
  var prog=c.progress||{percent:0,label:c.stage_label||''};
  var pct=Math.max(0,Math.min(100,prog.percent||0));
  var done=c.status==='completed';
  var SHORT={financial:'Fees',academic:'Academic',project:'Project',results:'Results',physical:'Documents'};
  var steps=(c.stages||[]).map(function(st){
    var cls=st.done?'done':(st.current?'current':'');
    var icon=st.done?'✓':(st.current?'●':'○');
    return '<div class="fcstep '+cls+'"><div class="dot">'+icon+'</div>'+eh(SHORT[st.key]||st.label||'')+'</div>';
  }).join('');
  var right=done?'Final clearance complete':('Current step<br><b style="color:#1e293b">'+eh(prog.label||c.stage_label||'')+'</b>');
  return '<div class="fcprog'+(done?' done':'')+'">'
    +'<div class="top"><div class="pct">'+pct+'%</div><div class="lbl">'+right+'</div></div>'
    +'<div class="fcbar"><span style="width:'+pct+'%"></span></div>'
    +'<div class="fcsteps">'+steps+'</div></div>';
}
function renderFinalClearance(c){
  if(!c.exists){
    if(!c.eligible) return '<div class="panel"><div class="muted">Final clearance is for graduating students in <b>300 level and above</b>. You are not eligible yet.</div></div>';
    return '<div class="panel"><h3>Ready to graduate?</h3><div class="muted" style="margin-bottom:10px">Request your final clearance to begin the graduation process. You can pay any office online and track every step right here.</div><button class="btn full" onclick="fcRequest()">🎓 Request final clearance</button><div class="err" id="fcErr" style="color:#b91c1c;font-size:13px;margin-top:6px"></div></div>';
  }
  if(c.status==='requested') return '<div class="fcprog"><div class="top"><div class="pct">0%</div><div class="lbl">Awaiting<br><b style="color:#1e293b">Bursary approval</b></div></div><div class="fcbar"><span style="width:4%"></span></div></div><div class="panel"><div class="ok">✅ Your request has been sent to the Bursary. You will be notified the moment it is accepted so you can begin — then track every step right here.</div></div>';
  if(c.status==='denied') return '<div class="panel"><div class="exbar bad">Your final-clearance request was not approved.'+(c.deny_reason?(' Reason: '+eh(c.deny_reason)):'')+'</div><button class="btn" style="margin-top:10px" onclick="fcRequest()">Request again</button><div class="err" id="fcErr" style="color:#b91c1c;font-size:13px;margin-top:6px"></div></div>';
  var head=fcProgressBar(c)+(c.status==='completed'?'<div class="exbar ok">🎓 Congratulations — your final clearance is complete. You are now an alumnus/alumna.</div>':'');
  var stagesHtml=(c.stages||[]).map(function(st){
    var items=(st.items||[]).map(function(it){return fcItemHtml(it);}).join('');
    return '<div class="panel" style="'+(st.current?'border:2px solid var(--brand)':'')+'"><h3 style="margin-top:0">'+fcStageIcon(st.done,st.current)+' '+eh(st.label)+(st.done?' <span class="pos" style="font-size:12px">cleared</span>':(st.current?' <span class="badge" style="background:#fef3c7;color:#92400e">current</span>':''))+'</h3>'+(items||'<div class="muted" style="font-size:12px">No actions needed here.</div>')+'</div>';
  }).join('');
  var docs=c.documents||{}; var dl=[];
  function dlink(d,label){ if(d) dl.push('<button class="btn sm" onclick="doc(\\'/doc/portal-document/'+d.id+'\\')">⬇️ '+label+'</button>'); }
  dlink(docs.project,'My project'); dlink(docs.transcript,'Transcript (Student Copy)'); dlink(docs.certificate,'Certificate (Student Copy)'); dlink(docs.scanned_transcript,'Official transcript'); dlink(docs.scanned_certificate,'Official certificate');
  var docsHtml=dl.length?('<div class="panel"><h3 style="margin-top:0">My Documents</h3><div class="muted" style="font-size:11px;margin-bottom:6px">Copies on your portal are marked “Student Copy”.</div><div class="qa">'+dl.join('')+'</div></div>'):'';
  return head+stagesHtml+docsHtml;
}
function fcItemHtml(it){
  var st=it.status;
  var badge=st==='cleared'?'<span class="pos" style="font-weight:800">✓ Cleared</span>':st==='owing'?'<span class="neg" style="font-weight:800">Owing</span>':st==='reviewing'?'<span class="badge" style="background:#dbeafe;color:#1e40af">Under review</span>':st==='failed'?'<span class="neg">Not approved</span>':'<span class="muted">Pending</span>';
  var line='<div style="padding:7px 0;border-top:1px solid #f1f5f9"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><div style="flex:1;min-width:140px"><b style="font-size:13.5px">'+eh(it.name)+'</b><div class="muted" style="font-size:11px">'+eh(it.oversee_label)+'</div></div>'+badge+'</div>';
  if(st==='owing'&&it.owed&&Object.keys(it.owed).length){
    var cur=Object.keys(it.owed)[0]; var amt=it.owed[cur];
    line+='<div style="font-size:12px;margin-top:4px" class="neg">You owe '+money(amt,cur)+' for this.</div>';
    if(it.online_pay&&it.pay_category) line+='<button class="btn sm" style="margin-top:4px" onclick="payFee(\\''+encodeURIComponent(it.pay_category)+'\\',\\''+eh(cur)+'\\','+Number(amt)+')">💳 Pay '+money(amt,cur)+' online</button>';
  }
  if(it.detail){
    var dd=[];
    if(it.detail.carryovers&&it.detail.carryovers.length) dd.push('Carry-overs: '+it.detail.carryovers.map(function(x){return eh(x.code||'');}).join(', '));
    if(it.detail.malpractices&&it.detail.malpractices.length) dd.push(it.detail.malpractices.length+' malpractice flag(s)');
    if(it.detail.suspensions&&it.detail.suspensions.length) dd.push('Suspension on record');
    if(dd.length) line+='<div style="font-size:11px;margin-top:4px" class="neg">⚠ '+dd.join(' · ')+' — awaiting the Dean/Registrar.</div>';
  }
  if(it.type==='project_upload'&&st!=='cleared'){
    line+='<label class="btn sm" style="cursor:pointer;margin-top:4px">📎 Upload my project (PDF/Word)<input type="file" accept=".pdf,.doc,.docx" style="display:none" onchange="fcUploadProject(this)"></label>';
  }
  line+='</div>';
  return line;
}
async function fcRequest(){
  var e=document.getElementById('fcErr'); if(e)e.textContent='';
  var r; try{ r=await api('/api/final-clearance/request',{method:'POST',body:'{}'}); }catch(_){ r={ok:false,error:'Network error.'}; }
  if(!r||!r.ok){ if(e)e.textContent=(r&&r.error)||'Could not request.'; else alert((r&&r.error)||'Could not request.'); return; }
  loadFinalClearance();
}
async function fcUploadProject(input){
  var f=input.files&&input.files[0]; if(!f)return;
  if(f.size>8*1024*1024){ alert('That file is larger than 8MB.'); return; }
  var rd=new FileReader();
  rd.onload=async function(){
    var r; try{ r=await api('/api/final-clearance/project',{method:'POST',body:JSON.stringify({filename:f.name,file:rd.result,mime:f.type})}); }catch(_){ r={ok:false,error:'Upload failed.'}; }
    if(!r||!r.ok){ alert((r&&r.error)||'Upload failed.'); return; }
    loadFinalClearance();
  };
  rd.readAsDataURL(f);
}
let CHAT_MOUNTED=false;
function mountChat(){
  if(CHAT_MOUNTED)return;CHAT_MOUNTED=true;
  var fab=document.createElement('button');fab.textContent='💬';fab.title='Ask the assistant';
  fab.style.cssText='position:fixed;right:18px;bottom:18px;z-index:9000;width:54px;height:54px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;font-size:24px;box-shadow:0 6px 18px rgba(30,58,138,.4)';
  var panel=document.createElement('div');
  panel.style.cssText='position:fixed;right:18px;bottom:82px;z-index:9000;width:340px;max-width:calc(100vw - 28px);height:480px;max-height:calc(100vh - 120px);display:none;flex-direction:column;background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(2,6,23,.28)';
  panel.innerHTML='<div style="padding:11px 13px;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;font-weight:800;display:flex;justify-content:space-between;align-items:center"><span>💬 Student Assistant</span><span id="cx" style="cursor:pointer;font-size:20px">×</span></div><div id="clog" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f8fafc"></div><div style="display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0"><input id="cin" placeholder="Ask about results, fees, exams…" style="flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:9px 11px;font-size:13px"><button id="csend" style="border:none;background:#1e3a8a;color:#fff;border-radius:10px;padding:0 14px;cursor:pointer;font-size:16px">&#10148;</button></div>';
  document.body.appendChild(fab);document.body.appendChild(panel);
  var log=panel.querySelector('#clog'),inp=panel.querySelector('#cin');
  function bub(role,text){var b=document.createElement('div');var me=role==='me';b.style.cssText='align-self:'+(me?'flex-end':'flex-start')+';max-width:85%;padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.4;white-space:pre-wrap;'+(me?'background:#1e3a8a;color:#fff':'background:#fff;color:#0f172a;border:1px solid #e2e8f0');b.textContent=text;log.appendChild(b);log.scrollTop=log.scrollHeight;return b;}
  function open(){var o=panel.style.display==='none';panel.style.display=o?'flex':'none';if(o){if(!log.childNodes.length)bub('bot','Hi! I can check your results, school fees, balance, exam clearance and timetable. Try “How much do I owe?” or “When are my exams?”.');inp.focus();}}
  fab.onclick=open;panel.querySelector('#cx').onclick=open;
  async function send(){var t=inp.value.trim();if(!t)return;inp.value='';bub('me',t);var w=bub('bot','…');try{var r=await api('/api/assistant',{method:'POST',body:JSON.stringify({message:t})});w.textContent=r.reply||'Sorry, I could not answer that.';}catch(e){w.textContent='⚠ Could not reach the assistant.';}}
  panel.querySelector('#csend').onclick=send;inp.addEventListener('keydown',function(e){if(e.key==='Enter')send();});
}
// Open a live class room (Jitsi). Navigate in the SAME webview so the app's camera/mic permission
// applies; Jitsi's "Back to portal" returns here. name is already URL-encoded.
function joinClass(room,subjEnc){var n=window.__lcName||encodeURIComponent('Guest');var host=window.__lcHost?'1':'0';location.href=(window.__B||'')+'/class/'+room+'?n='+n+'&s='+subjEnc+'&host='+host+'&t='+encodeURIComponent(TOKEN||localStorage.getItem('ubu_token')||'');}
// E-library: read in-app (navigate so the pdf.js viewer fills the screen; "Back" returns here) / download
function readBook(id){location.href=(window.__B||'')+'/library/read/'+id+'?t='+encodeURIComponent(TOKEN);}
function downloadBook(id){window.open('/library/download/'+id+'?t='+encodeURIComponent(TOKEN),'_blank');}
function goSeg(s){if(window.__goSeg)window.__goSeg(s);}
function startExam(id){location.href=(window.__B||'')+'/exam/take/'+id+'?t='+encodeURIComponent(TOKEN);}
async function appealFlag(id){
  var msg=prompt('Tell the exam officer why you believe this flag is a mistake (e.g. "the camera identified the wrong person" or "I was not talking"):','');
  if(msg===null)return;
  var r=await api('/api/surveillance/appeal',{method:'POST',body:JSON.stringify({flag_id:id,reason:'misidentification',message:String(msg||'')})});
  if(r&&r.ok){alert(r.already?'You already have a pending appeal for this flag.':'Appeal submitted. An exam officer will review it and you will be notified of the outcome.');if(window.renderApp)renderApp();}
  else alert((r&&r.error)||'Could not submit the appeal. Please try again.');
}
async function submitSurvey(id){
  var box=document.getElementById('survey-'+id);if(!box)return;
  var answers={};
  Array.prototype.forEach.call(box.querySelectorAll('input[type=radio]:checked'),function(r){answers[r.getAttribute('data-qid')]=Number(r.value);});
  Array.prototype.forEach.call(box.querySelectorAll('textarea[data-qid]'),function(t){if(t.value.trim())answers[t.getAttribute('data-qid')]=t.value.trim();});
  var cEl=box.querySelector('.svcomment');var comment=cEl?cEl.value.trim():'';
  var need=Number(box.getAttribute('data-ratings')||0);var got=box.querySelectorAll('input[type=radio]:checked').length;
  if(need>0&&got<need){alert('Please rate every statement before submitting.');return;}
  var btn=box.querySelector('.svsubmit');if(btn){btn.disabled=true;btn.textContent='Submitting…';}
  var r=await api('/api/survey/submit',{method:'POST',body:JSON.stringify({survey_id:id,answers:answers,comment:comment})});
  if(r&&r.ok){alert(r.already?'You have already submitted this evaluation. Thank you!':'Thank you! Your anonymous evaluation has been submitted.');if(window.renderApp)renderApp();}
  else{alert((r&&r.error)||'Could not submit. Please try again.');if(btn){btn.disabled=false;btn.textContent='Submit Evaluation';}}
}

function studentView(w,d){
  var p=d.profile;
  var clr=d.examClearance||{};
  var chip=clr.cleared?(clr.type==='partial'?'<span class="chip warn">⚠ Partially cleared</span>':'<span class="chip ok">✓ Cleared for exams</span>'):'<span class="chip bad">✗ Not cleared</span>';
  var owingCount=(d.outstanding||[]).length;
  var photo=p.photo?'<img src="'+p.photo+'">':'<div class="ph">🎓</div>';
  // --- section tabs ---
  var ttCount=(d.timetables||[]).length+(d.allocations||[]).length;
  var liveCount=(d.liveClasses||[]).length;
  var sv=d.surveillance||{flags:[],attendance:[]};
  var openFlags=(sv.flags||[]).filter(function(f){return f.status==='open'||f.status==='appealed';}).length;
  var notifs=d.notifications||[];
  var seenKey='ubu_seen_'+((p.matric_no||p.full_name||'me'));
  var lastSeen=localStorage.getItem(seenKey)||'';
  var unread=notifs.filter(function(n){return String(n.date||'')>lastSeen;}).length;
  window.__seenKey=seenKey; window.__notifMax=(notifs[0]&&notifs[0].date)||'';
  var exNow=(d.exams||[]).filter(function(e){return e.window!=='closed' && e.status!=='ended' && (!e.attempt || e.attempt.status==='in_progress');}).length;
  var segs=[['overview','🏠','Overview',0],['notifications','🔔','Updates',unread],['fees','💳','Fees & Payments',owingCount],['receipts','🧾','Receipts',0],['timetable','🗓','Timetable',ttCount],['liveclasses','🎥','Live Classes',liveCount],['exams','📝','Exams',exNow],['library','📚','Library',0],['results','📑','Results',0],['clearance','✅','Clearance',0],['finalclr','🎓','Graduation',0],['documents','📂','Documents',0]];
  if(d.misconduct&&d.misconduct.length)segs.push(['discipline','⚖️','Discipline',d.misconduct.length]);
  if((sv.flags&&sv.flags.length)||(sv.attendance&&sv.attendance.length))segs.push(['surveillance','🛡','Exam Conduct',openFlags]);
  if(d.surveys&&d.surveys.length)segs.push(['evaluation','⭐','Evaluation',d.surveys.length]);
  segs.push(['profile','👤','Profile',0]);
  var navHtml=segs.map(function(s){return '<a data-seg="'+s[0]+'"><span class="ic">'+s[1]+'</span><span class="lbl">'+s[2]+'</span>'+(s[3]?'<span class="pill">'+s[3]+'</span>':'')+'</a>';}).join('');
  // --- profile + photo pinned at the TOP (full width) ---
  var head=$('<div class="phead">'+photo
    +'<div style="flex:1;min-width:0"><div class="nm">'+eh(p.full_name)+'</div>'
    +'<div class="mt">'+eh(p.matric_no||'Matric pending')+' · '+eh(p.department||'—')+' · '+eh(p.level||'—')+(p.faculty?(' · '+eh(p.faculty)):'')+(p.campus?(' · 🏫 '+eh(p.campus)):'')+'</div>'
    +'<div style="margin-top:9px">'+chip+'<span class="bal">Balance: <b>'+mapMoney(d.balances)+'</b></span></div></div></div>');
  // --- horizontal section tabs ---
  var navEl=$('<div class="nav">'+navHtml+'</div>');
  // --- content (segments) ---
  var content=$('<div class="content"></div>');
  if(d.parentView)content.appendChild($('<div class="pbanner">👨‍👩‍👧 Parent/Guardian view — records of <b>'+eh(p.full_name||'your ward')+'</b>.</div>'));

  function seg(id,html){return '<div class="seg" data-seg="'+id+'">'+html+'</div>';}
  function sevBadge(s){var c=s==='severe'?'background:#fee2e2;color:#991b1b':s==='major'?'background:#fef3c7;color:#92400e':'background:#e5e7eb;color:#374151';return '<span class="badge" style="'+c+'">'+cap(s||'minor')+'</span>';}
  function stBadge(s){var c=s==='resolved'?'background:#dcfce7;color:#166534':'background:#fee2e2;color:#991b1b';return '<span class="badge" style="'+c+'">'+cap(s||'open')+'</span>';}
  var clrCls=clr.cleared?(clr.type==='partial'?'warn':'ok'):'bad';
  var clrTxt=clr.cleared?(clr.type==='partial'?'⚠ PARTIALLY CLEARED for exams — you still owe fees':'✓ CLEARED for examinations'):('✗ NOT CLEARED for exams — '+eh(clr.reason||'no clearance'));

  var html='';
  // OVERVIEW
  html+=seg('overview',
    '<div class="kpis">'
    +'<div class="kpi"><div class="l">Outstanding Balance</div><div class="v neg">'+mapMoney(d.balances)+'</div></div>'
    +'<div class="kpi"><div class="l">Session</div><div class="v" style="font-size:16px">'+eh(d.currentSession||'—')+'</div></div>'
    +'<div class="kpi"><div class="l">Semester</div><div class="v" style="font-size:16px">'+eh(d.currentSemester||'—')+'</div></div>'
    +'<div class="kpi"><div class="l">Exam Status</div><div class="v" style="font-size:15px">'+(clr.cleared?(clr.type==='partial'?'Partial':'Cleared'):'Not cleared')+'</div></div></div>'
    +'<div class="exbar '+clrCls+'">'+clrTxt+'</div>'
    +'<div class="qa"><button class="btn sm" onclick="doc(\\'/doc/statement\\')">📄 Download full statement</button><button class="btn sm ghost" onclick="changePassword()">🔑 Change password</button></div>'
    +'<div class="panel"><h3>Who You Owe — by Office</h3>'+tbl([{t:'Office',f:function(r){return eh(r.office);}},{t:'Charged',r:1,f:function(r){return mapMoney(r.charged);}},{t:'Paid',r:1,f:function(r){return mapMoney(r.paid);}},{t:'Outstanding',r:1,f:function(r){return Object.keys(r.owing).length?'<span class=neg>'+mapMoney(r.owing)+'</span>':'<span class=pos>Cleared</span>';}}],d.byOffice,'No charges on your account.')+'</div>');
  // NOTIFICATIONS / UPDATES — derived feed of receipts, results, documents, fees, timetables…
  var notifHtml=notifs.length?notifs.map(function(n){
    var isNew=String(n.date||'')>lastSeen;
    var act=n.doc?(' onclick="doc(\\''+n.doc+'\\')"'):(n.seg?(' onclick="goSeg(\\''+n.seg+'\\')"'):'');
    return '<div class="panel ntf'+(isNew?' new':'')+'"'+act+' style="cursor:'+((n.doc||n.seg)?'pointer':'default')+';display:flex;gap:12px;align-items:flex-start">'
      +'<div style="font-size:22px;line-height:1">'+eh(n.icon||'🔔')+'</div>'
      +'<div style="flex:1;min-width:0"><div style="font-weight:800">'+eh(n.title||'')+(isNew?' <span class="pill" style="background:#ef4444">new</span>':'')+'</div>'
      +'<div class="muted" style="font-size:12.5px;margin-top:2px">'+eh(n.text||'')+'</div>'
      +'<div class="muted" style="font-size:11px;margin-top:4px">'+fmt(n.date)+'</div></div></div>';
  }).join(''):'<div class="empty">No updates yet. New receipts, results, documents, fees and timetable releases will appear here so you never miss anything.</div>';
  html+=seg('notifications','<h2 class="sectitle">🔔 Updates &amp; Notifications</h2>'+notifHtml);
  // FEES
  html+=seg('fees',
    '<h2 class="sectitle">💳 Fees &amp; Payments</h2>'
    +'<div class="exbar" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><span>Paid something that isn’t showing here yet? Open a ticket and the system will trace it through the ledger and the payment gateway — you get an email at every update.</span><button class="btn sm" onclick="reportPayment(\\''+eh((d.outstanding&&d.outstanding[0]&&d.outstanding[0].currency)||'NGN')+'\\')">💬 Payment not showing?</button></div>'
    +'<div class="panel"><h3>Outstanding Fees</h3><div class="muted" style="font-size:12px;margin-bottom:8px">Tap <b>Pay online</b> on any fee to pay securely by card, bank or USSD — your receipt is issued instantly and emailed to you.</div>'+tbl([{t:'Fee Category',f:function(r){return cap(r.category);}},{t:'Currency',f:function(r){return r.currency;}},{t:'Billed',r:1,f:function(r){return money(r.billed,r.currency);}},{t:'Paid',r:1,f:function(r){return money(r.paid,r.currency);}},{t:'Outstanding',r:1,f:function(r){return '<span class=neg>'+money(r.outstanding,r.currency)+'</span>';}},{t:'',r:1,f:function(r){return Number(r.outstanding)>0?'<button class="btn sm" onclick="payFee(\\''+encodeURIComponent(r.category)+'\\',\\''+eh(r.currency)+'\\','+Number(r.outstanding)+')">💳 Pay online</button>':'<span class="muted">Paid</span>';}}],d.outstanding,'You owe nothing. 🎉')+'</div>'
    +'<div class="panel"><h3>All Fees &amp; Charges</h3>'+tbl([{t:'Date',f:function(r){return fmt(r.date);}},{t:'Description',f:function(r){return (eh(r.description)||cap(r.category))+' '+(r.rollover?'<span class="badge" style="background:#fef3c7;color:#92400e">Rollover'+(r.rolled_from?' · '+eh(r.rolled_from):'')+'</span>':'<span class="badge" style="background:#dbeafe;color:#1e40af">Current</span>');}},{t:'Category',f:function(r){return cap(r.category);}},{t:'Set By',f:function(r){return eh(r.by||'—');}},{t:'Amount',r:1,f:function(r){return money(r.amount,r.currency);}}],d.charges,'No charges yet.')+'</div>'
    +((d.invoices&&d.invoices.length)?('<div class="panel"><h3>Fee Invoices</h3><div class="muted" style="font-size:12px;margin-bottom:6px">Download the invoice PDF from your <b>Documents</b> tab.</div>'+tbl([{t:'Invoice',f:function(r){return eh(r.invoice_no);}},{t:'Amount',r:1,f:function(r){return money(r.amount,r.currency);}},{t:'Due',f:function(r){return eh(r.due_date||'—');}},{t:'Status',f:function(r){return '<span class="badge">'+cap(r.status)+'</span>';}}],d.invoices,'No invoices.')+'</div>'):''));
  // RECEIPTS
  html+=seg('receipts',
    '<h2 class="sectitle">🧾 Payment History &amp; Receipts</h2>'
    +'<div class="panel">'+tbl([{t:'Receipt',f:function(r){return r.receipt_no||'—';}},{t:'Date',f:function(r){return fmt(r.date);}},{t:'For',f:function(r){return cap(r.category);}},{t:'Collected By',f:function(r){return (r.collector?eh(r.collector)+'<br>':'')+'<span class="muted" style="font-size:11px">'+eh(r.office||'')+'</span>';}},{t:'Amount',r:1,f:function(r){return money(r.amount,r.currency);}},{t:'',r:1,f:function(r){return r.receipt_no?'<button class="btn sm" onclick="doc(\\'/doc/receipt/'+r.id+'\\')">Download</button>':'';}}],d.payments,'No payments yet.')+'</div>');
  // TIMETABLE — published lecture/exam/mid-semester timetables + course allocation
  var ttTypeName=function(t){return t==='lecture'?'Lecture':t==='midsemester'?'Mid-Semester Test':'Examination';};
  var ttHtml='';
  (d.timetables||[]).forEach(function(t){
    var rows=(t.slots||[]).filter(function(s){return s.kind!=='holiday';});
    var hol=(t.slots||[]).filter(function(s){return s.kind==='holiday';});
    var isLec=t.type==='lecture';
    ttHtml+='<div class="panel"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap"><h3 style="margin:0">'+(isLec?'📘':t.type==='exam'?'📝':'🧪')+' '+eh(t.title||ttTypeName(t.type))+'</h3>'
      +'<button class="btn sm" onclick="doc(\\'/doc/timetable/'+t.id+'\\')">⬇️ Download PDF</button></div>'
      +'<div class="muted" style="font-size:12px;margin:4px 0 8px">'+eh([t.semester,t.session].filter(Boolean).join(' · ')||'')+'</div>'
      +tbl([
        {t:isLec?'Day':'Date',f:function(r){return eh(r.day||'—');}},
        {t:'Time',f:function(r){return eh((r.start||'')+(r.end?('–'+r.end):''));}},
        {t:'Course',f:function(r){return '<b>'+eh(r.course_code||'')+'</b> '+eh(r.course_title||'');}},
        {t:'Lecturer',f:function(r){return eh(r.lecturer||'—');}},
        {t:'Venue',f:function(r){return eh(r.venue||'—');}}
      ],rows,'No entries.')
      +(hol.length?('<div class="muted" style="font-size:12px;margin-top:6px">🏖 Breaks/holidays: '+hol.map(function(s){return eh(fmt(s.day));}).join(', ')+'</div>'):'')
      +'</div>';
  });
  (d.allocations||[]).forEach(function(a){
    ttHtml+='<div class="panel"><h3>👩‍🏫 '+eh(a.title||'Course Allocation')+'</h3>'
      +'<div class="muted" style="font-size:12px;margin-bottom:8px">'+eh([a.semester,a.session].filter(Boolean).join(' · ')||'')+'</div>'
      +tbl([
        {t:'Code',f:function(r){return '<b>'+eh(r.code||'')+'</b>';}},
        {t:'Course',f:function(r){return eh(r.title||'');}},
        {t:'CH',r:1,f:function(r){return String(r.ch||0);}},
        {t:'Lecturer',f:function(r){return eh(r.lecturer||'—');}}
      ],a.courses,'No courses.')
      +'</div>';
  });
  html+=seg('timetable',
    '<h2 class="sectitle">🗓 My Timetable &amp; Course Allocation</h2>'
    +(ttHtml||'<div class="empty">No timetables or course allocations published yet. They will appear here (and arrive by email) once your department releases them.</div>'));
  // LIVE CLASSES — join the lecturer's live video class (Jitsi) for each registered course
  var lcName=encodeURIComponent(((p.full_name||'Student'))+(p.matric_no?(' ('+p.matric_no+')'):''));
  window.__lcName=lcName; window.__lcHost=false;
  var lcHtml=(d.liveClasses||[]).map(function(c){
    return '<div class="panel"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">'
      +'<div><div style="font-weight:800;font-size:15px">'+eh(c.code||'')+' — '+eh(c.title||'')+'</div>'
      +'<div class="muted" style="font-size:12px;margin-top:2px">'+(c.lecturer?('👤 '+eh(c.lecturer)+' · '):'')+eh([c.semester,c.session].filter(Boolean).join(' · '))+(c.when?(' · 🕒 '+eh(c.when)):'')+'</div></div>'
      +'<button class="btn" onclick="joinClass(\\''+c.room+'\\',\\''+encodeURIComponent(c.subject||c.code||'Live Class')+'\\')">🎥 Join Live Class</button>'
      +'</div></div>';
  }).join('');
  html+=seg('liveclasses',
    '<h2 class="sectitle">🎥 Live Classes</h2>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:10px">Join your lecturer\\'s live video class for any of your registered courses. You can use your camera and microphone, see shared screens/documents, and chat. The class opens when your lecturer starts it.</div>'
    +(lcHtml||'<div class="empty">No live classes available yet. Once your courses are allocated to lecturers, each course will appear here with a <b>Join</b> button.</div>'));
  // E-LIBRARY — read e-books / study materials online (in-app reader) or download
  var libHtml=(d.library||[]).length?('<div class="lib-grid">'+(d.library||[]).map(function(b){
    var cover=b.cover?('<img class="lib-cover" src="'+b.cover+'" alt="">'):('<div class="lib-cover noc">📘</div>');
    var read=b.readable?('<button class="btn sm" onclick="readBook(\\''+b.id+'\\')">📖 Read</button>'):'';
    return '<div class="lib-card">'+cover
      +'<div class="lib-body"><div class="lib-title">'+eh(b.title||'Untitled')+'</div>'
      +'<div class="muted" style="font-size:11.5px">'+eh(b.author||'Unknown author')+(b.pages?(' · '+b.pages+' pages'):'')+'</div>'
      +'<div style="margin:5px 0"><span class="badge">'+eh(b.category||'General')+'</span></div>'
      +(b.description?('<div class="muted" style="font-size:11.5px;margin-bottom:6px">'+eh(String(b.description).slice(0,140))+'</div>'):'')
      +'<div class="qa" style="margin-top:auto">'+read+'<button class="btn sm ghost" onclick="downloadBook(\\''+b.id+'\\')">⬇ Download</button></div>'
      +'</div></div>';
  }).join('')+'</div>'):'<div class="empty">No books in the library yet. E-books and study materials published by the school will appear here to read online or download.</div>';
  html+=seg('library',
    '<h2 class="sectitle">📚 E-Library</h2>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:10px">Read e-books and study materials online in the built-in reader, or download them to read offline.</div>'
    +'<style>.lib-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}.lib-card{display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 3px 12px rgba(15,23,42,.05)}.lib-cover{width:100%;height:150px;object-fit:cover;background:#eef2f8}.lib-cover.noc{display:flex;align-items:center;justify-content:center;font-size:46px;color:#94a3b8}.lib-body{padding:11px 12px;display:flex;flex-direction:column;flex:1}.lib-title{font-weight:800;font-size:14px;line-height:1.25;margin-bottom:2px}</style>'
    +libHtml);
  // ONLINE EXAMS — scheduled, timed, camera/mic-proctored exams sat on this device (laptop or phone)
  var examsHtml=(d.exams||[]).length?((d.exams||[]).map(function(e){
    var a=e.attempt; var st;
    if(a&&(a.status==='submitted'||a.status==='auto_submitted'||a.status==='graded'))st='submitted';
    else if(e.window==='closed'||e.status==='ended')st='closed';
    else if(e.window==='upcoming')st='upcoming';
    else st='open';
    var badge=st==='submitted'?'<span class="badge" style="background:#dcfce7;color:#166534">Submitted</span>'
      :st==='closed'?'<span class="badge" style="background:#e5e7eb;color:#374151">Closed</span>'
      :st==='upcoming'?'<span class="badge" style="background:#fef3c7;color:#92400e">Upcoming</span>'
      :(e.live?'<span class="badge" style="background:#dbeafe;color:#1e40af">Open now</span>':'<span class="badge" style="background:#fef3c7;color:#92400e">Waiting for invigilator</span>');
    var btn='';
    if(st==='open')btn='<button class="btn" onclick="startExam(\\''+e.id+'\\')">'+((a&&a.status==='in_progress')?'▶ Resume exam':'▶ Start exam')+'</button>';
    else if(st==='submitted'&&a&&a.status==='graded'&&a.score!=null)btn='<span class="muted">Score: <b>'+a.score+'/'+(a.max_score||e.total_marks||'?')+'</b></span>';
    else if(st==='submitted')btn='<span class="muted">Awaiting results</span>';
    else if(st==='upcoming')btn='<span class="muted">Opens '+fmt(e.start_at)+'</span>';
    return '<div class="panel"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">'
      +'<div style="min-width:0"><div style="font-weight:800;font-size:15px">'+eh(e.title||e.course_code||'Exam')+'</div>'
      +'<div class="muted" style="font-size:12px;margin-top:2px">'+badge+' · '+(e.question_count||0)+' question(s) · '+(e.total_marks||0)+' marks · '+(e.duration_min||60)+' min</div></div>'
      +'<div>'+btn+'</div></div>'
      +(e.require_camera?'<div class="muted" style="font-size:11.5px;margin-top:6px">🎥 Camera &amp; microphone required — you are monitored live.</div>':'')
      +'</div>';
  }).join('')):'<div class="empty">No exams scheduled for you yet. When your department publishes an online exam it will appear here to sit on this device.</div>';
  html+=seg('exams',
    '<h2 class="sectitle">📝 Online Exams</h2>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:10px">Sit your scheduled exams right here — on a <b>laptop or a phone</b>, no app needed. Exams are timed and <b>proctored with your camera and microphone</b>: allow access when prompted, sit alone in good light, and stay on the page. Leaving the screen is recorded for the invigilator.</div>'
    +examsHtml);
  // EXAM CONDUCT — the student's exam attendance + any AI malpractice flag, with the actual
  // recorded evidence to download and a one-tap Appeal (transparency: nobody is penalised unseen).
  function svSev(s){var c=s==='high'?'background:#fee2e2;color:#991b1b':s==='medium'?'background:#fef3c7;color:#92400e':'background:#e5e7eb;color:#374151';return '<span class="badge" style="'+c+'">'+cap(s||'low')+'</span>';}
  function svStat(s){var m={open:['Under review','#fef3c7','#92400e'],appealed:['Appeal filed','#dbeafe','#1e40af'],upheld:['Upheld','#fee2e2','#991b1b'],dismissed:['Cleared ✓','#dcfce7','#166534'],reviewed:['Reviewed','#e5e7eb','#374151']}[s]||['Open','#fef3c7','#92400e'];return '<span class="badge" style="background:'+m[1]+';color:'+m[2]+'">'+m[0]+'</span>';}
  var attRows=(sv.attendance||[]).map(function(a){return '<tr><td>'+eh(a.exam)+'</td><td>'+(a.status==='present'?'<span class="badge" style="background:#dcfce7;color:#166534">Present</span>':'<span class="badge" style="background:#fee2e2;color:#991b1b">Absent</span>')+'</td><td class="muted">'+(a.method==='face'?'Face recognition':'Officer')+'</td><td class="muted">'+eh(fmt(a.date))+'</td></tr>';}).join('');
  var attHtml=attRows?('<div class="panel"><h3>Attendance</h3><table class="tb"><thead><tr><th>Exam</th><th>Status</th><th>Marked by</th><th>When</th></tr></thead><tbody>'+attRows+'</tbody></table></div>'):'';
  var flagHtml=(sv.flags||[]).length?((sv.flags||[]).map(function(f){
    var ev=(f.evidence||[]).map(function(e){var icon=e.kind==='video'?'🎬':e.kind==='audio'?'🔊':'🖼';return '<button class="btn sm" onclick="doc(\\'/surveillance/evidence/'+e.id+'\\')">'+icon+' View evidence</button> <button class="btn sm ghost" onclick="doc(\\'/surveillance/evidence/'+e.id+'?dl=1\\')">⬇ Download</button>';}).join(' ');
    var canAppeal=f.status!=='dismissed'&&!(f.appeal&&f.appeal.status==='pending');
    var appealBtn=canAppeal?('<button class="btn sm warn" onclick="appealFlag(\\''+f.id+'\\')">⚖️ Appeal / report wrong person</button>'):(f.appeal&&f.appeal.status==='pending'?'<span class="muted" style="font-size:12px">⏳ Your appeal is under review</span>':(f.appeal&&f.appeal.status==='accepted'?'<span class="muted" style="font-size:12px;color:#166534">✓ Appeal accepted — cleared</span>':''));
    return '<div class="panel" style="border-left:4px solid '+(f.severity==='high'?'#ef4444':f.severity==='medium'?'#f59e0b':'#94a3b8')+'">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><div style="font-weight:800">'+eh(f.label||f.type)+'</div><div>'+svSev(f.severity)+' '+svStat(f.status)+'</div></div>'
      +'<div class="muted" style="font-size:12px;margin:4px 0">'+eh(f.exam)+' · '+eh(fmt(f.date))+'</div>'
      +(f.detail?('<div style="font-size:13px;margin-bottom:7px">'+eh(f.detail)+'</div>'):'')
      +'<div class="qa" style="gap:6px;flex-wrap:wrap">'+(ev||'<span class="muted" style="font-size:12px">No clip attached.</span>')+'</div>'
      +'<div style="margin-top:8px">'+appealBtn+'</div></div>';
  }).join('')):'<div class="empty">No exam-conduct flags on your record. 🎉</div>';
  html+=seg('surveillance',
    '<h2 class="sectitle">🛡️ Exam Conduct</h2>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:10px">Your exam attendance and any conduct alert raised by the AI monitoring system. We show you the exact evidence that was recorded — if you believe a flag is a mistake (for example the system identified the wrong person), tap <b>Appeal</b> and an exam officer will review it.</div>'
    +attHtml+flagHtml);
  // RESULTS — list each level + semester with a downloadable PDF statement of result
  var sc=d.scores||{courses:[],semesters:[],cgpa:0,totalUnits:0};
  var myLevel=(d.profile&&d.profile.level)||'—';
  // 📈 the student's own GPA trend — same signal the university's Academic Watch tracks, so a
  // student can see their progress (and the effect of a comeback semester) at a glance.
  var gpaTrend='';
  if(sc.semesters&&sc.semesters.length){
    var gbars=sc.semesters.map(function(sm){var g=Number(sm.gpa)||0;var pct=Math.max(3,Math.min(100,(g/5)*100));var col=g<2?'#ef4444':g<3?'#f59e0b':'#22c55e';
      return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:2px"><span>'+eh([sm.session,sm.semester].filter(Boolean).join(' · ')||'—')+'</span><b style="color:'+(g<2?'#b91c1c':g>=4?'#065f46':'#0f172a')+'">'+g.toFixed(2)+'</b></div>'
        +'<div style="height:10px;border-radius:999px;background:#e2e8f0;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+col+'"></div></div></div>';}).join('');
    gpaTrend='<div class="panel"><h3>📈 My Academic Progress</h3>'
      +'<div style="font-size:13px;margin:4px 0 10px">Cumulative GPA: <b style="font-size:19px">'+(Number(sc.cgpa)||0).toFixed(2)+'</b> · '+(sc.totalUnits||0)+' credit units earned</div>'
      +gbars
      +'<div class="muted" style="font-size:11.5px;margin-top:6px">Keep it climbing — the 📚 E-Library has free textbooks for every course, and your lecturers are there to help.</div></div>';
  }
  var resultsHtml=(sc.semesters&&sc.semesters.length)?(
    '<div class="panel"><h3>My Results</h3>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:8px">Your statement of result is generated as a PDF. Pick a semester and click <b>Download PDF</b> — the document opens ready to save/print.</div>'
    +tbl([
      {t:'Level',f:function(r){return eh(myLevel);}},
      {t:'Semester',f:function(r){return eh(r.semester||'—');}},
      {t:'Session',f:function(r){return eh(r.session||'—');}},
      {t:'',r:1,f:function(r){return '<button class="btn sm" onclick="doc(\\'/doc/result-slip?session='+encodeURIComponent(r.session_id||'')+'&semester='+encodeURIComponent(r.semester_id||'')+'\\')">⬇️ Download PDF</button>';}}
    ],sc.semesters,'No results published yet.')
    +'<div style="margin-top:10px"><button class="btn sm ghost" onclick="doc(\\'/doc/result-slip\\')">⬇️ Download full statement (all semesters)</button></div>'
    +'</div>'
  ):(d.resultsWithheld
    ?'<div class="exbar warn">⚠ Some or all of your results for this period are currently <b>withheld</b> by the Examinations Board (e.g. pending board approval or an outstanding obligation). Please contact the Registry. They will appear here once released.</div>'
    :'<div class="empty">No results published yet. They will appear here once your results are released.</div>');
  // MY COURSES — the courses the student is registered to offer this session (auto-linked from
  // Academic Planning) and which of them are still awaiting a result.
  var rc=d.registeredCourses||{courses:[],awaiting:[]};
  var kindTag=function(k){return k==='carryover'?' <span class="neg" style="font-weight:800">carry-over</span>':(k==='borrowed'?' <span class="muted">borrowed</span>':(k==='elective'?' <span class="muted">elective</span>':''));};
  var statusBadge=function(s){var m={published:['✓ Published','pos'],recorded:['⏳ Recorded — pending release','muted'],uploaded:['⚙ Uploaded — processing','muted'],missing:['⚠ Missing — not on the uploaded sheet','neg'],not_uploaded:['✖ Not uploaded yet','neg']}[s]||['—','muted'];return '<span class="'+m[1]+'" style="font-weight:800">'+m[0]+'</span>';};
  var reqLine=function(rq){if(!rq)return '';var m={open:'🔎 Reported — the system is locating your result…',auto_fixed:'✓ Found and linked — it will show once released',recorded:'✓ Recorded',not_found:'👤 With a staff member for a manual check',not_uploaded:'⏳ Results not uploaded yet',resolved:'✓ Resolved',rejected:'Reviewed and closed'}[rq.status]||rq.status;return '<div class="muted" style="font-size:11px;margin-top:3px">'+(rq.ticket_no?('<b>'+eh(rq.ticket_no)+'</b> · '):'')+eh(m)+(rq.resolution?(' — '+eh(rq.resolution)):'')+'</div>';};
  var reportBtn=function(r){
    if(r.request&&(r.request.status==='open'))return '<span class="muted" style="font-size:11.5px">⏳ Reported</span>';
    if(r.status==='published')return '<button class="btn sm ghost" onclick="reportResult(\\''+encodeURIComponent(r.course_code)+'\\',\\'wrong_score\\')">⚠ Wrong score?</button>';
    return '<button class="btn sm" onclick="reportResult(\\''+encodeURIComponent(r.course_code)+'\\',\\'missing\\')">🔎 Report missing</button>';
  };
  var notUp=(rc.courses||[]).filter(function(c){return c.status==='not_uploaded';});
  var missn=(rc.courses||[]).filter(function(c){return c.status==='missing';});
  var coursesHtml=(rc.courses&&rc.courses.length)?(
    '<div class="panel"><h3>My Courses This Semester</h3>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:8px">Every course you are registered to offer, with its result status. <b>✓ Published</b> = released to you · <b>Recorded</b> = your score is captured, awaiting release · <b>Uploaded — processing</b> = the sheet is in and your row is being matched · <b>⚠ Missing</b> = the sheet was uploaded and processed but YOUR row is not on it (absent, exam/test not written, or misread — report it!) · <b>Not uploaded yet</b> = the lecturer’s sheet has not arrived. Tap <b>Report</b> and the AI will find and fix it automatically, or hand it to a staff member — you get an email at every step of your ticket.</div>'
    +(notUp.length?('<div class="exbar warn">✖ Results not yet uploaded for '+notUp.length+' course(s): <b>'+notUp.map(function(c){return eh(c.course_code);}).join(', ')+'</b> — you’ll see them here the moment they are.</div>'):'')
    +(missn.length?('<div class="exbar warn">⚠ The uploaded results for <b>'+missn.map(function(c){return eh(c.course_code);}).join(', ')+'</b> do NOT include a score for you (absent, exam/test not written, or your row was misread). If you sat the paper, tap <b>Report missing</b> so the AI + exams office can trace your script.</div>'):'')
    +tbl([
      {t:'Code',f:function(r){return '<span class="mono" style="font-weight:700">'+eh(r.course_code||'—')+'</span>'+kindTag(r.kind);}},
      {t:'Title',f:function(r){return eh(r.course_title||'—')+reqLine(r.request);}},
      {t:'CH',r:1,f:function(r){return String(r.credit_unit||0);}},
      {t:'Status',f:function(r){return statusBadge(r.status)+(r.status==='published'&&r.grade?(' <span class="muted">('+eh(r.grade)+')</span>'):'');}},
      {t:'',r:1,f:function(r){return reportBtn(r);}}
    ],rc.courses,'No registered courses yet.')
    +'</div>'
  ):'';
  // 🎫 MY TICKETS — every result/payment report with its live timeline (lazy-loaded)
  var ticketsHtml='<div class="panel"><h3>🎫 My Tickets</h3>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:8px">Every issue you have reported — missing results and payments that didn’t reflect — with its live timeline. You also get an email at every update.</div>'
    +'<div id="tixBody"><div class="empty">Loading…</div></div></div>';
  html+=seg('results',
    '<h2 class="sectitle">📑 My Results</h2>'
    +gpaTrend
    +coursesHtml
    +ticketsHtml
    +resultsHtml
    +'<div class="panel"><h3>Other Result Documents</h3>'+tbl([{t:'Level',f:function(r){return eh(r.level||'—');}},{t:'Semester',f:function(r){return eh(r.semester||'—');}},{t:'Session',f:function(r){return eh(r.session||'—');}},{t:'Title',f:function(r){return eh(r.title||'Result');}},{t:'',r:1,f:function(r){return '<button class="btn sm" onclick="doc(\\'/doc/result/'+r.id+'\\')">Download</button>';}}],d.results,'No other result documents.')+'</div>');
  // CLEARANCE
  html+=seg('clearance',
    '<h2 class="sectitle">✅ Examination Clearance</h2>'
    +'<div class="exbar '+clrCls+'">'+clrTxt+'</div>'
    +(((clr.certs&&clr.certs.length))?('<div class="qa">'+clr.certs.map(function(ct){return '<button class="btn sm" onclick="doc(\\'/doc/clearance/'+ct.id+'\\')">📄 Download my '+eh(ct.typeName)+' clearance certificate</button>';}).join('')+'</div>'):'')
    +'<div class="panel"><h3>Exam Validation History</h3>'+tbl([{t:'Date',f:function(r){return fmt(r.date);}},{t:'Type',f:function(r){return cap(r.exam_type||'exam');}},{t:'Session',f:function(r){return eh(r.session||'—')+(r.semester?(' · '+eh(r.semester)):'');}},{t:'Result',f:function(r){return '<span class="'+(r.status==='valid'?'pos':'neg')+'" style="font-weight:800">'+(r.status==='valid'?'CLEARED':'DENIED')+'</span>';}},{t:'Reason',f:function(r){return eh(r.reason||'—');}}],d.validations,'No exam validations yet.')+'</div>');
  // FINAL CLEARANCE (Graduation) — lazy-loaded from /api/final-clearance when the tab opens
  html+=seg('finalclr',
    '<h2 class="sectitle">🎓 Final Clearance (Graduation)</h2>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:10px">Your end-to-end graduation clearance — financial clearance, academic checks, project defence, transcript &amp; certificate, and collection of your physical documents. Pay any office online and track every step here.</div>'
    +'<div id="fcBody"><div class="empty">Loading…</div></div>');
  // DOCUMENTS
  var trqRows=(d.transcriptRequests||[]);
  var trqBadge=function(s){var c=s==='dispatched'?'pos':(s==='rejected'?'neg':'');return '<span class="'+c+'" style="font-weight:800">'+cap(s||'pending')+'</span>';};
  // 📨 graduate document dispatch — send credentials to a government agency / university / employer
  var dsp=d.dispatch||{graduated:false,docs:[],ready:false};
  var dspHtml='';
  if(dsp.graduated){
    if(dsp.ready){
      var dcks=(dsp.docs||[]).map(function(x){
        return '<label style="display:flex;align-items:center;gap:9px;padding:8px 11px;border:1px solid var(--line,#e2e8f0);border-radius:9px;margin-bottom:6px;'+(x.available?'cursor:pointer':'opacity:.55')+'">'
          +'<input type="checkbox" class="odck" value="'+eh(x.key)+'"'+(x.available?((x.key==='transcript'||x.key==='certificate')?' checked':''):' disabled')+' style="width:16px;height:16px">'
          +'<span style="flex:1;font-size:13px;font-weight:600">'+eh(x.label)+'</span>'
          +'<span class="muted" style="font-size:11px">'+(x.available?'Available':'Not issued')+'</span></label>';
      }).join('');
      dspHtml='<div class="panel"><h3>📨 Send My Documents to an Organization</h3>'
        +'<div class="muted" style="font-size:12.5px;margin-bottom:8px">Send your official transcript, certificate or letters directly to a government agency, university or employer. They are emailed by the <b>Office of the Registrar</b> (never from your personal email), and every send is logged with a reference number.</div>'
        +'<label style="display:block;font-size:12px;font-weight:700;margin:8px 0 3px">The organization is a…</label>'
        +'<select id="orgType" style="width:100%"><option value="government">Government agency</option><option value="university">University / higher institution</option><option value="institution">Other institution</option><option value="employer">Employer</option><option value="other">Other</option></select>'
        +'<label style="display:block;font-size:12px;font-weight:700;margin:8px 0 3px">Organization name</label>'
        +'<input id="orgName" placeholder="e.g. Federal Ministry of Education" style="width:100%">'
        +'<label style="display:block;font-size:12px;font-weight:700;margin:8px 0 3px">Organization email</label>'
        +'<input id="orgEmail" type="email" placeholder="records@organization.gov" style="width:100%">'
        +'<label style="display:block;font-size:12px;font-weight:700;margin:10px 0 5px">Documents to send</label>'
        +dcks
        +'<button class="btn" id="orgSend" onclick="sendToOrg()" style="margin-top:8px">📨 Send via the Office of the Registrar</button>'
        +'<div id="orgMsg"></div></div>';
    } else {
      dspHtml='<div class="panel"><h3>📨 Send My Documents to an Organization</h3>'
        +'<div class="muted" style="font-size:12.5px">Your official transcript and certificate are not yet available on your record, so documents cannot be sent to organizations yet. <b>Please contact the Office of the Registrar for help.</b></div></div>';
    }
  }
  html+=seg('documents',
    '<h2 class="sectitle">📂 University Documents</h2>'
    +'<div class="panel">'+tbl([{t:'Title',f:function(r){return eh(r.title||'Document');}},{t:'Type',f:function(r){return '<span class="badge">'+eh(r.category||'Document')+'</span>';}},{t:'From Office',f:function(r){return eh(r.office||'—')+(r.by?'<br><span class="muted" style="font-size:11px">'+eh(r.by)+'</span>':'');}},{t:'Date',f:function(r){return fmt(r.date);}},{t:'',r:1,f:function(r){return '<button class="btn sm" onclick="doc(\\'/doc/portal-document/'+r.id+'\\')">Download</button>';}}],d.documents,'No documents published yet.')+'</div>'
    +dspHtml
    +'<div class="panel"><h3>Request an Official Document</h3>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:8px">Request a signed official transcript or degree certificate. The Registry processes it, emails you a copy and places it in your Documents above.</div>'
    +'<div class="qa"><button class="btn sm" onclick="reqTranscript(\\'transcript\\')">📜 Request Transcript</button><button class="btn sm" onclick="reqTranscript(\\'certificate\\')">🎓 Request Certificate</button></div>'
    +tbl([{t:'Type',f:function(r){return cap(r.kind||'transcript');}},{t:'Purpose',f:function(r){return eh(r.purpose||'—');}},{t:'Requested',f:function(r){return fmt(r.date);}},{t:'Status',f:function(r){return trqBadge(r.status)+(r.status==='rejected'&&r.note?(' <span class="muted">('+eh(r.note)+')</span>'):'');}}],trqRows,'No requests yet.')+'</div>');
  // DISCIPLINE
  if(d.misconduct&&d.misconduct.length){
    html+=seg('discipline',
      '<h2 class="sectitle">⚖️ Disciplinary Records</h2>'
      +'<div class="panel">'+tbl([{t:'Date',f:function(r){return fmt(r.date);}},{t:'Offense',f:function(r){return eh(r.offense||'—');}},{t:'Severity',f:function(r){return sevBadge(r.severity);}},{t:'Action',f:function(r){return cap(r.action||'—');}},{t:'Fine',r:1,f:function(r){return r.fine>0?money(r.fine,r.currency):'—';}},{t:'Status',f:function(r){return stBadge(r.status);}},{t:'Note',f:function(r){return eh(r.note||'—');}}],d.misconduct,'No misconduct on record.')+'</div>');
  }
  // EVALUATION — open anonymous course/lecturer evaluation surveys for this student's cohort
  if(d.surveys&&d.surveys.length){
    var evHtml=d.surveys.map(function(sv){
      var nr=(sv.questions||[]).filter(function(q){return q.type!=='text';}).length;
      var qs=(sv.questions||[]).map(function(q){
        if(q.type==='text')return '<div style="margin-bottom:12px"><div style="font-weight:600;font-size:13.5px;margin-bottom:4px">'+eh(q.text)+'</div><textarea data-qid="'+eh(q.id)+'" rows="2" style="width:100%"></textarea></div>';
        var st='';for(var n=1;n<=5;n++)st+='<label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:13px"><input type="radio" name="q_'+sv.id+'_'+q.id+'" data-qid="'+eh(q.id)+'" value="'+n+'" style="width:auto"> '+n+'</label>';
        return '<div style="margin-bottom:12px"><div style="font-weight:600;font-size:13.5px;margin-bottom:4px">'+eh(q.text)+'</div><div>'+st+'<span class="muted" style="font-size:11px">(1 = poor · 5 = excellent)</span></div></div>';
      }).join('');
      return '<div class="panel" id="survey-'+sv.id+'" data-ratings="'+nr+'" style="padding:16px">'
        +'<div style="font-weight:800;font-size:15px">'+eh(sv.title)+'</div>'
        +((sv.course||sv.lecturer)?('<div class="muted" style="font-size:12px;margin-top:2px">'+eh([sv.course,sv.lecturer].filter(Boolean).join(' · '))+'</div>'):'')
        +(sv.description?('<div class="muted" style="font-size:12.5px;margin:6px 0">'+eh(sv.description)+'</div>'):'')
        +'<div style="margin-top:10px">'+qs+'</div>'
        +'<div style="margin-bottom:12px"><div style="font-weight:600;font-size:13.5px;margin-bottom:4px">Additional comments (optional)</div><textarea class="svcomment" rows="2" style="width:100%"></textarea></div>'
        +'<button class="btn sm svsubmit" onclick="submitSurvey(\\''+sv.id+'\\')">Submit Evaluation</button>'
        +'</div>';
    }).join('');
    html+=seg('evaluation',
      '<h2 class="sectitle">⭐ Course &amp; Lecturer Evaluation</h2>'
      +'<div class="muted" style="font-size:12.5px;margin-bottom:10px">Your feedback is <b>anonymous</b> and helps improve teaching. Please rate each statement from 1 (poor) to 5 (excellent).</div>'
      +evHtml);
  }
  // PROFILE
  html+=seg('profile',
    '<h2 class="sectitle">👤 My Profile</h2>'
    +'<div class="panel"><div class="prof">'+photo+'<div><div class="nm">'+eh(p.full_name)+'</div><div class="meta">'+eh(p.matric_no||'Matric pending')+'</div></div></div>'
    +'<table><tbody>'
    +'<tr><th>Faculty</th><td>'+eh(p.faculty||'—')+'</td><th>Department</th><td>'+eh(p.department||'—')+'</td></tr>'
    +'<tr><th>Level</th><td>'+eh(p.level||'—')+'</td><th>Email</th><td>'+eh(p.email||'—')+'</td></tr>'
    +'<tr><th>Session</th><td>'+eh(d.currentSession||'—')+'</td><th>Semester</th><td>'+eh(d.currentSemester||'—')+'</td></tr>'
    +'</tbody></table></div>'
    +'<div class="qa"><button class="btn sm" onclick="changePassword()">🔑 Change password</button></div>');

  var box=document.createElement('div');box.innerHTML=html;
  while(box.firstChild)content.appendChild(box.firstChild);
  var shell=$('<div class="shell"></div>');shell.appendChild(head);shell.appendChild(navEl);shell.appendChild(content);w.appendChild(shell);
  function show(s){
    Array.prototype.forEach.call(content.querySelectorAll('.seg'),function(el){el.classList.toggle('on',el.getAttribute('data-seg')===s);});
    Array.prototype.forEach.call(navEl.querySelectorAll('a'),function(a){a.classList.toggle('active',a.getAttribute('data-seg')===s);});
    window.__seg=s;
    if(s==='finalclr'){ try{ loadFinalClearance(); }catch(_){} }
    if(s==='results'){ try{ loadTickets(); }catch(_){} }
    // opening Updates marks everything seen → clears the unread pill
    if(s==='notifications'){ try{ if(window.__notifMax) localStorage.setItem(window.__seenKey, window.__notifMax); }catch(_){}
      var nb=navEl.querySelector('a[data-seg="notifications"] .pill'); if(nb)nb.remove(); }
    if(!window.__renderBg){try{window.scrollTo(0,0);}catch(_){}}   // top of the chosen section (but never on a silent live refresh)
  }
  window.__goSeg=show;
  Array.prototype.forEach.call(navEl.querySelectorAll('a'),function(a){a.onclick=function(){show(a.getAttribute('data-seg'));};});
  var want=window.__seg||'overview';
  if(!content.querySelector('.seg[data-seg="'+want+'"]'))want='overview';
  show(want);
}
function staffView(w,d){
  const p=d.profile;
  w.appendChild($('<div class="panel"><div class="prof">'+(p.photo?'<img src="'+p.photo+'">':'<div class="ph">👤</div>')+'<div><div class="nm">'+eh(p.full_name)+' <span class="badge">'+eh(p.type)+'</span></div><div class="meta">'+eh(p.staff_no||'—')+' · '+eh(p.position||p.title||'—')+'</div><div class="meta">'+eh(p.department||p.faculty||'')+' · '+eh(p.email||'')+'</div></div></div></div>'));
  w.appendChild($('<div class="kpis"><div class="kpi"><div class="l">Base / Default Pay</div><div class="v">'+money(p.base_salary,p.currency)+'</div></div><div class="kpi"><div class="l">Payslips</div><div class="v">'+d.payslips.length+'</div></div><div class="kpi"><div class="l">Bank</div><div class="v" style="font-size:15px">'+(p.bank_name||'—')+'</div></div></div>'));
  w.appendChild($('<div class="panel"><h3>My Payslips</h3>'+tbl([{t:'Period',f:r=>r.period||'—'},{t:'Type',f:r=>cap(r.run_type||'staff')},{t:'Status',f:r=>'<span class="badge">'+cap(r.status||'draft')+'</span>'},{t:'Net Pay',r:1,f:r=>money(r.net,r.currency)},{t:'',r:1,f:r=>'<button class="btn sm" onclick="doc(\\'/doc/payslip/'+r.id+'\\')">Payslip</button>'}],d.payslips,'No payslips yet.')+'</div>'));
  // INVIGILATION — exam duties assigned to this staff member
  if(d.invigilations&&d.invigilations.length){
    w.appendChild($('<div class="panel"><h3>🧑‍🏫 My Invigilation Duties</h3><div class="muted" style="font-size:12.5px;margin-bottom:6px">Examinations you have been assigned to invigilate. Please report to the room ahead of the start time.</div>'+tbl([{t:'Date',f:r=>fmt(r.date)},{t:'Time',f:r=>eh((r.start||'')+'–'+(r.end||''))},{t:'Room',f:r=>eh(r.room||'—')},{t:'Course',f:r=>eh(r.course||'—')},{t:'Cohort',f:r=>eh([r.department,r.level].filter(Boolean).join(' · ')||'—')}],d.invigilations,'No invigilation duties assigned.')+'</div>'));
  }
  // LIVE CLASSES — a lecturer HOSTS the live video class for each course they teach
  if(d.liveClasses&&d.liveClasses.length){
    window.__lcName=encodeURIComponent((p.full_name||'Lecturer')+' (Lecturer)'); window.__lcHost=true;
    var rows=d.liveClasses.map(function(c){
      return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--line)">'
        +'<div><div style="font-weight:800">'+eh(c.code||'')+' — '+eh(c.title||'')+'</div>'
        +'<div class="muted" style="font-size:12px;margin-top:2px">'+eh([c.department,c.level,c.semester,c.session].filter(Boolean).join(' · '))+'</div></div>'
        +'<button class="btn" onclick="joinClass(\\''+c.room+'\\',\\''+encodeURIComponent(c.subject||c.code||'Live Class')+'\\')">🎥 Start / Host Class</button></div>';
    }).join('');
    w.appendChild($('<div class="panel"><h3>🎥 My Live Classes</h3><div class="muted" style="font-size:12.5px;margin-bottom:6px">Start a live video class for any course you teach. Students registered for the course join from their portal. You can share your screen and documents, and chat live.</div>'+rows+'</div>'));
  }
}
function officerControls(w,d){
  var per=d.period||{};var ps=d.periods||{sessions:[],semesters:[]};
  var today=new Date().toISOString().slice(0,10);var thisMonth=today.slice(0,7);
  function o(v,l,sel){return '<option value="'+v+'"'+(sel?' selected':'')+'>'+l+'</option>';}
  var basis=per.basis||'all';
  var basisOpts=[['all','All time'],['day','Daily'],['week','Weekly'],['month','Monthly'],['semester','Semester'],['session','Session']].map(function(x){return o(x[0],x[1],basis===x[0]);}).join('');
  var sessOpts='<option value="">All sessions</option>'+ps.sessions.map(function(s){return o(s.id,eh(s.name),s.id===per.session);}).join('');
  var semOpts='<option value="">All semesters</option>'+ps.semesters.map(function(sm){return o(sm.id,eh(sm.name),sm.id===per.semester);}).join('');
  // finance officers (accountant/admin) can drill into a specific office's collections
  var officeCtrl='';
  if(d.canPickOffice){var oo=per.office||'';officeCtrl='<span class="muted">Office:</span> <select id="of-office">'+[['','All offices'],['accountant','Bursary / Accountant'],['registrar','Registrar'],['dean','Faculty Head (Dean)'],['student_affairs','Student Affairs']].map(function(x){return o(x[0],x[1],oo===x[0]);}).join('')+'</select>';}
  var bar=$('<div class="panel"><div class="toolbarp" style="padding:14px 16px">'
    +'<b>📊 Report:</b> <select id="of-basis">'+basisOpts+'</select> <span id="of-valwrap"></span>'
    +officeCtrl
    +'<button class="btn sm" id="of-dl" style="width:auto">📄 Download</button>'
    +'<span style="flex:1"></span>'
    +'<input id="of-find" placeholder="🔎 Find a student…" style="min-width:200px;width:auto">'
    +'</div><div id="of-find-res" style="padding:0 16px 14px"></div></div>');
  w.appendChild(bar);
  var basisSel=bar.querySelector('#of-basis'),valwrap=bar.querySelector('#of-valwrap');
  var officeSel=bar.querySelector('#of-office');if(officeSel)officeSel.onchange=apply;
  function buildVal(){
    var b=basisSel.value;
    if(b==='day')valwrap.innerHTML='<input type="date" id="of-day" value="'+(per.day||today)+'">';
    else if(b==='week')valwrap.innerHTML='week of <input type="date" id="of-week" value="'+(per.weekStart||today)+'">';
    else if(b==='month')valwrap.innerHTML='<input type="month" id="of-month" value="'+(per.month||thisMonth)+'">';
    else if(b==='session')valwrap.innerHTML='<select id="of-sess">'+sessOpts+'</select>';
    else if(b==='semester')valwrap.innerHTML='<select id="of-sess">'+sessOpts+'</select> <select id="of-sem">'+semOpts+'</select>';
    else valwrap.innerHTML='';
    Array.prototype.forEach.call(valwrap.querySelectorAll('input,select'),function(el){el.onchange=apply;});
  }
  function gather(){
    var b=basisSel.value,p={basis:b},e;
    if(b==='day'){e=valwrap.querySelector('#of-day');p.day=e?e.value:today;}
    else if(b==='week'){e=valwrap.querySelector('#of-week');p.weekStart=e?e.value:today;}
    else if(b==='month'){e=valwrap.querySelector('#of-month');p.month=e?e.value:thisMonth;}
    else if(b==='session'){e=valwrap.querySelector('#of-sess');p.session=e?e.value:'';}
    else if(b==='semester'){var s=valwrap.querySelector('#of-sess'),m=valwrap.querySelector('#of-sem');p.session=s?s.value:'';p.semester=m?m.value:'';}
    if(officeSel&&officeSel.value)p.office=officeSel.value;
    return p;
  }
  function qstr(p){return Object.keys(p).map(function(k){return k+'='+encodeURIComponent(p[k]||'');}).join('&');}
  function apply(){officerReload(gather());}
  basisSel.onchange=function(){buildVal();apply();};
  buildVal();
  bar.querySelector('#of-dl').onclick=function(){doc('/doc/officer-report?'+qstr(gather()));};
  var find=bar.querySelector('#of-find'),fres=bar.querySelector('#of-find-res');var ft;
  find.addEventListener('input',function(){clearTimeout(ft);ft=setTimeout(async function(){
    var q=find.value.trim();fres.innerHTML='';if(q.length<2)return;
    var r=await api('/api/students?q='+encodeURIComponent(q));
    (r.students||[]).forEach(function(s){var c=$('<div class="ev-card" style="display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid #e6eaf0;border-radius:10px;margin-top:6px;cursor:pointer"><div style="flex:1"><b>'+eh(s.name)+'</b><div class="muted" style="font-size:12px">'+eh(s.matric||'—')+' · '+eh(s.department||'—')+'</div></div><span class="badge">Statement →</span></div>');c.onclick=function(){doc('/doc/student-statement/'+s.id);};fres.appendChild(c);});
    if(!(r.students||[]).length)fres.innerHTML='<div class="muted">No match.</div>';
  },200);});
}
function officerReload(period){
  var qs=Object.keys(period||{}).map(function(k){return k+'='+encodeURIComponent(period[k]||'');}).join('&');
  api('/api/officer-report?'+qs).then(function(r){
    if(!r.ok)return;var d=r.data;var w=document.querySelector('.wrap');w.innerHTML='';officerView(w,d);
  });
}
function officerView(w,d){
  var pp=d.profile||{};
  w.appendChild($('<div class="panel"><div class="prof">'+(pp.photo?'<img src="'+pp.photo+'">':'<div class="ph">👤</div>')+'<div><div class="nm">'+eh(pp.full_name||'Officer')+'</div><div class="meta" style="text-transform:capitalize">'+eh((d.role||'').replace("_"," "))+' • '+eh(pp.email||'')+'</div></div></div></div>'));
  officerControls(w,d);
  if(d.kind==='finance'){
    w.appendChild($('<div class="kpis">'+kpi('Collected',mapMoney(d.cards.collected))+kpi('Billed',mapMoney(d.cards.billed))+kpi('Expenses',mapMoney(d.cards.expenses))+kpi('Students',d.cards.students)+kpi('Debtors',d.cards.debtors)+'</div>'));
    if(d.campuses&&d.campuses.length){
      w.appendChild($('<div class="panel"><h3>🏫 Students by Campus</h3>'+tbl([{t:'Campus',f:r=>eh(r.name)},{t:'Students',r:1,f:r=>r.students}],d.campuses,'No campuses.')+'</div>'));
    }
    // collections grouped by office (who collected)
    if(d.byOffice&&d.byOffice.length){
      w.appendChild($('<div class="panel"><h3>💰 Collections by Office</h3>'+tbl([{t:'Office',f:r=>eh(r.office)},{t:'Collected',r:1,f:r=>mapMoney(r.amounts)}],d.byOffice,'No collections.')+'</div>'));
    }
    var rtitle = d.officeFilter ? 'Payments — '+eh((d.byOffice.find(function(o){return o.role===d.officeFilter;})||{}).office||'office') : 'Recent Payments (all offices)';
    w.appendChild($('<div class="panel"><h3>'+rtitle+'</h3>'+tbl([{t:'Receipt',f:r=>r.receipt_no||'—'},{t:'Student',f:r=>eh(r.student)},{t:'For',f:r=>cap(r.category)},{t:'Office',f:r=>eh(r.office||'—')},{t:'By',f:r=>eh(r.by||'—')},{t:'Date',f:r=>fmt(r.date)},{t:'Amount',r:1,f:r=>money(r.amount,r.currency)}],d.recent,'No payments.')+'</div>'));
    // expenses — all offices
    if(d.expensesByOffice&&d.expensesByOffice.length){
      w.appendChild($('<div class="panel"><h3>📉 Expenses by Office</h3>'+tbl([{t:'Office',f:r=>eh(r.office)},{t:'Spent',r:1,f:r=>mapMoney(r.amounts)}],d.expensesByOffice,'No expenses.')+'</div>'));
    }
    w.appendChild($('<div class="panel"><h3>Expense Records (all offices)</h3>'+tbl([{t:'Category',f:r=>cap(r.category)},{t:'Description',f:r=>eh(r.description||'—')},{t:'Recorded By',f:r=>eh(r.by||'—')},{t:'Date',f:r=>fmt(r.date)},{t:'Amount',r:1,f:r=>money(r.amount,r.currency)}],d.expensesList||[],'No expenses recorded yet.')+'</div>'));
  } else if(d.kind==='registrar'){
    w.appendChild($('<div class="kpis">'+kpi('My Collections',mapMoney(d.collected))+kpi('Students I Billed',d.students.length)+'</div>'));
    w.appendChild($('<div class="panel"><h3>Students I Billed — paid vs owing</h3>'+tbl([{t:'Name',f:r=>eh(r.full_name)},{t:'Matric',f:r=>eh(r.matric_no||'—')},{t:'Department',f:r=>eh(r.department||'—')},{t:'Paid',r:1,f:r=>mapMoney(r.paid)},{t:'Owing',r:1,f:r=>'<span class=neg>'+mapMoney(r.owing)+'</span>'}],d.students,'You have not billed anyone yet.')+'</div>'));
  } else if(d.kind==='dean'){
    w.appendChild($('<div class="kpis">'+kpi('Faculty Collections',mapMoney(d.collected))+kpi('My Expenditure',mapMoney(d.expenses))+kpi('Students Owing',d.debtors.length)+'</div>'));
    w.appendChild($('<div class="panel"><h3>Students Owing Faculty Fees</h3>'+tbl([{t:'Name',f:r=>eh(r.full_name)},{t:'Matric',f:r=>eh(r.matric_no||'—')},{t:'Department',f:r=>eh(r.department||'—')},{t:'Owing',r:1,f:r=>'<span class=neg>'+mapMoney(r.owing)+'</span>'}],d.debtors,'No student owes faculty fees.')+'</div>'));
  } else if(d.kind==='affairs'&&d.clearance){
    w.appendChild($('<div class="kpis">'+kpi('Clearance Pending',d.clearance.pending)+kpi('Approved',d.clearance.approved)+kpi('Misconduct (open)',d.misconduct.open)+kpi('Misconduct (total)',d.misconduct.total)+'</div>'));
    w.appendChild($('<div class="panel"><h3>Student Affairs</h3><div class="empty">Clearance approvals and discipline are summarised above. Use the desktop app to action items.</div></div>'));
  } else {
    w.appendChild($('<div class="panel"><div class="prof"><div class="ph">👤</div><div><div class="nm">'+eh((d.profile&&d.profile.full_name)||'Welcome')+'</div><div class="meta" style="text-transform:capitalize">'+eh(d.role||'staff')+' account</div></div></div></div>'));
    w.appendChild($('<div class="panel"><h3>Dashboard</h3><div class="empty">You are signed in. Your reports and tools are available in the desktop app.</div></div>'));
  }
  try{PI18N.translate(w);}catch(_){}
}
function kpi(l,v){return '<div class="kpi"><div class="l">'+l+'</div><div class="v">'+v+'</div></div>';}
function cap(s){s=String(s||'');return s.charAt(0).toUpperCase()+s.slice(1).replace(/_/g,' ');}
if('serviceWorker' in navigator){navigator.serviceWorker.register((window.__B||'')+'/sw.js').catch(()=>{});}
(function(){
  function boot(){
    if(!TOKEN){renderLogin();return;}
    // ⚡ paint INSTANTLY from the last-good data (no network wait — a cold serverless hub can take
    // seconds), then refresh from the server in the background and swap silently if anything changed.
    var c=dataCache();
    if(c){ renderApp({data:c,keepVer:true}).then(function(){refreshFromServer();}).catch(function(){renderApp().catch(function(){renderLogin();});}); }
    else renderApp().catch(function(){renderLogin();});
  }
  // colour the portal to the institution's brand (overrides the --brand CSS variable the UI is built on)
  function applyTheme(b){ try{ var hx=/^#([0-9a-fA-F]{6})$/; var r=document.documentElement.style; var p=(b&&String(b.primary||'').trim())||''; if(hx.test(p)){r.setProperty('--brand',p);r.setProperty('--brand-rgb',[parseInt(p.slice(1,3),16),parseInt(p.slice(3,5),16),parseInt(p.slice(5,7),16)].join(','));} if(b&&hx.test(String(b.accent||'').trim()))r.setProperty('--navy',b.accent.trim()); if(b&&b.login_bg)r.setProperty('--login-bg-img','url("'+String(b.login_bg).replace(/["\\)]/g,'')+'")'); if(b&&b.favicon){var fl=document.querySelector('link[rel=icon]');if(fl)fl.href=b.favicon;} }catch(_){} }
  // Boot IMMEDIATELY (theme/i18n from the cached branding), then refresh branding in the background.
  // The old flow gated the first paint on /api/branding — on a cold serverless host that call can
  // take 10+ seconds and the page sat BLANK. Now the splash is replaced instantly and the theme
  // simply re-applies when fresh branding lands.
  function applyBrand(b){
    applyTheme(b);
    /* 🌐 downloaded language packs: register the LANGUAGES first (so the code is known + RTL is right),
       then their strings, then the institution default — a device choice always wins. */
    try{ if(b&&b.i18n_langs){try{PI18N.addLangs(JSON.parse(b.i18n_langs));}catch(_){}} }catch(_){}
    try{ if(b&&b.i18n_custom){try{PI18N.merge(JSON.parse(b.i18n_custom));}catch(_){}} }catch(_){}
    try{ if(!PI18N.hasPref()&&b&&b.language)PI18N.use(b.language); }catch(_){}
  }
  try{ var cb=brandCache(); if(cb)applyBrand(cb); }catch(_){}
  boot();
  try{ fetchBranding(0).then(function(b){ if(b)applyBrand(b); }); }catch(_){}
})();
</script></body></html>`;

// ----------------------- installable app assets -----------------------
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="104" fill="#1e3a8a"/><text x="50%" y="55%" font-family="Segoe UI,Arial,sans-serif" font-size="220" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">UB</text></svg>`;
// ---- Public Online Admission portal (/apply) — self-contained mini-SPA, temporary-pass auth ----
const APPLY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apply for Admission</title>
<link rel="icon" href="/favicon">
<style>
:root{--navy:#0f1e3d;--blue:#1e3a8a;--ind:#4338ca;--line:#e2e8f0;--muted:#64748b;--bg:#f1f5f9}
*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',Roboto,Arial,sans-serif;background:var(--bg);color:#0f172a}
.top{background:linear-gradient(120deg,var(--navy),var(--blue));color:#fff;padding:12px 16px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:5}
.top img{height:34px;width:34px;border-radius:8px;object-fit:contain;background:#fff}
.top .t{font-weight:800;font-size:16px;line-height:1.1}.top .s{font-size:11px;opacity:.8}
.top .sp{flex:1}.top a.lk{color:#cde;font-size:13px;text-decoration:none;border:1px solid rgba(255,255,255,.3);padding:6px 10px;border-radius:8px}
.wrap{max-width:760px;margin:0 auto;padding:18px 14px 60px}
.screen{display:none}.screen.on{display:block;animation:fu .25s ease}@keyframes fu{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0;box-shadow:0 1px 3px rgba(15,23,42,.05)}
.hero{background:linear-gradient(120deg,var(--navy),var(--ind));color:#fff;border:none}
.hero h1{margin:0 0 6px;font-size:26px}.hero p{margin:0;opacity:.9;line-height:1.5}
h2{font-size:19px;margin:0 0 4px}h3{font-size:15px;margin:14px 0 6px}.muted{color:var(--muted);font-size:13px}
label{display:block;font-size:12px;font-weight:600;color:#334155;margin:10px 0 4px}
input,select,textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;background:#fff}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(30,58,138,.12)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:560px){.row{grid-template-columns:1fr}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--blue);color:#fff;border:none;padding:12px 18px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none}
.btn.alt{background:#fff;color:var(--blue);border:1.5px solid var(--blue)}.btn.gho{background:transparent;color:#334155;border:1px solid var(--line)}
.btn:disabled{opacity:.6;cursor:default}.btn.full{width:100%}
.btnrow{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.err{background:#fee2e2;color:#991b1b;border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0;display:none}
.ok{background:#dcfce7;color:#166534;border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0}
.fac{border:1px solid var(--line);border-radius:12px;margin:10px 0;overflow:hidden}
.fac>.h{padding:12px 14px;font-weight:700;background:#f8fafc;cursor:pointer;display:flex;justify-content:space-between}
.fac .deps{display:none;padding:6px 10px 12px}.fac.open .deps{display:block}
.dep{display:block;width:100%;text-align:left;background:#fff;border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:6px 0;cursor:pointer;font-size:14px}
.dep:hover{border-color:var(--blue);background:#f5f8ff}
.steps{display:flex;gap:6px;margin:6px 0 14px;flex-wrap:wrap}
.steps .st{flex:1;min-width:54px;text-align:center;font-size:11px;color:var(--muted);border-top:3px solid var(--line);padding-top:6px}
.steps .st.on{color:var(--blue);border-color:var(--blue);font-weight:700}.steps .st.done{color:#166534;border-color:#16a34a}
.passbox{background:#0f1e3d;color:#fff;border-radius:12px;padding:16px;text-align:center;margin:12px 0}
.passbox .k{font-size:12px;opacity:.8}.passbox .v{font-size:22px;font-weight:800;letter-spacing:1px;margin:4px 0 10px;user-select:all}
.olrow{display:grid;grid-template-columns:1fr 90px 34px;gap:8px;margin:6px 0}
.docs{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
.doc{border:1px solid var(--line);border-radius:10px;padding:8px;width:120px;text-align:center;font-size:11px;position:relative}
.doc img{width:100%;height:74px;object-fit:cover;border-radius:6px}.doc .del{position:absolute;top:-7px;right:-7px;background:#ef4444;color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer}
.pill{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}
.tl{margin:14px 0}.tl .i{display:flex;gap:10px;align-items:flex-start;margin:0 0 2px}
.tl .dot{width:22px;height:22px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:12px;background:#e2e8f0;color:#64748b}
.tl .i.done .dot{background:#16a34a;color:#fff}.tl .i.now .dot{background:var(--blue);color:#fff}
.tl .ln{font-size:13px;padding-top:2px}.tl .i .bar{width:2px;background:#e2e8f0;margin:0 10px;height:14px}
.kv{display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:7px 0;font-size:14px}
</style></head><body>
<div class="top"><img id="logo" src="/favicon" alt=""><div><div class="t" id="instName">University Admissions</div><div class="s">Online Application Portal</div></div><div class="sp"></div><a class="lk" href="#" onclick="goContinue();return false">Continue application</a></div>
<div class="wrap">

  <div class="screen on" id="s-landing">
    <div class="card hero"><h1>Apply for Admission</h1><p>Start your application online in minutes. Choose your programme, upload your documents and track your admission — all from here.</p>
      <div class="btnrow"><button class="btn" style="background:#fff;color:#1e3a8a" onclick="show('s-start')">Start New Application</button><button class="btn" style="background:transparent;border:1.5px solid #fff;color:#fff" onclick="goContinue()">Continue / Check Status</button></div></div>
    <div class="card"><h2>Choose a programme</h2><div class="muted">Browse our faculties and click the department you want to apply to.</div><div id="progs"></div></div>
    <div class="card" style="text-align:center"><div style="font-weight:800;margin-bottom:4px">🏛 Employer, university or government agency?</div><div class="muted" style="margin-bottom:8px">Confirm a certificate or transcript issued by this institution.</div><a href="/verify-credentials" style="display:inline-block;background:#15803d;color:#fff;padding:9px 16px;border-radius:9px;text-decoration:none;font-weight:700">🎓 Verify a Transcript or Certificate</a></div>
  </div>

  <div class="screen" id="s-start">
    <div class="card"><h2>Start your application</h2><div class="muted">We will give you a temporary application number and passcode to log back in.</div>
      <div class="err" id="startErr"></div>
      <div class="row"><div><label>First name</label><input id="f_first"></div><div><label>Last name</label><input id="f_last"></div></div>
      <div class="row"><div><label>Email</label><input id="f_email" type="email"></div><div><label>Phone</label><input id="f_phone"></div></div>
      <div id="f_campus_w" style="display:none"><label>🏫 Campus</label><select id="f_campus" onchange="onCampusChange()"></select></div>
      <label>Programme (department)</label><select id="f_dept"></select>
      <label>Entry level</label><select id="f_level"></select>
      <div class="btnrow"><button class="btn gho" onclick="show('s-landing')">Back</button><button class="btn" id="startBtn" onclick="startApp()">Create Application</button></div>
    </div>
  </div>

  <div class="screen" id="s-pass">
    <div class="card"><h2>Save your temporary pass</h2><div class="muted">Write these down. You will use them to log back in and check your admission status.</div>
      <div class="passbox"><div class="k">APPLICATION NUMBER</div><div class="v" id="pass_no"></div><div class="k">PASSCODE</div><div class="v" id="pass_code"></div></div>
      <div class="ok">A copy is shown here only — keep it safe.</div>
      <button class="btn full" onclick="openWizard()">Continue to application form</button>
    </div>
  </div>

  <div class="screen" id="s-continue">
    <div class="card"><h2>Continue your application</h2>
      <div class="err" id="contErr"></div>
      <label>Application number</label><input id="c_no" placeholder="e.g. WAUU/APP/2026/00001">
      <label>Passcode</label><input id="c_code">
      <div class="btnrow"><button class="btn gho" onclick="show('s-landing')">Back</button><button class="btn" id="contBtn" onclick="continueApp()">Continue</button></div>
    </div>
  </div>

  <div class="screen" id="s-wizard">
    <div class="steps" id="stepper"></div>
    <div class="err" id="wizErr"></div>
    <div class="card" id="wizBody"></div>
  </div>

  <div class="screen" id="s-status"><div id="statusBody"></div></div>

</div>
<script>
var TOKEN=localStorage.getItem('ubu_app_token')||'';
var APP=null, PROG={faculties:[],levels:[]}, STEP=1, OLEVEL=[];
var STEP_NAMES=['Personal','Programme','Academic','Documents','Review'];
function show(id){var els=document.querySelectorAll('.screen');for(var i=0;i<els.length;i++)els[i].classList.remove('on');document.getElementById(id).classList.add('on');window.scrollTo(0,0);}
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
async function api(path,opts){opts=opts||{};opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});if(TOKEN)opts.headers.Authorization='Bearer '+TOKEN;try{var r=await fetch(path,opts);return await r.json();}catch(e){return{ok:false,error:'Network error.'};}}
function err(id,msg){var e=el(id);if(!e)return;if(msg){e.textContent=msg;e.style.display='block';}else{e.style.display='none';}}

async function boot(){
  var b=await api('/api/branding');if(b&&b.name){el('instName').textContent=b.name+' — Admissions';if(b.logo)el('logo').src=b.logo;document.title='Apply — '+b.name;}
  var pr=await api('/api/apply/programmes');if(pr&&pr.ok){PROG=pr;renderProgs();fillSelects();if(pr.open===false){el('progs').innerHTML='<div class="err" style="display:block">Online admissions are currently closed. Please check back later.</div>';}}
  if(TOKEN){var me=await api('/api/apply/me');if(me&&me.ok){APP=me.application;if(APP.status&&APP.status!=='draft'){renderStatus();show('s-status');}else{openWizard();}}else{TOKEN='';localStorage.removeItem('ubu_app_token');}}
}
function renderProgs(){
  var w=el('progs');var h='';
  (PROG.faculties||[]).forEach(function(f,i){
    h+='<div class="fac" id="fac'+i+'"><div class="h" onclick="document.getElementById(\\'fac'+i+'\\').classList.toggle(\\'open\\')"><span>'+esc(f.name)+'</span><span>+</span></div><div class="deps">';
    f.departments.forEach(function(d){h+='<button class="dep" onclick="pickDept(\\''+d.id+'\\')">'+esc(d.name)+'</button>';});
    h+='</div></div>';
  });
  w.innerHTML=h||'<div class="muted">No programmes published yet.</div>';
}
function hasCampuses(){return PROG.campuses&&PROG.campuses.length;}
function deptOptions(campusId,selId){
  var ds='<option value="">Select a department…</option>';
  (PROG.faculties||[]).forEach(function(f){
    // show the chosen campus's programmes PLUS any faculty not yet assigned to a campus (so picking a
    // campus never hides everything on a partially-configured/legacy institution)
    if(campusId&&f.campus_id&&f.campus_id!==campusId)return;
    f.departments.forEach(function(d){ds+='<option value="'+d.id+'"'+(selId===d.id?' selected':'')+'>'+esc(d.name)+' ('+esc(f.name)+')</option>';});
  });
  return ds;
}
function campusOf(deptId){var c=null;(PROG.faculties||[]).forEach(function(f){f.departments.forEach(function(d){if(d.id===deptId)c=f.campus_id||'';});});return c;}
function fillSelects(){
  if(el('f_campus_w'))el('f_campus_w').style.display=hasCampuses()?'':'none';
  if(hasCampuses()){var cs='';PROG.campuses.forEach(function(c,i){cs+='<option value="'+c.id+'"'+(i===0?' selected':'')+'>'+esc(c.name)+'</option>';});el('f_campus').innerHTML=cs;}
  el('f_dept').innerHTML=deptOptions(hasCampuses()?el('f_campus').value:'');
  var ls='<option value="">Select…</option>';(PROG.levels||[]).forEach(function(l){ls+='<option value="'+l.id+'">'+esc(l.name)+'</option>';});
  el('f_level').innerHTML=ls;if(PROG.levels&&PROG.levels[0])el('f_level').value=PROG.levels[0].id;
}
function onCampusChange(){el('f_dept').innerHTML=deptOptions(el('f_campus').value);}
function onWizCampusChange(){el('w_dept').innerHTML=deptOptions(el('w_campus').value);}
function pickDept(id){
  show('s-start');
  if(hasCampuses()&&el('f_campus')){var c=campusOf(id);if(c!=null){el('f_campus').value=c;el('f_dept').innerHTML=deptOptions(c);}}
  el('f_dept').value=id;
}
function goContinue(){show('s-continue');}

async function startApp(){
  err('startErr','');
  var body={first_name:el('f_first').value.trim(),last_name:el('f_last').value.trim(),email:el('f_email').value.trim(),phone:el('f_phone').value.trim(),campus_id:(el('f_campus')?el('f_campus').value:''),department_id:el('f_dept').value,level_id:el('f_level').value};
  if(!body.first_name||!body.last_name){err('startErr','Enter your first and last name.');return;}
  el('startBtn').disabled=true;
  var r=await api('/api/apply/start',{method:'POST',body:JSON.stringify(body)});
  el('startBtn').disabled=false;
  if(!r.ok){err('startErr',r.error||'Could not start.');return;}
  TOKEN=r.token;localStorage.setItem('ubu_app_token',TOKEN);APP=r.application;
  el('pass_no').textContent=r.app_no;el('pass_code').textContent=r.passcode;show('s-pass');
}
async function continueApp(){
  err('contErr','');el('contBtn').disabled=true;
  var r=await api('/api/apply/login',{method:'POST',body:JSON.stringify({app_no:el('c_no').value.trim(),passcode:el('c_code').value.trim()})});
  el('contBtn').disabled=false;
  if(!r.ok){err('contErr',r.error||'Invalid details.');return;}
  TOKEN=r.token;localStorage.setItem('ubu_app_token',TOKEN);APP=r.application;
  if(APP.status&&APP.status!=='draft'){renderStatus();show('s-status');}else{openWizard();}
}
function openWizard(){STEP=APP&&APP.stage?Math.min(5,Math.max(1,APP.stage)):1;try{OLEVEL=APP&&APP.olevel?JSON.parse(APP.olevel):[];}catch(e){OLEVEL=[];}if(!OLEVEL.length)OLEVEL=[{exam:'',year:'',subjects:[{subject:'',grade:''}]}];renderWizard();show('s-wizard');}

function val(k){return APP&&APP[k]!=null?APP[k]:'';}
function renderStepper(){var h='';for(var i=1;i<=5;i++){h+='<div class="st '+(i===STEP?'on':(i<STEP?'done':''))+'">'+i+'. '+STEP_NAMES[i-1]+'</div>';}el('stepper').innerHTML=h;}
function renderWizard(){
  renderStepper();err('wizErr','');var b=el('wizBody');
  if(STEP===1){
    b.innerHTML='<h2>Personal details</h2>'+
      '<div class="row"><div><label>First name</label><input id="w_first" value="'+esc(val('first_name'))+'"></div><div><label>Last name</label><input id="w_last" value="'+esc(val('last_name'))+'"></div></div>'+
      '<div class="row"><div><label>Middle name</label><input id="w_middle" value="'+esc(val('middle_name'))+'"></div><div><label>Gender</label><select id="w_gender"><option value="">Select…</option><option'+(val('gender')==='male'?' selected':'')+'>male</option><option'+(val('gender')==='female'?' selected':'')+'>female</option></select></div></div>'+
      '<div class="row"><div><label>Date of birth</label><input id="w_dob" type="date" value="'+esc(val('date_of_birth'))+'"></div><div><label>Phone</label><input id="w_phone" value="'+esc(val('phone'))+'"></div></div>'+
      '<div class="row"><div><label>Nationality</label><input id="w_nat" value="'+esc(val('nationality'))+'"></div><div><label>State of origin</label><input id="w_state" value="'+esc(val('state_of_origin'))+'"></div></div>'+
      '<label>Home address</label><textarea id="w_addr" rows="2">'+esc(val('address'))+'</textarea>'+
      '<h3>Parent / Guardian</h3><div class="row"><div><label>Name</label><input id="w_gname" value="'+esc(val('guardian_name'))+'"></div><div><label>Relationship</label><input id="w_grel" value="'+esc(val('guardian_relation'))+'"></div></div>'+
      '<div class="row"><div><label>Guardian phone</label><input id="w_gphone" value="'+esc(val('guardian_phone'))+'"></div><div><label>Guardian email</label><input id="w_gemail" value="'+esc(val('guardian_email'))+'"></div></div>'+
      navBtns();
  }else if(STEP===2){
    var curC=hasCampuses()?(val('campus_id')||PROG.campuses[0].id):'';
    var ds=deptOptions(curC,val('department_id'));
    var ls='<option value="">Select…</option>';(PROG.levels||[]).forEach(function(l){ls+='<option value="'+l.id+'"'+(val('level_id')===l.id?' selected':'')+'>'+esc(l.name)+'</option>';});
    var cw='';
    if(hasCampuses()){var cs='';PROG.campuses.forEach(function(c){cs+='<option value="'+c.id+'"'+(curC===c.id?' selected':'')+'>'+esc(c.name)+'</option>';});cw='<label>🏫 Campus</label><select id="w_campus" onchange="onWizCampusChange()">'+cs+'</select>';}
    b.innerHTML='<h2>Programme</h2>'+cw+'<label>Department / Programme</label><select id="w_dept">'+ds+'</select><label>Entry level</label><select id="w_level">'+ls+'</select><label>Email</label><input id="w_email" type="email" value="'+esc(val('email'))+'">'+navBtns();
  }else if(STEP===3){
    b.innerHTML='<h2>Academic background</h2><div class="row"><div><label>JAMB reg. no</label><input id="w_jamb" value="'+esc(val('jamb_no'))+'"></div><div><label>JAMB score</label><input id="w_jscore" type="number" value="'+esc(val('jamb_score'))+'"></div></div>'+
      '<label>Previous school attended</label><input id="w_school" value="'+esc(val('prev_school'))+'">'+
      '<h3>O\\'Level result</h3><div class="row"><div><label>Exam (e.g. WAEC)</label><input id="w_oexam" value="'+esc(OLEVEL[0].exam||'')+'"></div><div><label>Year</label><input id="w_oyear" value="'+esc(OLEVEL[0].year||'')+'"></div></div>'+
      '<div id="olrows"></div><button class="btn gho" type="button" onclick="addOl()">+ Add subject</button>'+navBtns();
    renderOl();
  }else if(STEP===4){
    b.innerHTML='<h2>Documents</h2><div class="muted">Upload clear scans or photos (JPG/PNG/PDF, ~6MB max).</div>'+
      docUploader('Passport photograph','photo')+docUploader('O\\'Level result','olevel')+docUploader('Birth certificate / age declaration','birth_cert')+docUploader('Other supporting document','other')+
      '<div class="docs" id="docList"></div>'+navBtns();
    renderDocs();
  }else{
    var d=APP||{};
    b.innerHTML='<h2>Review &amp; submit</h2><div class="muted">Confirm your details, then submit your application for review.</div>'+
      kv('Name',esc((d.first_name||'')+' '+(d.last_name||'')))+kv('Email',esc(d.email))+kv('Phone',esc(d.phone))+(d.campus_name?kv('Campus',esc(d.campus_name)):'')+kv('Programme',esc(d.department_name||'—'))+kv('Level',esc(d.level_name||'—'))+kv('JAMB',esc(d.jamb_no||'—'))+kv('Documents',(d.documents||[]).length+' uploaded')+
      '<div class="btnrow"><button class="btn gho" onclick="STEP=4;renderWizard()">Back</button><button class="btn" id="subBtn" onclick="submitApp()">Submit Application</button></div>';
  }
}
function navBtns(){return '<div class="btnrow">'+(STEP>1?'<button class="btn gho" onclick="prevStep()">Back</button>':'')+'<button class="btn" onclick="nextStep()">Save &amp; Continue</button></div>';}
function kv(k,v){return '<div class="kv"><span class="muted">'+k+'</span><b>'+v+'</b></div>';}
function docUploader(label,kind){return '<label>'+label+'</label><input type="file" accept="image/*,application/pdf" onchange="uploadDoc(\\''+kind+'\\',this)">';}
function renderOl(){var w=el('olrows');var subs=OLEVEL[0].subjects||[];var h='';subs.forEach(function(s,i){h+='<div class="olrow"><input placeholder="Subject" value="'+esc(s.subject)+'" oninput="OLEVEL[0].subjects['+i+'].subject=this.value"><select onchange="OLEVEL[0].subjects['+i+'].grade=this.value">'+['','A1','B2','B3','C4','C5','C6','D7','E8','F9'].map(function(g){return '<option'+(s.grade===g?' selected':'')+'>'+g+'</option>';}).join('')+'</select><button class="btn gho" type="button" onclick="delOl('+i+')">×</button></div>';});w.innerHTML=h;}
function addOl(){OLEVEL[0].subjects.push({subject:'',grade:''});renderOl();}
function delOl(i){OLEVEL[0].subjects.splice(i,1);if(!OLEVEL[0].subjects.length)OLEVEL[0].subjects.push({subject:'',grade:''});renderOl();}
function renderDocs(){var w=el('docList');if(!w)return;var ds=(APP&&APP.documents)||[];w.innerHTML=ds.map(function(d){return '<div class="doc"><div style="font-size:30px">📄</div><div>'+esc(d.kind)+'</div><button class="del" onclick="delDoc(\\''+d.id+'\\')">×</button></div>';}).join('')||'<div class="muted">No documents yet.</div>';}

function collectStep(){
  var patch={stage:STEP};
  if(STEP===1){patch.first_name=el('w_first').value.trim();patch.last_name=el('w_last').value.trim();patch.middle_name=el('w_middle').value.trim();patch.gender=el('w_gender').value;patch.date_of_birth=el('w_dob').value;patch.phone=el('w_phone').value.trim();patch.nationality=el('w_nat').value.trim();patch.state_of_origin=el('w_state').value.trim();patch.address=el('w_addr').value.trim();patch.guardian_name=el('w_gname').value.trim();patch.guardian_relation=el('w_grel').value.trim();patch.guardian_phone=el('w_gphone').value.trim();patch.guardian_email=el('w_gemail').value.trim();}
  else if(STEP===2){if(el('w_campus'))patch.campus_id=el('w_campus').value;patch.department_id=el('w_dept').value;patch.level_id=el('w_level').value;patch.email=el('w_email').value.trim();}
  else if(STEP===3){patch.jamb_no=el('w_jamb').value.trim();patch.jamb_score=el('w_jscore').value;patch.prev_school=el('w_school').value.trim();OLEVEL[0].exam=el('w_oexam').value.trim();OLEVEL[0].year=el('w_oyear').value.trim();patch.olevel=JSON.stringify(OLEVEL);}
  return patch;
}
async function saveStep(){var r=await api('/api/apply/save',{method:'POST',body:JSON.stringify(collectStep())});if(r&&r.ok){APP=r.application;return true;}err('wizErr',(r&&r.error)||'Could not save.');return false;}
async function nextStep(){if(STEP<=3){if(!await saveStep())return;}if(STEP<5){STEP++;renderWizard();}else{submitApp();}}
async function prevStep(){if(STEP<=3)await saveStep();if(STEP>1){STEP--;renderWizard();}}
async function uploadDoc(kind,input){
  var f=input.files&&input.files[0];if(!f)return;err('wizErr','');
  if(f.size>6*1024*1024){err('wizErr','That file is larger than 6MB.');return;}
  var rd=new FileReader();rd.onload=async function(){var r=await api('/api/apply/doc',{method:'POST',body:JSON.stringify({kind:kind,filename:f.name,content:rd.result})});if(r&&r.ok){APP=r.application;renderDocs();}else{err('wizErr',(r&&r.error)||'Upload failed.');}};rd.readAsDataURL(f);
}
async function delDoc(id){var r=await api('/api/apply/doc/delete',{method:'POST',body:JSON.stringify({id:id})});if(r&&r.ok){APP=r.application;renderDocs();}}
async function submitApp(){if(STEP===5){/* nothing extra to collect */}var sb=el('subBtn');if(sb)sb.disabled=true;var r=await api('/api/apply/submit',{method:'POST',body:JSON.stringify({})});if(sb)sb.disabled=false;if(!r.ok){err('wizErr',r.error||'Could not submit.');return;}APP=r.application;renderStatus();show('s-status');}

function statusPill(s){var m={submitted:['#dbeafe','#1e40af','Submitted — under review'],under_review:['#fef3c7','#92400e','Under review'],offered:['#ede9fe','#5b21b6','Offer made — pay to accept'],fee_paid:['#dcfce7','#166534','Fee paid'],admitted:['#dcfce7','#166534','Admitted 🎉'],rejected:['#fee2e2','#991b1b','Not successful'],withdrawn:['#f1f5f9','#475569','Withdrawn']};var c=m[s]||['#f1f5f9','#475569',s];return '<span class="pill" style="background:'+c[0]+';color:'+c[1]+'">'+c[2]+'</span>';}
function tlItem(label,done,now){return '<div class="i '+(done?'done':(now?'now':''))+'"><div class="dot">'+(done?'✓':'')+'</div><div class="ln">'+label+'</div></div>';}
function renderStatus(){
  var d=APP||{};var st=d.status;
  var order=['submitted','under_review','offered','fee_paid','admitted'];var idx=order.indexOf(st);if(st==='accepted')idx=2;
  var tl='<div class="tl">'+tlItem('Application submitted',idx>=0,idx===0)+tlItem('Under review',idx>=1,idx===1)+tlItem('Offer of admission',idx>=2,idx===2)+tlItem('Admission fee paid',idx>=3||d.admission_fee_paid,idx===3)+tlItem('Admitted',idx>=4,idx===4)+'</div>';
  var pay='';
  if((st==='offered'||st==='accepted')&&!d.admission_fee_paid&&Number(d.admission_fee_amount)>0){
    pay='<div class="card"><h3>Accept your offer — pay the admission fee</h3><div class="kv"><span class="muted">Admission fee</span><b>'+esc(d.admission_fee_currency||'NGN')+' '+Number(d.admission_fee_amount).toLocaleString()+'</b></div><div class="err" id="payErr"></div><div id="payArea"><button class="btn full" id="payBtn" onclick="pay()">Pay admission fee</button></div></div>';
  }
  if(d.admission_fee_paid&&st!=='admitted'){pay='<div class="ok">Your admission fee has been received. Your admission is being finalized — watch your email.</div>';}
  if(st==='admitted'){pay='<div class="card"><h3>Congratulations! 🎓</h3><div class="muted">You have been admitted. Your official admission letter and student portal login have been emailed to you. Sign in to the student portal to continue your registration.</div><a class="btn full" href="/" style="margin-top:10px">Go to student portal</a></div>';}
  if(st==='rejected'){pay='<div class="card"><div class="muted">'+(d.decision_note?esc(d.decision_note):'We are unable to offer you admission at this time.')+'</div></div>';}
  el('statusBody').innerHTML='<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">'+esc((d.first_name||'')+' '+(d.last_name||''))+'</h2>'+statusPill(st)+'</div><div class="muted">Application '+esc(d.app_no||'')+' • '+esc(d.department_name||'')+'</div>'+tl+'</div>'+pay+'<div class="btnrow"><button class="btn gho" onclick="logoutApp()">Sign out</button></div>';
}
async function pay(){
  err('payErr','');
  var pr;try{pr=await api('/api/pay/providers?currency='+encodeURIComponent((d&&d.admission_fee_currency)||''));}catch(e){pr=null;}
  var providers=(pr&&pr.providers)||[];
  if(providers.length>1){
    // more than one gateway configured → let the applicant choose which platform to pay with
    el('payArea').innerHTML='<div style="font-size:13px;color:#64748b;margin-bottom:6px">Choose a payment method</div>'
      +providers.map(function(p,i){return '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:8px;cursor:pointer"><input type="radio" name="apayprov" value="'+esc(p.id)+'"'+(i===0?' checked':'')+'><span style="font-weight:600">'+esc(p.label)+'</span></label>';}).join('')
      +'<button class="btn full" id="payBtn2" onclick="payGo()">Continue to payment</button>';
    return;
  }
  await payGo();
}
async function payGo(){
  err('payErr','');var pb=el('payBtn2')||el('payBtn');if(pb)pb.disabled=true;
  var sel=document.querySelector('input[name=apayprov]:checked');
  var provider=sel?sel.value:'';
  var r=await api('/api/apply/pay',{method:'POST',body:JSON.stringify({provider:provider})});
  if(pb)pb.disabled=false;
  if(!r.ok){err('payErr',r.error||'Could not start payment.');return;}
  if(r.authorization_url){location.href=r.authorization_url;return;}
  el('payArea').innerHTML='<div class="ok" style="text-align:left">Pay the admission fee by bank transfer:<br><b>'+esc(r.bank)+'</b></div><label>Payment reference / teller number</label><input id="payRef" placeholder="Enter your transfer reference"><button class="btn full" style="margin-top:8px" onclick="declarePay()">I have paid — notify the Bursary</button>';
}
async function declarePay(){var ref=(el('payRef')&&el('payRef').value.trim())||'';var r=await api('/api/apply/pay/declare',{method:'POST',body:JSON.stringify({ref:ref})});if(r&&r.ok){APP=r.application;el('payArea').innerHTML='<div class="ok">Thank you. Your payment has been recorded and will be confirmed by the Bursary. You will be admitted once confirmed.</div>';}}
function logoutApp(){TOKEN='';localStorage.removeItem('ubu_app_token');APP=null;show('s-landing');}
boot();
</script></body></html>`;

const MANIFEST_PORTAL = JSON.stringify({ name: 'UniBursar Portal', short_name: 'Portal', start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#0f1e3d', theme_color: '#1e3a8a', icons: [{ src: '/favicon', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }] });
const MANIFEST_SCAN = JSON.stringify({ name: 'UniBursar Clearance Scanner', short_name: 'Scanner', start_url: '/scan', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#0f1e3d', theme_color: '#0f1e3d', icons: [{ src: '/favicon', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }] });
const SW_JS = `const C='ubu-portal-v2';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/scan','/verify','/icon.svg']).catch(()=>{})).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(Promise.all([caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))),self.clients.claim()]));});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))));});`;

// shared client renderer for verification results (used by /scan and /verify)
const RESULT_JS = `
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(m){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m];});}
function office(o){return ({registrar:'Registrar',dean:'Dean / Faculty Head',student_affairs:'Student Affairs'})[o]||o;}
function row(k,v){return '<tr><td>'+k+'</td><td>'+esc(v||'—')+'</td></tr>';}
function extractId(raw){raw=String(raw||'').trim();var m=/[?&]c=([^&\\s]+)/.exec(raw);if(m)return decodeURIComponent(m[1]);return raw.replace(/^UBU-CLR:/i,'').trim();}
function extractCode(raw){raw=String(raw||'').trim();var m=/[?&]res=([^&\\s]+)/.exec(raw);if(m)return{type:'res',id:decodeURIComponent(m[1])};if(/^UBU-TRX:/i.test(raw))return{type:'res',id:raw.replace(/^UBU-TRX:/i,'').trim()};m=/[?&]r=([^&\\s]+)/.exec(raw);if(m)return{type:'r',id:decodeURIComponent(m[1])};if(/^UBU-RCT:/i.test(raw))return{type:'r',id:raw.replace(/^UBU-RCT:/i,'').trim()};m=/[?&]p=([^&\\s]+)/.exec(raw);if(m)return{type:'p',id:decodeURIComponent(m[1])};m=/[?&]c=([^&\\s]+)/.exec(raw);if(m)return{type:'c',id:decodeURIComponent(m[1])};return{type:'c',id:raw.replace(/^UBU-CLR:/i,'').trim()};}
function renderResult(el,d){
  if(!d||!d.valid){el.innerHTML='<div class="rcard invalid"><div class="big">✗ INVALID</div><p>This code does not match any record on file. The document may be forged, altered, or not yet issued.</p><button class="btn" onclick="resetView&&resetView()">Check another</button></div>';return;}
  if(d.kind==='receipt'){var rs=d.student;
    el.innerHTML='<div class="rcard valid">'+
     '<div class="big">✓ GENUINE RECEIPT</div>'+
     '<div class="who">'+(rs.photo?'<img src="'+rs.photo+'" alt="photo">':'<div class="ph">🧾</div>')+'<div><div class="nm">'+esc(rs.name)+'</div><div class="mt">'+esc(rs.matric)+'</div></div></div>'+
     '<table>'+row('Receipt No',d.receipt_no)+row('Amount paid',d.amountText)+row('Paid for',d.category)+row('Narration',d.narration)+row('Method',d.method)+row('Date',d.dateText)+row('Issued by',d.office)+row('Received by',d.receivedBy)+row('Faculty',rs.faculty)+row('Department',rs.department)+row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  if(d.kind==='payslip'){var ps=d.staff;
    el.innerHTML='<div class="rcard valid">'+
     '<div class="big">✓ GENUINE PAYSLIP</div>'+
     '<div class="who">'+(ps.photo?'<img src="'+ps.photo+'" alt="photo">':'<div class="ph">💼</div>')+'<div><div class="nm">'+esc(ps.name)+'</div><div class="mt">'+esc(ps.staffNo)+'</div></div></div>'+
     '<table>'+row('Type',d.staffType)+row('Department',ps.department)+row('Pay period',d.period)+row('Net pay',d.net)+row('Gross',d.gross)+row('Pay date',d.dateText)+row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  if(d.kind==='student'){var su=d.student;var act=String(su.status||'').toLowerCase()==='active';
    el.innerHTML='<div class="rcard '+(act?'valid':'warn')+'">'+
     '<div class="big">'+(act?'✓ GENUINE STUDENT':'⚠ '+String(su.status||'INACTIVE').toUpperCase())+'</div>'+
     '<div class="who">'+(su.photo?'<img src="'+su.photo+'" alt="photo">':'<div class="ph">🎓</div>')+'<div><div class="nm">'+esc(su.name)+'</div><div class="mt">'+esc(su.matric)+'</div></div></div>'+
     '<table>'+row('Faculty',su.faculty)+row('Department',su.department)+row('Level',su.level)+row('Student status',su.status)+(d.session?row('Session',d.session):'')+row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  if(d.kind==='result'){var rs=d.student;var grad=!!d.graduated;
    el.innerHTML='<div class="rcard valid">'+
     '<div class="big">'+(grad?'🎓 GENUINE GRADUATE':'✓ GENUINE RESULT')+'</div>'+
     '<div class="who">'+(rs.photo?'<img src="'+rs.photo+'" alt="photo">':'<div class="ph">🎓</div>')+'<div><div class="nm">'+esc(rs.name)+'</div><div class="mt">'+esc(rs.matric)+'</div></div></div>'+
     '<table>'+row('Faculty',rs.faculty)+row('Department',rs.department)+row('Level',rs.level)+(d.session?row('Session',d.session):'')+(d.semester?row('Semester',d.semester):'')+row('Courses',String(d.courses))+row('GPA',String(d.gpa))+row('CGPA',String(d.cgpa))+row('Class standing',d.standing)+
       (grad?(row('Graduation status','Graduated')+(d.classification?row('Class of degree',d.classification):'')+(d.graduationSession?row('Graduation session',d.graduationSession):'')):'')+
       row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  var s=d.student;var ok=d.completed;var tn=d.typeName||'Examination';var mid=d.clearanceType==='midterm';
  el.innerHTML='<div class="rcard '+(ok?'valid':'warn')+'">'+
   '<div class="big">'+(ok?'✓ CLEARED — '+tn.toUpperCase():'⚠ '+String(d.status||'NOT COMPLETE').toUpperCase())+'</div>'+
   '<div class="who">'+(s.photo?'<img src="'+s.photo+'" alt="photo">':'<div class="ph">🎓</div>')+'<div><div class="nm">'+esc(s.name)+'</div><div class="mt">'+esc(s.matric)+'</div></div></div>'+
   '<table>'+row('Clearance type',tn+' Clearance')+row('Faculty',s.faculty)+row('Department',s.department)+row('Level',s.level)+row('Gender',s.gender)+row('Student status',s.status)+row('Session',d.session)+row('Semester',d.semester)+row('Verification ref',d.ref)+'</table>'+
   '<div class="apps">'+(d.approvals||[]).map(function(a){return '<span class="ap '+(a.status==='approved'?'a':(a.status==='denied'?'x':'p'))+'">'+office(a.office)+': '+a.status+(a.by?(' ('+esc(a.by)+')'):'')+'</span>';}).join('')+'</div>'+
   (ok?'':'<p class="note">Not all offices have approved. Do NOT admit this student to the '+(mid?'mid-semester test':'examination')+'.</p>')+
   '<button class="btn" onclick="resetView&&resetView()">Scan another</button></div>';
}
async function doVerify(el,code){var q=(code&&code.type)?code.type:'c';var id=(code&&code.id!=null)?code.id:code;el.innerHTML='<div class="rcard"><div class="big">Checking…</div></div>';try{var r=await fetch('/api/verify?'+q+'='+encodeURIComponent(id));var d=await r.json();renderResult(el,d);}catch(e){renderResult(el,{valid:false});}}`;

const RESULT_CSS = `
.rcard{background:#fff;border-radius:16px;padding:18px;margin:14px;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.rcard .big{font-size:24px;font-weight:900;text-align:center;padding:8px;border-radius:10px;margin-bottom:12px}
.rcard.valid .big{background:#dcfce7;color:#166534}.rcard.invalid .big{background:#fee2e2;color:#991b1b}.rcard.warn .big{background:#fef9c3;color:#854d0e}
.who{display:flex;gap:14px;align-items:center;margin-bottom:12px}
.who img{width:90px;height:104px;object-fit:cover;border-radius:10px;border:2px solid #1e3a8a}
.who .ph{width:90px;height:104px;border-radius:10px;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:34px}
.who .nm{font-size:20px;font-weight:800}.who .mt{color:#64748b;font-family:monospace;font-weight:700}
.rcard table{width:100%;border-collapse:collapse}.rcard td{padding:7px 4px;border-bottom:1px solid #eef2f7;font-size:14px}
.rcard td:first-child{color:#64748b;width:42%}.rcard td:last-child{font-weight:600}
.apps{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.ap{font-size:11px;font-weight:700;border-radius:999px;padding:4px 10px}.ap.a{background:#dcfce7;color:#166534}.ap.x{background:#fee2e2;color:#991b1b}.ap.p{background:#fff7ed;color:#9a6300}
.note{color:#991b1b;font-weight:700;margin:10px 0}
.btn{display:block;width:100%;margin-top:14px;background:linear-gradient(135deg,#2563eb,#4338ca);color:#fff;border:0;border-radius:10px;padding:13px;font-weight:800;font-size:15px;cursor:pointer}`;

const SCAN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Clearance Scanner</title><link rel="manifest" href="/scan-manifest.webmanifest"><meta name="theme-color" content="#0f1e3d"><link rel="icon" href="/favicon">
<style>*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:#0f1e3d;color:#fff;min-height:100vh}
.bar{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#0b1730;font-size:15px}
.bar #st{font-size:12px;opacity:.85}
.stage{padding:8px}
video{width:100%;max-width:520px;display:block;margin:0 auto;border-radius:14px;background:#000;aspect-ratio:1/1;object-fit:cover}
.controls{display:flex;gap:10px;justify-content:center;margin:12px}
.controls .b{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:800;font-size:15px;cursor:pointer}
.controls .b.ghost{background:#1b2c4d}
.manual{display:flex;gap:8px;max-width:520px;margin:0 auto 6px;padding:0 12px}
.manual input{flex:1;padding:12px;border-radius:10px;border:0;font-size:14px}
.manual .b{background:#1b2c4d;color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:700}
.hint{max-width:520px;margin:6px auto;padding:0 16px;font-size:12.5px;opacity:.8;text-align:center}
#result{max-width:520px;margin:0 auto;color:#0f172a}
${RESULT_CSS}
</style></head><body>
<div class="bar"><b>🛡 Clearance Scanner</b><span id="st">Ready</span></div>
<div class="stage"><video id="v" playsinline muted></video></div>
<div class="controls"><button class="b" id="start">▶ Start camera</button><button class="b ghost" id="stop" style="display:none">■ Stop</button></div>
<div class="manual"><input id="code" placeholder="Or paste the code / link from the certificate" autocomplete="off"><button class="b" id="lk">Verify</button></div>
<div class="hint" id="hint">Point the camera at the QR code on the clearance certificate. The student's photo and details will appear so you can confirm them in person.</div>
<div id="result"></div>
<script>
${RESULT_JS}
var $=function(id){return document.getElementById(id);};
var stream=null,scanning=false,det=null,raf=null;
function setStatus(t){$('st').textContent=t;}
function resetView(){$('result').innerHTML='';setStatus('Ready');}
async function startCam(){
  try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});var v=$('v');v.srcObject=stream;await v.play();$('start').style.display='none';$('stop').style.display='';setStatus('Scanning…');loop();}
  catch(e){setStatus('No camera');$('hint').textContent='Could not open the camera ('+e.message+'). Tip: scan the QR with your phone\\'s built-in camera — it opens the verification page directly — or paste the code below.';}
}
function stopCam(){scanning=false;if(raf)cancelAnimationFrame(raf);if(stream){stream.getTracks().forEach(function(t){t.stop();});stream=null;}$('start').style.display='';$('stop').style.display='none';}
async function loop(){
  if(!stream)return;scanning=true;
  if('BarcodeDetector' in window){
    if(!det)det=new BarcodeDetector({formats:['qr_code']});
    var v=$('v');
    var tick=async function(){if(!scanning)return;try{var codes=await det.detect(v);if(codes&&codes.length){onCode(codes[0].rawValue);return;}}catch(_){}raf=requestAnimationFrame(tick);};
    tick();
  } else {
    $('hint').textContent='In-app scanning is not supported by this browser. Scan the QR with your phone camera (it opens the verification page automatically), or paste the code below.';
    setStatus('Manual mode');
  }
}
function onCode(raw){stopCam();setStatus('Found code');doVerify($('result'),extractCode(raw));}
$('start').onclick=startCam;$('stop').onclick=stopCam;
$('lk').onclick=function(){doVerify($('result'),extractCode($('code').value));};
$('code').addEventListener('keydown',function(e){if(e.key==='Enter')doVerify($('result'),extractCode($('code').value));});
if('serviceWorker' in navigator)navigator.serviceWorker.register((window.__B||'')+'/sw.js').catch(function(){});
</script></body></html>`;

// 🔎 external CREDENTIAL verification — universities, government agencies and employers confirm a
// transcript/certificate is genuine and (optionally) receive a STUDENT COPY by e-mail.
const VERIFY_CREDENTIALS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify Transcript &amp; Certificate</title><link rel="icon" href="/favicon"><meta name="theme-color" content="#0f1e3d">
<style>*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:linear-gradient(180deg,#eef2f8,#e2e8f0);color:#0f172a;min-height:100vh}
.wrap{max-width:720px;margin:0 auto;padding:0 16px 40px}
.bar{background:#0f1e3d;color:#fff;padding:16px;font-weight:800;font-size:16px;text-align:center;letter-spacing:.3px}
.bar small{display:block;font-weight:500;opacity:.8;font-size:12px;margin-top:2px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 8px 30px rgba(15,23,42,.07);padding:20px;margin-top:18px}
h2{margin:0 0 4px;font-size:17px}.sub{color:#64748b;font-size:13px;margin-bottom:14px}
label{display:block;font-size:12.5px;font-weight:600;color:#334155;margin:10px 0 4px}
input,select{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px;background:#fff}
.row{display:flex;gap:10px}.row>div{flex:1}
.btn{width:100%;margin-top:16px;background:#1e3a8a;color:#fff;border:0;border-radius:11px;padding:13px;font-weight:800;font-size:15px;cursor:pointer}
.btn:disabled{opacity:.6;cursor:default}
.btn.g{background:#065f46}.btn.ghost{background:#fff;color:#1e3a8a;border:1.5px solid #1e3a8a}
.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:10px;padding:11px 13px;font-size:13px;margin-top:12px}
.ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:10px;padding:11px 13px;font-size:13px;margin-top:12px}
.stu{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
.photo{width:112px;height:130px;object-fit:cover;border-radius:12px;border:3px solid #dbeafe;background:#f1f5f9;flex:none;box-shadow:0 2px 8px rgba(15,23,42,.08)}
.photo.ph{display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:38px}
.stu .who{flex:1;min-width:220px}
.stu .who .nm{font-size:22px;font-weight:900;color:#0f1e3d;line-height:1.15;letter-spacing:.2px}
.stu .who .mt{font-family:ui-monospace,Consolas,monospace;font-size:14px;font-weight:700;color:#1e3a8a;margin-top:3px;letter-spacing:.5px}
.stu .who .prg{font-size:13.5px;color:#334155;margin-top:5px}
.badges{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 18px}
.f{padding:7px 0;border-bottom:1px solid #f1f5f9}
.f span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;font-weight:700}
.f b{font-size:14px;color:#0f172a}
.sect{margin-top:18px}
.sect .st{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#1e3a8a;font-weight:800;margin-bottom:2px;display:flex;align-items:center;gap:7px}
.sect .st::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,#dbeafe,transparent)}
.badge{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:999px;font-weight:800;font-size:12px}
.badge.grad{background:#dcfce7;color:#166534}.badge.act{background:#fef9c3;color:#854d0e}
.badge.cls{background:#ede9fe;color:#5b21b6}.badge.reg{background:#e0f2fe;color:#075985}
.hr{height:1px;background:#e2e8f0;margin:18px 0}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:10px}
.metric{background:linear-gradient(160deg,#f8fafc,#eff4fb);border:1px solid #e5edf7;border-radius:14px;padding:14px 12px;text-align:center}
.metric .v{font-size:24px;font-weight:900;color:#1e3a8a;line-height:1.1}
.metric .v.sm{font-size:15px;line-height:1.25}
.metric .l{font-size:10.5px;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-top:4px;font-weight:600}
.note{background:#f8fafc;border:1px dashed #cbd5e1;border-radius:12px;padding:12px 14px;font-size:12.5px;color:#475569;margin-top:10px;line-height:1.55}
.docs{display:grid;gap:8px;margin:10px 0 2px}
.doc{display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid #e5edf7;border-radius:11px;background:#fbfdff}
.doc.off{opacity:.62;background:#f8fafc}
.doc input{width:17px;height:17px;flex:none;accent-color:#065f46;cursor:pointer}
.doc .di{flex:1}
.doc .di .dl{font-size:13.5px;font-weight:700;color:#0f172a}
.doc .di .ds{font-size:11px;color:#94a3b8}
.doc .chip{font-size:10px;font-weight:800;padding:3px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.3px}
.doc .chip.on{background:#dcfce7;color:#166534}.doc .chip.no{background:#f1f5f9;color:#94a3b8}
.doc .meta{font-size:10.5px;color:#64748b;margin-top:3px;line-height:1.5}
.doc .meta code{font-family:ui-monospace,Consolas,monospace;background:#f1f5f9;padding:1px 5px;border-radius:5px;color:#334155;letter-spacing:.4px;font-size:10px}
.consent{display:flex;gap:9px;align-items:flex-start;font-weight:500;font-size:12.5px;color:#334155;margin-top:12px;line-height:1.45;cursor:pointer}
.consent input{width:17px;height:17px;flex:none;margin-top:1px;accent-color:#1e3a8a;cursor:pointer}
.fpbox{border:1px solid #e5edf7;border-radius:11px;padding:13px;margin-top:12px}
.fpbox.good{background:#ecfdf5;border-color:#a7f3d0}.fpbox.bad{background:#fef2f2;border-color:#fecaca}
.fpbox.warn{background:#fffbeb;border-color:#fde68a}
.fpbox .ttl{font-weight:800;font-size:15px}.fpbox.good .ttl{color:#065f46}.fpbox.bad .ttl{color:#991b1b}.fpbox.warn .ttl{color:#92400e}
.fpbox .bd{font-size:12.5px;margin-top:4px;line-height:1.55}.fpbox.good .bd{color:#065f46}.fpbox.bad .bd{color:#991b1b}.fpbox.warn .bd{color:#92400e}
.badge.code{background:#dbeafe;color:#1e40af}.badge.new{background:#fef3c7;color:#92400e}
.fp{font-family:ui-monospace,Consolas,monospace;font-size:13px;letter-spacing:1px;color:#0f172a;background:#fff;border:1px dashed #cbd5e1;border-radius:8px;padding:7px 10px;margin-top:7px;word-break:break-all}
.contact{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;font-size:13px;line-height:1.7;margin-top:12px}
.instrow{display:flex;align-items:center;gap:11px;padding-bottom:14px;margin-bottom:16px;border-bottom:2px solid #eef2f8}
.instrow img{width:46px;height:46px;object-fit:contain;border-radius:8px}
.instrow .il{width:46px;height:46px;border-radius:10px;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px}
.instrow .it{font-size:15px;font-weight:800;color:#0f1e3d;line-height:1.2}
.instrow .is{font-size:11px;color:#64748b}
.reftag{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:16px;padding-top:12px;border-top:1px dashed #cbd5e1;font-size:11.5px;color:#64748b}
.reftag b{color:#334155;font-family:ui-monospace,Consolas,monospace;letter-spacing:.5px}
.foot{text-align:center;color:#94a3b8;font-size:11.5px;margin-top:18px}
@media print{body{background:#fff}.bar,#formcard,#checkcard,.foot,#copy,#doclist,.pbar{display:none!important}.card{box-shadow:none;border:1px solid #cbd5e1}}
@media(max-width:520px){.grid{grid-template-columns:1fr}.metrics{grid-template-columns:1fr}}
</style></head><body>
<div class="bar">🎓 Transcript &amp; Certificate Verification<small>Confirm the authenticity of an academic credential</small></div>
<div class="wrap">
  <div class="card" id="formcard">
    <h2>Verify a student's credentials</h2>
    <div class="sub">Enter your details and the student's matric number. Verification requests are logged for the institution's records.</div>
    <label>I am verifying as</label>
    <select id="vtype"><option value="university">A university / higher institution</option><option value="government">A government agency</option><option value="employer">An employer</option><option value="institution">Another institution</option><option value="other">Other</option></select>
    <div class="row"><div><label>Your name</label><input id="vname" placeholder="Full name"></div><div><label>Your e-mail</label><input id="vemail" type="email" placeholder="you@organisation.org"></div></div>
    <label>Student matric number <span style="font-weight:500;color:#64748b">— or the verification code printed on the document</span></label>
    <input id="vmatric" placeholder="e.g. 021/0101/0023  ·  or  UB-1A2B3C4D5E" autocomplete="off">
    <label>Purpose of verification</label>
    <select id="vpurpose">
      <option value="Employment / background check">Employment / background check</option>
      <option value="Admission to a university">Admission to a university</option>
      <option value="Immigration / visa">Immigration / visa</option>
      <option value="Professional licensing / registration">Professional licensing / registration</option>
      <option value="Scholarship / funding">Scholarship / funding</option>
      <option value="Other">Other</option>
    </select>
    <label class="consent"><input type="checkbox" id="vconsent"> I confirm I have the student's consent, or another lawful basis, to verify their academic credentials. This verification will be logged.</label>
    <button class="btn" id="go">🔎 Verify credentials</button>
    <div id="msg"></div>
  </div>

  <div class="card" id="checkcard">
    <h2>🔐 Check a document you received</h2>
    <div class="sub">Upload the transcript or certificate PDF you were given — <b>that alone is enough</b>. We fingerprint the file and match it against what the registry actually issued, so an altered grade or a forged copy is caught instantly. Add the matric number only if you also want us to confirm the document belongs to the person you were told it does.</div>
    <label>The document file (PDF)</label>
    <input id="cfile" type="file" accept="application/pdf,image/*">
    <label>Student matric number <span style="font-weight:500;color:#64748b">— optional</span></label>
    <input id="cmatric" placeholder="Leave blank to identify the document from the file alone" autocomplete="off">
    <button class="btn g" id="cgo">🔐 Check this document</button>
    <div id="ckmsg"></div>
  </div>

  <div id="result"></div>
  <div class="note" style="max-width:none">🛡 <b>How this verification works.</b> A genuine record here confirms the student exists in the institution's official database with the identity, programme and (where released) academic standing shown. Each issued document carries a unique verification code and a tamper-evident fingerprint, so you can verify three ways: by <b>matric number</b>, by the <b>verification code printed on the document</b>, or by <b>uploading the file itself</b> — the upload needs nothing else, and reports whether the document is authentic, altered, superseded by a re-issue, or genuine but belonging to a different student. Always cross-check the photo and matric number, and treat any document that fails the fingerprint check as suspect.</div>
  <div class="foot">Powered securely · results reflect the institution's official records.</div>
</div>
<script>
var el=function(id){return document.getElementById(id)};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(m){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m]})}
var LAST=null;
async function verify(){
  var matric=el('vmatric').value.trim(), email=el('vemail').value.trim(), name=el('vname').value.trim(), vtype=el('vtype').value;
  var purpose=el('vpurpose').value, consent=el('vconsent').checked;
  el('msg').innerHTML='';
  if(!matric){el('msg').innerHTML='<div class="err">Enter the student matric number, or the verification code printed on the document.</div>';return}
  if(!email||email.indexOf('@')<0){el('msg').innerHTML='<div class="err">Enter a valid e-mail address.</div>';return}
  if(!consent){el('msg').innerHTML='<div class="err">Please tick the consent confirmation to continue.</div>';return}
  el('go').disabled=true; el('go').textContent='Checking…';
  try{
    var r=await fetch('/api/verify-credentials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({matric:matric,email:email,name:name,verifierType:vtype,purpose:purpose,consent:consent})});
    var d=await r.json();
    if(!d.ok){el('msg').innerHTML='<div class="err">'+esc(d.error||'Something went wrong.')+'</div>';}
    else if(!d.valid){render_notfound(d.contact||{});}
    else {LAST={matric:matric,email:email,name:name};render_student(d);}
  }catch(e){el('msg').innerHTML='<div class="err">Network error. Please try again.</div>';}
  el('go').disabled=false; el('go').textContent='🔎 Verify credentials';
}
// 🔐 tamper check — hash the uploaded file in the browser is not needed; the server hashes the bytes
// and compares to the issued document. We just ship the file as base64.
function fileToB64(file){return new Promise(function(resolve,reject){var fr=new FileReader();fr.onerror=function(){reject(new Error('read failed'))};fr.onload=function(){resolve(String(fr.result).replace(/^data:[^;]+;base64,/,''))};fr.readAsDataURL(file);});}
function fpbox(kind,title,body,fp){
  return '<div class="fpbox '+kind+'"><div class="ttl">'+title+'</div><div class="bd">'+body+'</div>'+(fp?'<div class="fp">'+esc(fp)+'</div>':'')+'</div>';
}
async function checkFile(){
  // the matric is OPTIONAL — the file's own fingerprint identifies it
  var matric=el('cmatric').value.trim(), f=el('cfile').files[0];
  el('ckmsg').innerHTML='';
  if(!f){el('ckmsg').innerHTML='<div class="err">Choose the document file you received.</div>';return}
  // 15 MB, matching the server: base64 inflates by ~4/3 and the hub destroys bodies over 24 MB, so a
  // bigger file dies as an unexplained "network error" instead of this message.
  if(f.size>15*1024*1024){el('ckmsg').innerHTML='<div class="err">That file is too large (max 15 MB). Please contact the Registry to verify a larger document.</div>';return}
  el('cgo').disabled=true; el('cgo').textContent='Checking…';
  try{
    var b64=await fileToB64(f);
    var r=await fetch('/api/verify-credentials/check-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({matric:matric,file:b64})});
    var d=await r.json();
    var who=d.student?('<b>'+esc(d.student.name)+'</b> ('+esc(d.student.matric)+')'):'';
    if(!d.ok){el('ckmsg').innerHTML='<div class="err">'+esc(d.error||'Something went wrong.')+'</div>';}
    else if(!d.valid){el('ckmsg').innerHTML='<div class="err"><b>❌ Matric number not valid.</b> No student matches that matric number.</div>';}
    // 🚩 the file is genuine but the holder is NOT who it was presented as — the sharpest fraud signal here
    else if(d.identified&&d.mismatch){el('ckmsg').innerHTML=fpbox('bad','🚩 Genuine document — but NOT this student',
      'These bytes are a real <b>'+esc(d.document.label)+'</b> issued by this institution, but it belongs to '+who+' — <b>not</b> to '+(d.claimed?'<b>'+esc(d.claimed.name)+'</b> ('+esc(d.claimed.matric)+')':'the matric number you entered')+'. A genuine document presented under someone else\\'s name is a serious misrepresentation — please contact the Registry.',d.fingerprint);}
    // ♻ genuine, but the registry has since re-issued this credential
    else if(d.identified&&d.superseded){el('ckmsg').innerHTML=fpbox('warn','♻ Genuine — but superseded',
      'This is an authentic <b>'+esc(d.document.label)+'</b> issued for '+who+(d.document.issuedAt?' on '+esc(fmtWhen(d.document.issuedAt)):'')+', but the registry has since <b>re-issued</b> it'+(d.supersededAt?' ('+esc(fmtWhen(d.supersededAt))+')':'')+'. The copy you hold is genuine but out of date — ask for the current version. Code <b>'+esc(d.document.code)+'</b>.',d.fingerprint);}
    else if(d.identified){el('ckmsg').innerHTML=fpbox('good','✓ Genuine &amp; unaltered',
      'This is the exact <b>'+esc(d.document.label)+'</b> the registry issued for '+who+(d.document.issuedAt?' on '+esc(fmtWhen(d.document.issuedAt)):'')+'. Document code <b>'+esc(d.document.code)+'</b>.'+(d.seal&&d.seal.valid?' The document\\'s embedded security seal also verified.':''),d.fingerprint);}
    // 🫥 a SPECIFIC issued document whose bytes no longer match — altered/re-saved since issue
    else if(d.sealIdentified&&d.altered){el('ckmsg').innerHTML=fpbox('bad','⚠ Issued document — content ALTERED',
      'This file carries this institution\\'s embedded security seal for a genuine <b>'+esc(d.document.label)+'</b>'+(who?' issued for '+who:'')+(d.document.issuedAt?' on '+esc(fmtWhen(d.document.issuedAt)):'')+', but its content no longer matches what the registry issued — the document has been <b>altered or re-saved</b> since issue. Do not rely on it; request the original from the Registry'+(d.document.code?' (code <b>'+esc(d.document.code)+'</b>)':'')+'.',d.fingerprint);}
    // 🫥 valid seal, no single stored row to byte-compare (an officer-saved copy, a translation) —
    // origin is cryptographically confirmed, so this is a GENUINE document, not an alteration.
    else if(d.sealIdentified){el('ckmsg').innerHTML=fpbox('good','✓ Genuine — verified by security seal',
      'This file carries this institution\\'s valid embedded security seal for a <b>'+esc(d.document.label)+'</b>'+(who?' issued for '+who:'')+(d.document.issuedAt?' on '+esc(fmtWhen(d.document.issuedAt)):'')+'. Its origin is <b>cryptographically confirmed</b> as issued by this institution. (This is a saved/forwarded copy, so it is verified by its seal rather than by an exact byte match.)',d.fingerprint);}
    else{
      var extra='';
      if(d.seal&&d.seal.present&&!d.seal.valid&&d.seal.reason==='signature')extra=' It also carries a <b>forged or doctored</b> copy of this institution\\'s security seal — treat it as fraudulent.';
      el('ckmsg').innerHTML=fpbox('bad','⚠ Does not match an issued document',
      'This file does not match any document this institution has issued'+(who?' for '+who:'')+'. It may have been altered, or it was never issued here — treat it as unverified and contact the Registry.'+extra,d.fingerprint);}
  }catch(e){el('ckmsg').innerHTML='<div class="err">Network error. Please try again.</div>';}
  el('cgo').disabled=false; el('cgo').textContent='🔐 Check this document';
}
function f(label,val){return '<div class="f"><span>'+esc(label)+'</span><b>'+esc(val==null||val===''?'—':val)+'</b></div>'}
function fmtWhen(iso){try{var dt=new Date(iso);return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})+' '+dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});}catch(e){return '';}}
function render_student(d){
  var s=d.student||{};
  var inst=d.institution||{};
  // institution header (logo + name) so the record clearly belongs to the issuing university
  var ilogo=inst.logo?'<img src="'+esc(inst.logo)+'">':'<div class="il">'+esc((inst.short||'U').slice(0,3))+'</div>';
  var instRow=inst.name?('<div class="instrow">'+ilogo+'<div><div class="it">'+esc(inst.name)+'</div><div class="is">Office of the Registrar · Verified academic record</div></div></div>'):'';
  var photo=s.photo?'<img class="photo" src="'+esc(s.photo)+'">':'<div class="photo ph">👤</div>';
  // status + class badges
  var badges='<span class="badge '+(d.graduated?'grad':'act')+'">'+(d.graduated?'✓ Graduated':'● Active — not yet graduated')+'</span>';
  if(d.graduated&&d.classification)badges+='<span class="badge cls">🎓 '+esc(d.classification)+'</span>';
  if(d.recordSource==='registry')badges+='<span class="badge reg">Registry record</span>';
  // matching by a code printed on the document proves possession of an issued credential — say so
  if(d.matchedBy==='code')badges+='<span class="badge code">🔑 Matched by document code</span>';
  var who='<div class="who"><div class="nm">'+esc(s.name)+'</div><div class="mt">'+esc(s.matric)+'</div>'+
    (s.programme&&s.programme!=='—'?'<div class="prg">'+esc(s.programme)+(s.level&&s.level!=='—'?' · '+esc(s.level):'')+'</div>':'')+
    '<div class="badges">'+badges+'</div></div>';
  // identity + academic sections
  var identity='<div class="sect"><div class="st">👤 Identity</div><div class="grid">'+
    f('Date of birth',s.dob)+f('Gender',s.gender)+f('Nationality',s.nationality)+f('Status',s.status==='alumni'?'Alumnus / Graduate':s.status)+
    '</div></div>';
  var academic='<div class="sect"><div class="st">🎓 Academic</div><div class="grid">'+
    f('Faculty',s.faculty)+f('Department',s.department)+
    (s.campus?f('Campus',s.campus):'')+f('Level',s.level)+
    f('Year of entry',d.entryYear)+f('Year of graduation',d.gradYear||(d.graduated?'—':'In progress'))+
    '</div></div>';
  // performance — real numbers when known, an honest note when the Registry holds them
  var perf;
  if(d.hasRecord){
    perf='<div class="sect"><div class="st">📊 Academic performance</div><div class="metrics">'+
      '<div class="metric"><div class="v">'+esc(d.cgpa)+'</div><div class="l">CGPA (of 5.00)</div></div>'+
      '<div class="metric"><div class="v sm">'+esc(d.classification||d.standing||'—')+'</div><div class="l">Class of degree</div></div>'+
      '<div class="metric"><div class="v">'+esc(d.totalUnits)+'</div><div class="l">Credit units'+(d.courses?' · '+esc(d.courses)+' courses':'')+'</div></div>'+
      '</div></div>';
  } else if(d.graduated){
    perf='<div class="note">This student has <b>graduated</b>'+(d.classification?' with a <b>'+esc(d.classification)+'</b>':'')+'. The detailed CGPA and credit summary are held on the institution\\'s registry — request the official transcript below to receive the full academic record.</div>';
  } else {
    perf='<div class="note">This student is currently <b>active</b> and has <b>not yet graduated</b>. A final transcript and degree certificate become available after graduation.</div>';
  }
  // documents — EVERY credential document, available ones tickable, the rest shown as not-yet-issued
  var docs=d.documents||[];
  var anyAvail=docs.some(function(x){return x.available});
  var docSection='';
  if(docs.length){
    docSection='<div class="sect"><div class="st">📨 Official documents</div>'+
      '<div class="sub" style="margin:2px 0 4px">Tick the documents you need — the Office of the Registrar e-mails them to <b>'+esc((LAST&&LAST.email)||'your address')+'</b> (student copies are watermarked, for verification).</div>'+
      '<div class="docs" id="doclist">'+
      docs.map(function(x){
        var on=!!x.available;
        var meta=on?('<div class="meta">Issued '+(x.issuedAt?esc(fmtWhen(x.issuedAt)):'—')+(x.office?' · '+esc(x.office):'')+'<br>Code <code>'+esc(x.code||'—')+'</code>'+(x.fingerprint?' · Fingerprint <code>'+esc(x.fingerprint)+'</code>':'')+
          // re-issued → any older printout in circulation is genuine but superseded
          (x.reissued?'<br>♻ Re-issued '+esc(x.issues)+'× — only the copy with the code above is current':'')+'</div>'):'<div class="ds">Not yet issued for this student</div>';
        return '<label class="doc'+(on?'':' off')+'">'+
          '<input type="checkbox" class="dck" value="'+esc(x.key)+'"'+(on?' checked':' disabled')+'>'+
          '<div class="di"><div class="dl">'+esc(x.label)+'</div>'+meta+'</div>'+
          '<span class="chip '+(on?'on':'no')+'">'+(on?'Available':'—')+'</span></label>';
      }).join('')+
      '</div>'+
      (anyAvail?'<button class="btn g" id="copy">✉ E-mail me the selected document(s)</button><div id="cmsg"></div>':'<div class="note">No issued documents are available for this student yet. Please contact the Registry for a certified copy.</div>')+
      '</div>';
  }
  el('result').innerHTML='<div class="card">'+instRow+
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><h2 style="margin:0">✓ Verified record</h2>'+
    '<button class="btn ghost" style="width:auto;margin:0;padding:8px 14px;font-size:12.5px" onclick="window.print()">🖨 Print</button></div>'+
    '<div class="stu">'+photo+who+'</div>'+
    identity+academic+perf+docSection+
    '<div class="reftag"><span>Verification reference <b>'+esc(d.ref)+'</b></span><span>Verified '+esc(fmtWhen(d.verifiedAt)||'just now')+'</span></div>'+
    '</div>';
  if(el('copy'))el('copy').onclick=requestCopies;
}
function render_notfound(c){
  el('result').innerHTML='<div class="card"><div class="err" style="font-size:14px"><b>❌ Matric number not valid.</b><br>No student record matches the matric number you entered.</div>'+
   '<div class="contact"><b>Please contact '+esc(c.name||'the University')+' for manual verification:</b><br>'+
   (c.email?('✉ '+esc(c.email)+'<br>'):'')+(c.phone?('📞 '+esc(c.phone)+'<br>'):'')+(c.address?('📍 '+esc(c.address)+'<br>'):'')+(c.website?('🔗 '+esc(c.website)):'')+
   '</div></div>';
}
async function requestCopies(){
  var docs=[].slice.call(document.querySelectorAll('.dck:checked')).map(function(x){return x.value});
  if(!docs.length){el('cmsg').innerHTML='<div class="err">Tick at least one document to receive.</div>';return}
  el('copy').disabled=true; el('copy').textContent='Sending…'; el('cmsg').innerHTML='';
  try{
    var r=await fetch('/api/verify-credentials/copy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({},LAST,{docs:docs}))});
    var d=await r.json();
    el('cmsg').innerHTML=d.ok?('<div class="ok">✓ '+esc(d.message||'Sent.')+' Check your inbox (and spam).</div>'):('<div class="err">'+esc(d.error||'Could not send.')+'</div>');
    if(d.ok){el('copy').textContent='✓ Sent';}else{el('copy').disabled=false;el('copy').textContent='✉ E-mail me the selected document(s)';}
  }catch(e){el('cmsg').innerHTML='<div class="err">Network error. Please try again.</div>';el('copy').disabled=false;el('copy').textContent='✉ E-mail me the selected document(s)';}
}
el('go').onclick=verify;
el('cgo').onclick=checkFile;
el('vmatric').addEventListener('keydown',function(e){if(e.key==='Enter')verify()});
el('cmatric').addEventListener('keydown',function(e){if(e.key==='Enter')checkFile()});
</script></body></html>`;

const VERIFY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Document Verification</title><link rel="icon" href="/favicon"><meta name="theme-color" content="#0f1e3d">
<style>*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:#eef2f8;color:#0f172a;min-height:100vh}
.bar{background:#0f1e3d;color:#fff;padding:14px 16px;font-weight:700}
#result{max-width:560px;margin:0 auto}
.lookup{max-width:560px;margin:14px auto;padding:0 14px;display:flex;gap:8px}
.lookup input{flex:1;padding:12px;border-radius:10px;border:1px solid #cbd5e1}
.lookup .b{background:#1e3a8a;color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:700}
${RESULT_CSS}
</style></head><body>
<div class="bar">🛡 Document Verification</div>
<div class="lookup"><input id="code" placeholder="Paste a certificate / transcript / receipt / clearance code or link"><button class="b" id="lk">Verify</button></div>
<div id="result"></div>
<script>
${RESULT_JS}
function resetView(){location.href=(window.__B||'')+'/scan';}
var el=document.getElementById('result');
var q=new URLSearchParams(location.search);var rr=q.get('r');var pp=q.get('p');var st=q.get('student');var rsq=q.get('res');var c=q.get('c')||q.get('ref');
document.getElementById('lk').onclick=function(){doVerify(el,extractCode(document.getElementById('code').value));};
if(rsq){document.getElementById('code').value=rsq;doVerify(el,{type:'res',id:rsq});}
else if(st){document.getElementById('code').value=st;doVerify(el,{type:'student',id:st});}
else if(pp){document.getElementById('code').value=pp;doVerify(el,{type:'p',id:pp});}
else if(rr){document.getElementById('code').value=rr;doVerify(el,{type:'r',id:rr});}
else if(c){document.getElementById('code').value=c;doVerify(el,extractCode(c));}
</script></body></html>`;

