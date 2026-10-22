'use strict';
/**
 * 🗳 STUDENT ELECTIONS — pure rules shared by the desktop (electoral committee) and the portal (voters):
 * the election timeline (nominations → voting → counting → results), who may vote for which position,
 * what a valid ballot is, the count (with ties), and the ballot-box fingerprint published with the results.
 *
 * SECRET BALLOT: a ballot row carries NO student id. "Has this student voted?" is a separate mark whose id
 * is an HMAC of (election, student) under the server key, and the ballot carries a second, differently
 * labelled HMAC used only to drop a duplicate ballot at the count. Nobody using the app can see who voted
 * for whom; linking a ballot to a voter needs the server's secret key.
 */
const crypto = require('crypto');

const INACTIVE = ['graduated', 'alumni', 'withdrawn', 'suspended', 'deceased', 'expelled'];
const SCOPES = ['all', 'faculty', 'department', 'level', 'campus'];
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n || 1000); // eslint-disable-line no-control-regex
const t16 = (x) => String(x || '').replace(' ', 'T').slice(0, 16);
const ids = (x) => { if (Array.isArray(x)) return x.map(String).filter(Boolean); try { const v = JSON.parse(x || '[]'); return Array.isArray(v) ? v.map(String).filter(Boolean) : []; } catch (_) { return String(x || '').split(',').map(s => s.trim()).filter(Boolean); } };
const hmac = (secret, s) => crypto.createHmac('sha256', String(secret || 'ubu-elections')).update(s).digest('hex');

/** draft · nominations · upcoming · open · closed (counting) · published · cancelled */
function state(e, now) {
  if (!e || Number(e.deleted)) return 'draft';
  if (e.status === 'cancelled') return 'cancelled';
  if (e.status !== 'scheduled') return 'draft';
  if (Number(e.results_published)) return 'published';
  const n = t16(now);
  if (e.nominations_open_at && e.nominations_close_at && n >= t16(e.nominations_open_at) && n < t16(e.nominations_close_at)) return 'nominations';
  if (!e.opens_at || n < t16(e.opens_at)) return 'upcoming';
  if (e.closes_at && n < t16(e.closes_at)) return 'open';
  return 'closed';
}
function inScope(kind, scopeIds, s) {
  const k = kind || 'all'; if (k === 'all') return true;
  const want = ids(scopeIds); if (!want.length) return true;
  const have = { faculty: s.faculty_id, department: s.department_id, level: s.level_id, campus: s.campus_id }[k];
  return !!have && want.includes(String(have));
}
/** An active student inside the election's electorate. */
function canVote(e, s) { return !!(e && s) && !Number(s.deleted) && !INACTIVE.includes(String(s.status || 'active').toLowerCase()) && inScope(e.scope_kind, e.scope_ids, s); }
/** The positions on THIS voter's ballot (a faculty representative only appears to that faculty's students). */
function positionsFor(e, positions, s) {
  return (positions || []).filter(p => !Number(p.deleted) && p.election_id === e.id && inScope(p.scope_kind, p.scope_id ? [p.scope_id] : [], s))
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.title).localeCompare(String(b.title)));
}

function validateBallot(e, positions, candidates, choices, now) {
  if (state(e, now) !== 'open') throw new Error('Voting is not open for this election.');
  const c = choices && typeof choices === 'object' ? choices : {};
  const mine = new Set(positions.map(p => p.id));
  for (const k of Object.keys(c)) if (!mine.has(k)) throw new Error('Your ballot has a position you cannot vote for.');
  const out = {}; let any = 0;
  for (const p of positions) {
    const raw = c[p.id]; const arr = [...new Set((raw == null || raw === '' ? [] : (Array.isArray(raw) ? raw : [raw])).map(String).filter(Boolean))];
    const seats = Math.max(1, Number(p.seats) || 1);
    if (arr.length > seats) throw new Error(`Choose at most ${seats} for ${p.title}.`);
    for (const cid of arr) { const cand = candidates.find(x => x.id === cid); if (!cand || cand.position_id !== p.id || cand.status !== 'approved' || Number(cand.deleted)) throw new Error(`That is not a candidate for ${p.title}.`); }
    out[p.id] = arr; any += arr.length;
  }
  if (!any) throw new Error('Your ballot is empty — choose at least one candidate.');
  return out;
}

/** The count. Duplicate ballots (same voter token, e.g. two portals before a sync) keep only the earliest. */
function tally(positions, candidates, ballots) {
  const seen = new Map(); let duplicates = 0;
  const sorted = (ballots || []).filter(b => !Number(b.deleted)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  const valid = [];
  for (const b of sorted) { if (b.voter_token && seen.has(b.voter_token)) { duplicates++; continue; } if (b.voter_token) seen.set(b.voter_token, 1); valid.push(b); }
  const res = positions.filter(p => !Number(p.deleted)).map(p => {
    const cands = candidates.filter(c => c.position_id === p.id && c.status === 'approved' && !Number(c.deleted));
    const votes = Object.fromEntries(cands.map(c => [c.id, 0])); let cast = 0, abstained = 0;
    for (const b of valid) {
      let ch; try { ch = typeof b.choices === 'string' ? JSON.parse(b.choices) : (b.choices || {}); } catch (_) { ch = {}; }
      if (!(p.id in ch)) continue;                    // this position was not on that voter's ballot
      const arr = Array.isArray(ch[p.id]) ? ch[p.id] : [];
      const ok = arr.filter(id => id in votes);
      if (!ok.length) { abstained++; continue; }
      cast++; for (const id of ok) votes[id]++;
    }
    const seats = Math.max(1, Number(p.seats) || 1);
    const list = cands.map(c => ({ id: c.id, name: c.name, votes: votes[c.id], pct: cast ? Math.round(votes[c.id] * 1000 / cast) / 10 : 0 }))
      .sort((a, b) => b.votes - a.votes || String(a.name).localeCompare(String(b.name)));
    const cut = list[seats - 1]; const next = list[seats];
    const tie = !!(cut && next && cut.votes === next.votes && cut.votes > 0);
    const winners = tie ? list.filter(x => x.votes > cut.votes).map(x => x.id) : list.slice(0, seats).filter(x => x.votes > 0).map(x => x.id);
    const tied = tie ? list.filter(x => x.votes === cut.votes).map(x => x.id) : [];
    return { id: p.id, title: p.title, seats, cast, abstained, candidates: list, winners, tie, tied };
  });
  return { ballots: valid.length, duplicates, positions: res };
}
/** A short digest of every counted ballot (receipt + choices), published with the results — any later
 *  change to the ballot box changes it. */
function fingerprint(ballots) {
  const lines = (ballots || []).filter(b => !Number(b.deleted)).map(b => {
    let ch; try { ch = typeof b.choices === 'string' ? JSON.parse(b.choices) : (b.choices || {}); } catch (_) { ch = {}; }
    const canon = Object.keys(ch).sort().map(k => k + '=' + (Array.isArray(ch[k]) ? ch[k].slice().sort().join('+') : '')).join(';');
    return b.receipt + '|' + canon;
  }).sort();
  const h = crypto.createHash('sha256').update(lines.join('\n')).digest('hex').toUpperCase().slice(0, 20);
  return h.match(/.{1,5}/g).join('-');
}

const markId = (secret, electionId, studentId) => 'evm_' + hmac(secret, 'mark|' + electionId + '|' + studentId).slice(0, 28);
const voterToken = (secret, electionId, studentId) => hmac(secret, 'ballot|' + electionId + '|' + studentId).slice(0, 32);
const candidateId = (positionId, studentId) => 'ecand_' + crypto.createHash('sha1').update(String(positionId) + '|' + String(studentId)).digest('hex').slice(0, 26);
function receipt() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.randomBytes(10); let s = ''; for (let i = 0; i < 10; i++) s += A[b[i] % A.length]; return s.slice(0, 5) + '-' + s.slice(5); }

function validateNomination(e, position, s, input, now, levelRank) {
  if (state(e, now) !== 'nominations') throw new Error('Nominations are not open for this election.');
  if (!position || Number(position.deleted) || position.election_id !== e.id) throw new Error('Choose a position.');
  if (!canVote(e, s) || !inScope(position.scope_kind, position.scope_id ? [position.scope_id] : [], s)) throw new Error('You are not eligible to stand for this position.');
  if (Number(position.min_level_rank) && (Number(levelRank) || 0) < Number(position.min_level_rank)) throw new Error(`Only ${position.min_level_rank}00 level students and above can stand for this position.`);
  const manifesto = clean(input && input.manifesto, 4000); if (manifesto.length < 50) throw new Error('Write your manifesto (at least a few sentences).');
  return { manifesto, slogan: clean(input && input.slogan, 120) || null };
}
function normalizeElection(input, existing) {
  const x = Object.assign({}, existing || {}, input || {});
  const out = { title: clean(x.title, 160), description: clean(x.description, 4000) || null, scope_kind: SCOPES.includes(x.scope_kind) ? x.scope_kind : 'all',
    scope_ids: JSON.stringify(ids(x.scope_ids)), nominations_open_at: x.nominations_open_at ? t16(x.nominations_open_at) : null, nominations_close_at: x.nominations_close_at ? t16(x.nominations_close_at) : null,
    opens_at: x.opens_at ? t16(x.opens_at) : null, closes_at: x.closes_at ? t16(x.closes_at) : null };
  if (!out.title) throw new Error('Give the election a title.');
  if (out.scope_kind !== 'all' && !ids(out.scope_ids).length) throw new Error('Choose who votes (which faculties / departments / levels).');
  if (!out.opens_at || !out.closes_at) throw new Error('Set when voting opens and closes.');
  if (out.closes_at <= out.opens_at) throw new Error('Voting must close after it opens.');
  if (!!out.nominations_open_at !== !!out.nominations_close_at) throw new Error('Set both the start and the end of nominations (or neither).');
  if (out.nominations_open_at && (out.nominations_close_at <= out.nominations_open_at || out.nominations_close_at > out.opens_at)) throw new Error('Nominations must close before voting opens.');
  return out;
}

module.exports = { INACTIVE, SCOPES, clean, ids, state, inScope, canVote, positionsFor, validateBallot, tally, fingerprint, markId, voterToken, candidateId, receipt, validateNomination, normalizeElection };
