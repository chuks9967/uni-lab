'use strict';
/** Minimal, dependency-free QR Code encoder (byte mode).
 *  Ported from Kazuhiko Arase's qrcode-generator (MIT). Supports versions 1–10
 *  and EC levels L/M/Q/H, and renders a crisp SVG (ideal for printToPDF).
 *  Used to put a scannable verification code on clearance certificates. */

const MODE_8BIT = 4;
const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 }; // QR error-correction indicator bits

const QRMath = (() => {
  const EXP = new Array(256); const LOG = new Array(256);
  for (let i = 0; i < 8; i++) EXP[i] = 1 << i;
  for (let i = 8; i < 256; i++) EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8];
  for (let i = 0; i < 255; i++) LOG[EXP[i]] = i;
  return {
    glog: (n) => { if (n < 1) throw new Error('glog(' + n + ')'); return LOG[n]; },
    gexp: (n) => { while (n < 0) n += 255; while (n >= 256) n -= 255; return EXP[n]; },
  };
})();

function Poly(num, shift) {
  let offset = 0; while (offset < num.length && num[offset] === 0) offset++;
  this.num = new Array(num.length - offset + shift);
  for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
}
Poly.prototype.get = function (i) { return this.num[i]; };
Poly.prototype.len = function () { return this.num.length; };
Poly.prototype.multiply = function (e) {
  const num = new Array(this.len() + e.len() - 1).fill(0);
  for (let i = 0; i < this.len(); i++) for (let j = 0; j < e.len(); j++) num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
  return new Poly(num, 0);
};
Poly.prototype.mod = function (e) {
  if (this.len() - e.len() < 0) return this;
  const ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));
  const num = this.num.slice();
  for (let i = 0; i < e.len(); i++) num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
  return new Poly(num, 0).mod(e);
};
function ecPolynomial(ecLength) {
  let poly = new Poly([1], 0);
  for (let i = 0; i < ecLength; i++) poly = poly.multiply(new Poly([1, QRMath.gexp(i)], 0));
  return poly;
}

// RS block table, versions 1..10, rows ordered [L, M, Q, H]; triples of (count,total,data)
const RS_BLOCK = [
  [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
  [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
  [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
  [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
  [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12],
  [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15],
  [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14],
  [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15],
  [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13],
  [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16],
];
function rsBlocks(version, ec) {
  const def = RS_BLOCK[(version - 1) * 4 + ({ L: 0, M: 1, Q: 2, H: 3 })[ec]];
  if (!def) throw new Error('QR: unsupported version/EC');
  const list = [];
  for (let i = 0; i < def.length; i += 3) for (let j = 0; j < def[i]; j++) list.push({ total: def[i + 1], data: def[i + 2] });
  return list;
}

const PATTERN_POSITION = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const G15 = 0b10100110111; const G18 = 0b1111100100101; const G15_MASK = 0b101010000010010;
function bchDigit(d) { let n = 0; while (d !== 0) { n++; d >>>= 1; } return n; }
function bchTypeInfo(data) { let d = data << 10; while (bchDigit(d) - bchDigit(G15) >= 0) d ^= (G15 << (bchDigit(d) - bchDigit(G15))); return ((data << 10) | d) ^ G15_MASK; }
function bchTypeNumber(data) { let d = data << 12; while (bchDigit(d) - bchDigit(G18) >= 0) d ^= (G18 << (bchDigit(d) - bchDigit(G18))); return (data << 12) | d; }

function BitBuffer() { this.buffer = []; this.length = 0; }
BitBuffer.prototype.putBit = function (bit) {
  const idx = Math.floor(this.length / 8);
  if (this.buffer.length <= idx) this.buffer.push(0);
  if (bit) this.buffer[idx] |= (0x80 >>> (this.length % 8));
  this.length++;
};
BitBuffer.prototype.put = function (num, len) { for (let i = 0; i < len; i++) this.putBit(((num >>> (len - i - 1)) & 1) === 1); };

const PAD0 = 0xEC; const PAD1 = 0x11;
function createData(version, ec, bytes) {
  const blocks = rsBlocks(version, ec);
  const buf = new BitBuffer();
  buf.put(MODE_8BIT, 4);
  buf.put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) buf.put(b, 8);
  const totalData = blocks.reduce((s, b) => s + b.data, 0);
  if (buf.length > totalData * 8) throw new Error('QR: overflow');
  if (buf.length + 4 <= totalData * 8) buf.put(0, 4);
  while (buf.length % 8 !== 0) buf.putBit(false);
  for (;;) { if (buf.length >= totalData * 8) break; buf.put(PAD0, 8); if (buf.length >= totalData * 8) break; buf.put(PAD1, 8); }
  return createBytes(buf, blocks);
}
function createBytes(buf, blocks) {
  let offset = 0; let maxDc = 0; let maxEc = 0; const dcData = []; const ecData = [];
  for (const blk of blocks) {
    const dcCount = blk.data; const ecCount = blk.total - blk.data;
    maxDc = Math.max(maxDc, dcCount); maxEc = Math.max(maxEc, ecCount);
    const dc = new Array(dcCount);
    for (let i = 0; i < dcCount; i++) dc[i] = 0xff & buf.buffer[i + offset];
    offset += dcCount;
    const rsPoly = ecPolynomial(ecCount);
    const modPoly = new Poly(dc, rsPoly.len() - 1).mod(rsPoly);
    const ec = new Array(rsPoly.len() - 1);
    for (let i = 0; i < ec.length; i++) { const mi = i + modPoly.len() - ec.length; ec[i] = mi >= 0 ? modPoly.get(mi) : 0; }
    dcData.push(dc); ecData.push(ec);
  }
  const total = blocks.reduce((s, b) => s + b.total, 0);
  const data = new Array(total); let index = 0;
  for (let i = 0; i < maxDc; i++) for (let r = 0; r < blocks.length; r++) if (i < dcData[r].length) data[index++] = dcData[r][i];
  for (let i = 0; i < maxEc; i++) for (let r = 0; r < blocks.length; r++) if (i < ecData[r].length) data[index++] = ecData[r][i];
  return data;
}

function maskFn(p, i, j) {
  switch (p) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return (i * j) % 2 + (i * j) % 3 === 0;
    case 6: return ((i * j) % 2 + (i * j) % 3) % 2 === 0;
    case 7: return ((i * j) % 3 + (i + j) % 2) % 2 === 0;
    default: throw new Error('mask ' + p);
  }
}

function Model(version, ec) { this.version = version; this.ec = ec; this.n = version * 4 + 17; this.modules = null; this.dataCache = null; }
Model.prototype.isDark = function (r, c) { return this.modules[r][c] === true; };
Model.prototype.make = function (bytes) { this.dataCache = createData(this.version, this.ec, bytes); this.makeImpl(false, this.bestMask()); };
Model.prototype.bestMask = function () {
  let min = 0; let best = 0;
  for (let i = 0; i < 8; i++) { this.makeImpl(true, i); const lost = lostPoint(this); if (i === 0 || lost < min) { min = lost; best = i; } }
  return best;
};
Model.prototype.makeImpl = function (test, mask) {
  const n = this.n;
  this.modules = Array.from({ length: n }, () => new Array(n).fill(null));
  this.probe(0, 0); this.probe(n - 7, 0); this.probe(0, n - 7);
  this.adjust(); this.timing();
  this.typeInfo(test, mask);
  if (this.version >= 7) this.typeNumber(test);
  this.mapData(this.dataCache, mask);
};
Model.prototype.probe = function (row, col) {
  for (let r = -1; r <= 7; r++) {
    if (row + r <= -1 || this.n <= row + r) continue;
    for (let c = -1; c <= 7; c++) {
      if (col + c <= -1 || this.n <= col + c) continue;
      const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      this.modules[row + r][col + c] = dark;
    }
  }
};
Model.prototype.timing = function () {
  for (let i = 8; i < this.n - 8; i++) {
    if (this.modules[i][6] === null) this.modules[i][6] = i % 2 === 0;
    if (this.modules[6][i] === null) this.modules[6][i] = i % 2 === 0;
  }
};
Model.prototype.adjust = function () {
  const pos = PATTERN_POSITION[this.version - 1];
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    const row = pos[i]; const col = pos[j];
    if (this.modules[row][col] !== null) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) this.modules[row + r][col + c] = (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0));
  }
};
Model.prototype.typeNumber = function (test) {
  const bits = bchTypeNumber(this.version);
  for (let i = 0; i < 18; i++) { const mod = !test && ((bits >> i) & 1) === 1; this.modules[Math.floor(i / 3)][i % 3 + this.n - 8 - 3] = mod; }
  for (let i = 0; i < 18; i++) { const mod = !test && ((bits >> i) & 1) === 1; this.modules[i % 3 + this.n - 8 - 3][Math.floor(i / 3)] = mod; }
};
Model.prototype.typeInfo = function (test, mask) {
  const data = (EC_BITS[this.ec] << 3) | mask;
  const bits = bchTypeInfo(data);
  for (let i = 0; i < 15; i++) {
    const mod = !test && ((bits >> i) & 1) === 1;
    if (i < 6) this.modules[i][8] = mod; else if (i < 8) this.modules[i + 1][8] = mod; else this.modules[this.n - 15 + i][8] = mod;
  }
  for (let i = 0; i < 15; i++) {
    const mod = !test && ((bits >> i) & 1) === 1;
    if (i < 8) this.modules[8][this.n - i - 1] = mod; else if (i < 9) this.modules[8][15 - i - 1 + 1] = mod; else this.modules[8][15 - i - 1] = mod;
  }
  this.modules[this.n - 8][8] = !test;
};
Model.prototype.mapData = function (data, mask) {
  let inc = -1; let row = this.n - 1; let bitIndex = 7; let byteIndex = 0;
  for (let col = this.n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (this.modules[row][col - c] === null) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          if (maskFn(mask, row, col - c)) dark = !dark;
          this.modules[row][col - c] = dark;
          bitIndex--;
          if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
        }
      }
      row += inc;
      if (row < 0 || this.n <= row) { row -= inc; inc = -inc; break; }
    }
  }
};

function lostPoint(qr) {
  const n = qr.n; let lost = 0;
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
    let same = 0; const dark = qr.isDark(row, col);
    for (let r = -1; r <= 1; r++) { if (row + r < 0 || n <= row + r) continue; for (let c = -1; c <= 1; c++) { if (col + c < 0 || n <= col + c) continue; if (r === 0 && c === 0) continue; if (dark === qr.isDark(row + r, col + c)) same++; } }
    if (same > 5) lost += (3 + same - 5);
  }
  for (let row = 0; row < n - 1; row++) for (let col = 0; col < n - 1; col++) {
    let count = 0;
    if (qr.isDark(row, col)) count++; if (qr.isDark(row + 1, col)) count++; if (qr.isDark(row, col + 1)) count++; if (qr.isDark(row + 1, col + 1)) count++;
    if (count === 0 || count === 4) lost += 3;
  }
  for (let row = 0; row < n; row++) for (let col = 0; col < n - 6; col++) {
    if (qr.isDark(row, col) && !qr.isDark(row, col + 1) && qr.isDark(row, col + 2) && qr.isDark(row, col + 3) && qr.isDark(row, col + 4) && !qr.isDark(row, col + 5) && qr.isDark(row, col + 6)) lost += 40;
  }
  for (let col = 0; col < n; col++) for (let row = 0; row < n - 6; row++) {
    if (qr.isDark(row, col) && !qr.isDark(row + 1, col) && qr.isDark(row + 2, col) && qr.isDark(row + 3, col) && qr.isDark(row + 4, col) && !qr.isDark(row + 5, col) && qr.isDark(row + 6, col)) lost += 40;
  }
  let darkCount = 0;
  for (let col = 0; col < n; col++) for (let row = 0; row < n; row++) if (qr.isDark(row, col)) darkCount++;
  const ratio = Math.abs(100 * darkCount / n / n - 50) / 5;
  lost += ratio * 10;
  return lost;
}

function toBytes(text) {
  // UTF-8 encode
  const out = [];
  for (const ch of String(text)) {
    let code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (code < 0x800) { out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f)); }
    else if (code < 0x10000) { out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)); }
    else { out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)); }
  }
  return out;
}

function encode(text, ec = 'M') {
  const bytes = toBytes(text);
  for (let v = 1; v <= 10; v++) {
    try { const m = new Model(v, ec); m.make(bytes); return m; } catch (_) { /* too small — try next version */ }
  }
  throw new Error('QR: data too long for supported versions');
}

/** Render a QR for `text` as an SVG string. */
function toSVG(text, opts = {}) {
  const ec = opts.ec || 'M';
  const cell = opts.cellSize || 4;
  const margin = opts.margin != null ? opts.margin : 4;
  const dark = opts.dark || '#0b1320';
  const light = opts.light || '#ffffff';
  const m = encode(text, ec);
  const n = m.n; const size = (n + margin * 2) * cell;
  let rects = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m.isDark(r, c)) {
    rects += `<rect x="${(c + margin) * cell}" y="${(r + margin) * cell}" width="${cell}" height="${cell}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`;
}

/** SVG as a data URL (handy for <img src>). */
function toDataURL(text, opts = {}) {
  return 'data:image/svg+xml;base64,' + Buffer.from(toSVG(text, opts), 'utf8').toString('base64');
}

module.exports = { toSVG, toDataURL, encode };
