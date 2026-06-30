'use strict';
// Member self-service (the member app/web). Authenticated as the logged-in member.
// Unifies wallet activity + invoices addressed to the member, and lets them fund,
// spend across departments, and pay invoices from their wallet balance.
const router = require('express').Router();
const { prisma, memberAuth, getConfig } = require('../_shared');
const { ok, fail, created, notFound, generateRef } = require('../../../utils/helpers');
const compliance = require('../../../services/complianceService');
const ledger = require('../services/ledger');
const { payInvoiceFromWallet } = require('../services/walletInvoice');

const CHECKOUT_BASE = (process.env.CHECKOUT_BASE_URL || 'https://paylodeservices.com').replace(/\/$/, '');
router.use(memberAuth);
const num = (v) => (v == null ? null : Number(v));
function handle(res, e, next) { if (e && e.name === 'WalletError') return fail(res, e.message, e.code, e.status); next(e); }

// Invoices addressed to this member (matched by email/phone within the merchant).
function memberInvoiceWhere(m) {
  const parts = []; const vals = [m.merchant_id]; let i = 2;
  if (m.email) { parts.push(`lower(recipient_email) = $${i++}`); vals.push(m.email.toLowerCase()); }
  if (m.phone) { parts.push(`recipient_phone = $${i++}`); vals.push(m.phone); }
  return { clause: parts.length ? `(${parts.join(' OR ')})` : 'false', vals };
}

router.get('/', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const cfg = await getConfig(m.merchant_id);
    return ok(res, {
      member: { id: m.member_id, name: m.name, email: m.email, phone: m.phone },
      wallet: { id: m.wallet_id, balance: num(m.balance), currency: m.currency, low_balance_threshold: num(m.low_balance_threshold) },
      branding: { name: cfg.brand_name || 'Wallet', logo_url: cfg.brand_logo_url || null, color: cfg.brand_color || '#1a2744' },
    });
  } catch (e) { next(e); }
});

// Departments the member can pay (spend targets).
router.get('/departments', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, name FROM inv_departments WHERE merchant_id = $1::uuid ORDER BY name`, req.walletMember.merchant_id);
    return ok(res, rows);
  } catch (e) { next(e); }
});

// Unified transaction history: wallet ledger entries + invoices to this member.
router.get('/transactions', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const led = await prisma.$queryRawUnsafe(
      `SELECT created_at, type, direction, amount::text AS amount, balance_after::text AS balance_after, reference,
              department_id::text AS department_id, note
         FROM mw_ledger WHERE wallet_id = $1::uuid ORDER BY created_at DESC LIMIT 200`, m.wallet_id);
    const iw = memberInvoiceWhere(m);
    const inv = await prisma.$queryRawUnsafe(
      `SELECT created_at, invoice_number, description, total_amount::text AS total_amount, amount_paid::text AS amount_paid,
              status, id::text AS id FROM inv_invoices WHERE merchant_id = $1::uuid AND ${iw.clause}
         ORDER BY created_at DESC LIMIT 200`, ...iw.vals);
    const feed = [
      ...led.map((l) => ({ kind: 'wallet', date: l.created_at, type: l.type, direction: l.direction,
        amount: num(l.amount), balance_after: num(l.balance_after), reference: l.reference, note: l.note })),
      ...inv.map((v) => ({ kind: 'invoice', date: v.created_at, invoice_id: v.id, invoice_number: v.invoice_number,
        description: v.description, amount: num(v.total_amount), amount_paid: num(v.amount_paid), status: v.status })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 300);
    return ok(res, feed);
  } catch (e) { next(e); }
});

// Invoices addressed to this member.
router.get('/invoices', async (req, res, next) => {
  try {
    const m = req.walletMember; const iw = memberInvoiceWhere(m);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, invoice_number, description, total_amount::text AS total_amount, amount_paid::text AS amount_paid,
              status, due_at, department_id::text AS department_id, created_at
         FROM inv_invoices WHERE merchant_id = $1::uuid AND ${iw.clause} ORDER BY created_at DESC LIMIT 200`, ...iw.vals);
    return ok(res, rows.map((r) => ({ ...r, total_amount: num(r.total_amount), amount_paid: num(r.amount_paid) })));
  } catch (e) { next(e); }
});

// Pay an invoice from the wallet (wallet can never go negative).
router.post('/invoices/:id/pay', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const r = await payInvoiceFromWallet({
      walletId: m.wallet_id, invoiceId: req.params.id, merchantId: m.merchant_id,
      amount: req.body.amount != null ? parseInt(req.body.amount, 10) : null, createdBy: req.user.id,
    });
    return ok(res, r, 'Invoice paid from wallet');
  } catch (e) { handle(res, e, next); }
});

// Fund own wallet via the hosted checkout.
router.post('/fund', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 10000) return fail(res, 'amount must be in kobo, minimum ₦100 (10000 kobo)');
    const cfg = await getConfig(m.merchant_id);
    if (BigInt(m.balance) + BigInt(amount) > cfg.max_balance)
      return fail(res, `Funding would exceed your ₦${(Number(cfg.max_balance) / 100).toLocaleString()} wallet ceiling`, 'MAX_BALANCE_EXCEEDED', 409);
    const merchant = await prisma.merchant.findUnique({ where: { id: m.merchant_id }, include: { aggregator: true } });
    if (!merchant || !merchant.isActive) return fail(res, 'This merchant cannot currently accept payments', 'MERCHANT_INACTIVE', 403);
    const gate = compliance.screenTransaction(merchant, { customerEmail: m.email || undefined });
    if (gate.decision === 'REJECT') return fail(res, gate.message, gate.reasonCode, 403);
    const ref = generateRef('WLTFUND');
    await prisma.transaction.create({ data: {
      reference: ref, merchantId: m.merchant_id, customerEmail: m.email || '',
      amount: BigInt(amount), currency: 'NGN', status: 'PENDING', channel: 'CARD',
      authUrl: `${CHECKOUT_BASE}/checkout.html?ref=${ref}`, accessCode: ref, isSandbox: false,
      metadata: { description: `Wallet top-up`, source: 'wallet_fund', wallet_id: m.wallet_id, member_id: m.member_id },
    }});
    return created(res, { reference: ref, redirect_url: `${CHECKOUT_BASE}/checkout.html?ref=${ref}` }, 'Funding started');
  } catch (e) { next(e); }
});

// Spend to a department.
router.post('/spend', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 1) return fail(res, 'A valid amount (kobo) is required');
    if (!req.body.department_id) return fail(res, 'department_id is required');
    const d = await prisma.$queryRawUnsafe(`SELECT id::text FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.body.department_id, m.merchant_id);
    if (!d.length) return fail(res, 'Invalid department');
    const r = await ledger.spendToDepartment({ walletId: m.wallet_id, departmentId: req.body.department_id, amount, createdBy: req.user.id, note: req.body.note ? String(req.body.note).slice(0, 200) : null });
    require('../services/walletNotify').memberSpent({ merchantId: m.merchant_id, walletId: m.wallet_id, departmentId: req.body.department_id, amount, balanceAfter: r.balanceAfter }).catch(() => {});
    return ok(res, { reference: r.reference, wallet_balance: Number(r.balanceAfter) }, 'Payment successful');
  } catch (e) { handle(res, e, next); }
});

// ── SCAN & PAY ───────────────────────────────────────────────────────────────
// A member scans a merchant/department QR (inv_qr_codes) in the wallet app. Closed-loop:
// the QR MUST belong to the member's own merchant. Resolve returns the bill; pay debits
// the wallet (never negative) and credits the department.
const VAT_RATE = 0.075;
async function resolveQr(m, token) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT q.id::text, q.qr_reference, q.label, q.type, q.amount::text AS amount, q.charge_vat,
            q.is_active, q.merchant_id::text AS merchant_id, q.department_id::text AS department_id,
            d.name AS department_name
       FROM inv_qr_codes q LEFT JOIN inv_departments d ON d.id = q.department_id
      WHERE q.access_token = $1`, token);
  if (!rows.length) return { error: 'This QR code is not recognised', code: 'QR_NOT_FOUND', status: 404 };
  const q = rows[0];
  if (q.merchant_id !== m.merchant_id) return { error: 'This wallet can only pay codes from your own organisation', code: 'QR_OUT_OF_NETWORK', status: 403 };
  if (!q.is_active) return { error: 'This QR code is no longer active', code: 'QR_INACTIVE', status: 409 };
  return { qr: {
    id: q.id, reference: q.qr_reference, label: q.label, type: q.type,
    amount: q.amount === null ? null : num(q.amount), charge_vat: !!q.charge_vat,
    department_id: q.department_id, department_name: q.department_name || null,
  }};
}

// GET /wallet/me/qr/:token — resolve a scanned QR into a payable bill.
router.get('/qr/:token', async (req, res, next) => {
  try {
    const r = await resolveQr(req.walletMember, String(req.params.token));
    if (r.error) return fail(res, r.error, r.code, r.status);
    return ok(res, r.qr);
  } catch (e) { next(e); }
});

// POST /wallet/me/qr/:token/pay — pay a scanned QR from the wallet (never goes negative).
// Fixed QR → the preset amount; open QR → the member-entered amount (body.amount, kobo). VAT added if the QR charges it.
router.post('/qr/:token/pay', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const r = await resolveQr(m, String(req.params.token));
    if (r.error) return fail(res, r.error, r.code, r.status);
    const q = r.qr;
    const base = q.type === 'fixed' ? q.amount : parseInt(req.body.amount, 10);
    if (!Number.isInteger(base) || base < 1)
      return fail(res, q.type === 'fixed' ? 'This QR has no valid amount' : 'Enter a valid amount to pay');
    const vat = q.charge_vat ? Math.round(base * VAT_RATE) : 0;
    const amount = base + vat;
    let result;
    if (q.department_id) {
      result = await ledger.spendToDepartment({ walletId: m.wallet_id, departmentId: q.department_id, amount, createdBy: req.user.id, note: q.label || ('QR ' + q.reference) });
      require('../services/walletNotify').memberSpent({ merchantId: m.merchant_id, walletId: m.wallet_id, departmentId: q.department_id, amount, balanceAfter: result.balanceAfter }).catch(() => {});
    } else {
      result = await ledger.debit({ walletId: m.wallet_id, amount, type: 'spend', counterparty: q.reference, note: q.label || ('QR ' + q.reference), createdBy: req.user.id });
    }
    return ok(res, { reference: result.reference, wallet_balance: Number(result.balanceAfter), paid: amount, base, vat,
      label: q.label, department: q.department_name || null }, 'Payment successful');
  } catch (e) { handle(res, e, next); }
});

module.exports = router;
