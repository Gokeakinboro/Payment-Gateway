'use strict';
const aggRouter = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin, requireAggregator } = require('../middleware/auth');
const { ok, fail, notFound, koboToNaira } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');

aggRouter.get('/', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const aggs = await prisma.aggregator.findMany({
      include: { _count:{select:{merchants:true}}, user:{select:{email:true,firstName:true,lastName:true}} },
      orderBy: { createdAt:'desc' },
    });
    ok(res, aggs.map(a => ({ ...a, merchant_count: a._count.merchants })));
  } catch(e){next(e);}
});

// ── Default split (flat rate for entire aggregator) ───────────────────────────

aggRouter.put('/:id/split', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const split = parseFloat(req.body.revenue_split_pct);
    if (isNaN(split)||split<0||split>1) return fail(res,'revenue_split_pct must be 0-1 (e.g. 0.30 for 30%)');
    const before = await prisma.aggregator.findUnique({where:{id:req.params.id},select:{revenueSplitPct:true}});
    const agg = await prisma.aggregator.update({where:{id:req.params.id},data:{revenueSplitPct:split}});
    await logAudit(req.user.id,'AGG_SPLIT_CHANGED','aggregators',agg.id,{revenueSplitPct:before?.revenueSplitPct},{revenueSplitPct:split},req.body.notes);
    ok(res,{aggregator_id:agg.id,revenue_split_pct:Number(agg.revenueSplitPct),message:'Split updated'});
  } catch(e){next(e);}
});

// ── Per-merchant split overrides ─────────────────────────────────────────────

aggRouter.get('/:id/rates', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const agg = await prisma.aggregator.findUnique({ where:{id:req.params.id}, select:{id:true,companyName:true,revenueSplitPct:true} });
    if (!agg) return notFound(res);

    const overrides = await prisma.aggregatorRateConfig.findMany({
      where: { aggregatorId: req.params.id },
      include: { merchant: { select:{ id:true, businessName:true, merchantCode:true } } },
      orderBy: { createdAt: 'desc' },
    });

    ok(res, {
      aggregator_id:    agg.id,
      company_name:     agg.companyName,
      default_split_pct: Number(agg.revenueSplitPct),
      overrides: overrides.map(o => ({
        id:          o.id,
        merchant_id: o.merchantId,
        merchant:    o.merchant,
        split_pct:   Number(o.splitPct),
        notes:       o.notes,
        created_at:  o.createdAt,
      })),
    });
  } catch(e){next(e);}
});

aggRouter.post('/:id/rates', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const { merchant_id = null, split_pct, notes } = req.body;
    const split = parseFloat(split_pct);
    if (isNaN(split) || split < 0 || split > 1) return fail(res, 'split_pct must be 0-1');

    // merchant_id = null means default override (replaces aggregator.revenueSplitPct)
    if (!merchant_id) {
      const agg = await prisma.aggregator.update({
        where: { id: req.params.id },
        data: { revenueSplitPct: split },
      });
      await logAudit(req.user.id, 'AGG_DEFAULT_SPLIT_CHANGED', 'aggregators', agg.id, null, { split_pct: split }, notes);
      return ok(res, { aggregator_id: agg.id, default_split_pct: split, scope: 'default' });
    }

    const config = await prisma.aggregatorRateConfig.upsert({
      where: { aggregatorId_merchantId: { aggregatorId: req.params.id, merchantId: merchant_id } },
      create: { aggregatorId: req.params.id, merchantId: merchant_id, splitPct: split, notes, setBy: req.user.id },
      update: { splitPct: split, notes, setBy: req.user.id, updatedAt: new Date() },
    });

    await logAudit(req.user.id, 'AGG_MERCHANT_SPLIT_SET', 'aggregator_rate_configs', config.id,
      null, { merchant_id, split_pct: split }, notes);

    ok(res, { ...config, split_pct: Number(config.splitPct), scope: 'merchant-override' });
  } catch(e){next(e);}
});

aggRouter.delete('/:id/rates/:merchantId', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const config = await prisma.aggregatorRateConfig.findUnique({
      where: { aggregatorId_merchantId: { aggregatorId: req.params.id, merchantId: req.params.merchantId } },
    });
    if (!config) return notFound(res);
    await prisma.aggregatorRateConfig.delete({ where: { id: config.id } });
    await logAudit(req.user.id, 'AGG_MERCHANT_SPLIT_REMOVED', 'aggregator_rate_configs', config.id, config, null);
    ok(res, { message: 'Override removed — merchant now uses aggregator default split' });
  } catch(e){next(e);}
});

// ── Aggregator self-service ───────────────────────────────────────────────────

// ── GET /api/v1/aggregators/:id/merchants — super admin views an aggregator's merchants ──
aggRouter.get('/:id/merchants', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const merchants = await prisma.merchant.findMany({
      where: { aggregatorId: req.params.id, isOutlet: false },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { outlets: true } } },
    });
    ok(res, merchants);
  } catch(e){ next(e); }
});

aggRouter.get('/my/merchants', requireAuth, requireAggregator, async (req,res,next) => {
  try {
    const agg = req.user.aggregator;
    if (!agg) return fail(res,'No aggregator account');
    const merchants = await prisma.merchant.findMany({
      where: { aggregatorId: agg.id, isOutlet: false },
      orderBy: { createdAt:'desc' },
      include: { _count: { select: { outlets: true } } },
    });
    ok(res, merchants);
  } catch(e){next(e);}
});

aggRouter.get('/my/revenue', requireAuth, requireAggregator, async (req,res,next) => {
  try {
    const agg = req.user.aggregator;
    const months = await prisma.aggPayout.findMany({
      where:{aggregatorId:agg.id},
      orderBy:{periodMonth:'desc'},
      take:12,
    });
    ok(res, months.map(m=>({ ...m,
      total_merchant_fees_naira: koboToNaira(m.totalMerchantFees),
      agg_share_naira:           koboToNaira(m.aggShareAmount),
    })));
  } catch(e){next(e);}
});

module.exports = aggRouter;
