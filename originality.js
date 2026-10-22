'use strict';
/**
 * 🔍 ORIGINALITY CHECK — finds submissions to the same assignment that share long runs of identical wording.
 * Pure + dependency-light (`zlib` only) so it runs on the desktop, the Node hub and the Supabase Edge portal.
 *
 *  • TEXT: typed answers, and the text layer of .docx / .odt / .pdf / .txt / .rtf files (a scanned PDF has
 *    none — it is reported as "not readable", never as original).
 *  • FINGERPRINTS: every run of K consecutive words (a "shingle"), hashed. Two scripts that share many
 *    shingles share whole sentences — rewording a few words breaks the runs, so ordinary overlap of topic
 *    vocabulary does not count.
 *  • IGNORED: wording from the lecturer's own instructions, and wording that a large part of the class shares
 *    (a template, the question copied into every answer).
 *  • SCORE: the share of the SMALLER script's shingles found in the other (so a short copied answer inside a
 *    long essay still shows). It is an indicator for a human to read the passages — never an automatic verdict.
 */
const zlib = require('zlib');

const K = 6;                     // words per shingle
const REPORT_AT = 0.15;          // pairs below this are not listed
const MAX_DOCS = 400;

// ---------------------------------------------------------------- text extraction
function zipEntry(buf, want) {
  try {
    let eocd = -1; const min = Math.max(0, buf.length - 22 - 65536);
    for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count && off + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) break;
      const method = buf.readUInt16LE(off + 10), size = buf.readUInt32LE(off + 20), nameLen = buf.readUInt16LE(off + 28), extra = buf.readUInt16LE(off + 30), comment = buf.readUInt16LE(off + 32), local = buf.readUInt32LE(off + 42);
      const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
      if (name === want) {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const comp = buf.subarray(start, start + size);
        return method === 8 ? zlib.inflateRawSync(comp) : comp;
      }
      off += 46 + nameLen + extra + comment;
    }
  } catch (_) { /* not a zip / damaged */ }
  return null;
}
const decodeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ''; } })
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch (_) { return ''; } }).replace(/&amp;/g, '&');
function xmlText(xml, paraClose) { return decodeXml(String(xml).replace(paraClose, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim(); }
function pdfString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]; if (ch !== '\\') { out += ch; continue; }
    const n = s[++i];
    if (n === 'n' || n === 'r') out += '\n'; else if (n === 't') out += ' ';
    else if (n >= '0' && n <= '7') { let o = n; for (let k = 0; k < 2 && s[i + 1] >= '0' && s[i + 1] <= '7'; k++) o += s[++i]; out += String.fromCharCode(parseInt(o, 8)); }
    else if (n !== undefined && n !== 'b' && n !== 'f') out += n;
  }
  return out;
}
function pdfText(buf) {
  const pieces = []; let idx = 0;
  while (idx < buf.length) {
    const st = buf.indexOf('stream', idx); if (st < 0) break;
    const dict = buf.toString('latin1', Math.max(0, st - 1500), st);
    let ds = st + 6; if (buf[ds] === 0x0d) ds++; if (buf[ds] === 0x0a) ds++;
    const en = buf.indexOf('endstream', ds); if (en < 0) break;
    idx = en + 9;
    if (/\/Subtype\s*\/Image/.test(dict) || /\/(DCTDecode|JPXDecode|CCITTFaxDecode|LZWDecode|ASCII85Decode)/.test(dict)) continue;
    let data = buf.subarray(ds, en);
    if (/\/FlateDecode/.test(dict)) { try { data = zlib.inflateSync(data); } catch (_) { try { data = zlib.inflateRawSync(data); } catch (_) { continue; } } }
    const c = data.toString('latin1'); if (c.indexOf('Tj') < 0 && c.indexOf('TJ') < 0) continue;
    const re = /\((?:[^()\\]|\\.)*\)\s*(?:Tj|'|")|\[(?:[^\]\\]|\\.)*\]\s*TJ/g; let m; const out = [];
    while ((m = re.exec(c))) { const tok = m[0]; if (tok[0] === '(') { const inner = /^\(((?:[^()\\]|\\.)*)\)/.exec(tok); if (inner) out.push(pdfString(inner[1])); } else out.push((tok.match(/\((?:[^()\\]|\\.)*\)/g) || []).map(p => pdfString(p.slice(1, -1))).join('')); }
    if (out.length) pieces.push(out.join(' '));
  }
  const text = pieces.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (!text) return '';
  const printable = (text.match(/[\x20-\x7e\n\r -ɏ]/g) || []).length;          // custom-encoded fonts come out as noise
  return printable / text.length >= 0.75 ? text : '';
}
function rtfText(s) { return String(s).replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^{}]*\}/g, '').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '').trim(); }
/** Best-effort plain text of an uploaded file ('' when it has no readable text layer). */
function extractText(buf, name, mime) {
  if (!buf || !buf.length) return '';
  const n = String(name || '').toLowerCase(); const m = String(mime || '').toLowerCase();
  try {
    if (n.endsWith('.docx') || /wordprocessingml/.test(m)) { const x = zipEntry(buf, 'word/document.xml'); return x ? xmlText(x.toString('utf8'), /<\/w:p>/g) : ''; }
    if (n.endsWith('.odt') || /opendocument\.text/.test(m)) { const x = zipEntry(buf, 'content.xml'); return x ? xmlText(x.toString('utf8'), /<\/text:p>/g) : ''; }
    if (n.endsWith('.pdf') || /pdf/.test(m)) return pdfText(buf);
    if (n.endsWith('.rtf') || /rtf/.test(m)) return rtfText(buf.toString('latin1'));
    if (/\.(txt|md|csv|py|js|java|c|cpp|html?|m|r|sql)$/.test(n) || /^text\//.test(m)) return buf.toString('utf8');
  } catch (_) { /* unreadable */ }
  return '';
}

// ---------------------------------------------------------------- fingerprints
function words(text) { return (String(text || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []); }
function h32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function shingleSet(tokens, k) { const set = new Set(); for (let i = 0; i + k <= tokens.length; i++) set.add(h32(tokens.slice(i, i + k).join(' '))); return set; }
/** The longest shared runs of wording (for a reader to judge), taken from A's text. */
function passages(tokensA, setB, ignore, k, max) {
  const runs = []; let start = -1, end = -1;
  for (let i = 0; i + k <= tokensA.length; i++) {
    const hh = h32(tokensA.slice(i, i + k).join(' '));
    const hit = setB.has(hh) && !ignore.has(hh);
    if (hit) { if (start < 0) start = i; end = i + k; } else if (start >= 0 && i >= end) { runs.push([start, end]); start = -1; }
  }
  if (start >= 0) runs.push([start, end]);
  return runs.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, max || 3).map(([s, e]) => ({ words: e - s, text: tokensA.slice(s, Math.min(e, s + 60)).join(' ') + (e - s > 60 ? ' …' : '') }));
}
const level = (score) => score >= 0.5 ? 'high' : score >= 0.25 ? 'medium' : 'low';

/**
 * docs: [{ id, name, text }]; opts: { template (the instructions), k, reportAt }.
 * → { docs: [{ id, name, words, readable, max, with, level }], pairs: [{ a, b, score, level, shared, passages }], ignored }
 */
function check(docs, opts = {}) {
  const k = opts.k || K; const reportAt = opts.reportAt == null ? REPORT_AT : opts.reportAt;
  const list = (docs || []).slice(0, MAX_DOCS).map(d => { const t = words(d.text); return { id: d.id, name: d.name, tokens: t, set: shingleSet(t, k) }; });
  const ignore = shingleSet(words(opts.template || ''), k);
  // wording a large part of the class shares is a template, not copying
  const index = new Map();
  list.forEach((d, i) => { for (const hh of d.set) { if (ignore.has(hh)) continue; let arr = index.get(hh); if (!arr) index.set(hh, arr = []); arr.push(i); } });
  const common = Math.max(4, Math.ceil(list.length * 0.5));
  const pairCount = new Map();
  for (const [hh, arr] of index) {
    if (arr.length >= common) { ignore.add(hh); continue; }
    if (arr.length < 2) continue;
    for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) { const key = arr[x] * 100000 + arr[y]; pairCount.set(key, (pairCount.get(key) || 0) + 1); }
  }
  const own = list.map(d => { let n = 0; for (const hh of d.set) if (!ignore.has(hh)) n++; return n; });
  const pairs = [];
  for (const [key, shared] of pairCount) {
    const i = Math.floor(key / 100000), j = key % 100000;
    const denom = Math.min(own[i], own[j]); if (!denom) continue;
    const score = Math.min(1, shared / denom);
    if (score < reportAt) continue;
    const [small, other] = own[i] <= own[j] ? [i, j] : [j, i];
    pairs.push({ a: list[i].id, b: list[j].id, a_name: list[i].name, b_name: list[j].name, score: Math.round(score * 1000) / 1000, level: level(score), shared,
      passages: passages(list[small].tokens, list[other].set, ignore, k, 3) });
  }
  pairs.sort((x, y) => y.score - x.score);
  const out = list.map((d, i) => {
    let max = 0, w = null;
    for (const p of pairs) if ((p.a === d.id || p.b === d.id) && p.score > max) { max = p.score; w = p.a === d.id ? p.b_name : p.a_name; }
    return { id: d.id, name: d.name, words: d.tokens.length, readable: d.tokens.length >= k, max, with: w, level: max ? level(max) : 'none' };
  });
  return { docs: out, pairs, ignored: ignore.size, k };
}

module.exports = { K, REPORT_AT, extractText, words, check, level, zipEntry };
