'use strict';
/**
 * 📚 THE PROJECT REPOSITORY — ONE pure module (desk · portal · edge) for the institution's completed final-year projects
 * and theses: students and staff search them (title, abstract, keywords, supervisor, year), and a student checks an
 * idea against them BEFORE proposing it — with the SAME similarity the department uses to vet topics
 * (defenserules.similarTopics), so "already done here" means the same thing to both.
 *
 * Access is set when the final copy is deposited:
 *   open     — abstract + full text for everyone signed in to the university
 *   abstract — abstract only; the full text on request (the default)
 *   embargo  — title and year only, until the embargo date (then it shows as "abstract")
 * The author and staff always see the link.
 *
 *   ACCESS · validateDeposit(input, today) · listed(t) · accessOf(t, today) · entry(t, ctx) · search(entries, q, f) · similarTo(entries, idea)
 */
const DEFR = require('./defenserules');
const ACCESS = { open: 'Full text for the university', abstract: 'Abstract only — full text on request', embargo: 'Embargoed' };
const day = (v) => String(v || '').slice(0, 10);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n || 500); // eslint-disable-line no-control-regex
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 1);

function validateDeposit(input, today) {
  const x = input || {}; const t = day(today || new Date().toISOString());
  const access = ACCESS[x.access] ? x.access : 'abstract';
  let embargo = null;
  if (access === 'embargo') {
    embargo = day(x.embargo_until);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(embargo) || embargo <= t) return { ok: false, error: 'An embargo needs a date after today.' };
    if (embargo > String(Number(t.slice(0, 4)) + 5) + t.slice(4)) return { ok: false, error: 'An embargo is at most five years.' };
  }
  const keywords = [...new Set((Array.isArray(x.keywords) ? x.keywords : String(x.keywords || '').split(/[,;]/)).map(k => clean(k, 40).toLowerCase()).filter(Boolean))].slice(0, 8);
  return { ok: true, deposit: { repo_access: access, embargo_until: embargo, keywords: keywords.length ? JSON.stringify(keywords) : null, abstract: x.abstract ? clean(x.abstract, 4000) : undefined } };
}

/** In the repository: deposited, or completed with a passed defence. */
const listed = (t) => !!t && !Number(t.deleted) && (!!t.deposited_at || (t.status === 'completed' && !!t.outcome && !['fail', 'resubmit'].includes(t.outcome)));
function accessOf(t, today) {
  const a = ACCESS[t && t.repo_access] ? t.repo_access : 'abstract';
  return a === 'embargo' && t.embargo_until && day(t.embargo_until) <= day(today || new Date().toISOString()) ? 'abstract' : a;
}
const kw = (t) => { try { return JSON.parse(t.keywords || '[]') || []; } catch (_) { return []; } };

/** One project as a viewer may see it. ctx: { today, viewer: { kind, id }, name(id), dept(id) } */
function entry(t, ctx) {
  const c = ctx || {}; const acc = accessOf(t, c.today); const v = c.viewer || {};
  const mine = v.kind === 'student' && v.id === t.student_id; const staff = v.kind === 'staff' || v.kind === 'user';
  return { id: t.id, title: t.title || '', year: String(t.completed_at || t.deposited_at || t.start_date || '').slice(0, 4), programme: t.programme || '',
    department: c.dept ? c.dept(t.department_id) || '' : '', supervisor: c.name ? c.name(t.supervisor_id) || '' : '', author: c.name && t.student_name ? t.student_name : undefined,
    keywords: acc === 'embargo' ? [] : kw(t), access: acc, access_label: ACCESS[acc], embargo_until: acc === 'embargo' ? day(t.embargo_until) : null,
    abstract: acc === 'embargo' ? '' : String(t.abstract || '').slice(0, 1500),
    link: (acc === 'open' || mine || staff) && t.deposit_link ? t.deposit_link : null };
}

/** Search: every word must appear somewhere (title, abstract, keywords, supervisor, programme); title hits first, newest next. */
function search(entries, q, f) {
  const ws = words(q); const o = f || {};
  return (entries || []).filter(e => (!o.department || e.department === o.department) && (!o.year || e.year === String(o.year)))
    .map(e => { const hay = words([e.title, e.abstract, (e.keywords || []).join(' '), e.supervisor, e.programme].join(' ')); const tw = words(e.title);
      const hit = ws.every(w => hay.some(h => h.startsWith(w))); const inTitle = ws.filter(w => tw.some(h => h.startsWith(w))).length;
      return { e, hit: !ws.length || hit, inTitle }; })
    .filter(x => x.hit).sort((a, b) => b.inTitle - a.inTitle || String(b.e.year).localeCompare(String(a.e.year)) || a.e.title.localeCompare(b.e.title)).map(x => x.e);
}

/** "Is my idea already done here?" — the department's own similarity rule, against the repository. */
function similarTo(entries, idea) {
  const t = clean(idea, 300); if (words(t).length < 2) return [];
  return DEFR.similarTopics(t, (entries || []).map(e => ({ id: e.id, kind: 'project', title: e.title, who: '', year: e.year })))
    .slice(0, 5).map(x => ({ id: x.id, title: x.title, year: x.year, level: x.level, score: x.score }));
}

module.exports = { ACCESS, validateDeposit, listed, accessOf, entry, search, similarTo };
