'use strict';
/**
 * 📶 LOW-BANDWIDTH HTTP for the Node hosts of the portal (the campus LAN hub inside the desktop app, and the hosted
 * hub). The cloud edge already gzips; these did not — and the portal page (all of its screens, inline) is ~600 KB.
 *
 *   gzip      every compressible response (HTML, JSON, JS, CSS, SVG) of 1 KB or more, when the client accepts it —
 *             browsers and the app's OkHttp do. ~4–5× smaller. A large body that is the same for everyone (the
 *             portal page) is compressed ONCE and served from memory.
 *   ETag/304  a large page or script carries a fingerprint; a phone that already has it asks "changed?" and gets an
 *             empty 304 instead of the whole page again (Cache-Control: no-cache — always checked, never stale).
 *
 * wrap(req, res) intercepts writeHead/end until the response is finished, then puts the originals back — Node's own
 * end() calls writeHead internally, and streamed responses (write) pass straight through untouched.
 */
const zlib = require('zlib');
const crypto = require('crypto');

const COMPRESSIBLE = /html|json|javascript|css|text\/plain|svg|xml|manifest/i;
const memo = new Map();   // sha1 of a big body → its gzip (the portal page, the class page script…)
const remember = (k, v) => { memo.set(k, v); if (memo.size > 16) memo.delete(memo.keys().next().value); };
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('base64url');

function wrap(req, res) {
  const acceptGz = /\bgzip\b/i.test(String((req.headers && req.headers['accept-encoding']) || ''));
  const inm = String((req.headers && req.headers['if-none-match']) || '');
  const isGet = req.method === 'GET' || req.method === 'HEAD';
  const orig = { writeHead: res.writeHead, end: res.end, write: res.write };
  let status = 200, hdrs = null;
  const restore = () => { res.writeHead = orig.writeHead; res.end = orig.end; res.write = orig.write; };
  const flush = () => { if (hdrs) { const h = hdrs; hdrs = null; orig.writeHead.call(res, status, h); } };
  res.writeHead = function (code, a, b) {
    status = code; const h = (a && typeof a === 'object') ? a : ((b && typeof b === 'object') ? b : {});
    hdrs = Object.assign(hdrs || {}, h); return res;
  };
  res.write = function (...args) { restore(); flush(); return orig.write.apply(res, args); };   // a stream: no rewriting
  res.end = function (body, ...rest) {
    restore();
    if (!hdrs) return orig.end.call(res, body, ...rest);           // headers set another way (setHeader) — untouched
    try {
      const get = (k) => { for (const key of Object.keys(hdrs)) if (key.toLowerCase() === k) return hdrs[key]; return res.getHeader ? res.getHeader(k) : undefined; };
      const drop = (k) => { for (const key of Object.keys(hdrs)) if (key.toLowerCase() === k) delete hdrs[key]; };
      const ct = String(get('content-type') || '');
      let buf = body == null ? null : Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body, typeof rest[0] === 'string' ? rest[0] : 'utf8') : null;
      let key = null;
      // ETag: big pages and scripts only (JSON answers change constantly and already have their own "same" signatures)
      if (buf && isGet && status === 200 && buf.length >= 4096 && /html|javascript|css/i.test(ct) && !get('etag') && !/no-store/i.test(String(get('cache-control') || ''))) {
        key = sha(buf); const tag = 'W/"' + key.slice(0, 22) + '"';
        hdrs.ETag = tag; if (!get('cache-control')) hdrs['Cache-Control'] = 'no-cache';
        if (inm && inm.split(/\s*,\s*/).includes(tag)) {
          drop('content-length'); drop('content-type'); const h = hdrs; hdrs = null;
          orig.writeHead.call(res, 304, h); return orig.end.call(res);
        }
      }
      if (buf && acceptGz && buf.length >= 1024 && COMPRESSIBLE.test(ct) && !get('content-encoding') && status !== 204 && status !== 304) {
        let gz = null; const mk = buf.length > 32768 ? (key || sha(buf)) : null;
        if (mk && memo.has(mk)) gz = memo.get(mk); else { gz = zlib.gzipSync(buf, { level: 6 }); if (mk) remember(mk, gz); }
        if (gz.length < buf.length) { buf = gz; hdrs['Content-Encoding'] = 'gzip'; const v = get('vary'); drop('vary'); hdrs.Vary = v ? v + ', Accept-Encoding' : 'Accept-Encoding'; drop('content-length'); }
      }
      if (buf && !get('content-length')) hdrs['Content-Length'] = String(buf.length);
      flush();
      return req.method === 'HEAD' ? orig.end.call(res) : orig.end.call(res, buf == null ? body : buf);
    } catch (_) { flush(); return orig.end.call(res, body, ...rest); }
  };
  return restore;   // for a request the portal did not handle (the next handler gets the untouched response)
}

module.exports = { wrap, COMPRESSIBLE };
