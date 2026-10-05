'use strict';
const router = require('express').Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { prisma, tenantAuth, requireWalletEnabled } = require('../_shared');
const { ok, fail } = require('../../../utils/helpers');

router.use(tenantAuth, requireWalletEnabled);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const n = (v) => Number(v || 0);

// ── Route 1: GET /settlement ─────────────────────────────────────────────────
router.get('/settlement', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const from = req.query.from || null;
    const to   = req.query.to   || null;

    const params = [mid];
    let where = 'WHERE merchant_id = $1::uuid';
    if (from) { params.push(from); where += ` AND period_to >= $${params.length}::date`; }
    if (to)   { params.push(to);   where += ` AND period_from <= $${params.length}::date`; }

    const settlements = await prisma.$queryRawUnsafe(
      `SELECT id::text, merchant_id::text, period_from, period_to,
              gross_kobo::text AS gross_kobo, member_count, txn_count,
              status, payout_ref, failure_reason, settled_at, created_at
         FROM mw_dept_settlements ${where} ORDER BY period_from DESC`,
      ...params);

    const enriched = [];
    for (const s of settlements) {
      const txns = await prisma.$queryRawUnsafe(
        `SELECT l.id::text, COALESCE(m.name, l.counterparty) AS member_name,
                l.direction, l.type, l.amount::text AS amount, l.reference,
                l.note, l.counterparty, l.department_id::text AS department_id, l.created_at
           FROM mw_ledger l
           LEFT JOIN mw_members m ON m.id = l.member_id
          WHERE l.merchant_id = $1::uuid
            AND l.created_at::date BETWEEN $2::date AND $3::date
          ORDER BY l.created_at`,
        mid, s.period_from, s.period_to);
      enriched.push({
        ...s,
        gross_kobo: n(s.gross_kobo),
        transactions: txns.map((t) => ({ ...t, amount: n(t.amount) })),
      });
    }

    // Unreconciled: ledger rows in requested range not covered by any settlement
    let unreconRows = [];
    if (from || to) {
      const rangeFrom = from || '1970-01-01';
      const rangeTo   = to   || '9999-12-31';
      const allTxns = await prisma.$queryRawUnsafe(
        `SELECT l.id::text, COALESCE(m.name, l.counterparty) AS member_name,
                l.direction, l.type, l.amount::text AS amount, l.reference, l.created_at
           FROM mw_ledger l
           LEFT JOIN mw_members m ON m.id = l.member_id
          WHERE l.merchant_id = $1::uuid
            AND l.created_at::date BETWEEN $2::date AND $3::date
          ORDER BY l.created_at`,
        mid, rangeFrom, rangeTo);

      const periods = settlements.map((s) => ({ from: s.period_from, to: s.period_to }));
      unreconRows = allTxns.filter((t) => {
        const d = typeof t.created_at === 'string' ? t.created_at.slice(0, 10) : new Date(t.created_at).toISOString().slice(0, 10);
        return !periods.some((p) => {
          const pf = typeof p.from === 'string' ? p.from : new Date(p.from).toISOString().slice(0, 10);
          const pt = typeof p.to   === 'string' ? p.to   : new Date(p.to).toISOString().slice(0, 10);
          return d >= pf && d <= pt;
        });
      }).map((t) => ({ ...t, amount: n(t.amount) }));
    }

    const totalSettledKobo = enriched.reduce((a, s) => a + s.gross_kobo, 0);
    const totalUnreconKobo = unreconRows.reduce((a, t) => a + (t.direction === 'credit' ? t.amount : 0), 0);
    const txnCount = enriched.reduce((a, s) => a + s.transactions.length, 0);

    return ok(res, {
      settlements: enriched,
      unreconciled: unreconRows,
      summary: {
        settlement_count: enriched.length,
        total_settled_kobo: totalSettledKobo,
        total_unreconciled_kobo: totalUnreconKobo,
        txn_count: txnCount,
      },
    });
  } catch (e) { next(e); }
});

// ── Route 2: POST /upload-statement ──────────────────────────────────────────
router.post('/upload-statement', upload.single('statement'), async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 'No file uploaded. Send a multipart/form-data field named "statement".');

    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    const HEADER_KEYWORDS = ['date', 'amount', 'credit', 'debit', 'narration', 'description', 'reference', 'details', 'remarks', 'value', 'balance'];
    let headerRowIdx = -1;
    let headerRow = null;

    for (let i = 0; i < Math.min(10, raw.length); i++) {
      const row = raw[i];
      if (!Array.isArray(row)) continue;
      const cells = row.map((c) => String(c || '').toLowerCase().trim());
      const hits = cells.filter((c) => HEADER_KEYWORDS.some((k) => c.includes(k))).length;
      if (hits >= 2) { headerRowIdx = i; headerRow = cells; break; }
    }

    if (headerRowIdx === -1)
      return fail(res, 'Could not detect column headers. Ensure the file has a row with Date, Credit/Debit or Amount, and Description columns.');

    const findCol = (...terms) => {
      const idx = headerRow.findIndex((c) => terms.some((t) => c.includes(t)));
      return idx >= 0 ? idx : null;
    };

    const colDate   = findCol('value date', 'date');
    const colDesc   = findCol('narration', 'description', 'details', 'remarks');
    const colCredit = findCol('credit');
    const colDebit  = findCol('debit');
    const colAmount = colCredit === null ? findCol('amount') : null;
    const colRef    = findCol('reference', 'ref');
    const colBal    = findCol('balance');

    const toKobo = (v) => {
      if (v === null || v === undefined || v === '') return 0;
      const f = parseFloat(String(v).replace(/[₦,\s]/g, ''));
      return isNaN(f) ? 0 : Math.round(f * 100);
    };

    const toDateStr = (v) => {
      if (!v) return null;
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === 'number') {
        const d = XLSX.SSF.parse_date_code(v);
        if (!d) return null;
        return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
      }
      const s = String(v).trim();
      const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (m) {
        const yr = m[3].length === 2 ? '20' + m[3] : m[3];
        return `${yr}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
      }
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    };

    const rows = [];
    let totalCredits = 0, totalDebits = 0;

    for (let i = headerRowIdx + 1; i < raw.length; i++) {
      const row = raw[i];
      if (!Array.isArray(row)) continue;
      const dateVal = colDate !== null ? row[colDate] : null;
      const date = toDateStr(dateVal);
      if (!date) continue;

      const creditRaw = colCredit !== null ? toKobo(row[colCredit]) : 0;
      const debitRaw  = colDebit  !== null ? toKobo(row[colDebit])  : 0;
      const amtRaw    = colAmount !== null ? toKobo(row[colAmount]) : 0;

      const credit_kobo = creditRaw || (amtRaw > 0 ? amtRaw : 0);
      const debit_kobo  = debitRaw  || (amtRaw < 0 ? Math.abs(amtRaw) : 0);

      totalCredits += credit_kobo;
      totalDebits  += debit_kobo;

      rows.push({
        row_num: i + 1,
        date,
        description: colDesc !== null ? String(row[colDesc] || '').trim() : '',
        credit_kobo,
        debit_kobo,
        reference:   colRef !== null ? String(row[colRef] || '').trim() : '',
        balance_kobo: colBal !== null ? toKobo(row[colBal]) : null,
      });
    }

    return ok(res, { rows, total_credits_kobo: totalCredits, total_debits_kobo: totalDebits, row_count: rows.length });
  } catch (e) { next(e); }
});

// ── Route 3: POST /run-match ──────────────────────────────────────────────────
router.post('/run-match', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const { from, to, statement_rows } = req.body || {};

    if (!Array.isArray(statement_rows) || !statement_rows.length)
      return fail(res, 'statement_rows array is required');

    const params = [mid];
    let where = 'WHERE merchant_id = $1::uuid';
    if (from) { params.push(from); where += ` AND period_to >= $${params.length}::date`; }
    if (to)   { params.push(to);   where += ` AND period_from <= $${params.length}::date`; }

    const settlements = await prisma.$queryRawUnsafe(
      `SELECT id::text, period_from, period_to, gross_kobo::text AS gross_kobo,
              status, payout_ref, settled_at
         FROM mw_dept_settlements ${where} ORDER BY period_from`,
      ...params);

    const bankCredits = statement_rows.filter((r) => (r.credit_kobo || 0) > 0);

    const matched = [];
    const usedSettlementIds = new Set();
    const usedBankIndices   = new Set();

    // Pass 1 — reference match
    for (let bi = 0; bi < bankCredits.length; bi++) {
      const brow = bankCredits[bi];
      for (const s of settlements) {
        if (usedSettlementIds.has(s.id) || !s.payout_ref || s.status !== 'settled') continue;
        const haystack = `${brow.reference || ''} ${brow.description || ''}`.toLowerCase();
        if (haystack.includes(s.payout_ref.toLowerCase())) {
          matched.push({ settlement: { ...s, gross_kobo: n(s.gross_kobo) }, bank_row: brow, match_method: 'reference' });
          usedSettlementIds.add(s.id);
          usedBankIndices.add(bi);
          break;
        }
      }
    }

    // Pass 2 — amount + date match
    for (let bi = 0; bi < bankCredits.length; bi++) {
      if (usedBankIndices.has(bi)) continue;
      const brow = bankCredits[bi];
      const bankDate = brow.date ? new Date(brow.date) : null;

      for (const s of settlements) {
        if (usedSettlementIds.has(s.id) || s.status !== 'settled') continue;
        const sGross = n(s.gross_kobo);
        if (Math.abs(brow.credit_kobo - sGross) > 100) continue;
        if (!bankDate || !s.settled_at) continue;
        const settledDate = new Date(s.settled_at);
        const diffDays = Math.abs((bankDate - settledDate) / 86400000);
        if (diffDays <= 2) {
          matched.push({ settlement: { ...s, gross_kobo: sGross }, bank_row: brow, match_method: 'amount+date' });
          usedSettlementIds.add(s.id);
          usedBankIndices.add(bi);
          break;
        }
      }
    }

    const unmatchedSettlements = settlements
      .filter((s) => !usedSettlementIds.has(s.id))
      .map((s) => ({ ...s, gross_kobo: n(s.gross_kobo) }));

    const unmatchedBankCredits = bankCredits.filter((_, i) => !usedBankIndices.has(i));

    const matchedKobo = matched.reduce((a, m) => a + m.settlement.gross_kobo, 0);
    const unmatchedSettlementsKobo = unmatchedSettlements.reduce((a, s) => a + s.gross_kobo, 0);

    return ok(res, {
      matched,
      unmatched_settlements: unmatchedSettlements,
      unmatched_bank_credits: unmatchedBankCredits,
      summary: {
        matched_count: matched.length,
        unmatched_settlements_count: unmatchedSettlements.length,
        unmatched_bank_count: unmatchedBankCredits.length,
        matched_kobo: matchedKobo,
        unmatched_settlements_kobo: unmatchedSettlementsKobo,
      },
    });
  } catch (e) { next(e); }
});

module.exports = router;
