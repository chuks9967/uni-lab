'use strict';
/**
 * 🕵️ ANSWER FORENSICS — catching the malpractice a camera cannot see.
 *
 * The proctoring engine watches the ROOM: phones, earbuds, a second face, someone leaving the seat.
 * It is good at that, and completely blind to the cheating that leaves no visual trace — a student
 * who has the paper in advance, one being fed answers through an earpiece the camera never catches,
 * or a browser-based lookup on a device outside frame. Those all leave the same kind of evidence:
 * the SHAPE of the answering in time.
 *
 * ⚠ THE TIMESTAMPS ARE THE SERVER'S, never the client's. The portal stamps each answer as it arrives,
 * exactly as it already refuses answers after the deadline on server time — a candidate who can lie
 * about when they answered can defeat every signal here.
 *
 * ⚠ AND THE OUTPUT IS EVIDENCE, NOT A VERDICT. Every signal below has an innocent explanation: a
 * strong student IS fast, a nervous one DOES revisit answers, and a bad connection DOES deliver a
 * burst of queued answers. So this reports what it saw, with the numbers behind it, at a stated
 * confidence — and an officer decides. Nothing here disqualifies anybody. A malpractice system that
 * accuses on statistics alone destroys the trust that makes the honest signals usable at all.
 *
 * ⚠ LIVES IN server/ SO BOTH SEATS CAN REACH IT. The desktop Exam Office runs it over stored
 * attempts; the PORTAL invigilator monitor runs it live, while the exam is still being sat. If the
 * two computed different signals, a lecturer invigilating from the web and an administrator on the
 * desktop would be looking at different evidence about the same candidate.
 *
 * Pure: every function takes data and returns findings. No DB, no clock — the caller passes `now`.
 */

// A question a candidate could not have READ, let alone answered, in this long. Deliberately brutal
// (3s) rather than merely "fast": the claim is not "quick" but "physically impossible", which is the
// only claim worth putting in front of a disciplinary panel.
const IMPOSSIBLE_MS = 3000;
// Reading speed used to judge whether a long question could have been comprehended. ~230 wpm is a
// competent adult reading for comprehension; the threshold is generous on purpose.
const WORDS_PER_MS = 230 / 60000;
// Answers landing this close together are one SAVE, not two decisions — the client batches.
const SAME_BATCH_MS = 1200;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/** Words in a question stem — how much there was to read before answering. */
function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The minimum time a candidate needed just to READ this question and its options.
 * Used to separate "fast because they knew it" from "answered before they could have read it".
 */
function readingFloorMs(q) {
  const words = wordCount(q && q.text) + (Array.isArray(q && q.options) ? q.options.reduce((a, o) => a + wordCount(o), 0) : 0);
  return Math.round(words / WORDS_PER_MS);
}

/**
 * Turn the raw log into ordered ANSWER EVENTS.
 *
 * `log` is `{ questionId: [ms, ms, …] }` — every time that answer was set, server-stamped. The first
 * entry for a question is when it was FIRST answered; later entries are changes, which matter on
 * their own (a cluster of changes after a long gap is a different story from steady work).
 */
function events(log) {
  const out = [];
  for (const [qid, stamps] of Object.entries(log || {})) {
    const list = (Array.isArray(stamps) ? stamps : [stamps]).map(num).filter(v => v != null).sort((a, b) => a - b);
    list.forEach((ms, i) => out.push({ qid, ms, change: i > 0 }));
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/**
 * Gaps between consecutive DECISIONS (batched saves collapsed).
 *
 * ⚠ Collapsing matters: a client that flushes four answers in one request would otherwise look like
 * four superhuman 40ms decisions, and the "impossibly fast" signal would fire on every candidate with
 * a slow connection — the exact people least able to defend themselves.
 */
function decisionGaps(evts) {
  const gaps = [];
  for (let i = 1; i < evts.length; i++) {
    const d = evts[i].ms - evts[i - 1].ms;
    if (d >= SAME_BATCH_MS) gaps.push(d);
  }
  return gaps;
}

/** Coefficient of variation — how METRONOMIC the answering was. Low = suspiciously regular. */
function regularity(gaps) {
  if (gaps.length < 6) return null;          // too few to say anything honest
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (!mean) return null;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  return { mean: Math.round(mean), sd: Math.round(sd), cv: round(sd / mean, 3), n: gaps.length };
}

/**
 * ANALYSE ONE ATTEMPT. Returns { signals, riskDelta, summary } — evidence, never a verdict.
 *
 * `attempt` = { started_at_ms, submitted_at_ms, answer_log }
 * `questions` = [{ id, text, options, type, marks }]
 */
function analyseAttempt(attempt, questions, opts = {}) {
  const qById = Object.fromEntries((questions || []).map(q => [String(q.id), q]));
  const evts = events(attempt && attempt.answer_log);
  const signals = [];
  if (!evts.length) return { signals, riskDelta: 0, summary: 'No answer timing was recorded for this attempt.', measured: false };

  const started = num(attempt.started_at_ms);
  const gaps = decisionGaps(evts);

  // ── 1. ANSWERED BEFORE IT COULD BE READ ────────────────────────────────────────────────────
  // The strongest single signal, because it is a claim about physics rather than about ability.
  const firsts = new Map();
  for (const e of evts) if (!firsts.has(e.qid)) firsts.set(e.qid, e.ms);

  // ⚠ JUDGE BATCHES, NOT INDIVIDUAL STAMPS. A client on a slow link flushes several answers in ONE
  // request, so their stamps land milliseconds apart — and comparing them one to the next reads as a
  // run of superhuman decisions. That would fire on precisely the candidates least able to argue
  // back. So consecutive answers within one save are grouped, and the question asked of a group is
  // the honest one: in the time since the previous save, could this candidate have read and answered
  // ALL of these?
  const ordered = [...firsts.entries()].sort((a, b) => a[1] - b[1]);
  const batches = [];
  for (const [qid, ms] of ordered) {
    const last = batches[batches.length - 1];
    if (last && ms - last.ms <= SAME_BATCH_MS) { last.qids.push(qid); last.ms = ms; }
    else batches.push({ ms, qids: [qid] });
  }
  const impossible = [];
  let prev = started;
  for (const b of batches) {
    const elapsed = prev == null ? null : b.ms - prev;
    if (elapsed != null && elapsed > 0) {
      const needed = b.qids.reduce((a, qid) => a + Math.max(IMPOSSIBLE_MS, qById[qid] ? readingFloorMs(qById[qid]) : 0), 0);
      if (elapsed < needed) {
        // the whole batch is implausible — record each question in it, with the batch's arithmetic
        for (const qid of b.qids) {
          impossible.push({ qid, thinkMs: Math.round(elapsed / b.qids.length), neededMs: Math.round(needed / b.qids.length), batched: b.qids.length > 1, words: qById[qid] ? wordCount(qById[qid].text) : null });
        }
      }
    }
    prev = b.ms;
  }
  if (impossible.length >= 3) {
    signals.push({
      key: 'impossible_speed', severity: impossible.length >= 8 ? 'high' : 'medium',
      confidence: Math.min(0.95, 0.4 + impossible.length * 0.06),
      label: `${impossible.length} answers given faster than the question could be read`,
      detail: `On ${impossible.length} question(s) the answer arrived in less time than a competent reader needs for the words on screen `
        + `(e.g. ${round(impossible[0].thinkMs / 1000, 1)}s where ${round(impossible[0].neededMs / 1000, 1)}s is the floor). `
        + 'That is consistent with knowing the answers in advance. It is also consistent with a candidate who skipped ahead and returned — check the order.',
      evidence: impossible.slice(0, 12),
    });
  }

  // ── 2. METRONOMIC ANSWERING ────────────────────────────────────────────────────────────────
  // Humans working through a paper are irregular: some questions are easy, some are re-read. Answers
  // arriving at a near-constant beat is what being READ TO looks like.
  const reg = regularity(gaps);
  if (reg && reg.cv <= 0.25 && reg.n >= 8) {
    signals.push({
      key: 'metronomic', severity: 'medium', confidence: Math.min(0.85, 0.9 - reg.cv * 2),
      label: 'Answers arrived at an unnaturally regular beat',
      detail: `${reg.n} consecutive answers averaged ${round(reg.mean / 1000, 1)}s apart with very little variation `
        + `(±${round(reg.sd / 1000, 1)}s). Working through a paper is normally irregular — easy questions are quick and some are re-read. `
        + 'A steady beat is what being dictated to, or working from a prepared list, looks like.',
      evidence: reg,
    });
  }

  // ── 3. A BURST AT THE END ──────────────────────────────────────────────────────────────────
  // Nothing for most of the paper, then most of it answered in the last minutes: the shape of
  // answers arriving from outside. Distinguished from ordinary last-minute rushing by requiring that
  // the burst be BOTH large and much faster than the candidate's own established pace.
  const submitted = num(attempt.submitted_at_ms);
  if (submitted && firsts.size >= 8) {
    const tail = [...firsts.values()].filter(ms => submitted - ms <= 120000).length;
    const share = tail / firsts.size;
    if (share >= 0.5 && tail >= 6) {
      signals.push({
        key: 'end_burst', severity: 'medium', confidence: Math.min(0.8, 0.35 + share * 0.5),
        label: `${tail} of ${firsts.size} answers were entered in the last two minutes`,
        detail: `${Math.round(share * 100)}% of this candidate's answers were first entered in the final two minutes. `
          + 'A candidate who ran out of time answers the REMAINING questions quickly; this pattern — most of the paper at the end — '
          + 'is what receiving a completed set of answers looks like. Compare against when they were actually present on camera.',
        evidence: { tail, total: firsts.size, share: round(share, 2) },
      });
    }
  }

  // ── 4. CHANGES AFTER AN ABSENCE ────────────────────────────────────────────────────────────
  // Went quiet for a long time, came back and rewrote a block of answers. Innocent as a bathroom
  // break plus a re-read; not innocent as a consultation.
  const longGapIdx = [];
  for (let i = 1; i < evts.length; i++) if (evts[i].ms - evts[i - 1].ms >= 180000) longGapIdx.push(i);
  for (const i of longGapIdx) {
    const after = evts.slice(i, i + 12).filter(e => e.change && e.ms - evts[i].ms <= 120000).length;
    if (after >= 5) {
      signals.push({
        key: 'post_absence_rewrite', severity: 'medium', confidence: 0.6,
        label: `${after} answers were CHANGED immediately after a long pause`,
        detail: `The candidate stopped answering for ${round((evts[i].ms - evts[i - 1].ms) / 60000, 1)} minutes, then changed ${after} `
          + 'existing answers within two minutes of returning. Revisiting answers is normal; revising a block of them straight after an '
          + 'unexplained absence is worth putting beside the camera record for that window.',
        evidence: { pausedMinutes: round((evts[i].ms - evts[i - 1].ms) / 60000, 1), changed: after, atMs: evts[i].ms },
      });
      break;      // one is the finding; listing every pause is noise
    }
  }

  // the contribution to the attempt's risk score. Capped: forensics INFORMS the risk, it does not
  // get to condemn on its own — the visual proctoring and the officer's review carry the rest.
  const weight = { high: 18, medium: 10, low: 4 };
  const riskDelta = Math.min(40, signals.reduce((a, s) => a + (weight[s.severity] || 4) * (s.confidence || 0.5), 0));

  return {
    measured: true,
    signals,
    riskDelta: Math.round(riskDelta),
    answered: firsts.size,
    edits: evts.length - firsts.size,
    summary: signals.length
      ? `${signals.length} timing signal(s) worth an officer's eye.`
      : 'Answer timing shows nothing unusual.',
  };
}

/**
 * COHORT-WIDE: candidates whose answering was SYNCHRONISED.
 *
 * Two students answering the same questions within seconds of each other, repeatedly, across a paper
 * they are both shuffled differently on, is very hard to explain innocently — and it is invisible to
 * both the cameras and the shared-wrong-answer test, because the answers can be correct and the
 * candidates can be in different rooms.
 */
function synchronised(attempts, opts = {}) {
  const windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : 8000;
  const minHits = Number(opts.minHits) > 0 ? Number(opts.minHits) : 6;
  const prepared = (attempts || []).map(a => ({
    student_id: a.student_id, name: a.name || '', matric: a.matric || '',
    first: new Map(events(a.answer_log).reduce((m, e) => { if (!m.some(([q]) => q === e.qid)) m.push([e.qid, e.ms]); return m; }, [])),
  })).filter(a => a.first.size >= 4);

  const pairs = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const A = prepared[i], B = prepared[j];
      let hits = 0, shared = 0; const deltas = [];
      for (const [qid, ta] of A.first) {
        const tb = B.first.get(qid);
        if (tb == null) continue;
        shared++;
        const d = Math.abs(ta - tb);
        if (d <= windowMs) { hits++; deltas.push(d); }
      }
      if (shared >= 6 && hits >= minHits) {
        const rate = hits / shared;
        pairs.push({
          a: { student_id: A.student_id, name: A.name, matric: A.matric },
          b: { student_id: B.student_id, name: B.name, matric: B.matric },
          shared, hits, rate: round(rate, 2),
          medianDeltaMs: deltas.sort((x, y) => x - y)[Math.floor(deltas.length / 2)] || 0,
          confidence: Math.min(0.9, rate * 0.9),
        });
      }
    }
  }
  pairs.sort((x, y) => (y.hits - x.hits) || (x.medianDeltaMs - y.medianDeltaMs));
  return { pairs, count: pairs.length, windowMs, minHits };
}

module.exports = {
  analyseAttempt, synchronised,
  // pure helpers (tested)
  events, decisionGaps, regularity, readingFloorMs, wordCount,
  IMPOSSIBLE_MS, SAME_BATCH_MS,
};
