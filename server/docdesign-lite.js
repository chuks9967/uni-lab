'use strict';
/**
 * 🎨 PORTAL-SIDE (server) resolution of the ISSUING OFFICER's document design — so a student's
 * self-service copy (e.g. a receipt they download from their portal) carries the SAME look the
 * officer who issued it designed on the desktop (Document Design).
 *
 * Pure + dependency-free (no DB, no electron/services), so it runs on the Node hub AND the Supabase
 * Edge (Deno) build, and is unit-testable in isolation. It mirrors the FRONT of the desktop chain in
 * electron/services/docstyle.resolveDesign — issuing USER → their OFFICE → their FACULTY — over the
 * SYNCED rows the portal already has (`document_designs` + `faculty_templates`). The university-wide
 * default is deliberately NOT resolved here: institution settings aren't synced as rows, and the
 * portal's own built-in look already IS that default — so when the officer has no design at any level
 * this returns null and the portal renders exactly as before.
 */

/** The office key a role-level design is stored under (campus-qualified — matches docstyle.officeKeyFor). */
function officeKeyFor(issuer) {
  if (!issuer || !issuer.role) return '';
  return issuer.campus_id ? (issuer.role + '@' + issuer.campus_id) : String(issuer.role);
}
function parseTokens(row) { if (!row) return null; try { return JSON.parse(row.tokens || '{}') || {}; } catch (_) { return {}; } }
const enabledRow = (r) => r && !r.deleted && (r.enabled === undefined || r.enabled === null || !!r.enabled || r.enabled === 1);

/**
 * Merge the issuing officer's design tokens for a document kind: faculty → office → user (user wins).
 *   designRows   — every `document_designs` row (owner_type user|office).
 *   facultyRows  — every `faculty_templates` row.
 *   issuer       — the officer who issued the document ({ id, role, campus_id, faculty_id }).
 *   docKind      — 'receipt' | 'result_sheet' | 'transcript' | …
 *   facId        — the faculty whose design to fall back to (the officer's, else the student's).
 * Returns the merged token object, or null when the officer has no design at any level.
 */
function resolveOfficerDesign(designRows, facultyRows, issuer, docKind, facId) {
  if (!issuer || !docKind) return null;
  const dds = (designRows || []).filter(r => enabledRow(r) && r.doc_kind === docKind);
  const officeKey = officeKeyFor(issuer);
  const userRow = issuer.id ? dds.find(r => r.owner_type === 'user' && String(r.owner_id) === String(issuer.id)) : null;
  const officeRow = officeKey ? dds.find(r => r.owner_type === 'office' && String(r.owner_id) === officeKey) : null;
  const facRow = facId ? (facultyRows || []).find(r => enabledRow(r) && String(r.faculty_id) === String(facId)) : null;
  const merged = Object.assign({}, parseTokens(facRow), parseTokens(officeRow), parseTokens(userRow));
  return Object.keys(merged).length ? merged : null;
}

const isHex = (v) => /^#[0-9a-fA-F]{3,8}$/.test(String(v || ''));
/** WCAG relative luminance of #rrggbb (0…1). */
function lum(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return 0.5;
  const c = [1, 2, 3].map((i) => { const v = parseInt(m[i], 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** The readable ink to print ON a coloured fill — a light accent never yields white-on-white. */
function readableOn(hex) { return lum(hex) > 0.52 ? '#111827' : '#ffffff'; }
/**
 * Distil the design tokens into the handful of values the portal skin needs (palette + watermark word
 * + a signature ink). null when there are no tokens — the caller then leaves the portal look untouched.
 * `inst` = { name, short, motto } for resolving the watermark wording source.
 */
function designSkin(tokens, inst) {
  if (!tokens) return null;
  const i = inst || {};
  const src = String(tokens.wmSource || 'name');
  let wmWord = i.name || '';
  if (src === 'short') wmWord = (i.short || i.name || '').toUpperCase();
  else if (src === 'motto') wmWord = i.motto || i.name || '';
  else if (src === 'name_motto') wmWord = i.motto ? (i.name + ' · ' + i.motto) : (i.name || '');
  else if (src === 'custom') wmWord = tokens.wmText || i.name || '';
  const wmOff = tokens.wmShape === 'none' || String(tokens.wmSource || '') === '' || Number(tokens.wmOpacity) === 0;
  const accent = isHex(tokens.accent) ? tokens.accent : '#1e3a8a';
  return {
    accent,
    onAccent: readableOn(accent),                 // readable text ON the accent (bars/buttons)
    paper: isHex(tokens.transcriptPaper) ? tokens.transcriptPaper : '#ffffff',
    ink: isHex(tokens.transcriptInk) ? tokens.transcriptInk : '#1f2937',
    sigInk: isHex(tokens.sigInk) ? tokens.sigInk : (isHex(tokens.stampInk) ? tokens.stampInk : '#1e3a8a'),
    wmWord: wmOff ? '' : String(wmWord || '').slice(0, 40),
    sigStyle: String(tokens.sigTranscriptStyle || 'executive'),
  };
}

/**
 * A skin object shaped for the shared form-layout engine (server/formlayout.js) — so the portal can
 * render a self-service receipt in the SAME structural layout the officer designed (voucher, revenue
 * slip, thermal, ledger, presentation…). Mirrors the fields electron's designSkin() exposes: accent /
 * accent2 / ink / paper / onAccent, a `tint(aa)` helper and the base `css`. The design WATERMARK is a
 * desktop SVG engine the portal doesn't run, so `wmHtml` stays '' and the caller passes any overlay
 * (e.g. "STUDENT COPY") as ctx.watermarkHtml instead.
 */
// 🔠 the same font stacks the desktop resolves (transcriptdoc.FONT_STACKS) — duplicated here to keep the
// portal renderer standalone, so a self-service receipt wears the SAME face the officer chose.
const FONT_STACKS = {
  serif: "Cambria,'Times New Roman',Georgia,serif",
  oldstyle: "'Palatino Linotype','Book Antiqua',Georgia,serif",
  sans: "'Segoe UI',Calibri,Arial,sans-serif",
  'sans-condensed': "'Arial Narrow','Segoe UI',Arial,sans-serif",
  slab: "Rockwell,'Segoe UI',Georgia,serif",
  mono: "Consolas,'Courier New',monospace",
  blackletter: "'Old English Text MT',Georgia,serif",
  engraved: "'Copperplate Gothic Light','Copperplate Gothic','Trajan Pro',Georgia,serif",
};
function formSkin(tokens, inst) {
  const t = tokens || {};
  const accent = isHex(t.accent) ? t.accent : '#1e3a8a';
  const accent2 = isHex(t.accent2) ? t.accent2 : accent;
  const ink = isHex(t.transcriptInk) ? t.transcriptInk : '#1f2937';
  const paper = isHex(t.transcriptPaper) ? t.transcriptPaper : '#ffffff';
  const tint = (aa) => /^#[0-9a-fA-F]{6}$/.test(accent) ? accent + aa : accent;
  const fontBody = FONT_STACKS[String(t.fontBody || '').trim()] || '';
  const css = `.ds-wm{position:absolute;inset:0;overflow:hidden;z-index:0;pointer-events:none}
    .ds-scope{position:relative;z-index:1}
    :root{--ds-accent:${accent};--ds-accent2:${accent2};--ds-ink:${ink};--ds-paper:${paper}}`;
  return { accent, accent2, ink, paper, onAccent: readableOn(accent), tint, css, wmHtml: '', fontBody, active: true };
}

module.exports = { officeKeyFor, resolveOfficerDesign, designSkin, formSkin };
