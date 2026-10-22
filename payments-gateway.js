'use strict';
/**
 * Multi-provider online-payment gateway for the hosted hub (server.js) and the desktop/LAN hub.
 * ZERO npm dependencies (Node built-ins only). Designed to go GLOBAL: a deployment turns on whichever
 * gateways it has merchant accounts for and the portal/APK offer the student exactly those choices.
 *
 * Providers (region → typical use):
 *   paystack     Africa (NGN, GHS, ZAR, KES…) — card / bank / USSD
 *   flutterwave  Africa + global — card / bank / mobile-money
 *   stripe       Global — card / Apple&Google Pay / many local methods
 *   paypal       Global — PayPal balance / card (sandbox host switch in test mode)
 *   razorpay     India + global — card / UPI / netbanking (payment links)
 *   mollie       Europe — iDEAL / card / SEPA / Bancontact…
 *
 * SECURITY MODEL (money is sensitive):
 *   • the browser/app NEVER tells us "I paid" — we only record a payment after VERIFYING the
 *     transaction directly against the provider API with our secret key (the source of truth);
 *   • both the redirect callback AND the server-to-server webhook funnel through that same verify,
 *     so a forged callback/webhook cannot create a payment and a replay is idempotent;
 *   • each provider ships a webhook-signature check (defence in depth on top of the API re-verify);
 *   • every checkout is correlated to a server-built payment INTENT keyed by OUR reference, so we
 *     settle using the intent's trusted student/amount/currency, never client-supplied values, and we
 *     cross-check the amount the provider says was paid against what was expected (fraud guard).
 *
 * TEST MODE: a global `payments_test_mode` flag (env PAYMENTS_TEST_MODE or app setting). Most providers
 * use distinct test keys (sk_test_/rzp_test_/test_…) against the same endpoint; PayPal additionally
 * switches to the sandbox host. The portal badges everything "TEST MODE" so nobody mistakes a sandbox
 * payment for real money.
 */
const https = require('https');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// low-level HTTPS (JSON or form-encoded), with timeout + safe failure
// ---------------------------------------------------------------------------
function httpReq(o) {
  return new Promise((resolve) => {
    try {
      let data = null, ctype = o.contentType || 'application/json';
      if (o.form) { data = Buffer.from(formEncode(o.form)); ctype = 'application/x-www-form-urlencoded'; }
      else if (o.raw != null) { data = Buffer.from(o.raw); }
      else if (o.body != null) { data = Buffer.from(JSON.stringify(o.body)); }
      const headers = Object.assign({ 'Accept': 'application/json' }, o.headers || {});
      if (data) { headers['Content-Type'] = ctype; headers['Content-Length'] = data.length; }
      const r = https.request({ hostname: o.host, path: o.path, method: o.method || 'GET', headers, timeout: o.timeout || 25000 }, (resp) => {
        let b = ''; resp.on('data', d => b += d); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: resp.statusCode, json: j, raw: b }); });
      });
      r.on('error', () => resolve({ status: 0, json: null, raw: '' }));
      r.on('timeout', () => { try { r.destroy(); } catch (_) {} resolve({ status: 0, json: null, raw: '' }); });
      if (data) r.write(data); r.end();
    } catch (_) { resolve({ status: 0, json: null, raw: '' }); }
  });
}
/** Flatten a (possibly nested) object into application/x-www-form-urlencoded — Stripe-style bracket keys. */
function formEncode(obj, prefix) {
  const parts = [];
  for (const k of Object.keys(obj || {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    const v = obj[k];
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) parts.push(formEncode(v, key));
    else if (Array.isArray(v)) v.forEach((item, i) => { parts.push(typeof item === 'object' ? formEncode(item, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`); });
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.filter(Boolean).join('&');
}

// ---------------------------------------------------------------------------
// config (env on the cloud hub; app settings on the desktop hub via configure())
// ---------------------------------------------------------------------------
let cfgGet = null;
function configure(getter) { cfgGet = (typeof getter === 'function') ? getter : null; }
/** Has a settings source been plugged in (the desktop, the hub or the edge)? */
function hasConfig() { return !!cfgGet; }
function cfg(envKey, settingKey) {
  if (cfgGet && settingKey) { try { const v = cfgGet(settingKey); if (v) return String(v).trim(); } catch (_) {} }
  return (process.env[envKey] || '').trim();
}
/** Global sandbox/test flag. */
function isTestMode() { const v = cfg('PAYMENTS_TEST_MODE', 'payments_test_mode'); return v === '1' || /^(true|yes|on)$/i.test(v); }
/** A provider's key: an OFFICE ACCOUNT clone reads ONLY its own keys (never the institution's), the
 *  institution's gateway reads the app setting / env. */
function ck(self, envKey, settingKey) { if (self && self._ov) return String(self._ov[settingKey] == null ? '' : self._ov[settingKey]).trim(); return cfg(envKey, settingKey); }
const sha512 = (x) => crypto.createHash('sha512').update(String(x)).digest('hex');
const basic = (u, p) => 'Basic ' + Buffer.from(String(u) + ':' + String(p)).toString('base64');
/** ISO-4217 numeric codes (Interswitch wants the number). */
const ISO_NUM = { NGN: '566', USD: '840', GBP: '826', EUR: '978', GHS: '936', KES: '404', ZAR: '710', XOF: '952' };

// ---------------------------------------------------------------------------
// currency minor-unit helpers (most ×100; a handful are zero-decimal)
// ---------------------------------------------------------------------------
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'XOF', 'XAF', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'PYG', 'RWF', 'UGX', 'VUV', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
function decimalsFor(cur) { cur = String(cur || '').toUpperCase(); if (ZERO_DECIMAL.has(cur)) return 0; if (THREE_DECIMAL.has(cur)) return 3; return 2; }
function toMinor(amount, cur) { const f = Math.pow(10, decimalsFor(cur)); return Math.round((Number(amount) || 0) * f); }
function fromMinor(minor, cur) { const f = Math.pow(10, decimalsFor(cur)); return Math.round((Number(minor) || 0) / f * 100) / 100; }
function amountString(amount, cur) { return (Number(amount) || 0).toFixed(decimalsFor(cur)); }

// ===========================================================================
// PROVIDER REGISTRY — each provider is self-contained; adding one is local.
// fields[] drives the admin config UI (and which settings configure() reads).
// ===========================================================================
const REGISTRY = {

  // ---- Paystack -----------------------------------------------------------
  paystack: {
    id: 'paystack', label: 'Paystack — Card · Bank · USSD', region: 'Africa',
    fields: [{ key: 'secret', setting: 'paystack_secret', env: 'PAYSTACK_SECRET', label: 'Secret key', placeholder: 'sk_live_… (or sk_test_…)', secret: true, required: true }],
    keys() { return { secret: ck(this, 'PAYSTACK_SECRET', 'paystack_secret') }; },
    configured() { return !!this.keys().secret; },
    async init(o) {
      const r = await httpReq({ host: 'api.paystack.co', method: 'POST', path: '/transaction/initialize', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { email: o.email, amount: toMinor(o.amount, o.currency), currency: o.currency, reference: o.reference, callback_url: o.callback_url, metadata: o.metadata || {} } });
      const d = r.json && r.json.status && r.json.data;
      return (d && d.authorization_url) ? { ok: true, url: d.authorization_url, reference: d.reference || o.reference } : { ok: false, error: (r.json && r.json.message) || 'Could not start the Paystack payment.' };
    },
    async verify(ref) {
      const r = await httpReq({ host: 'api.paystack.co', method: 'GET', path: '/transaction/verify/' + encodeURIComponent(ref), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json && r.json.status && r.json.data;
      if (d && d.status === 'success') {
        // 🔁 a card that may be charged again (AutoPay) — only ever kept when the payer asked for AutoPay
        const au = d.authorization || {};
        const mandate = au.reusable && au.authorization_code && String(au.channel || 'card') === 'card' ? { token: au.authorization_code, label: String(au.card_type || 'Card').trim() + ' •••• ' + (au.last4 || ''), exp: au.exp_year && au.exp_month ? String(au.exp_year) + '-' + String(au.exp_month).padStart(2, '0') : '', email: (d.customer && d.customer.email) || '' } : null;
        return { ok: true, amount: fromMinor(d.amount, d.currency), currency: String(d.currency || '').toUpperCase(), reference: d.reference || String(ref), metadata: d.metadata || {}, mandate };
      }
      if (d && (d.status === 'failed' || d.status === 'reversed')) return { ok: false, state: 'failed', reason: d.gateway_response || 'The payment was declined.' };
      return { ok: false };
    },
    /** 💸 Refund (all or part of) a payment back to the card / account it came from. */
    async refund(o) {
      const r = await httpReq({ host: 'api.paystack.co', method: 'POST', path: '/refund', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { transaction: o.reference, amount: toMinor(o.amount, o.currency), currency: o.currency, merchant_note: String(o.reason || 'Refund').slice(0, 120) } });
      const j = r.json || {}; const d = j.data || {};
      if (!j.status || d.id == null) return { ok: false, state: 'failed', reason: j.message || 'The refund was refused.' };
      return { ok: true, state: d.status === 'processed' ? 'done' : d.status === 'failed' ? 'failed' : 'pending', refund_id: String(d.id), expected_at: d.expected_at || null };
    },
    async refundStatus(id) {
      const r = await httpReq({ host: 'api.paystack.co', method: 'GET', path: '/refund/' + encodeURIComponent(id), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json && r.json.status && r.json.data; if (!d) return { ok: false };
      return { ok: true, state: d.status === 'processed' ? 'done' : d.status === 'failed' ? 'failed' : 'pending' };
    },
    /** 🔁 AutoPay: charge a card the payer allowed us to charge again (Paystack charge_authorization, same e-mail). */
    async chargeToken(o) {
      const r = await httpReq({ host: 'api.paystack.co', method: 'POST', path: '/transaction/charge_authorization', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { authorization_code: o.token, email: o.email, amount: toMinor(o.amount, o.currency), currency: o.currency, reference: o.reference, metadata: o.metadata || {} } });
      const j = r.json || {}; const d = j.data || {};
      if (!j.status) return { ok: false, state: 'failed', reason: j.message || 'The card could not be charged.' };
      if (d.status === 'success') return { ok: true, state: 'paid', reference: d.reference || o.reference };
      if (d.status === 'failed' || d.status === 'reversed') return { ok: false, state: 'failed', reason: d.gateway_response || 'The card was declined.' };
      return { ok: true, state: 'pending', reference: d.reference || o.reference };
    },
    webhookRef(body) { const d = (body && body.data) || {}; return d.reference || null; },
    // 🔁 the provider's OWN list of successful payments (the daily cross-check against our receipts)
    async listSuccessful(fromIso, toIso) {
      const out = []; const H = { Authorization: 'Bearer ' + this.keys().secret };
      for (let page = 1; page <= 30; page++) {
        const r = await httpReq({ host: 'api.paystack.co', method: 'GET', path: '/transaction?status=success&perPage=100&page=' + page + '&from=' + encodeURIComponent(fromIso) + '&to=' + encodeURIComponent(toIso), headers: H });
        const j = r.json; if (!j || !j.status || !Array.isArray(j.data)) return { ok: false, error: (j && j.message) || ('HTTP ' + r.status) };
        for (const d of j.data) out.push({ reference: String(d.reference || ''), provider_tx: String(d.id || ''), amount: fromMinor(d.amount, d.currency), currency: String(d.currency || '').toUpperCase(), paid_at: d.paid_at || d.paidAt || d.created_at || null });
        if (page >= (Number(j.meta && j.meta.pageCount) || 1) || !j.data.length) return { ok: true, complete: true, items: out };
      }
      return { ok: true, complete: false, items: out };
    },
    // ⚠ chargebacks: charge.dispute.create / remind / resolve → the dispute id (the body is only a trigger)
    disputeOf(body) { const ev = String((body && body.event) || ''); const d = (body && body.data) || {}; return /^charge\.dispute\./.test(ev) && d.id != null ? { id: String(d.id) } : null; },
    async fetchDispute(id) {
      const r = await httpReq({ host: 'api.paystack.co', method: 'GET', path: '/dispute/' + encodeURIComponent(id), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json && r.json.status && r.json.data; const tx = d && d.transaction;
      if (!d || !tx || !tx.reference) return { ok: false };
      // resolution 'merchant-accepted' = the money goes back to the card holder; 'declined' (or archived) = it stays
      const status = d.resolution === 'merchant-accepted' ? 'lost' : (d.resolution === 'declined' || d.status === 'archived') ? 'won' : 'open';
      const cur = String(d.currency || tx.currency || '').toUpperCase();
      return { ok: true, id: String(d.id), status, reference: String(tx.reference), currency: cur, amount: d.refund_amount != null ? fromMinor(d.refund_amount, cur) : (tx.amount != null ? fromMinor(tx.amount, cur) : null), reason: String(d.category || d.message || 'Disputed by the card holder').slice(0, 160), due_at: d.due_at || null };
    },
    webhookAuthentic(headers, rawBody) { const k = this.keys().secret; if (!k || !rawBody) return false; const sig = headers['x-paystack-signature']; return !!sig && timingEqual(sig, crypto.createHmac('sha512', k).update(rawBody).digest('hex')); },
    async ping() { if (!this.keys().secret) return { ok: false, message: 'No secret key.' }; const r = await httpReq({ host: 'api.paystack.co', method: 'GET', path: '/balance', headers: { Authorization: 'Bearer ' + this.keys().secret } }); return r.status === 200 ? { ok: true, message: 'Paystack key is valid.' } : { ok: false, message: (r.json && r.json.message) || ('Paystack rejected the key (HTTP ' + r.status + ').') }; },
  },

  // ---- Flutterwave --------------------------------------------------------
  flutterwave: {
    id: 'flutterwave', label: 'Flutterwave — Card · Bank · Mobile Money', region: 'Africa / Global',
    fields: [
      { key: 'secret', setting: 'flw_secret_key', env: 'FLW_SECRET_KEY', label: 'Secret key', placeholder: 'FLWSECK-…', secret: true, required: true },
      { key: 'hash', setting: 'flw_secret_hash', env: 'FLW_SECRET_HASH', label: 'Webhook secret hash', placeholder: 'your webhook hash', secret: true, required: false },
    ],
    keys() { return { secret: ck(this, 'FLW_SECRET_KEY', 'flw_secret_key'), hash: ck(this, 'FLW_SECRET_HASH', 'flw_secret_hash') }; },
    configured() { return !!this.keys().secret; },
    async init(o) {
      const r = await httpReq({ host: 'api.flutterwave.com', method: 'POST', path: '/v3/payments', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { tx_ref: o.reference, amount: o.amount, currency: o.currency, redirect_url: o.callback_url, customer: { email: o.email, name: o.name || undefined, phonenumber: o.phone || undefined }, customizations: { title: o.title || 'School Fees' }, meta: o.metadata || {} } });
      const link = r.json && r.json.status === 'success' && r.json.data && r.json.data.link;
      return link ? { ok: true, url: link, reference: o.reference } : { ok: false, error: (r.json && r.json.message) || 'Could not start the Flutterwave payment.' };
    },
    async verify(ref) {
      // the redirect hands us Flutterwave's numeric transaction id; the background re-check only knows OUR tx_ref
      // (the intent's provider_ref) — asking /transactions/<tx_ref>/verify always 404'd, so a checkout whose
      // redirect was lost was never settled. A non-numeric ref is looked up by reference instead.
      const path = /^\d+$/.test(String(ref)) ? '/v3/transactions/' + encodeURIComponent(ref) + '/verify' : '/v3/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(ref);
      const r = await httpReq({ host: 'api.flutterwave.com', method: 'GET', path, headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json && r.json.status === 'success' && r.json.data;
      if (d && d.status === 'successful') {
        const c = d.card || {}; const ex = /^(\d{1,2})\/(\d{2,4})$/.exec(String(c.expiry || ''));
        const mandate = c.token ? { token: c.token, label: String(c.type || 'Card').trim() + ' •••• ' + (c.last_4digits || ''), exp: ex ? (ex[2].length === 2 ? '20' + ex[2] : ex[2]) + '-' + ex[1].padStart(2, '0') : '', email: (d.customer && d.customer.email) || '' } : null;
        return { ok: true, amount: Number(d.amount) || 0, currency: String(d.currency || '').toUpperCase(), reference: d.tx_ref || String(ref), metadata: d.meta || {}, mandate };
      }
      if (d && d.status === 'failed') return { ok: false, state: 'failed', reason: d.processor_response || 'The payment was declined.' };
      return { ok: false };
    },
    /** 💸 Refund to the card / account that paid — Flutterwave refunds by ITS transaction id, found from our tx_ref. */
    async refund(o) {
      const H = { Authorization: 'Bearer ' + this.keys().secret };
      const v = await httpReq({ host: 'api.flutterwave.com', method: 'GET', path: '/v3/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(o.reference), headers: H });
      const tx = v.json && v.json.status === 'success' && v.json.data;
      if (!tx || tx.id == null) return { ok: false, state: 'failed', reason: 'The payment was not found at Flutterwave.' };
      const r = await httpReq({ host: 'api.flutterwave.com', method: 'POST', path: '/v3/transactions/' + encodeURIComponent(tx.id) + '/refund', headers: H, body: { amount: o.amount, comments: String(o.reason || 'Refund').slice(0, 120) } });
      const j = r.json || {}; const d = j.data || {};
      if (j.status !== 'success' || d.id == null) return { ok: false, state: 'failed', reason: j.message || 'The refund was refused.' };
      return { ok: true, state: d.status === 'completed' ? 'done' : d.status === 'failed' ? 'failed' : 'pending', refund_id: String(d.id) };
    },
    async refundStatus(id) {
      const r = await httpReq({ host: 'api.flutterwave.com', method: 'GET', path: '/v3/refunds/' + encodeURIComponent(id), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json && r.json.status === 'success' && r.json.data; if (!d) return { ok: false };
      return { ok: true, state: d.status === 'completed' ? 'done' : d.status === 'failed' ? 'failed' : 'pending' };
    },
    /** 🔁 AutoPay: charge a saved card token (Flutterwave tokenized charge). */
    async chargeToken(o) {
      const r = await httpReq({ host: 'api.flutterwave.com', method: 'POST', path: '/v3/tokenized-charges', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { token: o.token, currency: o.currency, amount: o.amount, email: o.email, tx_ref: o.reference, narration: String(o.title || 'School fees').slice(0, 60), meta: o.metadata || {} } });
      const j = r.json || {}; const d = j.data || {};
      if (j.status !== 'success') return { ok: false, state: 'failed', reason: j.message || 'The card could not be charged.' };
      if (d.status === 'successful') return { ok: true, state: 'paid', reference: d.tx_ref || o.reference };
      if (d.status === 'failed') return { ok: false, state: 'failed', reason: d.processor_response || 'The card was declined.' };
      return { ok: true, state: 'pending', reference: d.tx_ref || o.reference };
    },
    async listSuccessful(fromIso, toIso) {
      const out = []; const H = { Authorization: 'Bearer ' + this.keys().secret };
      for (let page = 1; page <= 30; page++) {
        const r = await httpReq({ host: 'api.flutterwave.com', method: 'GET', path: '/v3/transactions?status=successful&page=' + page + '&from=' + String(fromIso).slice(0, 10) + '&to=' + String(toIso).slice(0, 10), headers: H });
        const j = r.json; if (!j || j.status !== 'success' || !Array.isArray(j.data)) return { ok: false, error: (j && j.message) || ('HTTP ' + r.status) };
        for (const d of j.data) if (!d.status || d.status === 'successful') out.push({ reference: String(d.tx_ref || ''), provider_tx: String(d.id || ''), amount: Number(d.amount) || 0, currency: String(d.currency || '').toUpperCase(), paid_at: d.created_at || null });
        const pi = (j.meta && j.meta.page_info) || {};
        if (page >= (Number(pi.total_pages) || 1) || !j.data.length) return { ok: true, complete: true, items: out };
      }
      return { ok: true, complete: false, items: out };
    },
    // 🏦 a ONE-TIME bank account for this exact payment (Flutterwave "pay with bank transfer", no BVN needed): the payer
    // transfers from any bank app or USSD; the same verify (by our tx_ref) confirms it — no receipt, no matching
    async transferAccount(o) {
      if (String(o.currency || '').toUpperCase() !== 'NGN') return { ok: false, user_error: true, error: 'A transfer account is for naira (NGN) payments.' };
      const r = await httpReq({ host: 'api.flutterwave.com', method: 'POST', path: '/v3/charges?type=bank_transfer', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { tx_ref: o.reference, amount: o.amount, email: o.email, currency: 'NGN', phone_number: o.phone || undefined, fullname: o.name || undefined, is_permanent: false, narration: String(o.title || 'School fees').slice(0, 60), meta: o.metadata || {} } });
      const au = r.json && r.json.status === 'success' && r.json.meta && r.json.meta.authorization;
      if (!au || !au.transfer_account) return { ok: false, error: (r.json && r.json.message) || 'Could not open a transfer account.' };
      const exp = au.account_expiration ? Date.parse(au.account_expiration) : NaN;
      return { ok: true, reference: o.reference, provider_ref: o.reference, transfer: { account_number: String(au.transfer_account), bank: au.transfer_bank || '', account_name: au.account_name || '', amount: Number(au.transfer_amount) || o.amount, expires_at: isFinite(exp) ? new Date(exp).toISOString() : null, note: au.transfer_note || '' } };
    },
    webhookRef(body) { const d = (body && body.data) || {}; return d.id || d.tx_ref || null; },
    webhookAuthentic(headers) { const hash = headers['verif-hash'] || headers['verif_hash']; const want = this.keys().hash; return !!want && hash === want; },
    async ping() { if (!this.keys().secret) return { ok: false, message: 'No secret key.' }; const r = await httpReq({ host: 'api.flutterwave.com', method: 'GET', path: '/v3/subaccounts?page=1', headers: { Authorization: 'Bearer ' + this.keys().secret } }); return (r.status === 200 || r.status === 400) ? { ok: r.status === 200, message: r.status === 200 ? 'Flutterwave key is valid.' : ((r.json && r.json.message) || 'Flutterwave rejected the key.') } : { ok: false, message: 'Flutterwave rejected the key (HTTP ' + r.status + ').' }; },
  },

  // ---- Stripe (global) ----------------------------------------------------
  stripe: {
    id: 'stripe', label: 'Stripe — Card · Apple/Google Pay', region: 'Global',
    fields: [
      { key: 'secret', setting: 'stripe_secret', env: 'STRIPE_SECRET', label: 'Secret key', placeholder: 'sk_live_… (or sk_test_…)', secret: true, required: true },
      { key: 'webhook', setting: 'stripe_webhook_secret', env: 'STRIPE_WEBHOOK_SECRET', label: 'Webhook signing secret', placeholder: 'whsec_…', secret: true, required: false },
    ],
    keys() { return { secret: ck(this, 'STRIPE_SECRET', 'stripe_secret'), webhook: ck(this, 'STRIPE_WEBHOOK_SECRET', 'stripe_webhook_secret') }; },
    configured() { return !!this.keys().secret; },
    async init(o) {
      const form = {
        mode: 'payment', success_url: o.callback_url + '&session_id={CHECKOUT_SESSION_ID}', cancel_url: o.callback_url + '&cancelled=1',
        client_reference_id: o.reference, customer_email: o.email || undefined,
        'line_items': [{ quantity: 1, price_data: { currency: String(o.currency || 'usd').toLowerCase(), unit_amount: toMinor(o.amount, o.currency), product_data: { name: o.title || 'School Fees' } } }],
        metadata: Object.assign({ reference: o.reference }, o.metadata || {}),
        payment_intent_data: { metadata: Object.assign({ reference: o.reference }, o.metadata || {}) },
      };
      const r = await httpReq({ host: 'api.stripe.com', method: 'POST', path: '/v1/checkout/sessions', headers: { Authorization: 'Bearer ' + this.keys().secret }, form });
      const d = r.json;
      return (d && d.url) ? { ok: true, url: d.url, reference: o.reference, provider_ref: d.id } : { ok: false, error: (d && d.error && d.error.message) || 'Could not start the Stripe payment.' };
    },
    async verify(ref) {
      // `ref` is the checkout session id (from the callback ?session_id= or the intent's provider_ref)
      const r = await httpReq({ host: 'api.stripe.com', method: 'GET', path: '/v1/checkout/sessions/' + encodeURIComponent(ref), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json;
      if (d && d.payment_status === 'paid') return { ok: true, amount: fromMinor(d.amount_total, d.currency), currency: String(d.currency || '').toUpperCase(), reference: d.client_reference_id || (d.metadata && d.metadata.reference) || String(ref), metadata: d.metadata || {} };
      if (d && d.status === 'expired') return { ok: false, state: 'failed', reason: 'The checkout expired before it was paid.' };
      return { ok: false };
    },
    webhookRef(body) { const obj = body && body.data && body.data.object; return (obj && (obj.id || (obj.metadata && obj.metadata.reference))) || null; },
    async listSuccessful(fromIso, toIso) {
      const out = []; const H = { Authorization: 'Bearer ' + this.keys().secret }; let after = '';
      const gte = Math.floor(Date.parse(fromIso) / 1000), lte = Math.floor(Date.parse(toIso) / 1000);
      for (let page = 1; page <= 30; page++) {
        const r = await httpReq({ host: 'api.stripe.com', method: 'GET', path: '/v1/checkout/sessions?limit=100&status=complete&created%5Bgte%5D=' + gte + '&created%5Blte%5D=' + lte + (after ? '&starting_after=' + encodeURIComponent(after) : ''), headers: H });
        const j = r.json; if (!j || !Array.isArray(j.data)) return { ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + r.status) };
        for (const d of j.data) if (d.payment_status === 'paid') out.push({ reference: String(d.client_reference_id || (d.metadata && d.metadata.reference) || ''), provider_tx: String(d.id || ''), amount: fromMinor(d.amount_total, d.currency), currency: String(d.currency || '').toUpperCase(), paid_at: d.created ? new Date(d.created * 1000).toISOString() : null });
        if (!j.has_more || !j.data.length) return { ok: true, complete: true, items: out };
        after = j.data[j.data.length - 1].id;
      }
      return { ok: true, complete: false, items: out };
    },
    /** 💸 Refund to the card — the checkout session (our provider_ref) gives the payment intent. */
    async refund(o) {
      const H = { Authorization: 'Bearer ' + this.keys().secret };
      if (!o.provider_ref) return { ok: false, state: 'failed', reason: 'The Stripe checkout of this payment is not known.' };
      const s = await httpReq({ host: 'api.stripe.com', method: 'GET', path: '/v1/checkout/sessions/' + encodeURIComponent(o.provider_ref), headers: H });
      const pi = s.json && (typeof s.json.payment_intent === 'string' ? s.json.payment_intent : s.json.payment_intent && s.json.payment_intent.id);
      if (!pi) return { ok: false, state: 'failed', reason: 'The payment was not found at Stripe.' };
      const r = await httpReq({ host: 'api.stripe.com', method: 'POST', path: '/v1/refunds', headers: H, form: { payment_intent: pi, amount: toMinor(o.amount, o.currency), reason: 'requested_by_customer', metadata: { reference: o.reference } } });
      const d = r.json || {};
      if (!d.id || d.object !== 'refund') return { ok: false, state: 'failed', reason: (d.error && d.error.message) || 'The refund was refused.' };
      return { ok: true, state: d.status === 'succeeded' ? 'done' : (d.status === 'failed' || d.status === 'canceled') ? 'failed' : 'pending', refund_id: String(d.id) };
    },
    async refundStatus(id) {
      const r = await httpReq({ host: 'api.stripe.com', method: 'GET', path: '/v1/refunds/' + encodeURIComponent(id), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json; if (!d || d.object !== 'refund') return { ok: false };
      return { ok: true, state: d.status === 'succeeded' ? 'done' : (d.status === 'failed' || d.status === 'canceled') ? 'failed' : 'pending' };
    },
    // ⚠ chargebacks: charge.dispute.created / updated / closed / funds_withdrawn → the dispute id (dp_…)
    disputeOf(body) { const t = String((body && body.type) || ''); const obj = body && body.data && body.data.object; return /^charge\.dispute\./.test(t) && obj && obj.id ? { id: String(obj.id) } : null; },
    async fetchDispute(id) {
      const H = { Authorization: 'Bearer ' + this.keys().secret };
      const r = await httpReq({ host: 'api.stripe.com', method: 'GET', path: '/v1/disputes/' + encodeURIComponent(id) + '?expand%5B%5D=payment_intent', headers: H });
      const d = r.json; if (!d || d.object !== 'dispute') return { ok: false };
      let pi = d.payment_intent;
      if (pi && typeof pi === 'string') { const r2 = await httpReq({ host: 'api.stripe.com', method: 'GET', path: '/v1/payment_intents/' + encodeURIComponent(pi), headers: H }); pi = r2.json; }
      const ref = pi && pi.metadata && pi.metadata.reference; if (!ref) return { ok: false };
      const status = d.status === 'lost' ? 'lost' : (d.status === 'won' || d.status === 'warning_closed') ? 'won' : 'open';
      const due = d.evidence_details && d.evidence_details.due_by ? new Date(Number(d.evidence_details.due_by) * 1000).toISOString() : null;
      return { ok: true, id: String(d.id), status, reference: String(ref), currency: String(d.currency || '').toUpperCase(), amount: d.amount != null ? fromMinor(d.amount, d.currency) : null, reason: String(d.reason || 'Disputed by the card holder').replace(/_/g, ' ').slice(0, 160), due_at: due };
    },
    webhookAuthentic(headers, rawBody) {
      const secret = this.keys().webhook; const sig = headers['stripe-signature']; if (!secret || !sig || !rawBody) return false;
      try { const parts = {}; sig.split(',').forEach(p => { const [k, v] = p.split('='); parts[k] = v; }); if (!parts.t || !parts.v1) return false; const expect = crypto.createHmac('sha256', secret).update(parts.t + '.' + rawBody).digest('hex'); return timingEqual(parts.v1, expect); } catch (_) { return false; }
    },
    async ping() { if (!this.keys().secret) return { ok: false, message: 'No secret key.' }; const r = await httpReq({ host: 'api.stripe.com', method: 'GET', path: '/v1/balance', headers: { Authorization: 'Bearer ' + this.keys().secret } }); return r.status === 200 ? { ok: true, message: 'Stripe key is valid' + (/sk_test/.test(this.keys().secret) ? ' (TEST key).' : '.') } : { ok: false, message: (r.json && r.json.error && r.json.error.message) || ('Stripe rejected the key (HTTP ' + r.status + ').') }; },
  },

  // ---- PayPal (global; sandbox host in test mode) -------------------------
  paypal: {
    id: 'paypal', label: 'PayPal — PayPal · Card', region: 'Global',
    fields: [
      { key: 'client', setting: 'paypal_client_id', env: 'PAYPAL_CLIENT_ID', label: 'Client ID', placeholder: 'AY…', secret: false, required: true },
      { key: 'secret', setting: 'paypal_secret', env: 'PAYPAL_SECRET', label: 'Secret', placeholder: 'EL…', secret: true, required: true },
    ],
    keys() { return { client: ck(this, 'PAYPAL_CLIENT_ID', 'paypal_client_id'), secret: ck(this, 'PAYPAL_SECRET', 'paypal_secret') }; },
    host() { return isTestMode() ? 'api-m.sandbox.paypal.com' : 'api-m.paypal.com'; },
    configured() { const k = this.keys(); return !!(k.client && k.secret); },
    async token() {
      const k = this.keys(); const basic = Buffer.from(k.client + ':' + k.secret).toString('base64');
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/v1/oauth2/token', headers: { Authorization: 'Basic ' + basic }, form: { grant_type: 'client_credentials' } });
      return (r.json && r.json.access_token) || null;
    },
    async init(o) {
      const tk = await this.token(); if (!tk) return { ok: false, error: 'Could not authenticate with PayPal (check the Client ID / Secret).' };
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/v2/checkout/orders', headers: { Authorization: 'Bearer ' + tk }, body: {
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: o.currency, value: amountString(o.amount, o.currency) }, custom_id: o.reference, description: (o.title || 'School Fees').slice(0, 120) }],
        application_context: { return_url: o.callback_url, cancel_url: o.callback_url + '&cancelled=1', brand_name: (o.title || 'School Fees').slice(0, 120), user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' },
      } });
      const links = (r.json && r.json.links) || []; const approve = links.find(l => l.rel === 'approve' || l.rel === 'payer-action');
      return (approve && approve.href) ? { ok: true, url: approve.href, reference: o.reference, provider_ref: r.json.id } : { ok: false, error: (r.json && r.json.message) || 'Could not start the PayPal payment.' };
    },
    async verify(orderId) {
      const tk = await this.token(); if (!tk) return { ok: false };
      let r = await httpReq({ host: this.host(), method: 'GET', path: '/v2/checkout/orders/' + encodeURIComponent(orderId), headers: { Authorization: 'Bearer ' + tk } });
      let d = r.json;
      if (d && d.status === 'APPROVED') { const cap = await httpReq({ host: this.host(), method: 'POST', path: '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', headers: { Authorization: 'Bearer ' + tk } }); if (cap.json) d = cap.json; }
      if (d && d.status === 'COMPLETED') {
        const pu = (d.purchase_units && d.purchase_units[0]) || {};
        const cap = (pu.payments && pu.payments.captures && pu.payments.captures[0]) || {};
        const amt = (cap.amount && cap.amount.value) || (pu.amount && pu.amount.value) || 0;
        const cur = (cap.amount && cap.amount.currency_code) || (pu.amount && pu.amount.currency_code) || 'USD';
        return { ok: true, amount: Number(amt) || 0, currency: String(cur).toUpperCase(), reference: pu.custom_id || String(orderId), metadata: { reference: pu.custom_id } };
      }
      return { ok: false };
    },
    webhookRef(body) { const res = (body && body.resource) || {}; return res.id || (res.supplementary_data && res.supplementary_data.related_ids && res.supplementary_data.related_ids.order_id) || null; },
    webhookAuthentic() { return true; }, // PayPal sig-verify needs an API round-trip; we always API re-verify the order, so a forged webhook can't settle
    async ping() { if (!this.configured()) return { ok: false, message: 'Enter the Client ID and Secret.' }; const tk = await this.token(); return tk ? { ok: true, message: 'PayPal credentials are valid' + (isTestMode() ? ' (SANDBOX).' : '.') } : { ok: false, message: 'PayPal rejected the credentials.' }; },
  },

  // ---- Razorpay (India + global) — payment links --------------------------
  razorpay: {
    id: 'razorpay', label: 'Razorpay — Card · UPI · Netbanking', region: 'India / Global',
    fields: [
      { key: 'keyid', setting: 'razorpay_key_id', env: 'RAZORPAY_KEY_ID', label: 'Key ID', placeholder: 'rzp_live_… / rzp_test_…', secret: false, required: true },
      { key: 'secret', setting: 'razorpay_secret', env: 'RAZORPAY_KEY_SECRET', label: 'Key secret', placeholder: 'your key secret', secret: true, required: true },
      { key: 'webhook', setting: 'razorpay_webhook_secret', env: 'RAZORPAY_WEBHOOK_SECRET', label: 'Webhook secret', placeholder: 'webhook secret', secret: true, required: false },
    ],
    keys() { return { keyid: ck(this, 'RAZORPAY_KEY_ID', 'razorpay_key_id'), secret: ck(this, 'RAZORPAY_KEY_SECRET', 'razorpay_secret'), webhook: ck(this, 'RAZORPAY_WEBHOOK_SECRET', 'razorpay_webhook_secret') }; },
    auth() { return 'Basic ' + Buffer.from(this.keys().keyid + ':' + this.keys().secret).toString('base64'); },
    configured() { const k = this.keys(); return !!(k.keyid && k.secret); },
    async init(o) {
      const r = await httpReq({ host: 'api.razorpay.com', method: 'POST', path: '/v1/payment_links', headers: { Authorization: this.auth() }, body: {
        amount: toMinor(o.amount, o.currency), currency: o.currency, accept_partial: false, reference_id: o.reference,
        description: (o.title || 'School Fees').slice(0, 120), customer: { email: o.email, name: o.name || undefined, contact: o.phone || undefined },
        notify: { sms: false, email: false }, reminder_enable: false, callback_url: o.callback_url, callback_method: 'get', notes: o.metadata || {},
      } });
      const d = r.json;
      return (d && d.short_url) ? { ok: true, url: d.short_url, reference: o.reference, provider_ref: d.id } : { ok: false, error: (d && d.error && d.error.description) || 'Could not start the Razorpay payment.' };
    },
    async verify(plinkId) {
      const r = await httpReq({ host: 'api.razorpay.com', method: 'GET', path: '/v1/payment_links/' + encodeURIComponent(plinkId), headers: { Authorization: this.auth() } });
      const d = r.json;
      if (d && d.status === 'paid') return { ok: true, amount: fromMinor(d.amount_paid || d.amount, d.currency), currency: String(d.currency || '').toUpperCase(), reference: d.reference_id || String(plinkId), metadata: d.notes || {} };
      return { ok: false };
    },
    webhookRef(body) { const pl = body && body.payload; if (!pl) return null; return (pl.payment_link && pl.payment_link.entity && pl.payment_link.entity.id) || (pl.payment && pl.payment.entity && pl.payment.entity.notes && pl.payment.entity.notes.plink_id) || null; },
    webhookAuthentic(headers, rawBody) { const secret = this.keys().webhook; const sig = headers['x-razorpay-signature']; if (!secret || !sig || !rawBody) return false; return timingEqual(sig, crypto.createHmac('sha256', secret).update(rawBody).digest('hex')); },
    async ping() { if (!this.configured()) return { ok: false, message: 'Enter the Key ID and secret.' }; const r = await httpReq({ host: 'api.razorpay.com', method: 'GET', path: '/v1/payments?count=1', headers: { Authorization: this.auth() } }); return r.status === 200 ? { ok: true, message: 'Razorpay keys are valid.' } : { ok: false, message: (r.json && r.json.error && r.json.error.description) || ('Razorpay rejected the keys (HTTP ' + r.status + ').') }; },
  },

  // ---- Mollie (Europe) ----------------------------------------------------
  mollie: {
    id: 'mollie', label: 'Mollie — iDEAL · Card · SEPA', region: 'Europe',
    fields: [{ key: 'secret', setting: 'mollie_api_key', env: 'MOLLIE_API_KEY', label: 'API key', placeholder: 'live_… / test_…', secret: true, required: true }],
    keys() { return { secret: ck(this, 'MOLLIE_API_KEY', 'mollie_api_key') }; },
    configured() { return !!this.keys().secret; },
    async init(o) {
      const r = await httpReq({ host: 'api.mollie.com', method: 'POST', path: '/v2/payments', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: {
        amount: { currency: o.currency, value: amountString(o.amount, o.currency) },
        description: (o.title || 'School Fees').slice(0, 255), redirectUrl: o.callback_url, webhookUrl: o.webhook_url || undefined,
        metadata: Object.assign({ reference: o.reference }, o.metadata || {}),
      } });
      const link = r.json && r.json._links && r.json._links.checkout && r.json._links.checkout.href;
      return link ? { ok: true, url: link, reference: o.reference, provider_ref: r.json.id } : { ok: false, error: (r.json && r.json.detail) || 'Could not start the Mollie payment.' };
    },
    async verify(paymentId) {
      const r = await httpReq({ host: 'api.mollie.com', method: 'GET', path: '/v2/payments/' + encodeURIComponent(paymentId), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json;
      if (d && d.status === 'paid') return { ok: true, amount: Number(d.amount && d.amount.value) || 0, currency: String((d.amount && d.amount.currency) || '').toUpperCase(), reference: (d.metadata && d.metadata.reference) || String(paymentId), metadata: d.metadata || {} };
      return { ok: false };
    },
    webhookRef(body) { if (!body) return null; if (typeof body === 'string') { const m = /id=([^&\s]+)/.exec(body); return m ? decodeURIComponent(m[1]) : null; } return body.id || (body.data && body.data.id) || null; },
    webhookAuthentic() { return true; }, // Mollie has no webhook signature; the id is opaque and we always API re-verify it
    async ping() { if (!this.keys().secret) return { ok: false, message: 'No API key.' }; const r = await httpReq({ host: 'api.mollie.com', method: 'GET', path: '/v2/methods', headers: { Authorization: 'Bearer ' + this.keys().secret } }); return r.status === 200 ? { ok: true, message: 'Mollie key is valid' + (/^test_/.test(this.keys().secret) ? ' (TEST key).' : '.') } : { ok: false, message: (r.json && r.json.detail) || ('Mollie rejected the key (HTTP ' + r.status + ').') }; },
  },

  // ---- MoMoPay (West-Africa CFA mobile money: MTN MoMo · Moov Money · Celtiis — via FedaPay) ----
  // ONE "MoMoPay" checkout backed by the FedaPay aggregator, the common Benin gateway that uniquely
  // covers Celtiis Cash alongside MTN MoMo + Moov Money (and cards) for XOF. The student is redirected to
  // FedaPay's hosted page to pick their operator + enter their mobile-money number; we VERIFY the
  // transaction server-side exactly like every other provider (the app/browser never asserts payment).
  // TEST MODE switches to FedaPay's sandbox host + checkout domain (use an sk_sandbox_… key).
  momopay: {
    id: 'momopay', label: 'MoMoPay — MTN · Moov · Celtiis (Mobile Money)', region: 'West Africa (CFA)',
    fields: [
      { key: 'secret', setting: 'momopay_secret', env: 'MOMOPAY_SECRET', label: 'FedaPay secret key', placeholder: 'sk_live_… (or sk_sandbox_… for test)', secret: true, required: true },
      { key: 'webhook', setting: 'momopay_webhook_secret', env: 'MOMOPAY_WEBHOOK_SECRET', label: 'Webhook secret (optional)', placeholder: 'wh_…', secret: true, required: false },
    ],
    keys() { return { secret: ck(this, 'MOMOPAY_SECRET', 'momopay_secret'), webhook: ck(this, 'MOMOPAY_WEBHOOK_SECRET', 'momopay_webhook_secret') }; },
    host() { return isTestMode() ? 'sandbox-api.fedapay.com' : 'api.fedapay.com'; },
    checkoutHost() { return isTestMode() ? 'sandbox-checkout.fedapay.com' : 'checkout.fedapay.com'; },
    configured() { return !!this.keys().secret; },
    _tx(j) { return j ? (j['v1/transaction'] || j.transaction || j.data || j) : null; },
    async init(o) {
      const auth = 'Bearer ' + this.keys().secret;
      const parts = String(o.name || 'Student').trim().split(/\s+/); const first = parts.shift() || 'Student';
      const customer = { firstname: first, lastname: parts.join(' ') || first, email: o.email };
      // FedaPay XOF/XAF are zero-decimal → send the whole-franc integer amount.
      const created = await httpReq({ host: this.host(), method: 'POST', path: '/v1/transactions', headers: { Authorization: auth }, body: {
        description: (o.title || 'School Fees').slice(0, 250), amount: Math.round(Number(o.amount) || 0),
        currency: { iso: String(o.currency || 'XOF').toUpperCase() }, callback_url: o.callback_url, customer,
      } });
      const tx = this._tx(created.json); const id = tx && tx.id;
      if (!id) return { ok: false, error: (created.json && (created.json.message || (created.json.errors && JSON.stringify(created.json.errors)))) || 'Could not start the MoMoPay payment.' };
      const tok = await httpReq({ host: this.host(), method: 'POST', path: '/v1/transactions/' + encodeURIComponent(id) + '/token', headers: { Authorization: auth } });
      const url = (tok.json && tok.json.url) || (tok.json && tok.json.token ? ('https://' + this.checkoutHost() + '/checkout/' + tok.json.token) : null);
      return url ? { ok: true, url, reference: o.reference, provider_ref: String(id) } : { ok: false, error: (tok.json && tok.json.message) || 'Could not get the MoMoPay checkout link.' };
    },
    async verify(txId) {
      const r = await httpReq({ host: this.host(), method: 'GET', path: '/v1/transactions/' + encodeURIComponent(txId), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = this._tx(r.json);
      if (d && (d.status === 'approved' || d.status === 'transferred')) {
        const cur = (d.currency && (d.currency.iso || d.currency.code)) || '';
        return { ok: true, amount: Number(d.amount) || 0, currency: String(cur).toUpperCase(), reference: String(d.id || txId), metadata: d.custom_metadata || {} };
      }
      return { ok: false };
    },
    // FedaPay's notification is { name:'transaction.approved', entity:{ id, … } } — `_tx` falls back to the body itself,
    // so it must not be tried first (the webhook was silently ignored and only the sweep ever settled MoMoPay)
    webhookRef(body) { const b = body || {}; const o = b.entity || b['v1/transaction'] || b.transaction || (b.data && (b.data.object || b.data)) || b; return (o && o.id != null) ? String(o.id) : null; },
    webhookAuthentic(headers, rawBody) {
      const secret = this.keys().webhook; if (!secret) return true; // no secret set → rely on the mandatory API re-verify (a forged webhook can't settle)
      const sig = headers['x-fedapay-signature']; if (!sig || !rawBody) return false;
      try { const parts = {}; String(sig).split(',').forEach(p => { const i = p.indexOf('='); if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); const payload = parts.t ? (parts.t + '.' + rawBody) : rawBody; const expect = crypto.createHmac('sha256', secret).update(payload).digest('hex'); return timingEqual(parts.s || parts.v1 || sig, expect); } catch (_) { return false; }
    },
    async ping() { if (!this.keys().secret) return { ok: false, message: 'Enter the FedaPay secret key.' }; const r = await httpReq({ host: this.host(), method: 'GET', path: '/v1/currencies', headers: { Authorization: 'Bearer ' + this.keys().secret } }); return r.status === 200 ? { ok: true, message: 'MoMoPay (FedaPay) key is valid' + (isTestMode() ? ' (SANDBOX).' : '.') } : { ok: false, message: (r.json && r.json.message) || ('FedaPay rejected the key (HTTP ' + r.status + ').') }; },
  },

  // ======================= NIGERIA =======================================================================
  // ---- Remita (SystemSpecs) — RRR invoice + hosted payment page; the gateway of choice for many public
  // universities (card · bank · USSD · branch). The RRR is generated server-side, then the student is POSTed
  // to Remita's page; we verify by RRR status (00/01 = paid).
  remita: {
    id: 'remita', label: 'Remita — RRR · Card · Bank · USSD', region: 'Nigeria',
    fields: [
      { key: 'merchant', setting: 'remita_merchant_id', env: 'REMITA_MERCHANT_ID', label: 'Merchant ID', placeholder: '2547916', secret: false, required: true },
      { key: 'service', setting: 'remita_service_type', env: 'REMITA_SERVICE_TYPE', label: 'Service type ID', placeholder: '4430731', secret: false, required: true },
      { key: 'apikey', setting: 'remita_api_key', env: 'REMITA_API_KEY', label: 'API key', placeholder: 'your Remita API key', secret: true, required: true },
    ],
    keys() { return { merchant: ck(this, 'REMITA_MERCHANT_ID', 'remita_merchant_id'), service: ck(this, 'REMITA_SERVICE_TYPE', 'remita_service_type'), apikey: ck(this, 'REMITA_API_KEY', 'remita_api_key') }; },
    host() { return isTestMode() ? 'demo.remita.net' : 'login.remita.net'; },
    configured() { const k = this.keys(); return !!(k.merchant && k.service && k.apikey); },
    _json(raw) { const i = String(raw || '').indexOf('{'); const j = String(raw || '').lastIndexOf('}'); if (i < 0 || j < i) return null; try { return JSON.parse(String(raw).slice(i, j + 1)); } catch (_) { return null; } },
    async init(o) {
      const k = this.keys(); const amount = amountString(o.amount, 'NGN');
      const hash = sha512(k.merchant + k.service + o.reference + amount + k.apikey);
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/remita/exapp/api/v1/send/api/echannelsvc/merchant/api/paymentinit', headers: { Authorization: 'remitaConsumerKey=' + k.merchant + ',remitaConsumerToken=' + hash }, body: { serviceTypeId: k.service, amount, orderId: o.reference, payerName: o.name || 'Student', payerEmail: o.email, payerPhone: o.phone || '', description: (o.title || 'School Fees').slice(0, 100) } });
      const j = r.json || this._json(r.raw); const rrr = j && (j.RRR || j.rrr);
      if (!rrr) return { ok: false, error: (j && (j.status || j.statusMessage)) || 'Could not generate a Remita RRR.' };
      return { ok: true, reference: o.reference, provider_ref: String(rrr), form: { action: 'https://' + this.host() + '/remita/ecomm/finalize.reg', fields: { merchantId: k.merchant, hash: sha512(k.merchant + rrr + k.apikey), rrr: String(rrr), responseurl: o.callback_url } } };
    },
    async verify(rrr) {
      const k = this.keys(); const hash = sha512(rrr + k.apikey + k.merchant);
      const r = await httpReq({ host: this.host(), method: 'GET', path: '/remita/exapp/api/v1/send/api/echannelsvc/' + encodeURIComponent(k.merchant) + '/' + encodeURIComponent(rrr) + '/' + hash + '/status.reg', headers: { Authorization: 'remitaConsumerKey=' + k.merchant + ',remitaConsumerToken=' + hash } });
      const j = r.json || this._json(r.raw);
      if (j && (String(j.status) === '00' || String(j.status) === '01')) return { ok: true, amount: Number(j.amount) || 0, currency: 'NGN', reference: String(j.orderId || rrr), metadata: {} };
      return { ok: false };
    },
    webhookRef(body) { const b = Array.isArray(body) ? body[0] : body; return (b && (b.rrr || b.RRR)) || null; },
    webhookAuthentic() { return true; },   // the notification is only a trigger — every settle re-verifies by RRR with our API key
    async ping() { return this.configured() ? { ok: true, message: 'Remita details saved — the RRR is generated live on the first payment.' } : { ok: false, message: 'Enter the merchant ID, service type ID and API key.' }; },
  },

  // ---- Interswitch (Quickteller Business / Webpay) — form POST to the hosted page, verified with
  // gettransaction.json (ResponseCode 00). Our reference carries the minor amount so verify can confirm it.
  interswitch: {
    id: 'interswitch', label: 'Interswitch — Verve · Card · Quickteller', region: 'Nigeria',
    fields: [
      { key: 'merchant', setting: 'isw_merchant_code', env: 'ISW_MERCHANT_CODE', label: 'Merchant code', placeholder: 'MX12345', secret: false, required: true },
      { key: 'payitem', setting: 'isw_pay_item_id', env: 'ISW_PAY_ITEM_ID', label: 'Pay item ID', placeholder: 'Default_Payable_MX12345', secret: false, required: true },
    ],
    keys() { return { merchant: ck(this, 'ISW_MERCHANT_CODE', 'isw_merchant_code'), payitem: ck(this, 'ISW_PAY_ITEM_ID', 'isw_pay_item_id') }; },
    configured() { const k = this.keys(); return !!(k.merchant && k.payitem); },
    async init(o) {
      const k = this.keys(); const minor = toMinor(o.amount, o.currency);
      const action = isTestMode() ? 'https://newwebpay.qa.interswitchng.com/collections/w/pay' : 'https://newwebpay.interswitchng.com/collections/w/pay';
      return { ok: true, reference: o.reference, provider_ref: o.reference + '|' + minor, form: { action, fields: { merchant_code: k.merchant, pay_item_id: k.payitem, pay_item_name: (o.title || 'School Fees').slice(0, 60), site_redirect_url: o.callback_url, txn_ref: o.reference, amount: String(minor), currency: ISO_NUM[o.currency] || '566', cust_email: o.email || '', cust_name: o.name || '', display_mode: 'PAGE' } } };
    },
    async verify(ref) {
      const [txn, minor] = String(ref).split('|'); const k = this.keys();
      const host = isTestMode() ? 'qa.interswitchng.com' : 'webpay.interswitchng.com';
      const r = await httpReq({ host, method: 'GET', path: '/collections/api/v1/gettransaction.json?merchantcode=' + encodeURIComponent(k.merchant) + '&transactionreference=' + encodeURIComponent(txn) + '&amount=' + encodeURIComponent(minor || '') });
      const j = r.json;
      if (j && String(j.ResponseCode) === '00') return { ok: true, amount: fromMinor(j.Amount, 'NGN'), currency: 'NGN', reference: String(j.MerchantReference || txn), metadata: {} };
      return { ok: false };
    },
    webhookRef(body) { return (body && (body.txnRef || body.MerchantReference || (body.data && body.data.merchantReference))) || null; },
    webhookAuthentic() { return true; },
    async ping() { return this.configured() ? { ok: true, message: 'Interswitch details saved — checked live on the first payment.' } : { ok: false, message: 'Enter the merchant code and pay item ID.' }; },
  },

  // ---- Monnify (Moniepoint) — card · transfer to a dynamic account · USSD · phone number.
  monnify: {
    id: 'monnify', label: 'Monnify — Card · Bank Transfer · USSD', region: 'Nigeria',
    fields: [
      { key: 'apikey', setting: 'monnify_api_key', env: 'MONNIFY_API_KEY', label: 'API key', placeholder: 'MK_PROD_… (or MK_TEST_…)', secret: false, required: true },
      { key: 'secret', setting: 'monnify_secret', env: 'MONNIFY_SECRET', label: 'Secret key', placeholder: 'your secret key', secret: true, required: true },
      { key: 'contract', setting: 'monnify_contract_code', env: 'MONNIFY_CONTRACT', label: 'Contract code', placeholder: '1234567890', secret: false, required: true },
    ],
    keys() { return { apikey: ck(this, 'MONNIFY_API_KEY', 'monnify_api_key'), secret: ck(this, 'MONNIFY_SECRET', 'monnify_secret'), contract: ck(this, 'MONNIFY_CONTRACT', 'monnify_contract_code') }; },
    host() { return isTestMode() ? 'sandbox.monnify.com' : 'api.monnify.com'; },
    configured() { const k = this.keys(); return !!(k.apikey && k.secret && k.contract); },
    async token() { const k = this.keys(); const r = await httpReq({ host: this.host(), method: 'POST', path: '/api/v1/auth/login', headers: { Authorization: basic(k.apikey, k.secret) }, raw: '' }); return r.json && r.json.responseBody && r.json.responseBody.accessToken; },
    async init(o) {
      const tok = await this.token(); if (!tok) return { ok: false, error: 'Monnify rejected the API key/secret.' };
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/api/v1/merchant/transactions/init-transaction', headers: { Authorization: 'Bearer ' + tok }, body: { amount: o.amount, customerName: o.name || 'Student', customerEmail: o.email, paymentReference: o.reference, paymentDescription: (o.title || 'School Fees').slice(0, 80), currencyCode: o.currency, contractCode: this.keys().contract, redirectUrl: o.callback_url, paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD', 'PHONE_NUMBER'] } });
      const b = r.json && r.json.requestSuccessful && r.json.responseBody;
      return (b && b.checkoutUrl) ? { ok: true, url: b.checkoutUrl, reference: o.reference, provider_ref: o.reference } : { ok: false, error: (r.json && r.json.responseMessage) || 'Could not start the Monnify payment.' };
    },
    async verify(ref) {
      const tok = await this.token(); if (!tok) return { ok: false };
      const r = await httpReq({ host: this.host(), method: 'GET', path: '/api/v2/merchant/transactions/query?paymentReference=' + encodeURIComponent(ref), headers: { Authorization: 'Bearer ' + tok } });
      const b = r.json && r.json.requestSuccessful && r.json.responseBody;
      if (b && (b.paymentStatus === 'PAID' || b.paymentStatus === 'OVERPAID')) return { ok: true, amount: Number(b.amountPaid) || 0, currency: String(b.currencyCode || 'NGN').toUpperCase(), reference: b.paymentReference || String(ref), metadata: b.metaData || {} };
      return { ok: false };
    },
    // 🏦 a ONE-TIME account for this payment (Monnify "pay with transfer": no BVN needed) + the USSD code for basic phones
    async transferAccount(o) {
      if (String(o.currency || '').toUpperCase() !== 'NGN') return { ok: false, user_error: true, error: 'A transfer account is for naira (NGN) payments.' };
      const tok = await this.token(); if (!tok) return { ok: false, error: 'Monnify rejected the API key/secret.' };
      const it = await httpReq({ host: this.host(), method: 'POST', path: '/api/v1/merchant/transactions/init-transaction', headers: { Authorization: 'Bearer ' + tok }, body: { amount: o.amount, customerName: o.name || 'Student', customerEmail: o.email, paymentReference: o.reference, paymentDescription: String(o.title || 'School Fees').slice(0, 80), currencyCode: 'NGN', contractCode: this.keys().contract, redirectUrl: o.callback_url, paymentMethods: ['ACCOUNT_TRANSFER'] } });
      const tr = it.json && it.json.requestSuccessful && it.json.responseBody && it.json.responseBody.transactionReference;
      if (!tr) return { ok: false, error: (it.json && it.json.responseMessage) || 'Could not start the Monnify transfer.' };
      const bt = await httpReq({ host: this.host(), method: 'POST', path: '/api/v1/merchant/bank-transfer/init-payment', headers: { Authorization: 'Bearer ' + tok }, body: { transactionReference: tr } });
      const b = bt.json && bt.json.requestSuccessful && bt.json.responseBody;
      if (!b || !b.accountNumber) return { ok: false, error: (bt.json && bt.json.responseMessage) || 'Could not open a transfer account.' };
      const exp = b.expiresOn ? Date.parse(b.expiresOn) : (Number(b.accountDurationSeconds) > 0 ? Date.now() + Number(b.accountDurationSeconds) * 1000 : NaN);
      return { ok: true, reference: o.reference, provider_ref: o.reference, transfer: { account_number: String(b.accountNumber), bank: b.bankName || '', account_name: b.accountName || '', amount: Number(b.totalPayable || b.amount) || o.amount, expires_at: isFinite(exp) ? new Date(exp).toISOString() : null, ussd: b.ussdPayment || '' } };
    },
    webhookRef(body) { const d = (body && body.eventData) || {}; return d.paymentReference || null; },
    webhookAuthentic(headers, rawBody) { const k = this.keys().secret; const sig = headers['monnify-signature']; if (!k || !sig || !rawBody) return false; return timingEqual(sig, crypto.createHmac('sha512', k).update(rawBody).digest('hex')); },
    async ping() { if (!this.configured()) return { ok: false, message: 'Enter the API key, secret key and contract code.' }; return (await this.token()) ? { ok: true, message: 'Monnify credentials are valid' + (isTestMode() ? ' (SANDBOX).' : '.') } : { ok: false, message: 'Monnify rejected the API key/secret.' }; },
  },

  // ---- Squad (GTCO) — card · bank · USSD · transfer.
  squad: {
    id: 'squad', label: 'Squad (GTCO) — Card · Bank · USSD', region: 'Nigeria',
    fields: [{ key: 'secret', setting: 'squad_secret', env: 'SQUAD_SECRET', label: 'Secret key', placeholder: 'sk_… (sandbox_sk_… for test)', secret: true, required: true }],
    keys() { return { secret: ck(this, 'SQUAD_SECRET', 'squad_secret') }; },
    host() { return isTestMode() ? 'sandbox-api-d.squadco.com' : 'api-d.squadco.com'; },
    configured() { return !!this.keys().secret; },
    async init(o) {
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/transaction/initiate', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { amount: toMinor(o.amount, o.currency), email: o.email, currency: o.currency, initiate_type: 'inline', transaction_ref: o.reference, callback_url: o.callback_url, customer_name: o.name || 'Student' } });
      const d = r.json && r.json.data;
      return (d && d.checkout_url) ? { ok: true, url: d.checkout_url, reference: o.reference, provider_ref: o.reference } : { ok: false, error: (r.json && r.json.message) || 'Could not start the Squad payment.' };
    },
    async verify(ref) {
      const r = await httpReq({ host: this.host(), method: 'GET', path: '/transaction/verify/' + encodeURIComponent(ref), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json && r.json.data;
      if (d && String(d.transaction_status).toLowerCase() === 'success') return { ok: true, amount: fromMinor(d.transaction_amount, d.transaction_currency_id || 'NGN'), currency: String(d.transaction_currency_id || 'NGN').toUpperCase(), reference: d.transaction_ref || String(ref), metadata: d.meta || {} };
      return { ok: false };
    },
    webhookRef(body) { return (body && (body.TransactionRef || (body.Body && body.Body.transaction_ref))) || null; },
    webhookAuthentic(headers, rawBody) { const k = this.keys().secret; const sig = headers['x-squad-encrypted-body']; if (!k || !sig || !rawBody) return false; return timingEqual(String(sig).toUpperCase(), crypto.createHmac('sha512', k).update(rawBody).digest('hex').toUpperCase()); },
    async ping() { if (!this.keys().secret) return { ok: false, message: 'No secret key.' }; const r = await httpReq({ host: this.host(), method: 'GET', path: '/transaction/verify/ping-' + Date.now(), headers: { Authorization: 'Bearer ' + this.keys().secret } }); return (r.status === 401 || r.status === 403) ? { ok: false, message: 'Squad rejected the key.' } : { ok: true, message: 'Squad key accepted' + (isTestMode() ? ' (SANDBOX).' : '.') }; },
  },

  // ---- Korapay — card · bank transfer · mobile money (NGN, KES, GHS…).
  korapay: {
    id: 'korapay', label: 'Korapay — Card · Transfer · Mobile Money', region: 'Africa',
    fields: [{ key: 'secret', setting: 'korapay_secret', env: 'KORAPAY_SECRET', label: 'Secret key', placeholder: 'sk_live_… (or sk_test_…)', secret: true, required: true }],
    keys() { return { secret: ck(this, 'KORAPAY_SECRET', 'korapay_secret') }; },
    configured() { return !!this.keys().secret; },
    async init(o) {
      const r = await httpReq({ host: 'api.korapay.com', method: 'POST', path: '/merchant/api/v1/charges/initialize', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { amount: o.amount, currency: o.currency, reference: o.reference, redirect_url: o.callback_url, notification_url: o.webhook_url, narration: (o.title || 'School Fees').slice(0, 100), customer: { email: o.email, name: o.name || 'Student' } } });
      const d = r.json && r.json.status && r.json.data;
      return (d && d.checkout_url) ? { ok: true, url: d.checkout_url, reference: o.reference, provider_ref: o.reference } : { ok: false, error: (r.json && r.json.message) || 'Could not start the Korapay payment.' };
    },
    async verify(ref) {
      const r = await httpReq({ host: 'api.korapay.com', method: 'GET', path: '/merchant/api/v1/charges/' + encodeURIComponent(ref), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json && r.json.status && r.json.data;
      if (d && d.status === 'success') return { ok: true, amount: Number(d.amount) || 0, currency: String(d.currency || '').toUpperCase(), reference: d.reference || String(ref), metadata: d.metadata || {} };
      if (d && d.status === 'failed') return { ok: false, state: 'failed', reason: d.message || 'The payment was declined.' };
      return { ok: false };
    },
    webhookRef(body) { return (body && body.data && body.data.reference) || null; },
    webhookAuthentic(headers, rawBody) { const k = this.keys().secret; const sig = headers['x-korapay-signature']; if (!k || !sig || !rawBody) return false; let data = null; try { data = JSON.parse(rawBody).data; } catch (_) { return false; } return timingEqual(sig, crypto.createHmac('sha256', k).update(JSON.stringify(data)).digest('hex')); },
    async ping() { if (!this.keys().secret) return { ok: false, message: 'No secret key.' }; const r = await httpReq({ host: 'api.korapay.com', method: 'GET', path: '/merchant/api/v1/charges/ping-' + Date.now(), headers: { Authorization: 'Bearer ' + this.keys().secret } }); return (r.status === 401 || r.status === 403) ? { ok: false, message: 'Korapay rejected the key.' } : { ok: true, message: 'Korapay key accepted.' }; },
  },

  // ---- OPay (cashier) — card · OPay wallet · bank · USSD.
  opay: {
    id: 'opay', label: 'OPay — Wallet · Card · Bank · USSD', region: 'Nigeria',
    fields: [
      { key: 'merchant', setting: 'opay_merchant_id', env: 'OPAY_MERCHANT_ID', label: 'Merchant ID', placeholder: '256…', secret: false, required: true },
      { key: 'public', setting: 'opay_public_key', env: 'OPAY_PUBLIC_KEY', label: 'Public key', placeholder: 'OPAYPUB…', secret: false, required: true },
      { key: 'secret', setting: 'opay_secret_key', env: 'OPAY_SECRET_KEY', label: 'Secret key', placeholder: 'OPAYPRV…', secret: true, required: true },
    ],
    keys() { return { merchant: ck(this, 'OPAY_MERCHANT_ID', 'opay_merchant_id'), public: ck(this, 'OPAY_PUBLIC_KEY', 'opay_public_key'), secret: ck(this, 'OPAY_SECRET_KEY', 'opay_secret_key') }; },
    host() { return isTestMode() ? 'testapi.opaycheckout.com' : 'liveapi.opaycheckout.com'; },
    configured() { const k = this.keys(); return !!(k.merchant && k.public && k.secret); },
    async init(o) {
      const k = this.keys();
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/api/v1/international/cashier/create', headers: { Authorization: 'Bearer ' + k.public, MerchantId: k.merchant }, body: { country: 'NG', reference: o.reference, amount: { total: toMinor(o.amount, o.currency), currency: o.currency }, returnUrl: o.callback_url, callbackUrl: o.webhook_url, cancelUrl: o.callback_url, expireAt: 30, userInfo: { userEmail: o.email, userName: o.name || 'Student' }, product: { name: (o.title || 'School Fees').slice(0, 60), description: (o.title || 'School Fees').slice(0, 100) } } });
      const d = r.json && r.json.data;
      return (d && d.cashierUrl) ? { ok: true, url: d.cashierUrl, reference: o.reference, provider_ref: o.reference } : { ok: false, error: (r.json && r.json.message) || 'Could not start the OPay payment.' };
    },
    async verify(ref) {
      const k = this.keys(); const body = JSON.stringify({ country: 'NG', reference: String(ref) });
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/api/v1/international/cashier/status', headers: { Authorization: 'Bearer ' + crypto.createHmac('sha512', k.secret).update(body).digest('hex'), MerchantId: k.merchant }, raw: body });
      const d = r.json && r.json.data;
      if (d && d.status === 'SUCCESS') return { ok: true, amount: fromMinor(d.amount && d.amount.total, (d.amount && d.amount.currency) || 'NGN'), currency: String((d.amount && d.amount.currency) || 'NGN').toUpperCase(), reference: d.reference || String(ref), metadata: {} };
      return { ok: false };
    },
    webhookRef(body) { return (body && body.payload && body.payload.reference) || null; },
    webhookAuthentic() { return true; },
    async ping() { return this.configured() ? { ok: true, message: 'OPay details saved — checked live on the first payment.' } : { ok: false, message: 'Enter the merchant ID, public key and secret key.' }; },
  },

  // ======================= REST OF AFRICA ================================================================
  // ---- CinetPay — mobile money (Orange · MTN · Moov · Wave) + card across francophone Africa.
  cinetpay: {
    id: 'cinetpay', label: 'CinetPay — Orange · MTN · Moov · Wave · Card', region: 'Francophone Africa',
    fields: [
      { key: 'apikey', setting: 'cinetpay_apikey', env: 'CINETPAY_APIKEY', label: 'API key', placeholder: 'your CinetPay API key', secret: true, required: true },
      { key: 'site', setting: 'cinetpay_site_id', env: 'CINETPAY_SITE_ID', label: 'Site ID', placeholder: '123456', secret: false, required: true },
    ],
    keys() { return { apikey: ck(this, 'CINETPAY_APIKEY', 'cinetpay_apikey'), site: ck(this, 'CINETPAY_SITE_ID', 'cinetpay_site_id') }; },
    configured() { const k = this.keys(); return !!(k.apikey && k.site); },
    async init(o) {
      const k = this.keys(); const parts = String(o.name || 'Student').trim().split(/\s+/);
      const amount = /^(XOF|XAF)$/.test(o.currency) ? Math.ceil((Number(o.amount) || 0) / 5) * 5 : o.amount;   // CFA amounts must be multiples of 5
      const r = await httpReq({ host: 'api-checkout.cinetpay.com', method: 'POST', path: '/v2/payment', body: { apikey: k.apikey, site_id: k.site, transaction_id: o.reference, amount, currency: o.currency, description: (o.title || 'School Fees').replace(/[^\w\s-]/g, ' ').slice(0, 100), notify_url: o.webhook_url, return_url: o.callback_url, channels: 'ALL', customer_email: o.email, customer_name: parts[0], customer_surname: parts.slice(1).join(' ') || parts[0] } });
      const d = r.json && r.json.data;
      return (d && d.payment_url) ? { ok: true, url: d.payment_url, reference: o.reference, provider_ref: o.reference } : { ok: false, error: (r.json && (r.json.description || r.json.message)) || 'Could not start the CinetPay payment.' };
    },
    async verify(ref) {
      const k = this.keys();
      const r = await httpReq({ host: 'api-checkout.cinetpay.com', method: 'POST', path: '/v2/payment/check', body: { apikey: k.apikey, site_id: k.site, transaction_id: String(ref) } });
      const d = r.json && r.json.data;
      if (d && d.status === 'ACCEPTED') return { ok: true, amount: Number(d.amount) || 0, currency: String(d.currency || 'XOF').toUpperCase(), reference: String(ref), metadata: {} };
      return { ok: false };
    },
    webhookRef(body) { return (body && (body.cpm_trans_id || body.transaction_id)) || null; },
    webhookAuthentic() { return true; },
    async ping() { return this.configured() ? { ok: true, message: 'CinetPay details saved — checked live on the first payment.' } : { ok: false, message: 'Enter the API key and site ID.' }; },
  },

  // ---- Hubtel (Ghana) — MTN MoMo · Telecel Cash · AirtelTigo · card.
  hubtel: {
    id: 'hubtel', label: 'Hubtel — MoMo · Telecel · AirtelTigo · Card', region: 'Ghana',
    fields: [
      { key: 'client', setting: 'hubtel_client_id', env: 'HUBTEL_CLIENT_ID', label: 'API client ID', placeholder: 'client id', secret: false, required: true },
      { key: 'secret', setting: 'hubtel_client_secret', env: 'HUBTEL_CLIENT_SECRET', label: 'API client secret', placeholder: 'client secret', secret: true, required: true },
      { key: 'account', setting: 'hubtel_merchant_account', env: 'HUBTEL_MERCHANT_ACCOUNT', label: 'Merchant account number', placeholder: '2017101', secret: false, required: true },
    ],
    keys() { return { client: ck(this, 'HUBTEL_CLIENT_ID', 'hubtel_client_id'), secret: ck(this, 'HUBTEL_CLIENT_SECRET', 'hubtel_client_secret'), account: ck(this, 'HUBTEL_MERCHANT_ACCOUNT', 'hubtel_merchant_account') }; },
    configured() { const k = this.keys(); return !!(k.client && k.secret && k.account); },
    async init(o) {
      const k = this.keys();
      const r = await httpReq({ host: 'payproxyapi.hubtel.com', method: 'POST', path: '/items/initiate', headers: { Authorization: basic(k.client, k.secret) }, body: { totalAmount: o.amount, description: (o.title || 'School Fees').slice(0, 100), callbackUrl: o.webhook_url, returnUrl: o.callback_url, cancellationUrl: o.callback_url, merchantAccountNumber: k.account, clientReference: String(o.reference).slice(0, 32) } });
      const d = r.json && r.json.data;
      return (d && d.checkoutUrl) ? { ok: true, url: d.checkoutUrl, reference: o.reference, provider_ref: String(o.reference).slice(0, 32) } : { ok: false, error: (r.json && r.json.message) || 'Could not start the Hubtel payment.' };
    },
    async verify(ref) {
      const k = this.keys();
      const r = await httpReq({ host: 'api-txnstatus.hubtel.com', method: 'GET', path: '/transactions/' + encodeURIComponent(k.account) + '/status?clientReference=' + encodeURIComponent(ref), headers: { Authorization: basic(k.client, k.secret) } });
      const d = r.json && r.json.data;
      if (d && String(d.status).toLowerCase() === 'paid') return { ok: true, amount: Number(d.amount) || 0, currency: String(d.currencyCode || 'GHS').toUpperCase(), reference: String(d.clientReference || ref), metadata: {} };
      return { ok: false };
    },
    webhookRef(body) { const d = (body && (body.Data || body.data)) || {}; return d.ClientReference || d.clientReference || null; },
    webhookAuthentic() { return true; },
    async ping() { return this.configured() ? { ok: true, message: 'Hubtel details saved — checked live on the first payment.' } : { ok: false, message: 'Enter the client ID, client secret and merchant account.' }; },
  },

  // ---- Pesapal v3 (East Africa) — M-Pesa · Airtel Money · card.
  pesapal: {
    id: 'pesapal', label: 'Pesapal — M-Pesa · Airtel Money · Card', region: 'East Africa',
    fields: [
      { key: 'key', setting: 'pesapal_consumer_key', env: 'PESAPAL_CONSUMER_KEY', label: 'Consumer key', placeholder: 'consumer key', secret: false, required: true },
      { key: 'secret', setting: 'pesapal_consumer_secret', env: 'PESAPAL_CONSUMER_SECRET', label: 'Consumer secret', placeholder: 'consumer secret', secret: true, required: true },
      { key: 'ipn', setting: 'pesapal_ipn_id', env: 'PESAPAL_IPN_ID', label: 'IPN ID (optional — registered automatically)', placeholder: '', secret: false, required: false },
    ],
    keys() { return { key: ck(this, 'PESAPAL_CONSUMER_KEY', 'pesapal_consumer_key'), secret: ck(this, 'PESAPAL_CONSUMER_SECRET', 'pesapal_consumer_secret'), ipn: ck(this, 'PESAPAL_IPN_ID', 'pesapal_ipn_id') }; },
    host() { return isTestMode() ? 'cybqa.pesapal.com' : 'pay.pesapal.com'; },
    prefix() { return isTestMode() ? '/pesapalv3' : '/v3'; },
    configured() { const k = this.keys(); return !!(k.key && k.secret); },
    async token() { const k = this.keys(); const r = await httpReq({ host: this.host(), method: 'POST', path: this.prefix() + '/api/Auth/RequestToken', body: { consumer_key: k.key, consumer_secret: k.secret } }); return r.json && r.json.token; },
    async init(o) {
      const tok = await this.token(); if (!tok) return { ok: false, error: 'Pesapal rejected the consumer key/secret.' };
      let ipn = this.keys().ipn;
      if (!ipn && o.webhook_url) { const r = await httpReq({ host: this.host(), method: 'POST', path: this.prefix() + '/api/URLSetup/RegisterIPN', headers: { Authorization: 'Bearer ' + tok }, body: { url: o.webhook_url, ipn_notification_type: 'POST' } }); ipn = r.json && r.json.ipn_id; }
      const parts = String(o.name || 'Student').trim().split(/\s+/);
      const r = await httpReq({ host: this.host(), method: 'POST', path: this.prefix() + '/api/Transactions/SubmitOrderRequest', headers: { Authorization: 'Bearer ' + tok }, body: { id: o.reference, currency: o.currency, amount: o.amount, description: (o.title || 'School Fees').slice(0, 100), callback_url: o.callback_url, notification_id: ipn || undefined, billing_address: { email_address: o.email, first_name: parts[0], last_name: parts.slice(1).join(' ') || parts[0] } } });
      const j = r.json;
      return (j && j.redirect_url) ? { ok: true, url: j.redirect_url, reference: o.reference, provider_ref: String(j.order_tracking_id || '') } : { ok: false, error: (j && j.error && (j.error.message || j.error.code)) || 'Could not start the Pesapal payment.' };
    },
    async verify(trackingId) {
      const tok = await this.token(); if (!tok) return { ok: false };
      const r = await httpReq({ host: this.host(), method: 'GET', path: this.prefix() + '/api/Transactions/GetTransactionStatus?orderTrackingId=' + encodeURIComponent(trackingId), headers: { Authorization: 'Bearer ' + tok } });
      const j = r.json;
      if (j && Number(j.status_code) === 1) return { ok: true, amount: Number(j.amount) || 0, currency: String(j.currency || '').toUpperCase(), reference: String(j.merchant_reference || trackingId), metadata: {} };
      return { ok: false };
    },
    webhookRef(body) { return (body && (body.OrderTrackingId || body.orderTrackingId)) || null; },
    webhookAuthentic() { return true; },
    async ping() { if (!this.configured()) return { ok: false, message: 'Enter the consumer key and secret.' }; return (await this.token()) ? { ok: true, message: 'Pesapal credentials are valid' + (isTestMode() ? ' (SANDBOX).' : '.') } : { ok: false, message: 'Pesapal rejected the consumer key/secret.' }; },
  },

  // ======================= GLOBAL =======================================================================
  // ---- Square — card · Apple Pay · Google Pay · Cash App (payment links).
  square: {
    id: 'square', label: 'Square — Card · Apple/Google Pay', region: 'US / UK / CA / AU / JP / EU',
    fields: [
      { key: 'token', setting: 'square_access_token', env: 'SQUARE_ACCESS_TOKEN', label: 'Access token', placeholder: 'EAAA…', secret: true, required: true },
      { key: 'location', setting: 'square_location_id', env: 'SQUARE_LOCATION_ID', label: 'Location ID', placeholder: 'L…', secret: false, required: true },
    ],
    keys() { return { token: ck(this, 'SQUARE_ACCESS_TOKEN', 'square_access_token'), location: ck(this, 'SQUARE_LOCATION_ID', 'square_location_id') }; },
    host() { return isTestMode() ? 'connect.squareupsandbox.com' : 'connect.squareup.com'; },
    hdr() { return { Authorization: 'Bearer ' + this.keys().token, 'Square-Version': '2024-06-04' }; },
    configured() { const k = this.keys(); return !!(k.token && k.location); },
    async init(o) {
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/v2/online-checkout/payment-links', headers: this.hdr(), body: { idempotency_key: o.reference, quick_pay: { name: (o.title || 'School Fees').slice(0, 250), price_money: { amount: toMinor(o.amount, o.currency), currency: o.currency }, location_id: this.keys().location }, checkout_options: { redirect_url: o.callback_url }, pre_populated_data: { buyer_email: o.email } } });
      const l = r.json && r.json.payment_link;
      return (l && l.url) ? { ok: true, url: l.url, reference: o.reference, provider_ref: String(l.order_id || '') } : { ok: false, error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].detail) || 'Could not start the Square payment.' };
    },
    async verify(orderId) {
      const r = await httpReq({ host: this.host(), method: 'GET', path: '/v2/orders/' + encodeURIComponent(orderId), headers: this.hdr() });
      const od = r.json && r.json.order;
      const due = od && od.net_amount_due_money ? Number(od.net_amount_due_money.amount) : null;
      if (od && (od.state === 'COMPLETED' || ((od.tenders || []).length && due === 0))) { const m = od.total_money || {}; return { ok: true, amount: fromMinor(m.amount, m.currency), currency: String(m.currency || '').toUpperCase(), reference: String(od.id || orderId), metadata: {} }; }
      return { ok: false };
    },
    webhookRef(body) { const o = body && body.data && body.data.object; return (o && o.payment && o.payment.order_id) || null; },
    webhookAuthentic() { return true; },
    async ping() { if (!this.configured()) return { ok: false, message: 'Enter the access token and location ID.' }; const r = await httpReq({ host: this.host(), method: 'GET', path: '/v2/locations', headers: this.hdr() }); return r.status === 200 ? { ok: true, message: 'Square token is valid' + (isTestMode() ? ' (SANDBOX).' : '.') } : { ok: false, message: 'Square rejected the token (HTTP ' + r.status + ').' }; },
  },

  // ======================= PUSH-TO-PHONE + MORE REGIONS (2026-10) ========================================
  // ---- M-Pesa (Safaricom Daraja) — STK PUSH: no checkout page at all. Safaricom pops the M-Pesa PIN prompt on
  // the payer's phone; they approve it there while the portal/app polls /api/pay/status. WE fix the amount in the
  // push request (the payer can only approve or cancel), so a successful STK query settles the intent's amount.
  mpesa: {
    id: 'mpesa', label: 'M-Pesa — approve on your phone (STK push)', region: 'Kenya / East Africa', push: true,
    fields: [
      { key: 'key', setting: 'mpesa_consumer_key', env: 'MPESA_CONSUMER_KEY', label: 'Consumer key', placeholder: 'Daraja app consumer key', secret: false, required: true },
      { key: 'secret', setting: 'mpesa_consumer_secret', env: 'MPESA_CONSUMER_SECRET', label: 'Consumer secret', placeholder: 'Daraja app consumer secret', secret: true, required: true },
      { key: 'shortcode', setting: 'mpesa_shortcode', env: 'MPESA_SHORTCODE', label: 'Business short code (Paybill / store number)', placeholder: '174379', secret: false, required: true },
      { key: 'passkey', setting: 'mpesa_passkey', env: 'MPESA_PASSKEY', label: 'Lipa na M-Pesa passkey', placeholder: 'passkey', secret: true, required: true },
      { key: 'till', setting: 'mpesa_till', env: 'MPESA_TILL', label: 'Till number (Buy Goods only — blank for a Paybill)', placeholder: '', secret: false, required: false },
    ],
    keys() { return { key: ck(this, 'MPESA_CONSUMER_KEY', 'mpesa_consumer_key'), secret: ck(this, 'MPESA_CONSUMER_SECRET', 'mpesa_consumer_secret'), shortcode: ck(this, 'MPESA_SHORTCODE', 'mpesa_shortcode'), passkey: ck(this, 'MPESA_PASSKEY', 'mpesa_passkey'), till: ck(this, 'MPESA_TILL', 'mpesa_till') }; },
    host() { return isTestMode() ? 'sandbox.safaricom.co.ke' : 'api.safaricom.co.ke'; },
    configured() { const k = this.keys(); return !!(k.key && k.secret && k.shortcode && k.passkey); },
    async token() { const k = this.keys(); const r = await httpReq({ host: this.host(), method: 'GET', path: '/oauth/v1/generate?grant_type=client_credentials', headers: { Authorization: basic(k.key, k.secret) } }); return r.json && r.json.access_token; },
    stamp() { return new Date(Date.now() + 3 * 3600000).toISOString().replace(/[^0-9]/g, '').slice(0, 14); },   // YYYYMMDDHHmmss, East Africa Time
    password(ts) { const k = this.keys(); return Buffer.from(k.shortcode + k.passkey + ts).toString('base64'); },
    async init(o) {
      if (String(o.currency || 'KES').toUpperCase() !== 'KES') return { ok: false, user_error: true, error: 'M-Pesa takes Kenyan shillings (KES) only.' };
      const phone = msisdnKE(o.phone); if (!phone) return { ok: false, user_error: true, needs_phone: true, error: 'Enter the M-Pesa phone number to send the payment prompt to (for example 0712 345 678).' };
      const tok = await this.token(); if (!tok) return { ok: false, error: 'M-Pesa rejected the consumer key/secret.' };
      const k = this.keys(); const ts = this.stamp(); const amount = Math.round(Number(o.amount) || 0);
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/mpesa/stkpush/v1/processrequest', headers: { Authorization: 'Bearer ' + tok }, body: {
        BusinessShortCode: k.shortcode, Password: this.password(ts), Timestamp: ts, TransactionType: k.till ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
        Amount: amount, PartyA: phone, PartyB: k.till || k.shortcode, PhoneNumber: phone, CallBackURL: o.webhook_url,
        AccountReference: String(o.account_ref || o.reference).replace(/[^A-Za-z0-9]/g, '').slice(0, 12), TransactionDesc: 'School fees' } });
      const j = r.json;
      if (j && String(j.ResponseCode) === '0' && j.CheckoutRequestID) return { ok: true, push: true, amount, reference: o.reference, provider_ref: String(j.CheckoutRequestID), message: j.CustomerMessage || 'Check your phone and enter your M-Pesa PIN to approve the payment.' };
      return { ok: false, error: (j && (j.errorMessage || j.ResponseDescription)) || 'Could not send the M-Pesa prompt.' };
    },
    async verify(checkoutId) {
      const tok = await this.token(); if (!tok) return { ok: false };
      const k = this.keys(); const ts = this.stamp();
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/mpesa/stkpushquery/v1/query', headers: { Authorization: 'Bearer ' + tok }, body: { BusinessShortCode: k.shortcode, Password: this.password(ts), Timestamp: ts, CheckoutRequestID: String(checkoutId) } });
      const j = r.json; if (!j || j.ResultCode == null) return { ok: false };                       // still being processed
      if (String(j.ResultCode) === '0') return { ok: true, fixedAmount: true, amount: null, currency: 'KES', reference: String(checkoutId), metadata: {} };
      const why = { '1032': 'The M-Pesa prompt was cancelled on the phone.', '1037': 'The M-Pesa prompt timed out — the phone could not be reached.', '1': 'The M-Pesa balance was too low for this payment.', '2001': 'The M-Pesa PIN entered was wrong.' }[String(j.ResultCode)];
      return { ok: false, state: 'failed', reason: why || j.ResultDesc || 'The M-Pesa payment did not go through.' };
    },
    webhookRef(body) { const cb = body && body.Body && body.Body.stkCallback; return (cb && cb.CheckoutRequestID) || null; },
    webhookAuthentic() { return true; },   // Daraja callbacks are unsigned — the STK query with our own keys is the source of truth
    async ping() { if (!this.configured()) return { ok: false, message: 'Enter the consumer key, consumer secret, short code and passkey.' }; return (await this.token()) ? { ok: true, message: 'M-Pesa (Daraja) credentials are valid' + (isTestMode() ? ' (SANDBOX).' : '.') } : { ok: false, message: 'M-Pesa rejected the consumer key/secret.' }; },
  },

  // ---- Chapa (Ethiopia) — telebirr · CBE Birr · M-Pesa · card.
  chapa: {
    id: 'chapa', label: 'Chapa — telebirr · CBE Birr · Card', region: 'Ethiopia',
    fields: [
      { key: 'secret', setting: 'chapa_secret', env: 'CHAPA_SECRET', label: 'Secret key', placeholder: 'CHASECK-… (CHASECK_TEST-… for test)', secret: true, required: true },
      { key: 'hash', setting: 'chapa_webhook_secret', env: 'CHAPA_WEBHOOK_SECRET', label: 'Webhook secret (optional)', placeholder: 'webhook secret', secret: true, required: false },
    ],
    keys() { return { secret: ck(this, 'CHAPA_SECRET', 'chapa_secret'), hash: ck(this, 'CHAPA_WEBHOOK_SECRET', 'chapa_webhook_secret') }; },
    configured() { return !!this.keys().secret; },
    async init(o) {
      const parts = String(o.name || 'Student').trim().split(/\s+/);
      const r = await httpReq({ host: 'api.chapa.co', method: 'POST', path: '/v1/transaction/initialize', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { amount: amountString(o.amount, o.currency), currency: o.currency, email: o.email, first_name: parts[0], last_name: parts.slice(1).join(' ') || parts[0], phone_number: o.phone || undefined, tx_ref: o.reference, callback_url: o.webhook_url, return_url: o.callback_url, customization: { title: String(o.title || 'School Fees').replace(/[^A-Za-z0-9 ._-]/g, ' ').trim().slice(0, 16) || 'School Fees' } } });
      const d = r.json && r.json.status === 'success' && r.json.data;
      const msg = r.json && r.json.message; return (d && d.checkout_url) ? { ok: true, url: d.checkout_url, reference: o.reference, provider_ref: o.reference } : { ok: false, error: (typeof msg === 'string' ? msg : (msg ? JSON.stringify(msg) : '')) || 'Could not start the Chapa payment.' };
    },
    async verify(ref) {
      const r = await httpReq({ host: 'api.chapa.co', method: 'GET', path: '/v1/transaction/verify/' + encodeURIComponent(ref), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json && r.json.status === 'success' && r.json.data;
      if (d && d.status === 'success') return { ok: true, amount: Number(d.amount) || 0, currency: String(d.currency || 'ETB').toUpperCase(), reference: d.tx_ref || String(ref), metadata: {} };
      if (d && d.status === 'failed') return { ok: false, state: 'failed', reason: 'The payment was declined.' };
      return { ok: false };
    },
    webhookRef(body) { return (body && (body.tx_ref || body.trx_ref)) || null; },
    webhookAuthentic(headers, rawBody) { const k = this.keys().hash; if (!k) return true; const sig = headers['chapa-signature'] || headers['x-chapa-signature']; if (!sig || !rawBody) return false; return timingEqual(sig, crypto.createHmac('sha256', k).update(rawBody).digest('hex')); },
    async ping() { if (!this.keys().secret) return { ok: false, message: 'No secret key.' }; const r = await httpReq({ host: 'api.chapa.co', method: 'GET', path: '/v1/banks', headers: { Authorization: 'Bearer ' + this.keys().secret } }); return r.status === 200 ? { ok: true, message: 'Chapa key is valid.' } : { ok: false, message: 'Chapa rejected the key (HTTP ' + r.status + ').' }; },
  },

  // ---- PayFast (South Africa) — form POST to the hosted page; confirmation is PayFast's ITN, checked 4 ways:
  // our MD5 signature, the merchant id, PayFast's own server confirming the notification (validate) and the amount
  // (the portal compares it with the checkout it started). PayFast retries an ITN it could not deliver.
  payfast: {
    id: 'payfast', label: 'PayFast — Card · Instant EFT · SnapScan', region: 'South Africa',
    fields: [
      { key: 'merchant', setting: 'payfast_merchant_id', env: 'PAYFAST_MERCHANT_ID', label: 'Merchant ID', placeholder: '10000100', secret: false, required: true },
      { key: 'key', setting: 'payfast_merchant_key', env: 'PAYFAST_MERCHANT_KEY', label: 'Merchant key', placeholder: '46f0cd694581a', secret: true, required: true },
      { key: 'passphrase', setting: 'payfast_passphrase', env: 'PAYFAST_PASSPHRASE', label: 'Passphrase (set the same one in PayFast)', placeholder: 'passphrase', secret: true, required: false },
    ],
    keys() { return { merchant: ck(this, 'PAYFAST_MERCHANT_ID', 'payfast_merchant_id'), key: ck(this, 'PAYFAST_MERCHANT_KEY', 'payfast_merchant_key'), passphrase: ck(this, 'PAYFAST_PASSPHRASE', 'payfast_passphrase') }; },
    host() { return isTestMode() ? 'sandbox.payfast.co.za' : 'www.payfast.co.za'; },
    configured() { const k = this.keys(); return !!(k.merchant && k.key); },
    /** PayFast's signature: name=value pairs in the order sent (checkout: non-blank only; ITN: as received), PHP-style
     *  url-encoded, plus the passphrase → MD5. */
    sign(fields, keepEmpty) {
      const pass = this.keys().passphrase;
      const str = Object.keys(fields).filter(k => k !== 'signature' && (keepEmpty || (fields[k] != null && String(fields[k]).trim() !== ''))).map(k => k + '=' + pfEnc(String(fields[k] == null ? '' : fields[k]).trim())).join('&') + (pass ? '&passphrase=' + pfEnc(pass.trim()) : '');
      return crypto.createHash('md5').update(str).digest('hex');
    },
    async init(o) {
      if (String(o.currency || 'ZAR').toUpperCase() !== 'ZAR') return { ok: false, user_error: true, error: 'PayFast takes South African rand (ZAR) only.' };
      const k = this.keys(); const parts = String(o.name || 'Student').trim().split(/\s+/);
      const fields = { merchant_id: k.merchant, merchant_key: k.key, return_url: o.callback_url, cancel_url: o.callback_url + '&cancelled=1', notify_url: o.webhook_url, name_first: parts[0].slice(0, 100), name_last: parts.slice(1).join(' ').slice(0, 100), email_address: o.email, m_payment_id: o.reference, amount: amountString(o.amount, 'ZAR'), item_name: String(o.title || 'School Fees').slice(0, 100) };
      for (const x of Object.keys(fields)) if (fields[x] == null || String(fields[x]).trim() === '') delete fields[x];
      fields.signature = this.sign(fields, false);
      return { ok: true, reference: o.reference, provider_ref: o.reference, form: { action: 'https://' + this.host() + '/eng/process', fields } };
    },
    async verify() { return { ok: false }; },   // no look-up by our reference — the ITN (verifyNotification) confirms
    async verifyNotification(body) {
      const b = body || {}; if (!b.m_payment_id || !b.signature) return { ok: false };
      const f = {}; for (const key of Object.keys(b)) if (key !== 'signature') f[key] = b[key];
      if (!timingEqual(String(b.signature), this.sign(f, true))) return { ok: false };
      if (String(b.merchant_id || '') !== this.keys().merchant) return { ok: false };
      const raw = Object.keys(f).map(x => x + '=' + pfEnc(String(f[x] == null ? '' : f[x]))).join('&');
      const r = await httpReq({ host: this.host(), method: 'POST', path: '/eng/query/validate', raw, contentType: 'application/x-www-form-urlencoded' });
      if (String(r.raw || '').trim() !== 'VALID') return { ok: false };
      if (b.payment_status === 'COMPLETE') return { ok: true, amount: Number(b.amount_gross) || 0, currency: 'ZAR', reference: String(b.m_payment_id), metadata: {} };
      if (b.payment_status === 'CANCELLED') return { ok: false, state: 'failed', reason: 'The payment was cancelled.' };
      return { ok: false };
    },
    webhookRef(body) { return (body && body.m_payment_id) || null; },
    webhookAuthentic() { return true; },   // verifyNotification checks the signature + PayFast's own confirmation
    async ping() { return this.configured() ? { ok: true, message: 'PayFast details saved — confirmed live by the first payment notification (ITN).' } : { ok: false, message: 'Enter the merchant ID and merchant key.' }; },
  },

  // ---- Mercado Pago (Latin America) — Checkout Pro: card · Pix · boleto · OXXO.
  mercadopago: {
    id: 'mercadopago', label: 'Mercado Pago — Card · Pix · Boleto · OXXO', region: 'Latin America',
    fields: [{ key: 'token', setting: 'mercadopago_access_token', env: 'MERCADOPAGO_ACCESS_TOKEN', label: 'Access token', placeholder: 'APP_USR-… (TEST-… for test)', secret: true, required: true }],
    keys() { return { token: ck(this, 'MERCADOPAGO_ACCESS_TOKEN', 'mercadopago_access_token') }; },
    hdr() { return { Authorization: 'Bearer ' + this.keys().token }; },
    configured() { return !!this.keys().token; },
    async init(o) {
      const r = await httpReq({ host: 'api.mercadopago.com', method: 'POST', path: '/checkout/preferences', headers: this.hdr(), body: { items: [{ title: String(o.title || 'School Fees').slice(0, 250), quantity: 1, unit_price: Number(amountString(o.amount, o.currency)), currency_id: o.currency }], external_reference: o.reference, payer: { email: o.email }, back_urls: { success: o.callback_url, failure: o.callback_url + '&cancelled=1', pending: o.callback_url }, auto_return: 'approved', notification_url: o.webhook_url, metadata: o.metadata || {} } });
      const j = r.json; const url = j && (isTestMode() ? (j.sandbox_init_point || j.init_point) : j.init_point);
      return url ? { ok: true, url, reference: o.reference, provider_ref: o.reference } : { ok: false, error: (j && j.message) || 'Could not start the Mercado Pago payment.' };
    },
    async verify(ref) {
      // a payment id (redirect ?payment_id= / webhook) or OUR external_reference (the background re-check)
      let pay = null;
      if (/^\d+$/.test(String(ref))) { const r = await httpReq({ host: 'api.mercadopago.com', method: 'GET', path: '/v1/payments/' + encodeURIComponent(ref), headers: this.hdr() }); pay = r.json && r.json.id ? r.json : null; }
      else { const r = await httpReq({ host: 'api.mercadopago.com', method: 'GET', path: '/v1/payments/search?sort=date_created&criteria=desc&external_reference=' + encodeURIComponent(ref), headers: this.hdr() }); const list = (r.json && r.json.results) || []; pay = list.find(x => x && x.status === 'approved') || list[0] || null; }
      if (pay && pay.status === 'approved') return { ok: true, amount: Number(pay.transaction_amount) || 0, currency: String(pay.currency_id || '').toUpperCase(), reference: pay.external_reference || String(ref), metadata: pay.metadata || {} };
      if (pay && (pay.status === 'rejected' || pay.status === 'cancelled')) return { ok: false, state: 'failed', reason: 'The payment was declined (' + String(pay.status_detail || pay.status).replace(/_/g, ' ') + ').' };
      return { ok: false };
    },
    webhookRef(body) { if (!body) return null; const d = body.data || {}; return (d.id != null ? String(d.id) : null) || (body.resource && /\d+$/.exec(String(body.resource)) || [null])[0] || null; },
    webhookAuthentic() { return true; },   // the payment is always re-read from the API with our token before anything settles
    async ping() { if (!this.keys().token) return { ok: false, message: 'No access token.' }; const r = await httpReq({ host: 'api.mercadopago.com', method: 'GET', path: '/v1/payment_methods', headers: this.hdr() }); return r.status === 200 ? { ok: true, message: 'Mercado Pago token is valid' + (/^TEST-/.test(this.keys().token) ? ' (TEST token).' : '.') } : { ok: false, message: 'Mercado Pago rejected the token (HTTP ' + r.status + ').' }; },
  },

  // ---- Xendit (Southeast Asia) — invoices: card · bank transfer · e-wallets · QR (IDR, PHP, THB, VND, MYR).
  xendit: {
    id: 'xendit', label: 'Xendit — Card · Bank · e-Wallet · QR', region: 'Southeast Asia',
    fields: [
      { key: 'secret', setting: 'xendit_secret', env: 'XENDIT_SECRET', label: 'Secret API key', placeholder: 'xnd_production_… (xnd_development_… for test)', secret: true, required: true },
      { key: 'token', setting: 'xendit_callback_token', env: 'XENDIT_CALLBACK_TOKEN', label: 'Callback verification token (optional)', placeholder: 'token', secret: true, required: false },
    ],
    keys() { return { secret: ck(this, 'XENDIT_SECRET', 'xendit_secret'), token: ck(this, 'XENDIT_CALLBACK_TOKEN', 'xendit_callback_token') }; },
    auth() { return basic(this.keys().secret, ''); },
    configured() { return !!this.keys().secret; },
    async init(o) {
      const r = await httpReq({ host: 'api.xendit.co', method: 'POST', path: '/v2/invoices', headers: { Authorization: this.auth() }, body: { external_id: o.reference, amount: Number(amountString(o.amount, o.currency)), currency: o.currency, payer_email: o.email, description: String(o.title || 'School Fees').slice(0, 255), success_redirect_url: o.callback_url, failure_redirect_url: o.callback_url + '&cancelled=1', metadata: o.metadata || {} } });
      const j = r.json; return (j && j.invoice_url) ? { ok: true, url: j.invoice_url, reference: o.reference, provider_ref: String(j.id) } : { ok: false, error: (j && j.message) || 'Could not start the Xendit payment.' };
    },
    async verify(id) {
      const r = await httpReq({ host: 'api.xendit.co', method: 'GET', path: '/v2/invoices/' + encodeURIComponent(id), headers: { Authorization: this.auth() } });
      const j = r.json;
      if (j && (j.status === 'PAID' || j.status === 'SETTLED')) return { ok: true, amount: Number(j.paid_amount || j.amount) || 0, currency: String(j.currency || '').toUpperCase(), reference: j.external_id || String(id), metadata: j.metadata || {} };
      if (j && j.status === 'EXPIRED') return { ok: false, state: 'failed', reason: 'The invoice expired before it was paid.' };
      return { ok: false };
    },
    webhookRef(body) { return (body && body.id) || null; },
    webhookAuthentic(headers) { const t = this.keys().token; if (!t) return true; return timingEqual(String(headers['x-callback-token'] || ''), t); },
    async ping() { if (!this.keys().secret) return { ok: false, message: 'No secret key.' }; const r = await httpReq({ host: 'api.xendit.co', method: 'GET', path: '/balance', headers: { Authorization: this.auth() } }); return r.status === 200 ? { ok: true, message: 'Xendit key is valid' + (/xnd_development/.test(this.keys().secret) ? ' (TEST key).' : '.') } : { ok: false, message: (r.json && r.json.message) || ('Xendit rejected the key (HTTP ' + r.status + ').') }; },
  },
};
/** A Kenyan mobile number in the 2547XXXXXXXX / 2541XXXXXXXX form Daraja wants (null when it is not one). */
function msisdnKE(p) { let d = String(p || '').replace(/[^0-9]/g, ''); if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1); else if (/^[17]\d{8}$/.test(d)) d = '254' + d; return /^254[17]\d{8}$/.test(d) ? d : null; }
/** PHP urlencode() — what PayFast signs (spaces → +, and !'()*~ escaped too). */
function pfEnc(s) { return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }

const PROVIDER_ORDER = ['paystack', 'flutterwave', 'remita', 'monnify', 'interswitch', 'squad', 'korapay', 'opay', 'momopay', 'cinetpay', 'hubtel', 'mpesa', 'pesapal', 'chapa', 'payfast', 'stripe', 'paypal', 'square', 'razorpay', 'mollie', 'mercadopago', 'xendit'];
function timingEqual(a, b) { try { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); } catch (_) { return false; } }

// ---------------------------------------------------------------------------
// 🩺 GATEWAY HEALTH — every checkout start is remembered (per process), so a student is steered to a gateway that
// is answering and the ops audit can show one that is failing. Three failed starts in a row within 15 minutes =
// "degraded": still offered (a student may prefer it) but LAST, and the portal fails over away from it.
// A failure caused by the student's own input (no phone number, wrong currency) never counts against a gateway.
// ---------------------------------------------------------------------------
const HEALTH = new Map();
function noteHealth(id, ok, error) {
  const k = String(id || ''); if (!k) return null;
  const h = HEALTH.get(k) || { ok: 0, fail: 0, streak: 0, last_ok: null, last_fail: null, last_error: '' };
  if (ok) { h.ok++; h.streak = 0; h.last_ok = new Date().toISOString(); } else { h.fail++; h.streak++; h.last_fail = new Date().toISOString(); h.last_error = String(error || '').slice(0, 200); }
  HEALTH.set(k, h); return h;
}
function degraded(id) { const h = HEALTH.get(String(id || '')); return !!(h && h.streak >= 3 && h.last_fail && Date.now() - Date.parse(h.last_fail) < 15 * 60000); }
function health() { const out = {}; for (const [k, v] of HEALTH) out[k] = Object.assign({ degraded: degraded(k) }, v); return out; }
function resetHealth() { HEALTH.clear(); }

// ===========================================================================
// public API (provider-agnostic dispatch)
// ===========================================================================
/** Configured gateways → drives the student's provider choices (portal/APK). */
function providers() {
  const test = isTestMode();
  return PROVIDER_ORDER.filter(id => REGISTRY[id] && REGISTRY[id].configured())
    .map(id => ({ id, label: REGISTRY[id].label + (test ? ' · TEST MODE' : ''), region: REGISTRY[id].region, test, push: !!REGISTRY[id].push, needs_phone: !!REGISTRY[id].push, transfer: typeof REGISTRY[id].transferAccount === 'function', degraded: degraded(id) }));
}
/** The admin's per-currency provider allow-list: { "USD":["paypal","stripe"], "NGN":["paystack"], … }.
 *  Stored as one JSON app-setting (`currency_providers`) so it rides the same desktop→hub config push as
 *  the merchant keys. A currency that is absent (or maps to an empty array) means "offer every configured
 *  gateway" — fully backward-compatible with deployments that never assigned methods to a currency. */
function currencyProviderMap() {
  const raw = cfg('CURRENCY_PROVIDERS', 'currency_providers');
  if (!raw) return {};
  try { const o = JSON.parse(raw); if (!o || typeof o !== 'object') return {}; const out = {}; for (const k of Object.keys(o)) { if (Array.isArray(o[k])) out[String(k).toUpperCase()] = o[k].map(x => String(x).toLowerCase()); } return out; }
  catch (_) { return {}; }
}
/** Allow-list of provider ids for a currency, or null when the currency has no assignment. */
function allowFor(currency) {
  const cur = String(currency || '').toUpperCase();
  const map = currencyProviderMap();
  const a = cur && Array.isArray(map[cur]) ? map[cur] : null;
  return (a && a.length) ? a : null;
}
/** The configured providers a student may use to pay in `currency` — honouring the admin's assignment
 *  (intersected with what is actually configured), or every configured gateway when none is assigned. */
function providersForCurrency(currency) {
  const list = providers();
  const allow = allowFor(currency);
  return allow ? list.filter(p => allow.includes(p.id)) : list;
}
/** Is `provider` an accepted online-payment method for `currency`? (enforced on /api/pay/init.) */
function providerAllowedForCurrency(provider, currency) {
  const allow = allowFor(currency);
  return allow ? allow.includes(String(provider || '').toLowerCase()) : true;
}
/** Full registry metadata (every provider + its fields + configured/required) for the admin config UI. */
function registryMeta() {
  return PROVIDER_ORDER.map(id => { const p = REGISTRY[id]; return { id, label: p.label, region: p.region, configured: p.configured(), fields: p.fields.map(f => ({ key: f.key, setting: f.setting, label: f.label, placeholder: f.placeholder, secret: !!f.secret, required: !!f.required, set: !!cfg(f.env, f.setting) })) }; });
}

// ===========================================================================
// 🏛 OFFICE PAYMENT SYSTEMS — each fee-owning office (a USER, or an office ROLE) chooses which platforms
// its students may pay its fees with, and may register ITS OWN merchant account on any platform (the money
// then lands in that office's account, not the institution's). Stored as app settings so they ride the
// same desktop → portal config push as the institution's keys:
//   accounts [{ id, provider, label, owner_id?, office?, keys:{<setting>:<value>}, active }]
//   routes   { users:{ <userId>:{ methods:[…], banks:[…] } }, roles:{ <role>:{ methods, banks } } }
//   banks    [{ id, bank, account_name, account_no, currency, sort_code?, swift?, iban?, branch?, instructions?, owner_id?, office?, active }]
// They live in SYNCED TABLES (pay_accounts · pay_routes · bank_accounts) so every office's choices merge
// per row across computers and reach every hub (LAN · cloud · Supabase); each host plugs its reader in with
// setOfficeSource(). Without a source (tests, legacy) the same shapes are read from app settings.
// A method id is either a provider ('paystack' = the institution's gateway) or 'provider@accountId' (an
// office's own account). No route → the institution's gateways + the fee owner's own accounts.
// ===========================================================================
function parseJson(raw, dflt) { try { const v = JSON.parse(raw || ''); return v == null ? dflt : v; } catch (_) { return dflt; } }
let officeSource = null;
/** Plug in the reader of the synced office tables → () => ({ accounts, routes, banks }). */
function setOfficeSource(fn) { officeSource = (typeof fn === 'function') ? fn : null; }
function hasOfficeSource() { return !!officeSource; }
function officeData() {
  if (officeSource) { try { const o = officeSource() || {}; return { accounts: o.accounts || [], routes: o.routes || {}, banks: o.banks || [] }; } catch (_) { /* fall through */ } }
  return { accounts: parseJson(cfg('PAY_ACCOUNTS', 'pay_accounts'), []), routes: parseJson(cfg('PAY_ROUTES', 'pay_routes'), {}), banks: parseJson(cfg('BANK_ACCOUNTS', 'bank_accounts'), []) };
}
/** Rows of the three synced tables → the shapes above (shared by every host's source). */
function officeFromRows(accRows, routeRows, bankRows) {
  const alive = (r) => r && !Number(r.deleted);
  const arr = (x) => { const v = typeof x === 'string' ? parseJson(x, []) : x; return Array.isArray(v) ? v : []; };
  const routes = { users: {}, roles: {} };
  for (const r of (routeRows || []).filter(alive)) { const v = { methods: arr(r.methods), banks: arr(r.banks) }; if (r.owner_id) routes.users[r.owner_id] = v; else if (r.office) routes.roles[r.office] = v; }
  return {
    accounts: (accRows || []).filter(alive).map(r => ({ id: r.id, provider: r.provider, label: r.label || '', owner_id: r.owner_id || null, office: r.office || null, keys: typeof r.keys_json === 'string' ? parseJson(r.keys_json, {}) : (r.keys_json || {}), active: Number(r.active) !== 0 })),
    routes,
    banks: (bankRows || []).filter(alive).map(r => ({ id: r.id, bank: r.bank, account_name: r.account_name, account_no: r.account_no, currency: r.currency || '', sort_code: r.sort_code || '', swift: r.swift || '', iban: r.iban || '', branch: r.branch || '', instructions: r.instructions || '', owner_id: r.owner_id || null, office: r.office || null, active: Number(r.active) !== 0 })),
  };
}
function accounts() { const a = officeData().accounts; return Array.isArray(a) ? a.filter(x => x && x.id && REGISTRY[x.provider] && x.active !== false) : []; }
function account(id) { return accounts().find(a => a.id === id) || null; }
function routes() { const r = officeData().routes; return (r && typeof r === 'object') ? { users: r.users || {}, roles: r.roles || {} } : { users: {}, roles: {} }; }
function routeFor(owner) { const R = routes(); const o = owner || {}; return (o.user_id && R.users[o.user_id]) || (o.role && R.roles[o.role]) || null; }
function ownsAccount(owner, a) { const o = owner || {}; return !!((a.owner_id && o.user_id && a.owner_id === o.user_id) || (!a.owner_id && a.office && o.role && a.office === o.role)); }
/** 'paystack' → the institution's Paystack; 'paystack@acc_1' → that office's own Paystack account (a clone
 *  that reads ONLY the account's keys). Unknown/inactive → null. */
function resolve(id) {
  const s = String(id || '').trim(); const at = s.indexOf('@');
  const pid = (at > 0 ? s.slice(0, at) : s).toLowerCase(); const base = REGISTRY[pid]; if (!base) return null;
  if (at < 0) return base;
  const acc = account(s.slice(at + 1)); if (!acc || acc.provider !== pid) return null;
  const clone = Object.create(base); clone._ov = acc.keys || {}; clone._acct = acc; return clone;
}
function providerOf(id) { const s = String(id || ''); const at = s.indexOf('@'); return (at > 0 ? s.slice(0, at) : s).toLowerCase(); }
/** Every method that can take money right now (institution gateways + office accounts), unfiltered. */
function allMethods() {
  const test = isTestMode(); const out = [];
  for (const id of PROVIDER_ORDER) { const p = REGISTRY[id]; if (p.configured()) out.push({ id, provider: id, label: p.label, region: p.region, test, account: null, owner_id: null, office: null }); }
  for (const a of accounts()) { const p = resolve(a.provider + '@' + a.id); if (p && p.configured()) out.push({ id: a.provider + '@' + a.id, provider: a.provider, label: (a.label ? a.label + ' — ' : '') + REGISTRY[a.provider].label, region: REGISTRY[a.provider].region, test, account: a.id, owner_id: a.owner_id || null, office: a.office || null }); }
  return out;
}
/** The methods a student may use to pay a fee owned by `owner` ({user_id, role}) in `currency`. */
function optionsFor(owner, currency) {
  const all = allMethods(); const route = routeFor(owner);
  let list = (route && Array.isArray(route.methods) && route.methods.length) ? all.filter(o => route.methods.includes(o.id))
    : all.filter(o => !o.account || ownsAccount(owner, { owner_id: o.owner_id, office: o.office }));
  const allow = allowFor(currency); if (allow) list = list.filter(o => allow.includes(o.provider));
  // a gateway that keeps failing right now goes to the END of the list (stable for the rest)
  list = list.map((o, i) => ({ o, i, bad: degraded(o.id) })).sort((a, b) => (a.bad - b.bad) || (a.i - b.i)).map(x => x.o);
  return list.map(o => ({ id: o.id, provider: o.provider, label: o.label + (o.test ? ' · TEST MODE' : ''), region: o.region, test: o.test, account: o.account, push: !!(REGISTRY[o.provider] && REGISTRY[o.provider].push), needs_phone: !!(REGISTRY[o.provider] && REGISTRY[o.provider].push), transfer: !!(REGISTRY[o.provider] && typeof REGISTRY[o.provider].transferAccount === 'function'), degraded: degraded(o.id) }));
}
function methodAllowed(owner, id, currency) { return optionsFor(owner, currency).some(o => o.id === String(id || '')); }
/** Offline: the bank accounts students of this owner transfer into (route → owner's own → any active). */
function bankAccounts() { const a = officeData().banks; return Array.isArray(a) ? a.filter(x => x && x.id && x.account_no && x.active !== false) : []; }
function banksFor(owner, currency) {
  const all = bankAccounts(); const route = routeFor(owner); const cur = String(currency || '').toUpperCase();
  let list = (route && Array.isArray(route.banks) && route.banks.length) ? all.filter(b => route.banks.includes(b.id)) : all.filter(b => ownsAccount(owner, b));
  if (!list.length) list = all.filter(b => !b.owner_id && !b.office);              // the institution's general accounts
  if (cur) { const same = list.filter(b => !b.currency || String(b.currency).toUpperCase() === cur); if (same.length) list = same; }
  return list;
}
/** Catalogue for the office "Payment methods" screen: every platform + its fields (never secret values). */
function catalog() { return PROVIDER_ORDER.map(id => { const p = REGISTRY[id]; return { id, label: p.label, region: p.region, institution: p.configured(), fields: p.fields.map(f => ({ key: f.key, setting: f.setting, label: f.label, placeholder: f.placeholder, secret: !!f.secret, required: !!f.required })) }; }); }

function configured(provider) { const p = resolve(provider); return !!(p && p.configured()); }
/** Every app-setting key this gateway reads (all providers' fields + the global flags + office systems) —
 *  so a hub can forward the whole payment config to a remote portal (desktop → cloud) in one shot. */
function payConfigKeys() {
  const keys = new Set(['payments_test_mode', 'fees_bank', 'currency_providers', 'ussd_key', 'ussd_code']);   // office systems travel as synced rows, not settings
  for (const id of PROVIDER_ORDER) for (const f of (REGISTRY[id].fields || [])) if (f.setting) keys.add(f.setting);
  return Array.from(keys);
}
/** Start a checkout. Returns { ok, url } for a redirect, or { ok, form:{action, fields} } for providers whose
 *  hosted page must be reached by an HTML form POST (Remita, Interswitch) — the portal serves that form. */
async function init(provider, o = {}) {
  const p = resolve(provider); if (!p) return { ok: false, error: 'Unknown payment provider.' };
  if (!p.configured()) return { ok: false, error: p.label + ' is not configured.' };
  const amount = Math.round((Number(o.amount) || 0) * 100) / 100;
  if (!(amount > 0)) return { ok: false, error: 'Invalid amount.' };
  const reference = String(o.reference || ('PAY-' + Date.now()));
  let r;
  const args = Object.assign({}, o, { amount, currency: String(o.currency || 'NGN').toUpperCase(), reference });
  // 🏦 mode 'transfer' → a one-time account to transfer into (auto-confirmed), instead of a card/checkout page
  if (o.mode === 'transfer' && typeof p.transferAccount !== 'function') return { ok: false, user_error: true, error: p.label.split(' — ')[0] + ' cannot give a transfer account — choose another method.' };
  try { r = await (o.mode === 'transfer' ? p.transferAccount(args) : p.init(args)); }
  catch (_) { r = { ok: false, error: 'The payment provider could not be reached. Please try again.' }; }
  if (!r || typeof r !== 'object') r = { ok: false, error: 'The payment provider gave no answer.' };
  if (r.ok || !r.user_error) noteHealth(provider, !!r.ok, r.error);
  if (r.ok && p.push) r.push = true;
  return r;
}
async function verify(provider, ref) {
  const p = resolve(provider); if (!p || !p.configured() || !ref) return { ok: false };
  try { return await p.verify(ref); } catch (_) { return { ok: false }; }
}
/** Providers whose confirmation arrives as a signed NOTIFICATION rather than a look-up (PayFast ITN) → the verified
 *  result from the notification body itself; null when the provider has no such check (use webhookRef + verify). */
async function verifyNotification(provider, body) {
  const p = resolve(provider); if (!p || !p.configured() || typeof p.verifyNotification !== 'function') return null;
  try { return await p.verifyNotification(body); } catch (_) { return { ok: false }; }
}
function isPush(provider) { const p = resolve(provider); return !!(p && p.push); }
/** Can this method give a one-time transfer account (auto-confirmed bank transfer)? */
function canTransfer(provider) { const p = resolve(provider); return !!(p && typeof p.transferAccount === 'function'); }
function webhookRef(provider, body) { const p = resolve(provider); try { return p ? p.webhookRef(body) : null; } catch (_) { return null; } }
/** ⚠ A chargeback / dispute notice in a webhook body → { id } of the dispute, else null. Only a TRIGGER: the dispute
 *  itself is always read back from the provider with our secret key (fetchDispute) before anything changes. */
function disputeEvent(provider, body) { const p = resolve(provider); try { return p && typeof p.disputeOf === 'function' ? p.disputeOf(body) : null; } catch (_) { return null; } }
/** → { ok, id, status:'open'|'won'|'lost', reference (OUR checkout reference), amount, currency, reason, due_at } */
async function fetchDispute(provider, id) {
  const p = resolve(provider); if (!p || !p.configured() || typeof p.fetchDispute !== 'function' || !id) return { ok: false };
  try { const d = await p.fetchDispute(String(id)); return d && d.ok && ['open', 'won', 'lost'].includes(d.status) ? d : { ok: false }; } catch (_) { return { ok: false }; }
}
function canDispute(provider) { const p = resolve(provider); return !!(p && typeof p.fetchDispute === 'function'); }
/** 🔁 The provider's own list of SUCCESSFUL payments between two times → { ok, complete, items:[{ reference (ours),
 *  provider_tx, amount, currency, paid_at }] } (complete=false when the list was longer than we page through). */
async function listSuccessful(provider, fromIso, toIso) {
  const p = resolve(provider); if (!p || !p.configured() || typeof p.listSuccessful !== 'function') return { ok: false, error: 'This method cannot list its payments.' };
  try { const r = await p.listSuccessful(fromIso, toIso); return r && typeof r === 'object' ? r : { ok: false, error: 'No answer.' }; } catch (_) { return { ok: false, error: 'The provider could not be reached.' }; }
}
function canList(provider) { const p = resolve(provider); return !!(p && typeof p.listSuccessful === 'function'); }
/** 💸 Can this method refund a payment back to the card / account it came from? */
function canRefund(provider) { const p = resolve(provider); return !!(p && typeof p.refund === 'function'); }
/** → { ok, state:'done'|'pending'|'failed', refund_id, reason }. o = { reference (ours), provider_ref, amount, currency, reason } */
async function refundPayment(provider, o) {
  const p = resolve(provider); if (!p || !p.configured() || typeof p.refund !== 'function') return { ok: false, state: 'failed', reason: 'This method cannot refund to the card.' };
  try { const r = await p.refund(o); return r && typeof r === 'object' ? r : { ok: false, state: 'failed', reason: 'No answer from the provider.' }; } catch (_) { return { ok: false, state: 'error', reason: 'The payment provider could not be reached.' }; }
}
async function refundStatus(provider, id) {
  const p = resolve(provider); if (!p || !p.configured() || typeof p.refundStatus !== 'function' || !id) return { ok: false };
  try { return (await p.refundStatus(String(id))) || { ok: false }; } catch (_) { return { ok: false }; }
}
/** 🔁 AutoPay: can this method charge a saved card again? */
function canAutopay(provider) { const p = resolve(provider); return !!(p && typeof p.chargeToken === 'function'); }
/** → { ok, state:'paid'|'pending'|'failed', reference, reason }. Only a TRIGGER — the money is recorded after verify(). */
async function chargeToken(provider, o) {
  const p = resolve(provider); if (!p || !p.configured() || typeof p.chargeToken !== 'function') return { ok: false, state: 'failed', reason: 'This method cannot charge a saved card.' };
  let r; try { r = await p.chargeToken(o); } catch (_) { r = { ok: false, state: 'error', reason: 'The payment provider could not be reached.' }; }
  if (!r || typeof r !== 'object') r = { ok: false, state: 'error', reason: 'The payment provider gave no answer.' };
  return r;
}
/** 📞 USSD (pay from a basic phone): the code payers dial (shown on pages, reminders and the app) and the secret part of
 *  the callback address the USSD aggregator calls. Both are set by the admin on the desktop and travel with the pay config. */
function ussdConfig() { return { key: cfg('USSD_KEY', 'ussd_key'), code: cfg('USSD_CODE', 'ussd_code') }; }
function webhookAuthentic(provider, headers, rawBody) { const p = resolve(provider); try { return p ? !!p.webhookAuthentic(headers || {}, rawBody) : false; } catch (_) { return false; } }
/** Test-connection. `keys` (optional) tests an office account's keys BEFORE they are saved. */
async function ping(provider, keys) {
  let p = resolve(provider); if (!p) return { ok: false, message: 'Unknown provider.' };
  if (keys && typeof keys === 'object') { p = Object.create(REGISTRY[providerOf(provider)]); p._ov = keys; }
  try { return await p.ping(); } catch (_) { return { ok: false, message: 'Could not reach the provider.' }; }
}

module.exports = {
  providers, registryMeta, configured, init, verify, verifyNotification, isPush, canTransfer, webhookRef, webhookAuthentic, ping, configure, isTestMode, payConfigKeys,
  disputeEvent, fetchDispute, canDispute, listSuccessful, canList, ussdConfig, hasConfig, hasOfficeSource, canAutopay, chargeToken, canRefund, refundPayment, refundStatus,
  // 🩺 gateway health (failover ordering + ops audit)
  health, degraded, noteHealth, resetHealth, msisdnKE, pfEnc,
  // per-currency accepted methods
  providersForCurrency, providerAllowedForCurrency, currencyProviderMap,
  // 🏛 office payment systems
  accounts, routes, optionsFor, methodAllowed, bankAccounts, banksFor, catalog, allMethods, providerOf, resolve, setOfficeSource, officeFromRows,
  // pure helpers (unit-tested)
  toMinor, fromMinor, amountString, decimalsFor, formEncode, timingEqual, sha512, REGISTRY, PROVIDER_ORDER,
};
