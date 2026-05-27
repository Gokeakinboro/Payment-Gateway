'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireCompliance } = require('../middleware/auth');
const { ok, fail, koboToNaira, generateRef } = require('../utils/helpers');

router.get('/', requireAuth, async (req,res,next) => {
  try {
    const where = req.user.role==='MERCHANT' ? { merchantId:req.user.merchant.id } : {};
    const settlements = await prisma.settlement.findMany({ where, orderBy:{createdAt:'desc'}, take:100, include:{merchant:{select:{businessName:true,merchantCode:true}}} });
    ok(res, settlements.map(s=>({...s, gross_naira:koboToNaira(s.grossAmount), net_naira:koboToNaira(s.netSettled)})));
  } catch(e){next(e);}
});

router.post('/process', requireAuth, requireCompliance, async (req,res,next) => {
  try {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1); yesterday.setHours(0,0,0,0);
    const endOfYesterday = new Date(yesterday); endOfYesterday.setHours(23,59,59,999);
    const merchants = await prisma.merchant.findMany({ where:{isActive:true} });
    let processed = 0;
    for (const m of merchants) {
      const agg = await prisma.transaction.aggregate({
        where:{merchantId:m.id,status:'SUCCESS',isSandbox:false,createdAt:{gte:yesterday,lte:endOfYesterday}},
        _count:true, _sum:{amount:true,merchantFee:true},
      });
      if (!agg._count) continue;
      const gross = agg._sum.amount || 0n;
      const fees  = agg._sum.merchantFee || 0n;
      await prisma.settlement.create({ data:{
        merchantId:m.id, periodStart:yesterday, periodEnd:endOfYesterday,
        grossAmount:gross, feesDeducted:fees, netSettled:gross-fees,
        txnCount:agg._count, status:'PENDING', settlementRef:generateRef('SET'),
      }});
      processed++;
    }
    ok(res, { processed, date:yesterday.toISOString().split('T')[0], message:`${processed} settlement batches created` });
  } catch(e){next(e);}
});

module.exports = router;
