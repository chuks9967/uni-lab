'use strict';
/**
 * 💬 COURSE FORUMS — pure rules shared by the desktop (moderation desk) and the portal (students + lecturers):
 * one Q&A board per course code. Students ask, anyone in the course answers; the lecturer (or the person who
 * asked) accepts an answer; lecturers pin, lock and hide; anyone can flag, and a post flagged by several
 * people is hidden until a moderator looks at it.
 */
const crypto = require('crypto');

const FLAG_HIDE = 3;                          // distinct flags that hide a post pending review
const EDIT_WINDOW_MIN = 15;                   // an author may delete their own post for 15 minutes
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, n || 5000); // eslint-disable-line no-control-regex
const ck = (code) => String(code || '').toUpperCase().replace(/\s+/g, '');

function validateThread(input) {
  const title = clean(input && input.title, 160).replace(/\s+/g, ' ');
  const body = clean(input && input.body, 5000);
  if (title.length < 5) throw new Error('Give your question a short title.');
  if (body.length < 2) throw new Error('Write your question.');
  return { title, body };
}
function validatePost(input) {
  const body = clean(input && input.body, 5000);
  if (body.length < 2) throw new Error('Write your reply.');
  return { body };
}
const flagId = (targetId, reporterKey) => 'fflag_' + crypto.createHash('sha1').update(String(targetId) + '|' + String(reporterKey)).digest('hex').slice(0, 26);
const REASONS = ['spam', 'abusive', 'cheating', 'off_topic', 'other'];
/** An author may take back their own post for a short while (not once it is the accepted answer). */
function canDelete(post, authorKey, nowMs) {
  if (!post || Number(post.deleted)) return false;
  if ((post.author_kind + ':' + post.author_id) !== authorKey) return false;
  if (Number(post.is_answer)) return false;
  const t = Date.parse(post.created_at); return !Number.isNaN(t) && ((nowMs || Date.now()) - t) <= EDIT_WINDOW_MIN * 60000;
}
/** Pinned first, then the most recently active. */
function sortThreads(list) {
  return (list || []).slice().sort((a, b) => (Number(b.pinned) || 0) - (Number(a.pinned) || 0) || String(b.last_post_at || b.created_at).localeCompare(String(a.last_post_at || a.created_at)));
}
/** What a viewer sees of a post: moderators see hidden posts (marked); authors see their own hidden post; others see a stub. */
function viewPost(p, viewerKey, isMod) {
  const mine = (p.author_kind + ':' + p.author_id) === viewerKey;
  const base = { id: p.id, author_name: p.author_name, author_kind: p.author_kind, created_at: p.created_at, is_answer: !!Number(p.is_answer), mine, flags: isMod ? Number(p.flags) || 0 : undefined };
  if (Number(p.hidden) && !isMod && !mine) return Object.assign(base, { hidden: true, body: '' });
  return Object.assign(base, { hidden: !!Number(p.hidden), body: p.body });
}

module.exports = { FLAG_HIDE, EDIT_WINDOW_MIN, REASONS, clean, ck, validateThread, validatePost, flagId, canDelete, sortThreads, viewPost };
