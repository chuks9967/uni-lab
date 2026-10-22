'use strict';
/**
 * ▮▯ BARCODE ENGINE — a REAL, scannable Code 128 symbol, drawn as deterministic SVG.
 *
 * A document that prints a row of decorative bars is worse than one that prints none: it promises a
 * verifier something a scanner cannot read. This module encodes the genuine verification code
 * (services/docverify — a 16-digit HMAC of `matric|kind`) into a Code 128 symbol that any commodity
 * scanner or phone app decodes back to exactly those digits, which the desk / portal then verifies.
 *
 * Code 128 is the right symbology for this job: variable length, full ASCII, high density (subset C
 * packs two digits per symbol character, so a 16-digit code needs only 8), and a mandatory modulo-103
 * checksum that makes a mis-scan vanishingly unlikely. For a pure-digit payload of even length this
 * encoder uses subset C throughout; anything else falls back to subset B.
 *
 * PURE + DETERMINISTIC: no randomness (the watermark engine's rule — a document's markup must be
 * byte-identical every time it is produced, or the tamper-evident hash is meaningless), no DB, no IO.
 * Unit-tested against the published Code 128 checksum examples in test/barcode.js.
 */

// The 107 Code 128 patterns (values 0…106). Each is six digits: the widths, in modules, of
// bar,space,bar,space,bar,space — every character is exactly 11 modules wide.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104, START_C = 105, STOP = 106;

/** Is this payload encodable in subset C (digits only, even length)? Subset C halves the symbol width. */
function useSubsetC(data) { return /^\d+$/.test(data) && data.length % 2 === 0; }

/**
 * Encode a payload into Code 128 symbol values (start … data … checksum … stop).
 * Returns null when the payload holds a character Code 128 B cannot carry (outside ASCII 32-126).
 */
function encodeValues(data) {
  const s = String(data == null ? '' : data);
  if (!s) return null;
  const values = [];
  if (useSubsetC(s)) {
    values.push(START_C);
    for (let i = 0; i < s.length; i += 2) values.push(parseInt(s.substr(i, 2), 10));
  } else {
    for (const ch of s) { const c = ch.charCodeAt(0); if (c < 32 || c > 126) return null; }
    values.push(START_B);
    for (const ch of s) values.push(ch.charCodeAt(0) - 32);
  }
  // modulo-103 checksum: start value + Σ (position × value), positions counted from 1
  let sum = values[0];
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  values.push(STOP);
  return values;
}

/** The bar/space module widths for a payload, as a flat array starting with a BAR. */
function modules(data) {
  const values = encodeValues(data);
  if (!values) return null;
  const out = [];
  for (const v of values) for (const ch of PATTERNS[v]) out.push(parseInt(ch, 10));
  return out;
}

/** Total module width of the symbol INCLUDING the mandatory 10-module quiet zone on each side. */
function moduleWidth(data) {
  const m = modules(data);
  return m ? m.reduce((a, b) => a + b, 0) + 20 : 0;
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * A complete Code 128 symbol as SVG, sized to fill its box.
 *   opts.height     bar height as a fraction of the viewBox (default .78, leaving room for the text)
 *   opts.showText   print the human-readable payload under the bars (default true)
 *   opts.color      bar colour (default near-black — scanners want contrast, not brand colour)
 *   opts.quiet      quiet-zone modules each side (default 10 — REQUIRED by the specification)
 * Returns '' when the payload cannot be encoded, so a caller can fall back cleanly.
 */
function svg(data, opts = {}) {
  const payload = String(data == null ? '' : data);
  const mods = modules(payload);
  if (!mods) return '';
  const quiet = Math.max(0, opts.quiet == null ? 10 : opts.quiet | 0);
  const total = mods.reduce((a, b) => a + b, 0) + quiet * 2;
  const showText = opts.showText !== false;
  const H = 100;                                     // viewBox height; bars + optional text share it
  const barH = Math.round(H * (opts.height != null ? opts.height : (showText ? 0.78 : 1)));
  const color = /^#[0-9a-f]{3,8}$/i.test(String(opts.color || '')) ? opts.color : '#0b0b0b';
  let x = quiet, bars = '', isBar = true;
  for (const w of mods) {
    if (isBar) bars += `<rect x="${x}" y="0" width="${w}" height="${barH}" fill="${esc(color)}"/>`;
    x += w; isBar = !isBar;
  }
  const text = showText
    ? `<text x="${(total / 2).toFixed(2)}" y="${H - 3}" text-anchor="middle" font-family="Consolas,'Courier New',monospace" font-size="${Math.max(9, Math.round(total * 0.055))}" letter-spacing="1" fill="${esc(color)}">${esc(payload)}</text>`
    : '';
  // the plate: opaque white by DEFAULT (every existing caller keeps exactly the symbol it had), or
  // suppressed with `background:'transparent'` so the bars sit straight on the institution's stock.
  // Only a hex colour is accepted — anything else falls back to white rather than reaching the markup.
  const bgOpt = opts.background === undefined ? '#ffffff' : String(opts.background || '').trim();
  const clear = bgOpt === 'transparent' || bgOpt === 'none' || bgOpt === '';
  const bg = /^#[0-9a-f]{3,8}$/i.test(bgOpt) ? bgOpt : '#ffffff';
  const plate = clear ? '' : `<rect x="0" y="0" width="${total}" height="${H}" fill="${esc(bg)}"/>`;
  return `<svg viewBox="0 0 ${total} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" role="img" aria-label="Barcode ${esc(payload)}" style="width:100%;height:100%;display:block">`
    + `${plate}${bars}${text}</svg>`;
}

/** Can this payload be carried by a Code 128 symbol at all? */
function encodable(data) { return !!modules(data); }

// ---------------------------------------------------------------------------------------------
// 🎨 BLENDING ONTO THE PAPER — without ever making a symbol unreadable.
//
// A barcode's white plate is not decoration: a scanner discriminates bars from spaces by CONTRAST,
// and the quiet zones either side are part of the symbol. But an institution's stationery is rarely
// white — the WAUU documents are kraft — and the ISSUED originals print their bars straight onto the
// tinted stock with no white patch at all. Forcing an opaque white rectangle onto a tan sheet is
// therefore wrong twice over: it does not match the document being mirrored, and it announces itself
// as a pasted-on graphic on the digital copy a student actually looks at.
//
// So the plate is a DECISION, not a constant, and the decision is made from the paper: bars go
// directly on the stock when the stock is light enough to read them against, and keep their plate
// when it is not. The rule lives here, beside the encoder, so the desktop and the Edge portal answer
// it identically (this file is vendored into the Edge build).
// ---------------------------------------------------------------------------------------------

/** Relative luminance (WCAG) of a #rgb / #rrggbb colour, 0 (black) … 1 (white). */
function luminance(hex) {
  let x = String(hex || '').trim().replace('#', '');
  if (x.length === 3) x = x.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(x)) return -1;                       // unknown / named / rgba() → "cannot tell"
  const n = parseInt(x, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio between two colours, 1 … 21. -1 when either colour cannot be parsed. */
function contrastRatio(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  if (l1 < 0 || l2 < 0) return -1;
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * May a symbol in `ink` be printed DIRECTLY on `paper`, with no plate behind it?
 *
 * The threshold is deliberately far above the 4.5:1 that text needs. A reader is decoding reflectance
 * through a phone camera, off a scan or a photocopy, at an angle, possibly over a security ground —
 * so this only says yes for stock that is genuinely light. Kraft (#e9d9a9) against near-black is
 * ~14:1 and passes comfortably; a mid or dark ground fails and keeps its plate. An unparseable colour
 * (a gradient, a named colour, an image background) is treated as UNKNOWN and also keeps its plate:
 * the safe answer when we cannot measure is the one that always scans.
 */
const BLEND_MIN_CONTRAST = 9;
function scannableOn(paper, ink) {
  const r = contrastRatio(paper, ink || '#0b0b0b');
  return r >= BLEND_MIN_CONTRAST;
}

module.exports = {
  svg, modules, moduleWidth, encodeValues, encodable, useSubsetC, PATTERNS, START_B, START_C, STOP,
  luminance, contrastRatio, scannableOn, BLEND_MIN_CONTRAST,
};
