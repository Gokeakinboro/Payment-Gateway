'use strict';
// Merchant wallet dashboard — float, members, funding/spend volumes, department
// balances, low-balance count, pending approvals, reconciliation.
const router = require('express').Router();
const { prisma, tenantAuth, requireWalletEnabled } = require('../_shared');
const { ok } = require('../../../utils/helpers');
const ledger = require('../services/ledger');

router.use(tenantAuth, requireWalletEnabled);
const n = (v) => Number(v || 0);

router.get('/summary', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const s = (await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM wallet_members WHERE merchant_id=$1::uuid) AS members,
         (SELECT COUNT(*)::int FROM wallets WHERE merchant_id=$1::uuid AND status='active') AS active_wallets,
         (SELECT COALESCE(SUM(balance),0)::text FROM wallets WHERE merchant_id=$1::uuid) AS float_total,
         (SELECT COUNT(*)::int FROM wallets w WHERE w.merchant_id=$1::uuid AND w.low_balance_threshold>0 AND w.balance < w.low_balance_threshold) AS low_balance,
         (SELECT COALESCE(SUM(amount),0)::text FROM wallet_ledger WHERE merchant_id=$1::uuid AND type='fund') AS funded_total,
         (SELECT COALESCE(SUM(amount),0)::text FROM wallet_ledger WHERE merchant_id=$1::uuid AND type='spend') AS spent_total,
         (SELECT COUNT(*)::int FROM wallet_load_requests WHERE merchant_id=$1::uuid AND status='pending') AS pending_loads`,
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
         LEFT JOIN wallet_department_ledger l ON l.department_id = d.id
        WHERE d.merchant_id=$1::uuid GROUP BY d.id, d.name ORDER BY d.name`, mid);
    return ok(res, rows.map((r) => ({ ...r, balance: n(r.balance) })));
  } catch (e) { next(e); }
});

module.exports = router;
