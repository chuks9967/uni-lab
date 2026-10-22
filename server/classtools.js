'use strict';
/**
 * 🎓 THE LIVE-CLASS TOOLKIT — the toolbar sets and the in-class materials drawer, owned in ONE place
 * and used by BOTH class pages (electron/services/liveclasses.js on the desktop, server/portal.js on
 * the web/APK).
 *
 * ⚠ WHY SHARED. The two pages were built separately and had already drifted apart in the worst
 * possible direction: the DESKTOP host (an administrator, who rarely teaches) had the whiteboard,
 * the shared notes, audio-only sharing and live captions, while the PORTAL host — the LECTURER, the
 * person actually teaching the class — did not. A teaching tool that exists but is not on the
 * lecturer's screen might as well not exist, and nothing in either file said the two lists were
 * meant to match. Now there is one list, and a tool added here reaches every seat at once.
 *
 * Pure string/array building — no DOM, no network, no Jitsi import — so it is unit-testable
 * (test/classtools.js) and safe to require from the Deno edge bundle.
 */

/**
 * WHAT A LECTURER NEEDS TO TEACH. Each entry earns its place:
 *   desktop          — share the screen. The single most-used tool in an online lecture.
 *   whiteboard       — work a derivation live. Slides cannot answer "where did that step come from?".
 *   etherpad          — shared notes the class writes together and keeps afterwards.
 *   sharedvideo      — play a clip IN SYNC for everyone, instead of "go and watch this later".
 *   shareaudio       — audio-only sharing: a recording, a heart-sound, a language sample, at a
 *                      fraction of the bandwidth of screen-sharing a media player.
 *   closedcaptions   — live captions. Accessibility, and a lifeline for a second-language cohort.
 *   recording        — the students on bad connections watch it back. See RECORDING_NOTE.
 *   livestreaming    — a class too large for a call still gets taught.
 *   participants-pane, mute-everyone, mute-video-everyone, security — running a room of 200.
 *   raisehand, chat, reactions — the only way a student interrupts politely.
 *   select-background — a lecturer teaching from home should not have to tidy the room.
 *   stats            — "is it me or is it them?", answerable instead of guessable.
 */
const HOST_TOOLBAR = [
  'microphone', 'camera', 'desktop', 'chat', 'raisehand', 'reactions', 'participants-pane',
  'tileview', 'toggle-camera', 'select-background', 'security', 'recording', 'livestreaming',
  'mute-everyone', 'mute-video-everyone', 'settings', 'fullscreen', 'hangup', 'invite',
  'sharedvideo', 'whiteboard', 'etherpad', 'shareaudio', 'closedcaptions', 'videoquality', 'stats', 'feedback',
];

/**
 * WHAT A STUDENT GETS. Deliberately smaller — not to be mean, but because a student who can
 * mute-everyone or stop the recording can end the lecture for two hundred people by mis-tapping.
 *
 * `desktop` is NOT here by default: an unmoderated screen-share over the lecturer is the classic way
 * an online class gets hijacked. A lecturer grants it per-student instead (see PRESENTER_GRANT), so
 * a student presenting their project is one tap for the lecturer and impossible for anyone else.
 * `closedcaptions` IS here: accessibility is not a privilege the host hands out.
 */
const STUDENT_TOOLBAR = [
  'microphone', 'camera', 'chat', 'raisehand', 'reactions', 'tileview', 'toggle-camera',
  'select-background', 'closedcaptions', 'videoquality', 'settings', 'fullscreen', 'hangup',
];

/**
 * A student the lecturer has promoted to present: the same as a student, plus screen-sharing.
 *
 * ⚠ Kept for completeness, but the LIVE grant does not use it, and the reason is worth stating:
 * `TOOLBAR_BUTTONS` is fixed when the Jitsi frame is constructed, so switching a student to this
 * list mid-class would mean tearing the conference down and rebuilding it — the student would drop
 * out of the lecture to be allowed to present in it. `executeCommand('toggleShareScreen')` is NOT
 * gated by the toolbar config, so `presenterJs` below grants by revealing our OWN button instead.
 */
const PRESENTER_TOOLBAR = STUDENT_TOOLBAR.concat(['desktop']);

/** Serialised for embedding in the page's interfaceConfigOverwrite. */
const toolbarJson = (list) => JSON.stringify(list);

/**
 * ⚠ RECORDING IS NOT AUTOMATIC, and a lecturer must be told so BEFORE the class, not after. On the
 * public meet.jit.si the record button needs a linked Dropbox account; on a self-hosted deployment it
 * needs Jibri running. Neither is something the app can supply. The honest failure mode is a lecturer
 * who taught for an hour believing it was being recorded — so the class page says this up front.
 */
const RECORDING_NOTE = 'The 🔴 Record button records this class in your browser and saves it to the cloud — the whole class is then emailed a link to watch it. It works on any Jitsi server (no Dropbox or Jibri needed), but you must be on a computer (phones cannot screen-record) and the institution must have the online portal + cloud storage configured.';

/**
 * The in-class MATERIALS DRAWER: a slide-out panel listing everything shared with this class, so a
 * student can open the reading WHILE the lecture is running rather than hunting for it afterwards.
 *
 * Built as plain strings because it is injected into two self-contained pages that have no build
 * step and (on the desktop) run under a strict CSP with no framework available.
 *
 * `endpoint` is where the list is fetched, `fileBase` is the per-material payload URL prefix, and
 * `token` is appended when the page is running inside the native app (which has no cookies).
 */
function drawerCss() {
  return [
    '#matBtn{position:fixed;right:14px;bottom:84px;z-index:30;border:0;cursor:pointer;background:#1d4ed8;color:#fff;',
    'padding:11px 15px;border-radius:999px;font-weight:700;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.45)}',
    '#matBtn .n{background:#fff;color:#1d4ed8;border-radius:999px;padding:1px 7px;margin-left:6px;font-size:11px}',
    '#matPanel{position:fixed;top:0;right:0;bottom:0;width:min(390px,92vw);z-index:31;background:#0f1e3d;',
    'border-left:1px solid #1e3a8a;transform:translateX(102%);transition:transform .22s ease;display:flex;flex-direction:column}',
    '#matPanel.open{transform:none}',
    '#matPanel header{display:flex;align-items:center;gap:8px;padding:13px 14px;border-bottom:1px solid #1e3a8a;font-weight:700}',
    '#matPanel header .sp{flex:1}#matPanel header button{background:#1e293b;color:#fff;border:0;border-radius:8px;padding:6px 11px;cursor:pointer}',
    '#matList{overflow:auto;padding:10px 12px;gap:9px;display:flex;flex-direction:column}',
    '.mat{background:#132347;border:1px solid #1e3a8a;border-radius:10px;padding:10px 12px}',
    '.mat b{display:block;font-size:13.5px;margin-bottom:2px}',
    '.mat .meta{font-size:11.5px;opacity:.72;margin-bottom:7px}',
    '.mat .pin{font-size:10.5px;background:#b45309;padding:1px 7px;border-radius:999px;margin-left:6px}',
    '.mat a{display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:6px 12px;border-radius:8px;font-size:12.5px;font-weight:600}',
    '.mat p{margin:0 0 7px;font-size:12.5px;opacity:.85;line-height:1.45}',
    '#matEmpty{opacity:.7;font-size:13px;padding:18px 4px;line-height:1.55}',
  ].join('');
}

function drawerHtml() {
  return '<button id="matBtn" type="button" onclick="ubMat.toggle()">📚 Materials<span class="n" id="matN">0</span></button>'
    + '<div id="matPanel"><header>📚 Class materials<span class="sp"></span>'
    + '<button type="button" onclick="ubMat.reload()">↻</button>'
    + '<button type="button" onclick="ubMat.toggle()">✕</button></header>'
    + '<div id="matList"><div id="matEmpty">Loading…</div></div></div>';
}

const KIND_ICON = { reading: '📄', slides: '📊', video: '🎬', audio: '🎧', image: '🖼', link: '🔗', other: '📎' };

/**
 * The drawer's behaviour. Refreshes on open AND on a slow timer, because a lecturer very often shares
 * the slides a minute INTO the lecture — a drawer that only loaded once would show "nothing shared
 * yet" for the rest of the hour.
 */
function drawerJs({ listUrl, fileBase, room, course, token, seed }) {
  return `(function(){
  var ROOM=${JSON.stringify(String(room || ''))}, COURSE=${JSON.stringify(String(course || ''))};
  var TOK=${JSON.stringify(String(token || ''))};
  // fall back to the in-class token the page publishes (the live session token) so an authenticated
  // fetch carries it even when none was baked server-side — see the portal class page.
  // ⚠ resolved WHEN A REQUEST IS MADE, not at load: on the portal class page this script runs before the page
  // publishes __ubRecToken, so reading it once here left TOK empty and every materials request was a 401.
  function tok(){ if(TOK) return TOK; try{ return window.__ubRecToken||new URLSearchParams(location.search).get('t')||localStorage.getItem('ubu_token')||''; }catch(e){ return ''; } }
  var ICON=${JSON.stringify(KIND_ICON)};
  // ⚠ SEEDED, not fetched, on the DESKTOP host: that page runs in a sandboxed BrowserWindow with no
  // IPC and no portal session, so a fetch would 401 and the drawer would sit empty for the one person
  // who most needs to know what the class can see. The desktop builds the list from its own database
  // when it builds the page — which also means it works with no internet at all.
  var SEED=${seed ? JSON.stringify(seed) : 'null'};
  var LIST_URL=${JSON.stringify(String(listUrl || ''))};
  function q(){var a=[];if(ROOM)a.push('room='+encodeURIComponent(ROOM));if(COURSE)a.push('course='+encodeURIComponent(COURSE));var tk=tok();if(tk)a.push('t='+encodeURIComponent(tk));return a.length?('?'+a.join('&')):'';}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
  function fileUrl(id){return ${JSON.stringify(String(fileBase || ''))}+encodeURIComponent(id)+(tok()?('?t='+encodeURIComponent(tok())):'');}
  var open=false;
  function render(list){
    var el=document.getElementById('matList'); if(!el)return;
    var n=document.getElementById('matN'); if(n)n.textContent=String(list.length);
    var btn=document.getElementById('matBtn'); if(btn)btn.style.display=list.length?'':'none';
    if(!list.length){el.innerHTML='<div id="matEmpty">Nothing has been shared with this class yet. Your lecturer can share readings, slides, recordings and links here — check back during the lecture.</div>';return;}
    el.innerHTML=list.map(function(m){
      var href=m.url?m.url:(m.hasFile?fileUrl(m.id):'');
      var meta=[(m.kind||'other'),m.course_code||'',m.size_bytes?Math.round(m.size_bytes/1024)+' KB':''].filter(Boolean).join(' · ');
      return '<div class="mat"><b>'+(ICON[m.kind]||ICON.other)+' '+esc(m.title)+(m.pinned?'<span class="pin">READ FIRST</span>':'')+'</b>'
        +'<div class="meta">'+esc(meta)+'</div>'
        +(m.description?'<p>'+esc(m.description)+'</p>':'')
        +(href?'<a href="'+esc(href)+'" target="_blank" rel="noopener">'+(m.url?'Open link':'Open')+'</a>':'')
        +'</div>';
    }).join('');
  }
  function load(){
    if(!LIST_URL){ if(SEED)render(SEED); return; }
    fetch(LIST_URL+q()).then(function(r){return r.json();}).then(function(d){
      render((d&&d.materials)||[]);
    }).catch(function(){ if(SEED)render(SEED); });
  }
  window.ubMat={
    toggle:function(){var p=document.getElementById('matPanel');if(!p)return;open=!open;p.classList.toggle('open',open);if(open)load();},
    reload:load
  };
  if(SEED)render(SEED);
  load();
  // a lecturer very often shares the slides a minute INTO the lecture; without this the drawer would
  // say "nothing shared yet" for the rest of the hour
  setInterval(function(){ if(open)load(); }, 45000);
})();`;
}

/**
 * 🎤 LETTING A STUDENT PRESENT — the one thing a lecture needs that a locked-down student seat cannot
 * do, and the reason `desktop` is withheld from students in the first place.
 *
 * A student presenting their project, or working a problem on their own screen, is ordinary teaching.
 * But an UNMODERATED screen-share is how an online class gets hijacked, so it cannot simply be on.
 *
 * THE MECHANISM, and why this one: the grant travels over Jitsi's own endpoint-message channel
 * (`sendEndpointTextMessage`), which is exactly what that channel is for. That means:
 *   • no server state, no table, no polling — nothing to get out of sync or to clean up;
 *   • it works on meet.jit.si, on 8x8 JaaS and on a self-hosted server identically;
 *   • it is scoped to the conference, so a grant cannot leak past the class it was given in.
 * The student's frame is never rebuilt — `executeCommand('toggleShareScreen')` is not gated by
 * `TOOLBAR_BUTTONS`, so revealing our own button is enough. Rebuilding the frame would drop the
 * student out of the lecture in order to let them speak in it.
 *
 * Revocation is explicit AND automatic: the lecturer can take it back, and the student's own page
 * drops the permission when they stop sharing, so a grant for one presentation is not a grant for
 * the rest of the term.
 */
function presenterCss() {
  return [
    '#presBtn,#shareBtn{border:0;cursor:pointer;color:#fff;font-size:12.5px;font-weight:700;padding:7px 12px;border-radius:8px}',
    '#presBtn{background:#4338ca}#shareBtn{background:#0f766e;display:none}',
    '#presPanel{position:fixed;top:52px;right:14px;z-index:32;background:#0f1e3d;border:1px solid #1e3a8a;',
    'border-radius:12px;padding:10px;min-width:250px;max-height:60vh;overflow:auto;display:none}',
    '#presPanel h4{margin:0 0 8px;font-size:13px}',
    '#presPanel .row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed #1e3a8a}',
    '#presPanel .row:last-child{border-bottom:0}#presPanel .row .nm{flex:1;font-size:12.5px}',
    '#presPanel .row button{border:0;cursor:pointer;border-radius:7px;padding:5px 9px;font-size:11.5px;font-weight:700;color:#fff;background:#1d4ed8}',
    '#presPanel .row button.off{background:#7f1d1d}',
    '#presPanel .none{opacity:.7;font-size:12px;padding:6px 0}',
  ].join('');
}

/** The host's control and the student's revealed button — one markup for both, hidden per seat. */
function presenterHtml(isHost) {
  return isHost
    ? '<button id="presBtn" type="button" onclick="ubPres.toggle()">🎤 Let a student present</button>'
      + '<div id="presPanel"><h4>Who may share their screen?</h4><div id="presList"></div></div>'
    : '<button id="shareBtn" type="button" onclick="ubPres.share()">🖥 Share my screen</button>';
}

function presenterJs(isHost) {
  return `(function(){
  var api=window.__ubApi; if(!api){window.ubPres={toggle:function(){},share:function(){}};return;}
  var IS_HOST=${isHost ? 'true' : 'false'};
  var granted={};                       // host's view: participantId -> true
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
  function send(id,on){
    try{api.executeCommand('sendEndpointTextMessage',id,JSON.stringify({ub:'presenter',on:!!on}));}catch(e){}
  }
  if(IS_HOST){
    function draw(){
      var el=document.getElementById('presList'); if(!el)return;
      var me=null; try{me=api._myUserID||null;}catch(e){}
      var ps=[]; try{ps=api.getParticipantsInfo()||[];}catch(e){}
      ps=ps.filter(function(p){return p.participantId!==me;});
      if(!ps.length){el.innerHTML='<div class="none">Nobody else has joined yet.</div>';return;}
      el.innerHTML=ps.map(function(p){
        var on=!!granted[p.participantId];
        return '<div class="row"><span class="nm">'+esc(p.formattedDisplayName||p.displayName||'Student')+'</span>'
          +'<button class="'+(on?'off':'')+'" onclick="ubPres.set(\\''+p.participantId+'\\','+(on?'false':'true')+')">'+(on?'Stop':'Allow')+'</button></div>';
      }).join('');
    }
    window.ubPres={
      toggle:function(){var p=document.getElementById('presPanel');if(!p)return;var open=p.style.display!=='block';p.style.display=open?'block':'none';if(open)draw();},
      set:function(id,on){granted[id]=!!on;send(id,on);draw();},
      share:function(){}
    };
    // keep the list honest as people come and go — a stale list grants the wrong person
    try{api.addEventListener('participantJoined',function(){var p=document.getElementById('presPanel');if(p&&p.style.display==='block')draw();});}catch(e){}
    try{api.addEventListener('participantLeft',function(e){if(e&&e.id)delete granted[e.id];var p=document.getElementById('presPanel');if(p&&p.style.display==='block')draw();});}catch(e){}
  } else {
    var may=false;
    function show(on){may=!!on;var b=document.getElementById('shareBtn');if(b)b.style.display=on?'':'none';}
    window.ubPres={toggle:function(){},share:function(){ if(may){try{api.executeCommand('toggleShareScreen');}catch(e){}} }};
    try{api.addEventListener('endpointTextMessageReceived',function(e){
      var raw=(e&&e.data&&e.data.eventData&&e.data.eventData.text)||(e&&e.eventData&&e.eventData.text)||'';
      var d=null; try{d=JSON.parse(raw);}catch(_){return;}
      if(!d||d.ub!=='presenter')return;
      show(!!d.on);
    });}catch(e){}
    // a grant for ONE presentation is not a grant for the rest of the term: once they stop sharing,
    // the permission goes with it and the lecturer grants again if they want more
    try{api.addEventListener('screenSharingStatusChanged',function(e){ if(e&&e.on===false)show(false); });}catch(e){}
  }
})();`;
}

/**
 * 📶 LOW-DATA MODE — the difference between attending the lecture and not attending at all.
 *
 * This cohort attends on mobile data, often 3G, on bundles bought by the megabyte. A full-video Jitsi
 * call is simply unaffordable for a two-hour lecture, so the honest outcome without this is not "a
 * grainy class" — it is a student who stops coming. Jitsi's own quality dialog can do it, buried two
 * menus deep; a lecture is not the moment to go hunting through settings.
 *
 * WHAT IT DOES, in the order that matters for bytes:
 *   1. stops sending OUR video (uploading a camera stream is the single most expensive thing a
 *      student's phone does in a call, and nobody is looking at them anyway);
 *   2. caps INCOMING video at 180p;
 *   3. keeps audio and screen-share untouched — the lecturer's voice and slides are the lecture.
 *
 * ⚠ IT IS REMEMBERED. A student who needs low data needs it in every class, and one that had to be
 * re-found each lecture would be the same as not having it. The choice is kept per device and
 * re-applied on join, so it costs them one tap ever.
 */
function lowDataCss() {
  return '#lowBtn{border:0;cursor:pointer;color:#fff;background:#334155;font-size:12.5px;font-weight:700;padding:7px 12px;border-radius:8px}'
    + '#lowBtn.on{background:#15803d}';
}
function lowDataHtml() {
  return '<button id="lowBtn" type="button" title="Use much less data (about 60–90 MB an hour instead of 400–900) — stops sending your camera and lowers the incoming video quality" onclick="ubLow.toggle()">📶 Low data</button>';
}
function lowDataJs() {
  return `(function(){
  var api=window.__ubApi; if(!api){window.ubLow={toggle:function(){}};return;}
  var KEY='ubu_lowdata';
  function saved(){try{return localStorage.getItem(KEY)==='1';}catch(e){return false;}}
  function save(v){try{localStorage.setItem(KEY,v?'1':'0');}catch(e){}}
  // the app opens the class with ld=1 on mobile data: low data then, without making it this device's lasting choice —
  // and never over a choice the student made here
  var auto=(function(){try{return location.search.indexOf('ld=1')>=0&&localStorage.getItem(KEY)===null;}catch(e){return false;}})();
  var on=false;
  function paint(){var b=document.getElementById('lowBtn');if(b){b.classList.toggle('on',on);b.textContent=on?'📶 Low data ON':'📶 Low data';}}
  function apply(v,keep){
    on=!!v; if(keep!==false)save(on); paint();
    // 180p is Jitsi's lowest standard rung; 720 is its default "high"
    try{api.executeCommand('setVideoQuality',on?180:720);}catch(e){}
    // …and stop UPLOADING our own camera, which is the expensive half. Checked first so a student who
    // already had their camera off is not toggled back ON by choosing to save data.
    try{api.isVideoMuted().then(function(muted){ if(on!==!!muted){try{api.executeCommand('toggleVideo');}catch(e){}} });}catch(e){}
  }
  window.ubLow={toggle:function(){apply(!on);}};
  // re-apply the remembered choice once the conference is actually up — commands sent before the
  // participant has joined are dropped on the floor
  try{api.addEventListener('videoConferenceJoined',function(){ if(saved())apply(true); else if(auto)apply(true,false); else paint(); });}catch(e){paint();}
  paint();
})();`;
}

/**
 * ❓ THE IN-CLASS Q&A PANEL.
 *
 * Jitsi's chat is ephemeral, so every question asked in a lecture was thrown away with the call. This
 * panel keeps them: a student asks (optionally anonymously), the room upvotes what it also wants to
 * know, and the lecturer answers — and the thread outlives the session under the course.
 *
 * ⚠ PORTAL ONLY. Both seats here need to READ and WRITE through an authenticated session, and the
 * desktop class window is a sandboxed BrowserWindow with no portal token — which is also why its
 * materials drawer is seeded rather than fetched. A desktop host answers from the Live Classes desk
 * instead, over IPC, where the writes actually work.
 */
function qaCss() {
  return [
    '#qaBtn{position:fixed;right:14px;bottom:26px;z-index:30;border:0;cursor:pointer;background:#7c3aed;color:#fff;',
    'padding:11px 15px;border-radius:999px;font-weight:700;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.45)}',
    '#qaBtn .n{background:#fff;color:#7c3aed;border-radius:999px;padding:1px 7px;margin-left:6px;font-size:11px}',
    '#qaPanel{position:fixed;top:0;right:0;bottom:0;width:min(400px,94vw);z-index:31;background:#0f1e3d;',
    'border-left:1px solid #1e3a8a;transform:translateX(102%);transition:transform .22s ease;display:flex;flex-direction:column}',
    '#qaPanel.open{transform:none}',
    '#qaPanel header{display:flex;align-items:center;gap:8px;padding:13px 14px;border-bottom:1px solid #1e3a8a;font-weight:700}',
    '#qaPanel header .sp{flex:1}#qaPanel header button{background:#1e293b;color:#fff;border:0;border-radius:8px;padding:6px 11px;cursor:pointer}',
    '#qaList{overflow:auto;padding:10px 12px;flex:1;display:flex;flex-direction:column;gap:9px}',
    '#qaAsk{border-top:1px solid #1e3a8a;padding:10px 12px}',
    '#qaAsk textarea{width:100%;box-sizing:border-box;background:#132347;color:#fff;border:1px solid #1e3a8a;border-radius:9px;padding:8px;font:inherit;font-size:13px;resize:vertical}',
    '#qaAsk .r{display:flex;align-items:center;gap:10px;margin-top:7px}#qaAsk .r label{font-size:12px;opacity:.85}',
    '#qaAsk button{margin-left:auto;background:#7c3aed;color:#fff;border:0;border-radius:8px;padding:7px 14px;font-weight:700;cursor:pointer}',
    '.qa{background:#132347;border:1px solid #1e3a8a;border-radius:10px;padding:10px 12px}',
    '.qa .who{font-size:11px;opacity:.7;margin-bottom:3px}',
    '.qa .b{font-size:13.5px;line-height:1.45}',
    '.qa .ans{margin-top:7px;padding:7px 9px;background:#14532d;border-radius:8px;font-size:12.5px;line-height:1.45}',
    '.qa .act{display:flex;gap:8px;align-items:center;margin-top:7px}',
    '.qa .act button{background:#1e293b;color:#fff;border:0;border-radius:7px;padding:5px 10px;font-size:11.5px;cursor:pointer}',
    '.qa .act button.on{background:#7c3aed}',
    '#qaEmpty{opacity:.7;font-size:13px;padding:16px 4px;line-height:1.55}',
  ].join('');
}

function qaHtml(isHost) {
  return '<button id="qaBtn" type="button" onclick="ubQa.toggle()">❓ Questions<span class="n" id="qaN">0</span></button>'
    + '<div id="qaPanel"><header>❓ Questions<span class="sp"></span>'
    + '<button type="button" onclick="ubQa.reload()">↻</button>'
    + '<button type="button" onclick="ubQa.toggle()">✕</button></header>'
    + '<div id="qaList"><div id="qaEmpty">Loading…</div></div>'
    + (isHost ? '' : '<div id="qaAsk"><textarea id="qaText" rows="2" placeholder="Ask your lecturer a question…"></textarea>'
      + '<div class="r"><label><input type="checkbox" id="qaAnon"> Ask anonymously</label>'
      + '<button type="button" onclick="ubQa.send()">Ask</button></div></div>')
    + '</div>';
}

function qaJs({ isHost, room, course, token }) {
  return `(function(){
  var ROOM=${JSON.stringify(String(room || ''))}, COURSE=${JSON.stringify(String(course || ''))};
  var TOK=${JSON.stringify(String(token || ''))}, IS_HOST=${isHost ? 'true' : 'false'};
  try{ if(!TOK && window.__ubRecToken) TOK=window.__ubRecToken; }catch(e){}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
  function tok(){ if(TOK) return TOK; try{ return window.__ubRecToken||new URLSearchParams(location.search).get('t')||localStorage.getItem('ubu_token')||''; }catch(e){ return ''; } }
  function q(){var a=[];if(ROOM)a.push('room='+encodeURIComponent(ROOM));if(COURSE)a.push('course='+encodeURIComponent(COURSE));var tk=tok();if(tk)a.push('t='+encodeURIComponent(tk));return a.length?('?'+a.join('&')):'';}
  var open=false,items=[];
  function render(){
    var el=document.getElementById('qaList'); if(!el)return;
    // the badge counts what is UNANSWERED — the number a lecturer actually needs
    var n=items.filter(function(x){return !x.resolved;}).length;
    var b=document.getElementById('qaN'); if(b)b.textContent=String(n);
    if(!items.length){el.innerHTML='<div id="qaEmpty">'+(IS_HOST?'Nobody has asked anything yet. Questions appear here as they are asked, most-wanted first.':'No questions yet. Ask the first one \\u2014 you can do it anonymously.')+'</div>';return;}
    el.innerHTML=items.map(function(x){
      // the lecturer is the one IN the room, so they are the one who must be able to take down what
      // is disrupting it — moderation used to sit only with the administration, who are not present
      var act=IS_HOST
        ? '<button type="button" onclick="ubQa.answer(\\''+x.id+'\\')">'+(x.resolved?'Edit answer':'Answer')+'</button>'
          +'<button type="button" onclick="ubQa.drop(\\''+x.id+'\\')" title="Remove — for an off-topic or abusive question, not an awkward one">Remove</button>'
        : '<button type="button" class="'+(x.voted?'on':'')+'" onclick="ubQa.vote(\\''+x.id+'\\')">\\u25B2 '+(x.voted?'Same question':'I have this too')+' ('+x.upvotes+')</button>';
      return '<div class="qa"><div class="who">'+esc(x.asked_by)+(x.mine?' \\u00b7 you':'')+(x.resolved?' \\u00b7 answered':'')+'</div>'
        +'<div class="b">'+esc(x.body)+'</div>'
        +(x.answer?('<div class="ans"><b>Answer:</b> '+esc(x.answer)+'</div>'):'')
        +'<div class="act">'+act+'</div></div>';
    }).join('');
  }
  function load(){
    fetch('/api/class-questions'+q()).then(function(r){return r.json();}).then(function(d){
      items=(d&&d.questions)||[]; render();
    }).catch(function(){});
  }
  window.ubQa={
    toggle:function(){var p=document.getElementById('qaPanel');if(!p)return;open=!open;p.classList.toggle('open',open);if(open)load();},
    reload:load,
    send:function(){
      var t=document.getElementById('qaText'); if(!t||!t.value.trim())return;
      var anon=!!(document.getElementById('qaAnon')||{}).checked;
      fetch('/api/class-question'+(TOK?('?t='+encodeURIComponent(TOK)):''),{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({room:ROOM,course_code:COURSE,body:t.value.trim(),anonymous:anon})})
        .then(function(r){return r.json();}).then(function(d){ if(d&&d.ok){t.value='';load();} }).catch(function(){});
    },
    vote:function(id){
      fetch('/api/class-question-vote'+(TOK?('?t='+encodeURIComponent(TOK)):''),{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:id})}).then(function(){load();}).catch(function(){});
    },
    answer:function(id){
      var cur=(items.find(function(x){return x.id===id;})||{}).answer||'';
      var a=prompt('Your answer (leave empty to mark it unanswered again):',cur);
      if(a===null)return;
      fetch('/api/staff/answer-question'+(TOK?('?t='+encodeURIComponent(TOK)):''),{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:id,text:a})}).then(function(r){return r.json();}).then(function(d){ if(d&&d.ok)load(); }).catch(function(){});
    },
    drop:function(id){
      if(!confirm('Remove this question?\\n\\nUse this for an off-topic or abusive question \\u2014 not for one that is merely awkward.'))return;
      fetch('/api/staff/question-remove'+(TOK?('?t='+encodeURIComponent(TOK)):''),{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:id})}).then(function(r){return r.json();}).then(function(d){ if(d&&d.ok)load(); }).catch(function(){});
    }
  };
  load();
  // refresh while the panel is open — questions arrive DURING the lecture, which is the whole point
  setInterval(function(){ if(open)load(); }, 20000);
  // …and keep the unanswered badge current even when it is closed, so a lecturer sees them arrive
  setInterval(function(){ if(!open)load(); }, 60000);
})();`;
}

/**
 * 🔴 CLOUD RECORDING — browser-local capture, the backend-agnostic way.
 *
 * Jitsi's own record button needs Jibri (self-host) or a linked Dropbox (meet.jit.si), and neither is
 * something this app can supply — so for years a lecturer could "record" and never get the file. This
 * records the class IN THE HOST'S OWN BROWSER (getDisplayMedia for the shared screen/tab + audio,
 * MediaRecorder to webm) and streams it in small chunks to the portal, which saves it to the cloud
 * storage the app already has and emails the cohort a watch link. It works identically on meet.jit.si,
 * 8x8 JaaS and a self-hosted server, because it never touches the Jitsi recorder at all.
 *
 * ⚠ ONE IMPLEMENTATION, BOTH SEATS. The desktop class window and the staff-portal page inject the exact
 * same builder — `<base>` is same-origin '' on the portal and the published portal URL on the desktop
 * window, and `<token>` is the page's own session token on the portal or a short-lived HMAC upload
 * token on the desktop (server/recordingrules.js). Chunked because a full lecture is hundreds of MB and
 * the portal caps request bodies; each ~8s chunk is a few hundred KB.
 *
 * HOST-ONLY, and only where it can actually work: getDisplayMedia + MediaRecorder are desktop-browser
 * features (phones cannot screen-record), and cloud save needs a portal base — so the button is hidden
 * for students, and explains itself instead of failing silently when the environment can't support it.
 */
function recorderCss() {
  return [
    '#recBtn{border:0;cursor:pointer;color:#fff;background:#7f1d1d;font-size:12.5px;font-weight:700;padding:7px 12px;border-radius:8px}',
    '#recBtn.on{background:#b91c1c}',
    '#recDot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#fff;margin-right:6px;vertical-align:middle}',
    '#recBtn.on #recDot{animation:recPulse 1.1s ease-in-out infinite}',
    '@keyframes recPulse{0%,100%{opacity:1}50%{opacity:.25}}',
    '#recToast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:40;background:#0f1e3d;color:#fff;',
    'border:1px solid #1e3a8a;border-radius:10px;padding:9px 14px;font-size:12.5px;max-width:80vw;box-shadow:0 8px 24px rgba(0,0,0,.5);display:none}',
  ].join('');
}

/** The host's record button (empty string for a student — recording is a host capability). */
function recorderHtml(isHost) {
  return isHost
    ? '<button id="recBtn" type="button" title="Record this class to the cloud and email the class a link"><span id="recDot"></span>Record</button><div id="recToast"></div>'
    : '';
}

/**
 * The recorder's behaviour. `base` is the portal origin (''=same origin), `token` authenticates the
 * upload, `room`/`subject` identify the class. Uses addEventListener throughout (no inline onclick) so
 * it is immune to the page-template backslash landmine documented in the live-class memory.
 */
function recorderJs({ base, token, room, subject } = {}) {
  return `(function(){
  var BASE=${JSON.stringify(String(base || ''))}, TOK=${JSON.stringify(String(token || ''))};
  // the portal sets window.__ubRecToken to the live session token (read from URL/localStorage at load);
  // the desktop window bakes a short-lived HMAC upload token above. Either authenticates the upload.
  try{ if(window.__ubRecToken) TOK=window.__ubRecToken; }catch(e){}
  var ROOM=${JSON.stringify(String(room || ''))}, SUBJ=${JSON.stringify(String(subject || 'Live Class'))};
  var btn=document.getElementById('recBtn'); if(!btn) return;   // student seat has no button
  var toastEl=document.getElementById('recToast');
  function toast(msg,ms){ if(!toastEl)return; toastEl.textContent=msg; toastEl.style.display='block';
    if(toast._t)clearTimeout(toast._t); toast._t=setTimeout(function(){toastEl.style.display='none';}, ms||4200); }
  function qs(params){var a=[];for(var k in params){if(params[k]!=null&&params[k]!=='')a.push(encodeURIComponent(k)+'='+encodeURIComponent(params[k]));}return a.length?('?'+a.join('&')):'';}
  function api(path,params){return BASE+path+qs(Object.assign({t:TOK},params||{}));}

  // recording needs a portal to upload to AND a browser that can screen-capture; be honest when it can't
  var canCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);
  if(!canCapture){ btn.disabled=true; btn.title='Recording needs a desktop browser (screen capture is not available here).'; }

  var rec=null, stream=null, mixCtx=null, rid=null, seq=0, startedMs=0, timerT=null;
  var queue=[], sending=false, stopping=false, finished=false, pendingFinish=false;

  function pickMime(){
    var opts=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
    for(var i=0;i<opts.length;i++){ try{ if(window.MediaRecorder.isTypeSupported(opts[i]))return opts[i]; }catch(e){} }
    return 'video/webm';
  }
  function paint(on){ btn.classList.toggle('on', !!on); btn.innerHTML='<span id="recDot"></span>'+(on?'Stop':'Record'); }
  function elapsed(){ var s=Math.floor((Date.now()-startedMs)/1000); var m=Math.floor(s/60); s-=m*60; var h=Math.floor(m/60); m-=h*60;
    var p=function(n){return (n<10?'0':'')+n;}; return h?(h+':'+p(m)+':'+p(s)):(m+':'+p(s)); }

  // sequential upload with retry+backoff: a dropped chunk must not lose the lecture. Each chunk is sent
  // as base64 JSON (not a raw binary body) so it survives BOTH the Node hub and the serverless edge,
  // whose request shim can only read the body as text — one code path for every deployment.
  function drain(){
    if(sending) return; var item=queue.shift(); if(!item){ sending=false; if(pendingFinish)doFinish(); return; }
    sending=true;
    var fr=new FileReader();
    fr.onerror=function(){ sending=false; toast('A part of the recording could not be read.'); drain(); };
    fr.onload=function(){
      var b64=String(fr.result||''); var comma=b64.indexOf(','); if(comma>=0) b64=b64.slice(comma+1);
      var tries=0;
      (function attempt(){
        tries++;
        fetch(api('/api/class-recording/chunk',{}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:rid,seq:item.seq,b64:b64})})
          .then(function(r){return r.json().catch(function(){return {ok:r.ok};});})
          .then(function(d){ if(d&&d.ok===false&&d.fatal){ throw new Error(d.error||'rejected'); }
            sending=false; drain(); })
          .catch(function(e){
            if(tries<6 && !finished){ setTimeout(attempt, Math.min(1000*tries, 5000)); }
            else { sending=false; toast('A part of the recording could not upload — the rest is still being saved.'); drain(); }
          });
      })();
    };
    fr.readAsDataURL(item.blob);
  }

  function stopTracks(){ try{ stream&&stream.getTracks().forEach(function(t){try{t.stop();}catch(e){}}); }catch(e){}
    try{ mixCtx&&mixCtx.close(); }catch(e){} }

  function doFinish(){
    if(finished) return; finished=true; pendingFinish=false;
    var dur=startedMs?Math.round((Date.now()-startedMs)/1000):0;
    fetch(api('/api/class-recording/finish',{id:rid,duration:dur}),{method:'POST'})
      .then(function(r){return r.json();}).then(function(d){
        if(d&&d.ok){ toast('\\u2705 Recording saved to the cloud. The class has been emailed a link to watch it.',8000); }
        else { toast((d&&d.error)||'Recording saved, but finishing it failed.',7000); }
      }).catch(function(){ toast('Recording uploaded — it will finish saving shortly.',6000); });
  }

  function stop(){
    if(!rec || stopping) return; stopping=true;
    try{ if(timerT)clearInterval(timerT); }catch(e){}
    paint(false); btn.disabled=false;
    try{ rec.stop(); }catch(e){}
    stopTracks();
    // finish AFTER the queue drains (rec.onstop pushes the last chunk); flag it and let drain() call it
    pendingFinish=true; if(!sending && !queue.length) doFinish(); else drain();
  }

  async function start(){
    if(rec){ stop(); return; }
    if(!canCapture){ toast('Recording needs a desktop browser with screen capture.'); return; }
    btn.disabled=true;
    var disp;
    try{
      disp = await navigator.mediaDevices.getDisplayMedia({ video:{frameRate:15}, audio:true });
    }catch(e){ btn.disabled=false; toast('Screen sharing was cancelled — nothing was recorded.'); return; }
    // ask the server to open a recording (also the storage/portal readiness check)
    var open=null;
    try{ open = await fetch(api('/api/class-recording/start',{room:ROOM,subject:SUBJ}),{method:'POST'}).then(function(r){return r.json();}); }catch(e){ open=null; }
    if(!open || !open.ok || !open.id){ disp.getTracks().forEach(function(t){t.stop();}); btn.disabled=false;
      toast((open&&open.error)||'The server is not ready to store recordings (cloud storage may be off).',7000); return; }
    rid=open.id; seq=0; finished=false; stopping=false; pendingFinish=false; queue=[];

    // mix the shared-tab/system audio with the host mic into ONE track (MediaRecorder keeps only one
    // audio track), so the recording has both the lecturer's voice and everyone/everything they play
    var videoTrack = disp.getVideoTracks()[0];
    var audioTracks = disp.getAudioTracks();
    var mic=null; try{ mic = await navigator.mediaDevices.getUserMedia({audio:true}); }catch(e){ mic=null; }
    var combined;
    try{
      var AC = window.AudioContext||window.webkitAudioContext;
      if(AC && (audioTracks.length || mic)){
        mixCtx = new AC(); var dest = mixCtx.createMediaStreamDestination();
        if(audioTracks.length){ try{ mixCtx.createMediaStreamSource(new MediaStream(audioTracks)).connect(dest); }catch(e){} }
        if(mic){ try{ mixCtx.createMediaStreamSource(mic).connect(dest); }catch(e){} }
        combined = new MediaStream([videoTrack].concat(dest.stream.getAudioTracks()));
      } else {
        combined = new MediaStream([videoTrack].concat(audioTracks));
      }
    }catch(e){ combined = new MediaStream([videoTrack].concat(audioTracks)); }
    stream = disp; stream._mic = mic;
    // keep the mic tracks alive for stopTracks to clean up
    if(mic) mic.getTracks().forEach(function(t){ try{ disp.addTrack(t); }catch(e){} });

    try{
      rec = new MediaRecorder(combined, { mimeType: pickMime(), videoBitsPerSecond: 900000, audioBitsPerSecond: 96000 });
    }catch(e){
      try{ rec = new MediaRecorder(combined, { mimeType:'video/webm' }); }
      catch(e2){ disp.getTracks().forEach(function(t){t.stop();}); btn.disabled=false; toast('This browser cannot record video.'); return; }
    }
    rec.ondataavailable = function(ev){ if(ev.data && ev.data.size){ queue.push({seq:seq++, blob:ev.data}); drain(); } };
    rec.onstop = function(){ /* last chunk already queued via ondataavailable */ };
    // if the user clicks the browser's own "Stop sharing", end the recording cleanly
    if(videoTrack) videoTrack.addEventListener('ended', function(){ stop(); });

    startedMs=Date.now();
    rec.start(8000);                      // an 8s timeslice → small, frequent, resumable chunks
    paint(true); btn.disabled=false;
    toast('\\u25CF Recording. Everyone in the class can see a recording is in progress.');
    timerT=setInterval(function(){ if(rec && !stopping){ btn.innerHTML='<span id="recDot"></span>'+elapsed(); } }, 1000);
    hookCaptions();                       // 📝 best-effort live transcript, saved next to the recording
  }

  // 📝 TRANSCRIPTION — while recording, turn on Jitsi's captions and forward each FINALIZED line to the
  // recording so it is saved as a WebVTT transcript. Best-effort: a Jitsi backend with no transcription
  // service simply emits nothing, and the recording is fine without a transcript.
  function hookCaptions(){
    var japi=window.__ubApi; if(!japi) return;
    try{ japi.executeCommand('setSubtitles', true); }catch(e){}
    try{ japi.addEventListener('transcriptionChunkReceived', function(ev){
      if(!rec || finished) return;
      var d=(ev && ev.data) ? ev.data : ev;
      var text = (d && (d.final || d.text || (d.messages && d.messages.map(function(m){return m.text;}).join(' ')))) || '';
      if(!text) return;
      var at = startedMs ? ((Date.now()-startedMs)/1000) : 0;
      fetch(api('/api/class-recording/caption',{}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:rid,t:at,text:String(text).slice(0,300)})}).catch(function(){});
    }); }catch(e){}
  }

  btn.addEventListener('click', function(){ if(rec) stop(); else start(); });
  // never lose a recording to a closed tab: finalize what we have on the way out
  window.addEventListener('pagehide', function(){ if(rec && !finished) stop(); });
  // Jitsi's "leave" also unloads the page
  try{ var api2=window.__ubApi; if(api2) api2.addEventListener('readyToClose', function(){ if(rec && !finished) stop(); }); }catch(e){}
})();`;
}

/**
 * 🗳 IN-CLASS POLLS. The host asks a quick multiple-choice question; the class taps an answer from
 * their own screen; a live bar shows the result. Jitsi has no poll, so a lecturer checking "did that
 * land?" had only a wall of tiny faces to read. Portal-only writes (both seats read AND write through
 * an authenticated session), so the desktop host launches/closes from the desk over IPC — the same
 * split as Q&A. Uses event DELEGATION (data-* attributes, one handler) to stay clear of the
 * page-template backslash landmine that inline onclick handlers walk into.
 */
function pollCss() {
  return [
    '#pollBtn{position:fixed;right:14px;bottom:142px;z-index:30;border:0;cursor:pointer;background:#0e7490;color:#fff;',
    'padding:11px 15px;border-radius:999px;font-weight:700;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.45)}',
    '#pollBtn .n{background:#fff;color:#0e7490;border-radius:999px;padding:1px 7px;margin-left:6px;font-size:11px}',
    '#pollPanel{position:fixed;top:0;right:0;bottom:0;width:min(400px,94vw);z-index:31;background:#0f1e3d;',
    'border-left:1px solid #1e3a8a;transform:translateX(102%);transition:transform .22s ease;display:flex;flex-direction:column}',
    '#pollPanel.open{transform:none}',
    '#pollPanel header{display:flex;align-items:center;gap:8px;padding:13px 14px;border-bottom:1px solid #1e3a8a;font-weight:700}',
    '#pollPanel header .sp{flex:1}#pollPanel header button{background:#1e293b;color:#fff;border:0;border-radius:8px;padding:6px 11px;cursor:pointer}',
    '#pollList{overflow:auto;padding:10px 12px;flex:1;display:flex;flex-direction:column;gap:11px}',
    '.poll{background:#132347;border:1px solid #1e3a8a;border-radius:10px;padding:11px 12px}',
    '.poll .q{font-size:14px;font-weight:600;margin-bottom:8px}',
    '.poll .st{font-size:11px;opacity:.6;margin-bottom:8px}',
    '.poll .opt{display:block;width:100%;text-align:left;background:#1e293b;color:#fff;border:1px solid #24365f;border-radius:8px;',
    'padding:8px 11px;margin:6px 0;cursor:pointer;font:inherit;font-size:13px}',
    '.poll .opt:hover{background:#25406e}.poll .opt.mine{outline:2px solid #22d3ee}',
    '.poll .bar{position:relative;background:#0b1730;border-radius:8px;margin:6px 0;overflow:hidden;height:30px}',
    '.poll .bar .fill{position:absolute;left:0;top:0;bottom:0;background:#0e7490;opacity:.55}',
    '.poll .bar .lbl{position:relative;padding:6px 10px;font-size:12.5px;display:flex;justify-content:space-between}',
    '.poll .bar.mine .fill{background:#0891b2;opacity:.8}',
    '#pollNew{border-top:1px solid #1e3a8a;padding:10px 12px}',
    '#pollNew textarea{width:100%;box-sizing:border-box;background:#132347;color:#fff;border:1px solid #1e3a8a;border-radius:9px;padding:8px;font:inherit;font-size:13px;resize:vertical;margin-bottom:7px}',
    '#pollNew .r{display:flex;align-items:center;gap:10px}#pollNew .r label{font-size:12px;opacity:.85}',
    '#pollNew button{margin-left:auto;background:#0e7490;color:#fff;border:0;border-radius:8px;padding:7px 14px;font-weight:700;cursor:pointer}',
    '#pollEmpty{opacity:.7;font-size:13px;padding:16px 4px;line-height:1.55}',
  ].join('');
}

function pollHtml(isHost) {
  return '<button id="pollBtn" type="button">🗳 Polls<span class="n" id="pollN">0</span></button>'
    + '<div id="pollPanel"><header>🗳 Polls<span class="sp"></span>'
    + '<button type="button" id="pollReload">↻</button><button type="button" id="pollClose">✕</button></header>'
    + '<div id="pollList"><div id="pollEmpty">Loading…</div></div>'
    + (isHost ? '<div id="pollNew"><textarea id="pollQ" rows="2" placeholder="Ask the class a question…"></textarea>'
      + '<textarea id="pollO" rows="3" placeholder="One option per line (2–8 options)"></textarea>'
      + '<div class="r"><label><input type="checkbox" id="pollAnon" checked> Anonymous</label>'
      + '<button type="button" id="pollLaunch">Launch poll</button></div></div>' : '')
    + '</div>';
}

function pollJs({ isHost, room, course, token }) {
  return `(function(){
  var ROOM=${JSON.stringify(String(room || ''))}, COURSE=${JSON.stringify(String(course || ''))};
  var TOK=${JSON.stringify(String(token || ''))}, IS_HOST=${isHost ? 'true' : 'false'};
  try{ if(!TOK && window.__ubRecToken) TOK=window.__ubRecToken; }catch(e){}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}
  function tok(){ if(TOK) return TOK; try{ return window.__ubRecToken||new URLSearchParams(location.search).get('t')||localStorage.getItem('ubu_token')||''; }catch(e){ return ''; } }
  function q(){var a=[];if(ROOM)a.push('room='+encodeURIComponent(ROOM));if(COURSE)a.push('course='+encodeURIComponent(COURSE));var tk=tok();if(tk)a.push('t='+encodeURIComponent(tk));return a.length?('?'+a.join('&')):'';}
  var open=false, items=[];
  function bar(p){
    var counts=p.counts||[], total=p.total||0;
    return p.options.map(function(o,i){
      var n=counts[i]||0, pct=total?Math.round(n*100/total):0, mine=(p.mine===i);
      return '<div class="bar'+(mine?' mine':'')+'"><div class="fill" style="width:'+pct+'%"></div>'
        +'<div class="lbl"><span>'+esc(o)+(mine?' \\u2713':'')+'</span><span>'+pct+'% ('+n+')</span></div></div>';
    }).join('');
  }
  function choices(p){
    return p.options.map(function(o,i){
      return '<button type="button" class="opt'+(p.mine===i?' mine':'')+'" data-vote="'+p.id+'" data-choice="'+i+'">'+esc(o)+'</button>';
    }).join('');
  }
  function render(){
    var el=document.getElementById('pollList'); if(!el)return;
    var openN=items.filter(function(x){return x.status!=='closed';}).length;
    var b=document.getElementById('pollN'); if(b)b.textContent=String(openN);
    if(!items.length){el.innerHTML='<div id="pollEmpty">'+(IS_HOST?'No polls yet. Ask a quick question below and the class answers from their screens.':'No polls yet. Your lecturer can run a quick poll here during the class.')+'</div>';return;}
    el.innerHTML=items.map(function(p){
      var closed=(p.status==='closed');
      // a student sees vote buttons only while the poll is OPEN and they have not yet answered; otherwise the bar
      var body = (!IS_HOST && !closed && !p.voted) ? choices(p)
        : (p.counts ? bar(p) : '<div class="st">Waiting for results…</div>');
      var ctl = IS_HOST && !closed ? '<button type="button" class="opt" style="margin-top:8px;background:#7f1d1d" data-close="'+p.id+'">Close poll</button>' : '';
      return '<div class="poll"><div class="q">'+esc(p.question)+'</div>'
        +'<div class="st">'+(closed?'Closed':'Open')+(p.anonymous?' \\u00b7 anonymous':'')+(p.total!=null?(' \\u00b7 '+p.total+' vote'+(p.total===1?'':'s')):'')+'</div>'
        +body+ctl+'</div>';
    }).join('');
  }
  function load(){
    fetch('/api/class-polls'+q()).then(function(r){return r.json();}).then(function(d){ items=(d&&d.polls)||[]; render(); }).catch(function(){});
  }
  function vote(id,choice){
    fetch('/api/class-poll-vote'+(TOK?('?t='+encodeURIComponent(TOK)):''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,choice:choice})})
      .then(function(){load();}).catch(function(){});
  }
  function closePoll(id){
    fetch('/api/class-poll-close'+(TOK?('?t='+encodeURIComponent(TOK)):''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
      .then(function(){load();}).catch(function(){});
  }
  function launch(){
    var qEl=document.getElementById('pollQ'), oEl=document.getElementById('pollO');
    if(!qEl||!qEl.value.trim())return;
    var opts=(oEl?oEl.value:'').split(/\\r?\\n/).map(function(s){return s.trim();}).filter(Boolean);
    if(opts.length<2){alert('A poll needs at least two options — one per line.');return;}
    var anon=!!(document.getElementById('pollAnon')||{}).checked;
    fetch('/api/class-poll'+(TOK?('?t='+encodeURIComponent(TOK)):''),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({room:ROOM,course_code:COURSE,question:qEl.value.trim(),options:opts,anonymous:anon})})
      .then(function(r){return r.json();}).then(function(d){ if(d&&d.ok){qEl.value='';if(oEl)oEl.value='';load();} else if(d&&d.error){alert(d.error);} }).catch(function(){});
  }
  // wiring — one delegated handler on the panel, plus the fixed controls
  var panel=document.getElementById('pollPanel');
  var btn=document.getElementById('pollBtn');
  if(btn)btn.addEventListener('click',function(){ if(!panel)return; open=!open; panel.classList.toggle('open',open); if(open)load(); });
  var cl=document.getElementById('pollClose'); if(cl)cl.addEventListener('click',function(){open=false;panel.classList.remove('open');});
  var rl=document.getElementById('pollReload'); if(rl)rl.addEventListener('click',load);
  var lb=document.getElementById('pollLaunch'); if(lb)lb.addEventListener('click',launch);
  if(panel)panel.addEventListener('click',function(e){
    var t=e.target; if(!t||!t.getAttribute)return;
    var v=t.getAttribute('data-vote'); if(v){vote(v, Number(t.getAttribute('data-choice')));return;}
    var c=t.getAttribute('data-close'); if(c){closePoll(c);return;}
  });
  load();
  setInterval(function(){ if(open)load(); }, 15000);   // results move DURING the poll — that is the point
  setInterval(function(){ if(!open)load(); }, 60000);  // keep the open-count badge current when closed
})();`;
}

module.exports = {
  HOST_TOOLBAR, STUDENT_TOOLBAR, PRESENTER_TOOLBAR, toolbarJson, RECORDING_NOTE,
  drawerCss, drawerHtml, drawerJs, KIND_ICON,
  presenterCss, presenterHtml, presenterJs,
  lowDataCss, lowDataHtml, lowDataJs,
  qaCss, qaHtml, qaJs,
  recorderCss, recorderHtml, recorderJs,
  pollCss, pollHtml, pollJs,
};
