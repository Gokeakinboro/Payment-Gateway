'use strict';
// QR Scan & Pay — Fixed / Open amount codes, downloadable (PNG/SVG) + shareable link.
const router = require('express').Router();
const { prisma, tenantAuth, randToken, escapeHtml, koboToNairaStr, isValidEmail } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');
const { renderQr, qrPayUrl } = require('../services/qrService');
const { sendEmail } = require('../../../services/emailService');

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
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
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

// Share a saved QR by email via SMTP (branded, QR image inline). WhatsApp sharing
// stays a client-side wa.me deep link on the dashboard.
router.post('/:id/share', async (req, res, next) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!isValidEmail(email)) return fail(res, 'A valid recipient email is required');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT q.access_token, q.label, q.amount::text AS amount, m.business_name
         FROM inv_qr_codes q JOIN merchants m ON m.id = q.merchant_id
        WHERE q.id = $1::uuid AND q.merchant_id = $2::uuid`,
      req.params.id, req.invTenant.merchantId);
    if (!rows.length) return notFound(res, 'QR code');
    const r = rows[0];
    const bizName = r.business_name || 'A merchant';
    const payUrl = qrPayUrl(r.access_token);
    const img = await renderQr(r.access_token);
    const png = img.pngDataUrl.split(',')[1];
    const amtLine = r.amount === null
      ? 'You can enter the amount when you pay.'
      : `Amount: &#8358;${koboToNairaStr(r.amount)}`;
    const label = r.label ? escapeHtml(r.label) : 'Payment';
    const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;color:#1a1a1a">
      <p><strong>${escapeHtml(bizName)}</strong> has sent you a QR code to pay.</p>
      <p style="margin:14px 0;font-size:15px"><strong>${label}</strong></p>
      <p style="font-size:14px">${amtLine}</p>
      <div style="text-align:center;margin:16px 0"><img src="cid:paylodeqr" alt="Scan to pay" style="width:220px;height:220px"></div>
      <p style="text-align:center"><a href="${payUrl}" style="background:#16a34a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Pay now</a></p>
      <p style="font-size:12px;color:#666;margin-top:12px">Or open: ${escapeHtml(payUrl)}</p>
      <p style="font-size:11px;color:#999;margin-top:18px">Powered by Paylode</p></div>`;
    const info = await sendEmail({
      to: email,
      subject: `${bizName} — scan to pay${r.label ? ` (${r.label})` : ''}`.slice(0, 160),
      html,
      text: `${bizName} — ${r.label || 'Payment'}. ${r.amount === null ? '' : '₦' + koboToNairaStr(r.amount) + '. '}Pay: ${payUrl}`,
      attachments: [{ filename: 'paylode-qr.png', content: Buffer.from(png, 'base64'), cid: 'paylodeqr' }],
    });
    if (info && info.skipped) return fail(res, 'Email service is not configured', 'EMAIL_NOT_CONFIGURED', 503);
    return ok(res, { sent: true }, `QR code emailed to ${email}`);
  } catch (e) { next(e); }
});

module.exports = router;
