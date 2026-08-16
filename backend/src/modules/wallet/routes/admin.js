'use strict';
// Super-Admin: approve/reject merchant wallet enablement. The wallet holds customer
// funds, so SA reviews and flips it on (merchants can only REQUEST it).
const router = require('express').Router();
const { requireAuth } = require('../../../middleware/auth');
const { prisma } = require('../_shared');
const { ok, fail } = require('../../../utils/helpers');

const saOnly = (req, res, next) => {
  const role = req.user && req.user.role;
  if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') return fail(res, 'Super Admin only', 'FORBIDDEN', 403);
  next();
};
router.use(requireAuth, saOnly);

// Pending wallet enablement requests.
router.get('/requests', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT c.merchant_id::text AS merchant_id, m.business_name, c.requested_at, c.enabled
         FROM mw_config c JOIN merchants m ON m.id = c.merchant_id
        WHERE c.requested = true AND c.enabled = false ORDER BY c.requested_at ASC`);
    return ok(res, rows);
  } catch (e) { next(e); }
});

router.post('/:merchantId/approve', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO mw_config (merchant_id, enabled, requested, approved_by, approved_at)
         VALUES ($1::uuid, true, true, $2::uuid, now())
       ON CONFLICT (merchant_id) DO UPDATE SET enabled = true, approved_by = $2::uuid, approved_at = now(), updated_at = now()
       RETURNING merchant_id::text`, req.params.merchantId, req.user.id);
    return ok(res, { merchant_id: rows[0].merchant_id, enabled: true }, 'Wallet enabled for merchant');
  } catch (e) { next(e); }
});

router.post('/:merchantId/reject', async (req, res, next) => {
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE mw_config SET requested = false, updated_at = now() WHERE merchant_id = $1::uuid`, req.params.merchantId);
    return ok(res, { merchant_id: req.params.merchantId }, 'Wallet request rejected');
  } catch (e) { next(e); }
});

// ── Settlement processing (SA/ops) ─────────────────────────────────────────
// List all queued + processing settlements across all merchants.
router.get('/settlements', async (req, res, next) => {
  try {
    const status = req.query.status || null;
    let sql = `SELECT s.id::text, s.merchant_id::text, m.business_name,
                      s.period_from, s.period_to, s.gross_kobo::text AS gross_kobo,
                      s.member_count, s.txn_count, s.status, s.payout_ref,
                      s.failure_reason, s.settled_at, s.created_at,
                      m.settlement_account, m.settlement_bank, m.settlement_account_name
                 FROM mw_dept_settlements s
                 JOIN merchants m ON m.id = s.merchant_id`;
    const vals = [];
    if (status) { sql += ` WHERE s.status = $1`; vals.push(status); }
    sql += ` ORDER BY s.created_at DESC LIMIT 200`;
    const rows = await prisma.$queryRawUnsafe(sql, ...vals);
    const n = (v) => Number(v || 0);
    return ok(res, rows.map((r) => ({ ...r, gross_kobo: n(r.gross_kobo) })));
  } catch (e) { next(e); }
});

// Mark a settlement as processing or settled.
// Body: { status: 'processing'|'settled'|'failed', payout_ref?: string, failure_reason?: string }
router.patch('/settlements/:id', async (req, res, next) => {
  try {
    const { status, payout_ref, failure_reason } = req.body || {};
    if (!['processing', 'settled', 'failed'].includes(status))
      return fail(res, 'status must be processing, settled, or failed');

    const settled_at = status === 'settled' ? 'NOW()' : 'NULL';
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE mw_dept_settlements
          SET status = $1,
              payout_ref = COALESCE($2, payout_ref),
              failure_reason = COALESCE($3, failure_reason),
              settled_at = CASE WHEN $1 = 'settled' THEN NOW() ELSE settled_at END
        WHERE id = $4::uuid
          AND status IN ('queued','processing')
        RETURNING id::text, status, payout_ref, settled_at`,
      status, payout_ref || null, failure_reason || null, req.params.id);

    if (!rows.length) return fail(res, 'Settlement not found or already in a terminal state', 'NOT_FOUND', 404);
    return ok(res, rows[0], `Settlement marked ${status}`);
  } catch (e) { next(e); }
});

module.exports = router;
