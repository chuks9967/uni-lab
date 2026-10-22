'use strict';
/** 🔏 VERIFIABLE CREDENTIALS — degrees and transcripts any verifier in the world can check.
 *
 *  Standards implemented (no third-party libraries):
 *   • W3C Verifiable Credentials Data Model 2.0  (context https://www.w3.org/ns/credentials/v2)
 *   • W3C Data Integrity, cryptosuite eddsa-jcs-2022 (Ed25519 over JCS-canonical JSON):
 *       proofConfig = proof options (+ the document's @context), canonicalised with JCS (RFC 8785);
 *       hashData = SHA-256(proofConfig) ‖ SHA-256(JCS(document without proof));
 *       proofValue = multibase base58-btc ('z…') of the Ed25519 signature.
 *   • did:key / Multikey — publicKeyMultibase = 'z' + base58btc(0xed 0x01 ‖ 32-byte key), so a
 *     credential signed with a did:key is verifiable OFFLINE by anyone; did:web when the institution
 *     publishes its DID document on its portal.
 *   • 1EdTech Open Badges 3.0 (OpenBadgeCredential / Achievement) for the DEGREE and each COURSE, and
 *     Comprehensive Learner Record 2.0 (ClrCredential) for the TRANSCRIPT (nested, individually signed
 *     course credentials — as CLR 2.0 requires).
 *
 *  PURE apart from node:crypto (Ed25519 + SHA-256), which Node and Deno (Supabase Edge) both provide.
 */
const crypto = require('crypto');

const CTX_VC = 'https://www.w3.org/ns/credentials/v2';
const CTX_OB = 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json';
const CTX_CLR = 'https://purl.imsglobal.org/spec/clr/v2p0/context-2.0.1.json';

// ---------------------------------------------------------------------------------------------------
// JCS — RFC 8785 JSON Canonicalization Scheme. ES JSON.stringify already serialises numbers and strings
// exactly as JCS requires; canonical form = object members sorted by UTF-16 code units, no whitespace.
// ---------------------------------------------------------------------------------------------------
function jcs(v) {
  if (v === null || typeof v !== 'object') { if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('JCS: non-finite number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return '[' + v.map(x => (x === undefined ? 'null' : jcs(x))).join(',') + ']';
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
}

// ---------------------------------------------------------------------------------------------------
// base58-btc + multibase / Multikey / did:key
// ---------------------------------------------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  const b = Buffer.from(bytes); let zeros = 0; while (zeros < b.length && b[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < b.length; i++) {
    let carry = b[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map(d => B58[d]).join('');
}
function b58decode(str) {
  const s = String(str || ''); let zeros = 0; while (zeros < s.length && s[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < s.length; i++) {
    const v = B58.indexOf(s[i]); if (v < 0) throw new Error('base58: invalid character');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes.reverse())]);
}
const ED_PREFIX = Buffer.from([0xed, 0x01]);
function multikeyFromRaw(raw) { return 'z' + b58encode(Buffer.concat([ED_PREFIX, Buffer.from(raw)])); }
function rawFromMultikey(mb) {
  if (!/^z/.test(String(mb))) throw new Error('Multikey must be base58-btc (z…)');
  const b = b58decode(String(mb).slice(1));
  if (b.length !== 34 || b[0] !== 0xed || b[1] !== 0x01) throw new Error('Not an Ed25519 Multikey');
  return b.slice(2);
}
function didKeyFromRaw(raw) { const mk = multikeyFromRaw(raw); return { did: 'did:key:' + mk, verificationMethod: 'did:key:' + mk + '#' + mk, multikey: mk }; }

// ---------------------------------------------------------------------------------------------------
// Ed25519 keys (node:crypto KeyObjects ↔ raw 32-byte public keys)
// ---------------------------------------------------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function generateKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), raw, multikey: multikeyFromRaw(raw) };
}
// SPKI DER (RFC 8410) first — the most portable import (Node, Deno edge); JWK as a fallback
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function publicKeyObject(raw) {
  try { return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(raw)]), format: 'der', type: 'spki' }); }
  catch (_) { return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(raw) }, format: 'jwk' }); }
}
function rawFromPrivatePem(pem) { const pub = crypto.createPublicKey(crypto.createPrivateKey(pem)); return Buffer.from(pub.export({ format: 'jwk' }).x, 'base64url'); }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// ---------------------------------------------------------------------------------------------------
// Data Integrity — eddsa-jcs-2022
// ---------------------------------------------------------------------------------------------------
function hashData(doc, proofConfig) {
  const unsecured = Object.assign({}, doc); delete unsecured.proof;
  return Buffer.concat([sha256(jcs(proofConfig)), sha256(jcs(unsecured))]);
}
/** Sign a credential. opts = { privatePem, verificationMethod, created? } → a NEW object with `proof`. */
function sign(doc, opts) {
  const o = opts || {};
  const proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: o.created || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), verificationMethod: o.verificationMethod, proofPurpose: 'assertionMethod' };
  const cfg = Object.assign({}, proof); if (doc['@context']) cfg['@context'] = doc['@context'];
  const sig = crypto.sign(null, hashData(doc, cfg), crypto.createPrivateKey(o.privatePem));
  return Object.assign({}, doc, { proof: Object.assign(proof, { proofValue: 'z' + b58encode(sig) }) });
}
/** Resolve a verificationMethod to a raw Ed25519 public key. did:key is self-describing; anything else
 *  goes through `resolver(vm)` (e.g. the institution's published keys for did:web). */
function resolveKey(vm, resolver) {
  const m = /^did:key:(z6Mk[1-9A-HJ-NP-Za-km-z]+)(?:#.*)?$/.exec(String(vm || ''));
  if (m) return rawFromMultikey(m[1]);
  if (resolver) { const r = resolver(vm); if (r) return Buffer.isBuffer(r) ? r : rawFromMultikey(r); }
  return null;
}
/** Verify a credential's Data Integrity proof. → { ok, reason, verificationMethod }. Nested credentials
 *  (a CLR's course credentials) are verified too when opts.deep. */
function verify(doc, resolver, opts) {
  try {
    if (!doc || typeof doc !== 'object') return { ok: false, reason: 'Not a credential.' };
    const p = doc.proof;
    if (!p || p.type !== 'DataIntegrityProof' || p.cryptosuite !== 'eddsa-jcs-2022') return { ok: false, reason: 'Missing or unsupported proof (expected DataIntegrityProof / eddsa-jcs-2022).' };
    if (p.proofPurpose !== 'assertionMethod') return { ok: false, reason: 'The proof purpose must be assertionMethod.' };
    const raw = resolveKey(p.verificationMethod, resolver);
    if (!raw) return { ok: false, reason: 'The signing key is unknown to this verifier.', verificationMethod: p.verificationMethod };
    const cfg = Object.assign({}, p); delete cfg.proofValue; if (doc['@context']) cfg['@context'] = doc['@context'];
    const good = crypto.verify(null, hashData(doc, cfg), publicKeyObject(raw), b58decode(String(p.proofValue || '').replace(/^z/, '')));
    if (!good) return { ok: false, reason: 'The signature does not match — the credential was altered or signed by someone else.', verificationMethod: p.verificationMethod };
    if (doc.validUntil && Date.parse(doc.validUntil) < Date.now()) return { ok: false, reason: 'The credential has expired.', verificationMethod: p.verificationMethod };
    if (opts && opts.deep && doc.credentialSubject && Array.isArray(doc.credentialSubject.verifiableCredential)) {
      for (const inner of doc.credentialSubject.verifiableCredential) { const r = verify(inner, resolver); if (!r.ok) return { ok: false, reason: 'A nested course credential failed: ' + r.reason, verificationMethod: p.verificationMethod }; }
    }
    return { ok: true, reason: 'Signature valid.', verificationMethod: p.verificationMethod };
  } catch (e) { return { ok: false, reason: 'Could not verify: ' + e.message }; }
}

// ---------------------------------------------------------------------------------------------------
// did:web
// ---------------------------------------------------------------------------------------------------
/** "https://portal.uni.edu" → "did:web:portal.uni.edu"; ports are %3A-encoded, paths become ':' segments. */
function didWebFor(url) {
  let u; try { u = new URL(String(url || '')); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const path = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).map(encodeURIComponent);
  return ['did:web', encodeURIComponent(u.host)].concat(path).join(':');
}
/** The DID document of a did:web issuer listing every institution signing key. */
function didDocument(did, keys) {
  const vms = (keys || []).filter(k => k && k.multikey && !k.revoked).map(k => ({ id: did + '#' + k.kid, type: 'Multikey', controller: did, publicKeyMultibase: k.multikey }));
  return { '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: did, verificationMethod: vms, assertionMethod: vms.map(v => v.id) };
}

// ---------------------------------------------------------------------------------------------------
// Open Badges 3.0 + CLR 2.0 builders
// ---------------------------------------------------------------------------------------------------
const uuid = () => 'urn:uuid:' + crypto.randomUUID();
function issuerProfile(i) {
  const p = { id: i.id, type: ['Profile'], name: i.name };
  if (i.url) p.url = i.url;
  if (i.email) p.email = i.email;
  if (i.country) p.address = { type: ['Address'], addressCountry: i.country };
  return p;
}
function subjectIdentifiers(s) {
  const out = [];
  if (s.name) out.push({ type: ['IdentityObject'], identityType: 'name', hashed: false, identityHash: s.name });
  if (s.studentId) out.push({ type: ['IdentityObject'], identityType: 'studentId', hashed: false, identityHash: s.studentId });
  if (s.emailHash) out.push({ type: ['IdentityObject'], identityType: 'emailAddress', hashed: true, identityHash: s.emailHash, salt: s.emailSalt });
  return out;
}
/** The DEGREE as an Open Badges 3.0 credential. d = { issuer, subject, award{…}, results{…}, validFrom } */
function degreeCredential(d) {
  const a = d.award; const r = d.results || {};
  const rd = [];
  const results = [];
  if (r.gpa != null) { rd.push({ id: a.id + '#gpa', type: ['ResultDescription'], name: r.gpaLabel || 'CGPA', resultType: 'GradePointAverage', valueMin: '0', valueMax: String(r.gpaMax) }); results.push({ type: ['Result'], resultDescription: a.id + '#gpa', value: String(r.gpa) }); }
  if (r.classLabel) { rd.push({ id: a.id + '#class', type: ['ResultDescription'], name: r.classTitle || 'Class of degree', resultType: 'PerformanceLevel', allowedValue: r.classValues || undefined }); results.push({ type: ['Result'], resultDescription: a.id + '#class', value: r.classLabel }); }
  const alignment = [];
  if (a.iscedF) alignment.push({ type: ['Alignment'], targetName: a.iscedF.label, targetCode: a.iscedF.code, targetFramework: 'ISCED-F 2013', targetType: 'ext:ISCED-F', targetUrl: 'https://uis.unesco.org/en/topic/international-standard-classification-education-isced' });
  if (a.eqf) alignment.push({ type: ['Alignment'], targetName: 'EQF level ' + a.eqf, targetCode: String(a.eqf), targetFramework: 'European Qualifications Framework', targetType: 'ext:EQF', targetUrl: 'https://europass.europa.eu/en/europass-digital-tools/european-qualifications-framework' });
  if (a.isced) alignment.push({ type: ['Alignment'], targetName: 'ISCED 2011 level ' + a.isced, targetCode: String(a.isced), targetFramework: 'ISCED 2011', targetType: 'ext:ISCED', targetUrl: 'https://uis.unesco.org/en/topic/international-standard-classification-education-isced' });
  const achievement = { id: a.id, type: ['Achievement'], achievementType: a.obType || 'BachelorDegree', name: a.title, description: a.description || a.title,
    criteria: { narrative: a.criteria || 'Completion of the programme requirements of the awarding institution.' } };
  if (a.field) achievement.fieldOfStudy = a.field;
  if (a.credits) achievement.creditsAvailable = Number(a.credits);
  if (a.language) achievement.inLanguage = a.language;
  if (rd.length) achievement.resultDescription = rd;
  if (alignment.length) achievement.alignment = alignment;
  const subject = { type: ['AchievementSubject'], identifier: subjectIdentifiers(d.subject), achievement };
  if (results.length) subject.result = results;
  if (d.subject.creditsEarned != null) subject.creditsEarned = Number(d.subject.creditsEarned);
  if (d.subject.completedOn) subject.activityEndDate = d.subject.completedOn;
  return { '@context': [CTX_VC, CTX_OB], id: d.id || uuid(), type: ['VerifiableCredential', 'OpenBadgeCredential'], issuer: issuerProfile(d.issuer), validFrom: d.validFrom || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), name: a.title, credentialSubject: subject };
}
/** One COURSE result as an Open Badges 3.0 credential (the building block of the CLR transcript). */
function courseCredential(d) {
  const c = d.course; const aid = d.achievementBase + '/' + encodeURIComponent(String(c.code || c.title || 'course').replace(/\s+/g, ''));
  const rd = [{ id: aid + '#grade', type: ['ResultDescription'], name: 'Grade', resultType: 'LetterGrade', allowedValue: c.allowedGrades || undefined }];
  const res = [{ type: ['Result'], resultDescription: aid + '#grade', value: String(c.grade) }];
  if (c.mark != null) { rd.push({ id: aid + '#mark', type: ['ResultDescription'], name: 'Mark', resultType: 'RawScore', valueMin: '0', valueMax: String(c.markMax) }); res.push({ type: ['Result'], resultDescription: aid + '#mark', value: String(c.mark) }); }
  const subject = { type: ['AchievementSubject'], identifier: subjectIdentifiers(d.subject), achievement: { id: aid, type: ['Achievement'], achievementType: 'Course', name: c.title || c.code, humanCode: c.code || undefined, description: c.title || c.code, criteria: { narrative: 'Assessed and graded by the awarding institution.' }, creditsAvailable: Number(c.credits) || 0, resultDescription: rd }, result: res };
  if (c.passed) subject.creditsEarned = Number(c.credits) || 0;
  if (c.term) subject.term = c.term;
  return { '@context': [CTX_VC, CTX_OB], id: uuid(), type: ['VerifiableCredential', 'OpenBadgeCredential'], issuer: issuerProfile(d.issuer), validFrom: d.validFrom, name: (c.code ? c.code + ' — ' : '') + (c.title || ''), credentialSubject: subject };
}
/** The TRANSCRIPT as a CLR 2.0 credential wrapping individually-signed course credentials. */
function transcriptCredential(d, signFn) {
  const validFrom = d.validFrom || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nested = (d.courses || []).map(c => signFn(courseCredential({ issuer: d.issuer, subject: d.subject, course: c, achievementBase: d.achievementBase, validFrom })));
  if (d.degree) nested.push(signFn(d.degree));
  return { '@context': [CTX_VC, CTX_CLR, CTX_OB], id: uuid(), type: ['VerifiableCredential', 'ClrCredential'], issuer: issuerProfile(d.issuer), validFrom, name: d.name || 'Academic transcript',
    credentialSubject: { type: ['ClrSubject'], identifier: subjectIdentifiers(d.subject), verifiableCredential: nested } };
}
/** A short, human summary of a credential (for verification pages). */
function summarize(doc) {
  const cs = (doc && doc.credentialSubject) || {};
  const ids = cs.identifier || [];
  const who = (ids.find(i => i.identityType === 'name') || {}).identityHash || '';
  const sid = (ids.find(i => i.identityType === 'studentId') || {}).identityHash || '';
  const types = (doc && doc.type) || [];
  const out = { name: doc && doc.name, issuer: doc && doc.issuer && doc.issuer.name, issuerId: doc && doc.issuer && doc.issuer.id, holder: who, studentId: sid, validFrom: doc && doc.validFrom, kind: types.includes('ClrCredential') ? 'transcript' : 'degree' };
  if (cs.achievement) { out.achievement = cs.achievement.name; out.results = (cs.result || []).map(r => ({ name: ((cs.achievement.resultDescription || []).find(x => x.id === r.resultDescription) || {}).name || '', value: r.value })); }
  if (Array.isArray(cs.verifiableCredential)) out.courses = cs.verifiableCredential.filter(v => (v.type || []).includes('OpenBadgeCredential') && ((v.credentialSubject || {}).achievement || {}).achievementType === 'Course').length;
  return out;
}

module.exports = { CTX_VC, CTX_OB, CTX_CLR, jcs, b58encode, b58decode, multikeyFromRaw, rawFromMultikey, didKeyFromRaw, generateKey, rawFromPrivatePem, publicKeyObject,
  sign, verify, resolveKey, didWebFor, didDocument, degreeCredential, courseCredential, transcriptCredential, summarize, sha256 };
