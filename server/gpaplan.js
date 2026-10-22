'use strict';
/**
 * 🎯 WHAT GPA DO I NEED? — ONE pure module (portal · edge · tests; the portal page and the app do the same sum for the
 * free calculator) for a student's next step on a CGPA scale.
 *
 *   needed(cgpa, units, target, nextUnits) → the GPA this term must be for the CGPA to reach `target` after `nextUnits`
 *                                             more units:  (target·(U+u) − cgpa·U) / u
 *   plan({ cgpa, units, nextUnits, bands, gpMax }) → { cgpa, units, next_units, gp_max, class_now, targets: [{ key, label,
 *     min, needed, reachable, secure }] }   one line per class of degree in the institution's standard (secure = the
 *     class holds whatever the term brings; reachable = needed ≤ the scale's maximum)
 *   trend(semesters) → { last, prev, delta, direction: 'up'|'down'|'same'|null, best, worst }
 *
 * Only for CGPA standards (basis 'gpa'); a weighted-average standard (marks out of 20…) gets null from the portal.
 */
const r2 = (n) => Math.round(Number(n) * 100) / 100;

function needed(cgpa, units, target, nextUnits) {
  const U = Math.max(0, Number(units) || 0), u = Number(nextUnits) || 0, c = Number(cgpa) || 0, T = Number(target);
  if (!(u > 0) || !Number.isFinite(T)) return null;
  return r2((T * (U + u) - c * U) / u);
}

function plan(o) {
  const x = o || {}; const M = Number(x.gpMax) > 0 ? Number(x.gpMax) : 5;
  const c = Number(x.cgpa) || 0, U = Number(x.units) || 0, u = Number(x.nextUnits) || 0;
  const bands = (x.bands || []).filter(b => b && Number(b.min) > 0).slice().sort((a, b) => b.min - a.min);
  const now = bands.find(b => U > 0 && c >= b.min - 1e-9) || null;
  const targets = u > 0 ? bands.filter(b => b.award !== false).map(b => {
    const n = needed(c, U, b.min, u);
    return { key: b.key || b.label, label: b.label, min: r2(b.min), needed: Math.max(0, n), reachable: n <= M + 1e-9, secure: n <= 0 };
  }) : [];
  return { cgpa: r2(c), units: U, next_units: u, gp_max: M, class_now: now ? now.label : null, targets };
}

function trend(semesters) {
  const s = (semesters || []).filter(x => x && x.gpa != null && Number.isFinite(Number(x.gpa)));
  if (!s.length) return { last: null, prev: null, delta: null, direction: null, best: null, worst: null };
  const last = Number(s[s.length - 1].gpa), prev = s.length > 1 ? Number(s[s.length - 2].gpa) : null;
  const delta = prev == null ? null : r2(last - prev);
  const gp = s.map(x => Number(x.gpa));
  return { last: r2(last), prev: prev == null ? null : r2(prev), delta, direction: delta == null ? null : delta > 0.009 ? 'up' : delta < -0.009 ? 'down' : 'same', best: r2(Math.max(...gp)), worst: r2(Math.min(...gp)) };
}

module.exports = { needed, plan, trend };
