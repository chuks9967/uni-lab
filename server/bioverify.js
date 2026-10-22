'use strict';
/**
 * 🔐 BIOMETRIC IDENTITY — ONE pure module (desk · portal · edge) for proving, at an exam, that the candidate IS the student
 * whose matric number the attempt is filed under: by FACE, by FINGERPRINT, or both, under the institution's policy.
 *
 * 🐛 THE HOLES THIS FILLS
 *  • Face check-in trusted whatever face numbers the browser sent: no one-time challenge, no proof of a live person, no
 *    limit on tries, and nothing tied the numbers to the photo actually taken. → faceDecision(): at least 3 frames that
 *    differ (an injected or replayed vector, or a photo held up, gives identical frames), never a probe almost identical
 *    to the ENROLLED sample (a stolen template replayed), a head-turn liveness check, a cap on tries — and the check-in
 *    photo is kept so the desk re-checks it with its own engine (the student's browser can't touch that).
 *  • Fingerprint on a phone or laptop: a sensor never gives out a fingerprint — so the system can't "compare" one. What it
 *    CAN prove is that the student's OWN registered device unlocked a key only their fingerprint opens:
 *      - the app: an EC P-256 key in the phone's secure hardware (Android Keystore), usable only after a STRONG
 *        biometric, and destroyed if a new finger is added to the phone; it signs a one-time server challenge.
 *      - the portal: a passkey (WebAuthn — Windows Hello, Touch ID, Android), user-verified, signing the challenge.
 *    A new device is registered pending — the Registry approves it (policy) — so a borrowed password can't enrol a stranger.
 *
 *   normalizePolicy · newChallenge · signedMessage · faceDecision · livenessOk · validateAndroidKey · verifyAndroid ·
 *   webauthnRegister · webauthnAssert · combine · canBegin
 */
const crypto = require('crypto');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const r3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;

// ------------------------------------------------------------------------------------------------ policy
/** require: none | any (face OR fingerprint) | face | fingerprint | both · block: no answering until verified (or an
 *  officer clears) · max_tries · device_approval: registry | auto · liveness · max_devices */
function normalizePolicy(x) {
  let p = x; if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = null; } }
  p = p || {};
  return {
    require: ['none', 'any', 'face', 'fingerprint', 'both'].includes(p.require) ? p.require : 'any',
    block: p.block === true || p.block === 1 || p.block === '1',
    max_tries: Math.max(1, Math.min(10, Math.round(Number(p.max_tries) || 5))),
    device_approval: p.device_approval === 'auto' ? 'auto' : 'registry',
    liveness: p.liveness !== false && p.liveness !== 0 && p.liveness !== '0',
    max_devices: Math.max(1, Math.min(5, Math.round(Number(p.max_devices) || 2))),
    // 🪪 the ID card at an exam (server/idcard.js): off · ask (scanned when presented) · require (no start without a genuine card)
    card: ['off', 'ask', 'require'].includes(p.card) ? p.card : 'ask',
  };
}
/** A one-time challenge: 16 random bytes, and the head-turn order the face check asks for. */
function newChallenge() {
  const n = b64u(crypto.randomBytes(16));
  return { n, turns: crypto.randomBytes(1)[0] % 2 ? ['left', 'right'] : ['right', 'left'] };
}
/** What a device key signs: the challenge, bound to THIS exam and THIS student (a signature can't be moved elsewhere). */
const signedMessage = (nonce, examId, studentId) => 'UBU-ID|v1|' + String(nonce) + '|' + String(examId) + '|' + String(studentId);

// ------------------------------------------------------------------------------------------------ face
const dist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); };
/** 128 finite numbers in [-1, 1] — anything else is not a face descriptor. */
function cleanProbes(arr) {
  return (Array.isArray(arr) ? arr : []).filter(p => Array.isArray(p) && p.length === 128 && p.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1)).slice(0, 8);
}
/** Head-turn liveness from yaw samples [{ t (ms), yaw (≈ −0.5 … 0.5, 0 = facing the camera) }]: a frontal moment, a turn
 *  each way (either order — a mirrored camera can't trip it), at least 6 samples over 1.2 s. */
function livenessOk(samples) {
  const s = (Array.isArray(samples) ? samples : []).filter(x => x && Number.isFinite(Number(x.yaw)) && Number.isFinite(Number(x.t))).map(x => ({ t: Number(x.t), yaw: Number(x.yaw) })).sort((a, b) => a.t - b.t);
  if (s.length < 6) return { ok: false, why: 'too_few_samples' };
  if (s[s.length - 1].t - s[0].t < 1200) return { ok: false, why: 'too_quick' };
  const ys = s.map(x => x.yaw);
  if (!ys.some(y => Math.abs(y) < 0.08)) return { ok: false, why: 'never_frontal' };
  if (Math.min(...ys) > -0.15 || Math.max(...ys) < 0.15) return { ok: false, why: 'no_turn' };
  return { ok: true };
}
/**
 * The face decision. probes = descriptors from ≥3 live frames; enrolled = the student's enrolled samples.
 * → { verdict: verified | review | rejected | retry, distance, confidence, reasons[] }
 *   verified — a match, from frames that vary, with liveness, and nothing suspicious
 *   review   — a match, but something is off (no liveness, identical frames, a near-copy of the enrolled sample): an officer looks
 *   rejected — not the student
 *   retry    — too few usable frames
 */
function faceDecision(o) {
  const x = o || {}; const cfg = Object.assign({ verifyThreshold: 0.5, minProbes: 3, replayBelow: 0.06, staticBelow: 0.012, liveness: true }, x.cfg || {});
  const probes = cleanProbes(x.probes);
  const enrolled = (Array.isArray(x.enrolled) ? x.enrolled : []).filter(p => Array.isArray(p) && p.length === 128 && p.every(v => Number.isFinite(Number(v))));
  if (!enrolled.length) return { verdict: 'not_enrolled', reasons: ['not_enrolled'] };
  if (probes.length < cfg.minProbes) return { verdict: 'retry', reasons: ['too_few_frames'] };
  let best = Infinity, closest = Infinity;
  for (const p of probes) for (const e of enrolled) { const d = dist(p, e); if (d < best) best = d; if (d < closest) closest = d; }
  let spread = 0; for (let i = 0; i < probes.length; i++) for (let j = i + 1; j < probes.length; j++) spread = Math.max(spread, dist(probes[i], probes[j]));
  const reasons = [];
  if (closest < cfg.replayBelow) reasons.push('replay_suspected');      // a live capture never reproduces the stored sample
  if (spread < cfg.staticBelow) reasons.push('static_source');           // the same vector every frame — injected, or a still photo
  if (cfg.liveness) { const l = livenessOk(x.yaw); if (!l.ok) reasons.push('no_liveness:' + l.why); }
  const match = best <= cfg.verifyThreshold;
  const confidence = Math.max(0, Math.min(1, Math.round((1 - best / 0.62) * 100) / 100));
  const verdict = !match ? 'rejected' : (reasons.length ? 'review' : 'verified');
  return { verdict, distance: r3(best), spread: r3(spread), confidence, reasons };
}

// ------------------------------------------------------------------------------------------------ the phone's key (Android Keystore)
/** An EC P-256 public key (SubjectPublicKeyInfo, base64). */
function validateAndroidKey(spkiB64) {
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(String(spkiB64 || ''), 'base64'), format: 'der', type: 'spki' });
    const d = k.asymmetricKeyDetails || {};
    if (k.asymmetricKeyType !== 'ec' || (d.namedCurve && d.namedCurve !== 'prime256v1')) return { ok: false, error: 'Only an EC P-256 key is accepted.' };
    return { ok: true, alg: -7 };
  } catch (_) { return { ok: false, error: 'That is not a valid public key.' }; }
}
/** SHA256withECDSA (DER signature, base64) over the message, by the registered key. */
function verifyAndroid(spkiB64, message, sigB64) {
  try { const k = crypto.createPublicKey({ key: Buffer.from(String(spkiB64 || ''), 'base64'), format: 'der', type: 'spki' }); return crypto.verify('sha256', Buffer.from(String(message), 'utf8'), k, Buffer.from(String(sigB64 || ''), 'base64')); }
  catch (_) { return false; }
}

// ------------------------------------------------------------------------------------------------ passkeys (WebAuthn)
/** A small CBOR reader — enough for an attestation object and a COSE key (maps, arrays, ints, bytes, text, simple). */
function cborDecode(buf) {
  let i = 0;
  const len = (ai) => { if (ai < 24) return ai; if (ai === 24) return buf[i++]; if (ai === 25) { const v = buf.readUInt16BE(i); i += 2; return v; } if (ai === 26) { const v = buf.readUInt32BE(i); i += 4; return v; } if (ai === 27) { const v = Number(buf.readBigUInt64BE(i)); i += 8; return v; } throw new Error('cbor: bad length'); };
  const item = () => {
    const b = buf[i++]; const mt = b >> 5; const ai = b & 31;
    if (mt === 0) return len(ai);
    if (mt === 1) return -1 - len(ai);
    if (mt === 2) { const n = len(ai); const v = buf.subarray(i, i + n); i += n; return Buffer.from(v); }
    if (mt === 3) { const n = len(ai); const v = buf.subarray(i, i + n).toString('utf8'); i += n; return v; }
    if (mt === 4) { const n = len(ai); const a = []; for (let k = 0; k < n; k++) a.push(item()); return a; }
    if (mt === 5) { const n = len(ai); const m = new Map(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
    if (mt === 6) { len(ai); return item(); }
    if (mt === 7) { if (ai === 20) return false; if (ai === 21) return true; if (ai === 22 || ai === 23) return null; throw new Error('cbor: unsupported simple'); }
    throw new Error('cbor: bad type');
  };
  return item();
}
function parseAuthData(ad) {
  const buf = Buffer.from(ad);
  if (buf.length < 37) throw new Error('authenticator data too short');
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  out.up = !!(out.flags & 0x01); out.uv = !!(out.flags & 0x04); out.at = !!(out.flags & 0x40);
  if (out.at) {
    const credLen = buf.readUInt16BE(53); out.credId = buf.subarray(55, 55 + credLen);
    out.cose = cborDecode(buf.subarray(55 + credLen));
  }
  return out;
}
/** COSE key → JWK: ES256 (EC2, P-256) or RS256 (RSA — Windows Hello often uses it). */
function coseToJwk(cose) {
  const g = (k) => (cose instanceof Map ? cose.get(k) : cose[k]);
  const kty = g(1), alg = g(3);
  if (kty === 2 && alg === -7 && g(-1) === 1) return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(g(-2)), y: b64u(g(-3)) } };
  if (kty === 3 && alg === -257) return { alg: -257, jwk: { kty: 'RSA', n: b64u(g(-1)), e: b64u(g(-2)) } };
  throw new Error('Only ES256 or RS256 passkeys are accepted.');
}
function checkClient(clientDataJSON, type, challenge, origin) {
  let c; try { c = JSON.parse(fromB64u(clientDataJSON).toString('utf8')); } catch (_) { return 'The browser’s answer could not be read.'; }
  if (c.type !== type) return 'Wrong kind of passkey answer.';
  if (c.challenge !== challenge) return 'This answer is for another (or an old) challenge.';
  if (origin && c.origin !== origin) return 'This answer came from another website.';
  return null;
}
/** A new passkey: → { ok, credential_id, jwk, alg, sign_count } (attestation "none" — the key is trusted as the student's once the Registry approves it). */
function webauthnRegister(o) {
  const x = o || {};
  const bad = checkClient(x.clientDataJSON, 'webauthn.create', x.challenge, x.origin); if (bad) return { ok: false, error: bad };
  let att; try { att = cborDecode(fromB64u(x.attestationObject)); } catch (_) { return { ok: false, error: 'The passkey could not be read.' }; }
  const authData = att instanceof Map ? att.get('authData') : null; if (!authData) return { ok: false, error: 'The passkey could not be read.' };
  let ad; try { ad = parseAuthData(authData); } catch (e) { return { ok: false, error: 'The passkey could not be read.' }; }
  if (!crypto.timingSafeEqual(ad.rpIdHash, crypto.createHash('sha256').update(String(x.rpId)).digest())) return { ok: false, error: 'This passkey was made for another website.' };
  if (!ad.up || !ad.uv) return { ok: false, error: 'The passkey must be unlocked with your fingerprint, face or PIN.' };
  if (!ad.at || !ad.credId || !ad.cose) return { ok: false, error: 'The passkey has no key in it.' };
  let k; try { k = coseToJwk(ad.cose); } catch (e) { return { ok: false, error: e.message }; }
  try { crypto.createPublicKey({ key: k.jwk, format: 'jwk' }); } catch (_) { return { ok: false, error: 'That is not a valid passkey.' }; }
  return { ok: true, credential_id: b64u(ad.credId), jwk: k.jwk, alg: k.alg, sign_count: ad.signCount };
}
/** A passkey answer to a challenge: → { ok, sign_count } — user-verified, for this site, by the registered key, not cloned. */
function webauthnAssert(o) {
  const x = o || {};
  const bad = checkClient(x.clientDataJSON, 'webauthn.get', x.challenge, x.origin); if (bad) return { ok: false, error: bad };
  let ad; try { ad = parseAuthData(fromB64u(x.authenticatorData)); } catch (_) { return { ok: false, error: 'The passkey answer could not be read.' }; }
  if (!crypto.timingSafeEqual(ad.rpIdHash, crypto.createHash('sha256').update(String(x.rpId)).digest())) return { ok: false, error: 'This passkey belongs to another website.' };
  if (!ad.up || !ad.uv) return { ok: false, error: 'The passkey was not unlocked with your fingerprint, face or PIN.' };
  const data = Buffer.concat([fromB64u(x.authenticatorData), crypto.createHash('sha256').update(fromB64u(x.clientDataJSON)).digest()]);
  let okSig = false;
  try { const key = crypto.createPublicKey({ key: typeof x.jwk === 'string' ? JSON.parse(x.jwk) : x.jwk, format: 'jwk' }); okSig = crypto.verify('sha256', data, key, fromB64u(x.signature)); } catch (_) { okSig = false; }
  if (!okSig) return { ok: false, error: 'The passkey signature is not valid.' };
  const prev = Number(x.prevCount) || 0;
  if (prev > 0 && ad.signCount <= prev) return { ok: false, error: 'This passkey may have been copied (its counter went backwards) — the Registry has been told.', clone: true };
  return { ok: true, sign_count: ad.signCount };
}

// ------------------------------------------------------------------------------------------------ the verdict
/** Face + fingerprint verdicts under the policy → { verdict: verified | review | rejected | pending | not_required, method } */
function combine(o) {
  const p = normalizePolicy(o && o.policy); const cd = (o && o.card) || null;
  if (cd === 'rejected' && p.card !== 'off') return { verdict: 'rejected', method: 'idcard' };   // a revoked, lost or forged card was presented
  const r = combineBio(o, p);
  if (p.card === 'require' && p.require !== 'none' && r.verdict === 'verified' && cd !== 'verified') return { verdict: 'pending', method: r.method };
  if (r.verdict === 'verified' && cd === 'verified') return { verdict: 'verified', method: (r.method ? r.method + '+' : '') + 'idcard' };
  return r;
}
function combineBio(o, p) {
  const f = (o && o.face) || null; const fp = (o && o.fingerprint) || null;
  if (p.require === 'none') return { verdict: 'not_required', method: f === 'verified' ? 'face' : fp === 'verified' ? 'fingerprint' : null };
  const both = f === 'verified' && fp === 'verified';
  const method = both ? 'both' : f === 'verified' ? 'face' : fp === 'verified' ? 'fingerprint' : null;
  if (f === 'rejected' && fp === 'verified') return { verdict: 'review', method: 'fingerprint' };   // the phone's owner, but not the face on camera
  if (p.require === 'both') return { verdict: both ? 'verified' : (f === 'rejected' || fp === 'rejected') ? 'rejected' : (f === 'review' || fp === 'review') ? 'review' : 'pending', method };
  if (p.require === 'face') return { verdict: f === 'verified' ? 'verified' : f === 'rejected' ? 'rejected' : f === 'review' ? 'review' : 'pending', method: f === 'verified' ? 'face' : null };
  if (p.require === 'fingerprint') return { verdict: fp === 'verified' ? 'verified' : fp === 'rejected' ? 'rejected' : 'pending', method: fp === 'verified' ? 'fingerprint' : null };
  // any
  if (method) return { verdict: 'verified', method };
  if (f === 'review') return { verdict: 'review', method: null };
  if (f === 'rejected' || fp === 'rejected') return { verdict: 'rejected', method: null };
  return { verdict: 'pending', method: null };
}
/** May the candidate start answering? Under a blocking policy only once verified (or cleared by an officer). */
const canBegin = (policy, verdict) => { const p = normalizePolicy(policy); return !p.block || p.require === 'none' || verdict === 'verified' || verdict === 'officer_cleared'; };

module.exports = { normalizePolicy, newChallenge, signedMessage, cleanProbes, livenessOk, faceDecision, validateAndroidKey, verifyAndroid, cborDecode, parseAuthData, coseToJwk, webauthnRegister, webauthnAssert, combine, canBegin };
