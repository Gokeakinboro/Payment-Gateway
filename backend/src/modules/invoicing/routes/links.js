'use strict';
// Itemized payment links. Invoicing builds them from the per-department catalog +
// service charge (its domain), then creates the CORE payment_links row via core's
// createPaymentLink hook — invoicing never touches payment_links directly, keeping the
// boundary clean (see docs/DATA-OWNERSHIP.md). Simple (non-itemized) links stay on the
// core /api/v1/payment-links route.
const router = require('express').Router();
const { prisma, tenantAuth, computeInvoiceMoney, CHECKOUT_BASE } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');
const { createPaymentLink } = require('../../../routes/paymentLinks');
const { notifyPaymentLink, isConfigured: waConfigured } = require('../../../services/whatsappService');

router.use(tenantAuth);

// List all payment links for this merchant (for the Pay Links tab in invoicing.html).
router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, slug, title, description, amount::text AS amount, currency,
              is_reusable, expires_at, is_active, created_at
         FROM payment_links WHERE merchant_id=$1::uuid ORDER BY created_at DESC LIMIT 100`,
      req.invTenant.merchantId);
    const n = (v) => (v === null || v === undefined ? null : Number(v));
    return ok(res, rows.map((r) => ({
      ...r, amount: n(r.amount),
      pay_url: `${CHECKOUT_BASE}/checkout.html?link=${r.slug}`,
    })));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const t = req.invTenant, mid = t.merchantId, b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return fail(res, 'A title (what the customer is paying for) is required');

    // Department + its service charge %.
    let departmentId = t.isDeptUser ? t.departmentId : (b.department_id || null);
    let deptPct = 0;
    if (departmentId) {
      const d = await prisma.$queryRawUnsafe(`SELECT service_charge_pct::float AS pct FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid`, departmentId, mid);
      if (!d.length) return fail(res, 'Invalid department');
      deptPct = Number(d[0].pct) || 0;
    }
    const chargeVat = !!b.charge_vat;
    const applyServiceCharge = !!b.apply_service_charge && deptPct > 0;

    if (!Array.isArray(b.items) || !b.items.length) return fail(res, 'items[] is required for an itemized payment link (max 6)');
    const money = computeInvoiceMoney({ items: b.items, serviceChargePct: deptPct, applyServiceCharge, chargeVat, maxItems: 6 });
    if (money.error) return fail(res, money.error);
    if (money.amount < 100) return fail(res, 'Link total must be at least 100 kobo');

    let expiresAt = null;
    if (b.expires_at) {
      const dd = new Date(b.expires_at);
      if (isNaN(dd.getTime()) || dd.getTime() <= Date.now()) return fail(res, 'expires_at must be a valid future date');
      expiresAt = dd;
    }

    const link = await createPaymentLink({
      merchantId: mid, title: title.slice(0, 140),
      description: b.description ? String(b.description).slice(0, 500) : null,
      amount: money.amount, currency: b.currency === 'USD' ? 'USD' : 'NGN',
      reusable: b.reusable === undefined ? true : !!b.reusable, expiresAt, chargeVat,
      customerPhone: b.customer_phone ? String(b.customer_phone).slice(0, 32) : null,
      lineItems: money.lineItems, departmentId, serviceChargeAmount: money.serviceCharge,
      applyServiceCharge, vatAmount: money.vatAmount,
    });
    return created(res, link, 'Itemized payment link created');
  } catch (e) { next(e); }
});

// Share a payment link via WhatsApp — sends paylode_payment_link template.
router.post('/:id/share-whatsapp', async (req, res, next) => {
  try {
    if (!waConfigured()) return fail(res, 'WhatsApp is not configured', 'WA_NOT_CONFIGURED', 503);
    const phone = String((req.body && req.body.phone) || '').trim();
    if (!phone) return fail(res, 'A recipient phone number is required');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT pl.id::text, pl.slug, pl.title, pl.amount::text AS amount, pl.currency,
              m.business_name, m.id::text AS merchant_id
         FROM payment_links pl JOIN merchants m ON m.id = pl.merchant_id
        WHERE pl.id=$1::uuid AND pl.merchant_id=$2::uuid`,
      req.params.id, req.invTenant.merchantId);
    if (!rows.length) return notFound(res, 'Payment link');
    const r = rows[0];
    const result = await notifyPaymentLink({
      phone,
      businessName: r.business_name,
      title: r.title,
      amount: r.amount !== null ? Number(r.amount) : null,
      currency: r.currency || 'NGN',
      payUrl: `${CHECKOUT_BASE}/checkout.html?link=${r.slug}`,
      merchantId: r.merchant_id,
    });
    if (result.skipped) return fail(res, 'WhatsApp send skipped — check template or token', 'WA_SKIPPED', 503);
    if (!result.ok) return fail(res, 'WhatsApp send failed', 'WA_SEND_FAILED', 502);
    return ok(res, { sent: true }, `Payment link shared via WhatsApp to ${phone}`);
  } catch (e) { next(e); }
});

module.exports = router;
