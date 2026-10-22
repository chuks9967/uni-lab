'use strict';
/**
 * 📝 COURSEWORK — pure rules for assignments, shared by the desktop and the portal (the lecturer sets and grades
 * on the staff portal, students submit on the student portal / app, the academic offices oversee on the desktop).
 *
 * Times are the institution's LOCAL wall clock as "YYYY-MM-DDTHH:MM" strings (what a datetime-local field gives),
 * compared as strings — the caller passes "now" on the same clock (apptrules.localNow on a cloud server in UTC).
 */
const crypto = require('crypto');
const CM = require('./classmaterialrules');

const INLINE_MAX = 2 * 1024 * 1024;       // a file kept INSIDE the synced row (no object storage connected)
const STORED_MAX = 15 * 1024 * 1024;      // a file sent to object storage
const TEXT_MAX = 20000;
const OK_EXT = ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods', 'csv', 'zip', 'png', 'jpg', 'jpeg', 'py', 'java', 'c', 'cpp', 'js', 'ts', 'ipynb', 'sql', 'html', 'r', 'm'];
const submissionId = (assignmentId, studentId) => 'as_' + crypto.createHash('sha1').update(String(assignmentId) + '|' + String(studentId)).digest('hex').slice(0, 28);
const stamp = (s) => String(s || '').replace(' ', 'T').slice(0, 16);

/** draft · upcoming · open · late (past due, late window still open) · closed */
function state(a, now) {
  if (!a || a.status === 'draft') return 'draft';
  if (a.status === 'closed') return 'closed';
  const n = stamp(now), o = stamp(a.opens_at), d = stamp(a.due_at), l = stamp(a.late_until);
  if (o && n < o) return 'upcoming';
  if (!d || n <= d) return 'open';
  if (l && n <= l) return 'late';
  return 'closed';
}
function canSubmit(a, existing, now) {
  const st = state(a, now);
  if (st === 'draft') return { ok: false, error: 'This assignment is not published.' };
  if (st === 'upcoming') return { ok: false, error: 'Submissions open on ' + stamp(a.opens_at).replace('T', ' ') + '.' };
  if (st === 'closed') return { ok: false, error: 'Submissions are closed.' };
  if (existing && existing.status === 'graded') return { ok: false, error: 'Your submission has already been graded.' };
  return { ok: true, late: st === 'late' };
}
/** Check and normalise what a student hands in. `file` = { name, mime, base64 } (optional). */
function validateSubmission(a, input, storageOn) {
  const text = String((input && input.text) || '').replace(/\r\n?/g, '\n').trim().slice(0, TEXT_MAX);
  const linkRaw = String((input && input.link) || '').trim();
  const link = linkRaw ? CM.safeUrl(linkRaw) : '';
  if (linkRaw && !link) throw new Error('The link must be a normal web address (https://…).');
  let file = null;
  if (input && input.file && input.file.base64) {
    if (!Number(a.allow_file)) throw new Error('This assignment does not take file uploads.');
    const name = String(input.file.name || 'submission').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
    if (!ext || !OK_EXT.includes(ext.toLowerCase())) throw new Error('That file type is not accepted (use PDF, Word, PowerPoint, Excel, text, images, code or ZIP).');
    const b64 = String(input.file.base64).replace(/^data:[^,]*,/, '');
    const size = CM.base64Bytes(b64);
    const max = storageOn ? STORED_MAX : INLINE_MAX;
    if (size > max) throw new Error(`The file is ${CM.humanSize(size)} — the limit is ${CM.humanSize(max)}${storageOn ? '' : ' (ask the administrator to connect cloud storage for larger files, or submit a link)'}.`);
    file = { name, mime: String(input.file.mime || 'application/octet-stream').slice(0, 100), base64: b64, size };
  }
  if (text && !Number(a.allow_text)) throw new Error('This assignment does not take typed answers.');
  if (link && !Number(a.allow_link)) throw new Error('This assignment does not take links.');
  if (!text && !link && !file) throw new Error('Nothing to submit — type your answer, add a file or a link.');
  return { text, link, file };
}
function checkScore(a, score) {
  const n = Number(score); const max = Number(a && a.max_score) || 100;
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`The score must be between 0 and ${max}.`);
  return Math.round(n * 100) / 100;
}
/** Class-level picture of an assignment. */
function stats(a, subs, cohortSize) {
  const live = (subs || []).filter(s => s && !s.deleted);
  const graded = live.filter(s => s.status === 'graded');
  const avg = graded.length ? Math.round(graded.reduce((t, s) => t + (Number(s.score) || 0), 0) / graded.length * 10) / 10 : null;
  return { submitted: live.length, graded: graded.length, late: live.filter(s => Number(s.late)).length, missing: Math.max(0, (Number(cohortSize) || 0) - live.length), to_grade: live.length - graded.length, average: avg, max: Number(a && a.max_score) || 100 };
}
function normalizeAssignment(data) {
  const out = {};
  if (data.title !== undefined) { out.title = String(data.title || '').trim().slice(0, 200); if (!out.title) throw new Error('Give the assignment a title.'); }
  if (data.instructions !== undefined) out.instructions = String(data.instructions || '').trim().slice(0, 20000) || null;
  for (const k of ['opens_at', 'due_at', 'late_until']) if (data[k] !== undefined) { const v = stamp(data[k]); if (v && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) throw new Error('Use a full date and time.'); out[k] = v || null; }
  if (out.due_at && out.opens_at && out.due_at < out.opens_at) throw new Error('The deadline is before the opening time.');
  if (out.late_until && out.due_at && out.late_until < out.due_at) throw new Error('The late window ends before the deadline.');
  if (data.max_score !== undefined) { out.max_score = Number(data.max_score); if (!(out.max_score > 0 && out.max_score <= 1000)) throw new Error('The maximum score must be between 1 and 1000.'); }
  if (data.weight !== undefined) out.weight = Math.max(0, Math.min(100, Number(data.weight) || 0));
  for (const k of ['allow_text', 'allow_file', 'allow_link']) if (data[k] !== undefined) out[k] = data[k] ? 1 : 0;
  if (data.resource_url !== undefined) { const u = String(data.resource_url || '').trim(); out.resource_url = u ? (CM.safeUrl(u) || (() => { throw new Error('The resource link must be a normal web address.'); })()) : null; }
  return out;
}

module.exports = { INLINE_MAX, STORED_MAX, OK_EXT, submissionId, state, canSubmit, validateSubmission, checkScore, stats, normalizeAssignment, stamp };
