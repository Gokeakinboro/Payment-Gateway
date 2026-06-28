'use strict';
// Merchant invoice format / branding + the dashboard VAT default toggle.
const router = require('express').Router();
const { prisma, tenantAuth } = require('../_shared');
const { ok } = require('../../../utils/helpers');

router.use(tenantAuth);

const COLS = `id::text, logo_url, address, business_email, business_phone, layout,
              allow_part_payment_default, charge_vat_default, updated_at`;

// Get the merchant's format (returns sensible defaults if not yet set).
router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${COLS} FROM inv_formats WHERE merchant_id = $1::uuid`, req.invTenant.merchantId);
    return ok(res, rows[0] || {
      layout: 'classic', allow_part_payment_default: false, charge_vat_default: false,
    });
  } catch (e) { next(e); }
});

// Upsert the format (one per merchant).
router.put('/', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const b = req.body || {};
    const layout = ['classic', 'modern', 'minimal', 'receipt'].includes(b.layout) ? b.layout : 'classic';
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO inv_formats (merchant_id, logo_url, address, business_email, business_phone, layout, allow_part_payment_default, charge_vat_default)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (merchant_id) DO UPDATE SET
         logo_url=EXCLUDED.logo_url, address=EXCLUDED.address, business_email=EXCLUDED.business_email,
         business_phone=EXCLUDED.business_phone, layout=EXCLUDED.layout,
         allow_part_payment_default=EXCLUDED.allow_part_payment_default,
         charge_vat_default=EXCLUDED.charge_vat_default, updated_at=now()
       RETURNING ${COLS}`,
      mid, b.logo_url || null, b.address || null, b.business_email || null, b.business_phone || null,
      layout, !!b.allow_part_payment_default, !!b.charge_vat_default);
    return ok(res, rows[0], 'Invoice format saved');
  } catch (e) { next(e); }
});

module.exports = router;
