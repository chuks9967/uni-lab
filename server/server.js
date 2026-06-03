'use strict';
/**
 * UniBursar Central Sync Server (REST) — for GLOBAL, anywhere-in-the-world sharing.
 *
 * The desktop app auto-hosts a local hub, but that is only reachable on the same
 * machine/LAN. To let users anywhere share one live database, deploy THIS file to
 * a public host (a small VPS, Render, Railway, Fly.io, etc.):
 *
 *   1)  copy the project (or just this server folder + package.json) to the host
 *   2)  npm install express
 *   3)  PORT=4000 node server/server.js     (use a process manager like pm2 in prod)
 *   4)  in EVERY client → Administration → Sync, set Server URL to:
 *           http://<your-public-host>:4000        (or https://… behind a proxy)
 *
 * All clients then converge on this hub: every registered student/payment/etc. is
 * visible to every user, and each client still works fully offline and re-syncs
 * automatically when back online.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

const PORT = process.env.PORT || 4000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE = path.join(DATA_DIR, 'central-store.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let records = {};
try { if (fs.existsSync(STORE)) records = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (_) { records = {}; }
let saveTimer = null;
function save() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; try { fs.writeFileSync(STORE, JSON.stringify(records)); } catch (_) {} }, 600); }

const app = express();
app.use(express.json({ limit: '16mb' }));
app.get('/', (_q, r) => r.send('UniBursar Sync Server is running. Point each client\'s Server URL at this address.'));
app.get('/health', (_q, r) => r.json({ ok: true, records: Object.keys(records).length, time: new Date().toISOString() }));

app.post('/sync/push', (req, res) => {
  const changes = (req.body && req.body.changes) || [];
  let applied = 0;
  for (const ch of changes) {
    const entity = ch && ch.entity, row = ch && ch.row;
    if (!entity || !row || !row.id) continue;
    const key = `${entity}:${row.id}`;
    const updated_at = row.updated_at || new Date().toISOString();
    const prev = records[key];
    if (prev && prev.updated_at && updated_at <= prev.updated_at) continue;
    records[key] = { entity, id: row.id, row, updated_at };
    applied++;
  }
  if (applied) save();
  res.json({ ok: true, applied });
});

app.get('/sync/pull', (req, res) => {
  const since = req.query.since || null;
  const out = [];
  for (const k of Object.keys(records)) { const rec = records[k]; if (!since || rec.updated_at > since) out.push({ entity: rec.entity, row: rec.row, updated_at: rec.updated_at }); }
  res.json({ ok: true, changes: out, now: new Date().toISOString() });
});

const httpServer = http.createServer(app);
httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n⚠  Port ${PORT} is already in use.`);
    console.error('   The UniBursar desktop app already hosts a sync hub on this port automatically,');
    console.error('   so you do NOT need to run this standalone server on the same machine.\n');
    console.error('   • To run this hub anyway on a different port:   PORT=5000 node server/server.js');
    console.error('   • For worldwide sharing, run it on a SEPARATE public host (VPS / Render / Railway),');
    console.error('     then set each client\'s Server URL (Administration → Sync) to that public address.\n');
    process.exit(1);
  }
  console.error('Server error:', e.message);
  process.exit(1);
});
httpServer.listen(PORT, () => console.log(`UniBursar REST sync server listening on http://0.0.0.0:${PORT}  (Ctrl+C to stop)`));
