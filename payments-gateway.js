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
function cfg(envKey, settingKey) {
  if (cfgGet && settingKey) { try { const v = cfgGet(settingKey); if (v) return String(v).trim(); } catch (_) {} }
  return (process.env[envKey] || '').trim();
}
/** Global sandbox/test flag. */
function isTestMode() { const v = cfg('PAYMENTS_TEST_MODE', 'payments_test_mode'); return v === '1' || /^(true|yes|on)$/i.test(v); }

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
    keys() { return { secret: cfg('PAYSTACK_SECRET', 'paystack_secret') }; },
    configured() { return !!this.keys().secret; },
    async init(o) {
      const r = await httpReq({ host: 'api.paystack.co', method: 'POST', path: '/transaction/initialize', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { email: o.email, amount: toMinor(o.amount, o.currency), currency: o.currency, reference: o.reference, callback_url: o.callback_url, metadata: o.metadata || {} } });
      const d = r.json && r.json.status && r.json.data;
      return (d && d.authorization_url) ? { ok: true, url: d.authorization_url, reference: d.reference || o.reference } : { ok: false, error: (r.json && r.json.message) || 'Could not start the Paystack payment.' };
    },
    async verify(ref) {
      const r = await httpReq({ host: 'api.paystack.co', method: 'GET', path: '/transaction/verify/' + encodeURIComponent(ref), headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json && r.json.status && r.json.data;
      if (d && d.status === 'success') return { ok: true, amount: fromMinor(d.amount, d.currency), currency: String(d.currency || '').toUpperCase(), reference: d.reference || String(ref), metadata: d.metadata || {} };
      return { ok: false };
    },
    webhookRef(body) { const d = (body && body.data) || {}; return d.reference || null; },
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
    keys() { return { secret: cfg('FLW_SECRET_KEY', 'flw_secret_key'), hash: cfg('FLW_SECRET_HASH', 'flw_secret_hash') }; },
    configured() { return !!this.keys().secret; },
    async init(o) {
      const r = await httpReq({ host: 'api.flutterwave.com', method: 'POST', path: '/v3/payments', headers: { Authorization: 'Bearer ' + this.keys().secret }, body: { tx_ref: o.reference, amount: o.amount, currency: o.currency, redirect_url: o.callback_url, customer: { email: o.email, name: o.name || undefined, phonenumber: o.phone || undefined }, customizations: { title: o.title || 'School Fees' }, meta: o.metadata || {} } });
      const link = r.json && r.json.status === 'success' && r.json.data && r.json.data.link;
      return link ? { ok: true, url: link, reference: o.reference } : { ok: false, error: (r.json && r.json.message) || 'Could not start the Flutterwave payment.' };
    },
    async verify(ref) {
      const r = await httpReq({ host: 'api.flutterwave.com', method: 'GET', path: '/v3/transactions/' + encodeURIComponent(ref) + '/verify', headers: { Authorization: 'Bearer ' + this.keys().secret } });
      const d = r.json && r.json.status === 'success' && r.json.data;
      if (d && d.status === 'successful') return { ok: true, amount: Number(d.amount) || 0, currency: String(d.currency || '').toUpperCase(), reference: d.tx_ref || String(ref), metadata: d.meta || {} };
      return { ok: false };
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
    keys() { return { secret: cfg('STRIPE_SECRET', 'stripe_secret'), webhook: cfg('STRIPE_WEBHOOK_SECRET', 'stripe_webhook_secret') }; },
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
      return { ok: false };
    },
    webhookRef(body) { const obj = body && body.data && body.data.object; return (obj && (obj.id || (obj.metadata && obj.metadata.reference))) || null; },
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
    keys() { return { client: cfg('PAYPAL_CLIENT_ID', 'paypal_client_id'), secret: cfg('PAYPAL_SECRET', 'paypal_secret') }; },
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
    keys() { return { keyid: cfg('RAZORPAY_KEY_ID', 'razorpay_key_id'), secret: cfg('RAZORPAY_KEY_SECRET', 'razorpay_secret'), webhook: cfg('RAZORPAY_WEBHOOK_SECRET', 'razorpay_webhook_secret') }; },
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
    keys() { return { secret: cfg('MOLLIE_API_KEY', 'mollie_api_key') }; },
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
    keys() { return { secret: cfg('MOMOPAY_SECRET', 'momopay_secret'), webhook: cfg('MOMOPAY_WEBHOOK_SECRET', 'momopay_webhook_secret') }; },
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
    webhookRef(body) { const o = this._tx(body) || (body && (body.entity || (body.data && body.data.object))) || body; return (o && o.id) || null; },
    webhookAuthentic(headers, rawBody) {
      const secret = this.keys().webhook; if (!secret) return true; // no secret set → rely on the mandatory API re-verify (a forged webhook can't settle)
      const sig = headers['x-fedapay-signature']; if (!sig || !rawBody) return false;
      try { const parts = {}; String(sig).split(',').forEach(p => { const i = p.indexOf('='); if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); const payload = parts.t ? (parts.t + '.' + rawBody) : rawBody; const expect = crypto.createHmac('sha256', secret).update(payload).digest('hex'); return timingEqual(parts.s || parts.v1 || sig, expect); } catch (_) { return false; }
    },
    async ping() { if (!this.keys().secret) return { ok: false, message: 'Enter the FedaPay secret key.' }; const r = await httpReq({ host: this.host(), method: 'GET', path: '/v1/currencies', headers: { Authorization: 'Bearer ' + this.keys().secret } }); return r.status === 200 ? { ok: true, message: 'MoMoPay (FedaPay) key is valid' + (isTestMode() ? ' (SANDBOX).' : '.') } : { ok: false, message: (r.json && r.json.message) || ('FedaPay rejected the key (HTTP ' + r.status + ').') }; },
  },
};

const PROVIDER_ORDER = ['paystack', 'flutterwave', 'momopay', 'stripe', 'paypal', 'razorpay', 'mollie'];
function timingEqual(a, b) { try { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); } catch (_) { return false; } }

// ===========================================================================
// public API (provider-agnostic dispatch)
// ===========================================================================
/** Configured gateways → drives the student's provider choices (portal/APK). */
function providers() {
  const test = isTestMode();
  return PROVIDER_ORDER.filter(id => REGISTRY[id] && REGISTRY[id].configured())
    .map(id => ({ id, label: REGISTRY[id].label + (test ? ' · TEST MODE' : ''), region: REGISTRY[id].region, test }));
}
/** Full registry metadata (every provider + its fields + configured/required) for the admin config UI. */
function registryMeta() {
  return PROVIDER_ORDER.map(id => { const p = REGISTRY[id]; return { id, label: p.label, region: p.region, configured: p.configured(), fields: p.fields.map(f => ({ key: f.key, setting: f.setting, label: f.label, placeholder: f.placeholder, secret: !!f.secret, required: !!f.required, set: !!cfg(f.env, f.setting) })) }; });
}
function configured(provider) { return !!(REGISTRY[provider] && REGISTRY[provider].configured()); }
/** Every app-setting key this gateway reads (all providers' fields + the global flags) — so a hub can
 *  collect and forward the whole payment config to a remote portal (e.g. desktop → cloud) in one shot. */
function payConfigKeys() {
  const keys = new Set(['payments_test_mode', 'fees_bank']);
  for (const id of PROVIDER_ORDER) for (const f of (REGISTRY[id].fields || [])) if (f.setting) keys.add(f.setting);
  return Array.from(keys);
}
async function init(provider, o = {}) {
  const p = REGISTRY[provider]; if (!p) return { ok: false, error: 'Unknown payment provider.' };
  if (!p.configured()) return { ok: false, error: REGISTRY[provider].label + ' is not configured.' };
  const amount = Math.round((Number(o.amount) || 0) * 100) / 100;
  if (!(amount > 0)) return { ok: false, error: 'Invalid amount.' };
  const reference = String(o.reference || ('PAY-' + Date.now()));
  try { return await p.init(Object.assign({}, o, { amount, currency: String(o.currency || 'NGN').toUpperCase(), reference })); }
  catch (_) { return { ok: false, error: 'The payment provider could not be reached. Please try again.' }; }
}
async function verify(provider, ref) {
  const p = REGISTRY[provider]; if (!p || !p.configured() || !ref) return { ok: false };
  try { return await p.verify(ref); } catch (_) { return { ok: false }; }
}
function webhookRef(provider, body) { const p = REGISTRY[provider]; return p ? p.webhookRef(body) : null; }
function webhookAuthentic(provider, headers, rawBody) { const p = REGISTRY[provider]; try { return p ? !!p.webhookAuthentic(headers || {}, rawBody) : false; } catch (_) { return false; } }
async function ping(provider) { const p = REGISTRY[provider]; if (!p) return { ok: false, message: 'Unknown provider.' }; try { return await p.ping(); } catch (_) { return { ok: false, message: 'Could not reach the provider.' }; } }

module.exports = {
  providers, registryMeta, configured, init, verify, webhookRef, webhookAuthentic, ping, configure, isTestMode, payConfigKeys,
  // pure helpers (unit-tested)
  toMinor, fromMinor, amountString, decimalsFor, formEncode, timingEqual, REGISTRY, PROVIDER_ORDER,
};
