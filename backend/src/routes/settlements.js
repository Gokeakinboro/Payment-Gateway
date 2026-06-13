'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireCompliance } = require('../middleware/auth');
const { ok, fail, koboToNaira, generateRef } = require('../utils/helpers');

// Format a minor-unit amount in its currency (kobo→₦, cents→$)
function fmtMinor(minor, ccy) {
  const sym = ccy === 'USD' ? '$' : '₦';
  return sym + (Number(minor || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── GET /api/v1/settlements ───────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const where = req.user.role === 'MERCHANT' ? { merchantId: req.user.merchant.id } : {};
    const settlements = await prisma.settlement.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 200,
      include: { merchant: { select: { businessName: true, merchantCode: true, settlementBank: true, settlementAccount: true } } },
    });
    ok(res, settlements.map(s => ({
      ...s,
      currency:      s.currency || 'NGN',
      gross_major:   Number(s.grossAmount) / 100,
      fees_major:    Number(s.feesDeducted) / 100,
      net_major:     Number(s.netSettled) / 100,
      gross_display: fmtMinor(s.grossAmount, s.currency),
      fees_display:  fmtMinor(s.feesDeducted, s.currency),
      net_display:   fmtMinor(s.netSettled, s.currency),
      // legacy keys kept for any old callers
      gross_naira:   koboToNaira(s.grossAmount),
      net_naira:     koboToNaira(s.netSettled),
    })));
  } catch (e) { next(e); }
});

// ── POST /api/v1/settlements/process ──────────────────────────────────────────
// Generates one settlement PER (merchant, currency). USD intl-card txns settle in USD.
router.post('/process', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const sandbox = req.body.sandbox === true;
    const target  = req.body.date ? new Date(req.body.date) : (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d; })();
    target.setHours(0, 0, 0, 0);
    const periodStart = new Date(target);
    const periodEnd   = new Date(target); periodEnd.setHours(23, 59, 59, 999);

    // Group successful txns by merchant + currency for the day
    const groups = await prisma.transaction.groupBy({
      by: ['merchantId', 'currency'],
      where: { status: 'SUCCESS', isSandbox: sandbox, createdAt: { gte: periodStart, lte: periodEnd } },
      _count: true,
      _sum: { amount: true, merchantFee: true },
    });

    let processed = 0;
    const results = [];
    for (const g of groups) {
      if (!g._count) continue;
      const ccy   = g.currency || 'NGN';
      const gross = g._sum.amount || 0n;
      const fees  = g._sum.merchantFee || 0n;
      const net   = gross - fees;
      const s = await prisma.settlement.create({ data: {
        merchantId:   g.merchantId,
        currency:     ccy,
        periodStart, periodEnd,
        grossAmount:  gross,
        feesDeducted: fees,
        netSettled:   net,
        txnCount:     g._count,
        status:       'PENDING',
        settlementRef: generateRef(ccy === 'USD' ? 'SETUSD' : 'SET'),
      }});
      processed++;
      results.push({ merchant_id: g.merchantId, currency: ccy, txn_count: g._count,
        net_display: fmtMinor(net, ccy), net_major: Number(net) / 100 });
    }

    // Summary split by currency
    const byCurrency = results.reduce((acc, r) => {
      acc[r.currency] = acc[r.currency] || { batches: 0, net_major: 0 };
      acc[r.currency].batches += 1;
      acc[r.currency].net_major += r.net_major;
      return acc;
    }, {});

    ok(res, {
      processed,
      date: periodStart.toISOString().split('T')[0],
      sandbox,
      by_currency: byCurrency,
      results,
      message: `${processed} settlement batch(es) created across ${Object.keys(byCurrency).length} currenc(ies)`,
    });
  } catch (e) { next(e); }
});

module.exports = router;
