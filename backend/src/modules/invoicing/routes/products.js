'use strict';
// Reusable product/service catalogue for invoice line items. Amounts in kobo.
const router = require('express').Router();
const { prisma, tenantAuth } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');

router.use(tenantAuth);

const COLS = `id::text, name, default_amount::text AS default_amount, description, created_at`;
const shape = (r) => ({ ...r, default_amount: r.default_amount === null ? null : Number(r.default_amount) });

router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${COLS} FROM inv_products WHERE merchant_id = $1::uuid ORDER BY created_at DESC`, req.invTenant.merchantId);
    return ok(res, rows.map(shape));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return fail(res, 'Product/service name is required');
    let amount = null;
    if (req.body.default_amount !== undefined && req.body.default_amount !== null && String(req.body.default_amount) !== '') {
      amount = parseInt(req.body.default_amount, 10);
      if (!Number.isInteger(amount) || amount < 0) return fail(res, 'default_amount must be a whole number in kobo');
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO inv_products (merchant_id, name, default_amount, description)
       VALUES ($1::uuid,$2,$3,$4) RETURNING ${COLS}`,
      req.invTenant.merchantId, name, amount === null ? null : BigInt(amount), req.body.description ? String(req.body.description).slice(0, 500) : null);
    return created(res, shape(rows[0]), 'Product saved');
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `DELETE FROM inv_products WHERE id=$1::uuid AND merchant_id=$2::uuid RETURNING id::text`, req.params.id, req.invTenant.merchantId);
    if (!rows.length) return notFound(res, 'Product');
    return ok(res, { id: rows[0].id }, 'Product deleted');
  } catch (e) { next(e); }
});

module.exports = router;
