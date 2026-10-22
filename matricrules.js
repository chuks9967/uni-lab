'use strict';
/**
 * 🆔 MATRIC NUMBERS — ONE pure module (desk · portal · edge) for the one identifier every student record, biometric
 * template, result, payment and ID card hangs on. A matric number must belong to exactly ONE student.
 *
 * 🐛 THE HOLES THIS FILLS
 *  • Uniqueness was by exact text (case-insensitive at best): "CSC/2024/001", "csc 2024 001" and "CSC-2024-001" were three
 *    different numbers to the system and one to every human. → canon() — the same key for all of them.
 *  • Two desks (campuses, or a laptop working offline) issue numbers independently; when the second record synced in, the
 *    database refused it and the student silently never arrived. → the record arrives WITHOUT the clashing number and
 *    the clash is recorded for the Registry to resolve (conflictRow).
 *
 *   canon(m) · validate(m) · same(a, b) · duplicateGroups(rows) · conflictRow(...)
 */
/** The comparison key: upper-case; every separator (space / - . _) read as "/", runs collapsed, ends trimmed — the SAME
 *  expression the database trigger keeps in students.matric_key (electron/db/database.js), so SQL and JS always agree. */
function canon(m) {
  // spaces are separators too ("CSC 2024 001"); separators are NOT dropped — "CSC/2024/1" and "CSC/20/241" stay different
  const s = String(m == null ? '' : m).normalize('NFKC').toUpperCase().trim().replace(/[\s\-._]+/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return s || null;
}
const same = (a, b) => { const x = canon(a); return !!x && x === canon(b); };

/** A number a person typed: 3–40 characters, letters/digits and separators (legacy numbers may be letters only). */
function validate(m) {
  const raw = String(m == null ? '' : m).trim();
  if (!raw) return { ok: true, value: null };
  if (raw.length < 3 || raw.length > 40) return { ok: false, error: 'A matric number is 3 to 40 characters.' };
  if (!/^[A-Za-z0-9/\-._ ]+$/.test(raw)) return { ok: false, error: 'A matric number may only use letters, digits and / - . _' };
  return { ok: true, value: raw.replace(/\s+/g, ' '), key: canon(raw) };
}

/** Live students that share a matric key: [{ key, students: [{ id, matric_no, name, created_at }] }] — oldest first. */
function duplicateGroups(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (!r || Number(r.deleted)) continue;
    const k = canon(r.matric_no); if (!k) continue;
    (by.get(k) || by.set(k, []).get(k)).push(r);
  }
  return [...by.entries()].filter(([, v]) => v.length > 1)
    .map(([key, v]) => ({ key, students: v.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))).map(s => ({ id: s.id, matric_no: s.matric_no, name: [s.first_name, s.last_name].filter(Boolean).join(' '), created_at: s.created_at || null })) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The record of a clash found when a student arrived by sync. */
const conflictRow = (incoming, holder, origin) => ({ matric_no: incoming.matric_no, matric_key: canon(incoming.matric_no), student_id: incoming.id, holder_id: holder && holder.id, origin_node: origin || null, status: 'open' });

module.exports = { canon, same, validate, duplicateGroups, conflictRow };
