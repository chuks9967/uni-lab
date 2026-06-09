'use strict';
/**
 * Firebase Cloud Messaging — HTTP v1 sender. Zero external dependencies: it mints an OAuth2 access
 * token from a Google service-account JSON (a JWT signed with the SA private key, exchanged at the
 * Google token endpoint) and POSTs to the FCM v1 endpoint.
 *
 * Configure the HOSTED portal with EITHER:
 *   FCM_SERVICE_ACCOUNT       = absolute path to the service-account JSON file, OR
 *   FCM_SERVICE_ACCOUNT_JSON  = the service-account JSON itself (handy on env-only hosts like Render).
 * Get this from Firebase Console → Project settings → Service accounts → Generate new private key.
 *
 * When nothing is configured every call is a safe no-op ({ ok:false, disabled:true }), so the portal
 * runs perfectly without Firebase — pushes simply don't fire until credentials are added.
 */
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

let _sa; // undefined = not loaded, false = none, object = loaded
function serviceAccount() {
  if (_sa !== undefined) return _sa || null;
  try {
    let raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (!raw && process.env.FCM_SERVICE_ACCOUNT) raw = fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT, 'utf8');
    // Fallback: a service-account JSON shipped next to the server, so a plain `server/` upload to
    // Cloud Run / cPanel can send pushes with NO env-var setup. Env vars still take precedence.
    if (!raw) { try { const p = require('path').join(__dirname, 'fcm-service-account.json'); if (fs.existsSync(p)) raw = fs.readFileSync(p, 'utf8'); } catch (_) {} }
    const sa = raw ? JSON.parse(raw) : null;
    _sa = (sa && sa.client_email && sa.private_key && sa.project_id) ? sa : false;
  } catch (_) { _sa = false; }
  return _sa || null;
}
function configured() { return !!serviceAccount(); }

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function httpsPost(host, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = https.request({ host, path, method: 'POST', headers: Object.assign({ 'Content-Length': data.length }, headers) }, (res) => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => { let json = null; try { json = JSON.parse(out || '{}'); } catch (_) {} resolve({ status: res.statusCode, json, raw: out }); });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

let _tok = { token: null, exp: 0 };
async function accessToken() {
  const sa = serviceAccount(); if (!sa) throw new Error('FCM not configured');
  if (_tok.token && Date.now() < _tok.exp - 60000) return _tok.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256'); signer.update(header + '.' + claim);
  const jwt = header + '.' + claim + '.' + b64url(signer.sign(sa.private_key));
  const body = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt;
  const r = await httpsPost('oauth2.googleapis.com', '/token', body, { 'Content-Type': 'application/x-www-form-urlencoded' });
  if (!r.json || !r.json.access_token) throw new Error('FCM token exchange failed (' + r.status + ')');
  _tok = { token: r.json.access_token, exp: Date.now() + (Number(r.json.expires_in) || 3600) * 1000 };
  return _tok.token;
}

// FCM data values must be strings
function stringifyData(data) { const o = {}; for (const k of Object.keys(data || {})) if (data[k] != null) o[k] = String(data[k]); return o; }

/** Send one notification to many device tokens. Returns { ok, sent, total } (or { disabled:true }). */
async function sendToTokens(tokens, notification, data) {
  const sa = serviceAccount(); if (!sa) return { ok: false, disabled: true };
  const list = (tokens || []).filter(Boolean);
  if (!list.length) return { ok: true, sent: 0, total: 0 };
  let access; try { access = await accessToken(); } catch (e) { return { ok: false, error: e.message }; }
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + access };
  let sent = 0; const stale = [];
  await Promise.all(list.map(async (tk) => {
    const msg = { message: {
      token: tk,
      notification: { title: notification.title || 'Update', body: notification.body || '' },
      data: stringifyData(data),
      android: { priority: 'high', notification: { channel_id: 'ubu-updates' } },
    } };
    try {
      const r = await httpsPost('fcm.googleapis.com', '/v1/projects/' + sa.project_id + '/messages:send', JSON.stringify(msg), headers);
      if (r.status >= 200 && r.status < 300) sent++;
      else if (r.status === 404 || r.status === 400) stale.push(tk); // unregistered / invalid token
    } catch (_) { /* network blip — ignore */ }
  }));
  return { ok: true, sent, total: list.length, stale };
}

module.exports = { configured, sendToTokens };
