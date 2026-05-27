'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { ok, koboToNaira } = require('../utils/helpers');

router.get('/dashboard', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const [todayStats, mtdStats, merchantCount, aggCount, kycPending] = await Promise.all([
      prisma.transaction.aggregate({ where:{createdAt:{gte:today},isSandbox:false,status:'SUCCESS'}, _count:true, _sum:{amount:true,merchantFee:true,paylodeMargin:true} }),
      prisma.transaction.aggregate({ where:{createdAt:{gte:monthStart},isSandbox:false,status:'SUCCESS'}, _count:true, _sum:{amount:true,merchantFee:true,paylodeMargin:true} }),
      prisma.merchant.count({ where:{isActive:true} }),
      prisma.aggregator.count({ where:{status:'active'} }),
      prisma.kycSubmission.count({ where:{status:{in:['submitted','in_review']}} }),
    ]);
    ok(res, {
      today: { txn_count:todayStats._count, volume:koboToNaira(todayStats._sum.amount||0), fees:koboToNaira(todayStats._sum.merchantFee||0), paylode_net:koboToNaira(todayStats._sum.paylodeMargin||0) },
      mtd:   { txn_count:mtdStats._count,   volume:koboToNaira(mtdStats._sum.amount||0),   fees:koboToNaira(mtdStats._sum.merchantFee||0),   paylode_net:koboToNaira(mtdStats._sum.paylodeMargin||0) },
      active_merchants: merchantCount,
      active_aggregators: aggCount,
      kyc_pending: kycPending,
    });
  } catch(e){next(e);}
});

router.get('/audit-log', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const { page=1, perPage=50, action } = req.query;
    const where = action ? { action } : {};
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({ where, skip:(parseInt(page)-1)*parseInt(perPage), take:parseInt(perPage), orderBy:{createdAt:'desc'}, include:{actor:{select:{email:true,firstName:true,role:true}}} }),
      prisma.auditLog.count({ where }),
    ]);
    ok(res, { data:logs, meta:{total, page:parseInt(page), pages:Math.ceil(total/parseInt(perPage))} });
  } catch(e){next(e);}
});

module.exports = router;
