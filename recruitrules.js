'use strict';
/**
 * 👔 STAFF RECRUITMENT — pure rules shared by the desktop (HR pipeline) and the public jobs page on the portal:
 * which vacancies are open, what a valid application looks like (CV types and sizes, one application per person
 * per vacancy, a honeypot against bots) and how an applicant moves through the pipeline.
 */
const crypto = require('crypto');
const CM = require('./classmaterialrules');

const INLINE_MAX = 2 * 1024 * 1024, STORED_MAX = 8 * 1024 * 1024;
const CV_EXT = ['pdf', 'doc', 'docx', 'odt', 'rtf'];
const STAGES = ['applied', 'shortlisted', 'interview', 'offered', 'hired', 'rejected', 'withdrawn'];
const STAGE_LABEL = { applied: 'Applied', shortlisted: 'Shortlisted', interview: 'Interview', offered: 'Offer made', hired: 'Hired', rejected: 'Not successful', withdrawn: 'Withdrawn' };
const NEXT = { applied: ['shortlisted', 'rejected'], shortlisted: ['interview', 'rejected'], interview: ['offered', 'rejected'], offered: ['hired', 'rejected', 'withdrawn'], hired: [], rejected: ['applied'], withdrawn: [] };
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n || 1000); // eslint-disable-line no-control-regex
const EMAIL = /^[^@\s<>"']+@[^@\s<>"']+\.[a-z]{2,}$/i;

const applicationId = (vacancyId, email) => 'app_' + crypto.createHash('sha1').update(String(vacancyId) + '|' + String(email || '').trim().toLowerCase()).digest('hex').slice(0, 28);
const refFor = (id, year) => 'APP-' + (year || new Date().getFullYear()) + '-' + crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 6).toUpperCase();
function isOpen(v, today) { return !!v && !Number(v.deleted) && v.status === 'open' && (!v.closing_date || String(v.closing_date).slice(0, 10) >= String(today || new Date().toISOString()).slice(0, 10)); }
function validateApplication(v, input, storageOn, today) {
  if (!isOpen(v, today)) throw new Error('This vacancy is closed.');
  if (input && String(input.website || '').trim()) throw new Error('Your application could not be accepted.');   // honeypot: people never see this field
  const full_name = clean(input && input.full_name, 120); if (full_name.split(/\s+/).length < 2) throw new Error('Enter your full name.');
  const email = clean(input && input.email, 160).toLowerCase(); if (!EMAIL.test(email)) throw new Error('Enter a valid e-mail address.');
  const phone = clean(input && input.phone, 30); if (phone && !/^[+0-9 ()-]{6,30}$/.test(phone)) throw new Error('Enter a valid phone number.');
  const cover_letter = clean(input && input.cover_letter, 8000); if (cover_letter.length < 50) throw new Error('Write a short cover letter (at least a few sentences).');
  const f = input && input.cv; if (!f || !f.base64) throw new Error('Attach your CV (PDF or Word).');
  const name = String(f.name || 'cv').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
  const ext = ((name.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
  if (!CV_EXT.includes(ext)) throw new Error('The CV must be a PDF or Word document.');
  const b64 = String(f.base64).replace(/^data:[^,]*,/, ''); const size = CM.base64Bytes(b64); const max = storageOn ? STORED_MAX : INLINE_MAX;
  if (size > max) throw new Error(`The CV is ${CM.humanSize(size)} — the limit is ${CM.humanSize(max)}.`);
  return { full_name, email, phone: phone || null, cover_letter, cv: { name, mime: String(f.mime || 'application/octet-stream').slice(0, 100), base64: b64, size } };
}
function canMove(from, to) { return (NEXT[from] || []).includes(to); }

module.exports = { INLINE_MAX, STORED_MAX, CV_EXT, STAGES, STAGE_LABEL, NEXT, applicationId, refFor, isOpen, validateApplication, canMove, clean };
