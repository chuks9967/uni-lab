'use strict';
/**
 * 📚 KNOWLEDGE-BASE SEARCH — pure, dependency-free (portal, edge and desktop run the same code).
 *
 * The agent answers questions about a person's OWN record with its tools; everything else a university gets
 * asked ("what is the late-registration fee?", "when do hostels close?", "how do I replace my ID card?") lives
 * in the institution's knowledge base. This module ranks articles for a question with BM25 over title, the
 * question variants, tags and answer — accent-folded, lightly stemmed, with stop-words for English, French,
 * Spanish, Portuguese and Hausa — and groups UNANSWERED questions by similarity so an office answers a
 * question once, not forty times.
 */

const STOP = new Set(('a an and are as at be by can could do does for from how i if in is it its me my of on or our '
  + 'please should so tell that the their them there this to us was we what when where which who why will with would you your '
  + 'le la les un une des de du et est en pour que qui quoi quand comment je mon ma mes il elle nous vous au aux ce cette sur dans '
  + 'el los las una unos y es para que como cuando donde yo mi mis se por con del al '
  + 'o os um uma e para que como quando onde eu meu minha no na do da '
  + 'da ne na a ya yaya ina me shin wane wace').split(/\s+/));

/** Lower-case, fold accents, keep letters/digits, split. */
function tokens(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t.length > 1 && !STOP.has(t)).map(stem);
}
/** A light stemmer (English + Romance plurals): fees→fee, registering→register, deferred→defer, cartes→carte. */
function stem(t) {
  if (t.length <= 3 || /^\d+$/.test(t)) return t;
  let w = t;
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('es') && w.length > 4 && !/(ss|us)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (/(.)\1$/.test(w) && w.length > 3 && !/(ll|ss|ff)$/.test(w)) w = w.slice(0, -1);   // deferr → defer
  return w;
}
const J = (v, d) => { if (Array.isArray(v)) return v; try { const x = JSON.parse(v || ''); return x == null ? d : x; } catch (_) { return d; } };

/** Articles visible to this persona in its language (an article with no language fits every language). */
function visible(articles, persona, lang) {
  return (articles || []).filter(a => a && !a.deleted && (a.status || 'published') === 'published'
    && (!a.audience || a.audience === 'all' || String(a.audience).split(',').map(s => s.trim()).includes(persona))
    && (!a.language || !lang || a.language === lang || String(lang).slice(0, 2) === String(a.language).slice(0, 2)));
}

/**
 * Rank articles for a question (BM25, k1=1.2, b=0.75). Fields are weighted by repetition: title ×2, each
 * question variant ×2, tags ×1, answer ×1. Returns [{ article, score, confident }] best first.
 */
function search(articles, question, opts) {
  const o = opts || {}; const q = [...new Set(tokens(question))];
  if (!q.length || !articles || !articles.length) return [];
  const docs = articles.map(a => {
    const qs = J(a.questions, []);
    const words = [].concat(tokens(a.title), tokens(a.title), ...qs.map(x => tokens(x).concat(tokens(x))), tokens(Array.isArray(a.tags) ? a.tags.join(' ') : a.tags), tokens(a.answer));
    const tf = new Map(); for (const w of words) tf.set(w, (tf.get(w) || 0) + 1);
    return { a, tf, len: words.length };
  });
  const N = docs.length; const avg = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map(); for (const t of q) df.set(t, docs.filter(d => d.tf.has(t)).length);
  const k1 = 1.2; const b = 0.75;
  const out = docs.map(d => {
    let score = 0; let hits = 0;
    for (const t of q) {
      const f = d.tf.get(t) || 0; if (!f) continue; hits++;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg));
    }
    return { article: d.a, score: Math.round(score * 1000) / 1000, coverage: hits / q.length };
  }).filter(x => x.score > 0).sort((x, y) => y.score - x.score);
  const min = o.minScore != null ? o.minScore : 1.0;
  return out.slice(0, o.limit || 5).map((x, i) => Object.assign(x, { confident: i === 0 && x.score >= min && x.coverage >= 0.5 && (!out[1] || x.score >= out[1].score * 1.15 || x.coverage === 1) }));
}

/** Word-set similarity (Jaccard over stemmed tokens) — groups the same question asked in different words. */
function similarity(a, b) {
  const x = new Set(tokens(a)); const y = new Set(tokens(b));
  if (!x.size || !y.size) return 0;
  let inter = 0; for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}
/** A stable key for exact-duplicate questions ("How do I pay?" == "how do i pay"). */
function questionKey(s) { return tokens(s).sort().join(' ').slice(0, 200); }

/** Group unanswered questions: each group = the most-asked wording + its variants + total count. */
function groupQuestions(rows, threshold) {
  const th = threshold || 0.5; const groups = [];
  for (const r of (rows || []).slice().sort((p, q2) => (Number(q2.count) || 1) - (Number(p.count) || 1))) {
    const g = groups.find(x => similarity(x.text, r.text) >= th);
    if (g) { g.variants.push(r.text); g.ids.push(r.id); g.count += Number(r.count) || 1; if (String(r.last_at || '') > g.last_at) g.last_at = r.last_at; for (const p of String(r.personas || r.persona || '').split(',').filter(Boolean)) if (!g.personas.includes(p)) g.personas.push(p); }
    else groups.push({ text: r.text, variants: [], ids: [r.id], count: Number(r.count) || 1, last_at: r.last_at || '', personas: String(r.personas || r.persona || '').split(',').filter(Boolean) });
  }
  return groups.sort((x, y) => y.count - x.count);
}

/** Parse pasted FAQ text: "Q: … A: …" pairs (also "Question:"/"Answer:", French "Q/R", or a "?"-ending line then its answer). */
function parseFaq(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = []; let q = null; let a = [];
  const flush = () => { if (q && a.join(' ').trim()) out.push({ title: q.trim().slice(0, 200), answer: a.join('\n').trim().slice(0, 4000) }); q = null; a = []; };
  for (const raw of lines) {
    const l = raw.trim(); if (!l) { if (q && a.length) a.push(''); continue; }
    const mq = /^(?:q|question|qn)\s*[:.)-]\s*(.+)$/i.exec(l);
    const ma = /^(?:a|r|answer|ans|reponse|réponse|respuesta)\s*[:.)-]\s*(.*)$/i.exec(l);
    if (mq) { flush(); q = mq[1]; continue; }
    if (ma && q) { a.push(ma[1]); continue; }
    if (!q && /\?\s*$/.test(l)) { q = l; continue; }
    if (q && a.length === 0 && /\?\s*$/.test(l) && !ma) { q += ' ' + l; continue; }
    if (q) { if (/\?\s*$/.test(l) && a.length) { flush(); q = l; continue; } a.push(l); }
  }
  flush();
  return out.map(x => Object.assign(x, { answer: x.answer.replace(/\n{3,}/g, '\n\n') }));
}

module.exports = { tokens, stem, visible, search, similarity, questionKey, groupQuestions, parseFaq, STOP };
