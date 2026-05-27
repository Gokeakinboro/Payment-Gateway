'use strict';
// aggregators.js
const aggRouter = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin, requireAggregator } = require('../middleware/auth');
const { ok, fail, created, koboToNaira } = require('../utils/helpers');
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

aggRouter.get('/my/merchants', requireAuth, requireAggregator, async (req,res,next) => {
  try {
    const agg = req.user.aggregator;
    if (!agg) return fail(res,'No aggregator account');
    const merchants = await prisma.merchant.findMany({ where:{aggregatorId:agg.id}, orderBy:{createdAt:'desc'} });
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
