'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin, requireRole, requirePermission } = require('../middleware/auth');
const { ok, koboToNaira } = require('../utils/helpers');

// Activity-log actor classification.
const STAFF_ROLES    = ['SUPER_ADMIN', 'ADMIN', 'COMPLIANCE_OFFICER', 'AUDIT'];
const CUSTOMER_ROLES = ['MERCHANT', 'AGGREGATOR'];

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

// Activity log — permission-gated (view_audit_log) so SA can grant it to any role
// (AUDIT has it by default; SA bypasses). Staff vs customer split by actor role,
// plus action / entity / actor / date-range / free-text filters.
router.get('/audit-log', requireAuth, requirePermission('view_audit_log'), async (req,res,next) => {
  try {
    const { page=1, perPage=50, action, actorType, actorId, entityType, role, from, to, q } = req.query;
    const where = {};
    if (action)     where.action     = action;
    if (entityType) where.entityType = entityType;
    if (actorId)    where.actorId    = actorId;
    if (actorType === 'staff')    where.actor = { role: { in: STAFF_ROLES } };
    if (actorType === 'customer') where.actor = { role: { in: CUSTOMER_ROLES } };
    if (role)       where.actor = { role };   // specific-role filter (overrides the tab scope)
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   { const t = new Date(to); t.setHours(23,59,59,999); where.createdAt.lte = t; }
    }
    if (q) where.OR = [
      { action:     { contains: q, mode: 'insensitive' } },
      { entityType: { contains: q, mode: 'insensitive' } },
      { notes:      { contains: q, mode: 'insensitive' } },
      { actor: { email: { contains: q, mode: 'insensitive' } } },
    ];

    const [logs, total, actionRows] = await Promise.all([
      prisma.auditLog.findMany({ where, skip:(parseInt(page)-1)*parseInt(perPage), take:parseInt(perPage), orderBy:{createdAt:'desc'}, include:{actor:{select:{email:true,firstName:true,lastName:true,role:true}}} }),
      prisma.auditLog.count({ where }),
      prisma.$queryRaw`SELECT DISTINCT action FROM audit_log ORDER BY action`,
    ]);
    // id is BigInt — must be stringified for JSON.
    const data = logs.map(l => ({
      id: String(l.id), action: l.action, entity_type: l.entityType, entity_id: l.entityId,
      before: l.beforeState, after: l.afterState, notes: l.notes, ip: l.ipAddress,
      created_at: l.createdAt,
      actor: l.actor ? {
        email: l.actor.email,
        name: [l.actor.firstName, l.actor.lastName].filter(Boolean).join(' ') || l.actor.email,
        role: l.actor.role,
        is_staff: STAFF_ROLES.includes(l.actor.role),
      } : null,
    }));
    ok(res, { data, meta:{total, page:parseInt(page), pages:Math.ceil(total/parseInt(perPage)), actions: actionRows.map(a=>a.action)} });
  } catch(e){next(e);}
});

module.exports = router;
