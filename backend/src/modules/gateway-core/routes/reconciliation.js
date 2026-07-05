'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Bank reconciliation — upload a merchant's bank statement (CSV or XLS), match
//  its credits against that merchant's settlements, and surface exceptions
//  (settlements paid but not in the bank; bank credits with no settlement).
//  Merchant-facing value-add; SA/staff may act for a merchant via merchant_id.
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { prisma } = require('../../../utils/db');
const { requireAuth } = require('../../../middleware/auth');
const { ok, fail, notFound, koboToNaira } = require('../../../utils/helpers');
const { autoMatch } = require('../services/reconcile');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// MERCHANT → own; staff/SA → merchant_id from body/query.
function scopeMerchant(req) {
  if (req.user.role === 'MERCHANT') return req.user.merchant && req.user.merchant.id;
  return (req.body && req.body.merchant_id) || req.query.merchant_id || null;
}

// "1,234.56" / "₦1,234" → kobo bigint. Handles trailing "CR"/"DR" and parens negatives.
function toKobo(v) {
  if (v == null || v === '') return 0n;
  let s = String(v).trim();
  const neg = /^\(.*\)$/.test(s) || /dr$/i.test(s);
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (!isFinite(n)) return 0n;
  return BigInt(Math.round(n * 100)) * (neg ? -1n : 1n);
}
// Find a column value by fuzzy header match.
function pick(row, needles) {
  for (const k of Object.keys(row)) {
    const lk = k.toLowerCase().trim();
    if (needles.some((x) => lk.includes(x))) return row[k];
  }
  return undefined;
}

// ── POST /api/v1/reconciliation/upload ────────────────────────────────────────
// multipart file (CSV/XLS/XLSX). Columns auto-mapped by header keywords.
router.post('/upload', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const merchantId = scopeMerchant(req);
    if (!merchantId) return fail(res, 'merchant_id is required');
    if (!req.file) return fail(res, 'No file uploaded');

    let rows;
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } catch (e) { return fail(res, 'Could not parse the file — upload a CSV or Excel bank statement', 'PARSE_ERROR'); }
    if (!rows.length) return fail(res, 'The file has no data rows');

    const batch = crypto.randomUUID();
    let inserted = 0, skipped = 0;
    for (const r of rows) {
      let credit = toKobo(pick(r, ['credit', 'paid in', 'deposit', 'money in', 'inflow', 'cr amount']));
      let debit = toKobo(pick(r, ['debit', 'withdraw', 'paid out', 'money out', 'outflow', 'dr amount']));
      // Fallback: a single signed "amount" column.
      if (credit === 0n && debit === 0n) {
        const a = toKobo(pick(r, ['amount']));
        if (a > 0n) credit = a; else if (a < 0n) debit = -a;
      }
      if (credit === 0n && debit === 0n) { skipped++; continue; } // summary/blank row
      const narration = String(pick(r, ['narration', 'description', 'details', 'remarks', 'reference', 'particulars']) || '').slice(0, 500);
      const dateRaw = pick(r, ['date', 'value date', 'trans date', 'posting date', 'transaction date']);
      let txnDate = null;
      if (dateRaw) { const d = new Date(dateRaw); if (!isNaN(d.getTime())) txnDate = d.toISOString().slice(0, 10); }
      const balRaw = pick(r, ['balance']);
      const balance = (balRaw === undefined || balRaw === '') ? null : toKobo(balRaw).toString();
      await prisma.$executeRawUnsafe(
        `INSERT INTO bank_statement_lines (merchant_id, upload_batch, txn_date, credit_kobo, debit_kobo, narration, balance_kobo)
         VALUES ($1::uuid,$2::uuid,$3::date,$4,$5,$6,$7)`,
        merchantId, batch, txnDate, credit.toString(), debit.toString(), narration, balance);
      inserted++;
    }

    const auto = await autoMatch(merchantId);
    return ok(res, { batch, inserted, skipped, auto },
      `Uploaded ${inserted} line(s)${skipped ? ` (${skipped} skipped)` : ''} — auto-matched ${auto.matched}${auto.partial ? `, ${auto.partial} partial` : ''}.`);
  } catch (e) { next(e); }
});

// ── POST /api/v1/reconciliation/auto-match ────────────────────────────────────
router.post('/auto-match', requireAuth, async (req, res, next) => {
  try {
    const merchantId = scopeMerchant(req);
    if (!merchantId) return fail(res, 'merchant_id is required');
    const auto = await autoMatch(merchantId);
    return ok(res, auto, `Matched ${auto.matched}${auto.partial ? `, ${auto.partial} partial` : ''}.`);
  } catch (e) { next(e); }
});

// ── GET /api/v1/reconciliation/results ────────────────────────────────────────
router.get('/results', requireAuth, async (req, res, next) => {
  try {
    const merchantId = scopeMerchant(req);
    if (!merchantId) return fail(res, 'merchant_id is required');
    const n = (x) => Number(x || 0);

    const lines = await prisma.$queryRawUnsafe(
      `SELECT b.id::text, b.txn_date, b.credit_kobo::text AS credit, b.debit_kobo::text AS debit,
              b.narration, b.match_status, b.matched_settlement_id::text AS settlement_id, s.settlement_ref
         FROM bank_statement_lines b LEFT JOIN settlements s ON s.id = b.matched_settlement_id
        WHERE b.merchant_id = $1::uuid ORDER BY b.txn_date DESC NULLS LAST, b.created_at DESC LIMIT 1000`, merchantId);
    // Settlements with money but no matching bank credit = "not in bank yet" exceptions.
    const unrec = await prisma.$queryRawUnsafe(
      `SELECT s.id::text, s.settlement_ref, s.period_start, s.net_settled::text AS net, s.status
         FROM settlements s
        WHERE s.merchant_id = $1::uuid AND s.net_settled > 0
          AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.matched_settlement_id = s.id)
        ORDER BY s.period_start DESC LIMIT 500`, merchantId);

    const bankLines = lines.map((l) => ({
      id: l.id, txn_date: l.txn_date, narration: l.narration, match_status: l.match_status,
      settlement_ref: l.settlement_ref,
      credit: n(l.credit), debit: n(l.debit),
      credit_naira: koboToNaira(l.credit), debit_naira: koboToNaira(l.debit),
    }));
    const unmatchedCredits = bankLines.filter((l) => l.match_status === 'unmatched' && l.credit > 0);
    const summary = {
      bank_lines: bankLines.length,
      matched: bankLines.filter((l) => l.match_status === 'matched').length,
      partial: bankLines.filter((l) => l.match_status === 'partial').length,
      unmatched_credits: unmatchedCredits.length,
      settlements_not_in_bank: unrec.length,
    };
    return ok(res, {
      summary,
      bank_lines: bankLines,
      exceptions: {
        unmatched_bank_credits: unmatchedCredits,
        settlements_not_in_bank: unrec.map((s) => ({ id: s.id, settlement_ref: s.settlement_ref, period_start: s.period_start, status: s.status, net: n(s.net), net_naira: koboToNaira(s.net) })),
      },
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/reconciliation/match — manual match a bank line to a settlement ──
router.post('/match', requireAuth, async (req, res, next) => {
  try {
    const merchantId = scopeMerchant(req);
    const { line_id, settlement_id, note } = req.body || {};
    if (!merchantId || !line_id || !settlement_id) return fail(res, 'line_id and settlement_id are required');
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE bank_statement_lines SET match_status = 'matched', matched_settlement_id = $2::uuid, match_note = $3
        WHERE id = $1::uuid AND merchant_id = $4::uuid RETURNING id::text`,
      line_id, settlement_id, note || 'manual match', merchantId);
    if (!rows.length) return notFound(res, 'Bank line');
    return ok(res, { id: rows[0].id }, 'Matched');
  } catch (e) { next(e); }
});

module.exports = router;
