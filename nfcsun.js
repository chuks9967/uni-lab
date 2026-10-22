'use strict';
/**
 * 📶 NTAG 424 DNA — SUN (Secure Unique NFC, "SDM" in NXP's documents): the chip in the card writes a NEW signed link at every tap,
 *   https://<portal>/n?p=<encrypted PICC data>&m=<SDMMAC>
 * p = AES-128-CBC(K_meta, IV 0) of [tag C7 · UID (7) · read counter (3, LSB first) · random padding]; m = 8 bytes of
 * AES-CMAC(SesSDMFileReadMACKey, MAC input), the session key = CMAC(K_file, 3C C3 00 01 00 80 · UID · counter). A copied chip
 * has no keys and cannot make the next link; a recorded link has a counter that already went by (replay) — so the card cannot be
 * cloned, unlike a plain UID or a static signed record. Checked against NXP AN12196 (tables 1, 2, 4, 5 — the tests).
 *
 * The keys: K_meta is the institution's (one for every card), K_file is DIVERSIFIED per card from its UID, both derived from the
 * institution key — the desk and the portal compute them; nothing per card is stored. The application master key K0 (which locks
 * the chip's settings) is diversified the same way, so a stolen card cannot be re-programmed.
 *   aesCmac · truncMac · sessionKeys · decryptPicc · sdmMac · keysFor · verifySun · parseSun · personalisation
 */
const crypto = require('crypto');

const H = (s) => Buffer.from(String(s).replace(/[^0-9a-f]/gi, ''), 'hex');
function aesEcb(key, block) { const c = crypto.createCipheriv('aes-128-ecb', key, null); c.setAutoPadding(false); return Buffer.concat([c.update(block), c.final()]); }
/** AES-CMAC (RFC 4493). */
function aesCmac(key, msg) {
  const k = Buffer.from(key); const m = Buffer.from(msg || []);
  const L = aesEcb(k, Buffer.alloc(16)); const dbl = (b) => { const o = Buffer.alloc(16); let carry = 0; for (let i = 15; i >= 0; i--) { const v = (b[i] << 1) | carry; o[i] = v & 0xff; carry = (b[i] >> 7) & 1; } if (b[0] & 0x80) o[15] ^= 0x87; return o; };
  const K1 = dbl(L), K2 = dbl(K1); const n = Math.max(1, Math.ceil(m.length / 16)); const full = m.length > 0 && m.length % 16 === 0;
  const last = Buffer.alloc(16); if (full) { m.copy(last, 0, (n - 1) * 16); for (let i = 0; i < 16; i++) last[i] ^= K1[i]; } else { const r = m.slice((n - 1) * 16); r.copy(last); last[r.length] = 0x80; for (let i = 0; i < 16; i++) last[i] ^= K2[i]; }
  let x = Buffer.alloc(16);
  for (let b = 0; b < n - 1; b++) { const blk = m.slice(b * 16, b * 16 + 16); const y = Buffer.alloc(16); for (let i = 0; i < 16; i++) y[i] = x[i] ^ blk[i]; x = aesEcb(k, y); }
  const y = Buffer.alloc(16); for (let i = 0; i < 16; i++) y[i] = x[i] ^ last[i]; return aesEcb(k, y);
}
/** NTAG 424's 8-byte MAC: the odd bytes of the CMAC (S1 S3 … S15). */
function truncMac(m16) { const o = Buffer.alloc(8); for (let i = 0; i < 8; i++) o[i] = m16[2 * i + 1]; return o; }
/** The SDM session keys for a tap (AES mode): { enc, mac } from the file key, the UID (7 bytes) and the counter (3 bytes, LSB first). */
function sessionKeys(fileKey, uid, ctr) {
  const sv = (a, b) => { const s = Buffer.alloc(16); s.set([a, b, 0x00, 0x01, 0x00, 0x80], 0); Buffer.from(uid).copy(s, 6); Buffer.from(ctr).copy(s, 13); return s; };
  return { enc: aesCmac(fileKey, sv(0xC3, 0x3C)), mac: aesCmac(fileKey, sv(0x3C, 0xC3)) };
}
/** The encrypted PICC data → { tag, uid (hex), ctr (Buffer, LSB first), counter (number) } — null when it is not ours. */
function decryptPicc(metaKey, encHex) {
  const e = H(encHex); if (e.length !== 16) return null;
  const d = crypto.createDecipheriv('aes-128-cbc', metaKey, Buffer.alloc(16)); d.setAutoPadding(false); const p = Buffer.concat([d.update(e), d.final()]);
  const tag = p[0]; if (!(tag & 0x80) || !(tag & 0x40) || (tag & 0x0f) !== 7) return null;
  const uid = p.slice(1, 8), ctr = p.slice(8, 11);
  return { tag, uid: uid.toString('hex').toUpperCase(), uidBytes: uid, ctr, counter: ctr[0] | (ctr[1] << 8) | (ctr[2] << 16) };
}
/** The 8-byte SDMMAC of a tap (hex, upper case) over `input` (empty when the MAC input offset = the MAC offset — the cards we set up). */
function sdmMac(fileKey, uid, ctr, input) { return truncMac(aesCmac(sessionKeys(fileKey, uid, ctr).mac, Buffer.from(input || ''))).toString('hex').toUpperCase(); }

/** The keys of the institution's cards, from the institution key: K_meta (all cards) and, for a UID, K_file and K0 (diversified). */
function keysFor(instKey, uidHex) {
  const master = crypto.createHmac('sha256', String(instKey || '')).update('ubu-nfc-sdm-v1').digest();
  const k = (label) => crypto.createHmac('sha256', master).update(label).digest().slice(0, 16);
  const out = { meta: k('meta') };
  if (uidHex) { const u = String(uidHex).toUpperCase(); out.file = k('file|' + u); out.k0 = k('k0|' + u); }
  return out;
}
/** A SUN link (or its query) → { p, m } — null when it is not one. */
function parseSun(text) { const m = /[?&]p=([0-9A-F]{32})&m=([0-9A-F]{16})(?=$|[&#\s])/i.exec(String(text || '')); return m ? { p: m[1].toUpperCase(), m: m[2].toUpperCase() } : null; }
/** ✔ A tap's link checked → { ok, why: 'forged' | 'not_ours' | 'malformed', uid, counter }. The caller checks the counter only grows. */
function verifySun(instKey, text) {
  const s = parseSun(text); if (!s) return { ok: false, why: 'malformed' };
  const keys = keysFor(instKey); const picc = decryptPicc(keys.meta, s.p);
  if (!picc) return { ok: false, why: 'not_ours' };
  const kf = keysFor(instKey, picc.uid).file;
  const want = sdmMac(kf, picc.uidBytes, picc.ctr, '');
  const good = want.length === s.m.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(s.m));
  return good ? { ok: true, uid: picc.uid, counter: picc.counter } : { ok: false, why: 'forged', uid: picc.uid, counter: picc.counter };
}
/** 🛠 How to set a card up (the ICT office, with an NFC encoder app such as NXP TagWriter or the university app): the link with its
 *  placeholders, the byte offsets of the NDEF file (NLEN 2 · record header 4 · URI prefix 1 · the link), the keys for THIS chip. */
function personalisation(instKey, base, uidHex) {
  const b = String(base || '').replace(/\/+$/, ''); const noScheme = b.replace(/^https:\/\//i, '');
  const link = noScheme + '/n?p=' + '0'.repeat(32) + '&m=' + '0'.repeat(16);
  const head = 2 + 4 + 1;   // NLEN · D1 01 <len> 55 · 04 (https://)
  const piccOffset = head + link.indexOf('p=') + 2, macOffset = head + link.indexOf('m=') + 2;
  const k = keysFor(instKey, uidHex); const hx = (x) => (x ? x.toString('hex').toUpperCase() : null);
  // the NDEF file as it is written (the placeholders filled in by the chip at every tap)
  const payload = Buffer.concat([Buffer.from([0x04]), Buffer.from(link, 'ascii')]); const rec = Buffer.concat([Buffer.from([0xD1, 0x01, payload.length, 0x55]), payload]);
  const file = Buffer.concat([Buffer.from([rec.length >> 8, rec.length & 255]), rec]);
  return { url: 'https://' + link, ndef_file_hex: file.toString('hex').toUpperCase(), picc_offset: piccOffset, mac_input_offset: macOffset, mac_offset: macOffset,
    keys: { app_master_k0: hx(k.k0), sdm_meta_read_k1: hx(k.meta), sdm_file_read_k2: hx(k.file) }, access: 'SDM: PICC data mirrored encrypted (K1), SDMMAC (K2) over an empty input (MAC input offset = MAC offset), read counter on, no read counter limit.' };
}

module.exports = { aesCmac, truncMac, sessionKeys, decryptPicc, sdmMac, keysFor, parseSun, verifySun, personalisation, _hex: H };
