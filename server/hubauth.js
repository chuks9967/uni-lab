'use strict';
/**
 * 🔐 HUB AUTH — who may use a sync hub's DATA endpoints (/sync/push, /sync/pull, /sync/reset, /email/send and
 * the desktop's config pushes). They carry EVERY synced record — accounts, payments, results — and the
 * institution's mailbox, so they are never open to the network:
 *
 *   • a sync token is configured  → the caller must present it (X-Sync-Token), compared in constant time;
 *   • no token is configured      → only THIS computer may call (loopback — and not arriving through a
 *                                   tunnel or reverse proxy, which would make the whole internet "local").
 *
 * The portal pages and /api/* are separate: they keep their own per-account sign-in.
 * Pure (no database) — used by the embedded desktop hub (electron/syncserver.js) and the Node hub (server.js).
 */
const crypto = require('crypto');

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'fly-client-ip', 'x-client-ip'];
function peerOf(req) { return String((req && req.socket && req.socket.remoteAddress) || (req && req.connection && req.connection.remoteAddress) || ''); }
function isProxied(req) { const h = (req && req.headers) || {}; return PROXY_HEADERS.some(k => h[k] != null && String(h[k]) !== ''); }
function isLocal(req) { return /^(127\.|::1$|::ffff:127\.)/.test(peerOf(req)) && !isProxied(req); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a)), y = Buffer.from(String(b == null ? '' : b));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
function presented(req) { const h = (req && req.headers) || {}; return String(h['x-sync-token'] || '').trim(); }
/** @param {object} req  node request  @param {string} token  the hub's configured sync token ('' = none) */
function authorized(req, token) {
  const t = String(token == null ? '' : token).trim();
  return t ? safeEqual(presented(req), t) : isLocal(req);
}
/** A fresh strong token (24 url-safe characters). */
function newToken() { return crypto.randomBytes(18).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
const DENIED = 'Unauthorized — this hub needs its sync token. On the hub computer open Administration → Sync to copy it, or give this computer a join code.';

module.exports = { authorized, isLocal, isProxied, safeEqual, presented, newToken, DENIED, PROXY_HEADERS };
