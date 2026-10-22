'use strict';
/**
 * 🔐 OIDC SINGLE SIGN-ON — the enterprise-mandatory feature: students and staff sign in with the
 * institution's OWN identity provider (Microsoft Entra ID, Google Workspace, Okta, Keycloak, or any
 * standards-compliant OpenID Connect provider) instead of a portal-local password.
 *
 * This module is PURE OIDC PROTOCOL (zero npm deps — Node `crypto` + `https`, so it runs unchanged on
 * the Node hub AND the Supabase Edge Deno runtime, exactly like payments-gateway.js). It does the
 * authorization-code flow with PKCE:
 *
 *   discover(issuer)              → the provider's endpoints (.well-known/openid-configuration), cached
 *   pkce()                        → { verifier, challenge } (S256)
 *   authUrl(disco, cfg, params)   → the provider authorization URL to redirect the browser to
 *   exchange(disco, cfg, params)  → swap the returned code for tokens (server-to-server, confidential)
 *   verifyIdToken(disco, cfg, …)  → RS256-verify the id_token against the provider JWKS + check claims
 *
 * State/nonce/PKCE-verifier survive the browser round-trip inside a SIGNED, short-lived state param
 * (the portal signs it with its existing HMAC key), so nothing is kept server-side — the flow works
 * across stateless, multi-isolate Edge deployments with no shared session store.
 *
 * SECURITY POSTURE: SSO AUTHENTICATES an already-provisioned account; it never auto-creates one. The
 * verified email (or a configured claim) is matched to an existing student/staff/officer record. An
 * optional domain allow-list rejects tokens from outside the institution's tenant.
 */
const https = require('https');
const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ---------------------------------------------------------------------------
// low-level HTTPS GET/POST (JSON or form) — mirrors payments-gateway.httpReq so edge-compat is proven
// ---------------------------------------------------------------------------
function httpReq(o) {
  return new Promise((resolve) => {
    try {
      const url = new URL(o.url);
      let data = null, ctype = 'application/json';
      if (o.form) { data = Buffer.from(formEncode(o.form)); ctype = 'application/x-www-form-urlencoded'; }
      const headers = Object.assign({ 'Accept': 'application/json' }, o.headers || {});
      if (data) { headers['Content-Type'] = ctype; headers['Content-Length'] = data.length; }
      const req = https.request({ hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: o.method || 'GET', headers, timeout: o.timeout || 15000 }, (resp) => {
        let b = ''; resp.on('data', d => b += d); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, json: j, raw: b }); });
      });
      req.on('error', () => resolve({ status: 0, json: null, raw: '' }));
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, json: null, raw: '' }); });
      if (data) req.write(data); req.end();
    } catch (_) { resolve({ status: 0, json: null, raw: '' }); }
  });
}
function formEncode(obj) { return Object.keys(obj || {}).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] == null ? '' : obj[k])).join('&'); }

// ---------------------------------------------------------------------------
// discovery + JWKS caches (short TTL so a rotated key is picked up within minutes)
// ---------------------------------------------------------------------------
const discoCache = new Map();   // issuer → { at, doc }
const jwksCache = new Map();     // jwks_uri → { at, keys }
const TTL = 10 * 60 * 1000;

/** Normalise an issuer to a discovery URL. Accepts a bare issuer or a full well-known URL. */
function discoveryUrl(issuer) {
  let s = String(issuer || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/\/\.well-known\/openid-configuration$/.test(s)) return s;
  return s + '/.well-known/openid-configuration';
}

async function discover(issuer) {
  const key = String(issuer || '').trim();
  const cached = discoCache.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.doc;
  const url = discoveryUrl(issuer);
  if (!url) throw new Error('SSO is not configured (no issuer).');
  const r = await httpReq({ url, method: 'GET' });
  if (r.status !== 200 || !r.json || !r.json.authorization_endpoint || !r.json.token_endpoint) {
    throw new Error('Could not read the identity provider configuration. Check the issuer URL.');
  }
  const doc = {
    issuer: r.json.issuer || key,
    authorization_endpoint: r.json.authorization_endpoint,
    token_endpoint: r.json.token_endpoint,
    jwks_uri: r.json.jwks_uri,
    userinfo_endpoint: r.json.userinfo_endpoint || '',
    end_session_endpoint: r.json.end_session_endpoint || '',
  };
  discoCache.set(key, { at: Date.now(), doc });
  return doc;
}

async function jwksKeys(jwksUri) {
  const cached = jwksCache.get(jwksUri);
  if (cached && Date.now() - cached.at < TTL) return cached.keys;
  const r = await httpReq({ url: jwksUri, method: 'GET' });
  const keys = (r.json && Array.isArray(r.json.keys)) ? r.json.keys : [];
  jwksCache.set(jwksUri, { at: Date.now(), keys });
  return keys;
}

/** PKCE S256 pair. verifier stays server-side (in the signed state); challenge goes to the provider. */
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Build the provider authorization URL. `params` = { clientId, redirectUri, state, nonce, challenge, scope, loginHint, prompt }. */
function authUrl(disco, cfg, params) {
  const scope = String(cfg.scope || 'openid email profile').trim();
  const q = new URLSearchParams({
    client_id: params.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope,
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
  });
  if (params.prompt) q.set('prompt', params.prompt);
  if (params.loginHint) q.set('login_hint', params.loginHint);
  // Entra needs response_mode=query to return the code on the redirect (default for code flow, set explicitly)
  q.set('response_mode', 'query');
  return disco.authorization_endpoint + (disco.authorization_endpoint.includes('?') ? '&' : '?') + q.toString();
}

/** Exchange the authorization code for tokens (confidential client: client_secret + PKCE verifier). */
async function exchange(disco, cfg, params) {
  const form = {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: cfg.client_id,
    code_verifier: params.verifier,
  };
  if (cfg.client_secret) form.client_secret = cfg.client_secret;
  const r = await httpReq({ url: disco.token_endpoint, method: 'POST', form });
  if (r.status !== 200 || !r.json || (!r.json.id_token && !r.json.access_token)) {
    return { error: (r.json && (r.json.error_description || r.json.error)) || ('token endpoint returned ' + r.status) };
  }
  return { id_token: r.json.id_token, access_token: r.json.access_token, token_type: r.json.token_type };
}

/** Decode a JWT WITHOUT verifying — used only to read the header (kid/alg) before verification. */
function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(b64urlDecode(parts[0]).toString('utf8')),
      payload: JSON.parse(b64urlDecode(parts[1]).toString('utf8')),
      signingInput: parts[0] + '.' + parts[1],
      signature: b64urlDecode(parts[2]),
    };
  } catch (_) { return null; }
}

/**
 * RS256-verify an id_token against the provider JWKS and validate the standard claims.
 * Returns { ok, claims } or { ok:false, error }.  Checks: signature, iss, aud, exp/nbf, nonce.
 */
async function verifyIdToken(disco, cfg, idToken, opts = {}) {
  const jwt = decodeJwt(idToken);
  if (!jwt) return { ok: false, error: 'The identity token was malformed.' };
  const alg = jwt.header.alg;
  if (alg !== 'RS256' && alg !== 'RS384' && alg !== 'RS512') return { ok: false, error: 'Unsupported token signing algorithm: ' + alg };
  const keys = await jwksKeys(disco.jwks_uri);
  const jwk = keys.find(k => k.kid === jwt.header.kid) || keys.find(k => k.kty === 'RSA');
  if (!jwk) return { ok: false, error: 'The provider signing key was not found.' };
  let verified = false;
  try {
    const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const hash = 'RSA-SHA' + alg.slice(2);
    verified = crypto.verify(hash, Buffer.from(jwt.signingInput), pub, jwt.signature);
  } catch (e) { return { ok: false, error: 'Signature verification failed.' }; }
  if (!verified) return { ok: false, error: 'The identity token signature is invalid.' };
  const c = jwt.payload;
  // issuer: allow the discovery issuer (Entra's discovery iss carries the tenant, which must match)
  if (disco.issuer && c.iss && c.iss.replace(/\/+$/, '') !== String(disco.issuer).replace(/\/+$/, '')) {
    // Entra "common" tenant special-case: the discovery iss has a {tenantid} placeholder
    if (!(String(disco.issuer).includes('{tenantid}') && /login\.microsoftonline\.com/.test(c.iss))) {
      return { ok: false, error: 'The token issuer did not match the configured provider.' };
    }
  }
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(cfg.client_id)) return { ok: false, error: 'The token was not issued for this application.' };
  const now = Math.floor(Date.now() / 1000);
  if (c.exp && now > c.exp + 60) return { ok: false, error: 'The identity token has expired.' };
  if (c.nbf && now < c.nbf - 60) return { ok: false, error: 'The identity token is not yet valid.' };
  if (opts.nonce && c.nonce && c.nonce !== opts.nonce) return { ok: false, error: 'The token nonce did not match (possible replay).' };
  return { ok: true, claims: c };
}

/** Pull the sign-in identity out of verified claims: { email, name, sub, username }. */
function identityFromClaims(claims, cfg) {
  const emailClaim = String(cfg.email_claim || 'email');
  const email = String(claims[emailClaim] || claims.email || claims.preferred_username || claims.upn || '').trim().toLowerCase();
  const name = String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || '').trim();
  const username = String(claims.preferred_username || claims.upn || email || '').trim().toLowerCase();
  return { email, name, sub: String(claims.sub || ''), username };
}

/** Enforce an optional domain allow-list (comma/space separated) against the sign-in email. */
function domainAllowed(email, cfg) {
  const list = String(cfg.allowed_domains || '').split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const dom = String(email || '').split('@')[1] || '';
  return list.some(d => dom === d || dom.endsWith('.' + d));
}

/** Preset provider hints for the desktop config UI. */
const PROVIDERS = [
  { key: 'entra', label: 'Microsoft Entra ID (Azure AD / Office 365)', issuerHint: 'https://login.microsoftonline.com/<TENANT-ID>/v2.0', scope: 'openid email profile' },
  { key: 'google', label: 'Google Workspace', issuerHint: 'https://accounts.google.com', scope: 'openid email profile' },
  { key: 'okta', label: 'Okta', issuerHint: 'https://<your-org>.okta.com', scope: 'openid email profile' },
  { key: 'oidc', label: 'Other (generic OpenID Connect)', issuerHint: 'https://id.example.edu', scope: 'openid email profile' },
];

module.exports = {
  discover, jwksKeys, pkce, authUrl, exchange, verifyIdToken, decodeJwt,
  identityFromClaims, domainAllowed, discoveryUrl, PROVIDERS,
  _httpReq: httpReq, _b64url: b64url,
};
