'use strict';
/**
 * 8x8 JaaS (Jitsi-as-a-Service) helper — ZERO dependencies (Node `crypto` only), so it works in the
 * hosted hub, the embedded LAN portal AND the Electron main process without any npm install.
 *
 * Why this exists: the free public `meet.jit.si` now forces the moderator to sign in with Google/etc.
 * to start a room, and guests frequently get no video — so live classes "don't work" after the login.
 * JaaS removes that wall: you mint a short-lived RS256 JWT (signed with the RSA private key you
 * download from the JaaS console) that makes the lecturer the moderator and lets students join as
 * guests — no Google login at all. Self-hosted Jitsi works the same way with its own key.
 *
 * Config blob (from server env on the hosted portal, or app settings on the desktop):
 *   { mode: 'public' | 'jaas' | 'selfhost', domain, jaasAppId, jaasKid, jaasKey }
 *   - jaasAppId  e.g. "vpaas-magic-cookie-xxxxxxxx"   (also the JWT `sub`)
 *   - jaasKid    the API Key ID from the JaaS console (JWT header `kid`)
 *   - jaasKey    the RSA PRIVATE KEY PEM (may arrive with literal "\n" — we un-escape it)
 */
const crypto = require('crypto');

function b64url(input) { return Buffer.from(input).toString('base64url'); }

/** Normalize a PEM that may have been stored with escaped newlines (common in env vars). */
function normalizeKey(key) {
  const s = String(key || '');
  return s.indexOf('\\n') >= 0 ? s.replace(/\\n/g, '\n') : s;
}

/** Mint an 8x8 JaaS / self-hosted RS256 JWT. Returns the token, or '' if config/signing fails. */
function mintJaasJwt(opts = {}) {
  const appId = opts.appId, kid = opts.kid, privateKey = normalizeKey(opts.privateKey);
  if (!appId || !kid || !privateKey) return '';
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (Number(opts.ttlSec) > 0 ? Number(opts.ttlSec) : 3 * 60 * 60); // default 3h
  const u = opts.user || {};
  const mod = u.moderator ? 'true' : 'false';
  const header = { alg: 'RS256', kid, typ: 'JWT' };
  const payload = {
    aud: 'jitsi', iss: 'chat', sub: appId,
    room: opts.room || '*', iat: now, nbf: now - 10, exp,
    context: {
      user: { id: String(u.id || 'guest'), name: String(u.name || 'Guest'), email: String(u.email || ''), avatar: String(u.avatar || ''), moderator: mod },
      features: { livestreaming: mod, recording: mod, transcription: 'true', 'outbound-call': 'false' },
    },
  };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  try {
    const sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
    return signingInput + '.' + b64url(sig);
  } catch (_) { return ''; }
}

/** Resolve a raw config blob to a consistent shape (infers the mode when not set explicitly). */
function jitsiSettings(cfg = {}) {
  const hasJaas = !!(cfg.jaasAppId && cfg.jaasKid && cfg.jaasKey);
  let mode = String(cfg.mode || '').toLowerCase();
  if (!mode) mode = hasJaas ? 'jaas' : ((cfg.domain && cfg.domain !== 'meet.jit.si') ? 'selfhost' : 'public');
  const domain = mode === 'jaas' ? '8x8.vc' : (String(cfg.domain || 'meet.jit.si').replace(/^https?:\/\//, '').replace(/\/+$/, '') || 'meet.jit.si');
  return { mode, domain, jaasAppId: cfg.jaasAppId || '', jaasKid: cfg.jaasKid || '', jaasKey: cfg.jaasKey || '', hasJaas };
}

/** Is a no-Google-login JaaS setup fully configured? */
function jaasReady(cfg) { const s = jitsiSettings(cfg); return s.mode === 'jaas' && s.hasJaas; }

/**
 * Everything the embed page / native SDK needs to JOIN one room:
 *   { domain, roomName, jwt, scriptUrl, mode }
 * For JaaS the roomName is `<appId>/<room>` and a per-user JWT is minted (moderator for the lecturer).
 * For public/self-host there is no JWT (and no Google-login removal — see jaasReady()).
 */
function classEmbed(cfg, info = {}) {
  const s = jitsiSettings(cfg);
  const safeRoom = String(info.room || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80);
  if (s.mode === 'jaas' && s.hasJaas) {
    const jwt = mintJaasJwt({
      appId: s.jaasAppId, kid: s.jaasKid, privateKey: s.jaasKey, room: safeRoom || '*',
      user: { id: info.userId || 'u', name: info.displayName || 'Guest', email: info.email || '', moderator: !!info.moderator },
    });
    return { domain: '8x8.vc', roomName: s.jaasAppId + '/' + safeRoom, jwt, scriptUrl: 'https://8x8.vc/' + s.jaasAppId + '/external_api.js', mode: 'jaas' };
  }
  return { domain: s.domain, roomName: safeRoom, jwt: '', scriptUrl: 'https://' + s.domain + '/external_api.js', mode: s.mode };
}

module.exports = { mintJaasJwt, jitsiSettings, jaasReady, classEmbed, normalizeKey };
