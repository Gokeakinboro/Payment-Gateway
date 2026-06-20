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

const CHECKOUT_BASE = (process.env.CHECKOUT_BASE_URL || 'https://paylodeservices.com').replace(/\/$/, '');
const linkUrl = slug => `${CHECKOUT_BASE}/checkout.html?link=${slug}`;

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
    reusable:    r.is_reusable,
    status:      r.status,
    expires_at:  r.expires_at,
    paid_count:  r.paid_count,
    created_at:  r.created_at,
    url:         linkUrl(r.slug),
  };
}

const SELECT_COLS = `id::text, slug, title, description, amount::text AS amount, currency,
                     is_reusable, status, expires_at, paid_count, created_at`;

// NGN single-transaction cap by KYC tier (kobo) — mirrors transactions.initialize.
function singleTxnLimitKobo(tier) {
  return ({ 1: 5_000_000n, 2: 100_000_000n, 3: 500_000_000n })[tier] || 5_000_000n;
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
      `INSERT INTO payment_links (merchant_id, slug, title, description, amount, currency, is_reusable, expires_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${SELECT_COLS}`,
      m.id, slug, title, description, amount === null ? null : BigInt(amount), currency, reusable, expiresAt
    );
    return created(res, formatLink(rows[0]), 'Payment link created');
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
              pl.status, pl.expires_at, m.business_name
         FROM payment_links pl JOIN merchants m ON m.id = pl.merchant_id
        WHERE pl.slug = $1`,
      req.params.slug
    );
    if (!rows.length) return notFound(res, 'Payment link');
    const r = rows[0];
    if (r.status !== 'active') return fail(res, 'This payment link is no longer active', 'LINK_INACTIVE', 410);
    if (r.expires_at && new Date(r.expires_at) < new Date())
      return fail(res, 'This payment link has expired', 'LINK_EXPIRED', 410);
    return ok(res, {
      slug:          r.slug,
      title:         r.title,
      description:   r.description,
      amount:        r.amount === null ? null : Number(r.amount),
      amount_fixed:  r.amount !== null,
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
              currency, status, expires_at
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

    // KYC single-transaction limit (NGN).
    if (link.currency === 'NGN') {
      const limit = singleTxnLimitKobo(merchant.kycTier);
      if (BigInt(amount) > limit)
        return fail(res, `Amount exceeds the merchant's per-transaction limit of ₦${koboToNaira(limit).toLocaleString()}`, 'KYC_LIMIT_EXCEEDED');
    }

    const ref = generateRef('TXNPL');
    await prisma.transaction.create({ data: {
      reference:     ref,
      merchantId:    merchant.id,
      customerEmail: email,
      amount:        BigInt(amount),
      currency:      link.currency,
      status:        'PENDING',
      channel:       'CARD',                       // placeholder; charge path sets the real channel
      authUrl:       `${CHECKOUT_BASE}/checkout.html?ref=${ref}`,
      accessCode:    ref,
      isSandbox:     false,
      metadata:      { description: link.title, source: 'payment_link', payment_link_slug: req.params.slug },
    }});

    return created(res, {
      reference:    ref,
      redirect_url: `${CHECKOUT_BASE}/checkout.html?ref=${ref}`,
    }, 'Transaction created');
  } catch (e) { next(e); }
});

module.exports = router;
