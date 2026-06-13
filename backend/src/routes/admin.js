'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { ok, koboToNaira } = require('../utils/helpers');

router.get('/dashboard', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    // Group by currency so NGN (local) and USD (international cards) stay separate.
    const [todayGroups, mtdGroups, merchantCount, aggCount, kycPending] = await Promise.all([
      prisma.transaction.groupBy({ by:['currency'], where:{createdAt:{gte:today},isSandbox:false,status:'SUCCESS'}, _count:true, _sum:{amount:true,merchantFee:true,paylodeMargin:true} }),
      prisma.transaction.groupBy({ by:['currency'], where:{createdAt:{gte:monthStart},isSandbox:false,status:'SUCCESS'}, _count:true, _sum:{amount:true,merchantFee:true,paylodeMargin:true} }),
      prisma.merchant.count({ where:{isActive:true} }),
      prisma.aggregator.count({ where:{status:'active'} }),
      prisma.kycSubmission.count({ where:{status:{in:['submitted','in_review']}} }),
    ]);

    // Always return both NGN and USD blocks (USD shows zeros until intl cards transact).
    const blankCcy = () => ({ txn_count:0, volume:0, fees:0, paylode_net:0 });
    const shape = (groups) => {
      const out = { NGN: blankCcy(), USD: blankCcy() };
      groups.forEach(g => {
        const c = (g.currency === 'USD') ? 'USD' : 'NGN';
        out[c] = {
          txn_count:   g._count,
          volume:      Number(g._sum.amount||0)/100,
          fees:        Number(g._sum.merchantFee||0)/100,
          paylode_net: Number(g._sum.paylodeMargin||0)/100,
        };
      });
      return out;
    };

    const todayBy = shape(todayGroups);
    const mtdBy   = shape(mtdGroups);

    ok(res, {
      // by_currency blocks (new — separated)
      today_by_currency: todayBy,
      mtd_by_currency:   mtdBy,
      // legacy NGN-only keys kept so existing UI keeps working
      today: { txn_count:todayBy.NGN.txn_count, volume:todayBy.NGN.volume, fees:todayBy.NGN.fees, paylode_net:todayBy.NGN.paylode_net },
      mtd:   { txn_count:mtdBy.NGN.txn_count,   volume:mtdBy.NGN.volume,   fees:mtdBy.NGN.fees,   paylode_net:mtdBy.NGN.paylode_net },
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
