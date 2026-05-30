'use strict';
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { prisma }  = require('../utils/db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { ok, created, fail, notFound, koboToNaira } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');

const SERVICE_TYPES = ['VISA','MASTERCARD','VERVE','BANK_TRANSFER','USSD','PAYOUT'];

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ status:false, message:e.array()[0].msg, error_code:'VALIDATION_ERROR' });
  next();
};

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rails = await prisma.paymentRail.findMany({
      include: { costs: { where: { effectiveTo: null }, orderBy: { channel: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    ok(res, rails);
  } catch(e){next(e);}
});

router.get('/service-types', requireAuth, (req, res) => {
  ok(res, SERVICE_TYPES.map(t => ({
    value: t,
    label: t.replace(/_/g,' '),
    description: {
      VISA:'Visa card payments', MASTERCARD:'Mastercard payments',
      VERVE:'Verve card payments', BANK_TRANSFER:'NIP/NIBSS transfers',
      USSD:'USSD payments', PAYOUT:'Outbound disbursements',
    }[t],
  })));
});

router.post('/', requireAuth, requireSuperAdmin,
  validate([body('name').notEmpty()]),
  async (req, res, next) => {
    try {
      const rail = await prisma.paymentRail.create({
        data: { name: req.body.name, status: 'CONFIG_ONLY', notes: req.body.notes || null },
      });
      await logAudit(req.user.id, 'RAIL_CREATED', 'payment_rails', rail.id, null, { name: rail.name });
      created(res, rail, 'Rail created');
    } catch(e){next(e);}
  }
);

router.put('/:id/costs', requireAuth, requireSuperAdmin,
  validate([
    body('service_type').isIn(SERVICE_TYPES).withMessage('Invalid service_type'),
    body('rate').isFloat({ min:0, max:1 }).withMessage('rate must be 0-1'),
    body('fee_cap').optional().isInt({ min:0 }),
    body('merchant_cap').optional().isInt({ min:0 }),
    body('vat_rate').optional().isFloat({ min:0, max:1 }),
  ]),
  async (req, res, next) => {
    try {
      const rail = await prisma.paymentRail.findUnique({ where: { id: req.params.id } });
      if (!rail) return notFound(res, 'Rail');
      const { service_type, rate, fee_cap=0, merchant_cap=0, vat_rate=0.075 } = req.body;

      await prisma.railCost.updateMany({
        where: { railId: rail.id, effectiveTo: null },
        data: { effectiveTo: new Date() },
      });

      const channelMap = { VISA:'CARD', MASTERCARD:'CARD', VERVE:'CARD', BANK_TRANSFER:'BANK_TRANSFER', USSD:'USSD', PAYOUT:'DIRECT_DEBIT' };

      const cost = await prisma.$queryRaw`
        INSERT INTO rail_costs
          (rail_id, channel, service_type, rate, fee_cap, merchant_cap, vat_rate, effective_from)
        VALUES
          (${rail.id}::uuid, ${channelMap[service_type]}::"Channel",
           ${service_type}, ${Number(rate)}, ${BigInt(fee_cap)}, ${BigInt(merchant_cap)},
           ${Number(vat_rate)}, NOW()::date)
        RETURNING *
      `;

      await logAudit(req.user.id, 'RAIL_COST_UPDATED', 'rail_costs', cost[0].id, null,
        { service_type, rate, fee_cap, merchant_cap, vat_rate });

      ok(res, cost[0], 'Rail cost updated');
    } catch(e){next(e);}
  }
);

router.put('/:id/status', requireAuth, requireSuperAdmin,
  validate([body('status').isIn(['CONFIG_ONLY','TESTING','LIVE'])]),
  async (req, res, next) => {
    try {
      const rail = await prisma.paymentRail.update({ where:{ id:req.params.id }, data:{ status:req.body.status } });
      await logAudit(req.user.id, 'RAIL_STATUS_CHANGED', 'payment_rails', rail.id, null, { status:req.body.status });
      ok(res, rail, 'Rail status updated');
    } catch(e){next(e);}
  }
);

router.post('/routing-test', requireAuth, requireSuperAdmin,
  validate([body('service_type').isIn(SERVICE_TYPES), body('amount').isInt({ min:1 })]),
  async (req, res, next) => {
    try {
      const { service_type, amount } = req.body;
      const amt = BigInt(amount);

      const rails = await prisma.$queryRaw`
        SELECT rc.*, pr.name as rail_name
        FROM rail_costs rc
        JOIN payment_rails pr ON rc.rail_id = pr.id
        WHERE rc.service_type = ${service_type}
          AND rc.effective_to IS NULL
          AND pr.status = 'LIVE'
        ORDER BY rc.rate ASC
      `;

      const comparison = rails.map(rail => {
        const rate = Number(rail.rate);
        const cap  = BigInt(rail.fee_cap || 0);
        const vat  = Number(rail.vat_rate || 0.075);
        let costRaw = amt * BigInt(Math.round(rate * 1_000_000)) / 1_000_000n;
        if (cap > 0n && costRaw > cap) costRaw = cap;
        const costWithVat = costRaw + (costRaw * BigInt(Math.round(vat * 1_000_000)) / 1_000_000n);
        return {
          rail_name:     rail.rail_name,
          rate_pct:      (rate * 100).toFixed(3) + '%',
          cap_applied:   cap > 0n && (amt * BigInt(Math.round(rate * 1_000_000)) / 1_000_000n) > cap,
          cap_naira:     cap > 0n ? koboToNaira(cap) : 'No cap',
          cost_with_vat: koboToNaira(costWithVat),
          cost_raw:      koboToNaira(costRaw),
        };
      });

      const winner = comparison.length > 0
        ? comparison.reduce((a,b) => parseFloat(a.cost_with_vat) < parseFloat(b.cost_with_vat) ? a : b)
        : null;

      ok(res, {
        service_type,
        amount_naira: koboToNaira(amt),
        recommended_rail: winner?.rail_name || 'No live rails for this service type',
        comparison,
      });
    } catch(e){next(e);}
  }
);

module.exports = router;
