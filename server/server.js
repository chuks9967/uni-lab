'use strict';
/**
 * UniBursar Sync Hub — ZERO‑dependency REST server (pure Node built‑ins).
 *
 * Because it uses only Node's own modules, it runs with NO `npm install` for
 * sync — just upload this file and start it. (Email relay is optional and only
 * needs `nodemailer`; if it isn't installed the relay simply reports so.)
 *
 *   node server.js                 (or set the startup file to server.js in cPanel)
 *   PORT=4000 node server.js
 *
 * Env vars:
 *   PORT        listen port            (cPanel/Passenger/Render set this for you)
 *   DATA_DIR    where to store data    (defaults to ./data; persists on cPanel)
 *   SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS/SMTP_FROM  (email relay)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
// portal is optional — if portal.js wasn't uploaded, the hub still runs sync/email
let createPortal = null;
try { createPortal = require('./portal'); }
catch (e) { console.error('[UniBursar] portal.js not loaded (' + e.message + ') — upload server/portal.js to enable the web portal. Sync/email still work.'); }
// Firebase Cloud Messaging (native-app push). Optional — no-op unless FCM_SERVICE_ACCOUNT[_JSON] is set.
let fcm = null;
try { fcm = require('./fcm'); } catch (_) { fcm = null; }

const BUILD = 'portal-27'; // bump when server changes — visible at /health to confirm the live code
const PORT = process.env.PORT || 4000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SYNC_TOKEN = process.env.SYNC_TOKEN || ''; // optional shared secret
const tokenOk = (req) => !SYNC_TOKEN || (req.headers['x-sync-token'] || '') === SYNC_TOKEN;
const STORE = path.join(DATA_DIR, 'central-store.json');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

let store = { epoch: crypto.randomUUID(), records: {} };
try {
  if (fs.existsSync(STORE)) {
    const loaded = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    store = loaded && loaded.records ? loaded : { epoch: crypto.randomUUID(), records: loaded || {} };
  }
} catch (_) { store = { epoch: crypto.randomUUID(), records: {} }; }
if (!store.epoch) store.epoch = crypto.randomUUID();
if (!('branding' in store)) store.branding = null; // {name, short, logo, motto} pushed by the app
if (!store.deviceTokens) store.deviceTokens = {}; // fcmToken -> { kind, id, platform, ts } (native app push targets)

let saveTimer = null;
function save() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; try { fs.writeFileSync(STORE, JSON.stringify(store)); } catch (_) {} }, 600); }

// ---- Supabase backing (optional) ------------------------------------------
// When SUPABASE_URL + SUPABASE_KEY are set, this hub mirrors the SAME generic JSONB
// store the desktop app writes to (table `sync_records`), so the online portal shows the
// exact same data even when no desktop is online. The desktop may write to Supabase
// directly (cloud mode) OR through this hub (hub mode) — either way the portal stays aligned.
const https = require('https');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supaEnabled = () => !!(SUPABASE_URL && SUPABASE_KEY);
let lastCloudPull = '';

function supaRest(method, path, body, extraHeaders, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(SUPABASE_URL + path); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const headers = Object.assign({ 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' }, extraHeaders || {});
    if (data) headers['Content-Length'] = data.length;
    const req = lib.request({ method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers, timeout: timeoutMs || 30000 }, (res) => {
      let buf = ''; res.on('data', d => buf += d); res.on('end', () => { let j = null; try { j = buf ? JSON.parse(buf) : null; } catch (_) {} resolve({ status: res.statusCode, json: j, raw: buf }); });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data); req.end();
  });
}
async function cloudUpsert(records) {
  if (!supaEnabled() || !records.length) return;
  // de-duplicate by key (keep newest) — a single upsert can't affect the same row twice
  const byKey = new Map();
  for (const r of records) byKey.set(r.entity + ':' + r.id, { key: r.entity + ':' + r.id, entity: r.entity, entity_id: String(r.id), row: r.row, updated_at: r.updated_at || new Date().toISOString() });
  try { await supaRest('POST', '/rest/v1/sync_records', [...byKey.values()], { 'Prefer': 'resolution=merge-duplicates,return=minimal' }); } catch (e) { console.error('[supabase] upsert failed:', e.message); }
}
async function cloudGetMeta(key) {
  try { const r = await supaRest('GET', '/rest/v1/sync_meta?select=value&key=eq.' + encodeURIComponent(key)); if (Array.isArray(r.json) && r.json[0]) return r.json[0].value; } catch (_) {}
  return null;
}
async function cloudSetMeta(key, value) {
  if (!supaEnabled()) return;
  try { await supaRest('POST', '/rest/v1/sync_meta', [{ key, value: value == null ? null : String(value) }], { 'Prefer': 'resolution=merge-duplicates,return=minimal' }); } catch (e) { console.error('[supabase] setMeta failed:', e.message); }
}
/** Merge a page of cloud rows into the in-memory store; advances the pull watermark. */
function mergeCloudRows(page) {
  let n = 0; const pushable = [];
  for (const rec of page || []) {
    if (!rec || !rec.row) continue;
    const key = rec.entity + ':' + rec.entity_id;
    const prev = store.records[key];
    const ua = rec.updated_at || (rec.row && rec.row.updated_at);
    if (prev && prev.updated_at && ua && ua <= prev.updated_at) { if (ua > lastCloudPull) lastCloudPull = ua; continue; }
    if (collectPushable(rec.entity, prev, rec.row)) pushable.push({ entity: rec.entity, row: rec.row });
    store.records[key] = { entity: rec.entity, id: rec.entity_id, row: rec.row, updated_at: ua };
    if (ua && ua > lastCloudPull) lastCloudPull = ua;
    n++;
  }
  if (n) { storeVersion = Date.now(); save(); }
  if (pushable.length) pushNewRecords(pushable); // fire-and-forget native push (no-op without FCM creds)
  return n;
}
async function cloudLoadAll() {
  if (!supaEnabled()) return;
  try {
    const ep = await cloudGetMeta('epoch'); if (ep) store.epoch = ep;
    const br = await cloudGetMeta('branding'); if (br) { try { store.branding = JSON.parse(br); } catch (_) {} }
    // restore registered push tokens (Cloud Run's local FS is ephemeral — without this, a cold start
    // would forget every device and pushes would stop until each app re-registers on next open).
    const dt = await cloudGetMeta('deviceTokens'); if (dt) { try { const o = JSON.parse(dt); if (o && typeof o === 'object') store.deviceTokens = Object.assign(o, store.deviceTokens); } catch (_) {} }
    let offset = 0; const PAGE = 1000; let total = 0;
    for (;;) {
      const r = await supaRest('GET', '/rest/v1/sync_records?select=entity,entity_id,row,updated_at&order=updated_at.asc&limit=' + PAGE + '&offset=' + offset);
      if (r.status < 200 || r.status >= 300) { console.error('[supabase] load failed (' + r.status + '): ' + (r.raw || '').slice(0, 200)); break; }
      const page = Array.isArray(r.json) ? r.json : [];
      total += mergeCloudRows(page);
      if (page.length < PAGE) break; offset += PAGE;
    }
    console.log('[supabase] portal loaded ' + total + ' records from the cloud.');
  } catch (e) { console.error('[supabase] initial load failed:', e.message); }
}
let brandingTick = 0;
async function cloudPullDelta() {
  if (!supaEnabled()) return;
  try {
    // FIRST detect a cloud RESET: the desktop rotates the "epoch" whenever it wipes the cloud
    // (e.g. before a fresh student-database migration). When the epoch changes we must DROP our
    // stale in-memory store and reload the fresh cloud — otherwise the portal keeps showing the
    // old/duplicate records that were just deleted from the cloud.
    const ep = await cloudGetMeta('epoch');
    if (ep && ep !== store.epoch) {
      console.log('[supabase] cloud epoch changed (' + String(store.epoch).slice(0, 8) + ' → ' + String(ep).slice(0, 8) + ') — clearing portal store and reloading the fresh cloud.');
      store.epoch = ep; store.records = {}; lastCloudPull = ''; storeVersion = Date.now(); save();
      await cloudLoadAll();
      storeVersion = Date.now();
      return;
    }
    // Incremental pull, paginated and using >= (not >). Many migrated rows share the SAME updated_at
    // timestamp; with a strict ">" the portal would skip every row equal to the watermark and stay
    // short (the "portal shows 83 of 371" bug). ">=" re-fetches the boundary rows, but mergeCloudRows
    // de-duplicates them, so nothing is missed and the portal converges to the full count.
    const PAGE = 1000;
    for (let offset = 0; offset < 200000; offset += PAGE) {
      let path = '/rest/v1/sync_records?select=entity,entity_id,row,updated_at&order=updated_at.asc&limit=' + PAGE + '&offset=' + offset;
      if (lastCloudPull) path += '&updated_at=gte.' + encodeURIComponent(lastCloudPull);
      const r = await supaRest('GET', path);
      if (!(r.status >= 200 && r.status < 300 && Array.isArray(r.json))) break;
      mergeCloudRows(r.json);
      if (r.json.length < PAGE) break; // last page
    }
    // refresh branding (logo + university name) every ~30s so the portal reflects changes the
    // desktop pushed AFTER this server booted, without needing a restart.
    if ((brandingTick++ % 6) === 0) {
      const br = await cloudGetMeta('branding'); if (br) { try { const b = JSON.parse(br); if (b && (b.name || b.logo)) { store.branding = b; storeVersion = Date.now(); } } catch (_) {} }
    }
  } catch (_) { /* transient — try again next tick */ }
}

// in-memory version bumped on every applied change → portal clients poll this for live updates
let storeVersion = Date.now();
function allEntity(entity) { const out = []; for (const k in store.records) { const r = store.records[k]; if (r.entity === entity && r.row && !r.row.deleted) out.push(r.row); } return out; }
function oneEntity(entity, id) { const r = store.records[entity + ':' + id]; return r && r.row && !r.row.deleted ? r.row : null; }

// ---- native-app push (FCM) when a document/result is posted ---------------------------------
// Fires only for records that arrive AFTER boot (the initial backlog loaded at startup must NOT
// notify everyone). No-op unless FCM credentials are configured (see server/fcm.js).
let pushReady = false;
setTimeout(() => { pushReady = true; }, 20000);
function studentsForDoc(d) {
  if (!d) return [];
  if (d.student_id) return [d.student_id];
  return allEntity('students').filter(s =>
    (!d.faculty_id || s.faculty_id === d.faculty_id) &&
    (!d.department_id || s.department_id === d.department_id) &&
    (!d.level_id || s.level_id === d.level_id)).map(s => s.id);
}
function tokensForStudents(ids) {
  const set = new Set(ids); const out = [];
  for (const tk of Object.keys(store.deviceTokens || {})) { const d = store.deviceTokens[tk]; if (d && d.kind === 'student' && set.has(d.id)) out.push(tk); }
  return out;
}
function persistDeviceTokens() { if (supaEnabled()) { try { cloudSetMeta('deviceTokens', JSON.stringify(store.deviceTokens)); } catch (_) {} } }
function pruneStaleTokens(r) { if (r && r.stale && r.stale.length) { for (const t of r.stale) delete store.deviceTokens[t]; save(); persistDeviceTokens(); } }
/** Push every enrolled student in a live class's cohort that it just went live. Shared by the desktop
 *  sync path (pushNewRecords) and the portal-host path (the onLiveStart dep) so both notify identically. */
async function pushLiveSession(row) {
  if (!pushReady || !fcm || !fcm.configured() || !row || !row.active || row.deleted) return;
  const ids = allEntity('students').filter(s => s.department_id === row.department_id && s.level_id === row.level_id).map(s => s.id);
  const tokens = tokensForStudents(ids);
  if (tokens.length) pruneStaleTokens(await fcm.sendToTokens(tokens, { title: '🔴 Live class started', body: (row.subject || row.course_code || 'Your class') + ' is live now — tap to join' }, { seg: 'liveclasses', id: String(row.id || ''), room: String(row.room || '') }));
}
async function pushNewRecords(recs) {
  if (!pushReady || !fcm || !fcm.configured() || !recs || !recs.length) return;
  for (const rec of recs) {
    try {
      const row = rec.row;
      if (rec.entity === 'portal_documents') {
        const tokens = tokensForStudents(studentsForDoc(row));
        if (tokens.length) pruneStaleTokens(await fcm.sendToTokens(tokens, { title: 'New document', body: row.title || 'A new document was posted for you' }, { seg: 'documents', id: String(row.id || '') }));
      } else if (rec.entity === 'results' && row.student_id) {
        const tokens = tokensForStudents([row.student_id]);
        if (tokens.length) pruneStaleTokens(await fcm.sendToTokens(tokens, { title: 'Result published', body: row.title || 'A new statement of result is available' }, { seg: 'results', id: String(row.id || '') }));
      } else if (rec.entity === 'live_sessions' && row.active && !row.deleted) {
        await pushLiveSession(row); // A class just went live — push every enrolled student so they can tap in.
      } else if (rec.entity === 'malpractice_flags' && row.student_id && !row.deleted) {
        const tokens = tokensForStudents([row.student_id]);
        if (tokens.length) pruneStaleTokens(await fcm.sendToTokens(tokens, { title: '⚠️ Exam conduct notice', body: 'A possible malpractice was recorded during your exam — tap to see the evidence and appeal if it was a mistake.' }, { seg: 'surveillance', id: String(row.id || '') }));
      } else if (rec.entity === 'online_exams' && (row.status === 'published' || row.status === 'live') && !row.deleted) {
        // notify the cohort that an exam is scheduled / live
        const studs = allEntity('students').filter(s => s.status !== 'alumni'
          && (!row.faculty_id || row.faculty_id === s.faculty_id) && (!row.department_id || row.department_id === s.department_id) && (!row.level_id || row.level_id === s.level_id))
          .map(s => s.id);
        const tokens = tokensForStudents(studs);
        if (tokens.length) pruneStaleTokens(await fcm.sendToTokens(tokens, { title: '📝 ' + (row.title || row.course_code || 'Online exam'), body: 'Your online exam is ' + (row.status === 'live' ? 'live now' : 'scheduled') + ' — open the Exams tab to begin when it starts.' }, { seg: 'exam', id: String(row.id || '') }));
      }
    } catch (_) { /* best-effort */ }
  }
}
/** Records whose arrival should trigger a push (new, not-deleted documents/results). */
function collectPushable(entity, prev, row) {
  if (entity !== 'portal_documents' && entity !== 'results' && entity !== 'live_sessions' && entity !== 'malpractice_flags' && entity !== 'online_exams') return false;
  if (!row || row.deleted) return false;
  if (entity === 'live_sessions' && !row.active) return false; // only a started (active) session pushes
  if (entity === 'malpractice_flags' && !row.student_id) return false; // only an identified student can be pushed/notified
  if (entity === 'online_exams') { if (row.status !== 'published' && row.status !== 'live') return false; return !prev || !prev.row || (prev.row.status !== 'published' && prev.row.status !== 'live'); } // push when it first becomes published/live
  return !prev || !prev.row || prev.row.deleted; // genuinely new (or un-deleted)
}
// ---- Cross-instance LIVE-EXAM frame relay (Cloud Run autoscaling) ---------------------------------
// The live camera/audio relay is per-instance memory inside portal.js. On a multi-instance host the
// student's frame upload and the officer's monitor read hit DIFFERENT container instances → no camera
// ever reaches the monitor. With EXAM_RELAY=1 (and Supabase configured) we back the relay with a shared
// Supabase table `exam_live`, so every instance sees every student. One-time setup — run in the Supabase
// SQL editor:
//   create table if not exists public.exam_live (
//     exam_id text not null, student_id text not null, updated_at timestamptz default now(), ts int8,
//     audio_level real, away int, risk real, risk_level text, identity text, forfeited bool, last_event jsonb,
//     has_jpeg bool, has_kyc bool, has_audio bool, audio_mime text, audio_ts int8,
//     has_clip bool, clip_mime text, clip_ts int8, jpeg text, kyc text, audio text, clip text,
//     primary key (exam_id, student_id));
//   alter table public.exam_live enable row level security;  -- (service_role key bypasses RLS)
// The simpler alternative to all of this is to pin the service to ONE instance (--max-instances=1).
const EXAM_RELAY = process.env.EXAM_RELAY === '1' && supaEnabled();
const RELAY_META_COLS = 'exam_id,student_id,ts,audio_level,away,risk,risk_level,identity,forfeited,last_event,has_jpeg,has_kyc,has_audio,audio_mime,audio_ts,has_clip,clip_mime,clip_ts,updated_at';
function examRelayStore() {
  return {
    async put(examId, sid, fields) {
      const row = { exam_id: examId, student_id: sid, updated_at: new Date().toISOString() };
      if (fields.ts != null) row.ts = Number(fields.ts) || null;
      if (fields.audioLevel != null) row.audio_level = Number(fields.audioLevel) || 0;
      if (fields.away != null) row.away = Number(fields.away) || 0;
      if (fields.risk != null) row.risk = Number(fields.risk) || 0;
      if (fields.riskLevel != null) row.risk_level = String(fields.riskLevel);
      if (fields.identity != null) row.identity = String(fields.identity);
      if (fields.forfeited != null) row.forfeited = !!fields.forfeited;
      if (fields.lastEvent != null) row.last_event = fields.lastEvent;
      if (fields.jpeg != null) { row.jpeg = fields.jpeg; row.has_jpeg = true; }
      if (fields.kyc != null) { row.kyc = fields.kyc; row.has_kyc = true; }
      if (fields.audio != null) { row.audio = fields.audio; row.has_audio = true; if (fields.audioMime) row.audio_mime = fields.audioMime; if (fields.audioTs != null) row.audio_ts = Number(fields.audioTs) || null; }
      if (fields.clip != null) { row.clip = fields.clip; row.has_clip = true; if (fields.clipMime) row.clip_mime = fields.clipMime; if (fields.clipTs != null) row.clip_ts = Number(fields.clipTs) || null; }
      await supaRest('POST', '/rest/v1/exam_live?on_conflict=exam_id,student_id', [row], { 'Prefer': 'resolution=merge-duplicates,return=minimal' }, 8000);
    },
    async listMeta(examId) {
      const r = await supaRest('GET', '/rest/v1/exam_live?select=' + RELAY_META_COLS + '&exam_id=eq.' + encodeURIComponent(examId), null, null, 8000);
      if (!(r.status >= 200 && r.status < 300 && Array.isArray(r.json))) return [];
      return r.json.map(x => ({ student_id: x.student_id, ts: Number(x.ts) || 0,
        state: { audioLevel: x.audio_level, away: x.away, risk: x.risk, riskLevel: x.risk_level, identity: x.identity, forfeited: x.forfeited, lastEvent: x.last_event, audioMime: x.audio_mime, clipMime: x.clip_mime },
        has_jpeg: x.has_jpeg, has_kyc: x.has_kyc, has_audio: x.has_audio, has_clip: x.has_clip, audio_ts: Number(x.audio_ts) || 0, clip_ts: Number(x.clip_ts) || 0 }));
    },
    async getBytes(examId, sid, kind) {
      const col = kind === 'audio' ? 'audio,audio_mime' : kind === 'clip' ? 'clip,clip_mime' : kind === 'kyc' ? 'kyc' : 'jpeg';
      const r = await supaRest('GET', '/rest/v1/exam_live?select=' + col + '&exam_id=eq.' + encodeURIComponent(examId) + '&student_id=eq.' + encodeURIComponent(sid) + '&limit=1', null, null, 8000);
      const x = (r.json && r.json[0]) || null; if (!x) return null;
      if (kind === 'audio') return x.audio ? { data: x.audio, mime: x.audio_mime || 'audio/webm' } : null;
      if (kind === 'clip') return x.clip ? { data: x.clip, mime: x.clip_mime || 'video/webm' } : null;
      const data = kind === 'kyc' ? x.kyc : x.jpeg; return data ? { data, mime: 'image/jpeg' } : null;
    },
  };
}
// prune stale live-frame rows (a few hours after an exam) so the relay table stays small
if (EXAM_RELAY) setInterval(() => { try { supaRest('DELETE', '/rest/v1/exam_live?updated_at=lt.' + encodeURIComponent(new Date(Date.now() - 3 * 3600 * 1000).toISOString()), null, { 'Prefer': 'return=minimal' }).catch(() => {}); } catch (_) {} }, 30 * 60 * 1000);

let portal = null;
if (createPortal) {
  try {
    portal = createPortal({
      all: allEntity, one: oneEntity, getVersion: () => storeVersion, secret: SYNC_TOKEN || 'unibursar-portal',
      // shared cross-instance live-frame relay (Cloud Run); null ⇒ portal uses pure in-memory (pinned single instance)
      frameStore: EXAM_RELAY ? examRelayStore() : null,
      // resolve offloaded book/document bytes from object storage (env creds) — see server/blobstore.js
      blobFetch: (key) => require('./blobstore').getBuffer(key),
      // multi-provider online-payment gateway (Paystack/Flutterwave; env-keyed) — server/payments-gateway.js
      paymentGateway: (() => { try { return require('./payments-gateway'); } catch (_) { return null; } })(),
      // portal writes (e.g. password reset) update the store and bump updated_at so the
      // change syncs back to the desktop app on the next /sync/pull
      update: (entity, id, patch) => {
        const rec = store.records[entity + ':' + id];
        if (!rec || !rec.row) return false;
        Object.assign(rec.row, patch); const now = new Date().toISOString(); rec.row.updated_at = now; rec.updated_at = now;
        storeVersion = Date.now(); save();
        // Mirror portal-side writes (admission status changes, password resets, …) to Supabase so they
        // reach the desktop app in cloud-sync mode — the desktop pulls from Supabase, NOT this hub's
        // /sync/pull, so without this an applicant's update would never propagate. No-op in hub mode.
        try { cloudUpsert([{ entity, id, row: rec.row, updated_at: now }]); } catch (_) {}
        return true;
      },
      // create a brand-new record (online admission applications + their documents) ON THE SERVER. It
      // is stored exactly like a synced row so it flows to the registrar's desktop on the next
      // /sync/pull (and persists via save()). Mirrors the `update` hook above.
      create: (entity, row) => {
        if (!row || !row.id) return false;
        const key = entity + ':' + row.id;
        const now = row.updated_at || new Date().toISOString();
        row.updated_at = now;
        store.records[key] = { entity, id: row.id, row, updated_at: now };
        storeVersion = Date.now(); save();
        // Mirror brand-new portal rows (online admission applications + their documents, plus the
        // admissions-desk notifications below) to Supabase so they sync DOWN to the registrar's
        // desktop in cloud-sync mode. Without this the admissions dashboard stays empty. No-op in hub mode.
        try { cloudUpsert([{ entity, id: row.id, row, updated_at: now }]); } catch (_) {}
        return true;
      },
      // A class started FROM THE PORTAL (a lecturer hosting on the web) → push the cohort, exactly like a
      // desktop-started class does via the sync ingest. portal.js calls this ONLY for a genuinely new
      // session (it skips a re-host), so there is no duplicate notification. Best-effort + async.
      onLiveStart: (row) => { try { pushLiveSession(row).catch(() => {}); } catch (_) {} },
      // Send an applicant email (application confirmation + status updates) directly via the hub's SMTP
      // relay. Best-effort + async — it NEVER blocks or fails the apply flow; a missing relay just no-ops.
      sendMail: (msg) => { try { if (!relayConfigured()) return Promise.resolve({ ok: false, error: 'relay not configured' }); return relaySend(msg).then(r => r || { ok: true }).catch(e => ({ ok: false, error: e && e.message })); } catch (e) { return Promise.resolve({ ok: false, error: e && e.message }); } },
      // native app registers its FCM token here so we can push it when a document is posted
      registerDevice: (token, account) => {
        if (!token) return false;
        store.deviceTokens[token] = { kind: account && account.kind, id: account && account.id, platform: (account && account.platform) || 'android', ts: Date.now() };
        save(); persistDeviceTokens(); // survive Cloud Run cold starts
        return true;
      },
      institution: () => Object.assign(
        { language: process.env.PORTAL_LANGUAGE || '', i18n_custom: '' }, // multi-language default (overridden by synced branding if it carries one)
        (store.branding && store.branding.name)
          ? store.branding
          : { name: process.env.INSTITUTION_NAME || 'UniBursar University', short: process.env.INSTITUTION_SHORT || 'UBU', logo: process.env.INSTITUTION_LOGO || '', motto: process.env.INSTITUTION_MOTTO || '' }),
      // Live-class video config (8x8 JaaS / self-hosted Jitsi). Set these env vars on the host to remove
      // the meet.jit.si Google-login wall: JITSI_MODE=jaas, JAAS_APP_ID, JAAS_KID, JAAS_PRIVATE_KEY
      // (the RSA private key PEM — newlines may be written as \n). Leave unset for plain meet.jit.si.
      jitsiConfig: () => ({
        mode: process.env.JITSI_MODE || '',
        domain: process.env.JITSI_DOMAIN || '',
        jaasAppId: process.env.JAAS_APP_ID || '',
        jaasKid: process.env.JAAS_KID || '',
        jaasKey: process.env.JAAS_PRIVATE_KEY || '',
      }),
    });
  } catch (e) { console.error('[UniBursar] portal init failed:', e.message); portal = null; }
}

// email relay — uses nodemailer if installed, otherwise a built-in zero-dependency SMTP client
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* will fall back to built-in SMTP */ }
function smtpFromEnv() {
  return { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true', user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, from: process.env.SMTP_FROM || process.env.SMTP_USER };
}
const relayConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

// ---- built-in SMTP (no dependencies) --------------------------------------
function wrap76(s) { return (String(s).match(/.{1,76}/g) || []).join('\r\n'); }
function encHeader(s) { return /^[\x00-\x7F]*$/.test(s || '') ? (s || '') : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
function extractEmail(s) { const m = /<([^>]+)>/.exec(s || ''); return (m ? m[1] : s || '').trim(); }
// send AS the authenticated mailbox when the configured From is on a different domain
// (mail servers reject "domain is not allowed in header From")
function effectiveFrom(cfg) {
  const user = String(cfg.user || '').trim(); const raw = String(cfg.from || '').trim();
  if (!user) return raw; if (!raw) return user;
  const email = extractEmail(raw);
  const ud = (user.split('@')[1] || '').toLowerCase(); const fd = (email.split('@')[1] || '').toLowerCase();
  if (email && ud && fd === ud) return raw;
  const m = /^(.*?)<[^>]+>\s*$/.exec(raw); const name = m ? m[1].trim().replace(/^"|"$/g, '') : '';
  return name ? '"' + name + '" <' + user + '>' : user;
}
function buildMime(cfg, msg) {
  const CRLF = '\r\n'; const atts = msg.attachments || [];
  const head = [
    'From: ' + (cfg.from || cfg.user), 'To: ' + msg.to, 'Subject: ' + encHeader(msg.subject || ''),
    'MIME-Version: 1.0', 'Date: ' + new Date().toUTCString(), 'Message-ID: <' + crypto.randomUUID() + '@unibursar>',
  ];
  let body;
  if (atts.length) {
    const b = 'ubu_' + crypto.randomBytes(10).toString('hex');
    head.push('Content-Type: multipart/mixed; boundary="' + b + '"');
    let p = '--' + b + CRLF + 'Content-Type: text/html; charset=UTF-8' + CRLF + 'Content-Transfer-Encoding: base64' + CRLF + CRLF +
      wrap76(Buffer.from(msg.html || msg.text || '', 'utf8').toString('base64')) + CRLF;
    for (const a of atts) {
      p += '--' + b + CRLF + 'Content-Type: application/octet-stream; name="' + a.filename + '"' + CRLF +
        'Content-Transfer-Encoding: base64' + CRLF + 'Content-Disposition: attachment; filename="' + a.filename + '"' + CRLF + CRLF +
        wrap76(a.contentBase64 || '') + CRLF;
    }
    p += '--' + b + '--' + CRLF; body = p;
  } else {
    head.push('Content-Type: text/html; charset=UTF-8'); head.push('Content-Transfer-Encoding: base64');
    body = wrap76(Buffer.from(msg.html || msg.text || '', 'utf8').toString('base64')) + CRLF;
  }
  return head.join(CRLF) + CRLF + CRLF + body;
}
function smtpSendBuiltin(cfg, msg) {
  return new Promise((resolve, reject) => {
    let sock, buf = '', resolver = null, settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; try { sock && sock.destroy(); } catch (_) {} fn(v); } };
    const fail = (e) => done(reject, e instanceof Error ? e : new Error(String(e)));
    const onData = (d) => { buf += d.toString('utf8'); const ls = buf.split(/\r?\n/).filter(Boolean); const last = ls[ls.length - 1] || ''; if (/^\d{3} /.test(last)) { const reply = buf; buf = ''; const code = parseInt(last.slice(0, 3), 10); if (resolver) { const r = resolver; resolver = null; r({ code, reply }); } } };
    const expect = () => new Promise(r => { resolver = r; });
    const step = async (line, ok) => { sock.write(line + '\r\n'); const r = await expect(); if (ok && !ok.includes(r.code)) throw new Error('SMTP "' + line.split(' ')[0] + '" → ' + r.reply.trim()); return r; };
    const auth = async () => {
      await step('EHLO unibursar', [250]);
      await step('AUTH LOGIN', [334]);
      await step(Buffer.from(cfg.user).toString('base64'), [334]);
      await step(Buffer.from(cfg.pass).toString('base64'), [235]);
      await step('MAIL FROM:<' + extractEmail(cfg.from || cfg.user) + '>', [250]);
      const recips = String(msg.to).split(',').map(x => extractEmail(x)).filter(Boolean);
      for (const rc of recips) await step('RCPT TO:<' + rc + '>', [250, 251]);
      await step('DATA', [354]);
      sock.write(buildMime(cfg, msg).replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
      const r = await expect(); if (r.code !== 250) throw new Error('SMTP DATA → ' + r.reply.trim());
      try { sock.write('QUIT\r\n'); } catch (_) {}
      done(resolve, { ok: true, accepted: recips });
    };
    try {
      if (cfg.secure) {
        sock = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host });
        sock.setTimeout(20000); sock.on('timeout', () => fail(new Error('SMTP timeout'))); sock.on('error', fail); sock.on('data', onData);
        sock.once('secureConnect', async () => { try { await expect(); await auth(); } catch (e) { fail(e); } });
      } else {
        sock = net.connect({ host: cfg.host, port: cfg.port });
        sock.setTimeout(20000); sock.on('timeout', () => fail(new Error('SMTP timeout'))); sock.on('error', fail); sock.on('data', onData);
        sock.once('connect', async () => {
          try {
            await expect(); await step('EHLO unibursar', [250]); await step('STARTTLS', [220]);
            sock.removeListener('data', onData);
            const up = tls.connect({ socket: sock, servername: cfg.host });
            up.on('error', fail); up.setTimeout(20000); up.on('timeout', () => fail(new Error('SMTP timeout')));
            up.once('secureConnect', async () => { sock = up; buf = ''; sock.on('data', onData); try { await auth(); } catch (e) { fail(e); } });
          } catch (e) { fail(e); }
        });
      }
    } catch (e) { fail(e); }
  });
}
async function relaySend(msg) {
  const cfg = smtpFromEnv();
  cfg.from = effectiveFrom(cfg); // never send from a domain the server won't allow
  if (nodemailer) {
    const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass } });
    const atts = (msg.attachments || []).map(a => ({ filename: a.filename, content: Buffer.from(a.contentBase64 || '', 'base64') }));
    const info = await t.sendMail({ from: cfg.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, attachments: atts });
    return { ok: true, messageId: info.messageId, accepted: info.accepted || [], engine: 'nodemailer' };
  }
  const r = await smtpSendBuiltin(cfg, msg);
  return { ok: true, accepted: r.accepted, engine: 'builtin' };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', d => { b += d; if (b.length > 24 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Resilience: never let a stray async rejection or uncaught exception take the whole hub down — log it
// and keep serving (per-request errors are already contained by the handler's try/catch below). Without
// these, one unhandled rejection would crash the process and knock the portal offline for everyone.
process.on('unhandledRejection', (reason) => { try { console.error('[hub] unhandledRejection:', (reason && reason.stack) || reason); } catch (_) {} });
process.on('uncaughtException', (err) => { try { console.error('[hub] uncaughtException:', (err && err.stack) || err); } catch (_) {} });

const server = http.createServer(async (req, res) => {
 try { // top-level guard: a single bad request must never crash the hub (it serves every online user)
  let u; try { u = new URL(req.url, 'http://local'); } catch (_) { return send(res, 400, { ok: false }); }
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end(); }

  // online portal (login page, dashboards, printable documents) — public, has its own auth
  if (portal) { try { if (await portal.handle(req, res, u, req.method, () => readBody(req))) return; } catch (e) { return send(res, 500, { ok: false, error: 'portal error' }); } }

  // friendly root when the portal module isn't loaded (so the domain never looks "broken")
  if (p === '/' && req.method === 'GET' && !portal) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('UniBursar hub is running. The web portal is unavailable because server/portal.js was not uploaded — add it and Restart. Sync endpoint: /health'); }

  if (p === '/health') return send(res, 200, { ok: true, build: BUILD, epoch: store.epoch, records: Object.keys(store.records).length, portal: !!portal, secured: !!SYNC_TOKEN, examRelay: EXAM_RELAY, cloud: supaEnabled(), time: new Date().toISOString() });

  // protected endpoints require the shared token (when one is configured)
  if ((p === '/sync/push' || p === '/sync/pull' || p === '/email/send') && !tokenOk(req)) return send(res, 401, { ok: false, error: 'Unauthorized — missing or wrong sync token.' });

  if (p === '/sync/push' && req.method === 'POST') {
    const body = await readBody(req); const changes = (body && body.changes) || []; let applied = 0; const changedRecs = []; const pushable = [];
    for (const ch of changes) {
      const entity = ch && ch.entity, row = ch && ch.row; if (!entity || !row || !row.id) continue;
      const key = `${entity}:${row.id}`; const updated_at = row.updated_at || new Date().toISOString();
      const prev = store.records[key];
      // sticky deletes: a delete always wins and is never resurrected
      if (prev && prev.row && prev.row.deleted && !row.deleted) continue;
      if (row.deleted) { if (!(prev && prev.row && prev.row.deleted)) { store.records[key] = { entity, id: row.id, row, updated_at }; changedRecs.push(store.records[key]); applied++; } continue; }
      // sticky payment decisions: never revert a decided payment back to pending
      if (entity === 'payments' && prev && prev.row && ['completed', 'denied', 'voided'].includes(prev.row.status) && row.status === 'pending') continue;
      if (prev && prev.updated_at && updated_at <= prev.updated_at) continue;
      if (collectPushable(entity, prev, row)) pushable.push({ entity, row });
      store.records[key] = { entity, id: row.id, row, updated_at }; changedRecs.push(store.records[key]); applied++;
    }
    if (applied) { storeVersion = Date.now(); save(); cloudUpsert(changedRecs); } // mirror hub-mode writes to the cloud
    if (pushable.length) pushNewRecords(pushable); // native push when a document/result is posted
    return send(res, 200, { ok: true, applied, epoch: store.epoch });
  }

  // Admin factory-reset: wipe the central store so the online portal is emptied too.
  if (p === '/sync/reset' && req.method === 'POST') {
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: 'Unauthorized.' });
    const body = await readBody(req);
    if (!body || body.confirm !== 'RESET') return send(res, 400, { ok: false, error: 'confirm required' });
    store = { epoch: crypto.randomUUID(), records: {}, branding: store.branding };
    storeVersion = Date.now(); save();
    if (supaEnabled()) { lastCloudPull = ''; supaRest('DELETE', '/rest/v1/sync_records?key=not.is.null', null, { 'Prefer': 'return=minimal' }).catch(() => {}); cloudSetMeta('epoch', store.epoch); }
    return send(res, 200, { ok: true });
  }

  // the app pushes its institution name + logo so the portal/login page is branded
  if (p === '/branding' && req.method === 'POST') {
    if (!tokenOk(req)) return send(res, 401, { ok: false, error: 'Unauthorized.' });
    const body = await readBody(req);
    store.branding = {
      name: body.name || '', short: body.short || '', logo: body.logo || '', motto: body.motto || '',
      // extra identity fields so a fresh client can recover the FULL branding via GET /branding
      address: body.address || '', email: body.email || '', phone: body.phone || '', base_currency: body.base_currency || '', portal_url: body.portal_url || '',
      // per-university theme + document marks
      primary: body.primary || '', accent: body.accent || '', seal: body.seal || '', signature: body.signature || '',
      letterhead: body.letterhead || '', watermark: body.watermark || '', login_bg: body.login_bg || '', favicon: body.favicon || '',
      updated_at: body.updated_at || new Date().toISOString(),
      session: body.session || '', semester: body.semester || '',
      licensed: (typeof body.licensed === 'boolean') ? body.licensed : true, // institution activation status
    };
    storeVersion = Date.now(); save();
    cloudSetMeta('branding', JSON.stringify(store.branding));
    return send(res, 200, { ok: true });
  }
  // a fresh client pulls the institution name/logo back into its own settings (they aren't synced rows)
  if (p === '/branding' && req.method === 'GET') return send(res, 200, store.branding || {});

  if (p === '/sync/pull' && req.method === 'GET') {
    const since = u.searchParams.get('since') || null; const out = [];
    for (const k of Object.keys(store.records)) { const rec = store.records[k]; if (!since || rec.updated_at >= since) out.push({ entity: rec.entity, row: rec.row, updated_at: rec.updated_at }); }
    return send(res, 200, { ok: true, changes: out, now: new Date().toISOString(), epoch: store.epoch });
  }

  if (p === '/email/health') return send(res, 200, { ok: true, configured: relayConfigured(), engine: nodemailer ? 'nodemailer' : 'builtin' });
  if (p === '/email/send' && req.method === 'POST') {
    if (!relayConfigured()) return send(res, 200, { ok: false, error: 'Mail relay not configured: set SMTP_HOST / SMTP_USER / SMTP_PASS env vars on the server, then Restart.' });
    const body = await readBody(req);
    if (!body.to) return send(res, 200, { ok: false, error: 'No recipient.' });
    try { const r = await relaySend(body); return send(res, 200, r); }
    catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }

  send(res, 404, { ok: false, error: 'not found' });
 } catch (e) {
  try { console.error('[hub] request error:', req.method, req.url, '—', e && e.message); } catch (_) {}
  try { if (!res.headersSent) send(res, 500, { ok: false, error: 'server error' }); else res.end(); } catch (_) {}
 }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n⚠  Port ${PORT} is already in use. On a PC running the UniBursar app the app already hosts a hub here — you don't need this standalone server there. To run anyway: PORT=5000 node server.js\n`);
    process.exit(1);
  }
  console.error('Server error:', e.message); process.exit(1);
});
server.listen(PORT, () => console.log(`UniBursar hub [build ${BUILD}] listening on http://0.0.0.0:${PORT}  portal=${!!portal}  cloud=${supaEnabled()}  (data: ${STORE})`));

// Reconcile online-payment intents every ~3 minutes: re-verify any checkout that never came back
// (student closed the tab / a webhook was missed) and record the ones that actually paid — so the
// system "knows" about a real online transaction even without a successful redirect/webhook.
if (portal && typeof portal.reconcile === 'function') {
  setInterval(() => { try { portal.reconcile().catch(() => {}); } catch (_) {} }, 180000);
}

// When backed by Supabase, load the full dataset on boot and then poll for deltas every ~5s
// so the portal reflects changes the desktop wrote DIRECTLY to the cloud (cloud-sync mode).
if (supaEnabled()) {
  cloudLoadAll().then(() => { storeVersion = Date.now(); });
  setInterval(cloudPullDelta, 5000);
}

// Keep a free-tier cloud instance awake so students always reach the portal even
// when no desktop is online. Render exposes RENDER_EXTERNAL_URL; you can also set
// KEEPALIVE_URL. Pinging our own public /health every ~10 min (< the ~15 min idle
// cut-off) prevents the host from spinning the service down.
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || '';
if (KEEPALIVE_URL) {
  const https = require('https');
  const ping = () => {
    try {
      const u = new URL('/health', KEEPALIVE_URL);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(u, (r) => r.resume());
      req.on('error', () => {});
      req.setTimeout(15000, () => req.destroy());
    } catch (_) {}
  };
  setInterval(ping, 10 * 60 * 1000);
  console.log('[UniBursar] keepalive: pinging ' + KEEPALIVE_URL + ' every 10 min to stay always-on');
}
