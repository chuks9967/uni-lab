'use strict';
/**
 * 🔐 SAML 2.0 SERVICE PROVIDER — the other half of enterprise single sign-on. Universities on
 * Microsoft Entra ID, Google Workspace, ADFS, Shibboleth or Okta often mandate SAML rather than OIDC;
 * this module implements the SP side of the Web Browser SSO profile with ZERO npm deps (Node `crypto`
 * + `zlib` only), so it runs unchanged on the Node hub AND the Supabase Edge Deno runtime — exactly
 * like sso.js (OIDC) and payments-gateway.js.
 *
 *   authnRequestUrl(cfg, opts)  → the IdP redirect URL (HTTP-Redirect binding: deflate+base64 request)
 *   spMetadataXml(cfg)          → SP metadata the IdP admin uploads (entityID + ACS location)
 *   consumeResponse(b64, cfg, expect) → decode + XML-DSig-VERIFY + validate a POSTed SAMLResponse and
 *                                  return the asserted identity { email, name, sub, attributes }
 *
 * The verifier implements the subset of XML-DSig that every mainstream IdP emits: enveloped-signature
 * + exclusive canonicalization (with or without an InclusiveNamespaces PrefixList) and RSA-SHA256/512/1.
 * SECURITY POSTURE:
 *   • DTDs are rejected outright (no XXE / entity expansion surface).
 *   • Only the CONFIGURED IdP certificate verifies signatures — KeyInfo inside the response is ignored.
 *   • The signature must cover the Response root or the one Assertion we consume (node identity, not
 *     string matching), and a response carrying MORE than one Assertion is refused — this closes the
 *     classic signature-wrapping family of attacks.
 *   • Conditions (NotBefore/NotOnOrAfter ± clock-skew), AudienceRestriction, Recipient and
 *     InResponseTo are all enforced; unsolicited responses are refused.
 */
const crypto = require('crypto');
const zlib = require('zlib');

const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const NS_ASSERT = 'urn:oasis:names:tc:SAML:2.0:assertion';
const NS_PROTO = 'urn:oasis:names:tc:SAML:2.0:protocol';
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';

// ---------------------------------------------------------------------------
// A tiny, strict, non-validating XML parser → element tree. No DTDs, ever.
// Node: { el:true, name, prefix, local, attrs:[{name,prefix,local,value}], children:[], parent }
// Text: { text:'…' }   (entities decoded; re-encoded by the canonicalizer)
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') { const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] != null ? { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] : m;
  });
}
function splitName(name) { const i = name.indexOf(':'); return i < 0 ? { prefix: '', local: name } : { prefix: name.slice(0, i), local: name.slice(i + 1) }; }

function parseXml(text) {
  let s = String(text || '').replace(/^﻿/, '');
  if (/<!DOCTYPE/i.test(s)) throw new Error('DTDs are not allowed in a SAML message.');
  s = s.replace(/<\?[\s\S]*?\?>/g, '');                    // drop the XML declaration / PIs
  s = s.replace(/<!--[\s\S]*?-->/g, '');                   // drop comments (c14n is the no-comments variant)
  const root = { el: true, name: '#root', prefix: '', local: '#root', attrs: [], children: [], parent: null };
  let cur = root, i = 0;
  const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { const t = s.slice(i); if (t.trim() || t) cur.children.push({ text: decodeEntities(t) }); break; }
    if (lt > i) cur.children.push({ text: decodeEntities(s.slice(i, lt)) });
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt);
      if (end < 0) throw new Error('Unterminated CDATA.');
      cur.children.push({ text: s.slice(lt + 9, end) });
      i = end + 3; continue;
    }
    const gt = s.indexOf('>', lt);
    if (gt < 0) throw new Error('Malformed XML (unterminated tag).');
    const raw = s.slice(lt + 1, gt);
    if (raw[0] === '/') {                                   // closing tag
      const nm = raw.slice(1).trim();
      if (cur.name !== nm) throw new Error(`Mismatched XML tags (<${cur.name}> closed by </${nm}>).`);
      cur = cur.parent;
      i = gt + 1; continue;
    }
    const selfClose = /\/\s*$/.test(raw);
    const body = selfClose ? raw.replace(/\/\s*$/, '') : raw;
    const sp = body.search(/[\s]/);
    const name = (sp < 0 ? body : body.slice(0, sp)).trim();
    if (!name || /[<>"']/.test(name)) throw new Error('Malformed XML tag name.');
    const el = { el: true, name, ...splitName(name), attrs: [], children: [], parent: cur };
    if (sp >= 0) {
      attrRe.lastIndex = 0;
      let m; const attrsRaw = body.slice(sp);
      while ((m = attrRe.exec(attrsRaw))) el.attrs.push({ name: m[1], ...splitName(m[1]), value: decodeEntities(m[3] != null ? m[3] : m[4]) });
    }
    cur.children.push(el);
    if (!selfClose) cur = el;
    i = gt + 1;
  }
  if (cur !== root) throw new Error('Malformed XML (unclosed <' + cur.name + '>).');
  const rootEl = root.children.find(c => c.el);
  if (!rootEl) throw new Error('No XML root element.');
  return rootEl;
}

// ---------------------------------------------------------------------------
// canonicalization (exclusive c14n, no comments — plus an inclusive mode for
// documents whose signatures declare the older REC-xml-c14n algorithm)
// ---------------------------------------------------------------------------
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

/** The namespace URI a prefix resolves to at `el` (walking the ORIGINAL tree upward). */
function nsLookup(el, prefix) {
  for (let n = el; n && n.el; n = n.parent) {
    for (const a of n.attrs || []) {
      if (prefix === '' && a.name === 'xmlns') return a.value;
      if (a.prefix === 'xmlns' && a.local === prefix) return a.value;
    }
  }
  return undefined;
}
/** Every prefix declared in scope at `el` (for inclusive c14n). */
function nsInScope(el) {
  const out = new Map();
  const chain = [];
  for (let n = el; n && n.el; n = n.parent) chain.unshift(n);
  for (const n of chain) for (const a of n.attrs || []) {
    if (a.name === 'xmlns') out.set('', a.value);
    else if (a.prefix === 'xmlns') out.set(a.local, a.value);
  }
  return out;
}

/**
 * Canonicalize `node` (a document subset rooted there). opts:
 *   mode: 'exc' | 'inc'   inclusivePrefixes: []   omit: a node to skip entirely (enveloped signature)
 */
function c14n(node, opts = {}) {
  const mode = opts.mode || 'exc';
  const inclusive = new Set(opts.inclusivePrefixes || []);
  const omit = opts.omit || null;
  function render(el, nsRendered) {
    if (el === omit) return '';
    if (!el.el) return escText(el.text);
    let out = '<' + el.name;
    // ---- namespace nodes ----
    const nsOut = [];
    if (mode === 'exc') {
      const visible = new Set([el.prefix]);
      for (const a of el.attrs) if (a.prefix && a.prefix !== 'xmlns' && a.name !== 'xmlns') visible.add(a.prefix);
      for (const p of inclusive) visible.add(p);
      for (const p of [...visible].sort()) {
        if (p === 'xml') continue;                                  // the xml prefix is never re-declared
        const uri = nsLookup(el, p);
        if (uri === undefined) { if (p === '' && nsRendered.get('') ) nsOut.push(['', '']); continue; }
        if (nsRendered.get(p) !== uri) nsOut.push([p, uri]);
      }
    } else {
      for (const [p, uri] of [...nsInScope(el).entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
        if (p === 'xml') continue;
        if (nsRendered.get(p) !== uri) nsOut.push([p, uri]);
      }
    }
    const nsNow = new Map(nsRendered);
    for (const [p, uri] of nsOut) nsNow.set(p, uri);
    nsOut.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    for (const [p, uri] of nsOut) out += p ? ` xmlns:${p}="${escAttr(uri)}"` : ` xmlns="${escAttr(uri)}"`;
    // ---- attributes (sorted by namespace URI then local name; unqualified first) ----
    const plain = el.attrs.filter(a => a.name !== 'xmlns' && a.prefix !== 'xmlns');
    const keyed = plain.map(a => ({ a, uri: a.prefix ? (a.prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : (nsLookup(el, a.prefix) || '')) : '' }));
    keyed.sort((x, y) => x.uri < y.uri ? -1 : x.uri > y.uri ? 1 : x.a.local < y.a.local ? -1 : x.a.local > y.a.local ? 1 : 0);
    for (const { a } of keyed) out += ` ${a.name}="${escAttr(a.value)}"`;
    out += '>';
    for (const ch of el.children) out += render(ch, nsNow);
    return out + '</' + el.name + '>';
  }
  return render(node, new Map());
}

// ---------------------------------------------------------------------------
// tree helpers
// ---------------------------------------------------------------------------
function walk(el, fn) { fn(el); for (const c of el.children || []) if (c.el) walk(c, fn); }
function findAll(root, local, ns) {
  const out = [];
  walk(root, (n) => { if (n.local === local && (!ns || nsLookup(n, n.prefix) === ns)) out.push(n); });
  return out;
}
function childEl(el, local, ns) { return (el.children || []).find(c => c.el && c.local === local && (!ns || nsLookup(c, c.prefix) === ns)) || null; }
function textOf(el) { if (!el) return ''; let t = ''; for (const c of el.children || []) t += c.el ? textOf(c) : c.text; return t.trim(); }
function attrOf(el, name) { const a = (el && el.attrs || []).find(x => x.name === name || x.local === name); return a ? a.value : ''; }
function findById(root, id) {
  let hit = null;
  walk(root, (n) => { if (hit) return; for (const a of n.attrs || []) if ((a.name === 'ID' || a.name === 'Id' || a.name === 'id' || a.name === 'AssertionID') && a.value === id) { hit = n; return; } });
  return hit;
}

// ---------------------------------------------------------------------------
// XML-DSig verification
// ---------------------------------------------------------------------------
const HASHES = {
  'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256',
  'http://www.w3.org/2000/09/xmldsig#sha1': 'sha1',
  'http://www.w3.org/2001/04/xmlenc#sha512': 'sha512',
};
const SIG_ALGS = {
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'RSA-SHA256',
  'http://www.w3.org/2000/09/xmldsig#rsa-sha1': 'RSA-SHA1',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'RSA-SHA512',
};
function c14nModeOf(alg) {
  if (/xml-exc-c14n/.test(alg || '')) return 'exc';
  if (/REC-xml-c14n/.test(alg || '')) return 'inc';
  return 'exc';
}

/** Accept a PEM certificate, a PEM public key, or a bare base64 DER certificate (as IdP portals hand out). */
function publicKeyFrom(certOrKey) {
  const s = String(certOrKey || '').trim();
  if (!s) throw new Error('No identity-provider certificate is configured.');
  if (/BEGIN (RSA )?PUBLIC KEY/.test(s)) return crypto.createPublicKey(s);
  let pem = s;
  if (!/BEGIN CERTIFICATE/.test(s)) {
    const b64 = s.replace(/\s+/g, '');
    pem = '-----BEGIN CERTIFICATE-----\n' + (b64.match(/.{1,64}/g) || []).join('\n') + '\n-----END CERTIFICATE-----\n';
  }
  return new crypto.X509Certificate(pem).publicKey;
}

/**
 * Verify every enveloped signature in the document against the CONFIGURED cert.
 * Returns { verified: [node, …] } — the elements whose signatures checked out — or throws on none.
 */
function verifySignatures(root, certOrKey) {
  const pub = publicKeyFrom(certOrKey);
  const sigs = findAll(root, 'Signature', NS_DSIG);
  const verified = [];
  const errors = [];
  for (const sig of sigs) {
    try {
      const si = childEl(sig, 'SignedInfo', NS_DSIG);
      if (!si) throw new Error('SignedInfo missing');
      const c14nAlg = attrOf(childEl(si, 'CanonicalizationMethod', NS_DSIG), 'Algorithm');
      const sigAlg = SIG_ALGS[attrOf(childEl(si, 'SignatureMethod', NS_DSIG), 'Algorithm')];
      if (!sigAlg) throw new Error('unsupported signature algorithm');
      const ref = childEl(si, 'Reference', NS_DSIG);
      if (!ref) throw new Error('Reference missing');
      const uri = attrOf(ref, 'URI');
      const digestAlg = HASHES[attrOf(childEl(ref, 'DigestMethod', NS_DSIG), 'Algorithm')];
      if (!digestAlg) throw new Error('unsupported digest algorithm');
      const digestVal = textOf(childEl(ref, 'DigestValue', NS_DSIG)).replace(/\s+/g, '');
      // transforms: enveloped + exc-c14n (± InclusiveNamespaces)
      let refMode = 'exc', inclusivePrefixes = [], enveloped = false;
      const transforms = childEl(ref, 'Transforms', NS_DSIG);
      for (const t of (transforms && transforms.children || []).filter(c => c.el && c.local === 'Transform')) {
        const alg = attrOf(t, 'Algorithm');
        if (/enveloped-signature/.test(alg)) enveloped = true;
        else { refMode = c14nModeOf(alg);
          const inc = (t.children || []).find(c => c.el && c.local === 'InclusiveNamespaces');
          if (inc) inclusivePrefixes = attrOf(inc, 'PrefixList').split(/\s+/).filter(Boolean);
        }
      }
      const target = uri ? findById(root, uri.replace(/^#/, '')) : root;
      if (!target) throw new Error('signature reference target not found');
      if (!enveloped && uri) {
        // a non-enveloped ref over an element that CONTAINS this signature still needs the omit
        let inside = false; for (let n = sig; n; n = n.parent) if (n === target) { inside = true; break; }
        enveloped = inside;
      }
      const bytes = Buffer.from(c14n(target, { mode: refMode, inclusivePrefixes, omit: enveloped ? sig : null }), 'utf8');
      const digest = crypto.createHash(digestAlg).update(bytes).digest('base64');
      if (digest !== digestVal) throw new Error('digest mismatch — the signed content was altered');
      // SignedInfo c14n + RSA verify with the CONFIGURED key (KeyInfo in the message is ignored)
      const siBytes = Buffer.from(c14n(si, { mode: c14nModeOf(c14nAlg) }), 'utf8');
      const sigVal = Buffer.from(textOf(childEl(sig, 'SignatureValue', NS_DSIG)).replace(/\s+/g, ''), 'base64');
      if (!crypto.verify(sigAlg, siBytes, pub, sigVal)) throw new Error('signature value invalid');
      verified.push(target);
    } catch (e) { errors.push(e.message); }
  }
  if (!verified.length) throw new Error('No valid signature: ' + (errors.join('; ') || 'the response was not signed'));
  return { verified };
}

// ---------------------------------------------------------------------------
// SAML response consumption
// ---------------------------------------------------------------------------
const COMMON_EMAIL_ATTRS = [
  'email', 'mail', 'emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
];
const COMMON_NAME_ATTRS = ['displayname', 'name', 'cn', 'http://schemas.microsoft.com/identity/claims/displayname',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'urn:oid:2.16.840.1.113730.3.1.241'];

/**
 * Decode + verify + validate a POSTed SAMLResponse.
 * cfg:    { saml_cert, saml_idp_issuer?, email_claim? }
 * expect: { audience, recipient, inResponseTo, clockSkewMs? }
 * Returns { ok:true, email, name, sub, attributes } or throws with a human reason.
 */
function consumeResponse(samlResponseB64, cfg, expect = {}) {
  let xml;
  try { xml = Buffer.from(String(samlResponseB64 || ''), 'base64').toString('utf8'); } catch (_) { xml = ''; }
  if (!/<.*Response/.test(xml)) throw new Error('The identity provider response could not be decoded.');
  const root = parseXml(xml);
  if (root.local !== 'Response' || nsLookup(root, root.prefix) !== NS_PROTO) throw new Error('The message is not a SAML 2.0 Response.');
  // status must be Success
  const statusCode = childEl(childEl(root, 'Status', NS_PROTO) || root, 'StatusCode', NS_PROTO);
  const status = attrOf(statusCode, 'Value');
  if (status !== STATUS_SUCCESS) throw new Error('The identity provider reported sign-in failure (' + (status.split(':').pop() || 'no status') + ').');
  // exactly ONE assertion (wrapping defence) — encrypted assertions are not supported
  if (findAll(root, 'EncryptedAssertion', NS_ASSERT).length) throw new Error('Encrypted assertions are not supported — set the IdP to sign (not encrypt) the assertion.');
  const assertions = findAll(root, 'Assertion', NS_ASSERT);
  if (assertions.length !== 1) throw new Error(assertions.length ? 'The response carried multiple assertions — refused.' : 'The response carried no assertion.');
  const assertion = assertions[0];
  // signature: the Response root or THIS assertion must be validly signed by the configured cert
  const { verified } = verifySignatures(root, cfg.saml_cert);
  const covered = verified.some(v => v === root || v === assertion);
  if (!covered) throw new Error('Neither the response nor its assertion is covered by a valid signature.');
  // issuer pin (optional but recommended)
  const issuer = textOf(childEl(assertion, 'Issuer', NS_ASSERT)) || textOf(childEl(root, 'Issuer', NS_ASSERT));
  if (cfg.saml_idp_issuer && issuer && issuer !== String(cfg.saml_idp_issuer).trim()) {
    throw new Error('The assertion issuer did not match the configured identity provider.');
  }
  // conditions: time window + audience
  const skew = Number(expect.clockSkewMs) || 3 * 60 * 1000;
  const now = Date.now();
  const cond = childEl(assertion, 'Conditions', NS_ASSERT);
  if (cond) {
    const nb = attrOf(cond, 'NotBefore'), na = attrOf(cond, 'NotOnOrAfter');
    if (nb && now < Date.parse(nb) - skew) throw new Error('The sign-in assertion is not yet valid (check server clocks).');
    if (na && now >= Date.parse(na) + skew) throw new Error('The sign-in assertion has expired — please sign in again.');
    const audiences = findAll(cond, 'Audience', NS_ASSERT).map(textOf);
    if (expect.audience && audiences.length && !audiences.includes(expect.audience)) {
      throw new Error('The assertion was issued for a different application (audience mismatch).');
    }
  }
  // subject confirmation: recipient + InResponseTo + expiry
  const scd = findAll(assertion, 'SubjectConfirmationData', NS_ASSERT)[0];
  if (scd) {
    const rec = attrOf(scd, 'Recipient');
    if (expect.recipient && rec && rec !== expect.recipient) throw new Error('The assertion was addressed to a different sign-in endpoint.');
    const na = attrOf(scd, 'NotOnOrAfter');
    if (na && now >= Date.parse(na) + skew) throw new Error('The sign-in assertion has expired — please sign in again.');
    const irt = attrOf(scd, 'InResponseTo') || attrOf(root, 'InResponseTo');
    if (expect.inResponseTo && irt && irt !== expect.inResponseTo) throw new Error('The sign-in response did not match the request that started it.');
  }
  if (expect.inResponseTo) {
    const irt = attrOf(root, 'InResponseTo');
    if (!irt && !(scd && attrOf(scd, 'InResponseTo'))) throw new Error('Unsolicited sign-in responses are not accepted.');
    if (irt && irt !== expect.inResponseTo) throw new Error('The sign-in response did not match the request that started it.');
  }
  // identity: NameID + attributes
  const nameId = textOf(findAll(assertion, 'NameID', NS_ASSERT)[0]);
  const attributes = {};
  for (const at of findAll(assertion, 'Attribute', NS_ASSERT)) {
    const key = attrOf(at, 'Name') || attrOf(at, 'FriendlyName');
    const vals = (at.children || []).filter(c => c.el && c.local === 'AttributeValue').map(textOf).filter(Boolean);
    if (key) attributes[key] = vals.length > 1 ? vals : (vals[0] || '');
  }
  const lower = {};
  for (const [k, v] of Object.entries(attributes)) lower[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  const emailAttr = String(cfg.email_claim || '').toLowerCase();
  let email = (emailAttr && lower[emailAttr]) || '';
  if (!email) for (const k of COMMON_EMAIL_ATTRS) if (lower[k]) { email = lower[k]; break; }
  if (!email && /@/.test(nameId)) email = nameId;
  let name = '';
  for (const k of COMMON_NAME_ATTRS) if (lower[k.toLowerCase()]) { name = lower[k.toLowerCase()]; break; }
  if (!name) name = [lower['givenname'] || lower['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'], lower['surname'] || lower['sn'] || lower['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']].filter(Boolean).join(' ');
  return { ok: true, email: String(email).trim().toLowerCase(), name: String(name).trim(), sub: nameId || String(email).toLowerCase(), attributes, issuer };
}

// ---------------------------------------------------------------------------
// AuthnRequest (HTTP-Redirect binding) + SP metadata
// ---------------------------------------------------------------------------
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/** A fresh request id — XML ID types must not start with a digit. */
function newRequestId() { return '_' + crypto.randomBytes(16).toString('hex'); }

/**
 * Build the IdP redirect URL. opts: { idpUrl, spEntityId, acsUrl, relayState, id }.
 * The request is deflated (raw) + base64 + urlencoded per the HTTP-Redirect binding.
 */
function authnRequestUrl(opts) {
  const id = opts.id || newRequestId();
  const xml = `<samlp:AuthnRequest xmlns:samlp="${NS_PROTO}" xmlns:saml="${NS_ASSERT}" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}" Destination="${xmlEsc(opts.idpUrl)}" AssertionConsumerServiceURL="${xmlEsc(opts.acsUrl)}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${xmlEsc(opts.spEntityId)}</saml:Issuer><samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="false"/></samlp:AuthnRequest>`;
  const deflated = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));
  const q = new URLSearchParams({ SAMLRequest: deflated.toString('base64') });
  if (opts.relayState) q.set('RelayState', String(opts.relayState).slice(0, 1024));
  return { id, url: opts.idpUrl + (String(opts.idpUrl).includes('?') ? '&' : '?') + q.toString() };
}

/** The SP metadata document the IdP admin uploads (Entra "Upload metadata file", Google, Okta, ADFS…). */
function spMetadataXml(opts) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${xmlEsc(opts.spEntityId)}">`
    + `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`
    + `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>`
    + `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${xmlEsc(opts.acsUrl)}" index="0" isDefault="true"/>`
    + `</md:SPSSODescriptor></md:EntityDescriptor>`;
}

/** Preset hints for the desktop config UI. */
const SAML_PROVIDERS = [
  { key: 'entra-saml', label: 'Microsoft Entra ID — SAML', ssoUrlHint: 'https://login.microsoftonline.com/<TENANT-ID>/saml2', issuerHint: 'https://sts.windows.net/<TENANT-ID>/' },
  { key: 'google-saml', label: 'Google Workspace — SAML', ssoUrlHint: 'https://accounts.google.com/o/saml2/idp?idpid=<IDP-ID>', issuerHint: 'https://accounts.google.com/o/saml2?idpid=<IDP-ID>' },
  { key: 'adfs', label: 'ADFS / Shibboleth / Okta — SAML', ssoUrlHint: 'https://idp.university.edu/idp/profile/SAML2/Redirect/SSO', issuerHint: '' },
];

module.exports = {
  authnRequestUrl, spMetadataXml, consumeResponse, verifySignatures, newRequestId, SAML_PROVIDERS,
  // exported for tests (and any future tooling): the parser + canonicalizer are the protocol core
  _parseXml: parseXml, _c14n: c14n, _findById: findById, _findAll: findAll, _textOf: textOf, _publicKeyFrom: publicKeyFrom,
};
