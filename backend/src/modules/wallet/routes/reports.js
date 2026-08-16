'use strict';
// Merchant wallet dashboard — float, members, funding/spend volumes, department
// balances, low-balance count, pending approvals, reconciliation.
const router = require('express').Router();
const { prisma, tenantAuth, requireWalletEnabled } = require('../_shared');
const { ok, fail, created } = require('../../../utils/helpers');
const ledger = require('../services/ledger');

router.use(tenantAuth, requireWalletEnabled);
const n = (v) => Number(v || 0);

router.get('/summary', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const s = (await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM mw_members WHERE merchant_id=$1::uuid) AS members,
         (SELECT COUNT(*)::int FROM mw_wallets WHERE merchant_id=$1::uuid AND status='active') AS active_wallets,
         (SELECT COALESCE(SUM(balance),0)::text FROM mw_wallets WHERE merchant_id=$1::uuid) AS float_total,
         (SELECT COUNT(*)::int FROM mw_wallets w WHERE w.merchant_id=$1::uuid AND w.low_balance_threshold>0 AND w.balance < w.low_balance_threshold) AS low_balance,
         (SELECT COALESCE(SUM(amount),0)::text FROM mw_ledger WHERE merchant_id=$1::uuid AND type='fund') AS funded_total,
         (SELECT COALESCE(SUM(amount),0)::text FROM mw_ledger WHERE merchant_id=$1::uuid AND type='spend') AS spent_total,
         (SELECT COUNT(*)::int FROM mw_load_requests WHERE merchant_id=$1::uuid AND status='pending') AS pending_loads`,
      mid))[0];
    const recon = await ledger.reconcile(mid);
    return ok(res, {
      members: s.members, active_wallets: s.active_wallets,
      float_total: n(s.float_total), low_balance_wallets: s.low_balance,
      funded_total: n(s.funded_total), spent_total: n(s.spent_total),
      pending_loads: s.pending_loads, reconciliation: recon,
    });
  } catch (e) { next(e); }
});

// Department subsidiary balances.
router.get('/departments', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT d.id::text AS department_id, d.name,
              COALESCE(SUM(CASE WHEN l.direction='credit' THEN l.amount ELSE -l.amount END),0)::text AS balance
         FROM inv_departments d
         LEFT JOIN mw_dept_ledger l ON l.department_id = d.id
        WHERE d.merchant_id=$1::uuid GROUP BY d.id, d.name ORDER BY d.name`, mid);
    return ok(res, rows.map((r) => ({ ...r, balance: n(r.balance) })));
  } catch (e) { next(e); }
});

// ── Settlement history ──────────────────────────────────────────────────────
router.get('/settlements', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, period_from, period_to, gross_kobo::text AS gross_kobo,
              member_count, txn_count, status, payout_ref, failure_reason, settled_at, created_at
         FROM mw_dept_settlements WHERE merchant_id=$1::uuid ORDER BY created_at DESC LIMIT 100`, mid);
    return ok(res, rows.map((r) => ({
      ...r, gross: n(r.gross_kobo), gross_major: n(r.gross_kobo) / 100,
    })));
  } catch (e) { next(e); }
});

// Queue a settlement for all dept credits in [period_from, period_to].
// SA/ops team processes the actual payout separately.
router.post('/settle', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const from = String(req.body.period_from || '').trim();
    const to   = String(req.body.period_to   || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return fail(res, 'period_from and period_to are required (YYYY-MM-DD)');
    if (from > to) return fail(res, 'period_from must be on or before period_to');

    // Aggregate: credits in mw_dept_ledger for this merchant within the date range.
    const agg = (await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0)::text AS gross,
              COUNT(DISTINCT CASE WHEN direction='credit' THEN member_id END)::int AS member_count,
              COUNT(*)::int AS txn_count
         FROM mw_dept_ledger
        WHERE merchant_id=$1::uuid
          AND created_at >= $2::date AND created_at < ($3::date + interval '1 day')`, mid, from, to))[0];

    const gross = BigInt(agg.gross || 0);
    if (gross <= 0n) return fail(res, 'No dept credits found for that period — nothing to settle', 'NO_BALANCE', 422);

    const createdBy = req.walletTenant.userId || null;
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO mw_dept_settlements
         (merchant_id, period_from, period_to, gross_kobo, member_count, txn_count, created_by)
       VALUES ($1::uuid,$2::date,$3::date,$4,$5,$6,$7::uuid) RETURNING id::text`,
      mid, from, to, gross, agg.member_count, agg.txn_count, createdBy);

    return created(res, {
      settlement_id: rows[0].id, status: 'queued',
      gross_kobo: Number(gross), gross_major: Number(gross) / 100,
      member_count: agg.member_count, txn_count: agg.txn_count,
    }, 'Settlement queued — ops team will process the payout.');
  } catch (e) { next(e); }
});

// CSV export of dept ledger (credits only, for the merchant to reconcile).
router.get('/export', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const from = req.query.from || null;
    const to   = req.query.to   || null;
    let sql = `SELECT l.created_at, l.reference, l.direction, l.amount,
                      d.name AS department, l.note, l.member_id::text
                 FROM mw_dept_ledger l
                 LEFT JOIN inv_departments d ON d.id = l.department_id
                WHERE l.merchant_id=$1::uuid`;
    const vals = [mid];
    if (from) { sql += ` AND l.created_at >= $${vals.length+1}::date`; vals.push(from); }
    if (to)   { sql += ` AND l.created_at < ($${vals.length+1}::date + interval '1 day')`; vals.push(to); }
    sql += ` ORDER BY l.created_at DESC LIMIT 5000`;
    const rows = await prisma.$queryRawUnsafe(sql, ...vals);

    const header = 'Date,Reference,Direction,Amount (kobo),Amount (₦),Department,Note,Member ID\n';
    const body = rows.map((r) => [
      new Date(r.created_at).toISOString(), r.reference, r.direction, r.amount,
      (Number(r.amount)/100).toFixed(2), `"${(r.department||'').replace(/"/g,'""')}"`,
      `"${(r.note||'').replace(/"/g,'""')}"`, r.member_id,
    ].join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="dept-ledger.csv"');
    return res.send(header + body);
  } catch (e) { next(e); }
});

module.exports = router;
