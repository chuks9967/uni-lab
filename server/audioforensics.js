'use strict';
/**
 * 🎧 AUDIO FORENSICS — the sense the proctor did not have.
 *
 * 🐛 THE GAP: every candidate's device already uploads audio with its frames. An officer can LISTEN
 * to those clips. But the AI only ever looked at IMAGES — `surveillance-ai.analyze()` takes a frame
 * and nothing else — so the commonest remote-cheating arrangement of all, **someone else in the room
 * reading the questions and dictating answers**, was invisible to every automatic detector. A phone
 * on the desk gets caught by a camera. A voice does not.
 *
 * ⚠ WHAT THIS CLAIMS, AND WHAT IT REFUSES TO CLAIM. This is signal analysis, not transcription and
 * not speaker identification. It can say "there was sustained speech in this room, in a
 * back-and-forth pattern". It CANNOT say who spoke or what was said, and it must never be described
 * as if it could — a proctoring system that overstates what it knows is one whose findings collapse
 * the first time a student contests them properly.
 *
 * WHY SIGNAL ANALYSIS RATHER THAN A MODEL: it is deterministic, it runs offline on the hub AND on the
 * edge with no key and no vendor, it costs nothing per clip, and — the deciding reason — it can be
 * unit-tested against synthesised audio, so its false-positive behaviour is knowable. A speech model
 * would be more capable and completely opaque about when it is wrong.
 *
 * Pure: PCM in, findings out. No DB, no clock, no I/O.
 */

/**
 * Decode a RIFF/WAVE buffer to mono Float32 samples in [-1, 1].
 *
 * The APK sends 16-bit PCM WAV (see ExamActivity's recorder); browsers send webm/opus, which is a
 * compressed format this deliberately does NOT attempt — returning null for anything it cannot decode
 * honestly is far better than analysing garbage and reporting confident nonsense about it.
 */
function decodeWav(buf) {
  if (!buf || buf.length < 44) return null;
  const ascii = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(buf[o + i]); return s; };
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return null;
  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = ascii(pos, 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    } else if (id === 'data') { dataOff = pos + 8; dataLen = Math.min(size, buf.length - dataOff); }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0 || fmt.format !== 1 || fmt.bits !== 16 || !fmt.rate) return null;
  const ch = Math.max(1, fmt.channels);
  const frames = Math.floor(dataLen / 2 / ch);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) acc += buf.readInt16LE(dataOff + (i * ch + c) * 2);
    out[i] = acc / ch / 32768;
  }
  return { samples: out, rate: fmt.rate, durationMs: Math.round(frames / fmt.rate * 1000) };
}

const FRAME_MS = 20;

/** Per-frame energy (RMS) and zero-crossing rate — the two cheap features that separate speech. */
function features(pcm, rate) {
  const n = Math.max(1, Math.round(rate * FRAME_MS / 1000));
  const out = [];
  for (let i = 0; i + n <= pcm.length; i += n) {
    let sum = 0, zc = 0, prev = pcm[i];
    for (let k = 0; k < n; k++) {
      const v = pcm[i + k];
      sum += v * v;
      if ((v >= 0) !== (prev >= 0)) zc++;
      prev = v;
    }
    out.push({ rms: Math.sqrt(sum / n), zcr: zc / n });
  }
  return out;
}

/**
 * Which frames are SPEECH.
 *
 * ⚠ The floor is derived from the clip's own quiet frames, not from a fixed number. A fixed threshold
 * fails in exactly the two situations that matter: a candidate on a cheap phone in a noisy room (all
 * frames above it — everything is speech) and one on a good mic in a silent room (all frames below —
 * nothing is). Calibrating per clip is the only way the same rule works for both, and it is why the
 * false-positive tests below use both.
 *
 * Speech is voiced energy WELL above that floor, with a zero-crossing rate that is not the very high
 * value pure hiss produces.
 */
function voiceActivity(pcm, rate) {
  const f = features(pcm, rate);
  if (f.length < 10) return { frames: f.length, speechRatio: 0, segments: [], noiseFloor: 0 };
  const sorted = f.map(x => x.rms).sort((a, b) => a - b);
  const peak = sorted[sorted.length - 1] || 0;
  // ⚠ THE FLOOR MUST BE BOUNDED BY THE PEAK, not taken from a percentile alone. In a clip that is
  // MOSTLY speech the "quiet fifth" is not quiet — it is speech — so a bare percentile floor rises
  // into the voice and the threshold derived from it cuts most of it out. That failure lands exactly
  // on the clips with the most talking in them, which are the only ones anybody cares about.
  const pct = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const noiseFloor = Math.min(pct, peak * 0.06);
  // a clip with no dynamic range at all is silence or a dead mic — never "continuous speech"
  if (peak <= 0.005 || peak < noiseFloor * 2.2) return { frames: f.length, speechRatio: 0, segments: [], noiseFloor };
  const thr = Math.max(noiseFloor * 3, peak * 0.18, 0.006);

  const isSpeech = f.map(x => x.rms >= thr && x.zcr < 0.35);
  // close 1-frame gaps: real speech has short stops inside it
  for (let i = 1; i < isSpeech.length - 1; i++) if (!isSpeech[i] && isSpeech[i - 1] && isSpeech[i + 1]) isSpeech[i] = true;

  const segments = [];
  let start = -1;
  for (let i = 0; i < isSpeech.length; i++) {
    if (isSpeech[i] && start < 0) start = i;
    else if (!isSpeech[i] && start >= 0) { segments.push({ startMs: start * FRAME_MS, endMs: i * FRAME_MS }); start = -1; }
  }
  if (start >= 0) segments.push({ startMs: start * FRAME_MS, endMs: isSpeech.length * FRAME_MS });

  const speechFrames = isSpeech.filter(Boolean).length;
  return {
    frames: f.length, noiseFloor,
    speechRatio: speechFrames / f.length,
    segments: segments.filter(s => s.endMs - s.startMs >= 120),          // ignore clicks and taps
  };
}

/**
 * Does this look like a CONVERSATION rather than one person muttering?
 *
 * Turn-taking is the signal: several speech runs separated by short gaps, the runs varying in length.
 * One person reading aloud to themselves gives long, similar runs; a dialogue alternates.
 * Deliberately conservative — the innocent explanations (a family member in the next room, a
 * television) are common, and this is only ever an invitation to LISTEN to the clip.
 */
function conversation(segments) {
  if (!segments || segments.length < 4) return null;
  const gaps = [];
  for (let i = 1; i < segments.length; i++) gaps.push(segments[i].startMs - segments[i - 1].endMs);
  const turnGaps = gaps.filter(g => g >= 150 && g <= 1500);              // human turn-taking latency
  if (turnGaps.length < 3) return null;
  const lens = segments.map(s => s.endMs - s.startMs);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
  return { turns: turnGaps.length + 1, meanTurnMs: Math.round(mean), varianceRatio: mean ? Math.round(sd / mean * 100) / 100 : 0 };
}

/**
 * ANALYSE ONE CLIP → findings for an officer. Evidence, never a verdict.
 *
 * `opts.duringExam` should be true for a clip recorded while the candidate was writing; the same
 * audio before the exam starts means nothing.
 */
function analyseClip(wavBuffer, opts = {}) {
  const dec = decodeWav(wavBuffer);
  if (!dec) return { ok: false, decoded: false, reason: 'not 16-bit PCM WAV — this analyser does not guess at compressed audio', signals: [] };
  const va = voiceActivity(dec.samples, dec.rate);
  const signals = [];

  // ── sustained speech while writing ─────────────────────────────────────────────────────────
  // A candidate working alone produces near-silence. Speech through an examination is the thing an
  // invigilator in a hall would walk over to.
  if (va.speechRatio >= 0.35 && dec.durationMs >= 1500) {
    signals.push({
      key: 'speech_during_exam',
      severity: va.speechRatio >= 0.6 ? 'high' : 'medium',
      confidence: Math.min(0.85, 0.35 + va.speechRatio * 0.6),
      label: `Speech for ${Math.round(va.speechRatio * 100)}% of a ${Math.round(dec.durationMs / 1000)}s clip`,
      detail: 'Sustained speech was recorded in the candidate\'s room while they were writing. This analyser hears SPEECH; it cannot say who spoke or what was said. '
        + 'Ordinary explanations include a household member, a television, or the candidate reading aloud to themselves — so listen to the clip before drawing any conclusion.',
      evidence: { speechRatio: Math.round(va.speechRatio * 100) / 100, durationMs: dec.durationMs, segments: va.segments.length },
    });
  }

  // ── turn-taking ────────────────────────────────────────────────────────────────────────────
  const conv = conversation(va.segments);
  if (conv && va.speechRatio >= 0.2) {
    signals.push({
      key: 'conversation_pattern',
      severity: 'medium',
      confidence: Math.min(0.7, 0.3 + conv.turns * 0.05),
      label: `A back-and-forth pattern of about ${conv.turns} turns`,
      detail: 'The speech alternates in the way a CONVERSATION does — several runs separated by the short gaps people leave for each other — rather than one continuous voice. '
        + 'That is consistent with someone else in the room. It is also consistent with a phone call in the next room or a television playing dialogue. Listen before acting.',
      evidence: conv,
    });
  }

  return {
    ok: true, decoded: true, durationMs: dec.durationMs, rate: dec.rate,
    speechRatio: Math.round(va.speechRatio * 100) / 100,
    segments: va.segments.length,
    signals,
    // capped like the answer-timing forensics, and for the same reason: this INFORMS the risk score,
    // it does not get to condemn anybody on its own
    riskDelta: Math.min(25, signals.reduce((a, s) => a + (s.severity === 'high' ? 15 : 9) * (s.confidence || 0.5), 0)),
  };
}

module.exports = { analyseClip, decodeWav, voiceActivity, conversation, features, FRAME_MS };
