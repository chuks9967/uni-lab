'use strict';
/**
 * UniBursar Online Portal — served by the sync hub (server.js).
 *
 * Every account synced from the desktop app (officers, students, staff,
 * lecturers) can log in here from anywhere and see live data: students view
 * fees/payments/receipts, staff & lecturers view payslips, officers see their
 * reports. Data is read straight from the synced central store, so anything the
 * accountant (or any user) changes in the app appears here on the next sync.
 *
 * Pure Node — no dependencies. Mounted by server.js via createPortal().
 */
const crypto = require('crypto');
// pure-Node QR encoder (no npm deps — keeps the hub zero-dependency). Used to print a
// SCANNABLE verification QR on portal receipts & payslips.
let qrcode = null; try { qrcode = require('./qrcode'); } catch (_) { qrcode = null; }
// 8x8 JaaS / self-host JWT helper (zero-dep) — removes the meet.jit.si Google-login wall for live classes.
let jitsi = null; try { jitsi = require('./jitsi'); } catch (_) { jitsi = null; }
function verifyQrSvg(targetUrl) {
  if (!qrcode || !targetUrl) return '';
  // force a fixed display size (viewBox keeps it crisp + scannable at any QR version)
  try { return qrcode.toSVG(targetUrl, { ec: 'M', cellSize: 3, margin: 1 }).replace(/width="\d+" height="\d+"/, 'width="104" height="104"'); } catch (_) { return ''; }
}

const SYM = { NGN: '₦', XOF: 'CFA', USD: '$', EUR: '€', GBP: '£', GHS: '₵', KES: 'KSh', ZAR: 'R', GMD: 'D', SLL: 'Le' };
function money(a, c) { const n = Number(a || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return `${SYM[c] || (c ? c + ' ' : '')}${n}`; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function fmtDate(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return '—'; } }

// pure-Node scrypt hash/verify (matches electron/services/portalcreds.js)
function hashPass(password) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(password), salt, 32);
  return `s2$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPass(password, stored) {
  try {
    const [tag, saltHex, hashHex] = String(stored || '').split('$');
    if (tag !== 's2' || !saltHex || !hashHex) return false;
    const h = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
    const a = Buffer.from(hashHex, 'hex');
    return a.length === h.length && crypto.timingSafeEqual(a, h);
  } catch (_) { return false; }
}

const WORDS_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const WORDS_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const WORD_CCY = { NGN: 'Naira', XOF: 'CFA Francs', USD: 'Dollars', EUR: 'Euros', GBP: 'Pounds', GHS: 'Cedis', KES: 'Shillings' };
function below(n) { let s = ''; if (n >= 100) { s += WORDS_ONES[Math.floor(n / 100)] + ' Hundred'; n %= 100; if (n) s += ' '; } if (n >= 20) { s += WORDS_TENS[Math.floor(n / 10)]; n %= 10; if (n) s += '-' + WORDS_ONES[n]; } else if (n > 0) s += WORDS_ONES[n]; return s; }
function numWords(num) { num = Math.floor(Number(num) || 0); if (num === 0) return 'Zero'; const scales = ['', ' Thousand', ' Million', ' Billion']; const parts = []; let i = 0; while (num > 0) { const c = num % 1000; if (c) parts.unshift(below(c) + scales[i]); num = Math.floor(num / 1000); i++; } return parts.join(' ').trim(); }
function amountWords(a, c) { const whole = Math.floor(Number(a) || 0); const k = Math.round((Number(a) - whole) * 100); let s = `${numWords(whole)} ${WORD_CCY[c] || c}`; if (k > 0) s += ` and ${numWords(k)}/100`; return s + ' only'; }

module.exports = function createPortal(deps) {
  const { all, one, getVersion, secret, institution, update, create, registerDevice, jitsiConfig, onLiveStart } = deps;
  // Live-class video config (8x8 JaaS app id/key, or a self-hosted Jitsi domain). On the hosted hub
  // this comes from server env; on the embedded desktop portal it comes from app settings.
  const jitsiCfg = () => { try { return (typeof jitsiConfig === 'function' ? jitsiConfig() : {}) || {}; } catch (_) { return {}; } };
  // ---- Online-exam proctor frames (transient, in-memory; never synced) ----
  // examFrames[examId][studentId] = { jpeg(base64), audioLevel, ts, ring:[base64,…] }
  const examFrames = {};
  const lastFrameTs = {};                         // per-student rate-limit
  function winState(now, start, end) { const n = now || Date.now(); const s = start ? Date.parse(start) : null, e = end ? Date.parse(end) : null; if (s && n < s) return 'upcoming'; if (e && n > e) return 'closed'; return 'open'; }
  function seededShuffle(seed, arr) { const a = (arr || []).slice(); let s = 0; const str = String(seed || ''); for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0; s = s || 1; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  // the public base URL of THIS request (https://host) — used to print absolute,
  // scannable verification URLs in the QR on receipts/payslips. Set per request.
  let docBase = '';
  function buildBase(req) {
    try {
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket && req.socket.encrypted ? 'https' : 'http');
      const host = req.headers['x-forwarded-host'] || req.headers.host || '';
      return host ? `${proto}://${host}` : '';
    } catch (_) { return ''; }
  }
  // The session-token signing key. If no shared secret is configured we use a
  // strong RANDOM per-process key (never the old public default), so portal
  // tokens can never be forged. Set a SYNC_TOKEN to keep sessions across restarts.
  const KEY = (secret && String(secret).length >= 8) ? secret : crypto.randomBytes(32).toString('hex');
  if (!(secret && String(secret).length >= 8)) { try { console.warn('[UniBursar] No strong SYNC_TOKEN set — using a random session key (logins reset on restart). Set SYNC_TOKEN for persistent, secure sessions.'); } catch (_) {} }

  // ---- token (HMAC-signed, stateless) ----
  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
    return body + '.' + mac;
  }
  function verifyToken(tok) {
    try {
      const [body, mac] = String(tok || '').split('.');
      if (!body || !mac) return null;
      const exp = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
      if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (p.exp && Date.now() > p.exp) return null;
      return p;
    } catch (_) { return null; }
  }

  // ---- account resolution ----
  function findAccount(login) {
    const q = String(login || '').trim().toLowerCase();
    if (!q) return null;
    for (const u of all('users')) {
      if (u.is_active === 0) continue;
      if ([u.username, u.portal_username, u.email].some(v => (v || '').toLowerCase() === q)) return { kind: 'user', row: u, role: u.role };
    }
    for (const s of all('students')) {
      if ([s.portal_username, s.email, s.matric_no].some(v => (v || '').toLowerCase() === q)) return { kind: 'student', row: s, role: 'student' };
    }
    for (const s of all('students')) {
      if ([s.parent_portal_username, s.parent_email].some(v => (v || '').toLowerCase() === q)) return { kind: 'parent', row: s, role: 'parent' };
    }
    for (const s of all('staff')) {
      if (s.is_active === 0) continue;
      if ([s.portal_username, s.email, s.staff_no].some(v => (v || '').toLowerCase() === q)) return { kind: 'staff', row: s, role: s.staff_type === 'lecturer' ? 'lecturer' : 'staff' };
    }
    return null;
  }
  function accountById(kind, id) {
    const entity = kind === 'user' ? 'users' : (kind === 'student' || kind === 'parent') ? 'students' : 'staff';
    return one(entity, id);
  }
  function passField(kind, row) { return kind === 'parent' ? row.parent_portal_pass : row.portal_pass; }

  // ---- shared computations ----
  const nameOf = (entity, id) => { const r = id ? one(entity, id) : null; return r ? r.name : null; };

  // ---- live classes (Jitsi) -------------------------------------------------
  // A class room name is DETERMINISTIC: the lecturer and every enrolled student derive the SAME
  // hard-to-guess id from the (already-synced) allocation scope, so no writable state is needed.
  // Knowing the id (only shown to the cohort + the lecturer) is the capability to join.
  function classRoom(parts) {
    const raw = [secret || 'unibursar', 'liveclass'].concat((parts || []).map(x => String(x || ''))).join('|');
    const short = String(inst().short || 'WAUU').replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'wauu';
    return short + '-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 28);
  }
  // next scheduled time for a course, taken from the cohort's published LECTURE timetable (if any)
  function classWhen(s, code) {
    if (!code) return '';
    const tts = all('timetables').filter(t => !t.deleted && t.status === 'published' && t.type === 'lecture' &&
      (t.scope === 'faculty' ? t.faculty_id === s.faculty_id : (t.department_id === s.department_id && (!t.level_id || t.level_id === s.level_id))));
    for (const t of tts) {
      const sl = all('timetable_slots').find(x => x.timetable_id === t.id && !x.deleted && x.kind !== 'holiday' && String(x.course_code || '').toUpperCase() === String(code).toUpperCase());
      if (sl) return [sl.day_or_date, (sl.start_time || '') + (sl.end_time ? '–' + sl.end_time : '')].filter(Boolean).join(' ');
    }
    return '';
  }
  function dedupeRooms(list) { const seen = {}; return list.filter(c => seen[c.room] ? false : (seen[c.room] = true)); }
  /** A student's joinable live classes — one per course in their published course allocations. */
  function liveClassesForStudent(s) {
    const sets = all('allocation_sets').filter(a => !a.deleted && a.status === 'published' && a.department_id === s.department_id && a.level_id === s.level_id);
    const out = [];
    for (const a of sets) for (const r of all('course_allocations').filter(r => r.set_id === a.id && !r.deleted)) {
      out.push({ code: r.course_code, title: r.course_title, lecturer: r.lecturer_name || '', moderator: false, live: false,
        room: classRoom([a.department_id, a.level_id, a.session_id, r.course_code]), subject: [r.course_code, r.course_title].filter(Boolean).join(' '),
        session: nameOf('academic_sessions', a.session_id), semester: nameOf('semesters', a.semester_id), when: classWhen(s, r.course_code) });
    }
    // Merge LIVE-NOW sessions a host just started (≤3h): mark matching allocation classes live, and add
    // any cohort/ad-hoc session whose room isn't an allocation class — so a class a lecturer started
    // REFLECTS on the student app immediately and is joinable, even without a course allocation.
    const liveCut = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const liveSessions = all('live_sessions').filter(v => !v.deleted && v.active && v.department_id === s.department_id && v.level_id === s.level_id && String(v.started_at || '') >= liveCut);
    const liveRooms = new Set(liveSessions.map(v => v.room));
    for (const c of out) if (liveRooms.has(c.room)) { c.live = true; c.when = 'Live now'; }
    for (const v of liveSessions) {
      if (out.find(c => c.room === v.room)) continue;
      out.push({ code: v.course_code || '', title: v.course_title || v.subject || 'Live class', lecturer: '', moderator: false, live: true,
        room: v.room, subject: v.subject || v.course_title || 'Live Class', session: nameOf('academic_sessions', v.session_id), semester: '', when: 'Live now' });
    }
    out.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0)); // live classes first
    return dedupeRooms(out);
  }
  /** A lecturer's classes (they host) — courses they are allocated to teach. Same room ids as students. */
  function liveClassesForLecturer(staff) {
    const rows = all('course_allocations').filter(r => !r.deleted && (r.lecturer_id === staff.id ||
      (r.lecturer_name && staff.full_name && String(r.lecturer_name).toLowerCase() === String(staff.full_name).toLowerCase())));
    const out = [];
    for (const r of rows) {
      const a = one('allocation_sets', r.set_id);
      if (!a || a.deleted || a.status !== 'published') continue;
      out.push({ code: r.course_code, title: r.course_title, moderator: true,
        room: classRoom([a.department_id, a.level_id, a.session_id, r.course_code]), subject: [r.course_code, r.course_title].filter(Boolean).join(' '),
        department: nameOf('departments', a.department_id), level: nameOf('levels', a.level_id),
        session: nameOf('academic_sessions', a.session_id), semester: nameOf('semesters', a.semester_id) });
    }
    return dedupeRooms(out);
  }
  /** Resolve a course class's cohort scope (dept/level/session) from its room id. The room is a one-way
   *  hash of the allocation scope, so we MATCH it against every published allocation rather than reverse
   *  it. Used when a lecturer starts a class from the portal so the cohort can be notified + auto-ended.
   *  Returns null for ad-hoc/cohort rooms that aren't a course allocation (nothing to notify). */
  function scopeForRoom(room) {
    if (!room) return null;
    const sets = all('allocation_sets').filter(a => !a.deleted && a.status === 'published');
    for (const a of sets) {
      for (const r of all('course_allocations').filter(r => r.set_id === a.id && !r.deleted)) {
        if (classRoom([a.department_id, a.level_id, a.session_id, r.course_code]) === room)
          return { department_id: a.department_id, level_id: a.level_id, session_id: a.session_id,
            course_code: r.course_code, course_title: r.course_title,
            subject: [r.course_code, r.course_title].filter(Boolean).join(' ') };
      }
    }
    return null;
  }
  /** Standalone page that embeds Jitsi Meet for one class room (capability URL: the room id is a secret). */
  function classPageHTML(room, name, subject, host) {
    const dn = esc(String(name || 'Guest').slice(0, 60));
    const subj = esc(String(subject || 'Live Class').slice(0, 80));
    const isHost = !!host;
    // JaaS/self-host aware: mint a per-user JWT (moderator for the lecturer) so there is NO Google
    // login and students join reliably. Falls back to plain meet.jit.si when nothing is configured.
    const emb = jitsi ? jitsi.classEmbed(jitsiCfg(), { room, displayName: String(name || 'Guest').slice(0, 60), moderator: isHost })
      : { domain: 'meet.jit.si', roomName: String(room || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80), jwt: '', scriptUrl: 'https://meet.jit.si/external_api.js', mode: 'public' };
    const domain = emb.domain;
    const r = emb.roomName;
    // MODERATOR LOCK: the lecturer (host) is the moderator and auto-enables the LOBBY, so students
    // must be ADMITTED before they can join — the lecturer controls the class. Students get a
    // restricted toolbar (no moderation / recording / security), join muted, and cannot start
    // screen-share over the host. (On the public meet.jit.si moderator status is best-effort;
    // for cryptographic enforcement self-host Jitsi and set institution setting `jitsi_domain`
    // + issue a JWT with a moderator claim — the page already passes the role through.)
    const HOST_TOOLBAR = "['microphone','camera','desktop','chat','raisehand','participants-pane','tileview','toggle-camera','select-background','security','recording','mute-everyone','mute-video-everyone','settings','fullscreen','hangup','invite','sharedvideo']";
    const STUDENT_TOOLBAR = "['microphone','camera','chat','raisehand','tileview','toggle-camera','select-background','settings','fullscreen','hangup']";
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${subj} — Live Class</title>
<style>html,body{height:100%;margin:0;background:#0b1220;font-family:'Segoe UI',Arial,sans-serif;color:#fff}
#bar{height:46px;display:flex;align-items:center;gap:10px;padding:0 14px;background:#0f1e3d}
#bar b{font-size:14px}#bar .role{font-size:11px;background:${isHost ? '#16a34a' : '#334155'};padding:3px 9px;border-radius:999px;font-weight:700}#bar .sp{flex:1}#bar a{color:#bcd;font-size:13px;text-decoration:none;background:#1e3a8a;padding:7px 12px;border-radius:8px}
#meet{position:absolute;top:46px;left:0;right:0;bottom:0}
#wait{position:absolute;top:46px;left:0;right:0;bottom:0;display:none;align-items:center;justify-content:center;text-align:center;padding:24px}
#err{padding:24px;max-width:520px;margin:40px auto;background:#111c33;border-radius:12px;line-height:1.6}
</style></head><body>
<div id="bar"><b>🎥 ${subj}</b> <span class="role">${isHost ? 'Lecturer (Host)' : 'Student'}</span><span class="sp"></span><a href="/">⤺ Back to portal</a></div>
<div id="meet"></div>
<div id="wait"><div><div style="font-size:40px">⏳</div><h3>Waiting for the lecturer to admit you…</h3><p style="opacity:.8">The class opens once your lecturer starts it and lets you in.</p></div></div>
<div id="err" style="display:none"><h3>Could not start the class</h3><p>Check your internet connection and that the app has camera & microphone permission, then reopen the class.</p><p><a href="/" style="color:#9bd">Back to portal</a></p></div>
<script src="${emb.scriptUrl}"></script>
<script>
(function(){
  var isHost=${isHost ? 'true' : 'false'};
  var LC_ROOM=${JSON.stringify(String(room || ''))};
  var LC_SUBJ=${JSON.stringify(subj)};
  function lcTok(){try{return new URLSearchParams(location.search).get('t')||localStorage.getItem('ubu_token')||'';}catch(e){return '';}}
  // The host ENDS the class for the whole cohort when they leave/close, so it stops on the students' APK
  // too. sendBeacon survives the page unload; the token comes from ?t= (native app) or localStorage (web).
  var lcEndSent=false;
  function lcEndClass(){if(lcEndSent||!isHost||!LC_ROOM)return;lcEndSent=true;try{navigator.sendBeacon('/api/class-end?t='+encodeURIComponent(lcTok())+'&room='+encodeURIComponent(LC_ROOM));}catch(e){}}
  function fail(){var e=document.getElementById('err');if(e)e.style.display='block';var m=document.getElementById('meet');if(m)m.style.display='none';}
  if(typeof JitsiMeetExternalAPI!=='function'){fail();return;}
  try{
    var api=new JitsiMeetExternalAPI(${JSON.stringify(domain)},{
      roomName:${JSON.stringify(r)},
      ${emb.jwt ? 'jwt:' + JSON.stringify(emb.jwt) + ',' : ''}
      parentNode:document.getElementById('meet'),
      userInfo:{displayName:${JSON.stringify(dn)}},
      configOverwrite:{prejoinPageEnabled:true,startWithAudioMuted:${isHost ? 'false' : 'true'},startWithVideoMuted:false,disableDeepLinking:true,subject:${JSON.stringify(subj)},disableReactions:false},
      interfaceConfigOverwrite:{MOBILE_APP_PROMO:false,SHOW_JITSI_WATERMARK:false,DEFAULT_BACKGROUND:'#0b1220',TOOLBAR_BUTTONS:${isHost ? HOST_TOOLBAR : STUDENT_TOOLBAR}}
    });
    api.addEventListener('readyToClose',function(){lcEndClass();location.href='/';});
    if(isHost){
      // The lecturer hosts: enable the lobby so students must be admitted, label the room, and MARK the
      // class live for the cohort (so it shows "Live now", the app can join, and there is a session to
      // AUTO-END when the host leaves — which is what stops the class on the students' APK).
      window.addEventListener('pagehide',lcEndClass);
      window.addEventListener('beforeunload',lcEndClass);
      api.addEventListener('videoConferenceJoined',function(){
        try{api.executeCommand('subject',LC_SUBJ);}catch(e){}
        try{api.executeCommand('toggleLobby',true);}catch(e){}
        if(LC_ROOM){try{fetch('/api/class-start?t='+encodeURIComponent(lcTok())+'&room='+encodeURIComponent(LC_ROOM)+'&subject='+encodeURIComponent(LC_SUBJ),{method:'POST'});}catch(e){}}
      });
    } else {
      // A student knocks; show a waiting message until the lecturer admits them.
      var w=document.getElementById('wait');
      api.addEventListener('videoConferenceJoined',function(){ if(w)w.style.display='none'; });
      api.addEventListener('knockingParticipant',function(){});
      setTimeout(function(){ /* if still not joined, the lobby waiting screen is Jitsi's own */ },1500);
      // AUTO-LEAVE when the host ends the class. The APK keeps this page open, so without a signal the
      // Jitsi room kept running after the lecturer ended it. Poll the live-session state and, once the
      // session that made this class live has ended, dispose Jitsi and return to the portal.
      var lcDone=false;
      function lcEnded(){
        if(lcDone)return; lcDone=true;
        try{api.dispose();}catch(e){}
        var m=document.getElementById('meet'); if(m)m.style.display='none';
        if(w){w.style.display='flex';w.innerHTML='<div><div style="font-size:40px">\\uD83D\\uDCF4</div><h3>The class has ended</h3><p style="opacity:.8">Your lecturer ended this live class.</p><p><a href="/" style="color:#9bd">Back to portal</a></p></div>';}
        setTimeout(function(){location.href='/';},4000);
      }
      if(LC_ROOM){
        var lcPoll=setInterval(function(){
          fetch('/api/class-live?room='+encodeURIComponent(LC_ROOM)).then(function(r){return r.json();}).then(function(d){
            if(d&&d.ended){clearInterval(lcPoll);lcEnded();}
          }).catch(function(){});
        },12000);
      }
    }
  }catch(e){fail();}
})();
</script>
</body></html>`;
  }

  // ---- student notification feed (derived from synced data — no writable state needed) ----
  // Surfaces every important update so a student never misses anything: receipts, new fees,
  // results, documents, timetables, course allocations, clearance and disciplinary updates.
  function catLabel(key) { const c = all('fee_categories').find(x => x.key === key && !x.deleted); return c ? c.name : (key ? String(key)[0].toUpperCase() + String(key).slice(1).replace(/_/g, ' ') : 'Fee'); }
  function buildNotifications(s) {
    const out = [];
    const add = (type, icon, title, text, date, seg, docUrl) => { if (!date) return; out.push({ id: type + ':' + (docUrl || date), type, icon, title, text: text || '', date, seg: seg || null, doc: docUrl || null }); };
    for (const p of all('payments').filter(p => p.student_id === s.id && p.status === 'completed'))
      add('receipt', '🧾', 'Payment receipt issued', `${p.receipt_no ? 'Receipt ' + p.receipt_no + ' · ' : ''}${money(p.amount, p.currency)} for ${catLabel(p.category)}`, p.decided_at || p.created_at, 'receipts', p.receipt_no ? '/doc/receipt/' + p.id : null);
    for (const c of all('charges').filter(c => c.student_id === s.id))
      add('fee', '💳', 'New fee on your account', `${catLabel(c.category)} — ${money(c.amount, c.currency)}`, c.created_at, 'fees', null);
    for (const r of all('results').filter(r => r.student_id === s.id))
      add('result', '📑', 'Result published', r.title || 'A new statement of result is available', r.created_at, 'results', null);
    for (const d of all('portal_documents').filter(d => (!d.student_id || d.student_id === s.id) && (!d.faculty_id || d.faculty_id === s.faculty_id) && (!d.department_id || d.department_id === s.department_id) && (!d.level_id || d.level_id === s.level_id)))
      add('document', '📂', 'New document available', d.title || 'A document was published for you', d.created_at, 'documents', '/doc/portal-document/' + d.id);
    for (const t of all('timetables').filter(t => !t.deleted && t.status === 'published' && (t.scope === 'faculty' ? t.faculty_id === s.faculty_id : (t.department_id === s.department_id && (!t.level_id || t.level_id === s.level_id)))))
      add('timetable', '🗓', 'Timetable published', t.title || 'A new timetable is available', t.published_at, 'timetable', '/doc/timetable/' + t.id);
    for (const a of all('allocation_sets').filter(a => !a.deleted && a.status === 'published' && a.department_id === s.department_id && a.level_id === s.level_id))
      add('allocation', '👩‍🏫', 'Course allocation published', a.title || 'Lecturers have been assigned to your courses', a.published_at, 'liveclasses', null);
    // a class that went live in the last 3 hours — surfaces in Updates with a tap-through to Live Classes
    const liveCut = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    for (const v of all('live_sessions').filter(v => !v.deleted && v.active && v.department_id === s.department_id && v.level_id === s.level_id && String(v.started_at || '') >= liveCut))
      add('liveclass', '🔴', 'Live class started', (v.subject || v.course_code || 'A class') + ' is live now — open Live Classes to join', v.started_at, 'liveclasses', null);
    for (const v of all('exam_validations').filter(v => v.student_id === s.id))
      add('clearance', '✅', 'Examination clearance update', (v.status === 'valid' ? 'You have been cleared for exams' : 'Your clearance status changed') + (v.reason ? ' — ' + v.reason : ''), v.created_at, 'clearance', null);
    for (const m of all('misconducts').filter(m => m.student_id === s.id && !m.deleted))
      add('discipline', '⚖️', 'Disciplinary record update', m.offense || 'A disciplinary record was updated', m.occurred_at || m.created_at, null, null);
    for (const f of all('malpractice_flags').filter(f => f.student_id === s.id && !f.deleted))
      add('surveillance', '🛡️', 'Exam conduct notice', (MALPRACTICE_LABELS[f.type] || 'A conduct alert was recorded') + ' — tap to see the evidence and appeal if it was a mistake', f.occurred_at || f.created_at, 'surveillance', null);
    for (const e of all('online_exams').filter(e => examVisibleTo(e, s)))
      add('exam', '📝', 'Online exam: ' + (e.title || e.course_code || 'Exam'), (e.start_at ? 'Scheduled ' + fmtDate(e.start_at) : 'Open now') + ' — tap to open it in the Exams tab', e.published_at || e.created_at, 'exam', null);
    out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return out.slice(0, 80);
  }

  // ---- E-library -----------------------------------------------------------
  // Books the student may see: global, or matching their faculty/department/level.
  function libraryForStudent(s) {
    return all('library_books').filter(b => !b.deleted &&
      (!b.faculty_id || b.faculty_id === s.faculty_id) &&
      (!b.department_id || b.department_id === s.department_id) &&
      (!b.level_id || b.level_id === s.level_id))
      .map(b => ({ id: b.id, title: b.title, author: b.author || '', category: b.category || 'General', description: b.description || '', cover: b.cover || '', mime: b.mime || '', pages: b.pages || 0, filename: b.filename || 'book', readable: /pdf$/i.test(b.mime || '') || /^image\//i.test(b.mime || ''), date: b.created_at }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }
  function libraryVisibleTo(b, s) {
    return b && !b.deleted && (!b.faculty_id || b.faculty_id === s.faculty_id) && (!b.department_id || b.department_id === s.department_id) && (!b.level_id || b.level_id === s.level_id);
  }

  // ---- Exam Surveillance: the student's own attendance + any malpractice flag + evidence ----
  const MALPRACTICE_LABELS = { multiple_faces: 'Another person in your frame', absence: 'You left your seat', left_seat: 'You left your seat', looking_away: 'Looking away from your paper', talking: 'Talking during the exam', phone: 'Phone use', earbuds: 'Earbuds / earphones detected', neck_movement: 'Head/neck turning to a neighbour', notes: 'Unauthorised notes / material', unknown_face: 'Unrecognised face', impersonation: 'Possible impersonation', manual: 'Flagged by an exam officer' };
  function examTitleOf(examId) { const e = examId ? one('surveillance_sessions', examId) : null; return e ? (e.title || e.course_code || 'Exam') : 'Exam'; }
  function surveillanceForStudent(s) {
    const attendance = all('surveillance_attendance').filter(a => !a.deleted && a.student_id === s.id)
      .map(a => ({ exam: examTitleOf(a.exam_id), status: a.status, method: a.method, date: a.last_seen_at || a.created_at }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const appealsByFlag = {};
    for (const ap of all('malpractice_appeals').filter(a => !a.deleted && a.student_id === s.id)) appealsByFlag[ap.flag_id] = { status: ap.status, filed_at: ap.filed_at };
    const flags = all('malpractice_flags').filter(f => !f.deleted && f.student_id === s.id)
      .map(f => ({
        id: f.id, exam: examTitleOf(f.exam_id), type: f.type, label: MALPRACTICE_LABELS[f.type] || f.type,
        severity: f.severity, detail: f.detail || '', status: f.status, date: f.occurred_at || f.created_at,
        evidence: all('malpractice_evidence').filter(e => !e.deleted && e.flag_id === f.id).map(e => ({ id: e.id, kind: e.kind, mime: e.mime, filename: e.filename, bytes: e.bytes })),
        appeal: appealsByFlag[f.id] || null,
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { attendance, flags };
  }

  // ---- Online exams the student can see/sit (matched to their cohort) ----
  function examVisibleTo(e, s) {
    return e && !e.deleted && (e.status === 'published' || e.status === 'live') &&
      (!e.department_id || e.department_id === s.department_id) &&
      (!e.level_id || e.level_id === s.level_id) &&
      (!e.faculty_id || e.faculty_id === s.faculty_id);
  }
  function examsForStudent(s) {
    const now = Date.now();
    const attempted = (e) => all('exam_attempts').some(a => !a.deleted && a.exam_id === e.id && a.student_id === s.id);
    return all('online_exams').filter(e => !e.deleted && (examVisibleTo(e, s) || (e.status === 'ended' && attempted(e)))).map(e => {
      const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === e.id && a.student_id === s.id);
      return {
        id: e.id, title: e.title || e.course_code, course_code: e.course_code, course_title: e.course_title,
        instructions: e.instructions || '', duration_min: e.duration_min || 60, start_at: e.start_at, end_at: e.end_at,
        question_count: all('exam_questions').filter(q => !q.deleted && q.exam_id === e.id).length,
        total_marks: e.total_marks || 0, require_camera: e.require_camera !== 0, window: winState(now, e.start_at, e.end_at),
        status: e.status, live: e.status === 'live',
        attempt: at ? { id: at.id, status: at.status, score: at.score, max_score: at.max_score, submitted_at: at.submitted_at } : null,
      };
    }).sort((a, b) => String(a.start_at || '').localeCompare(String(b.start_at || '')));
  }
  /** Advanced in-app e-book reader (PDF via pdf.js with lazy page rendering + zoom; images inline). */
  function libraryReaderHTML(book, token) {
    const isPdf = /pdf$/i.test(book.mime || '');
    const isImg = /^image\//i.test(book.mime || '');
    const fileUrl = '/library/file/' + book.id + '?t=' + encodeURIComponent(token || '');
    const dl = '/library/download/' + book.id + '?t=' + encodeURIComponent(token || '');
    const title = esc(book.title || 'Book');
    const head = `<div id="bar"><b>📖 ${title}</b><span class="au">${esc(book.author || '')}</span><span class="sp"></span>`
      + (isPdf ? `<button onclick="zo(-1)">−</button><span id="zl">100%</span><button onclick="zo(1)">+</button>` : '')
      + `<a href="${dl}">⬇ Download</a><a href="/">⤺ Back</a></div>`;
    if (isImg) {
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>html,body{margin:0;background:#0b1220;color:#fff;font-family:'Segoe UI',Arial,sans-serif}#bar{height:46px;display:flex;align-items:center;gap:10px;padding:0 14px;background:#0f1e3d}#bar .au{opacity:.7;font-size:12px}#bar .sp{flex:1}#bar a{color:#bcd;text-decoration:none;background:#1e3a8a;padding:7px 12px;border-radius:8px;font-size:13px}img{display:block;max-width:100%;margin:16px auto}</style></head>
<body>${head}<img src="${fileUrl}"></body></html>`;
    }
    if (!isPdf) {
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;background:#0f1e3d;color:#fff;font-family:'Segoe UI',Arial,sans-serif;text-align:center;padding:60px 20px}a{color:#9bd}</style></head>
<body><h2>📘 ${title}</h2><p>This file type can't be read in the browser. Please download it to open in a reader app.</p><p><a href="${dl}">⬇ Download book</a> &nbsp; <a href="/">⤺ Back to portal</a></p></body></html>`;
    }
    // PDF reader (pdf.js, lazy per-page canvas rendering)
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title>
<style>html,body{margin:0;background:#1f2733;color:#fff;font-family:'Segoe UI',Arial,sans-serif}
#bar{position:sticky;top:0;z-index:5;height:46px;display:flex;align-items:center;gap:8px;padding:0 12px;background:#0f1e3d}
#bar b{font-size:14px}#bar .au{opacity:.7;font-size:12px}#bar .sp{flex:1}
#bar button{background:#1e3a8a;color:#fff;border:0;width:30px;height:30px;border-radius:7px;font-size:16px;cursor:pointer}
#bar #zl{font-size:12px;min-width:42px;text-align:center}
#bar a{color:#bcd;text-decoration:none;background:#1e3a8a;padding:7px 11px;border-radius:8px;font-size:13px}
#doc{padding:16px 8px 60px;display:flex;flex-direction:column;align-items:center;gap:14px}
.pg{background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.4);max-width:100%}
#msg{padding:40px;text-align:center;opacity:.85}
</style></head><body>
${head}
<div id="doc"><div id="msg">Loading book…</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
(function(){
  var FILE=${JSON.stringify(fileUrl)};
  if(!window['pdfjsLib']){document.getElementById('msg').textContent='Could not load the reader. Check your connection and try again, or download the book.';return;}
  pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var scale=1.2, pdf=null, doc=document.getElementById('doc'), io;
  function setZoom(){document.getElementById('zl').textContent=Math.round(scale/1.2*100)+'%';}
  window.zo=function(d){scale=Math.min(3,Math.max(0.5,scale+ d*0.2));setZoom();render(true);};
  function makeCanvases(){
    doc.innerHTML='';
    io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){draw(e.target);io.unobserve(e.target);}});},{rootMargin:'600px'});
    for(var i=1;i<=pdf.numPages;i++){var cv=document.createElement('canvas');cv.className='pg';cv.dataset.p=i;doc.appendChild(cv);io.observe(cv);}
  }
  function draw(cv){
    var n=+cv.dataset.p;
    pdf.getPage(n).then(function(page){
      var vp=page.getViewport({scale:scale});
      var ratio=window.devicePixelRatio||1;
      cv.width=vp.width*ratio;cv.height=vp.height*ratio;cv.style.width=vp.width+'px';cv.style.height=vp.height+'px';
      var ctx=cv.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);
      page.render({canvasContext:ctx,viewport:vp});
    });
  }
  function render(re){ if(!pdf)return; if(re){makeCanvases();} }
  pdfjsLib.getDocument(FILE).promise.then(function(p){pdf=p;setZoom();makeCanvases();}).catch(function(){document.getElementById('msg').textContent='Could not open this book. Try downloading it instead.';});
})();
</script>
</body></html>`;
  }

  function studentCharges(sid) { return all('charges').filter(c => c.student_id === sid); }
  function studentPaymentsCompleted(sid) { return all('payments').filter(p => p.student_id === sid && p.status === 'completed'); }
  function balancesFor(sid) {
    const bal = {};
    for (const c of studentCharges(sid)) bal[c.currency] = (bal[c.currency] || 0) + c.amount;
    for (const p of studentPaymentsCompleted(sid)) bal[p.currency] = (bal[p.currency] || 0) - p.amount;
    for (const k of Object.keys(bal)) if (Math.abs(bal[k]) < 0.001) delete bal[k];
    return bal;
  }
  // published per-course scores grouped by session+semester, with semester GPA + overall CGPA
  function scoresFor(sid) {
    const codeK = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const raw = all('student_scores').filter(r => r.student_id === sid && !r.deleted)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    // collapse duplicate course rows (same course in the same session+semester) — most recent wins
    const ddMap = {};
    for (const r of raw) ddMap[`${r.session_id || ''}|${r.semester_id || ''}|${codeK(r.course_code)}`] = r;
    const rows = Object.values(ddMap)
      .map(r => { const gp = Number(r.grade_point) || 0, cu = Number(r.credit_unit) || 0; return { course_code: r.course_code, course_title: r.course_title, credit_unit: cu, test_score: r.test_score, exam_score: r.exam_score, score: r.score, grade: r.grade, grade_point: gp, co: gp * cu, session_id: r.session_id, semester_id: r.semester_id, session: nameOf('academic_sessions', r.session_id), semester: nameOf('semesters', r.semester_id), date: r.created_at }; })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const gpaOf = (list) => { let qp = 0, u = 0; for (const s of list) { qp += s.grade_point * s.credit_unit; u += s.credit_unit; } return { gpa: u ? Math.round((qp / u) * 100) / 100 : 0, units: u }; };
    const groups = {};
    for (const r of rows) { const k = `${r.session_id || ''}|${r.semester_id || ''}`; (groups[k] = groups[k] || { session: r.session, semester: r.semester, session_id: r.session_id, semester_id: r.semester_id, list: [] }).list.push(r); }
    // chronological (ascending) so we can carry a running CGPA per semester
    const ordered = Object.values(groups).sort((a, b) => String((a.list[0] || {}).date).localeCompare(String((b.list[0] || {}).date)));
    let cumQp = 0, cumU = 0;
    const semesters = ordered.map(g => { const b = gpaOf(g.list); cumQp += g.list.reduce((x, c) => x + c.grade_point * c.credit_unit, 0); cumU += b.units; return { session: g.session, semester: g.semester, session_id: g.session_id, semester_id: g.semester_id, courses: g.list, ...b, cgpa: cumU ? Math.round((cumQp / cumU) * 100) / 100 : 0 }; });
    const overall = gpaOf(rows);
    return { courses: rows, semesters, cgpa: overall.gpa, totalUnits: overall.units };
  }
  const ROLE_OFFICE = { registrar: 'Office of the Registrar', accountant: 'Office of the Bursar', dean: 'Office of the Faculty Head', admin: 'Administration', student_affairs: 'Office of Student Affairs', hod: 'Office of the Head of Department' };
  // an HOD-issued receipt names the department; falls back to the plain office label
  const officeOf = (role, deptId) => role === 'hod' ? ('Office of the Head of Department' + (deptId && nameOf('departments', deptId) ? ' — ' + nameOf('departments', deptId) : '')) : (ROLE_OFFICE[role] || 'Office of the Bursar');

  function studentProfile(s) {
    return {
      id: s.id, full_name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), matric_no: s.matric_no,
      email: s.email, phone: s.phone, gender: s.gender, photo: s.photo, nationality: s.nationality,
      faculty: nameOf('faculties', s.faculty_id), department: nameOf('departments', s.department_id), level: nameOf('levels', s.level_id),
      status: s.status,
    };
  }

  function studentData(s) {
    const charges = studentCharges(s.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const pays = studentPaymentsCompleted(s.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const outstanding = {};
    // per category+currency
    const billed = {}; const paid = {};
    for (const c of charges) { const k = c.category + '|' + c.currency; billed[k] = (billed[k] || 0) + c.amount; }
    for (const p of pays) { const k = p.category + '|' + p.currency; paid[k] = (paid[k] || 0) + p.amount; }
    const owingRows = [];
    for (const k of Object.keys(billed)) {
      const [category, currency] = k.split('|'); const owed = billed[k] - (paid[k] || 0);
      if (owed > 0.001) owingRows.push({ category, currency, billed: billed[k], paid: paid[k] || 0, outstanding: owed });
    }
    const userName = (uid) => { const u = uid ? one('users', uid) : null; return u ? u.full_name : null; };
    // exam clearance status: full clearance, else active partial, else not cleared.
    // A student may hold BOTH a mid-semester and an examination clearance — list each
    // so the portal can offer a separate, correctly-labelled certificate per type.
    const clr = (() => {
      const completed = all('exam_clearances').filter(c => c.student_id === s.id && c.status === 'completed')
        .map(c => ({ id: c.id, type: c.clearance_type === 'midterm' ? 'midterm' : 'exam', typeName: c.clearance_type === 'midterm' ? 'Mid-Semester' : 'Examination' }));
      if (completed.length) {
        const exam = completed.find(c => c.type === 'exam') || completed[0];
        return { cleared: true, type: 'full', clearanceId: exam.id, certs: completed };
      }
      const partial = all('partial_clearances').find(p => p.student_id === s.id && p.status === 'active');
      if (partial) return { cleared: true, type: 'partial', reason: partial.reason, certs: [] };
      const owes = Object.values(balancesFor(s.id)).some(v => v > 0.001);
      return { cleared: false, type: null, reason: owes ? 'Outstanding fees not cleared' : 'No examination clearance issued', certs: [] };
    })();
    const validations = all('exam_validations').filter(v => v.student_id === s.id)
      .map(v => ({ status: v.status, reason: v.reason, exam_type: v.exam_type, date: v.created_at, session: nameOf('academic_sessions', v.session_id), semester: nameOf('semesters', v.semester_id) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    // published timetables for this student's cohort (lecture for dept+level; exams dept- or
    // faculty-wide, with faculty-wide sittings filtered down to the student's own cohort).
    const myTimetables = all('timetables').filter(t => !t.deleted && t.status === 'published')
      .filter(t => t.scope === 'faculty' ? t.faculty_id === s.faculty_id : (t.department_id === s.department_id && (!t.level_id || t.level_id === s.level_id)))
      .map(t => {
        let slots = all('timetable_slots').filter(sl => sl.timetable_id === t.id && !sl.deleted);
        if (t.scope === 'faculty') slots = slots.filter(sl => sl.kind === 'holiday' || (sl.department_id === s.department_id && (!sl.level_id || sl.level_id === s.level_id)));
        slots = slots.map(sl => ({ course_code: sl.course_code, course_title: sl.course_title, lecturer: sl.lecturer_name, day: sl.day_or_date, start: sl.start_time, end: sl.end_time, venue: sl.venue, kind: sl.kind }))
          .sort((a, b) => String(a.day).localeCompare(String(b.day)) || String(a.start || '').localeCompare(String(b.start || '')));
        return { id: t.id, title: t.title, type: t.type, level: nameOf('levels', t.level_id), department: nameOf('departments', t.department_id), faculty: nameOf('faculties', t.faculty_id), session: nameOf('academic_sessions', t.session_id), semester: nameOf('semesters', t.semester_id), date: t.published_at, slots };
      }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    // published course allocations (which lecturer teaches each course) for dept+level
    const myAllocations = all('allocation_sets').filter(a => !a.deleted && a.status === 'published' && a.department_id === s.department_id && a.level_id === s.level_id)
      .map(a => ({ id: a.id, title: a.title, department: nameOf('departments', a.department_id), level: nameOf('levels', a.level_id), session: nameOf('academic_sessions', a.session_id), semester: nameOf('semesters', a.semester_id), date: a.published_at,
        courses: all('course_allocations').filter(r => r.set_id === a.id && !r.deleted).map(r => ({ code: r.course_code, title: r.course_title, ch: r.credit_unit, lecturer: r.lecturer_name })) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const i = inst();
    // segment by office so the student sees exactly who they owe (and who collected)
    const roleOf = (uid) => { const u = uid ? one('users', uid) : null; return u ? u.role : null; };
    const offices = {};
    const bucket = (role) => { const k = role || 'accountant'; offices[k] = offices[k] || { role: k, office: officeOf(k, s.department_id), charged: {}, paid: {}, owing: {} }; return offices[k]; };
    for (const c of charges) { const b = bucket(roleOf(c.created_by) || 'accountant'); b.charged[c.currency] = (b.charged[c.currency] || 0) + c.amount; }
    for (const pmt of pays) { const b = bucket(pmt.raised_role || 'accountant'); b.paid[pmt.currency] = (b.paid[pmt.currency] || 0) + pmt.amount; }
    for (const k of Object.keys(offices)) { const o = offices[k]; for (const cur of new Set([...Object.keys(o.charged), ...Object.keys(o.paid)])) { const owe = (o.charged[cur] || 0) - (o.paid[cur] || 0); if (owe > 0.001) o.owing[cur] = owe; } }
    return {
      profile: studentProfile(s),
      byOffice: Object.values(offices),
      currentSession: i.session || nameOf('academic_sessions', s.current_session_id) || '',
      currentSemester: i.semester || '',
      balances: balancesFor(s.id),
      examClearance: clr,
      validations,
      results: all('results').filter(r => r.student_id === s.id).map(r => ({ id: r.id, title: r.title, level: nameOf('levels', r.level_id), semester: nameOf('semesters', r.semester_id), session: nameOf('academic_sessions', r.session_id), gpa: r.gpa, remark: r.remark, mime: r.mime, date: r.created_at })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      scores: scoresFor(s.id),
      timetables: myTimetables,
      allocations: myAllocations,
      liveClasses: liveClassesForStudent(s),
      notifications: buildNotifications(s),
      library: libraryForStudent(s),
      surveillance: surveillanceForStudent(s),
      exams: examsForStudent(s),
      documents: all('portal_documents').filter(d => (!d.student_id || d.student_id === s.id) && (!d.faculty_id || d.faculty_id === s.faculty_id) && (!d.department_id || d.department_id === s.department_id) && (!d.level_id || d.level_id === s.level_id))
        .map(d => ({ id: d.id, title: d.title, category: d.category, office: d.office, by: userName(d.uploaded_by), mime: d.mime, date: d.created_at })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      misconduct: all('misconducts').filter(m => m.student_id === s.id && !m.deleted).map(m => ({ offense: m.offense, severity: m.severity, action: m.action, fine: m.penalty_amount || 0, currency: m.currency, status: m.status, date: m.occurred_at || m.created_at, note: m.resolution_note || m.description || '' })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      charges: charges.map(c => ({ id: c.id, category: c.category, description: c.description, currency: c.currency, amount: c.amount, date: c.created_at, by: userName(c.created_by), rollover: !!c.is_rolled_over, rolled_from: nameOf('academic_sessions', c.rolled_from_session) })),
      payments: pays.map(p => ({ id: p.id, receipt_no: p.receipt_no, category: p.category, currency: p.currency, amount: p.amount, method: p.method, date: p.decided_at || p.created_at, office: officeOf(p.raised_role, s.department_id), collector: userName(p.decided_by || p.raised_by) })),
      outstanding: owingRows,
    };
  }

  // ---- student assistant (deterministic intent engine over the student's own data) ----
  // Answers the common portal questions ("my results", "how much do I owe", "when are my exams",
  // "am I cleared") from the SAME data the dashboard shows. No AI key needed — works on any portal.
  function sumByCur(items) { const m = {}; for (const it of items) m[it.currency] = (m[it.currency] || 0) + it.amount; return Object.keys(m).map(c => money(m[c], c)).join(' + ') || money(0); }
  function studentAssistant(s, message, isParent) {
    const d = studentData(s);
    const q = String(message || '').toLowerCase().trim();
    const who = isParent ? 'your ward' : 'you'; const has = (s2) => isParent ? (s2 + 's') : s2; // verb agreement helper
    const fname = s.first_name || (d.profile && (d.profile.full_name || '').split(' ')[0]) || 'there';
    const re = (rx) => rx.test(q);

    if (re(/\b(owe|owing|balance|outstanding|debt|arrears)\b/) || (/how much/.test(q) && /(owe|pay|fee|balance|left)/.test(q))) {
      const owe = (d.outstanding || []).filter(o => o.outstanding > 0.001);
      if (!owe.length) return `Good news — ${who} ${isParent ? 'has' : 'have'} no outstanding balance. ✅`;
      const lines = owe.map(o => '• ' + catLabel(o.category) + ': ' + money(o.outstanding, o.currency) + ' outstanding (of ' + money(o.billed, o.currency) + ' billed)').join('\n');
      return `Here is what ${who} currently ${has('owe')}:\n${lines}\nTotal: ${sumByCur(owe.map(o => ({ currency: o.currency, amount: o.outstanding })))}\nOpen the Fees tab to pay or download a statement.`;
    }
    if (re(/\b(my fees|school fees|tuition|charges|fee breakdown|bill)\b/) || (/what.*fee/.test(q))) {
      const ch = d.charges || [];
      if (!ch.length) return `No fees have been billed to ${who} yet.`;
      const g = {}; for (const c of ch) { const k = c.category + '|' + c.currency; g[k] = (g[k] || 0) + c.amount; }
      const lines = Object.keys(g).map(k => { const [cat, cur] = k.split('|'); return '• ' + catLabel(cat) + ': ' + money(g[k], cur); }).join('\n');
      return `Fees billed to ${who}:\n${lines}\nSee the Fees tab for the full statement and to pay.`;
    }
    if (re(/\b(result|results|score|scores|gpa|cgpa|grade|grades|my marks?|how did i do)\b/)) {
      const sc = d.scores || [], rs = d.results || [];
      if (!sc.length && !rs.length) return `No results have been published for ${who} yet. ${isParent ? 'They' : 'You'} will be notified when they are ready, and can download them from the Results tab.`;
      const sems = new Set(sc.map(x => (x.session || '') + '|' + (x.semester || ''))).size;
      let msg = `${isParent ? 'Your ward has' : 'You have'} published results in ${sems || rs.length} semester(s).`;
      if (rs[0] && rs[0].gpa) msg += ' Most recent GPA: ' + rs[0].gpa + '.';
      return msg + ' Open the Results tab to view or download each statement.';
    }
    if (re(/\b(exam|exams|test|paper|timetable|time table|schedule|class|classes|lecture|lectures)\b/) || /when (is|are|do)/.test(q)) {
      const examSlots = [];
      for (const t of (d.timetables || []).filter(t => t.type === 'exam')) for (const sl of (t.slots || [])) if (sl.kind !== 'holiday' && sl.course_code) examSlots.push(sl);
      examSlots.sort((a, b) => String(a.day).localeCompare(String(b.day)));
      if (/exam|test|paper/.test(q) && examSlots.length) {
        const next = examSlots.slice(0, 4).map(sl => '• ' + sl.course_code + (sl.course_title ? (' ' + sl.course_title) : '') + ': ' + fmtDate(sl.day) + (sl.start ? (' at ' + sl.start) : '') + (sl.venue ? (' — ' + sl.venue) : '')).join('\n');
        return 'Upcoming exams:\n' + next + '\nFull details are in the Timetable tab.';
      }
      const lectures = (d.timetables || []).filter(t => t.type === 'lecture');
      if (lectures.length) return 'Your lecture timetable is published — open the Timetable tab for your weekly classes.' + (examSlots.length ? ' Your exam timetable is there too.' : '');
      if (examSlots.length) return 'Your exam timetable is published — open the Timetable tab.';
      return 'No timetable has been published yet. You will be notified when it is out.';
    }
    if (re(/\b(clearance|cleared|exam card)\b/)) {
      const clr = d.examClearance || {};
      return clr.cleared ? `${isParent ? 'Your ward is' : 'You are'} cleared for exams ✅. Download the certificate from the Clearance tab.` : `${isParent ? 'Your ward is' : 'You are'} not cleared for exams yet${clr.reason ? (': ' + clr.reason) : ''}. Clear any outstanding fees, then check with the bursary.`;
    }
    if (re(/\b(document|documents|admission letter|transcript|certificate|library|book|e-?book)\b/)) return 'Your documents (admission letter, transcript, etc.) are in the Documents tab, and e-books are in the Library tab.';
    if (re(/\b(help|what can you|how do i|navigate|where|menu|guide|assist)\b/)) return `I can help ${who} with:\n• Results & GPA — “show my results”\n• School fees & balance — “how much do I owe?”\n• Exam clearance — “am I cleared?”\n• Timetable & exams — “when are my exams?”\nUse the tabs at the top for Fees, Results, Timetable, Documents and Library.`;
    if (re(/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/)) return `Hi ${fname}! I can help you check your results, school fees, balance, clearance and timetable. What would you like to know?`;
    return 'I can help with your results, school fees, how much you owe, exam clearance and timetable. Try “How much do I owe?”, “Show my results”, or “When are my exams?”.';
  }

  function staffProfile(s) {
    return {
      id: s.id, full_name: s.full_name, staff_no: s.staff_no, type: s.staff_type === 'lecturer' ? 'Lecturer' : 'Staff',
      title: s.title, position: s.position, department: s.department, faculty: s.faculty, qualification: s.qualification,
      email: s.email, phone: s.phone, photo: s.photo, bank_name: s.bank_name, bank_account: s.bank_account,
      base_salary: s.base_salary, currency: s.currency, date_employed: s.date_employed,
    };
  }
  function staffData(s) {
    const slips = all('payslips').filter(p => p.staff_id === s.id).map(p => {
      const run = one('payroll_runs', p.run_id) || {};
      return { id: p.id, period: run.period, status: run.status, run_type: run.run_type, gross: p.gross, allowances: p.allowances, bonus: p.bonus, deductions: p.deductions, loan_deduction: p.loan_deduction, net: p.net, currency: p.currency };
    }).sort((a, b) => String(b.period).localeCompare(String(a.period)));
    return { profile: staffProfile(s), payslips: slips, liveClasses: s.staff_type === 'lecturer' ? liveClassesForLecturer(s) : [] };
  }

  // Build a period filter from query params: basis = day|week|month|semester|session|all
  function parsePeriod(sp) {
    const basis = sp.get('basis') || (sp.get('session') || sp.get('semester') ? 'session' : 'all');
    return { basis, day: sp.get('day') || '', weekStart: sp.get('weekStart') || '', month: sp.get('month') || '', session: sp.get('session') || '', semester: sp.get('semester') || '', office: sp.get('office') || '' };
  }
  function periodLabel(period) {
    if (!period) return 'All time';
    switch (period.basis) {
      case 'day': return period.day ? 'On ' + period.day : 'Daily';
      case 'week': return period.weekStart ? 'Week of ' + period.weekStart : 'Weekly';
      case 'month': return period.month ? 'Month of ' + period.month : 'Monthly';
      case 'semester': return (period.session ? (nameOf('academic_sessions', period.session) || 'session') : 'All sessions') + ' · ' + (period.semester ? (nameOf('semesters', period.semester) || 'semester') : 'All semesters');
      case 'session': return period.session ? (nameOf('academic_sessions', period.session) || 'Session') : 'All sessions';
      default: return 'All time';
    }
  }

  function officerData(u, period) {
    const role = u.role;
    const dstr = (r) => String(r.decided_at || r.created_at || '');
    const inP = (r) => {
      if (!period || !period.basis || period.basis === 'all') return true;
      if (period.basis === 'day') return !period.day || dstr(r).slice(0, 10) === period.day;
      if (period.basis === 'week') { if (!period.weekStart) return true; const e = new Date(period.weekStart + 'T00:00:00'); e.setDate(e.getDate() + 7); const end = e.toISOString().slice(0, 10); const d = dstr(r).slice(0, 10); return d >= period.weekStart && d < end; }
      if (period.basis === 'month') return !period.month || dstr(r).slice(0, 7) === period.month;
      // session / semester
      return (!period.session || (r.session_id || '') === period.session) && (!period.semester || (r.semester_id || '') === period.semester);
    };
    const completed = all('payments').filter(p => p.status === 'completed' && inP(p));
    const out = {
      profile: { id: u.id, full_name: u.full_name, role, email: u.email, photo: u.photo || '' },
      periods: { sessions: all('academic_sessions').map(s => ({ id: s.id, name: s.name })), semesters: all('semesters').map(s => ({ id: s.id, name: s.name, session_id: s.session_id })) },
      period: period || {},
    };
    if (role === 'accountant' || role === 'admin') {
      const collected = {}; const billed = {}; const expenses = {};
      for (const p of completed) collected[p.currency] = (collected[p.currency] || 0) + p.amount;
      for (const c of all('charges').filter(inP)) billed[c.currency] = (billed[c.currency] || 0) + c.amount;
      for (const e of all('expenses').filter(inP)) expenses[e.currency] = (expenses[e.currency] || 0) + e.amount;
      const students = all('students').filter(s => s.status !== 'alumni');
      let debtors = 0; for (const s of students) if (Object.values(balancesFor(s.id)).some(v => v > 0.001)) debtors++;
      out.kind = 'finance';
      out.canPickOffice = true;
      out.cards = { collected, billed, expenses, students: students.length, debtors };
      const OFFICE_LABEL = { accountant: 'Bursary / Accountant', registrar: 'Registrar', dean: 'Faculty Head (Dean)', student_affairs: 'Student Affairs', admin: 'Administration' };
      const userName = (id) => { const x = id ? one('users', id) : null; return x ? x.full_name : '—'; };
      // collections grouped by the office that collected them
      const byOffice = {};
      for (const p of completed) { const r = p.raised_role || 'accountant'; byOffice[r] = byOffice[r] || {}; byOffice[r][p.currency] = (byOffice[r][p.currency] || 0) + p.amount; }
      out.byOffice = Object.entries(byOffice).map(([r, m]) => ({ role: r, office: OFFICE_LABEL[r] || r, amounts: m })).sort((a, b) => a.office.localeCompare(b.office));
      // optional office filter (the accountant picks an office to drill into)
      const off = period && period.office;
      const filtered = off ? completed.filter(p => (p.raised_role || 'accountant') === off) : completed;
      out.officeFilter = off || '';
      out.recent = filtered.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 60)
        .map(p => ({ receipt_no: p.receipt_no, student: studentName(p.student_id), category: p.category, amount: p.amount, currency: p.currency, office: OFFICE_LABEL[p.raised_role || 'accountant'] || '—', by: userName(p.decided_by || p.raised_by), date: p.decided_at || p.created_at }));
      // expenses — ALL offices, with who recorded them
      const expRows = all('expenses').filter(inP);
      const expByOffice = {};
      for (const e of expRows) { const r = (one('users', e.recorded_by) || {}).role || 'accountant'; expByOffice[r] = expByOffice[r] || {}; expByOffice[r][e.currency] = (expByOffice[r][e.currency] || 0) + e.amount; }
      out.expensesByOffice = Object.entries(expByOffice).map(([r, m]) => ({ office: OFFICE_LABEL[r] || r, amounts: m }));
      out.expensesList = expRows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 60)
        .map(e => ({ category: e.category, description: e.description, amount: e.amount, currency: e.currency, by: userName(e.recorded_by), date: e.created_at }));
    } else if (role === 'registrar' || role === 'student_affairs') {
      out.kind = 'registrar';
      out.collected = {};
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) { out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount; }
      const ids = [...new Set(all('charges').filter(c => c.created_by === u.id && inP(c)).map(c => c.student_id))];
      out.students = ids.map(sid => billedSummary(sid, u.id)).filter(Boolean);
    } else if (role === 'dean') {
      out.kind = 'dean'; out.collected = {}; out.expenses = {};
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount;
      for (const e of all('expenses').filter(e => e.recorded_by === u.id && inP(e))) out.expenses[e.currency] = (out.expenses[e.currency] || 0) + e.amount;
      const inFac = all('students').filter(s => s.faculty_id === u.faculty_id && s.status !== 'alumni');
      out.debtors = [];
      for (const s of inFac) {
        const bal = {};
        for (const c of studentCharges(s.id)) if (['faculty_due', 'custom'].includes(c.category)) bal[c.currency] = (bal[c.currency] || 0) + c.amount;
        for (const p of studentPaymentsCompleted(s.id)) if (['faculty_due', 'custom'].includes(p.category)) bal[p.currency] = (bal[p.currency] || 0) - p.amount;
        const owing = {}; for (const k of Object.keys(bal)) if (bal[k] > 0.001) owing[k] = bal[k];
        if (Object.keys(owing).length) out.debtors.push({ full_name: studentName(s.id), matric_no: s.matric_no, department: nameOf('departments', s.department_id), owing });
      }
    } else if (role === 'hod') {
      // a Head of Department's portal view mirrors the dean's, scoped to ONE department
      out.kind = 'dean'; out.collected = {}; out.expenses = {}; out.scopeLabel = 'Department: ' + (nameOf('departments', u.department_id) || '—');
      for (const p of completed) if (p.raised_by === u.id || p.decided_by === u.id) out.collected[p.currency] = (out.collected[p.currency] || 0) + p.amount;
      for (const e of all('expenses').filter(e => e.recorded_by === u.id && inP(e))) out.expenses[e.currency] = (out.expenses[e.currency] || 0) + e.amount;
      const inDept = all('students').filter(s => s.department_id === u.department_id && s.status !== 'alumni');
      out.debtors = [];
      for (const s of inDept) {
        const bal = {};
        for (const c of studentCharges(s.id)) if (['faculty_due', 'custom'].includes(c.category)) bal[c.currency] = (bal[c.currency] || 0) + c.amount;
        for (const p of studentPaymentsCompleted(s.id)) if (['faculty_due', 'custom'].includes(p.category)) bal[p.currency] = (bal[p.currency] || 0) - p.amount;
        const owing = {}; for (const k of Object.keys(bal)) if (bal[k] > 0.001) owing[k] = bal[k];
        if (Object.keys(owing).length) out.debtors.push({ full_name: studentName(s.id), matric_no: s.matric_no, department: nameOf('departments', s.department_id), owing });
      }
    } else { // student_affairs (no collections role) — clearance + discipline summary
      out.kind = 'affairs';
      const aps = all('clearance_approvals').filter(a => a.office === 'student_affairs');
      out.clearance = { pending: aps.filter(a => a.status === 'pending').length, approved: aps.filter(a => a.status === 'approved').length, denied: aps.filter(a => a.status === 'denied').length };
      const mc = all('misconducts');
      out.misconduct = { total: mc.length, open: mc.filter(m => m.status === 'open').length, resolved: mc.filter(m => m.status === 'resolved').length };
    }
    return out;
  }
  function studentName(sid) { const s = one('students', sid); return s ? `${s.first_name || ''} ${s.last_name || ''}`.trim() : '—'; }
  function billedSummary(sid, uid) {
    const s = one('students', sid); if (!s) return null;
    const billed = {}; const paid = {}; const owing = {};
    for (const c of studentCharges(sid)) if (c.created_by === uid) billed[c.currency] = (billed[c.currency] || 0) + c.amount;
    for (const p of studentPaymentsCompleted(sid)) if (p.raised_by === uid || p.decided_by === uid) paid[p.currency] = (paid[p.currency] || 0) + p.amount;
    for (const k of new Set([...Object.keys(billed), ...Object.keys(paid)])) { const o = (billed[k] || 0) - (paid[k] || 0); if (o > 0.001) owing[k] = o; }
    return { full_name: studentName(sid), matric_no: s.matric_no, department: nameOf('departments', s.department_id), paid, owing };
  }

  // ---- clearance verification (public; staff scan the QR to confirm a student) ----
  function verifyClearance(idOrRef) {
    const key = String(idOrRef || '').trim();
    if (!key) return { valid: false };
    let c = one('exam_clearances', key);
    if (!c) { // accept a short ref (first hex chars of the id)
      const want = key.replace(/-/g, '').toLowerCase();
      if (want.length >= 6 && want.length <= 16) c = all('exam_clearances').find(x => String(x.id).replace(/-/g, '').toLowerCase().startsWith(want));
    }
    if (!c) return { valid: false };
    const s = one('students', c.student_id) || {};
    const approvals = all('clearance_approvals').filter(a => a.clearance_id === c.id)
      .map(a => ({ office: a.office, status: a.status, by: a.approver_id ? ((one('users', a.approver_id) || {}).full_name || null) : null, date: a.decided_at }));
    const isMid = c.clearance_type === 'midterm';
    return {
      valid: true, completed: c.status === 'completed', status: c.status,
      clearanceType: isMid ? 'midterm' : 'exam', typeName: isMid ? 'Mid-Semester' : 'Examination',
      ref: String(c.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      student: {
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown', matric: s.matric_no || '—', gender: s.gender || '—',
        photo: s.photo || '', faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—',
        level: nameOf('levels', s.level_id) || '—', status: s.status || '—',
      },
      session: nameOf('academic_sessions', c.session_id) || '—', semester: nameOf('semesters', c.semester_id) || '—',
      approvals, issued: c.created_at,
    };
  }

  // Public STUDENT identity check (no login) — backs the digital student ID card's QR. Resolves a
  // student by matric number (preferred) or id and returns ONLY public identity (name/faculty/dept/
  // level/status/photo) — never any financials — so security/gate staff can confirm enrolment.
  function verifyStudent(matricOrId) {
    const key = String(matricOrId || '').trim();
    if (!key) return { valid: false };
    let s = all('students').find(x => !x.deleted && String(x.matric_no || '').toLowerCase() === key.toLowerCase());
    if (!s) s = one('students', key);
    if (!s || s.deleted) return { valid: false };
    return {
      valid: true, kind: 'student',
      ref: String(s.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      student: {
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown',
        matric: s.matric_no || '—', photo: s.photo || '',
        faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—',
        level: nameOf('levels', s.level_id) || '—', status: s.status || 'active',
      },
      session: nameOf('academic_sessions', s.session_id) || (inst().session || '—'),
    };
  }

  // Public receipt authenticity check (no login). Resolves a payment by id, short
  // id-ref, OR its printed receipt number, and returns the genuine details so anyone
  // can confirm a receipt presented to them isn't forged or altered.
  function verifyReceipt(idOrRef) {
    const key = String(idOrRef || '').trim();
    if (!key) return { valid: false };
    let p = one('payments', key);
    if (!p) {
      const want = key.replace(/-/g, '').toLowerCase();
      if (want.length >= 6 && want.length <= 16) p = all('payments').find(x => String(x.id).replace(/-/g, '').toLowerCase().startsWith(want));
      if (!p) p = all('payments').find(x => String(x.receipt_no || '').toLowerCase() === key.toLowerCase());
    }
    if (!p || p.deleted || p.status !== 'completed') return { valid: false };
    const s = one('students', p.student_id) || {};
    const office = ROLE_OFFICE[p.raised_role] || 'Office of the Bursar';
    const receivedBy = (one('users', p.decided_by) || one('users', p.raised_by) || {}).full_name || office;
    const catRow = all('fee_categories').find(c => c.key === p.category && !c.deleted);
    const feeLabel = (catRow && catRow.name) || (p.category ? p.category[0].toUpperCase() + p.category.slice(1).replace(/_/g, ' ') + ' Fee' : '—');
    return {
      valid: true, kind: 'receipt',
      ref: String(p.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      receipt_no: p.receipt_no || '—',
      amountText: money(p.amount, p.currency),
      category: feeLabel, narration: p.narration || '',
      method: String(p.channel || p.method || 'cash').toUpperCase(),
      dateText: fmtDate(p.decided_at || p.created_at), office, receivedBy,
      student: {
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown',
        matric: s.matric_no || '—', photo: s.photo || '',
        faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—',
      },
    };
  }

  // Public payslip authenticity check (no login) — confirms a payslip presented to a
  // bank/landlord is genuine: who it's for, the period, and the NET pay.
  function verifyPayslip(idOrRef) {
    const key = String(idOrRef || '').trim();
    if (!key) return { valid: false };
    let ps = one('payslips', key);
    if (!ps) { const want = key.replace(/-/g, '').toLowerCase(); if (want.length >= 6 && want.length <= 16) ps = all('payslips').find(x => String(x.id).replace(/-/g, '').toLowerCase().startsWith(want)); }
    if (!ps || ps.deleted) return { valid: false };
    const st = one('staff', ps.staff_id) || {};
    const run = one('payroll_runs', ps.run_id) || {};
    const cur = ps.currency || st.currency;
    const isLect = st.staff_type === 'lecturer';
    return {
      valid: true, kind: 'payslip',
      ref: String(ps.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      staffType: isLect ? 'Lecturer' : 'Staff',
      net: money(ps.net, cur), gross: money(ps.gross, cur),
      period: run.period || '—', dateText: fmtDate(run.updated_at || run.created_at),
      staff: { name: st.full_name || 'Unknown', staffNo: st.staff_no || '—', photo: st.photo || '', department: st.department || st.faculty || '—' },
    };
  }

  // Public result authenticity check (no login) — confirms a statement of result is genuine:
  // the student, level and the GPA/CGPA. Key is the student id, optionally "id|session|semester".
  function verifyResult(idOrRef) {
    let key = String(idOrRef || '').trim(); let ses = '', sem = '';
    if (key.indexOf('|') >= 0) { const a = key.split('|'); key = a[0]; ses = a[1] || ''; sem = a[2] || ''; }
    const s = one('students', key);
    if (!s || s.deleted) return { valid: false };
    const sc = scoresFor(s.id);
    if (!sc.courses || !sc.courses.length) return { valid: false };
    let gpa = sc.cgpa, cgpa = sc.cgpa, units = sc.totalUnits, courses = sc.courses.length, sesName = '', semName = '';
    if (ses || sem) { const g = (sc.semesters || []).find(x => (!ses || x.session_id === ses) && (!sem || x.semester_id === sem)); if (g) { gpa = g.gpa; cgpa = g.cgpa; units = g.units; courses = g.courses.length; sesName = g.session || ''; semName = g.semester || ''; } }
    const stand = (x) => { x = Number(x) || 0; return x >= 4.5 ? 'First Class' : x >= 3.5 ? 'Second Class (Upper)' : x >= 2.4 ? 'Second Class (Lower)' : x >= 1.5 ? 'Third Class' : x >= 1 ? 'Pass' : '—'; };
    return {
      valid: true, kind: 'result', ref: String(s.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
      session: sesName, semester: semName, gpa: gpa, cgpa: cgpa, totalUnits: units, courses: courses, standing: stand(cgpa),
      student: { name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown', matric: s.matric_no || '—', photo: s.photo || '', faculty: nameOf('faculties', s.faculty_id) || '—', department: nameOf('departments', s.department_id) || '—', level: nameOf('levels', s.level_id) || '—', gender: s.gender || '—', status: s.status || 'active' },
    };
  }

  // ---- documents (printable HTML) ----
  function inst() { return institution ? institution() : { name: 'UniBursar', short: 'UBU', logo: '', motto: '' }; }
  function docShell(title, body, watermark, opts) {
    const i = inst();
    const fit = opts && opts.fit ? 'true' : 'false';
    const wm = watermark ? `<div class="wm"><span>${esc(watermark)}</span></div>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;margin:0;padding:24px;font-size:13px;background:#f1f5f9;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .sheet{position:relative;overflow:hidden;max-width:820px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:26px;box-shadow:0 8px 30px rgba(15,23,42,.08)}
    .wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:6}
    .wm span{font-size:62px;font-weight:900;color:rgba(30,58,138,.12);transform:rotate(-28deg);letter-spacing:9px;white-space:nowrap;border:7px solid rgba(30,58,138,.12);padding:12px 34px;border-radius:14px}
    .head{display:flex;align-items:center;gap:12px;border-bottom:3px solid #1e3a8a;padding-bottom:14px;margin-bottom:18px}
    .head .logo{width:50px;height:50px;object-fit:contain;border-radius:8px}
    .head .mono{width:50px;height:50px;border-radius:10px;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800}
    .head h1{margin:0;font-size:18px;color:#111827}.head .t{margin-left:auto;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#1e3a8a}
    table{width:100%;border-collapse:collapse;margin:10px 0}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef2f7}
    th{background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#64748b}
    .r{text-align:right}.bar{background:#1e3a8a;color:#fff;padding:6px 12px;border-radius:6px;font-weight:700;text-transform:uppercase;font-size:11px;margin:16px 0 6px}
    .tot{font-size:16px;font-weight:800;color:#065f46;text-align:right;margin-top:6px}.words{font-style:italic;font-weight:700}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px}.grid .f span{color:#64748b;font-size:11px;display:block}.grid .f b{font-size:13px}
    .pbar{margin:16px 0;text-align:center}.pbar button{background:#1e3a8a;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer}
    @media print{.pbar{display:none}body{background:#fff;padding:0}.sheet{box-shadow:none;border:0}}
    .neg{color:#b91c1c}.pos{color:#065f46}.photo{width:84px;height:96px;object-fit:cover;border:1.5px solid #1e3a8a;border-radius:6px;float:right}</style></head>
    <body><div class="pbar"><button onclick="window.print()">⬇️ Download PDF / Print</button></div>
    <div class="sheet">${wm}<div class="head">${i.logo ? `<img class="logo" src="${i.logo}">` : `<div class="mono">${esc((i.short || 'U').slice(0, 3))}</div>`}<h1>${esc(i.name)}</h1><div class="t">${esc(title)}</div></div>${body}</div>
    <script>(function(){var FIT=${fit};function fit(){if(!FIT)return;var sh=document.querySelector('.sheet');if(!sh)return;sh.style.zoom='';var maxH=1040;var hgt=sh.scrollHeight;if(hgt>maxH){sh.style.zoom=Math.max(0.35,(maxH/hgt));}}var done=false;function go(){if(done)return;done=true;fit();try{window.focus();window.print();}catch(e){}}window.addEventListener('load',function(){setTimeout(go,450);});window.addEventListener('beforeprint',fit);window.addEventListener('resize',fit);})();</script>
    </body></html>`;
  }

  function receiptHTML(p) {
    const s = one('students', p.student_id) || {};
    const cur = p.currency;
    const issuer = one('users', p.decided_by) || one('users', p.raised_by) || {};
    // issuing office = who COMPLETED it (decided_by) — a registrar-raised, accountant-verified
    // payment is issued by the Bursar, not the registrar.
    const office = officeOf(issuer.role || p.raised_role, issuer.department_id || s.department_id);
    const receivedBy = issuer.full_name || office;
    // the line DESCRIPTION is the FEE paid for (category), NOT the narration
    const catRow = all('fee_categories').find(c => c.key === p.category && !c.deleted);
    const feeLabel = (catRow && catRow.name) || (p.category ? p.category[0].toUpperCase() + p.category.slice(1).replace(/_/g, ' ') + ' Fee' : 'Fee');
    // scannable verification QR → opens this hub's /verify page (same as the desktop receipt)
    const verifyUrl = (docBase ? docBase : '') + '/verify?r=' + p.id;
    const qrSvg = verifyQrSvg(verifyUrl);
    // SCOPE to the issuing office (mirrors the desktop): admin/accountant = full account;
    // any other office's receipt reflects only that office's fees/collections.
    const officeRole = ['admin', 'accountant'].includes(p.raised_role) ? null : p.raised_role;
    const officeUsers = officeRole ? new Set(all('users').filter(u => u.role === officeRole).map(u => u.id)) : null;
    const myCharge = (c) => !officeUsers || officeUsers.has(c.created_by);
    const myPay = (x) => !officeRole || x.raised_role === officeRole || (officeUsers && (officeUsers.has(x.raised_by) || officeUsers.has(x.decided_by)));
    const billedCat = studentCharges(p.student_id).filter(c => c.category === p.category && c.currency === cur && myCharge(c)).reduce((a, c) => a + c.amount, 0);
    const paidCat = studentPaymentsCompleted(p.student_id).filter(x => x.category === p.category && x.currency === cur && myPay(x)).reduce((a, x) => a + x.amount, 0);
    const lineRate = billedCat > 0 ? billedCat : p.amount;
    const chargesCur = studentCharges(p.student_id).filter(c => c.currency === cur && myCharge(c)).reduce((a, c) => a + c.amount, 0);
    const paidCur = studentPaymentsCompleted(p.student_id).filter(x => x.currency === cur && myPay(x)).reduce((a, x) => a + x.amount, 0);
    const newBal = chargesCur - paidCur; const prevBal = newBal + p.amount;
    const f = (l1, v1, l2, v2) => `<tr><td style="color:#64748b">${l1}</td><td><b>${esc(v1 || '—')}</b></td><td style="color:#64748b">${l2}</td><td><b>${esc(v2 || '—')}</b></td></tr>`;
    const body = `${s.photo ? `<img class="photo" src="${s.photo}">` : ''}
      <div class="grid" style="margin-bottom:8px"><div class="f"><span>Receipt No</span><b>${esc(p.receipt_no || '—')}</b></div><div class="f"><span>Issued By</span><b>${esc(office)}</b></div>
        <div class="f"><span>Date</span><b>${fmtDate(p.decided_at || p.created_at)}</b></div><div class="f"><span>Method</span><b>${esc(String(p.channel || p.method || 'cash').toUpperCase())}</b></div></div>
      <div class="bar">Student Details</div>
      <table><tbody>
        ${f("Student", `${s.first_name || ''} ${s.last_name || ''}`, 'Matric No', s.matric_no)}
        ${f('Faculty', nameOf('faculties', s.faculty_id), 'Department', nameOf('departments', s.department_id))}
        ${f('Level', nameOf('levels', s.level_id), 'Received By', receivedBy)}
      </tbody></table>
      <div class="bar">Payment Details</div>
      <table><tbody>${f('Narration', p.narration || '—', 'Currency', cur)}</tbody></table>
      <div class="bar">Payment Breakdown</div>
      <table><thead><tr><th>Description</th><th class="r">Amount (${esc(cur)})</th><th class="r">Paid Now</th><th class="r">Balance After</th></tr></thead>
        <tbody><tr><td>${esc(feeLabel)}</td><td class="r">${money(lineRate, cur)}</td><td class="r"><b>${money(p.amount, cur)}</b></td><td class="r">${money(lineRate - paidCat, cur)}</td></tr></tbody></table>
      <div class="tot">TOTAL PAID: ${money(p.amount, cur)}</div>
      <div class="bar">Payment Summary</div>
      <table><tbody>
        <tr><td style="color:#64748b">Amount In Words</td><td class="words" colspan="3">${esc(amountWords(p.amount, cur))}</td></tr>
        ${f('Previous Net Balance', money(prevBal, cur), 'New Net Balance', money(newBal, cur))}
      </tbody></table>
      <div class="bar">Authenticity</div>
      <div style="display:flex;align-items:center;gap:14px;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 14px;margin-top:8px">
        ${qrSvg ? `<div style="width:104px;height:104px;flex:none">${qrSvg}</div>` : ''}
        <div style="font-size:11.5px;color:#475569;line-height:1.5">Scan to verify this receipt is genuine.<br>Verification ref <b style="letter-spacing:1px;color:#111827">${esc(String(p.id).replace(/-/g, '').slice(0, 8).toUpperCase())}</b><br>or visit <a href="${esc(verifyUrl)}">${esc((docBase || '') + '/verify')}</a></div>
      </div>
      <p style="margin-top:18px;color:#64748b;font-size:11px">Received by ${esc(receivedBy)} (${esc(office)}) • Student copy of a computer-generated receipt; it mirrors the official receipt issued in the office. Anyone can confirm it is genuine by scanning the QR above.</p>`;
    return docShell('Payment Receipt', body, 'STUDENT COPY');
  }

  function statementHTML(s) {
    const charges = studentCharges(s.id).map(c => ({ kind: 'charge', date: c.created_at, desc: c.description || c.category, currency: c.currency, debit: c.amount < 0 ? 0 : c.amount, credit: c.amount < 0 ? -c.amount : 0 }));
    const pays = studentPaymentsCompleted(s.id).map(p => ({ kind: 'payment', date: p.decided_at || p.created_at, desc: (p.description || p.category) + (p.receipt_no ? ` (${p.receipt_no})` : ''), currency: p.currency, debit: 0, credit: p.amount }));
    const entries = [...charges, ...pays].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const running = {}; const rows = entries.map(e => { running[e.currency] = (running[e.currency] || 0) + (e.debit - e.credit); return `<tr><td>${fmtDate(e.date)}</td><td>${e.kind === 'payment' ? '💰 ' : '📌 '}${esc(e.desc)}</td><td class="r">${e.debit ? money(e.debit, e.currency) : ''}</td><td class="r">${e.credit ? money(e.credit, e.currency) : ''}</td><td class="r ${running[e.currency] > 0 ? 'neg' : 'pos'}">${money(running[e.currency], e.currency)}</td></tr>`; }).join('');
    const bal = balancesFor(s.id); const balStr = Object.keys(bal).length ? Object.entries(bal).map(([c, v]) => money(v, c)).join(' • ') : money(0);
    const body = `<div class="grid" style="margin-bottom:8px"><div class="f"><span>Student</span><b>${esc(`${s.first_name || ''} ${s.last_name || ''}`)}</b></div><div class="f"><span>Matric</span><b>${esc(s.matric_no || '—')}</b></div>
      <div class="f"><span>Department</span><b>${esc(nameOf('departments', s.department_id) || '—')}</b></div><div class="f"><span>Outstanding</span><b class="neg">${balStr}</b></div></div>
      <div class="bar">Full Statement — All Fees & Payments</div>
      <table><thead><tr><th>Date</th><th>Description</th><th class="r">Debit (Fee)</th><th class="r">Credit (Paid)</th><th class="r">Balance</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No ledger entries.</td></tr>'}</tbody></table>`;
    return docShell('Student Financial Statement', body);
  }

  // Student statement of result (PDF via the browser print dialog) — mirrors the desktop slip.
  function resultSlipHTML(s, filter) {
    const sc = scoresFor(s.id);
    let sems = sc.semesters || [];
    let focused = null;
    if (filter && (filter.session || filter.semester)) {
      focused = sems.find(g => (!filter.session || g.session_id === filter.session) && (!filter.semester || g.semester_id === filter.semester));
      if (focused) sems = [focused];
    }
    const stand = (g) => { const x = Number(g) || 0; return x >= 4.5 ? 'First Class' : x >= 3.5 ? 'Second Class (Upper)' : x >= 2.4 ? 'Second Class (Lower)' : x >= 1.5 ? 'Third Class' : x >= 1 ? 'Pass' : '—'; };
    const cgpa = focused ? focused.cgpa : sc.cgpa;
    const photo = s.photo ? `<img class="photo" src="${s.photo}">` : '';
    const infoRows = [
      ['Matric Number', s.matric_no || '—'],
      ['Full Name', `${s.first_name || ''} ${s.last_name || ''}`.trim()],
      ['Faculty', nameOf('faculties', s.faculty_id) || '—'],
      ['Department', nameOf('departments', s.department_id) || '—'],
      ['Level', nameOf('levels', s.level_id) || '—'],
      ['Gender', s.gender || '—'],
    ];
    if (focused) { infoRows.push(['Session / Semester', `${focused.session || '—'} · ${focused.semester || '—'}`]); }
    // GPA / CGPA / Class Standing are shown at the BOTTOM of the sheet, not here.
    const infoTable = `<table class="info"><tbody>${infoRows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</tbody></table>`;
    const semBlocks = sems.map(g => {
      return `<div class="bar">${esc(g.semester || 'Semester')} · ${esc(g.session || '—')} &nbsp;—&nbsp; GPA ${esc(g.gpa)} · CGPA ${esc(g.cgpa)} · ${esc(g.units)} units</div>
        <table class="ctbl"><thead><tr><th class="c">#</th><th>CODE</th><th>COURSE TITLE</th><th class="c">CH</th><th class="c">TEST</th><th class="c">EXAM</th><th class="c">SCORE</th><th class="c">GRD</th><th class="c">CO</th></tr></thead><tbody>${(g.courses || []).map((r, i) => `<tr><td class="c">${i + 1}</td><td class="mono">${esc(r.course_code || '—')}</td><td>${esc(r.course_title || '—')}</td><td class="c">${esc(r.credit_unit)}</td><td class="c">${r.test_score == null ? '–' : esc(r.test_score)}</td><td class="c">${r.exam_score == null ? '–' : esc(r.exam_score)}</td><td class="c"><b>${r.score == null ? '–' : esc(r.score)}</b></td><td class="c"><b>${esc(r.grade || '–')}</b></td><td class="c">${r.co == null ? '–' : esc(r.co)}</td></tr>`).join('') || '<tr><td colspan="9" class="c" style="color:#94a3b8">No courses</td></tr>'}</tbody></table>`;
    }).join('') || '<p style="color:#94a3b8">No published results yet.</p>';
    // verification QR → public /verify page (no login) showing the student + GPA/CGPA
    const vurl = (docBase || '') + '/verify?res=' + s.id + (focused ? ('&ses=' + (focused.session_id || '') + '&sem=' + (focused.semester_id || '')) : '');
    const qr = verifyQrSvg(vurl);
    const ref = String(s.id).replace(/-/g, '').slice(0, 8).toUpperCase();
    const legend = `<table class="gtbl"><thead><tr><th colspan="3">GRADING SYSTEM</th></tr></thead><tbody>
      <tr><td>70–100</td><td class="c"><b>A</b></td><td class="c">5</td></tr><tr><td>60–69</td><td class="c"><b>B</b></td><td class="c">4</td></tr><tr><td>50–59</td><td class="c"><b>C</b></td><td class="c">3</td></tr>
      <tr><td>45–49</td><td class="c"><b>D</b></td><td class="c">2</td></tr><tr><td>40–44</td><td class="c"><b>E</b></td><td class="c">1</td></tr><tr><td>0–39</td><td class="c"><b>F</b></td><td class="c">0</td></tr></tbody></table>
      <div class="note">CH = Credit Unit · CO = Grade Point × CH · GPA = Σ CO ÷ Σ CH (semester) · CGPA = cumulative GPA.</div>`;
    // Only the QR is visible — the verify URL is kept in an invisible HTML comment (for tooling).
    const authBox = `<div class="auth">${qr ? `<div class="qr">${qr}</div>` : ''}<div class="amt">Scan to<br>verify result</div></div><!--verify ${esc(vurl)} ref ${esc(ref)}-->`;
    const summary = `<div class="summary">${focused ? `<div class="lab">Semester GPA</div><div class="mid">${esc(focused.gpa)}</div>` : ''}<div class="lab">Cumulative GPA (CGPA)</div><div class="big">${esc(cgpa)}</div><div class="lab">${esc(sc.totalUnits)} total credit units</div><div class="st">${esc(stand(cgpa))}</div></div>`;
    const sig = `<div class="sig"><div><div class="ln">Registrar / Examinations Officer</div></div><div><div class="ln" style="border-top-style:dashed">Official Stamp</div></div></div>`;
    const css = `<style>
      .sheet{font-size:11px}
      .info{width:100%;border-collapse:collapse;margin:3px 0}
      .info td{border:1px solid #d8dee9;padding:4px 9px;font-size:11.5px}
      .info td.k{background:#f1f5f9;font-weight:700;color:#334155;width:190px;text-transform:uppercase;font-size:9.5px;letter-spacing:.3px}
      .bar{margin:12px 0 4px;font-size:10.5px;padding:5px 10px}
      table.ctbl{width:100%;border-collapse:collapse;margin:0 0 4px}
      table.ctbl th{background:#eef2ff;border:1px solid #c7d2fe;padding:4px 6px;font-size:9px;text-transform:uppercase;letter-spacing:.2px;color:#1e3a8a;text-align:left}
      table.ctbl td{border:1px solid #d8dee9;padding:4px 6px;font-size:10.5px}
      .mono{font-family:Consolas,monospace;font-weight:700}.c{text-align:center}
      .foot{margin-top:14px;display:flex;gap:14px;align-items:flex-start;justify-content:space-between}
      table.gtbl{border-collapse:collapse;width:170px}
      table.gtbl th{background:#1e3a8a;color:#fff;padding:3px;font-size:9px;letter-spacing:1px}
      table.gtbl td{border:1px solid #d1d5db;padding:1px 8px;font-size:9px}
      .note{margin-top:5px;color:#64748b;font-size:8.5px;max-width:190px}
      .auth{display:flex;gap:8px;align-items:center}
      .auth .qr{width:84px;height:84px;flex:none}
      .auth .amt{font-size:9.5px;color:#475569;line-height:1.4}
      .auth .vurl{font-size:7.5px;color:#94a3b8;word-break:break-all}
      .summary{text-align:right;min-width:140px}
      .summary .lab{font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;margin-top:4px}
      .summary .mid{font-size:17px;font-weight:800;color:#334155;line-height:1.05}
      .summary .big{font-size:26px;font-weight:800;color:#1e3a8a;line-height:1}
      .summary .st{display:inline-block;margin-top:4px;padding:3px 11px;border-radius:999px;background:#dcfce7;color:#166534;font-weight:700;font-size:10px}
      .sig{margin-top:22px;display:flex;justify-content:space-between}.sig div{width:42%;text-align:center}
      .sig .ln{border-top:1.5px solid #475569;padding-top:4px;color:#334155;font-size:10px;font-weight:600}
      @media print{@page{size:A4;margin:10mm}}
    </style>`;
    const body = `${photo}<div class="bar">Students Information</div>${infoTable}${semBlocks}<div class="foot">${legend}${authBox}${summary}</div>${sig}${css}`;
    return docShell('Statement of Result', body, null, { fit: true });
  }

  function payslipHTML(slip) {
    const run = one('payroll_runs', slip.run_id) || {}; const s = one('staff', slip.staff_id) || {};
    const cur = slip.currency || s.currency;
    const isLect = s.staff_type === 'lecturer';
    const wmText = isLect ? 'LECTURER PAYROLL' : 'STAFF PAYROLL';
    const psVerifyUrl = (docBase || '') + '/verify?p=' + slip.id;
    const psQr = verifyQrSvg(psVerifyUrl);
    const f = (l, v) => `<tr><td style="color:#64748b">${l}</td><td class="r"><b>${v}</b></td></tr>`;
    const body = `${s.photo ? `<img class="photo" src="${s.photo}">` : ''}
      <div class="grid" style="margin-bottom:8px"><div class="f"><span>Name</span><b>${esc(s.full_name)}</b></div><div class="f"><span>Staff No</span><b>${esc(s.staff_no || '—')}</b></div>
        <div class="f"><span>Type</span><b>${esc(s.staff_type === 'lecturer' ? 'Lecturer' : 'Staff')}</b></div><div class="f"><span>Period</span><b>${esc(run.period || '—')}</b></div>
        <div class="f"><span>Department</span><b>${esc(s.department || s.faculty || '—')}</b></div><div class="f"><span>Status</span><b>${esc(run.status || '—')}</b></div></div>
      <div class="bar">Earnings & Deductions</div>
      <table><tbody>
        ${f('Gross / Base', money(slip.gross, cur))}
        ${f('Allowances', money(slip.allowances, cur))}
        ${f('Bonus', money(slip.bonus, cur))}
        ${f('Deductions', money(slip.deductions, cur))}
        ${f('Loan / IOU Deduction', money(slip.loan_deduction, cur))}
      </tbody></table>
      <div class="tot">NET PAY: ${money(slip.net, cur)}</div>
      <p style="margin-top:8px" class="words">${esc(amountWords(slip.net, cur))}</p>
      <div class="bar">Authenticity</div>
      <div style="display:flex;align-items:center;gap:14px;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 14px;margin-top:8px">
        ${psQr ? `<div style="width:104px;height:104px;flex:none">${psQr}</div>` : ''}
        <div style="font-size:11.5px;color:#475569;line-height:1.5">Scan to verify this payslip is genuine.<br>Verification ref <b style="letter-spacing:1px;color:#111827">${esc(String(slip.id).replace(/-/g, '').slice(0, 8).toUpperCase())}</b><br>or visit <a href="${esc(psVerifyUrl)}">${esc((docBase || '') + '/verify')}</a></div>
      </div>`;
    return docShell((s.staff_type === 'lecturer' ? 'Lecturer' : 'Staff') + ' Payslip', body, wmText);
  }

  /** Printable examination-clearance certificate for the student (portal) — mirrors the
   *  desktop one, with a scannable QR (name, photo, department, level on the verify page). */
  function clearanceCertHTML(clearanceId) {
    const v = verifyClearance(clearanceId);
    const typeName = (v && v.typeName) || 'Examination';
    if (!v.valid) return docShell(typeName + ' Clearance', '<div class="empty" style="padding:30px;text-align:center">Clearance not found.</div>');
    const st = v.student;
    const isMid = v.clearanceType === 'midterm';
    const verifyUrl = (docBase || '') + '/verify?c=' + clearanceId;
    const qr = verifyQrSvg(verifyUrl);
    const apps = (v.approvals || []).map(a => `<tr><td>${esc(({ registrar: 'Registrar', dean: 'Faculty Head (Dean)', student_affairs: 'Student Affairs' })[a.office] || a.office)}</td><td><b style="color:${a.status === 'approved' ? '#166534' : a.status === 'denied' ? '#991b1b' : '#92400e'}">${esc(String(a.status || 'pending').toUpperCase())}</b></td><td>${esc(a.by || '—')}</td></tr>`).join('');
    const ok = v.completed;
    const okText = isMid ? '✓ CLEARED FOR MID-SEMESTER TESTS' : '✓ CLEARED FOR EXAMINATIONS';
    const body = `${st.photo ? `<img class="photo" src="${st.photo}">` : ''}
      <div class="exbar ${ok ? '' : ''}" style="background:${ok ? '#dcfce7' : '#fef9c3'};color:${ok ? '#166534' : '#854d0e'};border-radius:10px;padding:12px;text-align:center;font-weight:800;font-size:16px;margin-bottom:12px">${ok ? okText : '⚠ ' + esc(String(v.status || 'pending').toUpperCase())}</div>
      <div class="grid" style="margin-bottom:8px"><div class="f"><span>Student</span><b>${esc(st.name)}</b></div><div class="f"><span>Matric No</span><b>${esc(st.matric)}</b></div>
        <div class="f"><span>Faculty</span><b>${esc(st.faculty)}</b></div><div class="f"><span>Department</span><b>${esc(st.department)}</b></div>
        <div class="f"><span>Level</span><b>${esc(st.level)}</b></div><div class="f"><span>Clearance Type</span><b>${esc(typeName)} Clearance</b></div>
        <div class="f"><span>Session</span><b>${esc(v.session)} • ${esc(v.semester)}</b></div></div>
      <div class="bar">Office Approvals</div>
      <table><thead><tr><th>Office</th><th>Status</th><th>Approved By</th></tr></thead><tbody>${apps || '<tr><td colspan="3">—</td></tr>'}</tbody></table>
      <div class="bar">Authenticity</div>
      <div style="display:flex;align-items:center;gap:14px;border:1px dashed #cbd5e1;border-radius:10px;padding:12px 14px;margin-top:8px">
        ${qr ? `<div style="width:104px;height:104px;flex:none">${qr}</div>` : ''}
        <div style="font-size:11.5px;color:#475569;line-height:1.5">Scan to verify this clearance — shows the student's name, photo, department & level.<br>Verification ref <b style="letter-spacing:1px;color:#111827">${esc(v.ref)}</b></div>
      </div>
      <p style="margin-top:18px;color:#64748b;font-size:11px">Student copy of a computer-generated ${esc(typeName.toLowerCase())} clearance. Anyone can confirm it is genuine by scanning the QR above.</p>`;
    return docShell(typeName + ' Clearance', body, 'STUDENT COPY');
  }

  /** Resolve a published timetable + the slots that apply to THIS student (cohort-scoped),
   *  mirroring the dashboard's myTimetables logic. Returns null if the student is out of scope. */
  function studentTimetable(t, s) {
    if (!t || t.deleted || t.status !== 'published') return null;
    const inScope = t.scope === 'faculty' ? t.faculty_id === s.faculty_id
      : (t.department_id === s.department_id && (!t.level_id || t.level_id === s.level_id));
    if (!inScope) return null;
    let slots = all('timetable_slots').filter(sl => sl.timetable_id === t.id && !sl.deleted);
    if (t.scope === 'faculty') slots = slots.filter(sl => sl.kind === 'holiday' || (sl.department_id === s.department_id && (!sl.level_id || sl.level_id === s.level_id)));
    return { t, slots };
  }
  const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  /** Clean, downloadable TABULAR timetable for the student portal. Lectures render as a
   *  days × time grid (the familiar timetable layout); exams/tests as a chronological table. */
  function timetableHTML(t, slots) {
    const ttName = t.type === 'lecture' ? 'Lecture Timetable' : t.type === 'midsemester' ? 'Mid-Semester Test Timetable' : 'Examination Timetable';
    const meta = [['Department', nameOf('departments', t.department_id)], ['Faculty', nameOf('faculties', t.faculty_id)], ['Level', nameOf('levels', t.level_id)], ['Session', nameOf('academic_sessions', t.session_id)], ['Semester', nameOf('semesters', t.semester_id)]]
      .filter(x => x[1]).map(x => `<div class="f"><span>${esc(x[0])}</span><b>${esc(x[1])}</b></div>`).join('');
    const classes = (slots || []).filter(s => s.kind !== 'holiday');
    const holidays = (slots || []).filter(s => s.kind === 'holiday');
    const timeLabel = (s) => esc((s.start_time || '') + (s.end_time ? '–' + s.end_time : ''));
    const courseCell = (s) => `<b>${esc(s.course_code || '')}</b>${s.course_title ? '<br><span style="font-size:10.5px;color:#475569">' + esc(s.course_title) + '</span>' : ''}${s.venue ? '<br><span style="font-size:10px;color:#64748b">📍 ' + esc(s.venue) + '</span>' : ''}${s.lecturer_name ? '<br><span style="font-size:10px;color:#64748b">👤 ' + esc(s.lecturer_name) + '</span>' : ''}`;
    let bodyTable;
    if (t.type === 'lecture') {
      // build a days × time grid
      const days = []; for (const c of classes) { const d = String(c.day_or_date || '').trim(); if (d && !days.includes(d)) days.push(d); }
      days.sort((a, b) => (DAY_ORDER.indexOf(a.toLowerCase()) + 100) % 1000 - (DAY_ORDER.indexOf(b.toLowerCase()) + 100) % 1000 || a.localeCompare(b));
      const times = []; for (const c of classes) { const k = (c.start_time || '') + '|' + (c.end_time || ''); if (!times.find(x => x.k === k)) times.push({ k, start: c.start_time || '', end: c.end_time || '', label: timeLabel(c) }); }
      times.sort((a, b) => String(a.start).localeCompare(String(b.start)));
      if (!days.length || !times.length) {
        bodyTable = `<table><thead><tr><th>Day</th><th>Time</th><th>Course</th><th>Venue</th><th>Lecturer</th></tr></thead><tbody>${classes.map(s => `<tr><td>${esc(s.day_or_date || '—')}</td><td>${timeLabel(s) || '—'}</td><td><b>${esc(s.course_code || '')}</b> ${esc(s.course_title || '')}</td><td>${esc(s.venue || '—')}</td><td>${esc(s.lecturer_name || '—')}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#94a3b8">No classes scheduled.</td></tr>'}</tbody></table>`;
      } else {
        const head = `<tr><th style="background:#1e3a8a;color:#fff">Time</th>${days.map(d => `<th style="background:#1e3a8a;color:#fff">${esc(d)}</th>`).join('')}</tr>`;
        const rows = times.map(tm => {
          const cells = days.map(d => {
            const hit = classes.find(c => String(c.day_or_date || '').trim() === d && (c.start_time || '') === tm.start && (c.end_time || '') === tm.end);
            return `<td style="vertical-align:top">${hit ? courseCell(hit) : '<span style="color:#cbd5e1">—</span>'}</td>`;
          }).join('');
          return `<tr><td style="font-weight:700;white-space:nowrap;background:#f8fafc">${tm.label || '—'}</td>${cells}</tr>`;
        }).join('');
        bodyTable = `<table style="table-layout:fixed">${head}${rows}</table>`;
      }
    } else {
      const sorted = classes.slice().sort((a, b) => String(a.day_or_date || '').localeCompare(String(b.day_or_date || '')) || String(a.start_time || '').localeCompare(String(b.start_time || '')));
      bodyTable = `<table><thead><tr><th>Date</th><th>Time</th><th>Course</th><th>Venue</th><th>Invigilator</th></tr></thead><tbody>${sorted.map(s => `<tr><td>${esc(s.day_or_date || '—')}</td><td>${timeLabel(s) || '—'}</td><td><b>${esc(s.course_code || '')}</b> ${esc(s.course_title || '')}</td><td>${esc(s.venue || '—')}</td><td>${esc(s.lecturer_name || '—')}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#94a3b8">No sittings scheduled.</td></tr>'}</tbody></table>`;
    }
    const holHtml = holidays.length ? `<div class="bar">Breaks / Holidays</div><table><tbody>${holidays.map(h => `<tr><td>${esc(h.day_or_date || '—')}</td><td>${esc(h.course_title || h.venue || 'Holiday / Break')}</td></tr>`).join('')}</tbody></table>` : '';
    const body = `<div class="grid" style="margin-bottom:6px">${meta}</div>
      <div class="bar">${esc(t.title || ttName)}</div>
      ${bodyTable}${holHtml}
      <p style="margin-top:14px;color:#64748b;font-size:11px">Computer-generated ${esc(ttName.toLowerCase())} from ${esc(inst().name)}. Times are shown in the institution's local time.</p>`;
    return docShell(t.title || ttName, body, null, { fit: true });
  }

  function moneyMapHTML(m) { const e = Object.entries(m || {}); return e.length ? e.map(([c, v]) => money(v, c)).join(' · ') : money(0); }
  function officerReportHTML(data, periodLabel) {
    const ROLE = { finance: 'Bursary / Administration', registrar: data.role === 'student_affairs' ? 'Student Affairs' : 'Registrar', dean: 'Faculty Head', affairs: 'Student Affairs' };
    let body = `<div class="grid"><div class="f"><span>Officer</span><b>${esc(data.profile.full_name)}</b></div><div class="f"><span>Role</span><b>${esc(data.role)}</b></div><div class="f"><span>Period</span><b>${esc(periodLabel || 'All time')}</b></div><div class="f"><span>Generated</span><b>${fmtDate(new Date().toISOString())}</b></div></div>`;
    if (data.kind === 'finance') {
      body += `<div class="bar">Summary (per currency)</div><table><tbody><tr><td>Collected</td><td class="r">${moneyMapHTML(data.cards.collected)}</td></tr><tr><td>Billed</td><td class="r">${moneyMapHTML(data.cards.billed)}</td></tr><tr><td>Expenses</td><td class="r">${moneyMapHTML(data.cards.expenses)}</td></tr><tr><td>Students</td><td class="r">${data.cards.students}</td></tr><tr><td>Debtors</td><td class="r">${data.cards.debtors}</td></tr></tbody></table>`;
      body += `<div class="bar">Recent Payments</div><table><thead><tr><th>Receipt</th><th>Student</th><th>For</th><th>Date</th><th class="r">Amount</th></tr></thead><tbody>${(data.recent || []).map(p => `<tr><td>${esc(p.receipt_no || '—')}</td><td>${esc(p.student)}</td><td>${esc(p.category)}</td><td>${fmtDate(p.date)}</td><td class="r">${money(p.amount, p.currency)}</td></tr>`).join('') || '<tr><td colspan=5>No payments.</td></tr>'}</tbody></table>`;
    } else if (data.kind === 'registrar') {
      body += `<div class="bar">My Collections</div><div class="tot">${moneyMapHTML(data.collected)}</div>`;
      body += `<div class="bar">Students I Billed</div><table><thead><tr><th>Name</th><th>Matric</th><th class="r">Paid</th><th class="r">Owing</th></tr></thead><tbody>${(data.students || []).map(r => `<tr><td>${esc(r.full_name)}</td><td>${esc(r.matric_no || '—')}</td><td class="r">${moneyMapHTML(r.paid)}</td><td class="r neg">${moneyMapHTML(r.owing)}</td></tr>`).join('') || '<tr><td colspan=4>None.</td></tr>'}</tbody></table>`;
    } else if (data.kind === 'dean') {
      body += `<div class="bar">Faculty Collections / Expenditure</div><table><tbody><tr><td>Collected</td><td class="r">${moneyMapHTML(data.collected)}</td></tr><tr><td>Expenditure</td><td class="r">${moneyMapHTML(data.expenses)}</td></tr></tbody></table>`;
      body += `<div class="bar">Students Owing Faculty Fees</div><table><thead><tr><th>Name</th><th>Matric</th><th class="r">Owing</th></tr></thead><tbody>${(data.debtors || []).map(r => `<tr><td>${esc(r.full_name)}</td><td>${esc(r.matric_no || '—')}</td><td class="r neg">${moneyMapHTML(r.owing)}</td></tr>`).join('') || '<tr><td colspan=3>None.</td></tr>'}</tbody></table>`;
    }
    return docShell((ROLE[data.kind] || 'Officer') + ' Report', body);
  }

  // ---------------------------- HTTP ----------------------------
  function J(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(b); return true; }
  function H(res, code, html) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return true; }
  function S(res, code, body, type) { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }); res.end(body); return true; }
  function rawBearer(req, u) { const hdr = req.headers['authorization'] || ''; const b = /^Bearer\s+(.+)$/i.exec(hdr); return (b && b[1]) || u.searchParams.get('t') || ''; }
  function authOf(req, u) { return verifyToken(rawBearer(req, u)); }
  // Exam-monitor caller = a portal OFFICER (user) OR the trusted desktop sync node presenting the
  // sync token (so an officer needn't have a separate portal login to monitor exams).
  function isExamOfficer(req, u) {
    const t = authOf(req, u); if (t && t.k === 'user') return t;
    const raw = rawBearer(req, u); if (raw && secret && raw === secret) return { k: 'sync', role: 'officer', id: 'sync' };
    return null;
  }

  // ---------------------------------------------------------------------------
  // ONLINE ADMISSIONS — public application portal (/apply). Applicants are NOT accounts; they
  // authenticate with a temporary pass (application number + passcode) which mints a short-lived
  // 'applicant' token. Applications are WRITTEN here via the create/update hooks and sync to the
  // registrar's desktop. Payment rails (Paystack secret / bank details) are read from server env —
  // the FEE AMOUNT itself rides on the synced application (set by the registrar's Offer).
  function genAppNo() {
    const short = String(inst().short || 'WAUU').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'WAUU';
    const seq = all('admission_applications').length + 1;
    return `${short}/APP/${new Date().getFullYear()}/${String(seq).padStart(5, '0')}`;
  }
  const genPasscode = () => crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
  const applicantToken = (id) => sign({ k: 'applicant', id, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }); // 30-day temp pass
  function applicantFrom(req, u) { const t = authOf(req, u); if (!t || t.k !== 'applicant') return null; const a = one('admission_applications', t.id); return (a && !a.deleted) ? a : null; }
  function appPublic(a) {
    if (!a) return null;
    const docs = all('admission_documents').filter(d => d.application_id === a.id && !d.deleted).map(d => ({ id: d.id, kind: d.kind, filename: d.filename, uploaded_at: d.uploaded_at }));
    const { passcode_hash, ...rest } = a; // never expose the passcode hash to the client
    return Object.assign(rest, { department_name: nameOf('departments', a.department_id), faculty_name: nameOf('faculties', a.faculty_id), level_name: nameOf('levels', a.level_id), documents: docs });
  }
  function programmesPayload() {
    const faculties = all('faculties').filter(f => !f.deleted);
    const departments = all('departments').filter(d => !d.deleted);
    const levels = all('levels').filter(l => !l.deleted).sort((a, b) => (a.rank || 0) - (b.rank || 0)).map(l => ({ id: l.id, name: l.name }));
    const grouped = faculties.map(f => ({ id: f.id, name: f.name, departments: departments.filter(d => d.faculty_id === f.id).map(d => ({ id: d.id, name: d.name })) })).filter(f => f.departments.length);
    const orphans = departments.filter(d => !faculties.some(f => f.id === d.faculty_id));
    if (orphans.length) grouped.push({ id: '_other', name: 'Other Programmes', departments: orphans.map(d => ({ id: d.id, name: d.name })) });
    return { faculties: grouped, levels, open: (String(process.env.ADMISSIONS_OPEN || '1') !== '0') };
  }
  // minimal Paystack client (optional — only used when PAYSTACK_SECRET is set in the server env)
  function paystackReq(pathName, method, payload) {
    return new Promise((resolve) => {
      try {
        const https = require('https');
        const data = payload ? JSON.stringify(payload) : null;
        const r = https.request({ hostname: 'api.paystack.co', path: pathName, method, headers: Object.assign({ Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET, 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (resp) => {
          let b = ''; resp.on('data', d => b += d); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
        });
        r.on('error', () => resolve(null));
        if (data) r.write(data); r.end();
      } catch (_) { resolve(null); }
    });
  }

  async function handle(req, res, u, method, readBody) {
    const p = u.pathname.replace(/\/+$/, '') || '/';
    docBase = buildBase(req); // so any document we render this request can build absolute verify URLs

    if (p === '/' && method === 'GET') { H(res, 200, PAGE); return true; }
    // Live class room (Jitsi). The room id is a secret capability shown only to the cohort + lecturer.
    if (method === 'GET' && p.startsWith('/class/')) {
      const room = p.slice('/class/'.length);
      return H(res, 200, classPageHTML(room, u.searchParams.get('n') || 'Guest', u.searchParams.get('s') || 'Live Class', u.searchParams.get('host') === '1'));
    }
    // E-library: read online (in-app pdf.js viewer), stream the file, or download. Student-scoped.
    if (method === 'GET' && p.startsWith('/library/')) {
      const t = authOf(req, u); if (!t) return H(res, 401, '<p>Session expired. Please sign in again.</p>');
      const parts = p.split('/'); const action = parts[2]; const id = parts[3];
      const s = (t.k === 'student' || t.k === 'parent') ? (one('students', t.id)) : null;
      const book = id ? one('library_books', id) : null;
      if (!book || book.deleted) return H(res, 404, '<p>Book not found.</p>');
      if (s && !libraryVisibleTo(book, s)) return H(res, 403, '<p>This book is not available to you.</p>');
      if (action === 'read') return H(res, 200, libraryReaderHTML(book, u.searchParams.get('t') || ''));
      if (action === 'file' || action === 'download') {
        if (!book.file) return H(res, 404, '<p>This book has no file.</p>');
        const buf = Buffer.from(book.file, 'base64');
        const disp = action === 'download' ? 'attachment' : 'inline';
        res.writeHead(200, { 'Content-Type': book.mime || 'application/octet-stream', 'Content-Disposition': disp + '; filename="' + String(book.filename || 'book').replace(/[\\/:*?"<>|]+/g, '-') + '"', 'Cache-Control': 'private, max-age=3600' });
        res.end(buf); return true;
      }
      return H(res, 404, '<p>Not found.</p>');
    }
    // Exam-conduct evidence: the flagged student downloads the video/audio/image clip that was
    // recorded — full transparency, so they can see exactly what was captured and appeal if wrong.
    if (method === 'GET' && p.startsWith('/surveillance/evidence/')) {
      const t = authOf(req, u); if (!t) return H(res, 401, '<p>Session expired. Please sign in again.</p>');
      const id = p.split('/')[3];
      const ev = id ? one('malpractice_evidence', id) : null;
      if (!ev || ev.deleted) return H(res, 404, '<p>Evidence not found.</p>');
      // a student may only fetch evidence attached to their OWN flag
      if ((t.k === 'student' || t.k === 'parent') && ev.student_id !== t.id) return H(res, 403, '<p>This evidence is not available to you.</p>');
      if (!ev.data) return H(res, 404, '<p>This evidence has no file.</p>');
      const dl = u.searchParams.get('dl') === '1';
      res.writeHead(200, { 'Content-Type': ev.mime || 'application/octet-stream', 'Content-Disposition': (dl ? 'attachment' : 'inline') + '; filename="' + String(ev.filename || 'evidence').replace(/[\\/:*?"<>|]+/g, '-') + '"', 'Cache-Control': 'private, max-age=3600' });
      res.end(Buffer.from(ev.data, 'base64')); return true;
    }
    if (p === '/api/version' && method === 'GET') { J(res, 200, { version: getVersion() }); return true; }
    // Is a live class still running? The (already-open) student class page polls this and auto-leaves the
    // moment the host ends it — otherwise the class kept running on the APK after the lecturer ended it.
    // `ended` is true only once a session for this room existed and is no longer active, so a scheduled
    // class a student opened with no host session is never force-closed. (Room id is a secret capability.)
    if (p === '/api/class-live' && method === 'GET') {
      const room = u.searchParams.get('room') || '';
      const now = Date.now();
      const liveCut = new Date(now - 3 * 60 * 60 * 1000).toISOString();
      const recentCut = new Date(now - 12 * 60 * 60 * 1000).toISOString();
      const rows = all('live_sessions').filter(v => !v.deleted && v.room === room && String(v.started_at || '') >= recentCut);
      const live = rows.some(v => v.active && String(v.started_at || '') >= liveCut);
      const ended = !live && rows.length > 0;
      return J(res, 200, { ok: true, live, ended });
    }
    if (p === '/api/branding' && method === 'GET') { const i = inst(); return J(res, 200, { ok: true, name: i.name, short: i.short, logo: i.logo, motto: i.motto }); }

    // ---- installable app assets + public clearance verification (no login) ----
    if (method === 'GET' && p === '/manifest.webmanifest') return S(res, 200, MANIFEST_PORTAL, 'application/manifest+json');
    if (method === 'GET' && p === '/scan-manifest.webmanifest') return S(res, 200, MANIFEST_SCAN, 'application/manifest+json');
    if (method === 'GET' && p === '/sw.js') return S(res, 200, SW_JS, 'application/javascript');
    // Favicon / app icon = the university LOGO (falls back to a branded monogram).
    const monogramSvg = () => { const i = inst(); const init = String(i.short || i.name || 'U').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'U';
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#4338ca"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="41" font-family="Segoe UI,Arial,sans-serif" font-size="${init.length > 2 ? 20 : 26}" font-weight="800" fill="#fff" text-anchor="middle">${esc(init)}</text></svg>`; };
    if (method === 'GET' && (p === '/favicon' || p === '/favicon.ico' || p === '/favicon.png')) {
      const i = inst();
      const m = /^data:([^;]+);base64,(.+)$/.exec(i.logo || '');
      if (m) { res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'no-cache' }); res.end(Buffer.from(m[2], 'base64')); return true; }
      if (i.logo && /^https?:/i.test(i.logo)) { res.writeHead(302, { Location: i.logo }); res.end(); return true; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' }); res.end(monogramSvg()); return true;
    }
    if (method === 'GET' && p === '/icon.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' }); res.end(monogramSvg()); return true; }
    if (method === 'GET' && p === '/scan') return H(res, 200, SCAN_PAGE);
    if (method === 'GET' && p === '/verify') return H(res, 200, VERIFY_PAGE);
    if (method === 'GET' && p === '/api/verify') {
      let sid = u.searchParams.get('student') || '';
      if (sid) { // a student ID-card link/QR
        const msd = /[?&]student=([^&\\s]+)/.exec(sid); if (msd) sid = decodeURIComponent(msd[1]);
        return J(res, 200, { ok: true, ...verifyStudent(sid.trim()) });
      }
      let pid = u.searchParams.get('p') || '';
      if (pid) { // a payslip code/link
        const mp = /[?&]p=([^&\\s]+)/.exec(pid); if (mp) pid = decodeURIComponent(mp[1]);
        pid = pid.replace(/^UBU-PSL:/i, '').trim();
        return J(res, 200, { ok: true, ...verifyPayslip(pid) });
      }
      let sres = u.searchParams.get('res') || '';
      if (sres) { // a result statement link
        const ms = /[?&]res=([^&\\s]+)/.exec(sres); if (ms) sres = decodeURIComponent(ms[1]);
        const ses = u.searchParams.get('ses') || ''; const sem = u.searchParams.get('sem') || '';
        return J(res, 200, { ok: true, ...verifyResult(sres + ((ses || sem) ? ('|' + ses + '|' + sem) : '')) });
      }
      let rid = u.searchParams.get('r') || '';
      if (rid) { // a receipt code/link
        const mr = /[?&]r=([^&\\s]+)/.exec(rid); if (mr) rid = decodeURIComponent(mr[1]);
        rid = rid.replace(/^UBU-RCT:/i, '').trim();
        return J(res, 200, { ok: true, ...verifyReceipt(rid) });
      }
      let id = u.searchParams.get('c') || u.searchParams.get('ref') || '';
      const m = /[?&]c=([^&\\s]+)/.exec(id); if (m) id = decodeURIComponent(m[1]);   // a full URL was scanned
      id = id.replace(/^UBU-CLR:/i, '').trim();
      return J(res, 200, { ok: true, ...verifyClearance(id) });
    }

    if (p === '/api/login' && method === 'POST') {
      const body = await readBody();
      const acc = findAccount(body.login);
      if (!acc || !verifyPass(body.password, passField(acc.kind, acc.row))) return J(res, 200, { ok: false, error: 'Invalid login or password. (Officers: sign in to the desktop app once to activate your portal access.)' });
      const token = sign({ k: acc.kind, id: acc.row.id, role: acc.role, exp: Date.now() + 1000 * 60 * 60 * 12 });
      const name = (acc.kind === 'student') ? `${acc.row.first_name || ''} ${acc.row.last_name || ''}`.trim()
        : (acc.kind === 'parent') ? (acc.row.parent_name || 'Parent/Guardian') : acc.row.full_name;
      return J(res, 200, { ok: true, token, user: { role: acc.role, kind: acc.kind, name } });
    }

    // ---- Online Admissions (public application portal, temporary-pass auth) ----
    if (p === '/apply' && method === 'GET') { return H(res, 200, APPLY_PAGE); }
    if (p === '/api/apply/programmes' && method === 'GET') { return J(res, 200, Object.assign({ ok: true }, programmesPayload())); }

    if (p === '/api/apply/start' && method === 'POST') {
      if (String(process.env.ADMISSIONS_OPEN || '1') === '0') return J(res, 200, { ok: false, error: 'Online admissions are currently closed.' });
      const body = await readBody();
      const first = String(body.first_name || '').trim(), last = String(body.last_name || '').trim(), email = String(body.email || '').trim();
      if (!first || !last) return J(res, 200, { ok: false, error: 'Enter your first and last name.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return J(res, 200, { ok: false, error: 'Enter a valid email address.' });
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Applications are not available on this server.' });
      const dept = body.department_id ? one('departments', body.department_id) : null;
      const id = crypto.randomUUID(); const passcode = genPasscode(); const now = new Date().toISOString();
      create('admission_applications', {
        id, app_no: genAppNo(), passcode_hash: hashPass(passcode),
        first_name: first, last_name: last, email, phone: String(body.phone || '').trim(),
        faculty_id: dept ? dept.faculty_id : null, department_id: dept ? dept.id : (body.department_id || null), level_id: body.level_id || null, session_id: null,
        status: 'draft', stage: 1, admission_fee_paid: 0, deleted: 0, created_at: now, updated_at: now, origin_node: 'portal',
      });
      return J(res, 200, { ok: true, app_no: one('admission_applications', id).app_no, passcode, token: applicantToken(id), application: appPublic(one('admission_applications', id)) });
    }

    if (p === '/api/apply/login' && method === 'POST') {
      const body = await readBody();
      const appNo = String(body.app_no || '').trim().toUpperCase();
      const a = all('admission_applications').find(x => !x.deleted && String(x.app_no || '').toUpperCase() === appNo);
      if (!a || !verifyPass(body.passcode, a.passcode_hash)) return J(res, 200, { ok: false, error: 'Invalid application number or passcode.' });
      return J(res, 200, { ok: true, token: applicantToken(a.id), application: appPublic(a) });
    }

    if (p === '/api/apply/me' && method === 'GET') { const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false }); return J(res, 200, { ok: true, application: appPublic(a) }); }

    if (p === '/api/apply/save' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      if (a.status !== 'draft' && a.status !== 'submitted') return J(res, 200, { ok: false, error: 'This application can no longer be edited.' });
      const body = await readBody();
      const allowed = ['first_name', 'last_name', 'middle_name', 'email', 'phone', 'gender', 'date_of_birth', 'address', 'nationality', 'state_of_origin', 'department_id', 'level_id', 'jamb_no', 'jamb_score', 'olevel', 'prev_school', 'qualifications', 'guardian_name', 'guardian_email', 'guardian_phone', 'guardian_relation', 'stage'];
      const patch = {}; for (const k of allowed) if (k in body) patch[k] = body[k];
      if (patch.department_id) { const d = one('departments', patch.department_id); if (d) patch.faculty_id = d.faculty_id; }
      if (patch.olevel && typeof patch.olevel !== 'string') patch.olevel = JSON.stringify(patch.olevel);
      if (patch.qualifications && typeof patch.qualifications !== 'string') patch.qualifications = JSON.stringify(patch.qualifications);
      if (typeof update === 'function') update('admission_applications', a.id, patch);
      return J(res, 200, { ok: true, application: appPublic(one('admission_applications', a.id)) });
    }

    if (p === '/api/apply/doc' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      const body = await readBody();
      if (!body.content || !/^data:/.test(String(body.content))) return J(res, 200, { ok: false, error: 'No file received.' });
      if (String(body.content).length > 8 * 1024 * 1024) return J(res, 200, { ok: false, error: 'File too large (about 6MB max).' });
      const id = crypto.randomUUID(); const now = new Date().toISOString();
      const prior = all('admission_documents').find(d => d.application_id === a.id && d.kind === body.kind && !d.deleted);
      if (prior && typeof update === 'function') update('admission_documents', prior.id, { deleted: 1 });
      if (typeof create === 'function') create('admission_documents', { id, application_id: a.id, kind: String(body.kind || 'other'), filename: String(body.filename || 'upload'), content: String(body.content), uploaded_at: now, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
      return J(res, 200, { ok: true, application: appPublic(one('admission_applications', a.id)) });
    }

    if (p === '/api/apply/doc/delete' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      const body = await readBody(); const d = body.id ? one('admission_documents', body.id) : null;
      if (d && d.application_id === a.id && typeof update === 'function') update('admission_documents', d.id, { deleted: 1 });
      return J(res, 200, { ok: true, application: appPublic(one('admission_applications', a.id)) });
    }

    if (p === '/api/apply/submit' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      if (!a.first_name || !a.last_name || !a.email || !a.department_id) return J(res, 200, { ok: false, error: 'Please complete your name, email and chosen programme before submitting.' });
      const now = new Date().toISOString();
      const firstSubmit = a.status !== 'submitted'; // only alert the desk on the first submission
      if (typeof update === 'function') update('admission_applications', a.id, { status: 'submitted', submitted_at: a.submitted_at || now, stage: 6 });
      // Notify the admissions desk (registrar + admin). The notification is a normal SYNCED row, so it
      // shows up in the officer's 🔔 bell on the desktop (and any other signed-in machine) the moment it
      // syncs — no extra wiring needed. create() mirrors it to the cloud so it reaches cloud-sync desktops.
      if (firstSubmit && typeof create === 'function') {
        try {
          const dept = a.department_id ? nameOf('departments', a.department_id) : '';
          const who = `${a.first_name || ''} ${a.last_name || ''}`.trim() || 'A new applicant';
          const body = who + (dept ? ` applied to ${dept}` : ' submitted an admission application') + (a.app_no ? ` (App. No. ${a.app_no})` : '');
          for (const role of ['registrar', 'admin']) {
            create('notifications', { id: crypto.randomUUID(), target_user: null, target_role: role, title: 'New admission application 🎓', body, type: 'admission', payload: JSON.stringify({ application_id: a.id, app_no: a.app_no }), is_read: 0, created_at: now, updated_at: now, deleted: 0, origin_node: 'portal' });
          }
        } catch (_) { /* notification is best-effort — never block the submission */ }
      }
      return J(res, 200, { ok: true, application: appPublic(one('admission_applications', a.id)) });
    }

    if (p === '/api/apply/pay' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      if (!(Number(a.admission_fee_amount) > 0)) return J(res, 200, { ok: false, error: 'No admission fee has been set yet. Please wait for your offer.' });
      const amount = Number(a.admission_fee_amount), currency = a.admission_fee_currency || 'NGN';
      if (process.env.PAYSTACK_SECRET && a.email) {
        const init = await paystackReq('/transaction/initialize', 'POST', { email: a.email, amount: Math.round(amount * 100), currency, reference: 'ADM-' + String(a.id).slice(0, 8) + '-' + Date.now(), callback_url: `${buildBase(req)}/api/apply/pay/callback`, metadata: { application_id: a.id, app_no: a.app_no } });
        if (init && init.status && init.data && init.data.authorization_url) {
          if (typeof update === 'function') update('admission_applications', a.id, { payment_ref: init.data.reference });
          return J(res, 200, { ok: true, mode: 'paystack', authorization_url: init.data.authorization_url });
        }
      }
      return J(res, 200, { ok: true, mode: 'manual', amount, currency, bank: process.env.ADMISSION_BANK || 'Contact the Bursary for the bank account details, then declare your payment below.' });
    }

    if (p === '/api/apply/pay/declare' && method === 'POST') {
      const a = applicantFrom(req, u); if (!a) return J(res, 401, { ok: false });
      const body = await readBody();
      if (typeof update === 'function') update('admission_applications', a.id, { payment_ref: 'DECLARED:' + String(body.ref || 'bank transfer').slice(0, 60) });
      return J(res, 200, { ok: true, application: appPublic(one('admission_applications', a.id)) });
    }

    if (p === '/api/apply/pay/callback' && method === 'GET') {
      const reference = u.searchParams.get('reference') || u.searchParams.get('trxref') || '';
      let okPaid = false;
      if (process.env.PAYSTACK_SECRET && reference) {
        const v = await paystackReq('/transaction/verify/' + encodeURIComponent(reference), 'GET', null);
        if (v && v.status && v.data && v.data.status === 'success') {
          const appId = (v.data.metadata && v.data.metadata.application_id) || '';
          const a = appId ? one('admission_applications', appId) : null;
          if (a && typeof update === 'function') { update('admission_applications', a.id, { admission_fee_paid: 1, payment_ref: reference, status: a.status === 'admitted' ? 'admitted' : 'fee_paid' }); okPaid = true; }
        }
      }
      return H(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#fff;text-align:center;padding:60px 20px"><div style="font-size:54px">${okPaid ? '✅' : '⚠️'}</div><h2>${okPaid ? 'Payment received' : 'Payment not confirmed'}</h2><p style="opacity:.8">${okPaid ? 'Your admission fee has been received. Your admission will be finalized shortly.' : 'We could not confirm your payment. If you were debited, contact the Bursary.'}</p><a href="/apply" style="display:inline-block;margin-top:18px;background:#1e3a8a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Back to application</a></body>`);
    }

    // ---- Student fee payment (Paystack) — pay an outstanding fee from inside the app/portal ----
    // init → returns a Paystack authorization_url (when PAYSTACK_SECRET is set) or manual bank details.
    if (p === '/api/pay/init' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false, error: 'Sign in as a student to pay.' });
      const s = accountById('student', t.id); if (!s) return J(res, 401, { ok: false });
      const body = await readBody();
      const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
      const currency = String(body.currency || 'NGN').toUpperCase();
      const category = String(body.category || 'tuition').slice(0, 40);
      if (!(amount > 0)) return J(res, 200, { ok: false, error: 'Enter a valid amount to pay.' });
      if (process.env.PAYSTACK_SECRET && s.email) {
        const reference = 'STU-' + String(s.id).slice(0, 8) + '-' + Date.now();
        const init = await paystackReq('/transaction/initialize', 'POST', {
          email: s.email, amount: Math.round(amount * 100), currency, reference,
          callback_url: `${buildBase(req)}/api/pay/callback`,
          metadata: { student_id: s.id, category, currency },
        });
        if (init && init.status && init.data && init.data.authorization_url)
          return J(res, 200, { ok: true, mode: 'paystack', authorization_url: init.data.authorization_url, reference: init.data.reference });
        return J(res, 200, { ok: false, error: 'Could not start the online payment right now. Please try again later.' });
      }
      return J(res, 200, { ok: true, mode: 'manual', amount, currency, bank: process.env.FEES_BANK || process.env.ADMISSION_BANK || 'Online card payment is not enabled. Contact the Bursary for the bank account to pay into.' });
    }

    // callback → Paystack redirects the WebView here after payment. We VERIFY server-side and record a
    // COMPLETED payment for the student (idempotent on the Paystack reference) so it shows as a receipt
    // and reduces the balance — reusing the normal ledger (raised_role='accountant' = bursary/online).
    if (p === '/api/pay/callback' && method === 'GET') {
      const reference = u.searchParams.get('reference') || u.searchParams.get('trxref') || '';
      let okPaid = false; let paidText = '';
      if (process.env.PAYSTACK_SECRET && reference) {
        const v = await paystackReq('/transaction/verify/' + encodeURIComponent(reference), 'GET', null);
        if (v && v.status && v.data && v.data.status === 'success') {
          const md = v.data.metadata || {};
          const s = md.student_id ? one('students', md.student_id) : null;
          const dup = all('payments').find(x => !x.deleted && String(x.decision_note || '') === 'paystack:' + reference);
          if (dup) { okPaid = true; }
          else if (s && typeof create === 'function') {
            const now = new Date().toISOString();
            const amt = (Number(v.data.amount) || 0) / 100;
            const cur = String(v.data.currency || md.currency || 'NGN').toUpperCase();
            const ym = now.slice(0, 7).replace('-', '');
            create('payments', {
              id: crypto.randomUUID(), receipt_no: 'ONL-' + ym + '-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
              student_id: s.id, charge_id: null, category: String(md.category || 'tuition'),
              description: 'Online payment (Paystack)', currency: cur, amount: amt,
              method: 'online', channel: 'card', status: 'completed',
              raised_by: null, raised_role: 'accountant', decided_by: null, decided_at: now,
              decision_note: 'paystack:' + reference, session_id: null, semester_id: null,
              created_at: now, updated_at: now, deleted: 0, origin_node: 'portal',
            });
            okPaid = true; paidText = money(amt, cur);
          }
        }
      }
      return H(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#fff;text-align:center;padding:60px 20px"><div style="font-size:54px">${okPaid ? '✅' : '⚠️'}</div><h2>${okPaid ? 'Payment received' : 'Payment not confirmed'}</h2><p style="opacity:.8">${okPaid ? ('Your payment' + (paidText ? ' of ' + esc(paidText) : '') + ' has been recorded. Your receipt is now in the app under Fees.') : 'We could not confirm your payment. If you were debited, contact the Bursary with your transaction reference.'}</p><p style="opacity:.6;font-size:13px">You can close this window and return to the app.</p></body>`);
    }

    if (p === '/api/reset-password' && method === 'POST') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      const body = await readBody();
      if (!verifyPass(body.oldPassword, passField(t.k, row))) return J(res, 200, { ok: false, error: 'Your current password is incorrect.' });
      if (!body.newPassword || String(body.newPassword).length < 5) return J(res, 200, { ok: false, error: 'New password must be at least 5 characters.' });
      if (typeof update !== 'function') return J(res, 200, { ok: false, error: 'Password reset is unavailable on this server.' });
      const field = t.k === 'parent' ? 'parent_portal_pass' : 'portal_pass';
      const entity = (t.k === 'student' || t.k === 'parent') ? 'students' : (t.k === 'user' ? 'users' : 'staff');
      const done = update(entity, t.id, { [field]: hashPass(body.newPassword) });
      return J(res, 200, { ok: !!done, error: done ? null : 'Could not save the new password.' });
    }

    // A student appeals a malpractice flag ("the AI got the wrong person / it wasn't me"). Creates an
    // appeal row + marks the flag 'appealed' + notifies the exam officers — all of which sync to the
    // desktop so the officer reviews it. Ensures a wrongly-flagged student is never penalised silently.
    if (p === '/api/surveillance/appeal' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody();
      const flag = body.flag_id ? one('malpractice_flags', body.flag_id) : null;
      if (!flag || flag.deleted || flag.student_id !== t.id) return J(res, 404, { ok: false, error: 'Flag not found.' });
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Appeals are unavailable on this server.' });
      const existing = all('malpractice_appeals').find(a => !a.deleted && a.flag_id === flag.id && a.student_id === t.id && a.status === 'pending');
      if (existing) return J(res, 200, { ok: true, already: true });
      const now = new Date().toISOString();
      const id = 'mpa-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
      create('malpractice_appeals', { id, flag_id: flag.id, exam_id: flag.exam_id, student_id: t.id,
        reason: String(body.reason || 'misidentification').slice(0, 40), message: String(body.message || '').slice(0, 1500),
        status: 'pending', filed_at: now, created_at: now, updated_at: now, deleted: 0 });
      if (typeof update === 'function') update('malpractice_flags', flag.id, { status: 'appealed' });
      // notify the exam officers (shows on the desktop bell + sync)
      try {
        const sn = one('students', t.id); const nm = sn ? `${sn.first_name || ''} ${sn.last_name || ''}`.trim() : 'A student';
        create('notifications', { id: 'ntf-' + Math.random().toString(16).slice(2) + Date.now().toString(16), target_user: null, target_role: 'registrar',
          title: '📨 Exam-conduct appeal filed', body: nm + ' is appealing a malpractice flag (' + examTitleOf(flag.exam_id) + ')', type: 'system',
          payload: JSON.stringify({ appeal_flag: flag.id }), is_read: 0, created_at: now, updated_at: now, deleted: 0 });
      } catch (_) {}
      return J(res, 200, { ok: true });
    }

    // ===== Online examinations =====
    // Student: list the exams available to them (also in /api/data.exams; this is for polling).
    if (p === '/api/exam/active' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const s = one('students', t.id); if (!s) return J(res, 401, { ok: false });
      return J(res, 200, { ok: true, exams: examsForStudent(s) });
    }
    // Student: start (or resume) an attempt → shuffled questions (NO answers) + a server-authoritative end time.
    if (p === '/api/exam/start' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const s = one('students', t.id);
      const e = body.exam_id ? one('online_exams', body.exam_id) : null;
      if (!e || !examVisibleTo(e, s)) return J(res, 404, { ok: false, error: 'Exam not found.' });
      const win = winState(Date.now(), e.start_at, e.end_at);
      if (win === 'upcoming') return J(res, 200, { ok: false, error: 'This exam has not started yet.' });
      if (win === 'closed' || e.status === 'ended') return J(res, 200, { ok: false, error: 'This exam has closed.' });
      // WAITING ROOM: the invigilator must START the live session before students can begin.
      if (e.status !== 'live') {
        const resume = all('exam_attempts').find(a => !a.deleted && a.exam_id === e.id && a.student_id === t.id && a.status === 'in_progress');
        if (!resume) return J(res, 200, { ok: false, waiting: true, error: 'The invigilator has not started this exam yet. Please wait — it will begin shortly.' });
      }
      if (typeof create !== 'function') return J(res, 200, { ok: false, error: 'Exams are unavailable on this server.' });
      let at = all('exam_attempts').find(a => !a.deleted && a.exam_id === e.id && a.student_id === t.id);
      const now = new Date().toISOString();
      if (at && (at.status === 'submitted' || at.status === 'auto_submitted' || at.status === 'graded')) return J(res, 200, { ok: false, error: 'You have already submitted this exam.' });
      if (!at) { const id = 'att-' + Math.random().toString(16).slice(2) + Date.now().toString(16); at = { id, exam_id: e.id, student_id: t.id, status: 'in_progress', started_at: now, answers: '{}', live_requested: 0, created_at: now, updated_at: now, deleted: 0 }; create('exam_attempts', at); }
      const startedMs = Date.parse(at.started_at || now);
      const durEnd = startedMs + (Number(e.duration_min) || 60) * 60000;
      const winEnd = e.end_at ? Date.parse(e.end_at) : durEnd;
      const endsAt = new Date(Math.min(durEnd, winEnd)).toISOString();
      let qs = all('exam_questions').filter(q => !q.deleted && q.exam_id === e.id)
        .map(q => ({ id: q.id, seq: q.seq, type: q.type, text: q.text, options: (function () { try { return JSON.parse(q.options || '[]'); } catch (_) { return []; } })(), marks: q.marks, image: q.image || null }));
      if (e.shuffle !== 0) qs = seededShuffle(e.id + ':' + t.id, qs);
      let answers = {}; try { answers = JSON.parse(at.answers || '{}'); } catch (_) {}
      return J(res, 200, { ok: true, attempt_id: at.id, endsAt, duration_min: e.duration_min || 60, room: 'exam-' + e.id, exam: { id: e.id, title: e.title || e.course_code, instructions: e.instructions || '', require_camera: e.require_camera !== 0 }, answers, questions: qs });
    }
    // Student: autosave answers (during the exam).
    if (p === '/api/exam/answer' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const at = body.attempt_id ? one('exam_attempts', body.attempt_id) : null;
      if (!at || at.student_id !== t.id) return J(res, 404, { ok: false });
      if (at.status !== 'in_progress') return J(res, 200, { ok: false, error: 'This attempt is closed.' });
      if (typeof update === 'function') { let ans = {}; try { ans = JSON.parse(at.answers || '{}'); } catch (_) {} Object.assign(ans, body.answers || {}); update('exam_attempts', at.id, { answers: JSON.stringify(ans) }); }
      return J(res, 200, { ok: true });
    }
    // Student: submit (final / auto). Grading is done on the desktop, not here.
    if (p === '/api/exam/submit' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const at = body.attempt_id ? one('exam_attempts', body.attempt_id) : null;
      if (!at || at.student_id !== t.id) return J(res, 404, { ok: false });
      if (typeof update === 'function') { let ans = {}; try { ans = JSON.parse(at.answers || '{}'); } catch (_) {} Object.assign(ans, body.answers || {}); update('exam_attempts', at.id, { answers: JSON.stringify(ans), status: body.auto ? 'auto_submitted' : 'submitted', submitted_at: new Date().toISOString() }); }
      return J(res, 200, { ok: true });
    }
    // Student: upload a proctor frame (camera JPEG + mic level). Returns whether the officer wants live A/V.
    if (p === '/api/exam/frame' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const examId = String(body.exam_id || ''); if (!examId) return J(res, 400, { ok: false });
      const now = Date.now(); const key = examId + ':' + t.id;
      if (!body.kyc && lastFrameTs[key] && now - lastFrameTs[key] < 1000) return J(res, 200, { ok: true, throttled: true });  // KYC selfie bypasses the rate-limit
      lastFrameTs[key] = now;
      const jpeg = String(body.image_base64 || '').replace(/^data:[^;]+;base64,/, '');
      if (jpeg) { examFrames[examId] = examFrames[examId] || {}; const cur = examFrames[examId][t.id] || { ring: [], away: 0 }; cur.jpeg = jpeg; cur.audioLevel = Number(body.audioLevel) || 0; cur.ts = now; cur.ring = (cur.ring || []).concat([jpeg]).slice(-20); if (body.kyc) cur.kyc = jpeg; examFrames[examId][t.id] = cur; }
      const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === examId && a.student_id === t.id);
      return J(res, 200, { ok: true, live_requested: !!(at && at.live_requested), room: 'exam-' + examId });
    }
    // Student: report a proctoring EVENT (left the app / lost focus). Counted for the officer/AI.
    if (p === '/api/exam/event' && method === 'POST') {
      const t = authOf(req, u); if (!t || t.k !== 'student') return J(res, 401, { ok: false });
      const body = await readBody(); const examId = String(body.exam_id || ''); if (!examId) return J(res, 400, { ok: false });
      examFrames[examId] = examFrames[examId] || {}; const cur = examFrames[examId][t.id] || { ring: [], away: 0 };
      if ((body.type || 'left_app') === 'left_app') cur.away = (cur.away || 0) + 1;
      cur.lastEvent = { type: body.type || 'left_app', ts: Date.now() }; examFrames[examId][t.id] = cur;
      return J(res, 200, { ok: true, away: cur.away || 0 });
    }
    // Officer: monitor roster — who is online, audio level, last-seen, status.
    if (p === '/api/exam/monitor' && method === 'GET') {
      const t = isExamOfficer(req, u); if (!t) return J(res, 401, { ok: false, error: 'Not authorised — connect the monitor with the sync token or an officer login.' });
      const examId = u.searchParams.get('exam_id') || ''; const now = Date.now(); const frames = examFrames[examId] || {};
      const e = one('online_exams', examId) || {};
      const attempts = all('exam_attempts').filter(a => !a.deleted && a.exam_id === examId);
      // build the grid from the COHORT roster (so the officer sees the whole class, even before anyone
      // uploads a frame) unioned with any attempt that isn't in the cohort.
      const hasCohort = !!(e.department_id || e.level_id);
      const cohort = hasCohort ? all('students').filter(s => !s.deleted && s.status !== 'alumni'
        && (!e.department_id || s.department_id === e.department_id) && (!e.level_id || s.level_id === e.level_id) && (!e.faculty_id || s.faculty_id === e.faculty_id)) : [];
      const ids = new Set(cohort.map(s => s.id)); attempts.forEach(a => ids.add(a.student_id));
      const rows = Array.from(ids).map(sid => {
        const st = one('students', sid) || {}; const a = attempts.find(x => x.student_id === sid) || {}; const f = frames[sid];
        return { student_id: sid, name: `${st.first_name || ''} ${st.last_name || ''}`.trim(), matric: st.matric_no || '', status: a.status || 'not_started', score: a.score,
          live_requested: !!a.live_requested, identity: a.identity_verified || (f && f.kyc ? 'pending' : 'none'),
          hasFrame: !!(f && f.jpeg), hasKyc: !!(f && f.kyc), away: f ? (f.away || 0) : 0, audioLevel: f ? f.audioLevel : 0, lastSeen: f ? f.ts : 0, online: !!(f && now - f.ts < 8000) };
      }).sort((x, y) => (y.online - x.online) || String(x.name).localeCompare(String(y.name)));
      const onlineN = rows.filter(r => r.online).length;
      return J(res, 200, { ok: true, room: 'exam-' + examId, status: e.status, students: rows, onlineCount: onlineN, frameCount: rows.filter(r => r.hasFrame).length });
    }
    // Officer: latest frame JPEG for a student tile in the live grid.
    if (method === 'GET' && p === '/api/exam/frame') {
      const t = isExamOfficer(req, u); if (!t) return H(res, 401, '<p>Unauthorized.</p>');
      const examId = u.searchParams.get('exam_id') || ''; const sid = u.searchParams.get('student_id') || '';
      const f = (examFrames[examId] || {})[sid];
      const pic = (u.searchParams.get('kyc') === '1') ? (f && f.kyc) : (f && f.jpeg);
      if (!pic) return H(res, 404, '<p>No frame.</p>');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); res.end(Buffer.from(pic, 'base64')); return true;
    }
    // Officer/desktop: record the KYC identity-match result (verified | rejected) for a student's attempt.
    if (p === '/api/exam/identity' && method === 'POST') {
      const t = isExamOfficer(req, u); if (!t) return J(res, 401, { ok: false });
      const body = await readBody();
      const at = all('exam_attempts').find(a => !a.deleted && a.exam_id === body.exam_id && a.student_id === body.student_id);
      if (!at) return J(res, 404, { ok: false });
      if (typeof update === 'function') update('exam_attempts', at.id, { identity_verified: body.result === 'verified' ? 'verified' : 'rejected' });
      return J(res, 200, { ok: true });
    }
    // Officer: request (or stop) a student's real-time camera+mic (they then join the exam Jitsi room).
    if (p === '/api/exam/request-live' && method === 'POST') {
      const t = isExamOfficer(req, u); if (!t) return J(res, 401, { ok: false });
      const body = await readBody();
      const at = body.attempt_id ? one('exam_attempts', body.attempt_id) : all('exam_attempts').find(a => !a.deleted && a.exam_id === body.exam_id && a.student_id === body.student_id);
      if (!at) return J(res, 404, { ok: false });
      if (typeof update === 'function') update('exam_attempts', at.id, { live_requested: body.clear ? 0 : 1 });
      return J(res, 200, { ok: true, room: 'exam-' + at.exam_id });
    }

    if (p === '/api/me' && method === 'GET') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      const name = t.k === 'student' ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : row.full_name;
      return J(res, 200, { ok: true, user: { role: t.role, kind: t.k, name } });
    }

    // Native app registers its Firebase Cloud Messaging token here so the server can push it a
    // notification when a document is posted (etc.). No-op if the host has no FCM credentials.
    if (p === '/api/register-device' && method === 'POST') {
      const t = authOf(req, u); if (!t || (t.k !== 'student' && t.k !== 'parent')) return J(res, 401, { ok: false });
      const body = await readBody();
      const tok = body && (body.token || body.fcm || body.fcmToken);
      if (!tok) return J(res, 400, { ok: false, error: 'No device token.' });
      if (registerDevice) { try { registerDevice(String(tok), { kind: t.k, id: t.id, platform: String((body && body.platform) || 'android') }); } catch (_) {} }
      return J(res, 200, { ok: true });
    }

    if (p === '/api/officer-report' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'user') return J(res, 401, { ok: false });
      const row = accountById('user', t.id); if (!row) return J(res, 401, { ok: false });
      const data = officerData(row, parsePeriod(u.searchParams));
      data.role = t.role; data.institution = inst().name;
      return J(res, 200, { ok: true, data });
    }
    if (p === '/api/students' && method === 'GET') {
      const t = authOf(req, u); if (!t || t.k !== 'user') return J(res, 401, { ok: false });
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const rows = all('students').filter(s => s.status !== 'alumni' && (!q || (`${s.first_name || ''} ${s.last_name || ''}`.toLowerCase().includes(q) || (s.matric_no || '').toLowerCase().includes(q)))).slice(0, 25)
        .map(s => ({ id: s.id, name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), matric: s.matric_no, department: nameOf('departments', s.department_id) }));
      return J(res, 200, { ok: true, students: rows });
    }

    if (p === '/api/data' && method === 'GET') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      let data;
      if (t.k === 'student' || t.k === 'parent') { data = studentData(row); data.parentView = t.k === 'parent'; data.parentName = t.k === 'parent' ? (row.parent_name || 'Parent/Guardian') : null; data.kind = 'student'; }
      else if (t.k === 'staff') { data = staffData(row); data.kind = 'staff'; }
      else { data = officerData(row); } // officerData already sets data.kind = finance | registrar | dean | affairs
      data.institution = inst().name; data.role = t.role;
      return J(res, 200, { ok: true, data });
    }

    // student/parent assistant — deterministic answers from their own data (no AI key needed)
    if (p === '/api/assistant' && method === 'POST') {
      const t = authOf(req, u); if (!t || (t.k !== 'student' && t.k !== 'parent')) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      const body = await readBody();
      return J(res, 200, { ok: true, reply: studentAssistant(row, (body && body.message) || '', t.k === 'parent') });
    }

    // Native app: mint a per-user live-class JWT (8x8 JaaS / self-host) so the app can join the Jitsi
    // room in-app with NO Google login. The room id is an unguessable capability the student already
    // holds (it comes from /api/data → liveClasses), so we mint for whatever room they ask for.
    // Students join as guests; staff/officers as moderators. An empty jwt => plain meet.jit.si.
    if (p === '/api/class-jwt' && method === 'GET') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      const row = accountById(t.k, t.id); if (!row) return J(res, 401, { ok: false });
      const room = u.searchParams.get('room') || '';
      if (!room) return J(res, 200, { ok: false, error: 'No room specified.' });
      const name = t.k === 'student' ? `${row.first_name || ''} ${row.last_name || ''}`.trim() : (row.full_name || 'Guest');
      const moderator = (t.k === 'staff' || t.k === 'user');
      const emb = jitsi ? jitsi.classEmbed(jitsiCfg(), { room, displayName: name, email: row.email || '', moderator, userId: t.id })
        : { domain: 'meet.jit.si', roomName: String(room).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80), jwt: '', mode: 'public' };
      return J(res, 200, { ok: true, domain: emb.domain, roomName: emb.roomName, jwt: emb.jwt, mode: emb.mode });
    }

    // A lecturer started hosting a class FROM THE PORTAL → mark it LIVE for the cohort, exactly like the
    // desktop host does. This records a live_session so the class shows "Live now" + is joinable on the
    // students' app AND — crucially — gives the host's leave something to AUTO-END, which is what stops
    // the class on the students' APK (without this, a portal-hosted class kept running there). The room is
    // a one-way hash, so we resolve the cohort by MATCHING it against the lecturer's published allocations.
    if (p === '/api/class-start' && method === 'POST') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      if (t.k !== 'staff' && t.k !== 'user') return J(res, 403, { ok: false, error: 'Only teaching staff can start a class.' });
      const room = u.searchParams.get('room') || '';
      if (!room) return J(res, 200, { ok: false, error: 'No room specified.' });
      const sc = scopeForRoom(room);
      if (!sc || !sc.department_id || !sc.level_id) return J(res, 200, { ok: true, started: false }); // ad-hoc room: nobody to notify
      const now = new Date().toISOString();
      const recentCut = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const existing = all('live_sessions').find(v => v.room === room && !v.deleted && String(v.started_at || '') >= recentCut);
      if (existing) { // re-host within the window (or the desktop already started it) → refresh, don't duplicate
        if (typeof update === 'function') update('live_sessions', existing.id, { active: 1, started_at: now });
        return J(res, 200, { ok: true, started: true, id: existing.id });
      }
      if (typeof create !== 'function') return J(res, 200, { ok: true, started: false }); // LAN portal w/o create hook
      const id = crypto.randomUUID();
      const row = { id, room, subject: u.searchParams.get('subject') || sc.subject, course_code: sc.course_code, course_title: sc.course_title,
        department_id: sc.department_id, level_id: sc.level_id, session_id: sc.session_id || null, started_by: t.id,
        started_at: now, active: 1, deleted: 0, created_at: now, updated_at: now, origin_node: 'portal' };
      create('live_sessions', row);
      // notify the cohort (FCM push) — ONLY for this genuinely-new session, mirroring the desktop host
      try { if (typeof onLiveStart === 'function') onLiveStart(row); } catch (_) {}
      return J(res, 200, { ok: true, started: true, id });
    }
    // The host left/closed the class on the portal → END every active session for the room so it stops on
    // the cohort's app/APK (the student class page polls /api/class-live and leaves). Sent via sendBeacon.
    if (p === '/api/class-end' && method === 'POST') {
      const t = authOf(req, u); if (!t) return J(res, 401, { ok: false });
      if (t.k !== 'staff' && t.k !== 'user') return J(res, 403, { ok: false });
      const room = u.searchParams.get('room') || '';
      if (!room) return J(res, 200, { ok: false, error: 'No room specified.' });
      let ended = 0;
      if (typeof update === 'function')
        for (const v of all('live_sessions').filter(v => v.room === room && !v.deleted && v.active))
          if (update('live_sessions', v.id, { active: 0 })) ended++;
      return J(res, 200, { ok: true, ended });
    }

    // documents (open in a tab; token via ?t=)
    if (p.startsWith('/doc/') && method === 'GET') {
      const t = authOf(req, u); if (!t) return H(res, 401, '<p>Session expired. Please sign in again.</p>');
      const parts = p.split('/'); const type = parts[2]; const id = parts[3];
      const studentish = (t.k === 'student' || t.k === 'parent'); // both view the student record
      if (type === 'statement' && studentish) { return H(res, 200, statementHTML(accountById('student', t.id))); }
      if (type === 'result-slip' && studentish) {
        const s = accountById('student', t.id) || one('students', t.id);
        if (!s) return H(res, 404, '<p>Student not found.</p>');
        return H(res, 200, resultSlipHTML(s, { session: u.searchParams.get('session') || '', semester: u.searchParams.get('semester') || '' }));
      }
      if (type === 'receipt') {
        const pay = one('payments', id);
        if (!pay) return H(res, 404, '<p>Receipt not found.</p>');
        if (studentish && pay.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'staff') return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, receiptHTML(pay));
      }
      if (type === 'payslip') {
        const slip = one('payslips', id);
        if (!slip) return H(res, 404, '<p>Payslip not found.</p>');
        if (t.k === 'staff' && slip.staff_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (studentish) return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, payslipHTML(slip));
      }
      if (type === 'clearance') {
        const c = one('exam_clearances', id);
        if (!c) return H(res, 404, '<p>Clearance not found.</p>');
        if (studentish && c.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'staff') return H(res, 403, '<p>Not authorised.</p>');
        return H(res, 200, clearanceCertHTML(id));
      }
      if (type === 'officer-report' && t.k === 'user') {
        const row = accountById('user', t.id); if (!row) return H(res, 404, '<p>Not found.</p>');
        const period = parsePeriod(u.searchParams);
        return H(res, 200, officerReportHTML(officerData(row, period), periodLabel(period)));
      }
      if (type === 'student-statement' && t.k === 'user') {
        const s = one('students', id); if (!s) return H(res, 404, '<p>Student not found.</p>');
        return H(res, 200, statementHTML(s));
      }
      if (type === 'result') {
        const r = one('results', id);
        if (!r || !r.file) return H(res, 404, '<p>Result not found.</p>');
        if (studentish && r.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        if (t.k === 'staff') return H(res, 403, '<p>Not authorised.</p>');
        const buf = Buffer.from(r.file, 'base64');
        res.writeHead(200, { 'Content-Type': r.mime || 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + (r.filename || 'result') + '"' });
        res.end(buf); return true;
      }
      if (type === 'timetable' && studentish) {
        const s = accountById('student', t.id) || one('students', t.id);
        if (!s) return H(res, 404, '<p>Student not found.</p>');
        const tt = one('timetables', id);
        const scoped = tt && studentTimetable(tt, s);
        if (!scoped) return H(res, 404, '<p>Timetable not found or not for your cohort.</p>');
        return H(res, 200, timetableHTML(scoped.t, scoped.slots));
      }
      if (type === 'portal-document' || type === 'document') {
        const d = one('portal_documents', id);
        if (!d || !d.file) return H(res, 404, '<p>Document not found.</p>');
        // personalised docs (admission letter, certificate, transcript) are private to one student
        if (d.student_id && studentish && d.student_id !== t.id) return H(res, 403, '<p>Not authorised.</p>');
        const buf = Buffer.from(d.file, 'base64');
        res.writeHead(200, { 'Content-Type': d.mime || 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + (d.filename || 'document') + '"' });
        res.end(buf); return true;
      }
      return H(res, 404, '<p>Not found.</p>');
    }
    return false;
  }

  return { handle };
};

// ----------------------- single-page portal client -----------------------
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UniBursar Portal</title>
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1e3a8a"><link rel="icon" href="/favicon">
<style>
:root{--navy:#0f1e3d;--brand:#2563eb;--ink:#0f172a;--muted:#64748b;--line:#e6eaf0;--bg:#eef2f8}
*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand)}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(1200px 600px at 20% -10%,#1e3a8a22,transparent),var(--bg)}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 20px 60px rgba(15,23,42,.12)}
.lbox{width:380px;max-width:94vw;padding:30px}
.lbox h1{margin:0 0 2px;font-size:22px;color:var(--navy)}.lbox .sub{color:var(--muted);font-size:13px;margin-bottom:18px}
.brandhead{display:flex;gap:12px;align-items:center;margin-bottom:4px}
.blogo{width:58px;height:58px;object-fit:contain;border-radius:14px;background:#fff;border:1px solid var(--line);padding:4px;flex:none}
.blogo.mono{display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;font-weight:800;font-size:19px;border:0}
.uname{font-size:19px;font-weight:800;color:var(--navy);line-height:1.12}
.umotto{font-size:11px;color:var(--muted);font-style:italic;margin-top:2px}
.psub{font-size:13px;color:var(--brand);font-weight:700;margin:8px 0 16px}
.hintbar{font-size:12px;color:var(--muted);text-align:center;margin-top:12px;line-height:1.5}
.field{margin-bottom:12px}.field label{display:block;font-size:12px;font-weight:600;color:#334155;margin-bottom:5px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px}
.btn{background:linear-gradient(135deg,#2563eb,#4338ca);color:#fff;border:0;border-radius:10px;padding:12px;font-weight:700;width:100%;cursor:pointer;font-size:14px}
.btn.sm{width:auto;padding:8px 13px;font-size:12.5px;border-radius:8px}.btn.ghost{background:#fff;color:var(--brand);border:1px solid var(--line)}
.err{background:#fee2e2;color:#991b1b;padding:9px 12px;border-radius:9px;font-size:13px;margin-bottom:12px;display:none}
.top{background:var(--navy);color:#fff;display:flex;align-items:center;gap:12px;padding:12px 20px}
.top .nm{font-weight:800}.top .rl{margin-left:auto;opacity:.85;font-size:13px;text-transform:capitalize}
.wrap{max-width:1040px;margin:0 auto;padding:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px}
.kpi .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px}.kpi .v{font-size:22px;font-weight:800;margin-top:4px}
.panel{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:18px;overflow:hidden}
.panel h3{margin:0;padding:14px 18px;border-bottom:1px solid var(--line);font-size:15px}
table{width:100%;border-collapse:collapse}th,td{padding:11px 16px;text-align:left;border-bottom:1px solid #f1f5f9;font-size:13.5px}
th{background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted)}
.r{text-align:right}.neg{color:#b91c1c;font-weight:700}.pos{color:#065f46;font-weight:700}
.prof{display:flex;gap:16px;align-items:center;padding:18px}.prof img,.prof .ph{width:84px;height:96px;border-radius:10px;object-fit:cover;border:2px solid var(--brand)}
.prof .ph{background:#e2e8f0;display:flex;align-items:center;justify-content:center;color:#94a3b8}
.prof .nm{font-size:20px;font-weight:800}.prof .meta{color:var(--muted);font-size:13px;margin-top:3px}
.muted{color:var(--muted)}.badge{background:#eef2ff;color:#3730a3;border-radius:999px;padding:3px 9px;font-size:11px;font-weight:700}
.empty{padding:24px;text-align:center;color:var(--muted)}
.live{font-size:11px;color:#16a34a;margin-left:8px}
.tscroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
select{padding:9px 10px;border:1px solid var(--line);border-radius:9px;font-size:13.5px;background:#fff;max-width:100%}
.toolbarp{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pbanner{background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:12px;padding:11px 16px;margin-bottom:14px;font-size:13.5px}
.exbar{border-radius:12px;padding:13px 16px;margin-bottom:14px;font-weight:800;text-align:center;letter-spacing:.3px;font-size:15px}
.exbar.ok{background:#dcfce7;color:#166534;border:1px solid #86efac}
.exbar.warn{background:#fef9c3;color:#854d0e;border:1px solid #fde68a}
.exbar.bad{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}
/* ---- segmented student portal ---- */
/* single column: photo + info at the TOP, section tabs beneath, content below — the
   WHOLE page scrolls as one (no separate scrolling side panel). */
.shell{max-width:940px;margin:0 auto;padding:18px 16px}
.phead{background:linear-gradient(160deg,#1e3a8a,#4338ca);color:#fff;border-radius:18px;padding:20px 22px;display:flex;gap:18px;align-items:center;margin-bottom:14px;box-shadow:0 8px 26px rgba(30,58,138,.22)}
.phead img,.phead .ph{width:86px;height:86px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.55);flex:none}
.phead .ph{background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:34px}
.phead .nm{font-weight:800;font-size:21px;line-height:1.15}
.phead .mt{opacity:.92;font-size:13px;margin-top:4px}
.phead .bal{margin-left:8px;font-size:13px;opacity:.95}
.phead .chip{vertical-align:middle}
/* horizontal section tabs (sticky to the top of the page so they're always reachable) */
.nav{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;background:#fff;border:1px solid var(--line);border-radius:14px;padding:6px;margin-bottom:16px;position:sticky;top:8px;z-index:6;box-shadow:0 4px 16px rgba(15,23,42,.05)}
.nav a{display:inline-flex;gap:7px;align-items:center;padding:9px 14px;color:#334155;text-decoration:none;font-size:13.5px;font-weight:700;border-radius:10px;white-space:nowrap;cursor:pointer}
.nav a .ic{font-size:15px}
.nav a.active{background:var(--brand);color:#fff}
.nav a:hover{background:#f1f5f9}.nav a.active:hover{background:var(--brand)}
.nav a .pill{background:#ef4444;color:#fff;border-radius:999px;font-size:10px;font-weight:800;padding:1px 6px}
.content{min-width:0}
.hero{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:16px;display:flex;align-items:center;gap:16px;box-shadow:0 6px 22px rgba(15,23,42,.05)}
.hero .big{font-size:21px;font-weight:800}.hero .meta{color:var(--muted);font-size:13px;margin-top:3px}
.chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 12px;font-size:12.5px;font-weight:800}
.chip.ok{background:#dcfce7;color:#166534}.chip.warn{background:#fef9c3;color:#854d0e}.chip.bad{background:#fee2e2;color:#991b1b}
.seg{display:none}.seg.on{display:block}
.sectitle{font-size:18px;font-weight:800;margin:0 0 12px;color:var(--navy)}
.qa{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:16px}
/* phone — shrink the profile header; tabs become an icon strip that scrolls sideways */
@media(max-width:600px){
  .shell{padding:11px 9px}
  .phead{padding:14px;gap:12px;border-radius:14px}
  .phead img,.phead .ph{width:60px;height:60px;font-size:24px}
  .phead .nm{font-size:16px}.phead .mt{font-size:12px}
  .nav a{padding:9px 11px}
  .nav a .ic{font-size:18px}
  .nav a .lbl{display:none}   /* icons only on small phones; full labels on tablet+ */
  .tscroll table{min-width:520px}
}
@media(max-width:760px){
  .wrap{padding:12px}
  .top{padding:11px 14px;gap:9px}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
  .kpi{padding:13px}.kpi .v{font-size:19px}
  .panel h3{padding:12px 14px;font-size:14px}
  th,td{padding:9px 11px;font-size:13px;white-space:nowrap}
  .tscroll table{min-width:560px}
  .prof{flex-direction:column;text-align:center;gap:10px}
  .prof img,.prof .ph{width:96px;height:112px}
}
@media(max-width:560px){.top .rl{display:none}.lbox{padding:22px}}
</style></head>
<body>
<div id="app"></div>
<script>
const $=(h)=>{const d=document.createElement('div');d.innerHTML=h;return d.firstElementChild;};
let TOKEN=localStorage.getItem('ubu_token')||'';let VER=0;let TIMER=null;
const SYM={NGN:'₦',XOF:'CFA',USD:'$',EUR:'€',GBP:'£',GHS:'₵',KES:'KSh',ZAR:'R'};
function money(a,c){return (SYM[c]||(c?c+' ':''))+Number(a||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function mapMoney(m){const e=Object.entries(m||{});return e.length?e.map(([c,v])=>money(v,c)).join(' • '):money(0);}
function fmt(d){if(!d)return '—';try{return new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});}catch(_){return '—';}}
async function api(path,opts={}){opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});if(TOKEN)opts.headers.Authorization='Bearer '+TOKEN;const r=await fetch(path,opts);return r.json();}
function logout(){TOKEN='';localStorage.removeItem('ubu_token');if(TIMER)clearInterval(TIMER);renderLogin();}
async function changePassword(){
  const o=prompt('Enter your CURRENT password:'); if(o===null)return;
  const n=prompt('Enter your NEW password (at least 5 characters):'); if(n===null)return;
  if(!n||n.length<5){alert('New password must be at least 5 characters.');return;}
  const c2=prompt('Confirm your NEW password:'); if(c2===null)return;
  if(n!==c2){alert('The new passwords do not match.');return;}
  const r=await api('/api/reset-password',{method:'POST',body:JSON.stringify({oldPassword:o,newPassword:n})});
  alert(r.ok?'✓ Password changed. Use your new password next time you sign in. It also updates on the school system.':(r.error||'Could not change password.'));
}

function eh(s){return String(s==null?'':s).replace(/[&<>"]/g,function(m){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m];});}
async function renderLogin(msg){
  let b={};try{b=await(await fetch('/api/branding')).json();}catch(_){}
  const uname=eh(b.name||'University Portal');
  const logo=b.logo?'<img class="blogo" src="'+b.logo+'" alt="logo">':'<div class="blogo mono">'+eh((b.short||'UB').slice(0,3))+'</div>';
  document.getElementById('app').innerHTML='';
  const box=$('<div class="login"><div class="card lbox">'
    +'<div class="brandhead">'+logo+'<div><div class="uname">'+uname+'</div>'+(b.motto?('<div class="umotto">'+eh(b.motto)+'</div>'):'')+'</div></div>'
    +'<div class="psub">🎓 Student, Staff &amp; Lecturer Portal</div>'
    +'<div class="err"></div>'
    +'<div class="field"><label>Matric no · Staff no · Username · Email</label><input id="lg" autofocus autocomplete="username"></div>'
    +'<div class="field"><label>Password</label><input id="pw" type="password" autocomplete="current-password"></div>'
    +'<button class="btn" id="go">Sign In</button>'
    +'<div class="hintbar">Your login is emailed to you after registration. Forgot it? Ask the bursary or registrar to resend your portal login.</div>'
    +'<div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(148,163,184,.3);text-align:center"><div class="sub" style="margin-bottom:8px">New here? Not yet a student?</div><a href="/apply" style="display:inline-block;background:#1e3a8a;color:#fff;padding:10px 18px;border-radius:9px;text-decoration:none;font-weight:700">🎓 Apply for Admission</a></div>'
    +'<div class="sub" style="margin-top:10px;text-align:center"><a href="/scan">🛡 Staff: open the Clearance Scanner →</a></div>'
    +'</div></div>');
  document.getElementById('app').appendChild(box);
  if(msg){const e=box.querySelector('.err');e.textContent=msg;e.style.display='block';}
  const go=async()=>{const login=box.querySelector('#lg').value.trim();const password=box.querySelector('#pw').value;if(!login||!password)return;const btn=box.querySelector('#go');btn.disabled=true;btn.textContent='Signing in…';const r=await api('/api/login',{method:'POST',body:JSON.stringify({login,password})});btn.disabled=false;btn.textContent='Sign In';if(!r.ok){const e=box.querySelector('.err');e.textContent=r.error||'Login failed.';e.style.display='block';return;}TOKEN=r.token;localStorage.setItem('ubu_token',TOKEN);renderApp();};
  box.querySelector('#go').onclick=go;
  box.querySelectorAll('input').forEach(i=>i.addEventListener('keydown',function(e){if(e.key==='Enter')go();}));
}

// ---- NATIVE NOTIFICATIONS (Android/iOS app) -------------------------------
// When this portal runs INSIDE the mobile app (Capacitor WebView), fire a real OS notification
// (heads-up + sound) for every NEW item in the student's derived feed, so they are alerted even
// when they are not staring at the screen. On the plain web there is no Capacitor bridge → this is
// a silent no-op (the in-app 🔔 Updates tab still shows everything). renderApp() re-runs whenever the
// data version changes (every ~2.5s poll), so new receipts/results/fees trigger a notification within
// seconds of syncing. A per-account marker prevents the same item from notifying twice.
var NATIVE=(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.LocalNotifications)||null;
function isNativeApp(){return !!(window.Capacitor&&(window.Capacitor.isNativePlatform?window.Capacitor.isNativePlatform():window.Capacitor.platform&&window.Capacitor.platform!=='web'));}
var _notifReady=null;
function ensureNotif(){
  if(_notifReady)return _notifReady;
  _notifReady=(async function(){
    if(!NATIVE)return false;
    try{
      var pe=await NATIVE.checkPermissions();var granted=pe&&pe.display==='granted';
      if(!granted){var rq=await NATIVE.requestPermissions();granted=rq&&rq.display==='granted';}
      if(!granted)return false;
      try{ if(NATIVE.createChannel) await NATIVE.createChannel({id:'ubu-updates',name:'Portal Updates',description:'Fees, results, receipts and announcements',importance:5,visibility:1}); }catch(_){}
      return true;
    }catch(_){return false;}
  })();
  return _notifReady;
}
async function nativeNotify(notifs,key){
  if(!NATIVE||!notifs||!notifs.length)return;
  var ok=await ensureNotif();if(!ok)return;
  var markKey='ubu_notified_'+key;var last=localStorage.getItem(markKey)||'';var newest=String((notifs[0]&&notifs[0].date)||'');
  if(!newest)return;
  if(!last){localStorage.setItem(markKey,newest);return;} // first run on this device → set baseline, don't spam
  var fresh=notifs.filter(function(n){return String(n.date||'')>last;});
  if(!fresh.length)return;
  var toFire=fresh.slice(0,5).reverse();var base=Date.now()%2000000000;
  var arr=toFire.map(function(n,i){return {id:base+i,title:((n.icon?n.icon+' ':'')+(n.title||'Update')).slice(0,80),body:String(n.text||'').slice(0,180),channelId:'ubu-updates',extra:{seg:n.seg||null,doc:n.doc||null}};});
  try{await NATIVE.schedule({notifications:arr});}catch(_){}
  localStorage.setItem(markKey,newest);
}
// Tapping a notification opens the relevant section once the app is focused.
if(NATIVE&&NATIVE.addListener){try{NATIVE.addListener('localNotificationActionPerformed',function(ev){try{var ex=ev&&ev.notification&&ev.notification.extra;if(ex&&ex.seg&&window.__goSeg)window.__goSeg(ex.seg);}catch(_){}});}catch(_){}}
// Android hardware BACK button: navigate within the app (back to Overview) instead of closing it.
(function(){var A=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App;if(!A||!A.addListener)return;try{A.addListener('backButton',function(){try{var seg=window.__seg||'overview';if(seg&&seg!=='overview'&&window.__goSeg){window.__goSeg('overview');return;}if(A.minimizeApp)A.minimizeApp();else if(A.exitApp)A.exitApp();}catch(_){}});}catch(_){}})();

async function renderApp(){
  const r=await api('/api/data');
  if(!r.ok){return logout();}
  const d=r.data;
  const app=document.getElementById('app');app.innerHTML='';
  app.appendChild($('<div class="top"><div class="nm">'+(d.institution||'UniBursar')+'</div><div class="rl">'+(d.profile&&d.profile.full_name?d.profile.full_name+' · ':'')+d.role+' <span class="live">● live</span></div><button class="btn sm ghost" style="margin-left:14px" onclick="changePassword()">🔑 Password</button><button class="btn sm ghost" style="margin-left:8px" onclick="logout()">Sign out</button></div>'));
  const w=$('<div class="wrap"></div>');app.appendChild(w);
  if(d.kind==='student')studentView(w,d);
  else if(d.kind==='staff')staffView(w,d);
  else officerView(w,d);
  if(d.kind==='student'){mountChat();try{nativeNotify(d.notifications,(d.profile&&(d.profile.matric_no||d.profile.full_name))||'me');}catch(_){}}
  VER=(await api('/api/version')).version||0;
  if(TIMER)clearInterval(TIMER);
  TIMER=setInterval(async()=>{try{const v=(await api('/api/version')).version;if(v!==VER){VER=v;var ae=document.activeElement;if(ae&&/^(SELECT|INPUT|TEXTAREA)$/.test(ae.tagName))return;renderApp();}}catch(_){}},2500);
}
function tbl(cols,rows,empty){if(!rows||!rows.length)return '<div class="empty">'+(empty||'Nothing to show.')+'</div>';return '<div class="tscroll"><table><thead><tr>'+cols.map(c=>'<th class="'+(c.r?'r':'')+'">'+c.t+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+cols.map(c=>'<td class="'+(c.r?'r':'')+'">'+c.f(row)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';}
function doc(path){window.open(path+(path.includes('?')?'&':'?')+'t='+encodeURIComponent(TOKEN),'_blank');}
let CHAT_MOUNTED=false;
function mountChat(){
  if(CHAT_MOUNTED)return;CHAT_MOUNTED=true;
  var fab=document.createElement('button');fab.textContent='💬';fab.title='Ask the assistant';
  fab.style.cssText='position:fixed;right:18px;bottom:18px;z-index:9000;width:54px;height:54px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;font-size:24px;box-shadow:0 6px 18px rgba(30,58,138,.4)';
  var panel=document.createElement('div');
  panel.style.cssText='position:fixed;right:18px;bottom:82px;z-index:9000;width:340px;max-width:calc(100vw - 28px);height:480px;max-height:calc(100vh - 120px);display:none;flex-direction:column;background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(2,6,23,.28)';
  panel.innerHTML='<div style="padding:11px 13px;background:linear-gradient(135deg,#1e3a8a,#4338ca);color:#fff;font-weight:800;display:flex;justify-content:space-between;align-items:center"><span>💬 Student Assistant</span><span id="cx" style="cursor:pointer;font-size:20px">×</span></div><div id="clog" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f8fafc"></div><div style="display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0"><input id="cin" placeholder="Ask about results, fees, exams…" style="flex:1;border:1px solid #cbd5e1;border-radius:10px;padding:9px 11px;font-size:13px"><button id="csend" style="border:none;background:#1e3a8a;color:#fff;border-radius:10px;padding:0 14px;cursor:pointer;font-size:16px">&#10148;</button></div>';
  document.body.appendChild(fab);document.body.appendChild(panel);
  var log=panel.querySelector('#clog'),inp=panel.querySelector('#cin');
  function bub(role,text){var b=document.createElement('div');var me=role==='me';b.style.cssText='align-self:'+(me?'flex-end':'flex-start')+';max-width:85%;padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.4;white-space:pre-wrap;'+(me?'background:#1e3a8a;color:#fff':'background:#fff;color:#0f172a;border:1px solid #e2e8f0');b.textContent=text;log.appendChild(b);log.scrollTop=log.scrollHeight;return b;}
  function open(){var o=panel.style.display==='none';panel.style.display=o?'flex':'none';if(o){if(!log.childNodes.length)bub('bot','Hi! I can check your results, school fees, balance, exam clearance and timetable. Try “How much do I owe?” or “When are my exams?”.');inp.focus();}}
  fab.onclick=open;panel.querySelector('#cx').onclick=open;
  async function send(){var t=inp.value.trim();if(!t)return;inp.value='';bub('me',t);var w=bub('bot','…');try{var r=await api('/api/assistant',{method:'POST',body:JSON.stringify({message:t})});w.textContent=r.reply||'Sorry, I could not answer that.';}catch(e){w.textContent='⚠ Could not reach the assistant.';}}
  panel.querySelector('#csend').onclick=send;inp.addEventListener('keydown',function(e){if(e.key==='Enter')send();});
}
// Open a live class room (Jitsi). Navigate in the SAME webview so the app's camera/mic permission
// applies; Jitsi's "Back to portal" returns here. name is already URL-encoded.
function joinClass(room,subjEnc){var n=window.__lcName||encodeURIComponent('Guest');var host=window.__lcHost?'1':'0';location.href='/class/'+room+'?n='+n+'&s='+subjEnc+'&host='+host;}
// E-library: read in-app (navigate so the pdf.js viewer fills the screen; "Back" returns here) / download
function readBook(id){location.href='/library/read/'+id+'?t='+encodeURIComponent(TOKEN);}
function downloadBook(id){window.open('/library/download/'+id+'?t='+encodeURIComponent(TOKEN),'_blank');}
function goSeg(s){if(window.__goSeg)window.__goSeg(s);}
async function appealFlag(id){
  var msg=prompt('Tell the exam officer why you believe this flag is a mistake (e.g. "the camera identified the wrong person" or "I was not talking"):','');
  if(msg===null)return;
  var r=await api('/api/surveillance/appeal',{method:'POST',body:JSON.stringify({flag_id:id,reason:'misidentification',message:String(msg||'')})});
  if(r&&r.ok){alert(r.already?'You already have a pending appeal for this flag.':'Appeal submitted. An exam officer will review it and you will be notified of the outcome.');if(window.renderApp)renderApp();}
  else alert((r&&r.error)||'Could not submit the appeal. Please try again.');
}

function studentView(w,d){
  var p=d.profile;
  var clr=d.examClearance||{};
  var chip=clr.cleared?(clr.type==='partial'?'<span class="chip warn">⚠ Partially cleared</span>':'<span class="chip ok">✓ Cleared for exams</span>'):'<span class="chip bad">✗ Not cleared</span>';
  var owingCount=(d.outstanding||[]).length;
  var photo=p.photo?'<img src="'+p.photo+'">':'<div class="ph">🎓</div>';
  // --- section tabs ---
  var ttCount=(d.timetables||[]).length+(d.allocations||[]).length;
  var liveCount=(d.liveClasses||[]).length;
  var sv=d.surveillance||{flags:[],attendance:[]};
  var openFlags=(sv.flags||[]).filter(function(f){return f.status==='open'||f.status==='appealed';}).length;
  var notifs=d.notifications||[];
  var seenKey='ubu_seen_'+((p.matric_no||p.full_name||'me'));
  var lastSeen=localStorage.getItem(seenKey)||'';
  var unread=notifs.filter(function(n){return String(n.date||'')>lastSeen;}).length;
  window.__seenKey=seenKey; window.__notifMax=(notifs[0]&&notifs[0].date)||'';
  var segs=[['overview','🏠','Overview',0],['notifications','🔔','Updates',unread],['fees','💳','Fees & Payments',owingCount],['receipts','🧾','Receipts',0],['timetable','🗓','Timetable',ttCount],['liveclasses','🎥','Live Classes',liveCount],['library','📚','Library',0],['results','📑','Results',0],['clearance','✅','Clearance',0],['documents','📂','Documents',0]];
  if(d.misconduct&&d.misconduct.length)segs.push(['discipline','⚖️','Discipline',d.misconduct.length]);
  if((sv.flags&&sv.flags.length)||(sv.attendance&&sv.attendance.length))segs.push(['surveillance','🛡','Exam Conduct',openFlags]);
  segs.push(['profile','👤','Profile',0]);
  var navHtml=segs.map(function(s){return '<a data-seg="'+s[0]+'"><span class="ic">'+s[1]+'</span><span class="lbl">'+s[2]+'</span>'+(s[3]?'<span class="pill">'+s[3]+'</span>':'')+'</a>';}).join('');
  // --- profile + photo pinned at the TOP (full width) ---
  var head=$('<div class="phead">'+photo
    +'<div style="flex:1;min-width:0"><div class="nm">'+eh(p.full_name)+'</div>'
    +'<div class="mt">'+eh(p.matric_no||'Matric pending')+' · '+eh(p.department||'—')+' · '+eh(p.level||'—')+(p.faculty?(' · '+eh(p.faculty)):'')+'</div>'
    +'<div style="margin-top:9px">'+chip+'<span class="bal">Balance: <b>'+mapMoney(d.balances)+'</b></span></div></div></div>');
  // --- horizontal section tabs ---
  var navEl=$('<div class="nav">'+navHtml+'</div>');
  // --- content (segments) ---
  var content=$('<div class="content"></div>');
  if(d.parentView)content.appendChild($('<div class="pbanner">👨‍👩‍👧 Parent/Guardian view — records of <b>'+eh(p.full_name||'your ward')+'</b>.</div>'));

  function seg(id,html){return '<div class="seg" data-seg="'+id+'">'+html+'</div>';}
  function sevBadge(s){var c=s==='severe'?'background:#fee2e2;color:#991b1b':s==='major'?'background:#fef3c7;color:#92400e':'background:#e5e7eb;color:#374151';return '<span class="badge" style="'+c+'">'+cap(s||'minor')+'</span>';}
  function stBadge(s){var c=s==='resolved'?'background:#dcfce7;color:#166534':'background:#fee2e2;color:#991b1b';return '<span class="badge" style="'+c+'">'+cap(s||'open')+'</span>';}
  var clrCls=clr.cleared?(clr.type==='partial'?'warn':'ok'):'bad';
  var clrTxt=clr.cleared?(clr.type==='partial'?'⚠ PARTIALLY CLEARED for exams — you still owe fees':'✓ CLEARED for examinations'):('✗ NOT CLEARED for exams — '+eh(clr.reason||'no clearance'));

  var html='';
  // OVERVIEW
  html+=seg('overview',
    '<div class="kpis">'
    +'<div class="kpi"><div class="l">Outstanding Balance</div><div class="v neg">'+mapMoney(d.balances)+'</div></div>'
    +'<div class="kpi"><div class="l">Session</div><div class="v" style="font-size:16px">'+eh(d.currentSession||'—')+'</div></div>'
    +'<div class="kpi"><div class="l">Semester</div><div class="v" style="font-size:16px">'+eh(d.currentSemester||'—')+'</div></div>'
    +'<div class="kpi"><div class="l">Exam Status</div><div class="v" style="font-size:15px">'+(clr.cleared?(clr.type==='partial'?'Partial':'Cleared'):'Not cleared')+'</div></div></div>'
    +'<div class="exbar '+clrCls+'">'+clrTxt+'</div>'
    +'<div class="qa"><button class="btn sm" onclick="doc(\\'/doc/statement\\')">📄 Download full statement</button><button class="btn sm ghost" onclick="changePassword()">🔑 Change password</button></div>'
    +'<div class="panel"><h3>Who You Owe — by Office</h3>'+tbl([{t:'Office',f:function(r){return eh(r.office);}},{t:'Charged',r:1,f:function(r){return mapMoney(r.charged);}},{t:'Paid',r:1,f:function(r){return mapMoney(r.paid);}},{t:'Outstanding',r:1,f:function(r){return Object.keys(r.owing).length?'<span class=neg>'+mapMoney(r.owing)+'</span>':'<span class=pos>Cleared</span>';}}],d.byOffice,'No charges on your account.')+'</div>');
  // NOTIFICATIONS / UPDATES — derived feed of receipts, results, documents, fees, timetables…
  var notifHtml=notifs.length?notifs.map(function(n){
    var isNew=String(n.date||'')>lastSeen;
    var act=n.doc?(' onclick="doc(\\''+n.doc+'\\')"'):(n.seg?(' onclick="goSeg(\\''+n.seg+'\\')"'):'');
    return '<div class="panel ntf'+(isNew?' new':'')+'"'+act+' style="cursor:'+((n.doc||n.seg)?'pointer':'default')+';display:flex;gap:12px;align-items:flex-start">'
      +'<div style="font-size:22px;line-height:1">'+eh(n.icon||'🔔')+'</div>'
      +'<div style="flex:1;min-width:0"><div style="font-weight:800">'+eh(n.title||'')+(isNew?' <span class="pill" style="background:#ef4444">new</span>':'')+'</div>'
      +'<div class="muted" style="font-size:12.5px;margin-top:2px">'+eh(n.text||'')+'</div>'
      +'<div class="muted" style="font-size:11px;margin-top:4px">'+fmt(n.date)+'</div></div></div>';
  }).join(''):'<div class="empty">No updates yet. New receipts, results, documents, fees and timetable releases will appear here so you never miss anything.</div>';
  html+=seg('notifications','<h2 class="sectitle">🔔 Updates &amp; Notifications</h2>'+notifHtml);
  // FEES
  html+=seg('fees',
    '<h2 class="sectitle">💳 Fees &amp; Payments</h2>'
    +'<div class="panel"><h3>Outstanding Fees</h3>'+tbl([{t:'Fee Category',f:function(r){return cap(r.category);}},{t:'Currency',f:function(r){return r.currency;}},{t:'Billed',r:1,f:function(r){return money(r.billed,r.currency);}},{t:'Paid',r:1,f:function(r){return money(r.paid,r.currency);}},{t:'Outstanding',r:1,f:function(r){return '<span class=neg>'+money(r.outstanding,r.currency)+'</span>';}}],d.outstanding,'You owe nothing. 🎉')+'</div>'
    +'<div class="panel"><h3>All Fees &amp; Charges</h3>'+tbl([{t:'Date',f:function(r){return fmt(r.date);}},{t:'Description',f:function(r){return (eh(r.description)||cap(r.category))+' '+(r.rollover?'<span class="badge" style="background:#fef3c7;color:#92400e">Rollover'+(r.rolled_from?' · '+eh(r.rolled_from):'')+'</span>':'<span class="badge" style="background:#dbeafe;color:#1e40af">Current</span>');}},{t:'Category',f:function(r){return cap(r.category);}},{t:'Set By',f:function(r){return eh(r.by||'—');}},{t:'Amount',r:1,f:function(r){return money(r.amount,r.currency);}}],d.charges,'No charges yet.')+'</div>');
  // RECEIPTS
  html+=seg('receipts',
    '<h2 class="sectitle">🧾 Payment History &amp; Receipts</h2>'
    +'<div class="panel">'+tbl([{t:'Receipt',f:function(r){return r.receipt_no||'—';}},{t:'Date',f:function(r){return fmt(r.date);}},{t:'For',f:function(r){return cap(r.category);}},{t:'Collected By',f:function(r){return (r.collector?eh(r.collector)+'<br>':'')+'<span class="muted" style="font-size:11px">'+eh(r.office||'')+'</span>';}},{t:'Amount',r:1,f:function(r){return money(r.amount,r.currency);}},{t:'',r:1,f:function(r){return r.receipt_no?'<button class="btn sm" onclick="doc(\\'/doc/receipt/'+r.id+'\\')">Download</button>':'';}}],d.payments,'No payments yet.')+'</div>');
  // TIMETABLE — published lecture/exam/mid-semester timetables + course allocation
  var ttTypeName=function(t){return t==='lecture'?'Lecture':t==='midsemester'?'Mid-Semester Test':'Examination';};
  var ttHtml='';
  (d.timetables||[]).forEach(function(t){
    var rows=(t.slots||[]).filter(function(s){return s.kind!=='holiday';});
    var hol=(t.slots||[]).filter(function(s){return s.kind==='holiday';});
    var isLec=t.type==='lecture';
    ttHtml+='<div class="panel"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap"><h3 style="margin:0">'+(isLec?'📘':t.type==='exam'?'📝':'🧪')+' '+eh(t.title||ttTypeName(t.type))+'</h3>'
      +'<button class="btn sm" onclick="doc(\\'/doc/timetable/'+t.id+'\\')">⬇️ Download PDF</button></div>'
      +'<div class="muted" style="font-size:12px;margin:4px 0 8px">'+eh([t.semester,t.session].filter(Boolean).join(' · ')||'')+'</div>'
      +tbl([
        {t:isLec?'Day':'Date',f:function(r){return eh(r.day||'—');}},
        {t:'Time',f:function(r){return eh((r.start||'')+(r.end?('–'+r.end):''));}},
        {t:'Course',f:function(r){return '<b>'+eh(r.course_code||'')+'</b> '+eh(r.course_title||'');}},
        {t:'Lecturer',f:function(r){return eh(r.lecturer||'—');}},
        {t:'Venue',f:function(r){return eh(r.venue||'—');}}
      ],rows,'No entries.')
      +(hol.length?('<div class="muted" style="font-size:12px;margin-top:6px">🏖 Breaks/holidays: '+hol.map(function(s){return eh(fmt(s.day));}).join(', ')+'</div>'):'')
      +'</div>';
  });
  (d.allocations||[]).forEach(function(a){
    ttHtml+='<div class="panel"><h3>👩‍🏫 '+eh(a.title||'Course Allocation')+'</h3>'
      +'<div class="muted" style="font-size:12px;margin-bottom:8px">'+eh([a.semester,a.session].filter(Boolean).join(' · ')||'')+'</div>'
      +tbl([
        {t:'Code',f:function(r){return '<b>'+eh(r.code||'')+'</b>';}},
        {t:'Course',f:function(r){return eh(r.title||'');}},
        {t:'CH',r:1,f:function(r){return String(r.ch||0);}},
        {t:'Lecturer',f:function(r){return eh(r.lecturer||'—');}}
      ],a.courses,'No courses.')
      +'</div>';
  });
  html+=seg('timetable',
    '<h2 class="sectitle">🗓 My Timetable &amp; Course Allocation</h2>'
    +(ttHtml||'<div class="empty">No timetables or course allocations published yet. They will appear here (and arrive by email) once your department releases them.</div>'));
  // LIVE CLASSES — join the lecturer's live video class (Jitsi) for each registered course
  var lcName=encodeURIComponent(((p.full_name||'Student'))+(p.matric_no?(' ('+p.matric_no+')'):''));
  window.__lcName=lcName; window.__lcHost=false;
  var lcHtml=(d.liveClasses||[]).map(function(c){
    return '<div class="panel"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">'
      +'<div><div style="font-weight:800;font-size:15px">'+eh(c.code||'')+' — '+eh(c.title||'')+'</div>'
      +'<div class="muted" style="font-size:12px;margin-top:2px">'+(c.lecturer?('👤 '+eh(c.lecturer)+' · '):'')+eh([c.semester,c.session].filter(Boolean).join(' · '))+(c.when?(' · 🕒 '+eh(c.when)):'')+'</div></div>'
      +'<button class="btn" onclick="joinClass(\\''+c.room+'\\',\\''+encodeURIComponent(c.subject||c.code||'Live Class')+'\\')">🎥 Join Live Class</button>'
      +'</div></div>';
  }).join('');
  html+=seg('liveclasses',
    '<h2 class="sectitle">🎥 Live Classes</h2>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:10px">Join your lecturer\\'s live video class for any of your registered courses. You can use your camera and microphone, see shared screens/documents, and chat. The class opens when your lecturer starts it.</div>'
    +(lcHtml||'<div class="empty">No live classes available yet. Once your courses are allocated to lecturers, each course will appear here with a <b>Join</b> button.</div>'));
  // E-LIBRARY — read e-books / study materials online (in-app reader) or download
  var libHtml=(d.library||[]).length?('<div class="lib-grid">'+(d.library||[]).map(function(b){
    var cover=b.cover?('<img class="lib-cover" src="'+b.cover+'" alt="">'):('<div class="lib-cover noc">📘</div>');
    var read=b.readable?('<button class="btn sm" onclick="readBook(\\''+b.id+'\\')">📖 Read</button>'):'';
    return '<div class="lib-card">'+cover
      +'<div class="lib-body"><div class="lib-title">'+eh(b.title||'Untitled')+'</div>'
      +'<div class="muted" style="font-size:11.5px">'+eh(b.author||'Unknown author')+(b.pages?(' · '+b.pages+' pages'):'')+'</div>'
      +'<div style="margin:5px 0"><span class="badge">'+eh(b.category||'General')+'</span></div>'
      +(b.description?('<div class="muted" style="font-size:11.5px;margin-bottom:6px">'+eh(String(b.description).slice(0,140))+'</div>'):'')
      +'<div class="qa" style="margin-top:auto">'+read+'<button class="btn sm ghost" onclick="downloadBook(\\''+b.id+'\\')">⬇ Download</button></div>'
      +'</div></div>';
  }).join('')+'</div>'):'<div class="empty">No books in the library yet. E-books and study materials published by the school will appear here to read online or download.</div>';
  html+=seg('library',
    '<h2 class="sectitle">📚 E-Library</h2>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:10px">Read e-books and study materials online in the built-in reader, or download them to read offline.</div>'
    +'<style>.lib-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}.lib-card{display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 3px 12px rgba(15,23,42,.05)}.lib-cover{width:100%;height:150px;object-fit:cover;background:#eef2f8}.lib-cover.noc{display:flex;align-items:center;justify-content:center;font-size:46px;color:#94a3b8}.lib-body{padding:11px 12px;display:flex;flex-direction:column;flex:1}.lib-title{font-weight:800;font-size:14px;line-height:1.25;margin-bottom:2px}</style>'
    +libHtml);
  // EXAM CONDUCT — the student's exam attendance + any AI malpractice flag, with the actual
  // recorded evidence to download and a one-tap Appeal (transparency: nobody is penalised unseen).
  function svSev(s){var c=s==='high'?'background:#fee2e2;color:#991b1b':s==='medium'?'background:#fef3c7;color:#92400e':'background:#e5e7eb;color:#374151';return '<span class="badge" style="'+c+'">'+cap(s||'low')+'</span>';}
  function svStat(s){var m={open:['Under review','#fef3c7','#92400e'],appealed:['Appeal filed','#dbeafe','#1e40af'],upheld:['Upheld','#fee2e2','#991b1b'],dismissed:['Cleared ✓','#dcfce7','#166534'],reviewed:['Reviewed','#e5e7eb','#374151']}[s]||['Open','#fef3c7','#92400e'];return '<span class="badge" style="background:'+m[1]+';color:'+m[2]+'">'+m[0]+'</span>';}
  var attRows=(sv.attendance||[]).map(function(a){return '<tr><td>'+eh(a.exam)+'</td><td>'+(a.status==='present'?'<span class="badge" style="background:#dcfce7;color:#166534">Present</span>':'<span class="badge" style="background:#fee2e2;color:#991b1b">Absent</span>')+'</td><td class="muted">'+(a.method==='face'?'Face recognition':'Officer')+'</td><td class="muted">'+eh(fmt(a.date))+'</td></tr>';}).join('');
  var attHtml=attRows?('<div class="panel"><h3>Attendance</h3><table class="tb"><thead><tr><th>Exam</th><th>Status</th><th>Marked by</th><th>When</th></tr></thead><tbody>'+attRows+'</tbody></table></div>'):'';
  var flagHtml=(sv.flags||[]).length?((sv.flags||[]).map(function(f){
    var ev=(f.evidence||[]).map(function(e){var icon=e.kind==='video'?'🎬':e.kind==='audio'?'🔊':'🖼';return '<button class="btn sm" onclick="doc(\\'/surveillance/evidence/'+e.id+'\\')">'+icon+' View evidence</button> <button class="btn sm ghost" onclick="doc(\\'/surveillance/evidence/'+e.id+'?dl=1\\')">⬇ Download</button>';}).join(' ');
    var canAppeal=f.status!=='dismissed'&&!(f.appeal&&f.appeal.status==='pending');
    var appealBtn=canAppeal?('<button class="btn sm warn" onclick="appealFlag(\\''+f.id+'\\')">⚖️ Appeal / report wrong person</button>'):(f.appeal&&f.appeal.status==='pending'?'<span class="muted" style="font-size:12px">⏳ Your appeal is under review</span>':(f.appeal&&f.appeal.status==='accepted'?'<span class="muted" style="font-size:12px;color:#166534">✓ Appeal accepted — cleared</span>':''));
    return '<div class="panel" style="border-left:4px solid '+(f.severity==='high'?'#ef4444':f.severity==='medium'?'#f59e0b':'#94a3b8')+'">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><div style="font-weight:800">'+eh(f.label||f.type)+'</div><div>'+svSev(f.severity)+' '+svStat(f.status)+'</div></div>'
      +'<div class="muted" style="font-size:12px;margin:4px 0">'+eh(f.exam)+' · '+eh(fmt(f.date))+'</div>'
      +(f.detail?('<div style="font-size:13px;margin-bottom:7px">'+eh(f.detail)+'</div>'):'')
      +'<div class="qa" style="gap:6px;flex-wrap:wrap">'+(ev||'<span class="muted" style="font-size:12px">No clip attached.</span>')+'</div>'
      +'<div style="margin-top:8px">'+appealBtn+'</div></div>';
  }).join('')):'<div class="empty">No exam-conduct flags on your record. 🎉</div>';
  html+=seg('surveillance',
    '<h2 class="sectitle">🛡️ Exam Conduct</h2>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:10px">Your exam attendance and any conduct alert raised by the AI monitoring system. We show you the exact evidence that was recorded — if you believe a flag is a mistake (for example the system identified the wrong person), tap <b>Appeal</b> and an exam officer will review it.</div>'
    +attHtml+flagHtml);
  // RESULTS — list each level + semester with a downloadable PDF statement of result
  var sc=d.scores||{courses:[],semesters:[],cgpa:0,totalUnits:0};
  var myLevel=(d.profile&&d.profile.level)||'—';
  var resultsHtml=(sc.semesters&&sc.semesters.length)?(
    '<div class="panel"><h3>My Results</h3>'
    +'<div class="muted" style="font-size:12.5px;margin-bottom:8px">Your statement of result is generated as a PDF. Pick a semester and click <b>Download PDF</b> — the document opens ready to save/print.</div>'
    +tbl([
      {t:'Level',f:function(r){return eh(myLevel);}},
      {t:'Semester',f:function(r){return eh(r.semester||'—');}},
      {t:'Session',f:function(r){return eh(r.session||'—');}},
      {t:'',r:1,f:function(r){return '<button class="btn sm" onclick="doc(\\'/doc/result-slip?session='+encodeURIComponent(r.session_id||'')+'&semester='+encodeURIComponent(r.semester_id||'')+'\\')">⬇️ Download PDF</button>';}}
    ],sc.semesters,'No results published yet.')
    +'<div style="margin-top:10px"><button class="btn sm ghost" onclick="doc(\\'/doc/result-slip\\')">⬇️ Download full statement (all semesters)</button></div>'
    +'</div>'
  ):'<div class="empty">No results published yet. They will appear here once your results are released.</div>';
  html+=seg('results',
    '<h2 class="sectitle">📑 My Results</h2>'
    +resultsHtml
    +'<div class="panel"><h3>Other Result Documents</h3>'+tbl([{t:'Level',f:function(r){return eh(r.level||'—');}},{t:'Semester',f:function(r){return eh(r.semester||'—');}},{t:'Session',f:function(r){return eh(r.session||'—');}},{t:'Title',f:function(r){return eh(r.title||'Result');}},{t:'',r:1,f:function(r){return '<button class="btn sm" onclick="doc(\\'/doc/result/'+r.id+'\\')">Download</button>';}}],d.results,'No other result documents.')+'</div>');
  // CLEARANCE
  html+=seg('clearance',
    '<h2 class="sectitle">✅ Examination Clearance</h2>'
    +'<div class="exbar '+clrCls+'">'+clrTxt+'</div>'
    +(((clr.certs&&clr.certs.length))?('<div class="qa">'+clr.certs.map(function(ct){return '<button class="btn sm" onclick="doc(\\'/doc/clearance/'+ct.id+'\\')">📄 Download my '+eh(ct.typeName)+' clearance certificate</button>';}).join('')+'</div>'):'')
    +'<div class="panel"><h3>Exam Validation History</h3>'+tbl([{t:'Date',f:function(r){return fmt(r.date);}},{t:'Type',f:function(r){return cap(r.exam_type||'exam');}},{t:'Session',f:function(r){return eh(r.session||'—')+(r.semester?(' · '+eh(r.semester)):'');}},{t:'Result',f:function(r){return '<span class="'+(r.status==='valid'?'pos':'neg')+'" style="font-weight:800">'+(r.status==='valid'?'CLEARED':'DENIED')+'</span>';}},{t:'Reason',f:function(r){return eh(r.reason||'—');}}],d.validations,'No exam validations yet.')+'</div>');
  // DOCUMENTS
  html+=seg('documents',
    '<h2 class="sectitle">📂 University Documents</h2>'
    +'<div class="panel">'+tbl([{t:'Title',f:function(r){return eh(r.title||'Document');}},{t:'Type',f:function(r){return '<span class="badge">'+eh(r.category||'Document')+'</span>';}},{t:'From Office',f:function(r){return eh(r.office||'—')+(r.by?'<br><span class="muted" style="font-size:11px">'+eh(r.by)+'</span>':'');}},{t:'Date',f:function(r){return fmt(r.date);}},{t:'',r:1,f:function(r){return '<button class="btn sm" onclick="doc(\\'/doc/portal-document/'+r.id+'\\')">Download</button>';}}],d.documents,'No documents published yet.')+'</div>');
  // DISCIPLINE
  if(d.misconduct&&d.misconduct.length){
    html+=seg('discipline',
      '<h2 class="sectitle">⚖️ Disciplinary Records</h2>'
      +'<div class="panel">'+tbl([{t:'Date',f:function(r){return fmt(r.date);}},{t:'Offense',f:function(r){return eh(r.offense||'—');}},{t:'Severity',f:function(r){return sevBadge(r.severity);}},{t:'Action',f:function(r){return cap(r.action||'—');}},{t:'Fine',r:1,f:function(r){return r.fine>0?money(r.fine,r.currency):'—';}},{t:'Status',f:function(r){return stBadge(r.status);}},{t:'Note',f:function(r){return eh(r.note||'—');}}],d.misconduct,'No misconduct on record.')+'</div>');
  }
  // PROFILE
  html+=seg('profile',
    '<h2 class="sectitle">👤 My Profile</h2>'
    +'<div class="panel"><div class="prof">'+photo+'<div><div class="nm">'+eh(p.full_name)+'</div><div class="meta">'+eh(p.matric_no||'Matric pending')+'</div></div></div>'
    +'<table><tbody>'
    +'<tr><th>Faculty</th><td>'+eh(p.faculty||'—')+'</td><th>Department</th><td>'+eh(p.department||'—')+'</td></tr>'
    +'<tr><th>Level</th><td>'+eh(p.level||'—')+'</td><th>Email</th><td>'+eh(p.email||'—')+'</td></tr>'
    +'<tr><th>Session</th><td>'+eh(d.currentSession||'—')+'</td><th>Semester</th><td>'+eh(d.currentSemester||'—')+'</td></tr>'
    +'</tbody></table></div>'
    +'<div class="qa"><button class="btn sm" onclick="changePassword()">🔑 Change password</button></div>');

  var box=document.createElement('div');box.innerHTML=html;
  while(box.firstChild)content.appendChild(box.firstChild);
  var shell=$('<div class="shell"></div>');shell.appendChild(head);shell.appendChild(navEl);shell.appendChild(content);w.appendChild(shell);
  function show(s){
    Array.prototype.forEach.call(content.querySelectorAll('.seg'),function(el){el.classList.toggle('on',el.getAttribute('data-seg')===s);});
    Array.prototype.forEach.call(navEl.querySelectorAll('a'),function(a){a.classList.toggle('active',a.getAttribute('data-seg')===s);});
    window.__seg=s;
    // opening Updates marks everything seen → clears the unread pill
    if(s==='notifications'){ try{ if(window.__notifMax) localStorage.setItem(window.__seenKey, window.__notifMax); }catch(_){}
      var nb=navEl.querySelector('a[data-seg="notifications"] .pill'); if(nb)nb.remove(); }
    try{window.scrollTo(0,0);}catch(_){}   // show the top of the chosen section
  }
  window.__goSeg=show;
  Array.prototype.forEach.call(navEl.querySelectorAll('a'),function(a){a.onclick=function(){show(a.getAttribute('data-seg'));};});
  var want=window.__seg||'overview';
  if(!content.querySelector('.seg[data-seg="'+want+'"]'))want='overview';
  show(want);
}
function staffView(w,d){
  const p=d.profile;
  w.appendChild($('<div class="panel"><div class="prof">'+(p.photo?'<img src="'+p.photo+'">':'<div class="ph">👤</div>')+'<div><div class="nm">'+p.full_name+' <span class="badge">'+p.type+'</span></div><div class="meta">'+(p.staff_no||'—')+' · '+(p.position||p.title||'—')+'</div><div class="meta">'+(p.department||p.faculty||'')+' · '+(p.email||'')+'</div></div></div></div>'));
  w.appendChild($('<div class="kpis"><div class="kpi"><div class="l">Base / Default Pay</div><div class="v">'+money(p.base_salary,p.currency)+'</div></div><div class="kpi"><div class="l">Payslips</div><div class="v">'+d.payslips.length+'</div></div><div class="kpi"><div class="l">Bank</div><div class="v" style="font-size:15px">'+(p.bank_name||'—')+'</div></div></div>'));
  w.appendChild($('<div class="panel"><h3>My Payslips</h3>'+tbl([{t:'Period',f:r=>r.period||'—'},{t:'Type',f:r=>cap(r.run_type||'staff')},{t:'Status',f:r=>'<span class="badge">'+cap(r.status||'draft')+'</span>'},{t:'Net Pay',r:1,f:r=>money(r.net,r.currency)},{t:'',r:1,f:r=>'<button class="btn sm" onclick="doc(\\'/doc/payslip/'+r.id+'\\')">Payslip</button>'}],d.payslips,'No payslips yet.')+'</div>'));
  // LIVE CLASSES — a lecturer HOSTS the live video class for each course they teach
  if(d.liveClasses&&d.liveClasses.length){
    window.__lcName=encodeURIComponent((p.full_name||'Lecturer')+' (Lecturer)'); window.__lcHost=true;
    var rows=d.liveClasses.map(function(c){
      return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--line)">'
        +'<div><div style="font-weight:800">'+eh(c.code||'')+' — '+eh(c.title||'')+'</div>'
        +'<div class="muted" style="font-size:12px;margin-top:2px">'+eh([c.department,c.level,c.semester,c.session].filter(Boolean).join(' · '))+'</div></div>'
        +'<button class="btn" onclick="joinClass(\\''+c.room+'\\',\\''+encodeURIComponent(c.subject||c.code||'Live Class')+'\\')">🎥 Start / Host Class</button></div>';
    }).join('');
    w.appendChild($('<div class="panel"><h3>🎥 My Live Classes</h3><div class="muted" style="font-size:12.5px;margin-bottom:6px">Start a live video class for any course you teach. Students registered for the course join from their portal. You can share your screen and documents, and chat live.</div>'+rows+'</div>'));
  }
}
function officerControls(w,d){
  var per=d.period||{};var ps=d.periods||{sessions:[],semesters:[]};
  var today=new Date().toISOString().slice(0,10);var thisMonth=today.slice(0,7);
  function o(v,l,sel){return '<option value="'+v+'"'+(sel?' selected':'')+'>'+l+'</option>';}
  var basis=per.basis||'all';
  var basisOpts=[['all','All time'],['day','Daily'],['week','Weekly'],['month','Monthly'],['semester','Semester'],['session','Session']].map(function(x){return o(x[0],x[1],basis===x[0]);}).join('');
  var sessOpts='<option value="">All sessions</option>'+ps.sessions.map(function(s){return o(s.id,eh(s.name),s.id===per.session);}).join('');
  var semOpts='<option value="">All semesters</option>'+ps.semesters.map(function(sm){return o(sm.id,eh(sm.name),sm.id===per.semester);}).join('');
  // finance officers (accountant/admin) can drill into a specific office's collections
  var officeCtrl='';
  if(d.canPickOffice){var oo=per.office||'';officeCtrl='<span class="muted">Office:</span> <select id="of-office">'+[['','All offices'],['accountant','Bursary / Accountant'],['registrar','Registrar'],['dean','Faculty Head (Dean)'],['student_affairs','Student Affairs']].map(function(x){return o(x[0],x[1],oo===x[0]);}).join('')+'</select>';}
  var bar=$('<div class="panel"><div class="toolbarp" style="padding:14px 16px">'
    +'<b>📊 Report:</b> <select id="of-basis">'+basisOpts+'</select> <span id="of-valwrap"></span>'
    +officeCtrl
    +'<button class="btn sm" id="of-dl" style="width:auto">📄 Download</button>'
    +'<span style="flex:1"></span>'
    +'<input id="of-find" placeholder="🔎 Find a student…" style="min-width:200px;width:auto">'
    +'</div><div id="of-find-res" style="padding:0 16px 14px"></div></div>');
  w.appendChild(bar);
  var basisSel=bar.querySelector('#of-basis'),valwrap=bar.querySelector('#of-valwrap');
  var officeSel=bar.querySelector('#of-office');if(officeSel)officeSel.onchange=apply;
  function buildVal(){
    var b=basisSel.value;
    if(b==='day')valwrap.innerHTML='<input type="date" id="of-day" value="'+(per.day||today)+'">';
    else if(b==='week')valwrap.innerHTML='week of <input type="date" id="of-week" value="'+(per.weekStart||today)+'">';
    else if(b==='month')valwrap.innerHTML='<input type="month" id="of-month" value="'+(per.month||thisMonth)+'">';
    else if(b==='session')valwrap.innerHTML='<select id="of-sess">'+sessOpts+'</select>';
    else if(b==='semester')valwrap.innerHTML='<select id="of-sess">'+sessOpts+'</select> <select id="of-sem">'+semOpts+'</select>';
    else valwrap.innerHTML='';
    Array.prototype.forEach.call(valwrap.querySelectorAll('input,select'),function(el){el.onchange=apply;});
  }
  function gather(){
    var b=basisSel.value,p={basis:b},e;
    if(b==='day'){e=valwrap.querySelector('#of-day');p.day=e?e.value:today;}
    else if(b==='week'){e=valwrap.querySelector('#of-week');p.weekStart=e?e.value:today;}
    else if(b==='month'){e=valwrap.querySelector('#of-month');p.month=e?e.value:thisMonth;}
    else if(b==='session'){e=valwrap.querySelector('#of-sess');p.session=e?e.value:'';}
    else if(b==='semester'){var s=valwrap.querySelector('#of-sess'),m=valwrap.querySelector('#of-sem');p.session=s?s.value:'';p.semester=m?m.value:'';}
    if(officeSel&&officeSel.value)p.office=officeSel.value;
    return p;
  }
  function qstr(p){return Object.keys(p).map(function(k){return k+'='+encodeURIComponent(p[k]||'');}).join('&');}
  function apply(){officerReload(gather());}
  basisSel.onchange=function(){buildVal();apply();};
  buildVal();
  bar.querySelector('#of-dl').onclick=function(){doc('/doc/officer-report?'+qstr(gather()));};
  var find=bar.querySelector('#of-find'),fres=bar.querySelector('#of-find-res');var ft;
  find.addEventListener('input',function(){clearTimeout(ft);ft=setTimeout(async function(){
    var q=find.value.trim();fres.innerHTML='';if(q.length<2)return;
    var r=await api('/api/students?q='+encodeURIComponent(q));
    (r.students||[]).forEach(function(s){var c=$('<div class="ev-card" style="display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid #e6eaf0;border-radius:10px;margin-top:6px;cursor:pointer"><div style="flex:1"><b>'+eh(s.name)+'</b><div class="muted" style="font-size:12px">'+eh(s.matric||'—')+' · '+eh(s.department||'—')+'</div></div><span class="badge">Statement →</span></div>');c.onclick=function(){doc('/doc/student-statement/'+s.id);};fres.appendChild(c);});
    if(!(r.students||[]).length)fres.innerHTML='<div class="muted">No match.</div>';
  },200);});
}
function officerReload(period){
  var qs=Object.keys(period||{}).map(function(k){return k+'='+encodeURIComponent(period[k]||'');}).join('&');
  api('/api/officer-report?'+qs).then(function(r){
    if(!r.ok)return;var d=r.data;var w=document.querySelector('.wrap');w.innerHTML='';officerView(w,d);
  });
}
function officerView(w,d){
  var pp=d.profile||{};
  w.appendChild($('<div class="panel"><div class="prof">'+(pp.photo?'<img src="'+pp.photo+'">':'<div class="ph">👤</div>')+'<div><div class="nm">'+eh(pp.full_name||'Officer')+'</div><div class="meta" style="text-transform:capitalize">'+eh((d.role||'').replace("_"," "))+' • '+eh(pp.email||'')+'</div></div></div></div>'));
  officerControls(w,d);
  if(d.kind==='finance'){
    w.appendChild($('<div class="kpis">'+kpi('Collected',mapMoney(d.cards.collected))+kpi('Billed',mapMoney(d.cards.billed))+kpi('Expenses',mapMoney(d.cards.expenses))+kpi('Students',d.cards.students)+kpi('Debtors',d.cards.debtors)+'</div>'));
    // collections grouped by office (who collected)
    if(d.byOffice&&d.byOffice.length){
      w.appendChild($('<div class="panel"><h3>💰 Collections by Office</h3>'+tbl([{t:'Office',f:r=>eh(r.office)},{t:'Collected',r:1,f:r=>mapMoney(r.amounts)}],d.byOffice,'No collections.')+'</div>'));
    }
    var rtitle = d.officeFilter ? 'Payments — '+eh((d.byOffice.find(function(o){return o.role===d.officeFilter;})||{}).office||'office') : 'Recent Payments (all offices)';
    w.appendChild($('<div class="panel"><h3>'+rtitle+'</h3>'+tbl([{t:'Receipt',f:r=>r.receipt_no||'—'},{t:'Student',f:r=>eh(r.student)},{t:'For',f:r=>cap(r.category)},{t:'Office',f:r=>eh(r.office||'—')},{t:'By',f:r=>eh(r.by||'—')},{t:'Date',f:r=>fmt(r.date)},{t:'Amount',r:1,f:r=>money(r.amount,r.currency)}],d.recent,'No payments.')+'</div>'));
    // expenses — all offices
    if(d.expensesByOffice&&d.expensesByOffice.length){
      w.appendChild($('<div class="panel"><h3>📉 Expenses by Office</h3>'+tbl([{t:'Office',f:r=>eh(r.office)},{t:'Spent',r:1,f:r=>mapMoney(r.amounts)}],d.expensesByOffice,'No expenses.')+'</div>'));
    }
    w.appendChild($('<div class="panel"><h3>Expense Records (all offices)</h3>'+tbl([{t:'Category',f:r=>cap(r.category)},{t:'Description',f:r=>eh(r.description||'—')},{t:'Recorded By',f:r=>eh(r.by||'—')},{t:'Date',f:r=>fmt(r.date)},{t:'Amount',r:1,f:r=>money(r.amount,r.currency)}],d.expensesList||[],'No expenses recorded yet.')+'</div>'));
  } else if(d.kind==='registrar'){
    w.appendChild($('<div class="kpis">'+kpi('My Collections',mapMoney(d.collected))+kpi('Students I Billed',d.students.length)+'</div>'));
    w.appendChild($('<div class="panel"><h3>Students I Billed — paid vs owing</h3>'+tbl([{t:'Name',f:r=>r.full_name},{t:'Matric',f:r=>r.matric_no||'—'},{t:'Department',f:r=>r.department||'—'},{t:'Paid',r:1,f:r=>mapMoney(r.paid)},{t:'Owing',r:1,f:r=>'<span class=neg>'+mapMoney(r.owing)+'</span>'}],d.students,'You have not billed anyone yet.')+'</div>'));
  } else if(d.kind==='dean'){
    w.appendChild($('<div class="kpis">'+kpi('Faculty Collections',mapMoney(d.collected))+kpi('My Expenditure',mapMoney(d.expenses))+kpi('Students Owing',d.debtors.length)+'</div>'));
    w.appendChild($('<div class="panel"><h3>Students Owing Faculty Fees</h3>'+tbl([{t:'Name',f:r=>r.full_name},{t:'Matric',f:r=>r.matric_no||'—'},{t:'Department',f:r=>r.department||'—'},{t:'Owing',r:1,f:r=>'<span class=neg>'+mapMoney(r.owing)+'</span>'}],d.debtors,'No student owes faculty fees.')+'</div>'));
  } else if(d.kind==='affairs'&&d.clearance){
    w.appendChild($('<div class="kpis">'+kpi('Clearance Pending',d.clearance.pending)+kpi('Approved',d.clearance.approved)+kpi('Misconduct (open)',d.misconduct.open)+kpi('Misconduct (total)',d.misconduct.total)+'</div>'));
    w.appendChild($('<div class="panel"><h3>Student Affairs</h3><div class="empty">Clearance approvals and discipline are summarised above. Use the desktop app to action items.</div></div>'));
  } else {
    w.appendChild($('<div class="panel"><div class="prof"><div class="ph">👤</div><div><div class="nm">'+((d.profile&&d.profile.full_name)||'Welcome')+'</div><div class="meta" style="text-transform:capitalize">'+(d.role||'staff')+' account</div></div></div></div>'));
    w.appendChild($('<div class="panel"><h3>Dashboard</h3><div class="empty">You are signed in. Your reports and tools are available in the desktop app.</div></div>'));
  }
}
function kpi(l,v){return '<div class="kpi"><div class="l">'+l+'</div><div class="v">'+v+'</div></div>';}
function cap(s){s=String(s||'');return s.charAt(0).toUpperCase()+s.slice(1).replace(/_/g,' ');}
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{});}
if(TOKEN){renderApp().catch(()=>renderLogin());}else{renderLogin();}
</script></body></html>`;

// ----------------------- installable app assets -----------------------
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="104" fill="#1e3a8a"/><text x="50%" y="55%" font-family="Segoe UI,Arial,sans-serif" font-size="220" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">UB</text></svg>`;
// ---- Public Online Admission portal (/apply) — self-contained mini-SPA, temporary-pass auth ----
const APPLY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apply for Admission</title>
<link rel="icon" href="/favicon">
<style>
:root{--navy:#0f1e3d;--blue:#1e3a8a;--ind:#4338ca;--line:#e2e8f0;--muted:#64748b;--bg:#f1f5f9}
*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',Roboto,Arial,sans-serif;background:var(--bg);color:#0f172a}
.top{background:linear-gradient(120deg,var(--navy),var(--blue));color:#fff;padding:12px 16px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:5}
.top img{height:34px;width:34px;border-radius:8px;object-fit:contain;background:#fff}
.top .t{font-weight:800;font-size:16px;line-height:1.1}.top .s{font-size:11px;opacity:.8}
.top .sp{flex:1}.top a.lk{color:#cde;font-size:13px;text-decoration:none;border:1px solid rgba(255,255,255,.3);padding:6px 10px;border-radius:8px}
.wrap{max-width:760px;margin:0 auto;padding:18px 14px 60px}
.screen{display:none}.screen.on{display:block;animation:fu .25s ease}@keyframes fu{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0;box-shadow:0 1px 3px rgba(15,23,42,.05)}
.hero{background:linear-gradient(120deg,var(--navy),var(--ind));color:#fff;border:none}
.hero h1{margin:0 0 6px;font-size:26px}.hero p{margin:0;opacity:.9;line-height:1.5}
h2{font-size:19px;margin:0 0 4px}h3{font-size:15px;margin:14px 0 6px}.muted{color:var(--muted);font-size:13px}
label{display:block;font-size:12px;font-weight:600;color:#334155;margin:10px 0 4px}
input,select,textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;background:#fff}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(30,58,138,.12)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:560px){.row{grid-template-columns:1fr}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--blue);color:#fff;border:none;padding:12px 18px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none}
.btn.alt{background:#fff;color:var(--blue);border:1.5px solid var(--blue)}.btn.gho{background:transparent;color:#334155;border:1px solid var(--line)}
.btn:disabled{opacity:.6;cursor:default}.btn.full{width:100%}
.btnrow{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.err{background:#fee2e2;color:#991b1b;border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0;display:none}
.ok{background:#dcfce7;color:#166534;border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0}
.fac{border:1px solid var(--line);border-radius:12px;margin:10px 0;overflow:hidden}
.fac>.h{padding:12px 14px;font-weight:700;background:#f8fafc;cursor:pointer;display:flex;justify-content:space-between}
.fac .deps{display:none;padding:6px 10px 12px}.fac.open .deps{display:block}
.dep{display:block;width:100%;text-align:left;background:#fff;border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:6px 0;cursor:pointer;font-size:14px}
.dep:hover{border-color:var(--blue);background:#f5f8ff}
.steps{display:flex;gap:6px;margin:6px 0 14px;flex-wrap:wrap}
.steps .st{flex:1;min-width:54px;text-align:center;font-size:11px;color:var(--muted);border-top:3px solid var(--line);padding-top:6px}
.steps .st.on{color:var(--blue);border-color:var(--blue);font-weight:700}.steps .st.done{color:#166534;border-color:#16a34a}
.passbox{background:#0f1e3d;color:#fff;border-radius:12px;padding:16px;text-align:center;margin:12px 0}
.passbox .k{font-size:12px;opacity:.8}.passbox .v{font-size:22px;font-weight:800;letter-spacing:1px;margin:4px 0 10px;user-select:all}
.olrow{display:grid;grid-template-columns:1fr 90px 34px;gap:8px;margin:6px 0}
.docs{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
.doc{border:1px solid var(--line);border-radius:10px;padding:8px;width:120px;text-align:center;font-size:11px;position:relative}
.doc img{width:100%;height:74px;object-fit:cover;border-radius:6px}.doc .del{position:absolute;top:-7px;right:-7px;background:#ef4444;color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer}
.pill{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}
.tl{margin:14px 0}.tl .i{display:flex;gap:10px;align-items:flex-start;margin:0 0 2px}
.tl .dot{width:22px;height:22px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:12px;background:#e2e8f0;color:#64748b}
.tl .i.done .dot{background:#16a34a;color:#fff}.tl .i.now .dot{background:var(--blue);color:#fff}
.tl .ln{font-size:13px;padding-top:2px}.tl .i .bar{width:2px;background:#e2e8f0;margin:0 10px;height:14px}
.kv{display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:7px 0;font-size:14px}
</style></head><body>
<div class="top"><img id="logo" src="/favicon" alt=""><div><div class="t" id="instName">University Admissions</div><div class="s">Online Application Portal</div></div><div class="sp"></div><a class="lk" href="#" onclick="goContinue();return false">Continue application</a></div>
<div class="wrap">

  <div class="screen on" id="s-landing">
    <div class="card hero"><h1>Apply for Admission</h1><p>Start your application online in minutes. Choose your programme, upload your documents and track your admission — all from here.</p>
      <div class="btnrow"><button class="btn" style="background:#fff;color:#1e3a8a" onclick="show('s-start')">Start New Application</button><button class="btn" style="background:transparent;border:1.5px solid #fff;color:#fff" onclick="goContinue()">Continue / Check Status</button></div></div>
    <div class="card"><h2>Choose a programme</h2><div class="muted">Browse our faculties and click the department you want to apply to.</div><div id="progs"></div></div>
  </div>

  <div class="screen" id="s-start">
    <div class="card"><h2>Start your application</h2><div class="muted">We will give you a temporary application number and passcode to log back in.</div>
      <div class="err" id="startErr"></div>
      <div class="row"><div><label>First name</label><input id="f_first"></div><div><label>Last name</label><input id="f_last"></div></div>
      <div class="row"><div><label>Email</label><input id="f_email" type="email"></div><div><label>Phone</label><input id="f_phone"></div></div>
      <label>Programme (department)</label><select id="f_dept"></select>
      <label>Entry level</label><select id="f_level"></select>
      <div class="btnrow"><button class="btn gho" onclick="show('s-landing')">Back</button><button class="btn" id="startBtn" onclick="startApp()">Create Application</button></div>
    </div>
  </div>

  <div class="screen" id="s-pass">
    <div class="card"><h2>Save your temporary pass</h2><div class="muted">Write these down. You will use them to log back in and check your admission status.</div>
      <div class="passbox"><div class="k">APPLICATION NUMBER</div><div class="v" id="pass_no"></div><div class="k">PASSCODE</div><div class="v" id="pass_code"></div></div>
      <div class="ok">A copy is shown here only — keep it safe.</div>
      <button class="btn full" onclick="openWizard()">Continue to application form</button>
    </div>
  </div>

  <div class="screen" id="s-continue">
    <div class="card"><h2>Continue your application</h2>
      <div class="err" id="contErr"></div>
      <label>Application number</label><input id="c_no" placeholder="e.g. WAUU/APP/2026/00001">
      <label>Passcode</label><input id="c_code">
      <div class="btnrow"><button class="btn gho" onclick="show('s-landing')">Back</button><button class="btn" id="contBtn" onclick="continueApp()">Continue</button></div>
    </div>
  </div>

  <div class="screen" id="s-wizard">
    <div class="steps" id="stepper"></div>
    <div class="err" id="wizErr"></div>
    <div class="card" id="wizBody"></div>
  </div>

  <div class="screen" id="s-status"><div id="statusBody"></div></div>

</div>
<script>
var TOKEN=localStorage.getItem('ubu_app_token')||'';
var APP=null, PROG={faculties:[],levels:[]}, STEP=1, OLEVEL=[];
var STEP_NAMES=['Personal','Programme','Academic','Documents','Review'];
function show(id){var els=document.querySelectorAll('.screen');for(var i=0;i<els.length;i++)els[i].classList.remove('on');document.getElementById(id).classList.add('on');window.scrollTo(0,0);}
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
async function api(path,opts){opts=opts||{};opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});if(TOKEN)opts.headers.Authorization='Bearer '+TOKEN;try{var r=await fetch(path,opts);return await r.json();}catch(e){return{ok:false,error:'Network error.'};}}
function err(id,msg){var e=el(id);if(!e)return;if(msg){e.textContent=msg;e.style.display='block';}else{e.style.display='none';}}

async function boot(){
  var b=await api('/api/branding');if(b&&b.name){el('instName').textContent=b.name+' — Admissions';if(b.logo)el('logo').src=b.logo;document.title='Apply — '+b.name;}
  var pr=await api('/api/apply/programmes');if(pr&&pr.ok){PROG=pr;renderProgs();fillSelects();if(pr.open===false){el('progs').innerHTML='<div class="err" style="display:block">Online admissions are currently closed. Please check back later.</div>';}}
  if(TOKEN){var me=await api('/api/apply/me');if(me&&me.ok){APP=me.application;if(APP.status&&APP.status!=='draft'){renderStatus();show('s-status');}else{openWizard();}}else{TOKEN='';localStorage.removeItem('ubu_app_token');}}
}
function renderProgs(){
  var w=el('progs');var h='';
  (PROG.faculties||[]).forEach(function(f,i){
    h+='<div class="fac" id="fac'+i+'"><div class="h" onclick="document.getElementById(\\'fac'+i+'\\').classList.toggle(\\'open\\')"><span>'+esc(f.name)+'</span><span>+</span></div><div class="deps">';
    f.departments.forEach(function(d){h+='<button class="dep" onclick="pickDept(\\''+d.id+'\\')">'+esc(d.name)+'</button>';});
    h+='</div></div>';
  });
  w.innerHTML=h||'<div class="muted">No programmes published yet.</div>';
}
function fillSelects(){
  var ds='<option value="">Select a department…</option>';
  (PROG.faculties||[]).forEach(function(f){f.departments.forEach(function(d){ds+='<option value="'+d.id+'">'+esc(d.name)+' ('+esc(f.name)+')</option>';});});
  el('f_dept').innerHTML=ds;
  var ls='<option value="">Select…</option>';(PROG.levels||[]).forEach(function(l){ls+='<option value="'+l.id+'">'+esc(l.name)+'</option>';});
  el('f_level').innerHTML=ls;if(PROG.levels&&PROG.levels[0])el('f_level').value=PROG.levels[0].id;
}
function pickDept(id){show('s-start');el('f_dept').value=id;}
function goContinue(){show('s-continue');}

async function startApp(){
  err('startErr','');
  var body={first_name:el('f_first').value.trim(),last_name:el('f_last').value.trim(),email:el('f_email').value.trim(),phone:el('f_phone').value.trim(),department_id:el('f_dept').value,level_id:el('f_level').value};
  if(!body.first_name||!body.last_name){err('startErr','Enter your first and last name.');return;}
  el('startBtn').disabled=true;
  var r=await api('/api/apply/start',{method:'POST',body:JSON.stringify(body)});
  el('startBtn').disabled=false;
  if(!r.ok){err('startErr',r.error||'Could not start.');return;}
  TOKEN=r.token;localStorage.setItem('ubu_app_token',TOKEN);APP=r.application;
  el('pass_no').textContent=r.app_no;el('pass_code').textContent=r.passcode;show('s-pass');
}
async function continueApp(){
  err('contErr','');el('contBtn').disabled=true;
  var r=await api('/api/apply/login',{method:'POST',body:JSON.stringify({app_no:el('c_no').value.trim(),passcode:el('c_code').value.trim()})});
  el('contBtn').disabled=false;
  if(!r.ok){err('contErr',r.error||'Invalid details.');return;}
  TOKEN=r.token;localStorage.setItem('ubu_app_token',TOKEN);APP=r.application;
  if(APP.status&&APP.status!=='draft'){renderStatus();show('s-status');}else{openWizard();}
}
function openWizard(){STEP=APP&&APP.stage?Math.min(5,Math.max(1,APP.stage)):1;try{OLEVEL=APP&&APP.olevel?JSON.parse(APP.olevel):[];}catch(e){OLEVEL=[];}if(!OLEVEL.length)OLEVEL=[{exam:'',year:'',subjects:[{subject:'',grade:''}]}];renderWizard();show('s-wizard');}

function val(k){return APP&&APP[k]!=null?APP[k]:'';}
function renderStepper(){var h='';for(var i=1;i<=5;i++){h+='<div class="st '+(i===STEP?'on':(i<STEP?'done':''))+'">'+i+'. '+STEP_NAMES[i-1]+'</div>';}el('stepper').innerHTML=h;}
function renderWizard(){
  renderStepper();err('wizErr','');var b=el('wizBody');
  if(STEP===1){
    b.innerHTML='<h2>Personal details</h2>'+
      '<div class="row"><div><label>First name</label><input id="w_first" value="'+esc(val('first_name'))+'"></div><div><label>Last name</label><input id="w_last" value="'+esc(val('last_name'))+'"></div></div>'+
      '<div class="row"><div><label>Middle name</label><input id="w_middle" value="'+esc(val('middle_name'))+'"></div><div><label>Gender</label><select id="w_gender"><option value="">Select…</option><option'+(val('gender')==='male'?' selected':'')+'>male</option><option'+(val('gender')==='female'?' selected':'')+'>female</option></select></div></div>'+
      '<div class="row"><div><label>Date of birth</label><input id="w_dob" type="date" value="'+esc(val('date_of_birth'))+'"></div><div><label>Phone</label><input id="w_phone" value="'+esc(val('phone'))+'"></div></div>'+
      '<div class="row"><div><label>Nationality</label><input id="w_nat" value="'+esc(val('nationality'))+'"></div><div><label>State of origin</label><input id="w_state" value="'+esc(val('state_of_origin'))+'"></div></div>'+
      '<label>Home address</label><textarea id="w_addr" rows="2">'+esc(val('address'))+'</textarea>'+
      '<h3>Parent / Guardian</h3><div class="row"><div><label>Name</label><input id="w_gname" value="'+esc(val('guardian_name'))+'"></div><div><label>Relationship</label><input id="w_grel" value="'+esc(val('guardian_relation'))+'"></div></div>'+
      '<div class="row"><div><label>Guardian phone</label><input id="w_gphone" value="'+esc(val('guardian_phone'))+'"></div><div><label>Guardian email</label><input id="w_gemail" value="'+esc(val('guardian_email'))+'"></div></div>'+
      navBtns();
  }else if(STEP===2){
    var ds='<option value="">Select a department…</option>';(PROG.faculties||[]).forEach(function(f){f.departments.forEach(function(d){ds+='<option value="'+d.id+'"'+(val('department_id')===d.id?' selected':'')+'>'+esc(d.name)+' ('+esc(f.name)+')</option>';});});
    var ls='<option value="">Select…</option>';(PROG.levels||[]).forEach(function(l){ls+='<option value="'+l.id+'"'+(val('level_id')===l.id?' selected':'')+'>'+esc(l.name)+'</option>';});
    b.innerHTML='<h2>Programme</h2><label>Department / Programme</label><select id="w_dept">'+ds+'</select><label>Entry level</label><select id="w_level">'+ls+'</select><label>Email</label><input id="w_email" type="email" value="'+esc(val('email'))+'">'+navBtns();
  }else if(STEP===3){
    b.innerHTML='<h2>Academic background</h2><div class="row"><div><label>JAMB reg. no</label><input id="w_jamb" value="'+esc(val('jamb_no'))+'"></div><div><label>JAMB score</label><input id="w_jscore" type="number" value="'+esc(val('jamb_score'))+'"></div></div>'+
      '<label>Previous school attended</label><input id="w_school" value="'+esc(val('prev_school'))+'">'+
      '<h3>O\\'Level result</h3><div class="row"><div><label>Exam (e.g. WAEC)</label><input id="w_oexam" value="'+esc(OLEVEL[0].exam||'')+'"></div><div><label>Year</label><input id="w_oyear" value="'+esc(OLEVEL[0].year||'')+'"></div></div>'+
      '<div id="olrows"></div><button class="btn gho" type="button" onclick="addOl()">+ Add subject</button>'+navBtns();
    renderOl();
  }else if(STEP===4){
    b.innerHTML='<h2>Documents</h2><div class="muted">Upload clear scans or photos (JPG/PNG/PDF, ~6MB max).</div>'+
      docUploader('Passport photograph','photo')+docUploader('O\\'Level result','olevel')+docUploader('Birth certificate / age declaration','birth_cert')+docUploader('Other supporting document','other')+
      '<div class="docs" id="docList"></div>'+navBtns();
    renderDocs();
  }else{
    var d=APP||{};
    b.innerHTML='<h2>Review &amp; submit</h2><div class="muted">Confirm your details, then submit your application for review.</div>'+
      kv('Name',esc((d.first_name||'')+' '+(d.last_name||'')))+kv('Email',esc(d.email))+kv('Phone',esc(d.phone))+kv('Programme',esc(d.department_name||'—'))+kv('Level',esc(d.level_name||'—'))+kv('JAMB',esc(d.jamb_no||'—'))+kv('Documents',(d.documents||[]).length+' uploaded')+
      '<div class="btnrow"><button class="btn gho" onclick="STEP=4;renderWizard()">Back</button><button class="btn" id="subBtn" onclick="submitApp()">Submit Application</button></div>';
  }
}
function navBtns(){return '<div class="btnrow">'+(STEP>1?'<button class="btn gho" onclick="prevStep()">Back</button>':'')+'<button class="btn" onclick="nextStep()">Save &amp; Continue</button></div>';}
function kv(k,v){return '<div class="kv"><span class="muted">'+k+'</span><b>'+v+'</b></div>';}
function docUploader(label,kind){return '<label>'+label+'</label><input type="file" accept="image/*,application/pdf" onchange="uploadDoc(\\''+kind+'\\',this)">';}
function renderOl(){var w=el('olrows');var subs=OLEVEL[0].subjects||[];var h='';subs.forEach(function(s,i){h+='<div class="olrow"><input placeholder="Subject" value="'+esc(s.subject)+'" oninput="OLEVEL[0].subjects['+i+'].subject=this.value"><select onchange="OLEVEL[0].subjects['+i+'].grade=this.value">'+['','A1','B2','B3','C4','C5','C6','D7','E8','F9'].map(function(g){return '<option'+(s.grade===g?' selected':'')+'>'+g+'</option>';}).join('')+'</select><button class="btn gho" type="button" onclick="delOl('+i+')">×</button></div>';});w.innerHTML=h;}
function addOl(){OLEVEL[0].subjects.push({subject:'',grade:''});renderOl();}
function delOl(i){OLEVEL[0].subjects.splice(i,1);if(!OLEVEL[0].subjects.length)OLEVEL[0].subjects.push({subject:'',grade:''});renderOl();}
function renderDocs(){var w=el('docList');if(!w)return;var ds=(APP&&APP.documents)||[];w.innerHTML=ds.map(function(d){return '<div class="doc"><div style="font-size:30px">📄</div><div>'+esc(d.kind)+'</div><button class="del" onclick="delDoc(\\''+d.id+'\\')">×</button></div>';}).join('')||'<div class="muted">No documents yet.</div>';}

function collectStep(){
  var patch={stage:STEP};
  if(STEP===1){patch.first_name=el('w_first').value.trim();patch.last_name=el('w_last').value.trim();patch.middle_name=el('w_middle').value.trim();patch.gender=el('w_gender').value;patch.date_of_birth=el('w_dob').value;patch.phone=el('w_phone').value.trim();patch.nationality=el('w_nat').value.trim();patch.state_of_origin=el('w_state').value.trim();patch.address=el('w_addr').value.trim();patch.guardian_name=el('w_gname').value.trim();patch.guardian_relation=el('w_grel').value.trim();patch.guardian_phone=el('w_gphone').value.trim();patch.guardian_email=el('w_gemail').value.trim();}
  else if(STEP===2){patch.department_id=el('w_dept').value;patch.level_id=el('w_level').value;patch.email=el('w_email').value.trim();}
  else if(STEP===3){patch.jamb_no=el('w_jamb').value.trim();patch.jamb_score=el('w_jscore').value;patch.prev_school=el('w_school').value.trim();OLEVEL[0].exam=el('w_oexam').value.trim();OLEVEL[0].year=el('w_oyear').value.trim();patch.olevel=JSON.stringify(OLEVEL);}
  return patch;
}
async function saveStep(){var r=await api('/api/apply/save',{method:'POST',body:JSON.stringify(collectStep())});if(r&&r.ok){APP=r.application;return true;}err('wizErr',(r&&r.error)||'Could not save.');return false;}
async function nextStep(){if(STEP<=3){if(!await saveStep())return;}if(STEP<5){STEP++;renderWizard();}else{submitApp();}}
async function prevStep(){if(STEP<=3)await saveStep();if(STEP>1){STEP--;renderWizard();}}
async function uploadDoc(kind,input){
  var f=input.files&&input.files[0];if(!f)return;err('wizErr','');
  if(f.size>6*1024*1024){err('wizErr','That file is larger than 6MB.');return;}
  var rd=new FileReader();rd.onload=async function(){var r=await api('/api/apply/doc',{method:'POST',body:JSON.stringify({kind:kind,filename:f.name,content:rd.result})});if(r&&r.ok){APP=r.application;renderDocs();}else{err('wizErr',(r&&r.error)||'Upload failed.');}};rd.readAsDataURL(f);
}
async function delDoc(id){var r=await api('/api/apply/doc/delete',{method:'POST',body:JSON.stringify({id:id})});if(r&&r.ok){APP=r.application;renderDocs();}}
async function submitApp(){if(STEP===5){/* nothing extra to collect */}var sb=el('subBtn');if(sb)sb.disabled=true;var r=await api('/api/apply/submit',{method:'POST',body:JSON.stringify({})});if(sb)sb.disabled=false;if(!r.ok){err('wizErr',r.error||'Could not submit.');return;}APP=r.application;renderStatus();show('s-status');}

function statusPill(s){var m={submitted:['#dbeafe','#1e40af','Submitted — under review'],under_review:['#fef3c7','#92400e','Under review'],offered:['#ede9fe','#5b21b6','Offer made — pay to accept'],fee_paid:['#dcfce7','#166534','Fee paid'],admitted:['#dcfce7','#166534','Admitted 🎉'],rejected:['#fee2e2','#991b1b','Not successful'],withdrawn:['#f1f5f9','#475569','Withdrawn']};var c=m[s]||['#f1f5f9','#475569',s];return '<span class="pill" style="background:'+c[0]+';color:'+c[1]+'">'+c[2]+'</span>';}
function tlItem(label,done,now){return '<div class="i '+(done?'done':(now?'now':''))+'"><div class="dot">'+(done?'✓':'')+'</div><div class="ln">'+label+'</div></div>';}
function renderStatus(){
  var d=APP||{};var st=d.status;
  var order=['submitted','under_review','offered','fee_paid','admitted'];var idx=order.indexOf(st);if(st==='accepted')idx=2;
  var tl='<div class="tl">'+tlItem('Application submitted',idx>=0,idx===0)+tlItem('Under review',idx>=1,idx===1)+tlItem('Offer of admission',idx>=2,idx===2)+tlItem('Admission fee paid',idx>=3||d.admission_fee_paid,idx===3)+tlItem('Admitted',idx>=4,idx===4)+'</div>';
  var pay='';
  if((st==='offered'||st==='accepted')&&!d.admission_fee_paid&&Number(d.admission_fee_amount)>0){
    pay='<div class="card"><h3>Accept your offer — pay the admission fee</h3><div class="kv"><span class="muted">Admission fee</span><b>'+esc(d.admission_fee_currency||'NGN')+' '+Number(d.admission_fee_amount).toLocaleString()+'</b></div><div class="err" id="payErr"></div><div id="payArea"><button class="btn full" id="payBtn" onclick="pay()">Pay admission fee</button></div></div>';
  }
  if(d.admission_fee_paid&&st!=='admitted'){pay='<div class="ok">Your admission fee has been received. Your admission is being finalized — watch your email.</div>';}
  if(st==='admitted'){pay='<div class="card"><h3>Congratulations! 🎓</h3><div class="muted">You have been admitted. Your official admission letter and student portal login have been emailed to you. Sign in to the student portal to continue your registration.</div><a class="btn full" href="/" style="margin-top:10px">Go to student portal</a></div>';}
  if(st==='rejected'){pay='<div class="card"><div class="muted">'+(d.decision_note?esc(d.decision_note):'We are unable to offer you admission at this time.')+'</div></div>';}
  el('statusBody').innerHTML='<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">'+esc((d.first_name||'')+' '+(d.last_name||''))+'</h2>'+statusPill(st)+'</div><div class="muted">Application '+esc(d.app_no||'')+' • '+esc(d.department_name||'')+'</div>'+tl+'</div>'+pay+'<div class="btnrow"><button class="btn gho" onclick="logoutApp()">Sign out</button></div>';
}
async function pay(){
  err('payErr','');var pb=el('payBtn');if(pb)pb.disabled=true;
  var r=await api('/api/apply/pay',{method:'POST',body:JSON.stringify({})});
  if(pb)pb.disabled=false;
  if(!r.ok){err('payErr',r.error||'Could not start payment.');return;}
  if(r.mode==='paystack'&&r.authorization_url){location.href=r.authorization_url;return;}
  el('payArea').innerHTML='<div class="ok" style="text-align:left">Pay the admission fee by bank transfer:<br><b>'+esc(r.bank)+'</b></div><label>Payment reference / teller number</label><input id="payRef" placeholder="Enter your transfer reference"><button class="btn full" style="margin-top:8px" onclick="declarePay()">I have paid — notify the Bursary</button>';
}
async function declarePay(){var ref=(el('payRef')&&el('payRef').value.trim())||'';var r=await api('/api/apply/pay/declare',{method:'POST',body:JSON.stringify({ref:ref})});if(r&&r.ok){APP=r.application;el('payArea').innerHTML='<div class="ok">Thank you. Your payment has been recorded and will be confirmed by the Bursary. You will be admitted once confirmed.</div>';}}
function logoutApp(){TOKEN='';localStorage.removeItem('ubu_app_token');APP=null;show('s-landing');}
boot();
</script></body></html>`;

const MANIFEST_PORTAL = JSON.stringify({ name: 'UniBursar Portal', short_name: 'Portal', start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#0f1e3d', theme_color: '#1e3a8a', icons: [{ src: '/favicon', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }] });
const MANIFEST_SCAN = JSON.stringify({ name: 'UniBursar Clearance Scanner', short_name: 'Scanner', start_url: '/scan', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#0f1e3d', theme_color: '#0f1e3d', icons: [{ src: '/favicon', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }] });
const SW_JS = `const C='ubu-portal-v2';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/scan','/verify','/icon.svg']).catch(()=>{})).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(Promise.all([caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))),self.clients.claim()]));});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).catch(()=>caches.match(e.request).then(r=>r||caches.match('/'))));});`;

// shared client renderer for verification results (used by /scan and /verify)
const RESULT_JS = `
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(m){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m];});}
function office(o){return ({registrar:'Registrar',dean:'Dean / Faculty Head',student_affairs:'Student Affairs'})[o]||o;}
function row(k,v){return '<tr><td>'+k+'</td><td>'+esc(v||'—')+'</td></tr>';}
function extractId(raw){raw=String(raw||'').trim();var m=/[?&]c=([^&\\s]+)/.exec(raw);if(m)return decodeURIComponent(m[1]);return raw.replace(/^UBU-CLR:/i,'').trim();}
function extractCode(raw){raw=String(raw||'').trim();var m=/[?&]r=([^&\\s]+)/.exec(raw);if(m)return{type:'r',id:decodeURIComponent(m[1])};if(/^UBU-RCT:/i.test(raw))return{type:'r',id:raw.replace(/^UBU-RCT:/i,'').trim()};m=/[?&]c=([^&\\s]+)/.exec(raw);if(m)return{type:'c',id:decodeURIComponent(m[1])};return{type:'c',id:raw.replace(/^UBU-CLR:/i,'').trim()};}
function renderResult(el,d){
  if(!d||!d.valid){el.innerHTML='<div class="rcard invalid"><div class="big">✗ INVALID</div><p>This code does not match any record on file. The document may be forged, altered, or not yet issued.</p><button class="btn" onclick="resetView&&resetView()">Check another</button></div>';return;}
  if(d.kind==='receipt'){var rs=d.student;
    el.innerHTML='<div class="rcard valid">'+
     '<div class="big">✓ GENUINE RECEIPT</div>'+
     '<div class="who">'+(rs.photo?'<img src="'+rs.photo+'" alt="photo">':'<div class="ph">🧾</div>')+'<div><div class="nm">'+esc(rs.name)+'</div><div class="mt">'+esc(rs.matric)+'</div></div></div>'+
     '<table>'+row('Receipt No',d.receipt_no)+row('Amount paid',d.amountText)+row('Paid for',d.category)+row('Narration',d.narration)+row('Method',d.method)+row('Date',d.dateText)+row('Issued by',d.office)+row('Received by',d.receivedBy)+row('Faculty',rs.faculty)+row('Department',rs.department)+row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  if(d.kind==='payslip'){var ps=d.staff;
    el.innerHTML='<div class="rcard valid">'+
     '<div class="big">✓ GENUINE PAYSLIP</div>'+
     '<div class="who">'+(ps.photo?'<img src="'+ps.photo+'" alt="photo">':'<div class="ph">💼</div>')+'<div><div class="nm">'+esc(ps.name)+'</div><div class="mt">'+esc(ps.staffNo)+'</div></div></div>'+
     '<table>'+row('Type',d.staffType)+row('Department',ps.department)+row('Pay period',d.period)+row('Net pay',d.net)+row('Gross',d.gross)+row('Pay date',d.dateText)+row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  if(d.kind==='student'){var su=d.student;var act=String(su.status||'').toLowerCase()==='active';
    el.innerHTML='<div class="rcard '+(act?'valid':'warn')+'">'+
     '<div class="big">'+(act?'✓ GENUINE STUDENT':'⚠ '+String(su.status||'INACTIVE').toUpperCase())+'</div>'+
     '<div class="who">'+(su.photo?'<img src="'+su.photo+'" alt="photo">':'<div class="ph">🎓</div>')+'<div><div class="nm">'+esc(su.name)+'</div><div class="mt">'+esc(su.matric)+'</div></div></div>'+
     '<table>'+row('Faculty',su.faculty)+row('Department',su.department)+row('Level',su.level)+row('Student status',su.status)+(d.session?row('Session',d.session):'')+row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  if(d.kind==='result'){var rs=d.student;
    el.innerHTML='<div class="rcard valid">'+
     '<div class="big">✓ GENUINE RESULT</div>'+
     '<div class="who">'+(rs.photo?'<img src="'+rs.photo+'" alt="photo">':'<div class="ph">🎓</div>')+'<div><div class="nm">'+esc(rs.name)+'</div><div class="mt">'+esc(rs.matric)+'</div></div></div>'+
     '<table>'+row('Faculty',rs.faculty)+row('Department',rs.department)+row('Level',rs.level)+(d.session?row('Session',d.session):'')+(d.semester?row('Semester',d.semester):'')+row('Courses',String(d.courses))+row('GPA',String(d.gpa))+row('CGPA',String(d.cgpa))+row('Class standing',d.standing)+row('Verification ref',d.ref)+'</table>'+
     '<button class="btn" onclick="resetView&&resetView()">Check another</button></div>';
    return;}
  var s=d.student;var ok=d.completed;var tn=d.typeName||'Examination';var mid=d.clearanceType==='midterm';
  el.innerHTML='<div class="rcard '+(ok?'valid':'warn')+'">'+
   '<div class="big">'+(ok?'✓ CLEARED — '+tn.toUpperCase():'⚠ '+String(d.status||'NOT COMPLETE').toUpperCase())+'</div>'+
   '<div class="who">'+(s.photo?'<img src="'+s.photo+'" alt="photo">':'<div class="ph">🎓</div>')+'<div><div class="nm">'+esc(s.name)+'</div><div class="mt">'+esc(s.matric)+'</div></div></div>'+
   '<table>'+row('Clearance type',tn+' Clearance')+row('Faculty',s.faculty)+row('Department',s.department)+row('Level',s.level)+row('Gender',s.gender)+row('Student status',s.status)+row('Session',d.session)+row('Semester',d.semester)+row('Verification ref',d.ref)+'</table>'+
   '<div class="apps">'+(d.approvals||[]).map(function(a){return '<span class="ap '+(a.status==='approved'?'a':(a.status==='denied'?'x':'p'))+'">'+office(a.office)+': '+a.status+(a.by?(' ('+esc(a.by)+')'):'')+'</span>';}).join('')+'</div>'+
   (ok?'':'<p class="note">Not all offices have approved. Do NOT admit this student to the '+(mid?'mid-semester test':'examination')+'.</p>')+
   '<button class="btn" onclick="resetView&&resetView()">Scan another</button></div>';
}
async function doVerify(el,code){var q=(code&&code.type)?code.type:'c';var id=(code&&code.id!=null)?code.id:code;el.innerHTML='<div class="rcard"><div class="big">Checking…</div></div>';try{var r=await fetch('/api/verify?'+q+'='+encodeURIComponent(id));var d=await r.json();renderResult(el,d);}catch(e){renderResult(el,{valid:false});}}`;

const RESULT_CSS = `
.rcard{background:#fff;border-radius:16px;padding:18px;margin:14px;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.rcard .big{font-size:24px;font-weight:900;text-align:center;padding:8px;border-radius:10px;margin-bottom:12px}
.rcard.valid .big{background:#dcfce7;color:#166534}.rcard.invalid .big{background:#fee2e2;color:#991b1b}.rcard.warn .big{background:#fef9c3;color:#854d0e}
.who{display:flex;gap:14px;align-items:center;margin-bottom:12px}
.who img{width:90px;height:104px;object-fit:cover;border-radius:10px;border:2px solid #1e3a8a}
.who .ph{width:90px;height:104px;border-radius:10px;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:34px}
.who .nm{font-size:20px;font-weight:800}.who .mt{color:#64748b;font-family:monospace;font-weight:700}
.rcard table{width:100%;border-collapse:collapse}.rcard td{padding:7px 4px;border-bottom:1px solid #eef2f7;font-size:14px}
.rcard td:first-child{color:#64748b;width:42%}.rcard td:last-child{font-weight:600}
.apps{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.ap{font-size:11px;font-weight:700;border-radius:999px;padding:4px 10px}.ap.a{background:#dcfce7;color:#166534}.ap.x{background:#fee2e2;color:#991b1b}.ap.p{background:#fff7ed;color:#9a6300}
.note{color:#991b1b;font-weight:700;margin:10px 0}
.btn{display:block;width:100%;margin-top:14px;background:linear-gradient(135deg,#2563eb,#4338ca);color:#fff;border:0;border-radius:10px;padding:13px;font-weight:800;font-size:15px;cursor:pointer}`;

const SCAN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Clearance Scanner</title><link rel="manifest" href="/scan-manifest.webmanifest"><meta name="theme-color" content="#0f1e3d"><link rel="icon" href="/favicon">
<style>*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:#0f1e3d;color:#fff;min-height:100vh}
.bar{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#0b1730;font-size:15px}
.bar #st{font-size:12px;opacity:.85}
.stage{padding:8px}
video{width:100%;max-width:520px;display:block;margin:0 auto;border-radius:14px;background:#000;aspect-ratio:1/1;object-fit:cover}
.controls{display:flex;gap:10px;justify-content:center;margin:12px}
.controls .b{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:800;font-size:15px;cursor:pointer}
.controls .b.ghost{background:#1b2c4d}
.manual{display:flex;gap:8px;max-width:520px;margin:0 auto 6px;padding:0 12px}
.manual input{flex:1;padding:12px;border-radius:10px;border:0;font-size:14px}
.manual .b{background:#1b2c4d;color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:700}
.hint{max-width:520px;margin:6px auto;padding:0 16px;font-size:12.5px;opacity:.8;text-align:center}
#result{max-width:520px;margin:0 auto;color:#0f172a}
${RESULT_CSS}
</style></head><body>
<div class="bar"><b>🛡 Clearance Scanner</b><span id="st">Ready</span></div>
<div class="stage"><video id="v" playsinline muted></video></div>
<div class="controls"><button class="b" id="start">▶ Start camera</button><button class="b ghost" id="stop" style="display:none">■ Stop</button></div>
<div class="manual"><input id="code" placeholder="Or paste the code / link from the certificate" autocomplete="off"><button class="b" id="lk">Verify</button></div>
<div class="hint" id="hint">Point the camera at the QR code on the clearance certificate. The student's photo and details will appear so you can confirm them in person.</div>
<div id="result"></div>
<script>
${RESULT_JS}
var $=function(id){return document.getElementById(id);};
var stream=null,scanning=false,det=null,raf=null;
function setStatus(t){$('st').textContent=t;}
function resetView(){$('result').innerHTML='';setStatus('Ready');}
async function startCam(){
  try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});var v=$('v');v.srcObject=stream;await v.play();$('start').style.display='none';$('stop').style.display='';setStatus('Scanning…');loop();}
  catch(e){setStatus('No camera');$('hint').textContent='Could not open the camera ('+e.message+'). Tip: scan the QR with your phone\\'s built-in camera — it opens the verification page directly — or paste the code below.';}
}
function stopCam(){scanning=false;if(raf)cancelAnimationFrame(raf);if(stream){stream.getTracks().forEach(function(t){t.stop();});stream=null;}$('start').style.display='';$('stop').style.display='none';}
async function loop(){
  if(!stream)return;scanning=true;
  if('BarcodeDetector' in window){
    if(!det)det=new BarcodeDetector({formats:['qr_code']});
    var v=$('v');
    var tick=async function(){if(!scanning)return;try{var codes=await det.detect(v);if(codes&&codes.length){onCode(codes[0].rawValue);return;}}catch(_){}raf=requestAnimationFrame(tick);};
    tick();
  } else {
    $('hint').textContent='In-app scanning is not supported by this browser. Scan the QR with your phone camera (it opens the verification page automatically), or paste the code below.';
    setStatus('Manual mode');
  }
}
function onCode(raw){stopCam();setStatus('Found code');doVerify($('result'),extractCode(raw));}
$('start').onclick=startCam;$('stop').onclick=stopCam;
$('lk').onclick=function(){doVerify($('result'),extractCode($('code').value));};
$('code').addEventListener('keydown',function(e){if(e.key==='Enter')doVerify($('result'),extractCode($('code').value));});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(function(){});
</script></body></html>`;

const VERIFY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Document Verification</title><link rel="icon" href="/favicon"><meta name="theme-color" content="#0f1e3d">
<style>*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;background:#eef2f8;color:#0f172a;min-height:100vh}
.bar{background:#0f1e3d;color:#fff;padding:14px 16px;font-weight:700}
#result{max-width:560px;margin:0 auto}
.lookup{max-width:560px;margin:14px auto;padding:0 14px;display:flex;gap:8px}
.lookup input{flex:1;padding:12px;border-radius:10px;border:1px solid #cbd5e1}
.lookup .b{background:#1e3a8a;color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:700}
${RESULT_CSS}
</style></head><body>
<div class="bar">🛡 Document Verification</div>
<div class="lookup"><input id="code" placeholder="Clearance or receipt code / link"><button class="b" id="lk">Verify</button></div>
<div id="result"></div>
<script>
${RESULT_JS}
function resetView(){location.href='/scan';}
var el=document.getElementById('result');
var q=new URLSearchParams(location.search);var rr=q.get('r');var pp=q.get('p');var st=q.get('student');var c=q.get('c')||q.get('ref');
document.getElementById('lk').onclick=function(){doVerify(el,extractCode(document.getElementById('code').value));};
if(st){document.getElementById('code').value=st;doVerify(el,{type:'student',id:st});}
else if(pp){document.getElementById('code').value=pp;doVerify(el,{type:'p',id:pp});}
else if(rr){document.getElementById('code').value=rr;doVerify(el,{type:'r',id:rr});}
else if(c){document.getElementById('code').value=c;doVerify(el,extractCode(c));}
</script></body></html>`;

