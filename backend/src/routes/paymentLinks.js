'use strict';
/**
 * Paylode — Payment Links
 * Merchant-generated, shareable checkout links (no code required). A link mints a
 * PENDING transaction when a customer opens it and submits their email (+ amount,
 * for open-amount links); the customer then pays through the normal hosted checkout
 * flow (checkout.html?ref=<reference>).
 *
 *   Merchant (JWT):   POST / · GET / · PATCH /:id · DELETE /:id
 *   Public (no auth): GET /public/:slug · POST /public/:slug/transaction
 *
 * payment_links is accessed via raw SQL (no Prisma model) — same pattern as the
 * other recently-added tables; transactions use the existing Prisma model.
 */
const router = require('express').Router();
const crypto = require('crypto');
const { prisma }   = require('../utils/db');
const { requireAuth, requireMerchant } = require('../middleware/auth');
const { ok, fail, notFound, created, generateRef, koboToNaira } = require('../utils/helpers');
const compliance = require('../services/complianceService');
const { sendEmail } = require('../services/emailService');
const whatsapp = require('../services/whatsappService');

const CHECKOUT_BASE = (process.env.CHECKOUT_BASE_URL || 'https://paylodeservices.com').replace(/\/$/, '');
const linkUrl = slug => `${CHECKOUT_BASE}/checkout.html?link=${slug}`;

// Email format checker (the "valid email" gate for recipients).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = e => EMAIL_RE.test(String(e || '').trim());
const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Merchant-charged VAT (7.5%) added on top of the face amount — the merchant
// charging VAT to their customer, distinct from the gateway processing-fee VAT.
// 7.5% = 75/1000; BigInt math keeps it exact in kobo.
const merchantVat = (kobo) => (BigInt(kobo) * 75n) / 1000n;

// Shape a DB row (amount selected as ::text) into the API representation.
function formatLink(r) {
  const amt = r.amount === null || r.amount === undefined ? null : Number(r.amount);
  return {
    id:          r.id,
    slug:        r.slug,
    title:       r.title,
    description: r.description,
    amount:      amt,                                   // kobo, or null = customer-entered
    amount_major: amt === null ? null : amt / 100,
    currency:    r.currency,
    charge_vat:  !!r.charge_vat,
    customer_phone: r.customer_phone || null,
    reusable:    r.is_reusable,
    status:      r.status,
    expires_at:  r.expires_at,
    paid_count:  r.paid_count,
    created_at:  r.created_at,
    recipient_email: r.recipient_email || null,
    batch_id:        r.batch_id || null,
    line_items:      r.line_items || null,
    department_id:   r.department_id || null,
    service_charge_amount: r.service_charge_amount == null ? 0 : Number(r.service_charge_amount),
    apply_service_charge:  !!r.apply_service_charge,
    vat_amount:      r.vat_amount == null ? 0 : Number(r.vat_amount),
    url:         linkUrl(r.slug),
  };
}

const SELECT_COLS = `id::text, slug, title, description, amount::text AS amount, currency,
                     charge_vat, customer_phone, is_reusable, status, expires_at, paid_count, created_at,
                     recipient_email, batch_id::text AS batch_id,
                     line_items, department_id::text AS department_id,
                     service_charge_amount::text AS service_charge_amount, apply_service_charge,
                     vat_amount::text AS vat_amount`;

// NGN single-transaction cap by KYC tier (kobo) — mirrors transactions.initialize.
function singleTxnLimitKobo(tier) {
  return ({ 1: 5_000_000n, 2: 100_000_000n, 3: 500_000_000n })[tier] || 5_000_000n;
}

// Hook: create a payment_links row. Core owns payment_links, so other domains
// (invoicing's itemized-link builder, which resolves the dept catalog + service
// charge) create links through THIS instead of touching the table — keeps the
// boundary clean (see docs/DATA-OWNERSHIP.md). `amount` is the face (excl VAT).
async function createPaymentLink({
  merchantId, title, description = null, amount = null, currency = 'NGN', reusable = true,
  expiresAt = null, chargeVat = false, customerPhone = null, lineItems = null,
  departmentId = null, serviceChargeAmount = 0, applyServiceCharge = false, vatAmount = 0,
}) {
  const slug = crypto.randomBytes(8).toString('base64url');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO payment_links
       (merchant_id, slug, title, description, amount, currency, is_reusable, expires_at, charge_vat,
        customer_phone, line_items, department_id, service_charge_amount, apply_service_charge, vat_amount)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::uuid,$13,$14,$15)
     RETURNING ${SELECT_COLS}`,
    merchantId, slug, title, description, amount === null ? null : BigInt(amount), currency, reusable,
    expiresAt, chargeVat, customerPhone, lineItems ? JSON.stringify(lineItems) : null,
    departmentId, BigInt(serviceChargeAmount), applyServiceCharge, BigInt(vatAmount));
  return formatLink(rows[0]);
}

// ── Merchant: create a payment link ─────────────────────────────────────────
router.post('/', requireAuth, requireMerchant, async (req, res, next) => {
  try {
    const m = req.user.merchant;
    if (!m) return fail(res, 'Only merchants can create payment links', 'NOT_A_MERCHANT', 403);

    const title = String(req.body.title || '').trim();
    if (!title) return fail(res, 'A title (what the customer is paying for) is required');
    if (title.length > 140) return fail(res, 'Title is too long (max 140 characters)');

    const description = req.body.description ? String(req.body.description).trim().slice(0, 500) : null;
    const currency    = req.body.currency === 'USD' ? 'USD' : 'NGN';
    const reusable    = req.body.reusable === undefined ? true : !!req.body.reusable;
    const chargeVat   = !!req.body.charge_vat;
    const customerPhone = req.body.customer_phone ? String(req.body.customer_phone).trim().slice(0, 32) : null;

    // Amount is optional — omit it for a customer-entered ("open") amount.
    let amount = null;
    const raw = req.body.amount;
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      amount = parseInt(raw, 10);
      if (!Number.isInteger(amount) || amount < 100)
        return fail(res, 'amount must be a whole number in kobo (≥ 100), or omitted for a customer-entered amount');
    }

    let expiresAt = null;
    if (req.body.expires_at) {
      const d = new Date(req.body.expires_at);
      if (isNaN(d.getTime())) return fail(res, 'expires_at is not a valid date');
      if (d.getTime() <= Date.now()) return fail(res, 'expires_at must be in the future');
      expiresAt = d;
    }

    const slug = crypto.randomBytes(8).toString('base64url'); // ~11 url-safe chars
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO payment_links (merchant_id, slug, title, description, amount, currency, is_reusable, expires_at, charge_vat, customer_phone)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${SELECT_COLS}`,
      m.id, slug, title, description, amount === null ? null : BigInt(amount), currency, reusable, expiresAt, chargeVat, customerPhone
    );
    const link = formatLink(rows[0]);
    // Share the link over WhatsApp when a customer phone was supplied (best-effort;
    // no-ops until a WhatsApp sender + template are configured).
    if (link.customer_phone) {
      whatsapp.notifyPaymentLink({
        phone: link.customer_phone, businessName: m.businessName, title: link.title,
        amount: link.amount, currency: link.currency, payUrl: link.url,
      }).catch(() => {});
    }
    return created(res, link, 'Payment link created');
  } catch (e) { next(e); }
});

// ── Merchant: create per-recipient links (single or bulk) + auto-email ───────
// body: { title, description?, amount?, currency?, expires_at?, recipients:[email,…] }
// Each VALID, de-duplicated recipient gets a UNIQUE one-time link (grouped by a
// shared batch_id) and is emailed it. Invalid-format emails are skipped + reported.
router.post('/batch', requireAuth, requireMerchant, async (req, res, next) => {
  try {
    const m = req.user.merchant;
    if (!m) return fail(res, 'Only merchants can create payment links', 'NOT_A_MERCHANT', 403);

    const title = String(req.body.title || '').trim();
    if (!title) return fail(res, 'A title (what the customer is paying for) is required');
    if (title.length > 140) return fail(res, 'Title is too long (max 140 characters)');
    const description = req.body.description ? String(req.body.description).trim().slice(0, 500) : null;
    const currency    = req.body.currency === 'USD' ? 'USD' : 'NGN';
    const chargeVat   = !!req.body.charge_vat;

    let amount = null;
    const raw = req.body.amount;
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      amount = parseInt(raw, 10);
      if (!Number.isInteger(amount) || amount < 100)
        return fail(res, 'amount must be a whole number in kobo (≥ 100), or omitted for a customer-entered amount');
    }

    let expiresAt = null;
    if (req.body.expires_at) {
      const d = new Date(req.body.expires_at);
      if (isNaN(d.getTime())) return fail(res, 'expires_at is not a valid date');
      if (d.getTime() <= Date.now()) return fail(res, 'expires_at must be in the future');
      expiresAt = d;
    }

    // Validate + dedupe recipient emails (case-insensitive).
    const rawList = Array.isArray(req.body.recipients) ? req.body.recipients : [];
    const seen = new Set(); const valid = []; const invalid = [];
    for (const r of rawList) {
      const e = String(r || '').trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      seen.add(e);
      (isValidEmail(e) ? valid : invalid).push(e);
    }
    if (!valid.length)
      return fail(res, invalid.length ? 'No valid recipient emails — check the addresses.' : 'At least one recipient email is required.');
    if (valid.length > 1000) return fail(res, 'Too many recipients in one batch (max 1000).');

    const merchant = await prisma.merchant.findUnique({ where: { id: m.id }, select: { businessName: true } });
    const bizName  = (merchant && merchant.businessName) || 'A merchant';
    const batchId  = crypto.randomUUID();

    // Create a unique one-time link per recipient.
    const links = [];
    for (const email of valid) {
      const slug = crypto.randomBytes(8).toString('base64url');
      await prisma.$queryRawUnsafe(
        `INSERT INTO payment_links (merchant_id, slug, title, description, amount, currency, is_reusable, expires_at, recipient_email, batch_id, charge_vat)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,false,$7,$8,$9::uuid,$10)`,
        m.id, slug, title, description, amount === null ? null : BigInt(amount), currency, expiresAt, email, batchId, chargeVat
      );
      links.push({ email, slug, url: linkUrl(slug) });
    }

    // Auto-email each recipient their link (best-effort; the ?email param prefills checkout).
    const amtLabel = amount === null ? 'Enter amount at checkout'
      : `${currency === 'USD' ? '$' : '₦'}${(amount / 100).toLocaleString()}`;
    let emailed = 0; const emailFailed = [];
    for (const l of links) {
      const payUrl = `${l.url}&email=${encodeURIComponent(l.email)}`;
      const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;color:#222">
        <p><strong>${escapeHtml(bizName)}</strong> has sent you a payment request.</p>
        <p style="font-size:16px;margin:14px 0"><strong>${escapeHtml(title)}</strong><br>Amount: ${escapeHtml(amtLabel)}</p>
        <p><a href="${payUrl}" style="background:#16a34a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block">Pay securely</a></p>
        <p style="font-size:12px;color:#666;margin-top:14px">Or open this link:<br>${escapeHtml(payUrl)}${expiresAt ? `<br>Expires ${escapeHtml(expiresAt.toDateString())}` : ''}</p>
        <p style="font-size:11px;color:#999;margin-top:18px">Powered by Paylode</p></div>`;
      try {
        await sendEmail({
          to: l.email,
          subject: `Payment request from ${bizName}: ${title}`.slice(0, 160),
          html, text: `${bizName} requests payment for "${title}" (${amtLabel}). Pay: ${payUrl}`,
        });
        emailed++;
      } catch (e) { emailFailed.push(l.email); }
    }

    return created(res, {
      batch_id: batchId, title, amount, currency,
      created: links.length, emailed, email_failed: emailFailed, invalid_emails: invalid,
      links: links.map(l => ({ email: l.email, url: l.url })),
    }, `Created ${links.length} link(s), emailed ${emailed}.${invalid.length ? ` ${invalid.length} invalid email(s) skipped.` : ''}`);
  } catch (e) { next(e); }
});

// ── Merchant: list my payment links ─────────────────────────────────────────
router.get('/', requireAuth, requireMerchant, async (req, res, next) => {
  try {
    const m = req.user.merchant;
    if (!m) return fail(res, 'Only merchants can view payment links', 'NOT_A_MERCHANT', 403);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${SELECT_COLS} FROM payment_links WHERE merchant_id = $1::uuid ORDER BY created_at DESC`,
      m.id
    );
    return ok(res, rows.map(formatLink));
  } catch (e) { next(e); }
});

// ── Merchant: enable/disable (or edit title/description) ─────────────────────
router.patch('/:id', requireAuth, requireMerchant, async (req, res, next) => {
  try {
    const m = req.user.merchant;
    if (!m) return fail(res, 'Only merchants can update payment links', 'NOT_A_MERCHANT', 403);
    const sets = [];
    const vals = [];
    let i = 1;
    if (req.body.status !== undefined) {
      const status = req.body.status === 'disabled' ? 'disabled' : 'active';
      sets.push(`status = $${i++}`); vals.push(status);
    }
    if (req.body.title !== undefined) {
      const t = String(req.body.title || '').trim();
      if (!t) return fail(res, 'Title cannot be empty');
      sets.push(`title = $${i++}`); vals.push(t.slice(0, 140));
    }
    if (req.body.description !== undefined) {
      sets.push(`description = $${i++}`); vals.push(req.body.description ? String(req.body.description).slice(0, 500) : null);
    }
    if (!sets.length) return fail(res, 'Nothing to update');
    sets.push(`updated_at = now()`);
    vals.push(req.params.id, m.id);
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE payment_links SET ${sets.join(', ')} WHERE id = $${i++}::uuid AND merchant_id = $${i++}::uuid RETURNING ${SELECT_COLS}`,
      ...vals
    );
    if (!rows.length) return notFound(res, 'Payment link');
    return ok(res, formatLink(rows[0]), 'Payment link updated');
  } catch (e) { next(e); }
});

// ── Merchant: delete a link ─────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireMerchant, async (req, res, next) => {
  try {
    const m = req.user.merchant;
    if (!m) return fail(res, 'Only merchants can delete payment links', 'NOT_A_MERCHANT', 403);
    const rows = await prisma.$queryRawUnsafe(
      `DELETE FROM payment_links WHERE id = $1::uuid AND merchant_id = $2::uuid RETURNING id::text`,
      req.params.id, m.id
    );
    if (!rows.length) return notFound(res, 'Payment link');
    return ok(res, { id: rows[0].id }, 'Payment link deleted');
  } catch (e) { next(e); }
});

// ── Public: link details (for the hosted checkout page) ──────────────────────
router.get('/public/:slug', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT pl.slug, pl.title, pl.description, pl.amount::text AS amount, pl.currency,
              pl.charge_vat, pl.status, pl.expires_at, m.business_name
         FROM payment_links pl JOIN merchants m ON m.id = pl.merchant_id
        WHERE pl.slug = $1`,
      req.params.slug
    );
    if (!rows.length) return notFound(res, 'Payment link');
    const r = rows[0];
    if (r.status !== 'active') return fail(res, 'This payment link is no longer active', 'LINK_INACTIVE', 410);
    if (r.expires_at && new Date(r.expires_at) < new Date())
      return fail(res, 'This payment link has expired', 'LINK_EXPIRED', 410);
    const baseAmt = r.amount === null ? null : Number(r.amount);
    const vatAmt  = (baseAmt !== null && r.charge_vat) ? Number(merchantVat(baseAmt)) : null;
    return ok(res, {
      slug:          r.slug,
      title:         r.title,
      description:   r.description,
      amount:        baseAmt,
      amount_fixed:  r.amount !== null,
      charge_vat:    !!r.charge_vat,
      vat_rate:      0.075,
      vat_amount:    vatAmt,                                        // kobo, fixed links only
      total_amount:  baseAmt === null ? null : baseAmt + (vatAmt || 0),
      currency:      r.currency,
      merchant_name: r.business_name,
    });
  } catch (e) { next(e); }
});

// ── Public: mint a PENDING transaction from a link ───────────────────────────
// The customer submits their email (and the amount, for open-amount links). We
// create a transaction and hand back checkout.html?ref=<reference> to pay.
router.post('/public/:slug/transaction', async (req, res, next) => {
  try {
    const linkRows = await prisma.$queryRawUnsafe(
      `SELECT id::text, merchant_id::text AS merchant_id, title, amount::text AS amount,
              currency, charge_vat, status, expires_at, service_charge_amount::text AS service_charge_amount
         FROM payment_links WHERE slug = $1`,
      req.params.slug
    );
    if (!linkRows.length) return notFound(res, 'Payment link');
    const link = linkRows[0];
    if (link.status !== 'active') return fail(res, 'This payment link is no longer active', 'LINK_INACTIVE', 410);
    if (link.expires_at && new Date(link.expires_at) < new Date())
      return fail(res, 'This payment link has expired', 'LINK_EXPIRED', 410);

    // Email is OPTIONAL (a link is shared to many; each payer fills their own, or
    // skips it). Validate only when provided. Used for the receipt + customer screening.
    const email = String(req.body.email || '').trim().toLowerCase();
    if (email && !email.includes('@')) return fail(res, 'Enter a valid email or leave it blank');

    // Amount: fixed from the link, or customer-entered for open-amount links.
    let amount;
    if (link.amount !== null) {
      amount = parseInt(link.amount, 10);
    } else {
      amount = parseInt(req.body.amount, 10);
      if (!Number.isInteger(amount) || amount < 100)
        return fail(res, 'A valid amount (in kobo, ≥ 100) is required');
    }

    // Optional merchant-charged 7.5% VAT. Service charge (itemized links) is VAT-EXEMPT,
    // so the VAT base is the face amount minus the stored service charge.
    const svc     = link.amount !== null ? (Number(link.service_charge_amount) || 0) : 0;
    const vat     = link.charge_vat ? merchantVat(amount - svc) : 0n;
    const charged = BigInt(amount) + vat;

    const merchant = await prisma.merchant.findUnique({
      where: { id: link.merchant_id }, include: { aggregator: true },
    });
    if (!merchant) return notFound(res, 'Merchant');
    if (!merchant.isActive)
      return fail(res, 'This merchant cannot currently accept payments', 'MERCHANT_INACTIVE', 403);

    // Compliance gate (Mastercard Rules) — block a compliance-blocked / MATCH-listed
    // merchant or a sanctioned customer before a transaction is created.
    const gate = compliance.screenTransaction(merchant, { customerEmail: email || undefined });
    if (gate.decision === 'REJECT') return fail(res, gate.message, gate.reasonCode, 403);

    // KYC single-transaction limit (NGN) — applied to the total charged.
    if (link.currency === 'NGN') {
      const limit = singleTxnLimitKobo(merchant.kycTier);
      if (charged > limit)
        return fail(res, `Amount exceeds the merchant's per-transaction limit of ₦${koboToNaira(limit).toLocaleString()}`, 'KYC_LIMIT_EXCEEDED');
    }

    const ref = generateRef('TXNPL');
    await prisma.transaction.create({ data: {
      reference:     ref,
      merchantId:    merchant.id,
      customerEmail: email,
      amount:        charged,
      currency:      link.currency,
      status:        'PENDING',
      channel:       'CARD',                       // placeholder; charge path sets the real channel
      authUrl:       `${CHECKOUT_BASE}/checkout.html?ref=${ref}`,
      accessCode:    ref,
      isSandbox:     false,
      metadata:      { description: link.title, source: 'payment_link', payment_link_slug: req.params.slug,
                       charge_vat: link.charge_vat, base_amount: amount, vat_amount: Number(vat) },
    }});

    return created(res, {
      reference:    ref,
      redirect_url: `${CHECKOUT_BASE}/checkout.html?ref=${ref}`,
    }, 'Transaction created');
  } catch (e) { next(e); }
});

// Router is the default export (mounted by the registry); the hook is attached for
// invoicing's itemized-link builder (require('../routes/paymentLinks').createPaymentLink).
module.exports = router;
module.exports.createPaymentLink = createPaymentLink;
