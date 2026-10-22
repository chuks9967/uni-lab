'use strict';
/**
 * 🧾 FORM-DOCUMENT LAYOUT ENGINE — RETIRED, and deliberately kept as an inert stub.
 *
 * This module used to offer ~37 hand-built "structural layouts" (voucher · revenue slip · thermal roll ·
 * ledger · ministry stack · corporate sidebar · framed charter …) that an officer picked from a dropdown
 * for receipts, invoices and admission letters. It has been REPLACED by the LETTERHEAD BAND ENGINE
 * (server/letterhead.js), for one reason:
 *
 *   Asking a university to choose between a dozen invented stationery designs is the same mistake as
 *   storing a Word template — it APPROXIMATES an identity the institution already owns. Every
 *   university already has a letterhead, printed on the paper in its drawer. So instead of picking a
 *   look, the registry uploads the two bands that actually matter — the real HEADER strip and the real
 *   FOOTER strip — and every document it issues is printed on them, at exact physical size, on every
 *   page, with the body inset so text can never land on the artwork.
 *
 * The stub stays rather than the file being deleted because three call sites in
 * services/documents.js still ask `has(kind, key)` before choosing a renderer, and a saved design may
 * still carry an old `formLayout` token. Both now resolve to "no special layout", so those documents
 * fall through to the classic renderer and then wear the uploaded letterhead like everything else.
 * Nothing throws, nothing is lost, and no institution is left with a half-rendered document.
 *
 * The retired renderers live in git history if a specific one is ever wanted back.
 */

/** No layouts are offered any more — the designer shows the Letterhead uploader instead. */
function catalog() { return []; }
/** No key is a real layout now, so every caller takes its classic path. */
function has() { return false; }
/** Never renders — `null` tells the caller to use its own renderer. */
function render() { return null; }

const RECEIPT_LAYOUTS = [];
const INVOICE_LAYOUTS = [];
const ADMISSION_LAYOUTS = [];

module.exports = { catalog, has, render, RECEIPT_LAYOUTS, INVOICE_LAYOUTS, ADMISSION_LAYOUTS, RETIRED: true };
