'use strict';
/**
 * ⚡ RECORD-STORE INDEX — the hubs keep every synced row in one object keyed "entity:id". The portal asks for
 * `all('payments')`, `all('students')`… dozens of times per page, and each call used to walk EVERY record of
 * EVERY entity (100 000 rows × 60 calls = 6 million steps for one dashboard). `wrap()` returns the same object
 * behind a Proxy that keeps a per-entity index up to date on every write and delete, so `all(store, entity)` only
 * touches that entity's rows. Reads, `for…in`, JSON.stringify and Object.keys behave exactly as before.
 */
const INDEX = new WeakMap();

function wrap(raw) {
  const target = raw && typeof raw === 'object' ? raw : {};
  if (INDEX.has(target)) return target;
  const by = new Map();
  const add = (k, v) => { if (v && v.entity) { let m = by.get(v.entity); if (!m) { m = new Map(); by.set(v.entity, m); } m.set(k, v); } };
  const drop = (k, prev) => { if (prev && prev.entity) { const m = by.get(prev.entity); if (m) m.delete(k); } };
  for (const k of Object.keys(target)) add(k, target[k]);
  const proxy = new Proxy(target, {
    set(t, k, v) { drop(k, t[k]); t[k] = v; add(k, v); return true; },
    deleteProperty(t, k) { drop(k, t[k]); delete t[k]; return true; },
  });
  INDEX.set(proxy, by);
  return proxy;
}

/** The live (not deleted) rows of one entity. Falls back to a full scan for a store that was never wrapped. */
function all(store, entity) {
  const out = [];
  const by = store && INDEX.get(store);
  if (by) { const m = by.get(entity); if (m) for (const r of m.values()) if (r && r.row && !r.row.deleted) out.push(r.row); return out; }
  for (const k in store) { const r = store[k]; if (r && r.entity === entity && r.row && !r.row.deleted) out.push(r.row); }
  return out;
}
/** How many rows (live or not) an entity has — cheap, for status pages. */
function count(store, entity) { const by = store && INDEX.get(store); const m = by && by.get(entity); return m ? m.size : 0; }

module.exports = { wrap, all, count };
