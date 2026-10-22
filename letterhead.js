'use strict';
/**
 * 🏛 LETTERHEAD BAND ENGINE — the university uploads its REAL letterhead once, and every document it
 * issues is printed on it.
 *
 * WHY THIS REPLACED THE LAYOUT PICKER. Asking a registry to choose between a dozen synthetic
 * stationery designs ("Modern colour band", "Corporate sidebar") is the same mistake as storing a Word
 * template: it approximates an identity the institution already owns. Universities do not want to pick
 * a letterhead — they have one, printed on the paper in their drawer, and every letter, transcript,
 * receipt and attestation sits on it. So the system takes the two bands that actually matter — the
 * HEADER strip and the FOOTER strip — and reproduces them on every document, at exact physical size.
 *
 * WHAT A BAND IS. A single full-width image of the top (or bottom) of the real sheet: crest, name
 * stack, address block, security ground, rules, barcodes, flag — whatever the institution's printer
 * put there. The engine never re-interprets it. It measures it, places it edge-to-edge at the true
 * aspect ratio, and reserves exactly enough body space that no text can ever land on it.
 *
 * THE FOUR THINGS THAT MAKE THIS ROBUST RATHER THAN A BACKGROUND IMAGE:
 *
 *   1. TRUE SIZE, NEVER STRETCHED. The band's height is derived from its own pixel aspect ratio and
 *      the page width, so a 2048×430 scan lands at exactly 210mm × 44.1mm on A4 and at the correct
 *      height on A5, Letter or a custom sheet. Distortion is impossible because height is computed,
 *      never assumed.
 *
 *   2. IT REPEATS ON EVERY PAGE. A transcript runs to four sheets; the letterhead must be on all of
 *      them. The bands are fixed-position layers, which Chromium's print pipeline paints once per
 *      printed page — the same mechanism the registry stationery already uses for its security layers.
 *
 *   3. THE BODY IS INSET, NOT OVERLAID. Content margins are computed FROM the band heights (plus a
 *      breathing gap), so text starts below the header and ends above the footer no matter how tall
 *      the uploaded bands are. A taller letterhead simply shortens the text column.
 *
 *   4. PAPER, PRINTED AND PRE-PRINTED ARE DIFFERENT JOBS. The digital copy always carries the bands —
 *      it is the authentic record. The printed copy has three honest modes: PRINT the bands (blank
 *      paper), RESERVE their space but print nothing (the office feeds its own pre-printed
 *      stationery), or OFF. Reserve is the one that matters most and the one mail-merge systems get
 *      wrong: the text must land in exactly the same place whether or not we print the band.
 *
 * PURE: no DB, no electron/deno APIs, no IO. It lives in server/ so the desktop renderers and the
 * Supabase Edge portal share ONE implementation (the same arrangement as formlayout.js and
 * barcode.js). Unit-tested in test/letterhead.js.
 */

// ---------------------------------------------------------------------------------------------
// Band images
// ---------------------------------------------------------------------------------------------
const BAND_RE = /^data:image\/(png|jpe?g|webp|gif)\;base64,/i;

/** Is this a usable band image (an embedded raster the renderer can place)? A remote URL is refused
 *  on purpose: an issued document must carry its own letterhead, not fetch it from a server that may
 *  be unreachable — or replaced — years later. The payload check rejects an empty `data:` stub. */
function isBand(v) {
  if (typeof v !== 'string' || !BAND_RE.test(v.slice(0, 40))) return false;
  const comma = v.indexOf(',');
  return comma > 0 && (v.length - comma - 1) >= 16;
}

/** Decode just enough base64 to read an image header (we never need the pixels themselves). */
function headerBytes(dataUrl, bytes) {
  const comma = String(dataUrl).indexOf(',');
  if (comma < 0) return null;
  // 4 base64 chars → 3 bytes; take a little extra so multi-byte headers are complete
  const chars = Math.ceil((bytes + 32) / 3) * 4;
  const chunk = String(dataUrl).slice(comma + 1, comma + 1 + chars);
  try {
    if (typeof Buffer !== 'undefined') return Buffer.from(chunk, 'base64');
    if (typeof atob === 'function') { const bin = atob(chunk); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  } catch (_) {}
  return null;
}

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/**
 * The pixel dimensions of a data-URI image, read straight from its header bytes — PNG (IHDR),
 * JPEG (the first SOFn frame), GIF and the three WebP chunk flavours. Returns null when the format
 * is unreadable, and the caller then falls back to a configured height rather than guessing.
 */
function dimsOf(dataUrl) {
  if (!isBand(dataUrl)) return null;
  const b = headerBytes(dataUrl, 4096);
  // each format needs a different number of bytes to be readable, so the minimum is checked per
  // branch below rather than globally — a valid 14-byte JPEG frame header is still a valid answer
  if (!b || b.length < 10) return null;
  try {
    // PNG: 8-byte signature, then an IHDR chunk carrying width/height as big-endian uint32
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
      if (b.length < 24) return null;
      const w = u32(b, 16), h = u32(b, 20);
      return (w > 0 && h > 0) ? { w, h } : null;
    }
    // GIF: 'GIF8', then little-endian uint16 width/height
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8);
      return (w > 0 && h > 0) ? { w, h } : null;
    }
    // WebP: 'RIFF' .... 'WEBP' then VP8 / VP8L / VP8X
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length >= 30 && b[8] === 0x57 && b[9] === 0x45) {
      const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (tag === 'VP8X') return { w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
      if (tag === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3FFF, h: (b[28] | (b[29] << 8)) & 0x3FFF };
      if (tag === 'VP8L') { const n = u32le(b, 21); return { w: (n & 0x3FFF) + 1, h: ((n >> 14) & 0x3FFF) + 1 }; }
      return null;
    }
    // JPEG: walk the marker segments to the first Start-Of-Frame, which carries height then width
    if (b[0] === 0xFF && b[1] === 0xD8) {
      let i = 2;
      while (i <= b.length - 9) {
        if (b[i] !== 0xFF) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: u16(b, i + 5), w: u16(b, i + 7) };
        if (m === 0xD8 || (m >= 0xD0 && m <= 0xD9)) { i += 2; continue; }
        const len = u16(b, i + 2);
        if (!len || len < 2) break;
        i += 2 + len;
      }
    }
  } catch (_) {}
  return null;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clamp = (n, lo, hi) => { n = Number(n); if (!isFinite(n)) return lo; return n < lo ? lo : (n > hi ? hi : n); };

/**
 * The height, in millimetres, at which a band spans the full page width WITHOUT distortion.
 * Falls back to `fallbackMm` when the image header cannot be read, and is clamped so a mis-cropped
 * upload (a whole scanned page dropped into the header slot) can never swallow the document.
 */
function bandMm(dataUrl, pageWmm, fallbackMm, maxFraction) {
  const pw = clamp(pageWmm, 50, 1200);
  const d = dimsOf(dataUrl);
  const raw = (d && d.w > 0) ? (pw * d.h / d.w) : Number(fallbackMm || 0);
  const cap = pw * (maxFraction || 0.45);
  return round2(clamp(raw, 0, cap));
}

// ---------------------------------------------------------------------------------------------
// ✏️ EDITABLE HEADER (the composition overlay) — the header the officer can actually edit
// ---------------------------------------------------------------------------------------------
/**
 * The uploaded band is frozen pixels: if the crest moved or a phone number changed, the officer
 * had to re-scan. The EDITABLE header layers a tiny, positionable composition ON TOP of the same
 * uploaded raster — a movable LOGO and editable TEXT writeup — and renders it on the DIGITAL copy
 * of every document. It never stores its own copy of the background image (it references `lhHeader`),
 * so it stays small enough to sync to other machines and the portal.
 *
 * Shape (the token `lhHeaderDoc`):
 *   { showBg:true, h?:mm, elements:[
 *       { type:'image', slot?:'crest', src?:dataURI, x:%, y:mm, h:mm, align, round, blend },
 *       { type:'text',  text, x:%, y:mm, w:%, size, weight, color, align, font, uppercase, tracking, lineHeight } ] }
 *
 * Deliberately mirrors the positioned-band spec the transcript engine already uses
 * (docstyle.sanitizeSpecElement / transcriptdoc.customBandHtml), so the editor and renderer follow
 * a proven pattern. Text carries identity tokens ({name} {short} {motto} {address} {email} {phone}
 * {website}) filled at render from the identity the CALLER supplies — the engine stays pure.
 */
// maxImages / maxTotalImage keep a design with several logos within the sync budget (the whole
// design row replicates to other machines AND the portal). The known fields a writeup may reference.
const HEADERDOC_LIMITS = { maxElements: 12, maxText: 300, maxImage: 600000, maxImages: 4, maxTotalImage: 1200000 };
const KNOWN_HEADER_VARS = ['institution', 'name', 'short', 'motto', 'address', 'website', 'email', 'phone'];
// scripts that read right-to-left — Arabic, Hebrew, Syriac, Thaana, Arabic-presentation forms. A
// writeup typed in any of these must set direction:rtl or the words print in reverse visual order.
const RTL_RE = /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿ࢠ-ࣿיִ-﷿ﹰ-﻿]/;
const hdNum = (v, lo, hi, dflt) => { const n = Number(v); if (!isFinite(n)) return dflt; return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)); };
// one clean CSS colour or '' — strip anything that could break out of a style attribute
const hdColor = (v) => String(v == null ? '' : v).replace(/[;{}<>"'`\\]/g, '').trim().slice(0, 48);

function sanitizeHeaderEl(el, i) {
  if (!el || typeof el !== 'object') return null;
  const type = (el.type === 'text' || el.type === 'image') ? el.type : '';
  if (!type) return null;
  const out = {
    id: /^[a-z0-9_-]{1,24}$/i.test(String(el.id || '')) ? String(el.id) : ('h' + (i + 1)),
    type,
    x: hdNum(el.x, 0, 100, 50),
    y: hdNum(el.y, 0, 120, 4),
    align: ['left', 'center', 'right'].includes(el.align) ? el.align : 'center',
    opacity: hdNum(el.opacity, 4, 100, 100),
    rotate: hdNum(el.rotate, -180, 180, 0),
  };
  if (type === 'text') {
    out.text = String(el.text == null ? '' : el.text).slice(0, HEADERDOC_LIMITS.maxText);
    out.font = String(el.font || '').slice(0, 24);
    out.size = hdNum(el.size, 4, 60, 12);
    out.weight = hdNum(el.weight, 300, 900, 700);
    if (el.italic) out.italic = true;
    if (el.underline) out.underline = true;
    if (el.uppercase) out.uppercase = true;
    out.tracking = hdNum(el.tracking, 0, 30, 0);
    out.color = hdColor(el.color);
    out.w = hdNum(el.w, 4, 100, 60);
    out.lineHeight = hdNum(el.lineHeight, 0.8, 3, 1.2);
  } else {
    // 🛡 an OVERSIZED or non-image src is DROPPED to a crest slot, never sliced — a truncated data
    // URI still looks like an image (right prefix, plenty of payload) but decodes to a broken
    // picture on every document. A slot with empty src is an editable placeholder that draws the
    // institution crest at render, so the element survives and the officer re-uploads in place.
    const src = String(el.src || '');
    if (src && /^data:image\//.test(src) && src.length <= HEADERDOC_LIMITS.maxImage) {
      out.src = src;
      if (el.slot === 'crest') out.slot = 'crest';
    } else {
      out.src = '';
      out.slot = 'crest';
    }
    out.h = hdNum(el.h, 4, 100, 16);
    if (el.round) out.round = true;
    if (el.blend === false) out.blend = false;
  }
  return out;
}

/** Sanitise a whole editable-header doc (object or JSON string) → a clean object, or null. */
function sanitizeHeaderDoc(doc) {
  let s = doc;
  if (typeof s === 'string') { if (!s.trim()) return null; try { s = JSON.parse(s); } catch (_) { return null; } }
  if (!s || typeof s !== 'object') return null;
  const els = (Array.isArray(s.elements) ? s.elements : [])
    .slice(0, HEADERDOC_LIMITS.maxElements)
    .map(sanitizeHeaderEl)
    .filter(Boolean);
  // 🛡 TOTAL image budget — the sanitiser already caps EACH logo, but several within-cap logos would
  // still bloat the row beyond what can sync to other machines and the portal. Real logos are kept in
  // order until the budget (or count) runs out; the rest fall back to a crest slot — still editable,
  // never dropped, never silently oversized.
  let budget = HEADERDOC_LIMITS.maxTotalImage, kept = 0;
  for (const el of els) {
    if (el.type !== 'image' || !el.src) continue;
    if (kept >= HEADERDOC_LIMITS.maxImages || el.src.length > budget) { el.src = ''; el.slot = 'crest'; }
    else { budget -= el.src.length; kept++; }
  }
  const out = { showBg: s.showBg !== false, elements: els };
  if (Number(s.h) > 0) out.h = hdNum(s.h, 4, 120, 40);
  return out;
}

/**
 * Non-fatal DESIGN issues an editable header may carry, for the editor to surface (verify() stays for
 * the integrity faults that must never ship). Reports elements that fall outside the band (clipped),
 * empty text, and `{unknown}` fields that would print literally. Pure — takes the band height in mm.
 */
function validateHeaderDoc(doc, opts = {}) {
  const d = (doc && typeof doc === 'object' && Array.isArray(doc.elements)) ? doc : sanitizeHeaderDoc(doc);
  if (!d || !d.elements) return [];
  const H = Number(opts.headerMm) > 0 ? Number(opts.headerMm) : (Number(d.h) > 0 ? d.h : 40);
  const issues = [];
  d.elements.forEach((el) => {
    const label = el.type === 'text' ? `text “${String(el.text || '').slice(0, 16)}”` : 'the logo';
    const boxH = el.type === 'image' ? (Number(el.h) || 16)
      : ((Number(el.size) || 12) * 0.3528 * (Number(el.lineHeight) || 1.2) + 1);
    if (Number(el.y) >= H) issues.push({ level: 'error', id: el.id, msg: `${label} sits below the header band and will be clipped` });
    else if (Number(el.y) + boxH > H + 0.5) issues.push({ level: 'warn', id: el.id, msg: `${label} extends past the bottom of the band` });
    if (el.type === 'text') {
      if (!String(el.text || '').trim()) issues.push({ level: 'warn', id: el.id, msg: 'an empty text box renders nothing' });
      const unknown = [...new Set((String(el.text || '').match(/\{([a-z_]+)\}/gi) || [])
        .map(t => t.slice(1, -1).toLowerCase()).filter(t => KNOWN_HEADER_VARS.indexOf(t) < 0))];
      if (unknown.length) issues.push({ level: 'warn', id: el.id, msg: `{${unknown.join('} {')}} is not a known field and will print literally` });
    }
  });
  return issues;
}

// identity-token filling + font/colour resolution for the composition (pure — the caller passes
// the identity; the engine never reaches for a DB or an institution singleton)
const HD_FONTS = {
  serif: "'Times New Roman',Georgia,serif",
  sans: "'Segoe UI',Arial,Helvetica,sans-serif",
  slab: "'Roboto Slab',Rockwell,'Times New Roman',serif",
  script: "'Segoe Script','Brush Script MT','Monotype Corsiva',cursive",
  mono: "'Courier New',Courier,monospace",
  display: "Georgia,'Times New Roman',serif",
};
function hdFontStack(key) { return HD_FONTS[String(key || '')] || 'inherit'; }
function hdCssColor(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;
  if (/^[a-z]+$/i.test(s)) return s;                       // named colours
  if (/^rgba?\([\d.,\s%]+\)$/i.test(s)) return s;
  return '';
}
function hdFill(text, idm) {
  const name = String(idm.name || ''), short = String(idm.short || '');
  return String(text == null ? '' : text)
    .replace(/\{institution\}/gi, name)
    .replace(/\{name\}/gi, name)
    .replace(/\{short\}/gi, short)
    .replace(/\{motto\}/gi, String(idm.motto || ''))
    .replace(/\{address\}/gi, String(idm.address || ''))
    .replace(/\{website\}/gi, String(idm.website || '').replace(/^https?:\/\//, ''))
    .replace(/\{email\}/gi, String((Array.isArray(idm.emails) ? idm.emails[0] : idm.email) || ''))
    .replace(/\{phone\}/gi, Array.isArray(idm.phones) ? idm.phones.join(', ') : String(idm.phone || ''));
}

// ---------------------------------------------------------------------------------------------
// Configuration — resolved from the design tokens that already flow user → office → faculty → university
// ---------------------------------------------------------------------------------------------
const PRINT_MODES = ['band', 'reserve', 'off'];
/** How the PRINTED copy treats the bands. `band` prints them (blank paper); `reserve` keeps the space
 *  clear for pre-printed stationery; `off` prints neither band nor gap. Digital always shows them. */
function printMode(v) { const s = String(v == null ? '' : v).toLowerCase().trim(); return PRINT_MODES.includes(s) ? s : 'band'; }

/** The document kinds a letterhead is switched OFF for (a certificate often stands alone). */
/**
 * Document kinds an institution usually decides about as a GROUP. A registry that wants its
 * letterhead on credentials but not on internal paperwork should not have to tick twenty boxes, and
 * without these the opt-out could not reach those documents at all: everything built through the
 * shared shell used to pass no kind, so the per-kind control was dead for most of the app.
 */
const KIND_GROUPS = {
  reports: ['statement', 'collector_report', 'financial_report', 'academic_calendar', 'income_statement',
    'refund_voucher', 'results_statistics', 'sessional_report', 'exam_incident', 'convocation_list', 'report'],
  schedules: ['lecture_timetable', 'exam_timetable', 'allocation', 'invigilator_roster',
    'attendance_register', 'exam_eligibility'],
  slips: ['matric_slip', 'seat_slip', 'clearance', 'result_slip'],
  // 🎓 CREDENTIALS are not correspondence. A degree certificate is self-contained artwork — its own
  // border, crest, calligraphy and signatures — and a header/footer band both doubles up on that and
  // steals the ~49mm the signature block lives in, on a sheet that cannot grow. An institution that
  // wants its stationery off these puts `@credentials` in lhOff and is done, instead of having to
  // know each kind key. (Left OPT-OUT rather than default-off: an office printing onto pre-printed
  // certificate stock legitimately uses `reserve` mode to keep that space clear.)
  credentials: ['certificate', 'transcript'],
};
/** Is this kind opted out — directly, or through one of the group tokens (`@reports`)? */
function isOff(kind, off) {
  if (!kind || !off || !off.size) return false;
  if (off.has(kind)) return true;
  for (const g of Object.keys(KIND_GROUPS)) {
    if (off.has('@' + g) && KIND_GROUPS[g].indexOf(kind) >= 0) return true;
  }
  return false;
}

function offKinds(v) {
  if (Array.isArray(v)) return new Set(v.map(x => String(x).trim()).filter(Boolean));
  return new Set(String(v == null ? '' : v).split(/[,\s]+/).map(x => x.trim()).filter(Boolean));
}

/**
 * Resolve the letterhead for a document.
 *   ds       the design tokens (lhHeader · lhFooter · lhPaper · lhPrint · lhHeaderMm · lhFooterMm · lhOff)
 *   opts     { pageW, printable, kind, gapMm }
 * Returns a config the renderer can use directly, with `active:false` when no letterhead applies —
 * so every call site is a two-line change and an institution that never uploads one is unaffected.
 */
function resolve(ds, opts = {}) {
  const d = ds || {};
  const pageW = clamp(opts.pageW || 210, 50, 1200);
  const kind = String(opts.kind || '');
  const printable = !!opts.printable;
  const header = isBand(d.lhHeader) ? d.lhHeader : '';
  const footer = isBand(d.lhFooter) ? d.lhFooter : '';
  // ✏️ the EDITABLE header composition — a movable logo + writeup that rides ON the raster (or
  // rebuilds the header without one). Its presence keeps the letterhead active even when there is
  // no uploaded raster, so a from-scratch header still reserves body space and never overlays.
  const headerDoc = sanitizeHeaderDoc(d.lhHeaderDoc);
  const footerDoc = sanitizeHeaderDoc(d.lhFooterDoc);   // same shape — the letterhead is symmetric
  const hasHeaderContent = !!header || !!(headerDoc && headerDoc.elements && headerDoc.elements.length);
  const hasFooterContent = !!footer || !!(footerDoc && footerDoc.elements && footerDoc.elements.length);
  const off = offKinds(d.lhOff);
  const disabled = isOff(kind, off) || (!hasHeaderContent && !hasFooterContent);
  if (disabled) return { active: false, showHeader: false, showFooter: false, headerMm: 0, footerMm: 0, insetTopMm: 0, insetBottomMm: 0, paper: '' };

  const mode = printMode(d.lhPrint);
  // 🏛 FIRST PAGE ONLY — the classic institutional convention: the letterhead identifies page 1 and
  // continuation sheets are plain. The SPACE is still reserved on every page so the text block sits
  // in exactly the same place throughout; only the artwork stops. (Word expresses this natively with
  // w:titlePg, so the .docx behaves identically rather than approximating it.)
  const firstOnly = /^(1|true|yes|on|first)$/i.test(String(d.lhFirstOnly == null ? '' : d.lhFirstOnly).trim());
  const pageH = clamp(opts.pageH || 297, 50, 1800);
  // measured heights (a manual override wins, so an officer can nudge a band that scanned with slop)
  const headerSet = Number(d.lhHeaderMm) > 0, footerSet = Number(d.lhFooterMm) > 0;
  // band height: a raster measures/hand-sets exactly as before; a from-scratch header (no raster)
  // takes the editor's chosen height, or a sane default. The overlay sits WITHIN this height, so a
  // taller writeup never pushes the body — the physical header strip owns the space.
  const headerMm = header
    ? (headerSet ? clamp(d.lhHeaderMm, 2, pageW * 0.45) : bandMm(header, pageW, 40))
    : (headerDoc ? clamp(Number(headerDoc.h) > 0 ? headerDoc.h : 40, 2, pageW * 0.45) : 0);
  const footerMm = footer
    ? (footerSet ? clamp(d.lhFooterMm, 2, pageW * 0.45) : bandMm(footer, pageW, 24))
    : (footerDoc ? clamp(Number(footerDoc.h) > 0 ? footerDoc.h : 24, 2, pageW * 0.45) : 0);

  // the printed copy may keep the SPACE without the ink (pre-printed stationery)
  const paint = !printable || mode === 'band';
  const reserve = !printable || mode !== 'off';
  const gap = clamp(opts.gapMm != null ? opts.gapMm : 6, 0, 40);

  return {
    active: true,
    header, footer, mode, printable,
    headerMm, footerMm, firstOnly, pageH,
    // the width these heights were measured against. A renderer that paints the bands across a
    // DIFFERENT width (a landscape sheet measured as portrait) would stretch the artwork, so the
    // width travels with the config and `verify()` below turns that mistake into a caught error
    // rather than a subtly squashed crest nobody notices until it is printed.
    pageW,
    // a height set BY HAND is a deliberate choice; only auto-measured heights are aspect-checked
    headerSet, footerSet,
    // ✏️ the editable compositions (null when the officer never edited that band)
    headerDoc, footerDoc,
    showHeader: hasHeaderContent && paint,
    showFooter: hasFooterContent && paint,
    // the body must clear the band whether or not we print it — this is what keeps a printed copy and
    // a pre-printed copy identical on the page
    insetTopMm: hasHeaderContent && reserve ? round2(headerMm + gap) : 0,
    insetBottomMm: hasFooterContent && reserve ? round2(footerMm + gap) : 0,
    // the sheet tint sampled from the band on upload, so the paper reads as one continuous stock
    // (a printed copy goes on real paper, so it never gets the tint)
    paper: (!printable && /^#([0-9a-f]{3}){1,2}$/i.test(String(d.lhPaper || ''))) ? String(d.lhPaper) : '',
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
const escAttr = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** One positioned element of the editable header (logo or text writeup) → an absolutely-placed box
 *  inside the `.lh-head` band. All text is HTML-escaped after token filling — the composition can
 *  never break out of the band (same discipline as transcriptdoc.customBandHtml). */
function headerElHtml(el, idm) {
  const tx = el.align === 'left' ? '0' : el.align === 'right' ? '-100%' : '-50%';
  const rot = Number(el.rotate) ? ` rotate(${Number(el.rotate)}deg)` : '';
  const base = `position:absolute;left:${Number(el.x) || 0}%;top:${Number(el.y) || 0}mm;transform:translateX(${tx})${rot};opacity:${(Number(el.opacity) || 100) / 100};`;
  if (el.type === 'text') {
    let t = hdFill(el.text || '', idm || {});
    if (el.uppercase) t = t.toUpperCase();
    // 🌍 a writeup typed in Arabic/Hebrew must read right-to-left, or the words print reversed. Detect
    // it from the FILLED text (an {address} token may itself be RTL) and isolate so a mixed line is stable.
    const rtl = RTL_RE.test(t) ? 'direction:rtl;unicode-bidi:isolate;' : '';
    const st = base + `width:${Number(el.w) || 60}%;max-width:100%;text-align:${el.align};${rtl}`
      + `font-family:${hdFontStack(el.font)};font-size:${Number(el.size) || 12}pt;font-weight:${Number(el.weight) || 700};`
      + `letter-spacing:${Number(el.tracking) || 0}px;line-height:${Number(el.lineHeight) || 1.2};`
      + (el.italic ? 'font-style:italic;' : '') + (el.underline ? 'text-decoration:underline;' : '')
      + `color:${hdCssColor(el.color) || 'inherit'};white-space:pre-wrap;overflow-wrap:break-word;`;
    return `<div class="lh-el lh-el-text" style="${st}">${escHtml(t)}</div>`;
  }
  // image / logo — an empty crest slot fills from the caller's crest; still empty ⇒ draws nothing
  const src = el.src || (el.slot === 'crest' ? String((idm && idm.logo) || '') : '');
  if (!src) return '';
  const st = base + `height:${Number(el.h) || 16}mm;width:auto;object-fit:contain;`
    + (el.blend === false ? '' : 'mix-blend-mode:multiply;') + (el.round ? 'border-radius:50%;' : '');
  return `<img class="lh-el lh-el-img" src="${escAttr(src)}" alt="" style="${st}">`;
}

/** The inner HTML of a composed band (header OR footer): the uploaded raster (when kept as the
 *  background) plus every positioned overlay element. The band div and its height come from
 *  `headerHtml`/`footerHtml`/`css`. One code path serves both bands — the letterhead is symmetric. */
function composeInner(cfg, opts = {}, band = 'header') {
  const doc = (band === 'footer' ? cfg.footerDoc : cfg.headerDoc) || {};
  const raster = band === 'footer' ? cfg.footer : cfg.header;
  const idm = opts.identity || {};
  const bg = (doc.showBg && raster)
    ? `<img class="lh-bg" src="${escAttr(raster)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:block">`
    : '';
  return bg + (doc.elements || []).map(el => headerElHtml(el, idm)).join('');
}

/**
 * The CSS for the bands. They are FIXED layers so Chromium repeats them on every printed page, and
 * full-bleed (pinned to the sheet edges, outside the content margins) because a real letterhead runs
 * to the paper edge. z-index sits above the security ground and below the content.
 */
function css(cfg, opts = {}) {
  if (!cfg || !cfg.active) return '';
  const z = opts.z != null ? opts.z : 1;
  // FIXED is right for a document that flows as one long column (Chromium repaints a fixed layer on
  // every printed page). ABSOLUTE is right for an engine that already emits one positioned .sheet per
  // page — there the band belongs to its own sheet, and fixed would pin it to the viewport on screen.
  // A `fixed` layer is what makes a band repeat on every printed page — so a FIRST-ONLY band must be
  // absolute even in a flowing document, where it then lands on page 1 and nowhere else.
  const abs = opts.position === 'absolute' || (cfg.firstOnly && opts.position !== 'absolute');
  const pos = abs ? 'absolute' : 'fixed';
  return `
    .lh-band{position:${pos};left:0;right:0;width:100%;z-index:${z};pointer-events:none;line-height:0;overflow:hidden}
    .lh-band img{display:block;width:100%;height:100%}
    .lh-head{top:0;height:${cfg.headerMm}mm}
    .lh-foot{${(cfg.firstOnly && opts.position !== 'absolute')
      ? `top:${round2(cfg.pageH - cfg.footerMm)}mm;bottom:auto`
      : 'bottom:0'};height:${cfg.footerMm}mm}
    /* An AUTO-measured height came from the artwork's own aspect, so 'fill' is exact — it neither
       distorts nor leaves a rounding seam. A height typed BY HAND is a deliberate crop of scan slop,
       and 'cover' honours it without squashing the crest, which is what 'fill' used to do. */
    .lh-head img{object-fit:${cfg.headerSet ? 'cover' : 'fill'};object-position:center ${cfg.headerSet ? 'top' : 'center'}}
    .lh-foot img{object-fit:${cfg.footerSet ? 'cover' : 'fill'};object-position:center ${cfg.footerSet ? 'bottom' : 'center'}}${((cfg.headerDoc && (!cfg.printable || !cfg.header)) || (cfg.footerDoc && (!cfg.printable || !cfg.footer))) ? `
    /* ✏️ the editable composition: text isn't zeroed by the band's line-height:0, and positioned
       elements/logos keep their own inline sizing rather than the flat-band 100%×100%. Emitted only
       when the composition actually renders (digital, or a from-scratch band with no raster), so a
       printable copy that keeps the flat scan stays byte-identical to an unedited one. */
    .lh-compose{line-height:normal}
    .lh-compose .lh-el{position:absolute;margin:0;max-height:100%}
    .lh-compose .lh-el-img{width:auto;height:auto}` : ''}
    @media print{.lh-band{position:${pos}}}`;
}

/** The header band element (empty string when it must not paint). */
function headerHtml(cfg, opts = {}) {
  if (!cfg || !cfg.active || !cfg.showHeader) return '';
  if (cfg.firstOnly && opts.first === false) return '';       // continuation sheets are plain paper
  // ✏️ the EDITABLE composition rides the DIGITAL copy; the printed copy and Word keep the flat band
  // image (they can't position overlays reliably). With no flat raster at all — a header rebuilt from
  // scratch — the composition is the only header available, so it renders even on the printed copy.
  if (cfg.headerDoc && (!cfg.printable || !cfg.header)) {
    return `<div class="lh-band lh-head lh-compose" aria-hidden="true">${composeInner(cfg, opts, 'header')}</div>`;
  }
  if (!cfg.header) return '';
  return `<div class="lh-band lh-head" aria-hidden="true"><img src="${escAttr(cfg.header)}" alt=""></div>`;
}
/** The footer band element (empty string when it must not paint) — symmetric with the header, so an
 *  editable footer (contact block, accreditation line, extra marks) rides the digital copy too. */
function footerHtml(cfg, opts = {}) {
  if (!cfg || !cfg.active || !cfg.showFooter) return '';
  if (cfg.firstOnly && opts.first === false) return '';
  if (cfg.footerDoc && (!cfg.printable || !cfg.footer)) {
    return `<div class="lh-band lh-foot lh-compose" aria-hidden="true">${composeInner(cfg, opts, 'footer')}</div>`;
  }
  if (!cfg.footer) return '';
  return `<div class="lh-band lh-foot" aria-hidden="true"><img src="${escAttr(cfg.footer)}" alt=""></div>`;
}
/** Both bands plus their CSS, ready to drop into a document's <style> and <body>. */
function layers(cfg, opts) { return { css: css(cfg, opts), html: headerHtml(cfg, opts) + footerHtml(cfg, opts) }; }

/**
 * The content margins a framed document should use, given its own defaults. The letterhead only ever
 * PUSHES content further in — it never pulls a document's own margin tighter than it asked for, so a
 * design that already reserves a large footer keeps it.
 */
function insets(cfg, baseTopMm, baseBottomMm) {
  const t = Number(baseTopMm) || 0, b = Number(baseBottomMm) || 0;
  if (!cfg || !cfg.active) return { top: round2(t), bottom: round2(b) };
  return { top: round2(Math.max(t, cfg.insetTopMm)), bottom: round2(Math.max(b, cfg.insetBottomMm)) };
}

/** A one-line human summary for the designer UI ("Header 44.1mm · Footer 21.3mm · prints on paper"). */
function describe(cfg) {
  if (!cfg || !cfg.active) return 'No letterhead — documents use their own header and footer.';
  const bits = [];
  if (cfg.header || cfg.headerDoc) bits.push(`Header ${cfg.headerMm}mm${cfg.headerDoc ? ' (editable)' : ''}`);
  if (cfg.footer || cfg.footerDoc) bits.push(`Footer ${cfg.footerMm}mm${cfg.footerDoc ? ' (editable)' : ''}`);
  bits.push(cfg.mode === 'band' ? 'printed on blank paper'
    : cfg.mode === 'reserve' ? 'space reserved for pre-printed paper'
      : 'not printed');
  return bits.join(' · ');
}

/**
 * Sanity-check a resolved config against the width it is REALLY being painted across. Returns [] when
 * the band will land at true size, or a list of problems when a caller measured against the wrong
 * sheet (the landscape-certificate mistake). Cheap enough to assert in tests and harnesses.
 */
function verify(cfg, actualPageW) {
  if (!cfg || !cfg.active) return [];
  const problems = [];
  const w = Number(actualPageW) || 0;
  if (w && cfg.pageW && Math.abs(w - cfg.pageW) > 0.5) {
    problems.push(`the bands were measured for a ${cfg.pageW}mm sheet but are being painted across ${w}mm — the artwork would be stretched`);
  }
  for (const [name, src, mm, byHand] of [['header', cfg.header, cfg.headerMm, cfg.headerSet], ['footer', cfg.footer, cfg.footerMm, cfg.footerSet]]) {
    if (!src) continue;
    const d = dimsOf(src);
    // 🛡 A BAND WHOSE HEADER CANNOT BE READ is the signature of a truncated or corrupt image. It
    // still looks like an image (right prefix, plenty of payload) so nothing else catches it, and the
    // document would render a broken picture at a fallback height — on every copy, silently.
    if (!d || !d.w) { problems.push(`the ${name} band image cannot be read — it may have been truncated or corrupted; re-upload it`); continue; }
    if (byHand) continue;                         // a hand-set height is a choice, never a fault
    const trueMm = round2((cfg.pageW || 210) * d.h / d.w);
    const capped = mm >= (cfg.pageW || 210) * 0.449;   // clamped by the 45% ceiling, deliberately
    if (!capped && Math.abs(trueMm - mm) > 0.05) {
      problems.push(`the ${name} band would render ${mm}mm tall but its own aspect ratio makes it ${trueMm}mm`);
    }
  }
  // ✏️ an editable logo that can't be decoded would render as a broken picture on every digital copy
  // — same silent failure as a truncated band. Only raster srcs are checked (an SVG logo is unreadable
  // by the header-byte parser but renders fine); a crest slot has no src. Both bands are checked.
  for (const [name, doc] of [['header', cfg.headerDoc], ['footer', cfg.footerDoc]]) {
    if (!doc || !Array.isArray(doc.elements)) continue;
    doc.elements.forEach((el) => {
      if (el.type === 'image' && el.src && BAND_RE.test(String(el.src).slice(0, 40)) && !dimsOf(el.src)) {
        problems.push(`a logo in the editable ${name} cannot be read — it may be truncated or corrupted; re-upload it`);
      }
    });
  }
  return problems;
}

module.exports = {
  isBand, dimsOf, bandMm, resolve, css, headerHtml, footerHtml, layers, insets, describe, verify,
  printMode, offKinds, isOff, KIND_GROUPS, PRINT_MODES,
  sanitizeHeaderDoc, validateHeaderDoc, HEADERDOC_LIMITS, KNOWN_HEADER_VARS,
};
