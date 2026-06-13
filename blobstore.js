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
const { URL } = require('url');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_KEY = process.env.SUPABASE_KEY || '';
const SUPA_BUCKET = 'unibursar'; // matches the desktop's fixed Supabase bucket
const R2 = { account: process.env.R2_ACCOUNT_ID || '', accessKey: process.env.R2_ACCESS_KEY || '', secret: process.env.R2_SECRET || '', bucket: process.env.R2_BUCKET || 'unibursar' };
const r2Configured = () => !!(R2.account && R2.accessKey && R2.secret);
const supaConfigured = () => !!(SUPA_URL && SUPA_KEY);

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
  const res = await get(SUPA_URL + '/storage/v1/object/' + SUPA_BUCKET + '/' + encKey(key), { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY });
  return (res.status >= 200 && res.status < 300) ? res.buf : null;
}

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
function sha256hex(d) { return crypto.createHash('sha256').update(d).digest('hex'); }
function hmac(k, d) { return crypto.createHmac('sha256', k).update(d).digest(); }
async function r2Get(key) {
  const host = R2.account + '.r2.cloudflarestorage.com';
  const canonicalUri = '/' + R2.bucket + '/' + encKey(key);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const signed = { host, 'x-amz-content-sha256': EMPTY_SHA, 'x-amz-date': amzDate };
  const signedKeys = Object.keys(signed).sort();
  const canonicalHeaders = signedKeys.map(k => k + ':' + String(signed[k]).trim() + '\n').join('');
  const signedHeaders = signedKeys.join(';');
  const canonicalRequest = ['GET', canonicalUri, '', canonicalHeaders, signedHeaders, EMPTY_SHA].join('\n');
  const scope = dateStamp + '/auto/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + R2.secret, dateStamp), 'auto'), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const headers = Object.assign({}, signed, { 'Authorization': 'AWS4-HMAC-SHA256 Credential=' + R2.accessKey + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature });
  const res = await get('https://' + host + canonicalUri, headers);
  return (res.status >= 200 && res.status < 300) ? res.buf : null;
}

/** Resolve a storage key to a Buffer, or null if missing/unconfigured. Never throws. */
async function getBuffer(key) {
  if (!key) return null;
  if (r2Configured()) { try { const b = await r2Get(key); if (b) return b; } catch (_) {} }
  if (supaConfigured()) { try { const b = await supaGet(key); if (b) return b; } catch (_) {} }
  return null;
}

module.exports = { getBuffer, configured: () => r2Configured() || supaConfigured() };
