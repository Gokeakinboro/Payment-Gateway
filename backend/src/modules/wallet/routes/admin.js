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

module.exports = router;
