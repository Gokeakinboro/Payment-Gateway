'use strict';
// Maker-checker for merchant wallet credits and merchant-to-merchant wallet
// moves. OPERATIONS staff can only ever CREATE a wallet_action_requests row
// (status='pending') — nothing here moves money until a SUPER_ADMIN or ADMIN
// approves it. This is the structural enforcement of the standing rule that
// refunds/wallet credits/moves are never auto-executed.
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { prisma } = require('../../../utils/db');
const { requireAuth, requireRole, requireAdmin } = require('../../../middleware/auth');
const { ok, fail, notFound, koboToNaira } = require('../../../utils/helpers');
const { logAudit } = require('../../../services/auditService');
const { notifyApprovers } = require('../../../services/approvalNotify');

const requireOperations = requireRole('OPERATIONS');

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ status: false, message: e.array()[0].msg, error_code: 'VALIDATION_ERROR' });
  next();
};

// ── POST / — OPERATIONS initiates a CREDIT or MOVE request (maker) ───────────
// type='CREDIT': credit merchant_id by amount on rail_id.
// type='MOVE':   debit merchant_id, credit dest_merchant_id, both on rail_id.
router.post('/', requireAuth, requireOperations,
  validate([
    body('type').isIn(['CREDIT', 'MOVE']).withMessage('type must be CREDIT or MOVE'),
    body('merchant_id').notEmpty().withMessage('merchant_id required'),
    body('rail_id').notEmpty().withMessage('rail_id required'),
    body('amount').isInt({ min: 1 }).withMessage('amount in kobo required'),
    body('dest_merchant_id').optional({ nullable: true }).isString(),
    body('note').optional({ nullable: true }).isString(),
    body('reference').optional({ nullable: true }).isString(),
  ]),
  async (req, res, next) => {
    try {
      const { type, merchant_id, dest_merchant_id, rail_id, amount, note, reference } = req.body;

      if (type === 'MOVE') {
        if (!dest_merchant_id) return fail(res, 'dest_merchant_id required for a MOVE request');
        if (dest_merchant_id === merchant_id) return fail(res, 'Source and destination merchant must differ');
      }

      const merchant = await prisma.merchant.findUnique({ where: { id: merchant_id }, select: { id: true, businessName: true } });
      if (!merchant) return notFound(res, 'Source merchant');
      let destMerchant = null;
      if (type === 'MOVE') {
        destMerchant = await prisma.merchant.findUnique({ where: { id: dest_merchant_id }, select: { id: true, businessName: true } });
        if (!destMerchant) return notFound(res, 'Destination merchant');
      }
      const rail = await prisma.paymentRail.findUnique({ where: { id: rail_id }, select: { id: true, name: true } });
      if (!rail) return notFound(res, 'Rail');

      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO wallet_action_requests
           (type, merchant_id, dest_merchant_id, rail_id, amount, reference, note, requested_by)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid)
         RETURNING id, created_at`,
        type, merchant_id, dest_merchant_id || null, rail_id, amount, reference || null, note || null, req.user.id,
      );
      const requestId = rows[0].id;

      await logAudit(req.user.id, 'WALLET_ACTION_REQUESTED', 'wallet_action_requests', requestId,
        {}, { type, merchant_id, dest_merchant_id, rail_id, amount },
        `${type} request: ₦${koboToNaira(BigInt(amount)).toLocaleString()} on ${rail.name} — ${merchant.businessName}${destMerchant ? ' → ' + destMerchant.businessName : ''}`);

      notifyApprovers({
        subject: `Pending approval: ${type} wallet request — ${merchant.businessName}`,
        summaryHtml: `Operations staff requested a <b>${type}</b> of <b>₦${koboToNaira(BigInt(amount)).toLocaleString()}</b> on <b>${rail.name}</b> for <b>${merchant.businessName}</b>${destMerchant ? ` → <b>${destMerchant.businessName}</b>` : ''}.${note ? `<br>Note: ${note}` : ''}`,
        actionUrl: `${process.env.DASHBOARD_URL || 'https://paylodeservices.com/dashboard.html'}#wallet-approvals`,
      });

      return ok(res, { id: requestId, status: 'pending' }, 'Request submitted for approval');
    } catch (e) { next(e); }
  });

// ── GET /pending — SUPER_ADMIN/ADMIN review queue (checker) ──────────────────
router.get('/pending', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT war.id, war.type, war.amount::text, war.reference, war.note, war.status,
             war.requested_at,
             m.business_name  AS merchant_name, m.id::text AS merchant_id,
             dm.business_name AS dest_merchant_name, dm.id::text AS dest_merchant_id,
             pr.name AS rail_name,
             u.first_name AS requested_by_first, u.last_name AS requested_by_last, u.email AS requested_by_email
      FROM wallet_action_requests war
      JOIN merchants m       ON m.id = war.merchant_id
      LEFT JOIN merchants dm ON dm.id = war.dest_merchant_id
      LEFT JOIN payment_rails pr ON pr.id = war.rail_id
      JOIN users u           ON u.id = war.requested_by
      WHERE war.status = 'pending'
      ORDER BY war.requested_at ASC`);
    return ok(res, rows.map(r => ({
      id: r.id, type: r.type, amount: Number(r.amount), amount_naira: koboToNaira(BigInt(r.amount)),
      reference: r.reference, note: r.note, status: r.status, requested_at: r.requested_at,
      merchant: { id: r.merchant_id, name: r.merchant_name },
      dest_merchant: r.dest_merchant_id ? { id: r.dest_merchant_id, name: r.dest_merchant_name } : null,
      rail_name: r.rail_name,
      requested_by: { name: `${r.requested_by_first} ${r.requested_by_last}`, email: r.requested_by_email },
    })));
  } catch (e) { next(e); }
});

// ── GET /wallet/:merchantId — OPERATIONS: read-only per-rail balance lookup ──
// "Run queries on specific wallets" — view only, no fund controls here.
router.get('/wallet/:merchantId', requireAuth, requireOperations, async (req, res, next) => {
  try {
    const merchant = await prisma.merchant.findUnique({
      where: { id: req.params.merchantId },
      select: { id: true, businessName: true, merchantCode: true },
    });
    if (!merchant) return notFound(res, 'Merchant');
    const wallets = await prisma.merchantWallet.findMany({
      where: { merchantId: merchant.id },
      include: { rail: { select: { name: true } } },
    });
    return ok(res, {
      merchant: { id: merchant.id, name: merchant.businessName, code: merchant.merchantCode },
      rails: wallets.map(w => ({
        rail_id: w.railId, rail_name: w.rail?.name || '—',
        balance: Number(w.balance), balance_naira: koboToNaira(w.balance),
      })),
      total_naira: koboToNaira(wallets.reduce((s, w) => s + w.balance, 0n)),
    });
  } catch (e) { next(e); }
});

// ── GET /mine — OPERATIONS staff's own request history (any status) ──────────
router.get('/mine', requireAuth, requireOperations, async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT war.id, war.type, war.amount::text, war.reference, war.note, war.status,
             war.requested_at, war.decided_at, war.decision_note,
             m.business_name AS merchant_name, dm.business_name AS dest_merchant_name,
             pr.name AS rail_name
      FROM wallet_action_requests war
      JOIN merchants m       ON m.id = war.merchant_id
      LEFT JOIN merchants dm ON dm.id = war.dest_merchant_id
      LEFT JOIN payment_rails pr ON pr.id = war.rail_id
      WHERE war.requested_by = $1::uuid
      ORDER BY war.requested_at DESC LIMIT 200`, req.user.id);
    return ok(res, rows.map(r => ({
      id: r.id, type: r.type, amount: Number(r.amount), amount_naira: koboToNaira(BigInt(r.amount)),
      reference: r.reference, note: r.note, status: r.status,
      requested_at: r.requested_at, decided_at: r.decided_at, decision_note: r.decision_note,
      merchant_name: r.merchant_name, dest_merchant_name: r.dest_merchant_name, rail_name: r.rail_name,
    })));
  } catch (e) { next(e); }
});

// ── POST /:id/approve — SUPER_ADMIN/ADMIN executes the request (checker) ────
router.post('/:id/approve', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, type, merchant_id, dest_merchant_id, rail_id, amount, reference, status
         FROM wallet_action_requests WHERE id = $1::uuid`, req.params.id);
    const request = rows[0];
    if (!request) return notFound(res, 'Wallet action request');
    if (request.status !== 'pending') return fail(res, `Request already ${request.status}`);

    const amt = BigInt(request.amount);
    const reference = request.reference || `WACT-${String(request.id).slice(0, 8).toUpperCase()}`;

    const result = await prisma.$transaction(async (tx) => {
      async function creditRail(merchantId, delta, entryType, description) {
        let w = await tx.merchantWallet.findFirst({ where: { merchantId, railId: request.rail_id } });
        const before = w ? w.balance : 0n;
        const after = before + delta;
        if (after < 0n) throw Object.assign(new Error('Move would take the source merchant negative on this rail'), { _client: true });
        if (!w) {
          w = await tx.merchantWallet.create({ data: { merchantId, railId: request.rail_id, balance: after, lastFundedAt: delta > 0n ? new Date() : null, fundedBy: req.user.id } });
        } else {
          w = await tx.merchantWallet.update({ where: { id: w.id }, data: { balance: after, ...(delta > 0n ? { lastFundedAt: new Date(), fundedBy: req.user.id } : {}) } });
        }
        await tx.walletLedger.create({ data: {
          merchantId, railId: request.rail_id, entryType, amount: delta > 0n ? delta : -delta,
          balanceBefore: before, balanceAfter: after, reference, description, createdBy: req.user.id,
        }});
        return after;
      }

      if (request.type === 'CREDIT') {
        const after = await creditRail(request.merchant_id, amt, 'CREDIT', `Wallet action approval — ${reference}`);
        return { merchant_new_balance: after };
      }

      // MOVE: debit source, credit destination — same rail, one transaction.
      const sourceAfter = await creditRail(request.merchant_id, -amt, 'DEBIT', `Wallet move (approved) — to ${request.dest_merchant_id} — ${reference}`);
      const destAfter = await creditRail(request.dest_merchant_id, amt, 'CREDIT', `Wallet move (approved) — from ${request.merchant_id} — ${reference}`);
      return { merchant_new_balance: sourceAfter, dest_merchant_new_balance: destAfter };
    });

    await prisma.$executeRawUnsafe(
      `UPDATE wallet_action_requests SET status='approved', decided_by=$1::uuid, decided_at=NOW(), updated_at=NOW() WHERE id=$2::uuid`,
      req.user.id, request.id);

    await logAudit(req.user.id, 'WALLET_ACTION_APPROVED', 'wallet_action_requests', request.id,
      {}, result, `Approved ${request.type} of ₦${koboToNaira(amt).toLocaleString()} — Ref: ${reference}`);

    return ok(res, { id: request.id, status: 'approved', ...result }, 'Wallet action approved and executed');
  } catch (e) {
    if (e && e._client) return fail(res, e.message);
    next(e);
  }
});

// ── POST /:id/reject — SUPER_ADMIN/ADMIN declines the request (checker) ─────
router.post('/:id/reject', requireAuth, requireAdmin,
  validate([ body('decision_note').optional({ nullable: true }).isString() ]),
  async (req, res, next) => {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, status FROM wallet_action_requests WHERE id = $1::uuid`, req.params.id);
      const request = rows[0];
      if (!request) return notFound(res, 'Wallet action request');
      if (request.status !== 'pending') return fail(res, `Request already ${request.status}`);

      await prisma.$executeRawUnsafe(
        `UPDATE wallet_action_requests
            SET status='rejected', decided_by=$1::uuid, decided_at=NOW(), decision_note=$2, updated_at=NOW()
          WHERE id=$3::uuid`,
        req.user.id, req.body.decision_note || null, request.id);

      await logAudit(req.user.id, 'WALLET_ACTION_REJECTED', 'wallet_action_requests', request.id,
        {}, { decision_note: req.body.decision_note || null }, 'Wallet action request rejected');

      return ok(res, { id: request.id, status: 'rejected' }, 'Wallet action request rejected');
    } catch (e) { next(e); }
  });

module.exports = router;
