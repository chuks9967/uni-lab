'use strict';
/**
 * 📝 THIS MONTH IN BRIEF — a plain-language management summary written FROM THE FIGURES (no model, nothing invented):
 * the headline first, then collections against last month and last year, what is owed and how long debtors take,
 * who has paid this session, targets slipping, promises broken, separation-of-duties errors, sign-offs and restated
 * months. ONE writer shared by the desk (analysis tab, packs, the monthly e-mails) and the portal / app (a dean's or
 * HOD's report), so the same facts read the same way everywhere — in English or French (opts.lang; other languages
 * fall back to English).
 *
 * brief(facts, { money, lang }) → { headline, tone, headline_area, points: [{ tone: good|warn|bad|info, area, text }] }
 * Every fact is optional — a point is written only when its figures are there.
 */
const RANK = { bad: 0, warn: 1, info: 2, good: 3 };
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};
const langOf = (l) => (String(l || '').toLowerCase().startsWith('fr') ? 'fr' : 'en');
function monthName(ym, lang) { const m = /^(\d{4})-(\d{2})$/.exec(String(ym || '')); if (!m) return String(ym || ''); return MONTHS[langOf(lang)][Number(m[2]) - 1] + ' ' + m[1]; }
const r1 = (v) => Math.round(Number(v) * 10) / 10;
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

// Every sentence, per language. English is the reference wording (the tests read it word for word).
const P = {
  en: {
    pc: (v) => Math.round(Number(v) * 1000) / 10 + '%',
    money: (v, c) => (c ? c + ' ' : '') + Math.round(Number(v) || 0).toLocaleString('en'),
    collected: (amt, mon) => amt + ' collected in ' + mon,
    nothingIn: (cur, mon) => 'Nothing in ' + cur + ' collected in ' + mon,
    mom: (v) => (v > 0 ? 'up ' : 'down ') + Math.abs(r1(v)) + '% on the month before',
    yoy: (v) => (v > 0 ? 'up ' : 'down ') + Math.abs(r1(v)) + '% on the same month last year',
    and: ' and ',
    owed: (amt, dso) => amt + ' is owed by students' + (dso != null ? '; on average they take about ' + plural(dso, 'day') + ' to pay' : '') + '.',
    rise: (l, amt) => 'the biggest rise was ' + l + ' (+' + amt + ')', fall: (l, amt) => 'the biggest fall was ' + l + ' (−' + amt + ')',
    census: (full, n, sess, none) => (full != null ? full + '% of the ' + plural(n, 'current student') + ' are fully paid for ' + (sess || 'the session') : plural(n, 'current student')) + (none ? '; ' + plural(none, 'student has', 'students have') + ' paid nothing yet' : '') + '.',
    met: (s, tp, rate) => s + ' has met its ' + tp + ' collection target (' + rate + ' collected).',
    behind: (s, tp, rate, exp, amt, due) => s + ' is behind its ' + tp + ' target: ' + rate + ' collected where ' + exp + ' was needed by now — ' + amt + ' still to collect by ' + due + '.',
    missed: (s, tp, due, rate) => s + ' missed its ' + tp + ' target (due ' + due + '): ' + rate + ' collected.',
    promises: (p) => plural(p.pending, 'promise to pay is', 'promises to pay are') + ' pending' + (p.due_7 ? ' (' + p.due_7 + ' due this week)' : '') + (p.kept ? '; ' + p.kept + ' kept' : '') + (p.broken ? '; ' + p.broken + ' broken — call those students again' : '') + '.',
    ctlErrors: (n, top) => plural(n, 'separation-of-duties error') + ' to look into' + (top.length ? ': ' + top.slice(0, 2).map(x => x.title.toLowerCase() + ' (' + x.count + ')').join(', ') : '') + '.',
    ctlWarn: (n) => 'No separation-of-duties errors; ' + plural(n, 'warning') + ' worth a look.',
    ctlOk: () => 'Every separation-of-duties control passed.',
    signoff: (so, mon) => so.confirmed + ' of ' + plural(so.officers, 'officer') + ' confirmed their ' + mon + ' statements' + (so.waiting ? '; ' + so.waiting + ' not yet' : '') + (so.disputed ? '; ' + so.disputed + ' disputed' : '') + (so.changed ? '; ' + so.changed + ' changed after confirming' : '') + '.',
    filings: (months) => 'Filed reports changed after filing: ' + months + ' — see Filed reports.',
    accessChanged: () => 'Access to money has changed since it was certified — review it again.',
    accessDue: (q) => 'Access to money is not yet certified for ' + q + '.',
    nothing: 'Nothing recorded yet.',
  },
  fr: {
    pc: (v) => String(Math.round(Number(v) * 1000) / 10).replace('.', ',') + ' %',
    money: (v, c) => Math.round(Number(v) || 0).toLocaleString('fr-FR') + (c ? ' ' + c : ''),
    collected: (amt, mon) => amt + ' encaissés en ' + mon,
    nothingIn: (cur, mon) => 'Rien encaissé en ' + cur + ' en ' + mon,
    mom: (v) => (v > 0 ? 'en hausse de ' : 'en baisse de ') + String(Math.abs(r1(v))).replace('.', ',') + ' % par rapport au mois précédent',
    yoy: (v) => (v > 0 ? 'en hausse de ' : 'en baisse de ') + String(Math.abs(r1(v))).replace('.', ',') + ' % par rapport au même mois l’an dernier',
    and: ' et ',
    owed: (amt, dso) => 'Les étudiants doivent ' + amt + (dso != null ? ' ; ils mettent en moyenne environ ' + dso + ' jour' + (dso === 1 ? '' : 's') + ' à payer' : '') + '.',
    rise: (l, amt) => 'la plus forte hausse : ' + l + ' (+' + amt + ')', fall: (l, amt) => 'la plus forte baisse : ' + l + ' (−' + amt + ')',
    census: (full, n, sess, none) => (full != null ? String(full).replace('.', ',') + ' % des ' + n + ' étudiant' + (n === 1 ? '' : 's') + ' actuel' + (n === 1 ? '' : 's') + ' sont à jour pour ' + (sess || 'la session') : n + ' étudiant' + (n === 1 ? '' : 's') + ' actuel' + (n === 1 ? '' : 's')) + (none ? ' ; ' + none + (none === 1 ? ' n’a encore rien payé' : ' n’ont encore rien payé') : '') + '.',
    met: (s, tp, rate) => s + ' a atteint son objectif d’encaissement de ' + tp + ' (' + rate + ' encaissés).',
    behind: (s, tp, rate, exp, amt, due) => s + ' est en retard sur son objectif de ' + tp + ' : ' + rate + ' encaissés alors que ' + exp + ' étaient nécessaires à ce jour — ' + amt + ' restent à encaisser d’ici le ' + due + '.',
    missed: (s, tp, due, rate) => s + ' n’a pas atteint son objectif de ' + tp + ' (échéance ' + due + ') : ' + rate + ' encaissés.',
    promises: (p) => p.pending + ' promesse' + (p.pending === 1 ? '' : 's') + ' de paiement en attente' + (p.due_7 ? ' (' + p.due_7 + ' cette semaine)' : '') + (p.kept ? ' ; ' + p.kept + ' tenue' + (p.kept === 1 ? '' : 's') : '') + (p.broken ? ' ; ' + p.broken + ' non tenue' + (p.broken === 1 ? '' : 's') + ' — rappelez ces étudiants' : '') + '.',
    ctlErrors: (n, top) => n + ' erreur' + (n === 1 ? '' : 's') + ' de séparation des tâches à examiner' + (top.length ? ' : ' + top.slice(0, 2).map(x => x.title + ' (' + x.count + ')').join(', ') : '') + '.',
    ctlWarn: (n) => 'Aucune erreur de séparation des tâches ; ' + n + ' avertissement' + (n === 1 ? '' : 's') + ' à vérifier.',
    ctlOk: () => 'Tous les contrôles de séparation des tâches sont satisfaits.',
    signoff: (so, mon) => so.confirmed + ' agent' + (so.officers === 1 ? '' : 's') + ' sur ' + so.officers + ' ont confirmé leurs relevés de ' + mon + (so.waiting ? ' ; ' + so.waiting + ' pas encore' : '') + (so.disputed ? ' ; ' + so.disputed + ' contesté' + (so.disputed === 1 ? '' : 's') : '') + (so.changed ? ' ; ' + so.changed + ' modifié' + (so.changed === 1 ? '' : 's') + ' après confirmation' : '') + '.',
    filings: (months) => 'Rapports modifiés après leur archivage : ' + months + ' — voir Rapports archivés.',
    accessChanged: () => 'Les accès à l’argent ont changé depuis leur certification — à revoir.',
    accessDue: (q) => 'Les accès à l’argent ne sont pas encore certifiés pour ' + q + '.',
    nothing: 'Aucune donnée enregistrée pour l’instant.',
  },
};

function brief(f = {}, opts = {}) {
  const lang = langOf(opts.lang); const T = P[lang];
  const M = opts.money || T.money; const pts = []; const add = (tone, area, text) => pts.push({ tone, area, text });
  const mon = monthName(f.month, lang);
  // 💰 collections (the main currency first)
  for (const k of (f.kpis || []).filter(x => x && (x.collected || x.prev_collected || x.receivables)).slice(0, 3)) {
    if (k.collected || k.prev_collected) {   // a currency with nothing collected this month or last gets no collections line
      let t = k.collected ? T.collected(M(k.collected, k.currency), mon) : T.nothingIn(k.currency, mon);
      const bits = []; if (k.mom_pct != null && k.prev_collected) bits.push(T.mom(k.mom_pct)); if (k.yoy_pct != null && k.yoy_collected) bits.push(T.yoy(k.yoy_pct));
      if (bits.length) t += ' — ' + bits.join(T.and); t += '.';
      add(k.mom_pct != null && k.prev_collected && k.mom_pct < -10 ? 'warn' : 'good', 'collections', t);
    }
    if (k.receivables > 0) add(k.dso_days != null && k.dso_days > 90 ? 'warn' : 'info', 'receivables', T.owed(M(k.receivables, k.currency), k.dso_days != null ? k.dso_days : null));
  }
  // 📈 biggest movers
  const mv = (f.movers || []).filter(x => x && x.change);
  if (mv.length) {
    const up = [...mv].sort((a, b) => b.change - a.change)[0], dn = [...mv].sort((a, b) => a.change - b.change)[0];
    const parts = []; if (up && up.change > 0) parts.push(T.rise(up.label, M(up.change, up.currency))); if (dn && dn.change < 0 && dn !== up) parts.push(T.fall(dn.label, M(-dn.change, dn.currency)));
    if (parts.length) add('info', 'movers', parts.join('; ').replace(/^./, (c) => c.toUpperCase()) + '.');
  }
  // 🎓 who has paid this session
  const c = f.census;
  if (c && c.students) { const full = c.pct ? c.pct.fully_paid : null; add(full != null && full < 50 ? 'warn' : 'info', 'census', T.census(full, c.students, c.session, c.counts ? c.counts.not_paid : 0)); }
  // 🎯 targets
  for (const t of (f.targets || [])) {
    if (!t) continue;
    if (t.state === 'met') add('good', 'targets', T.met(t.scope_name, T.pc(t.target_pct), T.pc(t.rate)));
    else if (t.state === 'behind') add('warn', 'targets', T.behind(t.scope_name, T.pc(t.target_pct), T.pc(t.rate), T.pc(t.expected), M(t.to_collect, t.currency), t.due_date));
    else if (t.state === 'missed') add('bad', 'targets', T.missed(t.scope_name, T.pc(t.target_pct), t.due_date, T.pc(t.rate)));
  }
  // 📞 promises to pay
  const p = f.promises;
  if (p && (p.pending || p.broken || p.kept)) add(p.broken ? 'warn' : 'info', 'follow-ups', T.promises(p));
  // 🚦 controls
  const ct = f.controls;
  if (ct) {
    if (ct.errors) add('bad', 'controls', T.ctlErrors(ct.errors, ct.top || []));
    else if (ct.warnings) add('info', 'controls', T.ctlWarn(ct.warnings));
    else add('good', 'controls', T.ctlOk());
  }
  // ✍ sign-off
  const so = f.signoff;
  if (so && so.officers) add(so.disputed || so.changed ? 'warn' : so.waiting ? 'info' : 'good', 'sign-off', T.signoff(so, monthName(so.period, lang)));
  // 🗄 filed months / 🔐 access
  if (f.filings && (f.filings.restated || []).length) add('bad', 'filings', T.filings(f.filings.restated.map(x => monthName(x, lang)).join(', ')));
  if (f.access && f.access.state && f.access.state !== 'certified') add('warn', 'access', f.access.state === 'changed' ? T.accessChanged() : T.accessDue(f.access.quarter));
  // the headline: the most serious point, else the collections line — said once, not repeated in the points beneath it
  const ordered = [...pts].sort((a, b) => RANK[a.tone] - RANK[b.tone]);
  const top = ordered.find(x => x.tone === 'bad') || ordered.find(x => x.tone === 'warn' && x.area === 'targets') || pts.find(x => x.area === 'collections') || ordered[0] || null;
  return { headline: top ? top.text : T.nothing, tone: top ? top.tone : 'info', headline_area: top ? top.area : null, points: pts.filter(x => x !== top), scope: f.scope_label || null, month: f.month || null, lang };
}

/** The brief as plain lines (e-mail / text) and simple HTML. */
const ICON = { good: '✅', warn: '⚠️', bad: '❗', info: '•' };
function asText(b) { return [b.headline, '', ...b.points.map(x => (ICON[x.tone] || '•') + ' ' + x.text)].join('\n'); }
function asHtml(b) { const e = (s) => String(s || '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); return '<p><b>' + e(b.headline) + '</b></p><ul>' + b.points.map(x => '<li>' + (ICON[x.tone] || '•') + ' ' + e(x.text) + '</li>').join('') + '</ul>'; }

module.exports = { brief, asText, asHtml, monthName, langOf };
