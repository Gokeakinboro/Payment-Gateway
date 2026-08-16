'use strict';
// Public storefront — GET /api/v1/store/:merchantCode
// No auth required. Returns merchant business name + active, public payment links.

const router = require('express').Router();
const { prisma } = require('../utils/db');
const { ok, notFound } = require('../utils/helpers');

const CHECKOUT_BASE = (process.env.CHECKOUT_BASE_URL || 'https://paylodeservices.com').replace(/\/$/, '');
const linkUrl = slug => `${CHECKOUT_BASE}/checkout.html?link=${slug}`;

router.get('/:merchantCode', async (req, res, next) => {
  try {
    const code = String(req.params.merchantCode || '').trim().toUpperCase();
    if (!code) return notFound(res, 'Store not found');

    const merchants = await prisma.$queryRawUnsafe(`
      SELECT id::text, business_name, merchant_code, business_description
        FROM merchants
       WHERE merchant_code = $1 AND status = 'active'
       LIMIT 1
    `, code);
    if (!merchants.length) return notFound(res, 'Store not found');
    const m = merchants[0];

    const links = await prisma.$queryRawUnsafe(`
      SELECT slug, title, description,
             amount::text AS amount, currency
        FROM payment_links
       WHERE merchant_id = $1::uuid
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND batch_id IS NULL
         AND recipient_email IS NULL
       ORDER BY created_at DESC
       LIMIT 50
    `, m.id);

    return ok(res, {
      merchant: {
        name:        m.business_name,
        code:        m.merchant_code,
        description: m.business_description || null,
      },
      links: links.map(l => ({
        slug:         l.slug,
        title:        l.title,
        description:  l.description || null,
        amount:       l.amount === null ? null : Number(l.amount),
        amount_major: l.amount === null ? null : Number(l.amount) / 100,
        currency:     l.currency || 'NGN',
        url:          linkUrl(l.slug),
      })),
    });
  } catch (e) { next(e); }
});

module.exports = router;
