'use strict';
/**
 * 🔐 DOCUMENT VAULT — how a student's issued documents (transcripts, certificates, letters, scans) sit in cloud
 * object storage: COMPRESSED when that genuinely saves space, then ENCRYPTED with AES-256-GCM under a key that
 * is unique to that one file.
 *
 *   stored object = 'UBE1' | iv (12) | auth tag (16) | ciphertext( 'UBZ1' + gzip(bytes)  or  bytes )
 *
 * The per-file key travels in the document's database row (`file_enc`), never beside the file — so the bucket
 * on its own (a leaked R2 key, a mis-set public bucket, the storage provider itself) reveals nothing, and any
 * change to a stored file is detected by the GCM tag instead of being served. Pure + dependency-free
 * (`crypto` + `zlib`), so the desktop, the Node hub and the Supabase Edge portal all read the same format.
 * Objects written before the vault existed (plain, or gzip-wrapped 'UBZ1') still open unchanged.
 */
const crypto = require('crypto');
const zlib = require('zlib');

const E_MAGIC = Buffer.from('UBE1');
const Z_MAGIC = Buffer.from('UBZ1');
const AAD = Buffer.from('ubu-vault-v1');

function unZ(b) {
  if (b && b.length > 4 && b.subarray(0, 4).equals(Z_MAGIC)) { try { return zlib.gunzipSync(b.subarray(4)); } catch (_) { return b; } }
  return b;
}
function isSealed(b) { return !!b && b.length >= 33 && b.subarray(0, 4).equals(E_MAGIC); }

/** Compress (when it saves ≥10%) then encrypt. → { bytes, dek (base64), compressed, original, stored } */
function seal(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || '');
  let inner = buf, compressed = false;
  try {
    if (buf.length >= 512) { const gz = zlib.gzipSync(buf, { level: 9 }); if (gz.length + 4 <= buf.length * 0.9) { inner = Buffer.concat([Z_MAGIC, gz]); compressed = true; } }
  } catch (_) { inner = buf; compressed = false; }
  const dek = crypto.randomBytes(32); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dek, iv); c.setAAD(AAD);
  const enc = Buffer.concat([c.update(inner), c.final()]);
  const bytes = Buffer.concat([E_MAGIC, iv, c.getAuthTag(), enc]);
  return { bytes, dek: dek.toString('base64'), compressed, original: buf.length, stored: bytes.length };
}
/** The original bytes of a stored object. Sealed objects need their key (throws without it, or if the object
 *  was altered); plain and gzip-wrapped legacy objects are returned as they always were. */
function open(buf, dekB64) {
  if (!buf) return null;
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (!isSealed(buf)) return unZ(buf);
  if (!dekB64) throw new Error('This document is encrypted and its key is missing.');
  const dek = Buffer.from(String(dekB64), 'base64'); if (dek.length !== 32) throw new Error('The document key is damaged.');
  const d = crypto.createDecipheriv('aes-256-gcm', dek, buf.subarray(4, 16)); d.setAAD(AAD); d.setAuthTag(buf.subarray(16, 32));
  const inner = Buffer.concat([d.update(buf.subarray(32)), d.final()]);   // throws when the object was tampered with
  return unZ(inner);
}

module.exports = { seal, open, isSealed, E_MAGIC, Z_MAGIC };
