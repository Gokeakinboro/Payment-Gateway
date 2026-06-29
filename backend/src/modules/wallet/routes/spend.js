'use strict';
// Closed-loop spend: a member pays a department from their wallet (wallet debit →
// department subsidiary ledger credit). Plus admin transfer between departments.
const router = require('express').Router();
const { prisma, tenantAuth, requireWalletEnabled } = require('../_shared');
const { ok, fail, notFound } = require('../../../utils/helpers');
const ledger = require('../services/ledger');

router.use(tenantAuth, requireWalletEnabled);

function handle(res, e, next) {
  if (e && e.name === 'WalletError') return fail(res, e.message, e.code, e.status);
  next(e);
}

// POST /:walletId/spend  body: { department_id, amount, note? }
router.post('/:walletId/spend', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 1) return fail(res, 'A valid amount (kobo) is required');
    const deptId = req.body.department_id;
    if (!deptId) return fail(res, 'department_id is required');

    const w = await prisma.$queryRawUnsafe(`SELECT id::text FROM wallets WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.params.walletId, mid);
    if (!w.length) return notFound(res, 'Wallet');
    const d = await prisma.$queryRawUnsafe(`SELECT id::text FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid`, deptId, mid);
    if (!d.length) return fail(res, 'Invalid department');

    const r = await ledger.spendToDepartment({
      walletId: req.params.walletId, departmentId: deptId, amount,
      createdBy: req.walletTenant.userId, note: req.body.note ? String(req.body.note).slice(0, 200) : null,
    });
    return ok(res, { reference: r.reference, wallet_balance: Number(r.balanceAfter), department_balance: Number(r.departmentBalanceAfter) }, 'Payment successful');
  } catch (e) { handle(res, e, next); }
});

// POST /transfer  body: { from_department_id, to_department_id, amount } — admin only.
router.post('/transfer', async (req, res, next) => {
  try {
    if (req.walletTenant.isDeptUser) return fail(res, 'Only a merchant admin can move money between departments', 'FORBIDDEN', 403);
    const mid = req.walletTenant.merchantId;
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 1) return fail(res, 'A valid amount (kobo) is required');
    const { from_department_id: from, to_department_id: to } = req.body;
    if (!from || !to) return fail(res, 'from_department_id and to_department_id are required');
    const d = await prisma.$queryRawUnsafe(`SELECT id::text FROM inv_departments WHERE id = ANY($1::uuid[]) AND merchant_id=$2::uuid`, [from, to], mid);
    if (d.length < 2) return fail(res, 'Invalid department(s)');
    const r = await ledger.transferDepartments({ merchantId: mid, fromDepartmentId: from, toDepartmentId: to, amount });
    return ok(res, { reference: r.reference }, 'Transfer complete');
  } catch (e) { handle(res, e, next); }
});

module.exports = router;
