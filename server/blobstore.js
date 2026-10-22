'use strict';
/**
 * Portal-side READ access to offloaded binaries (counterpart of electron/services/blobstore.js).
 *
 * When the desktop offloads a book/document, the synced row keeps only a tiny key and the bytes live
 * in object storage. The hosted portal resolves that key → Buffer here so it can stream the file to a
 * student (proxied, so the portal's per-student access gate still applies — no public URLs).
 *
 * Credentials come from the host's environment (already set on the sync hub):
 *   • Supabase Storage : SUPABASE_URL + SUPABASE_KEY      (zero extra setup)
 *   • Cloudflare R2    : R2_ACCOUNT_ID + R2_ACCESS_KEY + R2_SECRET (+ optional R2_BUCKET)
 * Both configured backends are tried (R2 first), returning the first hit — so it works regardless of
 * which one the desktop wrote to. Read-only; the portal never writes blobs.
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');

// The desktop uploads compressible files gzip-wrapped behind a 4-byte magic ('UBZ1', see
// electron/services/blobstore.js) so object storage holds more. Un-wrap on read; anything without
// the magic (old objects, already-compressed files) is returned byte-for-byte. Deno's node:zlib
// compat runs this unchanged inside the Edge Function.
function unpackFromStorage(buf) {
  try {
    if (buf && buf.length >= 4 && buf[0] === 0x55 && buf[1] === 0x42 && buf[2] === 0x5a && buf[3] === 0x31)
      return zlib.gunzipSync(buf.subarray(4));
  } catch (_) { /* not really wrapped — return raw */ }
  return buf;
}

// Credentials resolve from a CONFIG GETTER first (the desktop hub pushes its own storage settings to the
// hub — see electron/services/sync.pushStorageConfig + server.js /storage-config), then fall back to the
// host's environment. Without the getter the hub could only read env vars, so a deployment that set up
// object storage on the DESKTOP (Supabase/R2) but never mirrored those creds into the hub env served
// "This document is unavailable" for every offloaded file. The push makes the bytes resolvable with no
// manual env setup — exactly like the payment-gateway keys already work.
let cfgGet = null;
function configure(getter) { cfgGet = (typeof getter === 'function') ? getter : null; }
function cfg(settingKey, envKey) {
  if (cfgGet) { try { const v = cfgGet(settingKey); if (v) return String(v).trim(); } catch (_) {} }
  return (process.env[envKey] || '').trim();
}
const SUPA_BUCKET = 'unibursar'; // matches the desktop's fixed Supabase bucket
function supaUrl() { return cfg('supabase_url', 'SUPABASE_URL').replace(/\/+$/, ''); }
function supaKey() { return cfg('supabase_key', 'SUPABASE_KEY'); }
function r2Creds() {
  return {
    account: cfg('r2_account_id', 'R2_ACCOUNT_ID'),
    accessKey: cfg('r2_access_key', 'R2_ACCESS_KEY'),
    secret: cfg('r2_secret', 'R2_SECRET'),
    bucket: cfg('r2_bucket', 'R2_BUCKET') || 'unibursar',
  };
}
const r2Configured = () => { const c = r2Creds(); return !!(c.account && c.accessKey && c.secret); };
const supaConfigured = () => !!(supaUrl() && supaKey());

function encKey(key) { return String(key).split('/').map(encodeURIComponent).join('/'); }

/** GET `urlStr` with `headers`; resolves { status, buf }. */
function get(urlStr, headers) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: headers || {}, timeout: 60000 }, (res) => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
  });
}

async function supaGet(key) {
  const url = supaUrl(), apiKey = supaKey();
  const res = await get(url + '/storage/v1/object/' + SUPA_BUCKET + '/' + encKey(key), { 'apikey': apiKey, 'Authorization': 'Bearer ' + apiKey });
  return (res.status >= 200 && res.status < 300) ? res.buf : null;
}

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
function sha256hex(d) { return crypto.createHash('sha256').update(d).digest('hex'); }
function hmac(k, d) { return crypto.createHmac('sha256', k).update(d).digest(); }
async function r2Get(key) {
  const c = r2Creds();
  const host = c.account + '.r2.cloudflarestorage.com';
  const canonicalUri = '/' + c.bucket + '/' + encKey(key);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const signed = { host, 'x-amz-content-sha256': EMPTY_SHA, 'x-amz-date': amzDate };
  const signedKeys = Object.keys(signed).sort();
  const canonicalHeaders = signedKeys.map(k => k + ':' + String(signed[k]).trim() + '\n').join('');
  const signedHeaders = signedKeys.join(';');
  const canonicalRequest = ['GET', canonicalUri, '', canonicalHeaders, signedHeaders, EMPTY_SHA].join('\n');
  const scope = dateStamp + '/auto/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + c.secret, dateStamp), 'auto'), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const headers = Object.assign({}, signed, { 'Authorization': 'AWS4-HMAC-SHA256 Credential=' + c.accessKey + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature });
  const res = await get('https://' + host + canonicalUri, headers);
  return (res.status >= 200 && res.status < 300) ? res.buf : null;
}

/** Resolve a storage key to a Buffer, or null if missing/unconfigured. Never throws. */
async function getBuffer(key) {
  if (!key) return null;
  if (r2Configured()) { try { const b = await r2Get(key); if (b) return unpackFromStorage(b); } catch (_) {} }
  if (supaConfigured()) { try { const b = await supaGet(key); if (b) return unpackFromStorage(b); } catch (_) {} }
  return null;
}

// ---- WRITE access, added for class RECORDINGS -------------------------------------------------------
// Historically the hub NEVER wrote blobs (it only resolved keys the desktop had offloaded). Live-class
// recordings are captured browser-side and chunk-uploaded to the hub, so the hub is now the writer: it
// stores each chunk, streams them into one assembled object, and deletes the parts. Recording bytes are
// binary/incompressible (webm) so they are stored RAW — no gzip magic — which reads back byte-for-byte
// through the existing unpack (which passes through anything without the 'UBZ1' magic).

/** A binary request that returns { status, buf }. Used for PUT/DELETE (write side). */
function requestBin(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: headers || {}, timeout: 120000 }, (res) => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body && body.length) req.write(body);
    req.end();
  });
}

/** SigV4-signed headers + URL for an R2 (S3) request. `payloadHash` may be a real sha256 or
 *  'UNSIGNED-PAYLOAD' (used when the body is streamed and its hash is not known up front). */
function r2Sign(method, key, payloadHash, extraHeaders) {
  const c = r2Creds();
  const host = c.account + '.r2.cloudflarestorage.com';
  const canonicalUri = '/' + c.bucket + '/' + encKey(key);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const signed = Object.assign({ host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }, extraHeaders || {});
  const signedKeys = Object.keys(signed).map(k => k.toLowerCase()).sort();
  const lc = {}; for (const k of Object.keys(signed)) lc[k.toLowerCase()] = signed[k];
  const canonicalHeaders = signedKeys.map(k => k + ':' + String(lc[k]).trim() + '\n').join('');
  const signedHeaders = signedKeys.join(';');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/auto/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + c.secret, dateStamp), 'auto'), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const headers = Object.assign({}, signed, { 'Authorization': 'AWS4-HMAC-SHA256 Credential=' + c.accessKey + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature });
  return { headers, url: 'https://' + host + canonicalUri };
}

/** Store a Buffer under `key` (raw bytes). Throws on failure so callers can surface a real error. */
async function put(key, buffer, mime) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
  if (r2Configured()) {
    const { headers, url } = r2Sign('PUT', key, sha256hex(buffer));
    headers['Content-Type'] = mime || 'application/octet-stream'; headers['Content-Length'] = buffer.length;
    const res = await requestBin('PUT', url, headers, buffer);
    if (res.status < 200 || res.status >= 300) throw new Error('R2 upload failed (' + res.status + ')');
    return { key };
  }
  if (supaConfigured()) {
    const url = supaUrl() + '/storage/v1/object/' + SUPA_BUCKET + '/' + encKey(key);
    const hdr = { apikey: supaKey(), Authorization: 'Bearer ' + supaKey(), 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true', 'Content-Length': buffer.length };
    let res = await requestBin('POST', url, hdr, buffer);
    if (res.status === 400 || res.status === 404) {
      await requestBin('POST', supaUrl() + '/storage/v1/bucket', { apikey: supaKey(), Authorization: 'Bearer ' + supaKey(), 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify({ id: SUPA_BUCKET, name: SUPA_BUCKET, public: false }))).catch(() => {});
      res = await requestBin('POST', url, hdr, buffer);
    }
    if (res.status < 200 || res.status >= 300) throw new Error('Supabase Storage upload failed (' + res.status + ')');
    return { key };
  }
  throw new Error('Cloud storage is not configured.');
}

/**
 * Stream an object of known total length into storage WITHOUT holding it all in RAM — the assembly
 * step for a recording, where dozens of part objects become one. `feed(write)` calls `write(buf)` for
 * each part in order (each part is only a few hundred KB); we push it straight onto the wire.
 * R2 signs with UNSIGNED-PAYLOAD (the body hash is not known up front); Supabase takes a streamed POST.
 */
function putStream(key, mime, contentLength, feed) {
  return new Promise((resolve, reject) => {
    let target;
    if (r2Configured()) {
      const s = r2Sign('PUT', key, 'UNSIGNED-PAYLOAD', { 'content-type': mime || 'application/octet-stream' });
      target = { method: 'PUT', url: s.url, headers: Object.assign({}, s.headers, { 'Content-Type': mime || 'application/octet-stream', 'Content-Length': contentLength }) };
    } else if (supaConfigured()) {
      target = { method: 'POST', url: supaUrl() + '/storage/v1/object/' + SUPA_BUCKET + '/' + encKey(key),
        headers: { apikey: supaKey(), Authorization: 'Bearer ' + supaKey(), 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true', 'Content-Length': contentLength } };
    } else { return reject(new Error('Cloud storage is not configured.')); }
    let u; try { u = new URL(target.url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ method: target.method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: target.headers, timeout: 300000 }, (res) => {
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => { (res.statusCode >= 200 && res.statusCode < 300) ? resolve({ key }) : reject(new Error('Storage assembly failed (' + res.statusCode + '): ' + Buffer.concat(chunks).toString().slice(0, 160))); });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    const write = (buf) => new Promise((ok) => { if (!buf || !buf.length) return ok(); req.write(buf, () => ok()); });
    Promise.resolve(feed(write)).then(() => req.end()).catch((e) => { try { req.destroy(); } catch (_) {} reject(e); });
  });
}

/** Fetch a byte range [start,end] of `key` from storage (proxy-stream fallback). Never throws. */
async function getRange(key, start, end) {
  if (!key) return null;
  const range = 'bytes=' + start + '-' + end;
  if (r2Configured()) {
    try { const { headers, url } = r2Sign('GET', key, EMPTY_SHA, { range }); const res = await get(url, Object.assign({}, headers, { Range: range })); if (res.status >= 200 && res.status < 300) return res.buf; } catch (_) {}
  }
  if (supaConfigured()) {
    try { const res = await get(supaUrl() + '/storage/v1/object/' + SUPA_BUCKET + '/' + encKey(key), { apikey: supaKey(), Authorization: 'Bearer ' + supaKey(), Range: range }); if (res.status >= 200 && res.status < 300) return res.buf; } catch (_) {}
  }
  return null;
}

/** Best-effort delete of a stored object (used to clean up recording parts after assembly). Never throws. */
async function del(key) {
  if (!key) return;
  try {
    if (r2Configured()) { const { headers, url } = r2Sign('DELETE', key, EMPTY_SHA); await requestBin('DELETE', url, headers, null); return; }
    if (supaConfigured()) { await requestBin('DELETE', supaUrl() + '/storage/v1/object/' + SUPA_BUCKET + '/' + encKey(key), { apikey: supaKey(), Authorization: 'Bearer ' + supaKey() }, null); }
  } catch (_) {}
}

/** Presigned GET URL (SigV4 query auth) so the BROWSER fetches large static blobs (the biometric
 *  face engine + model weights) DIRECTLY from storage — never proxied through a serverless isolate,
 *  which is far too slow/unreliable for multi-MB files. R2 → SigV4 presign (sync, pure crypto);
 *  Supabase Storage → its own signed-URL API (async). Returns a URL string, a Promise<string|null>,
 *  or null when unconfigured. */
function r2PresignGet(key, expires) {
  const c = r2Creds(); if (!c.account || !c.accessKey || !c.secret) return null;
  const host = c.account + '.r2.cloudflarestorage.com';
  const canonicalUri = '/' + c.bucket + '/' + encKey(key);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = dateStamp + '/auto/s3/aws4_request';
  const q = [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    'X-Amz-Credential=' + encodeURIComponent(c.accessKey + '/' + scope),
    'X-Amz-Date=' + amzDate,
    'X-Amz-Expires=' + (expires || 3600),
    'X-Amz-SignedHeaders=host',
  ].sort().join('&');
  const canonicalRequest = ['GET', canonicalUri, q, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + c.secret, dateStamp), 'auto'), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return 'https://' + host + canonicalUri + '?' + q + '&X-Amz-Signature=' + signature;
}
async function supaSignedUrl(key, expires) {
  const url = supaUrl(), apiKey = supaKey(); if (!url || !apiKey) return null;
  try {
    const body = Buffer.from(JSON.stringify({ expiresIn: expires || 3600 }));
    const res = await new Promise((resolve, reject) => {
      const u = new URL(url + '/storage/v1/object/sign/' + SUPA_BUCKET + '/' + encKey(key));
      const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname, headers: { apikey: apiKey, Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: 20000 }, (r) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(c).toString('utf8') })); });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.write(body); req.end();
    });
    if (res.status < 200 || res.status >= 300) return null;
    const j = JSON.parse(res.body); return j.signedURL ? url + '/storage/v1' + j.signedURL : null;
  } catch (_) { return null; }
}
/** Best available presigned URL for `key`, or null. R2 first (sync), else Supabase Storage (async). */
function presignGet(key, expires) {
  if (!key) return null;
  if (r2Configured()) { const u = r2PresignGet(key, expires); if (u) return u; }
  if (supaConfigured()) return supaSignedUrl(key, expires); // Promise
  return null;
}

/** Storage keys the desktop hub may push so the portal resolves blobs without manual env setup. */
function storageConfigKeys() { return ['storage_backend', 'supabase_url', 'supabase_key', 'r2_account_id', 'r2_access_key', 'r2_secret', 'r2_bucket']; }

module.exports = { getBuffer, getRange, put, putStream, del, presignGet, configure, storageConfigKeys, configured: () => r2Configured() || supaConfigured(),
  backend: () => (r2Configured() ? 'r2' : supaConfigured() ? 'supabase' : null) };
