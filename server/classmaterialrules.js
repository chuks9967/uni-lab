'use strict';
/**
 * 📚 THE RULES A CLASS MATERIAL MUST OBEY — what kind of thing it is, whether its link is safe, and
 * how big it is.
 *
 * ⚠ SHARED ON PURPOSE. Material is published from TWO places: the desktop desk
 * (electron/services/classmaterials.js, where the administration works) and the staff portal
 * (server/portal.js, where the LECTURER works). If the two disagreed about what counts as a video,
 * or about which links are safe to hand a student, the same file would behave differently depending
 * on who uploaded it — and the link rule in particular is a security boundary, so having two copies
 * of it means having one that eventually rots.
 *
 * Pure: no DB, no filesystem, no clock. Unit-tested through test/liveclass-suite.js.
 */

// A material is at most this big when it rides INSIDE its row. The cap exists because a material
// SYNCS: on a hub-only install it travels as base64 in the row, and one 500MB lecture recording would
// poison every replica. Object storage lifts it — but only on the desktop path, which is the only one
// that can offload.
const INLINE_MAX = 12 * 1024 * 1024;
const OFFLOAD_MAX = 512 * 1024 * 1024;
const KINDS = ['reading', 'slides', 'video', 'audio', 'image', 'link', 'other'];

/**
 * What KIND of material is this? MIME first, extension second, because they disagree constantly: a
 * PDF arrives as `application/pdf`, `application/x-pdf`, or — from a phone's share sheet —
 * `application/octet-stream` with only the filename to go on.
 *
 * The kind is not cosmetic. It picks the icon, the sort order and, crucially, HOW a student opens it:
 * an image and a video play inline in the class drawer, a reading opens in the document viewer, a
 * link leaves the app. Guessing "other" for a video means a student cannot play it during the class.
 */
function kindOf(mime, filename, url) {
  if (url && !filename) return 'link';
  const m = String(mime || '').toLowerCase();
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = ext ? ext[1] : '';
  if (m.startsWith('video/') || ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v'].includes(e)) return 'video';
  if (m.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'opus', 'flac'].includes(e)) return 'audio';
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(e)) return 'image';
  if (/presentation|powerpoint/.test(m) || ['ppt', 'pptx', 'odp', 'key'].includes(e)) return 'slides';
  if (m === 'application/pdf' || /\bpdf\b/.test(m) || /word|opendocument\.text|rtf|epub/.test(m)
    || ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'epub'].includes(e)) return 'reading';
  return 'other';
}

/**
 * Normalise a LINK before it is ever handed to a student.
 *
 * ⚠ A SECURITY BOUNDARY, not a convenience. Whatever a lecturer pastes ends up in an `href` on the
 * phones of everyone in the class, so a `javascript:` or `data:` payload cannot be allowed through.
 * A bare `www.` address is completed because an unschemed link simply fails to open from a native
 * app — it looks like a broken material rather than a broken link. Anything that is not plainly
 * http(s) returns '' and the caller refuses it.
 */
function safeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (/^(javascript|data|vbscript|file):/i.test(s)) return '';
  if (!/^https?:\/\//i.test(s)) {
    if (/^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(s)) s = 'https://' + s;
    else return '';
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch (_) { return ''; }
}

/** Bytes represented by a base64 payload, WITHOUT decoding it (a 500MB decode to measure is absurd). */
function base64Bytes(b64) {
  const s = String(b64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(s.length * 3 / 4) - pad);
}

/** A human size, for the UI and for refusal messages ("that file is 41.2MB — the limit is 12MB"). */
function humanSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

module.exports = { kindOf, safeUrl, base64Bytes, humanSize, KINDS, INLINE_MAX, OFFLOAD_MAX };
