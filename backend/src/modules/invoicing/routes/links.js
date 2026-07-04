'use strict';
// Itemized payment links. Invoicing builds them from the per-department catalog +
// service charge (its domain), then creates the CORE payment_links row via core's
// createPaymentLink hook — invoicing never touches payment_links directly, keeping the
// boundary clean (see docs/DATA-OWNERSHIP.md). Simple (non-itemized) links stay on the
// core /api/v1/payment-links route.
const router = require('express').Router();
const { prisma, tenantAuth, computeInvoiceMoney } = require('../_shared');
const { ok, fail, created } = require('../../../utils/helpers');
const { createPaymentLink } = require('../../../routes/paymentLinks');

router.use(tenantAuth);

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

module.exports = router;
