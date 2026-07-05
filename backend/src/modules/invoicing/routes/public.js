'use strict';
/**
 * Public (no-auth) recipient + QR endpoints.
 * Recipients never register: they reach invoices via the per-invoice access_token
 * (or a signed cross-invoice token), and pay through the normal hosted checkout.
 */
const router = require('express').Router();
const { prisma, CHECKOUT_BASE, computeVat, verifyRecipient } = require('../_shared');
const { ok, fail, notFound, created, koboToNaira } = require('../../../utils/helpers');
const { createCheckoutTransaction } = require('../../gateway-core/services/gatewayTxn');
const compliance = require('../../../services/complianceService');

function singleTxnLimitKobo(tier) {
  return ({ 1: 5_000_000n, 2: 100_000_000n, 3: 500_000_000n })[tier] || 5_000_000n;
}

// ── Recipient: view one invoice (marks it viewed) ─────────────────────────────
router.get('/invoice/:token', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT i.id::text, i.invoice_number, i.description, i.amount::text AS amount,
              i.vat_amount::text AS vat_amount, i.total_amount::text AS total_amount,
              i.amount_paid::text AS amount_paid, i.currency, i.status, i.allow_part_payment,
              i.due_at, i.recipient_name, i.line_items::text AS line_items,
              i.service_charge_amount::text AS service_charge_amount, d.service_charge_label,
              m.business_name, f.logo_url, f.address, f.business_email, f.business_phone, f.layout
         FROM inv_invoices i JOIN merchants m ON m.id = i.merchant_id
         LEFT JOIN inv_formats f ON f.merchant_id = i.merchant_id
         LEFT JOIN inv_departments d ON d.id = i.department_id
        WHERE i.access_token = $1 AND i.deleted_at IS NULL`, req.params.token);
    if (!rows.length) return notFound(res, 'Invoice');
    const r = rows[0];
    // First view → stamp viewed (don't downgrade a paid/part-paid status).
    prisma.$executeRawUnsafe(
      `UPDATE inv_invoices SET viewed_at = COALESCE(viewed_at, now()),
              status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END
        WHERE access_token = $1`, req.params.token).catch(() => {});
    const n = (v) => (v === null ? null : Number(v));
    return ok(res, {
      invoice_number: r.invoice_number, description: r.description,
      amount: n(r.amount), vat_amount: n(r.vat_amount), total_amount: n(r.total_amount),
      amount_paid: n(r.amount_paid), balance: n(r.total_amount) - n(r.amount_paid),
      currency: r.currency, status: r.status, allow_part_payment: r.allow_part_payment, due_at: r.due_at,
      recipient_name: r.recipient_name,
      service_charge_amount: n(r.service_charge_amount), service_charge_label: r.service_charge_label || null,
      line_items: (function () { try { return r.line_items ? JSON.parse(r.line_items) : null; } catch (e) { return null; } })(),
      merchant: { name: r.business_name, logo_url: r.logo_url, address: r.address, email: r.business_email, phone: r.business_phone },
      layout: r.layout || 'classic',
    });
  } catch (e) { next(e); }
});

// ── Recipient: pay an invoice (mints a PENDING transaction) ───────────────────
router.post('/invoice/:token/pay', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, merchant_id::text AS merchant_id, invoice_number, currency, status,
              total_amount::text AS total_amount, amount_paid::text AS amount_paid,
              allow_part_payment, charge_vat
         FROM inv_invoices WHERE access_token = $1`, req.params.token);
    if (!rows.length) return notFound(res, 'Invoice');
    const inv = rows[0];
    if (inv.status === 'paid') return fail(res, 'This invoice is already paid', 'ALREADY_PAID', 409);
    if (inv.status === 'cancelled') return fail(res, 'This invoice was cancelled', 'CANCELLED', 410);

    const balance = Number(inv.total_amount) - Number(inv.amount_paid);
    if (balance <= 0) return fail(res, 'Nothing left to pay on this invoice', 'NO_BALANCE', 409);

    let amount = balance;
    if (inv.allow_part_payment && req.body.amount !== undefined && req.body.amount !== null && String(req.body.amount) !== '') {
      amount = parseInt(req.body.amount, 10);
      if (!Number.isInteger(amount) || amount < 100) return fail(res, 'Enter a valid amount in kobo (≥ 100)');
      if (amount > balance) return fail(res, 'Amount exceeds the outstanding balance');
    }

    const email = String(req.body.email || '').trim().toLowerCase();
    if (email && !email.includes('@')) return fail(res, 'Enter a valid email or leave it blank');

    const merchant = await prisma.merchant.findUnique({ where: { id: inv.merchant_id }, include: { aggregator: true } });
    if (!merchant || !merchant.isActive) return fail(res, 'This merchant cannot currently accept payments', 'MERCHANT_INACTIVE', 403);

    const gate = compliance.screenTransaction(merchant, { customerEmail: email || undefined });
    if (gate.decision === 'REJECT') return fail(res, gate.message, gate.reasonCode, 403);
    if (inv.currency === 'NGN' && BigInt(amount) > singleTxnLimitKobo(merchant.kycTier))
      return fail(res, 'Amount exceeds the merchant\'s per-transaction limit', 'KYC_LIMIT_EXCEEDED');

    const { reference, redirectUrl } = await createCheckoutTransaction({
      merchantId: merchant.id, amount, currency: inv.currency, customerEmail: email, refPrefix: 'TXNINV',
      source: 'invoice', metadata: { description: `Invoice ${inv.invoice_number}`, invoice_id: inv.id },
    });
    return created(res, { reference, redirect_url: redirectUrl }, 'Transaction created');
  } catch (e) { next(e); }
});

// ── Recipient: cross-invoice history via signed token (no login) ───────────────
router.get('/recipient/:token', async (req, res, next) => {
  try {
    const email = verifyRecipient(req.params.token);
    if (!email) return fail(res, 'Invalid or expired link', 'BAD_TOKEN', 401);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT i.invoice_number, i.description, i.total_amount::text AS total_amount,
              i.amount_paid::text AS amount_paid, i.currency, i.status, i.due_at, i.access_token,
              m.business_name
         FROM inv_invoices i JOIN merchants m ON m.id = i.merchant_id
        WHERE lower(i.recipient_email) = $1 ORDER BY i.created_at DESC LIMIT 500`, email);
    const n = (v) => (v === null ? null : Number(v));
    return ok(res, { email, invoices: rows.map((r) => ({
      invoice_number: r.invoice_number, merchant: r.business_name, description: r.description,
      total_amount: n(r.total_amount), amount_paid: n(r.amount_paid), currency: r.currency,
      status: r.status, due_at: r.due_at, view_url: `${CHECKOUT_BASE}/invoice.html?t=${r.access_token}`,
    })) });
  } catch (e) { next(e); }
});

// ── QR: scan landing details ──────────────────────────────────────────────────
router.get('/qr/:token', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT q.id::text, q.type, q.amount::text AS amount, q.charge_vat, q.is_active, q.label,
              m.business_name, f.logo_url
         FROM inv_qr_codes q JOIN merchants m ON m.id = q.merchant_id
         LEFT JOIN inv_formats f ON f.merchant_id = q.merchant_id
        WHERE q.access_token = $1`, req.params.token);
    if (!rows.length) return notFound(res, 'QR code');
    const r = rows[0];
    if (!r.is_active) return fail(res, 'This QR code is no longer active', 'QR_INACTIVE', 410);
    return ok(res, {
      type: r.type, amount: r.amount === null ? null : Number(r.amount), charge_vat: r.charge_vat,
      label: r.label, merchant: { name: r.business_name, logo_url: r.logo_url },
    });
  } catch (e) { next(e); }
});

// ── QR: pay (mints a PENDING transaction) ─────────────────────────────────────
router.post('/qr/:token/pay', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, merchant_id::text AS merchant_id, type, amount::text AS amount, charge_vat, is_active, label,
              service_charge_amount::text AS service_charge_amount
         FROM inv_qr_codes WHERE access_token = $1`, req.params.token);
    if (!rows.length) return notFound(res, 'QR code');
    const qr = rows[0];
    if (!qr.is_active) return fail(res, 'This QR code is no longer active', 'QR_INACTIVE', 410);

    let face;
    if (qr.type === 'fixed') face = parseInt(qr.amount, 10);
    else {
      face = parseInt(req.body.amount, 10);
      if (!Number.isInteger(face) || face < 100) return fail(res, 'Enter a valid amount in kobo (≥ 100)');
    }
    // Service charge is VAT-exempt: VAT base = face minus the (fixed-QR) service charge.
    const svc = qr.type === 'fixed' ? (Number(qr.service_charge_amount) || 0) : 0;
    const vat = Number(computeVat(face - svc, qr.charge_vat));
    const total = face + vat;

    const email = String(req.body.email || '').trim().toLowerCase();
    if (email && !email.includes('@')) return fail(res, 'Enter a valid email or leave it blank');

    const merchant = await prisma.merchant.findUnique({ where: { id: qr.merchant_id }, include: { aggregator: true } });
    if (!merchant || !merchant.isActive) return fail(res, 'This merchant cannot currently accept payments', 'MERCHANT_INACTIVE', 403);
    const gate = compliance.screenTransaction(merchant, { customerEmail: email || undefined });
    if (gate.decision === 'REJECT') return fail(res, gate.message, gate.reasonCode, 403);
    if (BigInt(total) > singleTxnLimitKobo(merchant.kycTier))
      return fail(res, 'Amount exceeds the merchant\'s per-transaction limit', 'KYC_LIMIT_EXCEEDED');

    const { reference, redirectUrl } = await createCheckoutTransaction({
      merchantId: merchant.id, amount: total, currency: 'NGN', customerEmail: email, refPrefix: 'TXNQR',
      source: 'qr', metadata: { description: qr.label ? `QR: ${qr.label}` : 'QR payment', qr_id: qr.id,
        invoice_vat: vat, buyer_note: req.body.note ? String(req.body.note).slice(0, 200) : null },
    });
    return created(res, { reference, redirect_url: redirectUrl }, 'Transaction created');
  } catch (e) { next(e); }
});

module.exports = router;
