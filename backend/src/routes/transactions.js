'use strict';
const router = require('express').Router();
const { body, query, param, validationResult } = require('express-validator');
const { prisma }        = require('../utils/db');
const { requireAuth, requireApiKey, requireCompliance } = require('../middleware/auth');
const {
  ok, fail, notFound, created,
  generateRef, computeFees, computeFeesWithConfig, koboToNaira,
} = require('../utils/helpers');
const { dispatchWebhook } = require('../services/webhookService');
const { checkAmlRules }   = require('../services/amlService');

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ status:false, message:e.array()[0].msg, errors:e.array(), error_code:'VALIDATION_ERROR' });
  next();
};

// ── POST /api/v1/transactions/initialize ──────────────────────────────────
// Called by merchant SDK — requires Secret Key
router.post('/initialize', requireApiKey,
  validate([
    body('email').isEmail().withMessage('Valid customer email required'),
    body('amount').isInt({ min: 100 }).withMessage('amount must be an integer in minor units (kobo for NGN, cents for USD)'),
    body('currency').optional().isIn(['NGN', 'USD']).withMessage('currency must be NGN or USD'),
    body('channels').optional().isArray(),
  ]),
  async (req, res, next) => {
    try {
      const merchant    = req.merchant;
      const isSandbox   = req.isSandbox;
      const { email, amount, currency='NGN', reference, channels, metadata, callback_url } = req.body;

      const channel  = (channels?.[0] || 'CARD').toUpperCase();
      const isUSD    = currency === 'USD';
      const sym      = isUSD ? '$' : '₦';

      // ── Derive the fee PRODUCT from (channel, currency) ──────────────────────
      // International card = card paid in USD → CARD_INTL. Otherwise map normally.
      let product;
      if (channel === 'CARD')              product = isUSD ? 'CARD_INTL' : 'CARD_LOCAL';
      else if (channel === 'BANK_TRANSFER') product = 'VIRTUAL_ACCOUNT';
      else if (channel === 'USSD')          product = 'USSD';
      else                                  product = channel;

      // ── Limits — applied per currency (NGN tier limits; USD has its own caps) ─
      const today = new Date(); today.setHours(0,0,0,0);
      if (isUSD) {
        // USD single-txn cap (cents). Tier 1 $5k, Tier 2 $100k, Tier 3 $500k.
        const usdSingle = { 1: 500_000n, 2: 10_000_000n, 3: 50_000_000n }[merchant.kycTier] || 500_000n;
        if (BigInt(amount) > usdSingle)
          return fail(res, `Transaction exceeds your Tier ${merchant.kycTier} international single-transaction limit of $${(Number(usdSingle)/100).toLocaleString()}`, 'KYC_LIMIT_EXCEEDED');
      } else {
        const tierLimits = { 1: 5_000_000n, 2: 100_000_000n, 3: 500_000_000n };
        const singleLimit = tierLimits[merchant.kycTier] || 5_000_000n;
        if (BigInt(amount) > singleLimit)
          return fail(res, `Transaction exceeds your Tier ${merchant.kycTier} single transaction limit of ₦${koboToNaira(singleLimit).toLocaleString()}`, 'KYC_LIMIT_EXCEEDED');

        const dailyLimits = { 1: 30_000_000n, 2: 1_000_000_000n, 3: 10_000_000_000n };
        const dailyLimit  = dailyLimits[merchant.kycTier];
        if (dailyLimit) {
          const { _sum } = await prisma.transaction.aggregate({
            where: { merchantId: merchant.id, status: 'SUCCESS', currency: 'NGN', createdAt: { gte: today }, isSandbox },
            _sum: { amount: true },
          });
          const usedToday = _sum.amount ? BigInt(_sum.amount) : 0n;
          if (usedToday + BigInt(amount) > dailyLimit)
            return fail(res, `Transaction would exceed your daily limit of ₦${koboToNaira(dailyLimit).toLocaleString()}`, 'DAILY_LIMIT_EXCEEDED');
        }
      }

      // ── Rail routing: prefer the product's configured default rail, else cheapest LIVE rail for the channel ──
      let rail = null; let railRate = 0;
      // Exact product rate wins; fall back to the platform 'ALL' default.
      const platformRate = (await prisma.platformRateConfig.findUnique({ where: { channel: product } }))
        || (await prisma.platformRateConfig.findFirst({ where: { channel: 'ALL' } }));
      if (!isSandbox) {
        if (platformRate?.defaultRailId) {
          const dr = await prisma.paymentRail.findUnique({ where: { id: platformRate.defaultRailId } });
          if (dr && dr.status === 'LIVE') {
            rail = dr;
            const rc = await prisma.railCost.findFirst({ where: { railId: dr.id, channel, effectiveTo: null }, orderBy: { rate: 'asc' } });
            railRate = rc ? Number(rc.rate) : 0;
          }
        }
        if (!rail) {
          const railCost = await prisma.railCost.findFirst({
            where: { channel, effectiveTo: null, rail: { status: 'LIVE' } },
            include: { rail: true }, orderBy: { rate: 'asc' },
          });
          if (railCost) { rail = railCost.rail; railRate = Number(railCost.rate); }
        }
      }

      const aggSplitPct = merchant.aggregator ? Number(merchant.aggregator.revenueSplitPct) : 0;

      // ── Rate config: per-merchant override → platform product default → legacy ─
      // Exact product override wins over the merchant's 'ALL' override.
      const merchantRate = (await prisma.merchantRateConfig.findFirst({ where: { merchantId: merchant.id, channel: product } }))
        || (await prisma.merchantRateConfig.findFirst({ where: { merchantId: merchant.id, channel: 'ALL' } }));
      const rateConfig = merchantRate
        ? { rate: Number(merchantRate.rate), flat_fee: Number(merchantRate.flatFee), cap: Number(merchantRate.cap), min_charge: Number(merchantRate.minCharge), fee_model: merchantRate.feeModel, vat_rate: Number(merchantRate.vatRate) }
        : platformRate
          ? { rate: Number(platformRate.rate), flat_fee: Number(platformRate.flatFee), cap: Number(platformRate.cap), min_charge: Number(platformRate.minCharge), fee_model: platformRate.feeModel, vat_rate: Number(platformRate.vatRate) }
          : { rate: Number(merchant.processingRate || 0.015), flat_fee: 0, cap: 0, min_charge: 0 };

      const fees = computeFeesWithConfig(amount, rateConfig, railRate, aggSplitPct);
      const ref  = reference || generateRef(isUSD ? 'TXNUSD' : 'TXN');

      const txn = await prisma.transaction.create({ data: {
        reference:     ref,
        merchantId:    merchant.id,
        customerEmail: email,
        amount:        BigInt(amount),
        currency,
        status:        'PENDING',
        channel,
        railId:        rail?.id || null,
        merchantFee:   fees.merchantFee,
        railCost:      fees.railCost,
        netRevenue:    0n,
        aggShare:      0n,
        paylodeMargin: 0n,
        authUrl:       isSandbox
          ? `https://sandbox.paylodeservices.com/pay/${ref}`
          : `https://checkout.paylodeservices.com/pay/${ref}`,
        accessCode:    ref,
        callbackUrl:   callback_url,
        metadata:      Object.assign({}, metadata || {}, { product, is_international: isUSD }),
        isSandbox,
      }});

      checkAmlRules(txn, merchant).catch(() => {});

      created(res, {
        authorization_url: txn.authUrl,
        access_code:       txn.accessCode,
        reference:         txn.reference,
        amount:            Number(txn.amount),
        currency,
        product,
        is_international:  isUSD,
        sandbox:           isSandbox,
        fee_preview: {
          merchant_fee:       Number(fees.merchantFee),
          merchant_fee_major: Number(fees.merchantFee) / 100,
          currency,
          display:            sym + (Number(fees.merchantFee) / 100).toLocaleString(),
        },
      }, 'Transaction initialized');
    } catch (e) { next(e); }
  }
);

// ── GET /api/v1/transactions/verify/:reference ────────────────────────────
router.get('/verify/:reference', requireApiKey,
  async (req, res, next) => {
    try {
      const txn = await prisma.transaction.findUnique({
        where: { reference: req.params.reference },
        include: { merchant: { select: { merchantCode:true, businessName:true }} },
      });
      if (!txn || txn.merchantId !== req.merchant.id)
        return notFound(res, 'Transaction');

      ok(res, formatTxn(txn));
    } catch (e) { next(e); }
  }
);

// ── POST /api/v1/transactions/:id/confirm ─────────────────────────────────
// Called by payment page when customer completes payment (or simulated in sandbox)
router.post('/:id/confirm', requireApiKey,
  async (req, res, next) => {
    try {
      const txn = await prisma.transaction.findUnique({
        where: { id: req.params.id },
        include: { merchant: { include: { aggregator: true } } },
      });
      if (!txn) return notFound(res, 'Transaction');
      if (txn.status !== 'PENDING') return fail(res, 'Transaction already processed');

      const merchant    = txn.merchant;
      const railRate    = 0; // Will be fetched from rail in production
      const aggSplitPct = merchant.aggregator ? Number(merchant.aggregator.revenueSplitPct) : 0;
      const fees        = computeFees(Number(txn.amount), Number(merchant.processingRate || 0.015), railRate, aggSplitPct);

      const updated = await prisma.transaction.update({
        where: { id: txn.id },
        data: {
          status:        'SUCCESS',
          paidAt:        new Date(),
          netRevenue:    fees.netRevenue,
          aggShare:      fees.aggShare,
          paylodeMargin: fees.paylodeMargin,
        },
      });

      // Fire webhook (non-blocking)
      if (merchant.webhookUrl) {
        dispatchWebhook(merchant.id, 'payment.success', formatTxn(updated)).catch(() => {});
      }

      ok(res, formatTxn(updated));
    } catch (e) { next(e); }
  }
);

// ── GET /api/v1/transactions ──────────────────────────────────────────────
// Works for merchants (their own) and admin (all)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { page=1, perPage=50, status, from, to, channel, currency } = req.query;
    const skip  = (parseInt(page)-1) * parseInt(perPage);
    const where = {};

    // Merchants see only their own transactions
    if (req.user.role === 'MERCHANT') {
      if (!req.user.merchant) return fail(res, 'No merchant account found');
      where.merchantId = req.user.merchant.id;
    }
    if (status)   where.status   = status.toUpperCase();
    if (channel)  where.channel  = channel.toUpperCase();
    if (currency) where.currency = currency.toUpperCase();
    if (from || to) where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to)   where.createdAt.lte = new Date(to + 'T23:59:59Z');

    const [txns, total] = await Promise.all([
      prisma.transaction.findMany({
        where, skip, take: parseInt(perPage),
        orderBy: { createdAt: 'desc' },
        include: { merchant: { select: { businessName:true, merchantCode:true }} },
      }),
      prisma.transaction.count({ where }),
    ]);

    ok(res, {
      data: txns.map(formatTxn),
      meta: { total, page: parseInt(page), perPage: parseInt(perPage), pages: Math.ceil(total/parseInt(perPage)) },
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/transactions/:ref/refund ─────────────────────────────────
router.post('/:ref/refund', requireAuth,
  validate([
    body('reason').notEmpty().withMessage('Reason required for refund'),
    body('amount').optional().isInt({ min: 1 }),
  ]),
  async (req, res, next) => {
    try {
      const txn = await prisma.transaction.findUnique({ where: { reference: req.params.ref } });
      if (!txn) return notFound(res, 'Transaction');
      if (txn.status !== 'SUCCESS') return fail(res, 'Can only refund successful transactions');

      const refundAmount = req.body.amount ? BigInt(req.body.amount) : txn.amount;
      if (refundAmount > txn.amount) return fail(res, 'Refund amount cannot exceed original transaction amount');

      await prisma.transaction.update({
        where: { id: txn.id }, data: { status: 'REVERSED' },
      });

      // Log AML flag for refund tracking
      await prisma.amlFlag.create({ data: {
        merchantId:    txn.merchantId,
        transactionId: txn.id,
        flagType:      'REFUND',
        riskLevel:     'LOW',
        status:        'CLOSED',
        description:   `Refund initiated: ${req.body.reason}`,
        resolvedAt:    new Date(),
      }});

      ok(res, { reference: txn.reference, refunded_amount: Number(refundAmount), status: 'REVERSED' }, 'Refund initiated');
    } catch (e) { next(e); }
  }
);

function formatTxn(t) {
  return {
    id:             t.id,
    reference:      t.reference,
    status:         t.status,
    amount:         Number(t.amount),
    amount_naira:   koboToNaira(t.amount),
    currency:       t.currency,
    channel:        t.channel,
    customer_email: t.customerEmail,
    fees: {
      merchant_fee:    Number(t.merchantFee),
      rail_cost:       Number(t.railCost),
      net_revenue:     Number(t.netRevenue),
      agg_share:       Number(t.aggShare),
      paylode_margin:  Number(t.paylodeMargin),
    },
    metadata:          t.metadata,
    failure_reason:    t.failureReason,
    authorization_url: t.authUrl,
    paid_at:           t.paidAt,
    created_at:        t.createdAt,
    sandbox:           t.isSandbox,
    merchant:          t.merchant,
  };
}

module.exports = router;
