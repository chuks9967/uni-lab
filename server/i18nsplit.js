'use strict';
/**
 * 📶 LAZY LANGUAGE PACKS for the portal page. The page carries its built-in translations (French, Spanish, Arabic,
 * Hausa…) inline — ~170 KB of the ~630 KB page, downloaded and parsed by every visitor even though each reads ONE
 * language (most read English and need none of it).
 *
 * split(page) lifts every built-in dictionary out of the page once, at start-up:
 *   • the base dictionary (`var D={…}` inside PI18N) and every `PI18N.merge({…})` blob are evaluated (they are plain
 *     object literals written by us) and folded per language, in page order (a later merge wins, as before);
 *   • in the page each is replaced by `{}`, and a tiny loader goes into <head>: a returning visitor whose language is
 *     not English loads `/i18n/<lang>.js?v=<hash>` BEFORE the page script runs (no flash of English); a first-time or
 *     switched language is fetched on demand by PI18N.ensure;
 *   • each pack is `PI18N.pack(lang, {...})` (or parked for PI18N to pick up) and merges UNDER what is already there,
 *     so an institution's own wording (i18n_custom, merged at run time) still wins.
 * Any surprise → the page is served exactly as before.
 */
const crypto = require('crypto');

/** The end index (inclusive) of the object literal starting at s[i] === '{', honouring strings and escapes. */
function objectEnd(s, i) {
  let depth = 0, q = '';
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (q) { if (ch === '\\') { j++; continue; } if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return j; }
  }
  return -1;
}
const evalObject = (src) => (new Function('return (' + src + ');'))();
const hash = (str) => crypto.createHash('sha1').update(str).digest('base64url').slice(0, 12);

const LOADER = (map) => '<script>window.__I18N_SPLIT=' + JSON.stringify(map) + ';(function(){try{var L=localStorage.getItem("ubu_lang");var v=window.__I18N_SPLIT[L];'
  + 'if(L&&v)document.write("<script src=\\""+(window.__B||"")+"/i18n/"+L+".js?v="+v+"\\"><\\/script>");}catch(e){}})();</script>';

function packJs(lang, dict) {
  return '(function(d){if(window.PI18N&&PI18N.pack)PI18N.pack(' + JSON.stringify(lang) + ',d);else (window.__I18N_PRE=window.__I18N_PRE||{})[' + JSON.stringify(lang) + ']=d;})(' + JSON.stringify(dict) + ');';
}

/** → { page, packs: { lang: { js, v } }, bytes: { before, after } } — or { page } unchanged when anything is off. */
function split(page) {
  try {
    if (typeof page !== 'string' || page.indexOf('var PI18N=') < 0 || page.indexOf('</head>') < 0) return { page };
    const cuts = [];   // [start, end] ranges of object literals to replace with {}
    const all = {};
    const fold = (o) => { for (const l of Object.keys(o || {})) { if (!o[l] || typeof o[l] !== 'object') continue; all[l] = Object.assign(all[l] || {}, o[l]); } };
    // 1) the base dictionary inside PI18N
    const pi = page.indexOf('var PI18N=');
    const dAt = page.indexOf('var D={', pi);
    if (dAt < 0 || dAt - pi > 2000) return { page };
    const dStart = dAt + 'var D='.length, dEnd = objectEnd(page, dStart);
    if (dEnd < 0) return { page };
    fold(evalObject(page.slice(dStart, dEnd + 1))); cuts.push([dStart, dEnd]);
    // 2) every PI18N.merge({...}) after it (merges of run-time data — PI18N.merge(JSON.parse(…)) — are left alone)
    const re = /PI18N\.merge\(\{/g; let m;
    while ((m = re.exec(page))) {
      const start = m.index + 'PI18N.merge('.length; if (start < dEnd) continue;
      const end = objectEnd(page, start); if (end < 0) return { page };
      fold(evalObject(page.slice(start, end + 1))); cuts.push([start, end]); re.lastIndex = end;
    }
    let out = ''; let at = 0;
    for (const [s, e] of cuts.sort((a, b) => a[0] - b[0])) { out += page.slice(at, s) + '{}'; at = e + 1; }
    out += page.slice(at);
    const packs = {}; const map = {};
    for (const l of Object.keys(all)) { if (l === 'en' || !Object.keys(all[l]).length) continue; const js = packJs(l, all[l]); const v = hash(js); packs[l] = { js, v }; map[l] = v; }
    if (!Object.keys(packs).length) return { page };
    out = out.replace('</head>', LOADER(map) + '</head>');
    return { page: out, packs, bytes: { before: Buffer.byteLength(page), after: Buffer.byteLength(out) } };
  } catch (_) { return { page }; }
}

module.exports = { split, objectEnd, packJs };
