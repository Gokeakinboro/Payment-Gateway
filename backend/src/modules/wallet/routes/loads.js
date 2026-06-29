'use strict';
// Maker-checker loads/debits + admin refund/withdraw.
//   Maker (department sub-user) initiates a load/debit  -> pending request.
//   Any admin (owner JWT / API key) approves or rejects  -> ledger applied.
//   Admin refund/withdraw is a direct admin action (full rights).
const router = require('express').Router();
const { prisma, tenantAuth, requireWalletEnabled, getConfig } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');
const ledger = require('../services/ledger');

router.use(tenantAuth, requireWalletEnabled);

const isAdmin = (req) => !req.walletTenant.isDeptUser; // owner JWT or API key
function handle(res, e, next) { if (e && e.name === 'WalletError') return fail(res, e.message, e.code, e.status); next(e); }

// Maker creates a load/debit request (flagged for admin approval).
// POST /requests  body: { wallet_id, type: 'load'|'debit', amount, reason? }
router.post('/requests', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 1) return fail(res, 'A valid amount (kobo) is required');
    const type = req.body.type === 'debit' ? 'debit' : 'load';
    const direction = type === 'load' ? 'credit' : 'debit';
    const w = await prisma.$queryRawUnsafe(`SELECT id::text, member_id::text AS member_id FROM wallets WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.body.wallet_id, mid);
    if (!w.length) return notFound(res, 'Wallet');
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO wallet_load_requests (merchant_id, wallet_id, member_id, direction, type, amount, reason, maker_id)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8) RETURNING id::text`,
      mid, w[0].id, w[0].member_id, direction, type, BigInt(amount),
      req.body.reason ? String(req.body.reason).slice(0, 300) : null, req.walletTenant.userId || null);
    return created(res, { id: rows[0].id, status: 'pending' }, 'Load request submitted for admin approval');
  } catch (e) { next(e); }
});

// List requests (?status=pending).
router.get('/requests', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const status = String(req.query.status || '').trim();
    let sql = `SELECT r.id::text, r.type, r.direction, r.amount::text AS amount, r.reason, r.status,
                      r.created_at, r.decided_at, m.name AS member_name, r.wallet_id::text AS wallet_id
                 FROM wallet_load_requests r JOIN wallet_members m ON m.id = r.member_id
                WHERE r.merchant_id = $1::uuid`;
    const vals = [mid];
    if (status) { sql += ` AND r.status = $2`; vals.push(status); }
    sql += ` ORDER BY r.created_at DESC LIMIT 500`;
    const rows = await prisma.$queryRawUnsafe(sql, ...vals);
    return ok(res, rows.map((r) => ({ ...r, amount: Number(r.amount) })));
  } catch (e) { next(e); }
});

// Admin approves -> applies the ledger move.
router.post('/requests/:id/approve', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return fail(res, 'Only a merchant admin can approve loads', 'FORBIDDEN', 403);
    const mid = req.walletTenant.merchantId;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, wallet_id::text AS wallet_id, direction, type, amount::text AS amount, status
         FROM wallet_load_requests WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.params.id, mid);
    if (!rows.length) return notFound(res, 'Load request');
    const r = rows[0];
    if (r.status !== 'pending') return fail(res, 'This request is already ' + r.status, 'NOT_PENDING', 409);
    const cfg = await getConfig(mid);
    const move = await ledger[r.direction === 'credit' ? 'credit' : 'debit']({
      walletId: r.wallet_id, amount: r.amount, type: r.type,
      maxBalance: r.direction === 'credit' ? cfg.max_balance : null,
      approvedBy: req.walletTenant.userId, note: `Approved ${r.type}`,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE wallet_load_requests SET status='approved', checker_id=$1, ledger_id=$2::uuid, decided_at=now() WHERE id=$3::uuid`,
      req.walletTenant.userId || null, move.ledgerId, r.id);
    return ok(res, { id: r.id, status: 'approved', wallet_balance: Number(move.balanceAfter) }, 'Load approved');
  } catch (e) { handle(res, e, next); }
});

router.post('/requests/:id/reject', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return fail(res, 'Only a merchant admin can reject loads', 'FORBIDDEN', 403);
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE wallet_load_requests SET status='rejected', checker_id=$1, decided_at=now()
        WHERE id=$2::uuid AND merchant_id=$3::uuid AND status='pending' RETURNING id::text`,
      req.walletTenant.userId || null, req.params.id, req.walletTenant.merchantId);
    if (!rows.length) return fail(res, 'Request not found or not pending', 'NOT_PENDING', 404);
    return ok(res, { id: rows[0].id, status: 'rejected' }, 'Load rejected');
  } catch (e) { next(e); }
});

// Admin direct refund/withdraw (debit) — full rights, no maker-checker.
// POST /:walletId/refund  body: { amount, reason? }
router.post('/:walletId/refund', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return fail(res, 'Only a merchant admin can refund/withdraw', 'FORBIDDEN', 403);
    const mid = req.walletTenant.merchantId;
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 1) return fail(res, 'A valid amount (kobo) is required');
    const w = await prisma.$queryRawUnsafe(`SELECT id::text FROM wallets WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.params.walletId, mid);
    if (!w.length) return notFound(res, 'Wallet');
    const move = await ledger.debit({
      walletId: req.params.walletId, amount, type: 'refund',
      approvedBy: req.walletTenant.userId, note: req.body.reason ? String(req.body.reason).slice(0, 200) : 'Admin refund/withdrawal',
    });
    return ok(res, { reference: move.reference, wallet_balance: Number(move.balanceAfter) }, 'Refund/withdrawal complete');
  } catch (e) { handle(res, e, next); }
});

module.exports = router;
