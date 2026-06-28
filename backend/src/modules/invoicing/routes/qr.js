'use strict';
// QR Scan & Pay — Fixed / Open amount codes, downloadable (PNG/SVG) + shareable link.
const router = require('express').Router();
const { prisma, tenantAuth, randToken } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');
const { renderQr, qrPayUrl } = require('../services/qrService');

router.use(tenantAuth);

const COLS = `id::text, qr_reference, access_token, label, type, amount::text AS amount,
              charge_vat, is_active, department_id::text AS department_id, created_at`;
const shape = (r) => ({
  id: r.id, reference: r.qr_reference, label: r.label, type: r.type,
  amount: r.amount === null ? null : Number(r.amount), charge_vat: r.charge_vat,
  is_active: r.is_active, department_id: r.department_id, created_at: r.created_at,
  pay_url: qrPayUrl(r.access_token),
  image_png: `/api/v1/invoicing/qr/${r.id}/image?format=png`,
  image_svg: `/api/v1/invoicing/qr/${r.id}/image?format=svg`,
});

function deptScoped(req) {
  return req.invTenant.isDeptUser && req.invTenant.departmentId ? req.invTenant.departmentId : null;
}

router.get('/', async (req, res, next) => {
  try {
    const dept = deptScoped(req);
    let sql = `SELECT ${COLS} FROM inv_qr_codes WHERE merchant_id=$1::uuid`;
    const vals = [req.invTenant.merchantId];
    if (dept) { sql += ` AND department_id=$2::uuid`; vals.push(dept); }
    sql += ` ORDER BY created_at DESC`;
    const rows = await prisma.$queryRawUnsafe(sql, ...vals);
    return ok(res, rows.map(shape));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const t = req.invTenant; const mid = t.merchantId; const b = req.body || {};
    const type = b.type === 'open' ? 'open' : 'fixed';
    let amount = null;
    if (type === 'fixed') {
      amount = parseInt(b.amount, 10);
      if (!Number.isInteger(amount) || amount < 100) return fail(res, 'A fixed-amount QR needs amount in kobo (≥ 100)');
    }
    let departmentId = t.isDeptUser ? t.departmentId : (b.department_id || null);
    if (departmentId && !t.isDeptUser) {
      const d = await prisma.$queryRawUnsafe(`SELECT 1 FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid`, departmentId, mid);
      if (!d.length) return fail(res, 'Invalid department');
    }
    const reference = 'QR-' + randToken(6).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const token = randToken(18);
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO inv_qr_codes (merchant_id, department_id, qr_reference, access_token, label, type, amount, charge_vat)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
      mid, departmentId, reference, token, b.label ? String(b.label).slice(0, 80) : null, type,
      amount === null ? null : BigInt(amount), !!b.charge_vat);
    return created(res, shape(rows[0]), 'QR code created');
  } catch (e) { next(e); }
});

// Downloadable image — PNG (default) or SVG.
router.get('/:id/image', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT access_token FROM inv_qr_codes WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.params.id, req.invTenant.merchantId);
    if (!rows.length) return notFound(res, 'QR code');
    const img = await renderQr(rows[0].access_token);
    if (req.query.format === 'svg') {
      res.type('image/svg+xml').set('Content-Disposition', `attachment; filename="paylode-qr-${req.params.id}.svg"`);
      return res.send(img.svg);
    }
    const b64 = img.pngDataUrl.split(',')[1];
    res.type('image/png').set('Content-Disposition', `attachment; filename="paylode-qr-${req.params.id}.png"`);
    return res.send(Buffer.from(b64, 'base64'));
  } catch (e) { next(e); }
});

// Activate / deactivate.
router.patch('/:id', async (req, res, next) => {
  try {
    if (req.body.is_active === undefined) return fail(res, 'Nothing to update');
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE inv_qr_codes SET is_active=$1, updated_at=now() WHERE id=$2::uuid AND merchant_id=$3::uuid RETURNING ${COLS}`,
      !!req.body.is_active, req.params.id, req.invTenant.merchantId);
    if (!rows.length) return notFound(res, 'QR code');
    return ok(res, shape(rows[0]), 'QR code updated');
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `DELETE FROM inv_qr_codes WHERE id=$1::uuid AND merchant_id=$2::uuid RETURNING id::text`, req.params.id, req.invTenant.merchantId);
    if (!rows.length) return notFound(res, 'QR code');
    return ok(res, { id: rows[0].id }, 'QR code deleted');
  } catch (e) { next(e); }
});

module.exports = router;
