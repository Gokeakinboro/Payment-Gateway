'use strict';
/**
 * Invoice & Collect — shared helpers.
 * Tenant = merchant. Works identically for dashboard users (JWT → req.user.merchant)
 * and external platforms such as the golf platform (API key → req.merchant), so the
 * whole module is reusable by any product on the gateway.
 */
const crypto = require('crypto');
const { prisma } = require('../../utils/db');
const { requireAuth, requireApiKey } = require('../../middleware/auth');
const { fail } = require('../../utils/helpers');

const VAT_RATE = Number(process.env.INVOICE_VAT_RATE || 0.075);
const CHECKOUT_BASE = (process.env.CHECKOUT_BASE_URL || 'https://paylodeservices.com').replace(/\/$/, '');
const APP_BASE = (process.env.APP_BASE_URL || CHECKOUT_BASE).replace(/\/$/, '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (e) => EMAIL_RE.test(String(e || '').trim());

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Resolve the tenant merchant from either auth path. Returns the merchant object
// ({ id, ... }) or null.
function getMerchant(req) {
  if (req.user && req.user.merchant) return req.user.merchant;
  if (req.merchant) return req.merchant;
  return null;
}

// VAT on the merchant's invoice face amount (the merchant charging VAT to their
// customer) — distinct from the gateway processing-fee VAT. All kobo.
function computeVat(amountKobo, chargeVat) {
  if (!chargeVat) return 0n;
  const amt = BigInt(amountKobo);
  return amt * BigInt(Math.round(VAT_RATE * 1_000_000)) / 1_000_000n;
}

// Itemized-document money math (invoices / QR / payment links). ONE formula — the
// service-charge `mode` only changes DISPLAY, both modes give the same total.
// All kobo, integers. line_items store BASE amounts (unit×qty, pre-service):
//   items_subtotal = Σ(unit_amount × quantity)
//   service_charge = applyServiceCharge ? round(pct% × items_subtotal) : 0   (VAT-EXEMPT)
//   vat_amount     = chargeVat ? computeVat(items_subtotal) : 0   ← VAT base EXCLUDES service
//   amount(excl VAT) = items_subtotal + service_charge ; total = amount + vat_amount
// Accepts new items {product_id?, name, unit_amount, quantity} or legacy {description, amount}.
// Returns { error } on invalid input, else { lineItems, itemsSubtotal, serviceCharge, vatAmount, amount, total }.
function computeInvoiceMoney({ items, serviceChargePct = 0, applyServiceCharge = false, chargeVat = false, maxItems = 15 }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { error: 'At least one line item is required' };
  if (list.length > maxItems) return { error: `A maximum of ${maxItems} items is allowed` };
  const lineItems = [];
  for (const it of list) {
    if (!it) continue;
    const hasUnit = it.unit_amount != null && it.quantity != null;
    const unit = parseInt(hasUnit ? it.unit_amount : it.amount, 10);
    const qty  = hasUnit ? parseInt(it.quantity, 10) : 1;
    const name = String(it.name || it.description || '').trim().slice(0, 200);
    if (!name || !Number.isInteger(unit) || unit <= 0 || !Number.isInteger(qty) || qty <= 0)
      return { error: 'Each item needs a name, a positive unit_amount (kobo) and a positive quantity' };
    lineItems.push({ product_id: it.product_id || null, name, unit_amount: unit, quantity: qty, amount: unit * qty });
  }
  const itemsSubtotal = lineItems.reduce((s, it) => s + it.amount, 0);
  const pct = applyServiceCharge ? (Number(serviceChargePct) || 0) : 0;
  const serviceCharge = Math.round(itemsSubtotal * pct / 100);
  const vatAmount = Number(computeVat(itemsSubtotal, !!chargeVat));  // VAT on items only (service is VAT-exempt)
  const amount = itemsSubtotal + serviceCharge;   // face, excl VAT
  return { lineItems, itemsSubtotal, serviceCharge, vatAmount, amount, total: amount + vatAmount };
}

const randToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

// Signed token for the recipient's cross-invoice view (no account/registration):
// base64url(lower(email)) + "." + hmac. Verifiable, unguessable, stateless.
function signRecipient(email) {
  const e = String(email || '').trim().toLowerCase();
  const b = Buffer.from(e).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'paylode')
    .update(e).digest('base64url').slice(0, 24);
  return `${b}.${sig}`;
}
function verifyRecipient(token) {
  const [b, sig] = String(token || '').split('.');
  if (!b || !sig) return null;
  let email;
  try { email = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const expect = crypto.createHmac('sha256', process.env.JWT_SECRET || 'paylode')
    .update(email).digest('base64url').slice(0, 24);
  if (sig.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch { return null; }
  return email;
}

const koboToNairaStr = (k) => (Number(k) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

// ── Tenant resolution ───────────────────────────────────────────────────────
// Populates req.invTenant = { merchantId, merchant, departmentId|null, isDeptUser, isApiKey }.
// Works for: API-key callers (external platforms), merchant-owner JWT, and
// departmental sub-users (resolved via inv_department_users).
function tenantAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (tok.startsWith('sk_live_') || tok.startsWith('sk_test_')) {
    return requireApiKey(req, res, () => {
      req.invTenant = { merchantId: req.merchant.id, merchant: req.merchant, departmentId: null, isDeptUser: false, isApiKey: true };
      next();
    });
  }
  return requireAuth(req, res, async () => {
    try {
      const owner = req.user && req.user.merchant;
      if (owner) {
        req.invTenant = { merchantId: owner.id, merchant: owner, departmentId: null, isDeptUser: false, isApiKey: false };
        return next();
      }
      // Departmental sub-user: resolve merchant + department from the mapping table.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT merchant_id::text AS merchant_id, department_id::text AS department_id
           FROM inv_department_users WHERE user_id = $1::uuid LIMIT 1`,
        req.user.id
      );
      if (!rows.length)
        return fail(res, 'Only merchants can use Invoice & Collect', 'NOT_A_MERCHANT', 403);
      req.invTenant = { merchantId: rows[0].merchant_id, merchant: null, departmentId: rows[0].department_id, isDeptUser: true, isApiKey: false };
      next();
    } catch (e) { next(e); }
  });
}

module.exports = {
  prisma, VAT_RATE, CHECKOUT_BASE, APP_BASE,
  isValidEmail, escapeHtml, getMerchant, computeVat, computeInvoiceMoney,
  randToken, signRecipient, verifyRecipient, koboToNairaStr,
  tenantAuth,
};
