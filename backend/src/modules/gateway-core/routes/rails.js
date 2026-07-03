'use strict';
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { prisma }  = require('../../../utils/db');
const { requireAuth, requireSuperAdmin } = require('../../../middleware/auth');
const { ok, created, fail, notFound, koboToNaira } = require('../../../utils/helpers');
const { logAudit } = require('../../../services/auditService');

const SERVICE_TYPES = ['VISA','MASTERCARD','VERVE','BANK_TRANSFER','VIRTUAL_ACCOUNT','PAY_WITH_TRANSFER','PAY_WITH_WALLET','USSD','PAYOUT'];
const CHANNEL_MAP = { VISA:'CARD', MASTERCARD:'CARD', VERVE:'CARD', BANK_TRANSFER:'BANK_TRANSFER',
  VIRTUAL_ACCOUNT:'BANK_TRANSFER', PAY_WITH_TRANSFER:'BANK_TRANSFER', PAY_WITH_WALLET:'BANK_TRANSFER', USSD:'USSD', PAYOUT:'DIRECT_DEBIT' };

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ status:false, message:e.array()[0].msg, error_code:'VALIDATION_ERROR' });
  next();
};

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rails = await prisma.paymentRail.findMany({ orderBy: { name: 'asc' } });
    const costs = await prisma.$queryRaw`
      SELECT rail_id, service_type, rate, flat_fee, cap, min_charge, vat_rate
      FROM rail_costs WHERE effective_to IS NULL ORDER BY service_type`;
    const byRail = {};
    costs.forEach(c => {
      (byRail[c.rail_id] = byRail[c.rail_id] || []).push({
        service_type: c.service_type, rate: Number(c.rate),
        flat_fee: Number(c.flat_fee), cap: Number(c.cap),
        min_charge: Number(c.min_charge), vat_rate: Number(c.vat_rate),
      });
    });
    ok(res, rails.map(r => ({ ...r, costs: byRail[r.id] || [] })));
  } catch(e){next(e);}
});

// ── GET /api/v1/rails/providers-overview — SA service-provider overview ───────
// All vendors we pay (payment rails + screening providers), the products/services
// they offer us and their price to us. Rails merge LIVE status + our float.
router.get('/providers-overview', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { RAILS } = require('../../../config/serviceProviders');
    const live = await prisma.paymentRail.findMany({
      select: { name: true, status: true, payoutEnabled: true, floatBalance: true, floatSyncedAt: true, sponsorBank: true },
    });
    const liveByName = {}; live.forEach(r => { liveByName[r.name.toLowerCase()] = r; });
    const rails = RAILS.map(r => {
      const l = liveByName[r.name.toLowerCase()];
      return {
        ...r,
        registered: !!l,
        status: l ? l.status : 'not registered',
        payout_enabled: l ? l.payoutEnabled : false,
        float_balance: l ? Number(l.floatBalance) : null,
        float_naira: l ? koboToNaira(l.floatBalance) : null,
        float_synced_at: l ? l.floatSyncedAt : null,
        sponsor: (l && l.sponsorBank) || r.sponsor,
      };
    });
    // Screening/AML providers are now editable (DB) so SA can add/delete them.
    const screening = await prisma.$queryRaw`SELECT id, name, type, services, cost, status FROM service_providers ORDER BY name`;
    ok(res, { rails, screening });
  } catch (e) { next(e); }
});

// ── POST /api/v1/rails/service-providers — SA adds a screening/AML provider ──
router.post('/service-providers', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { name, type, services, cost, status } = req.body;
    if (!name || !String(name).trim()) return fail(res, 'Provider name is required');
    const rows = await prisma.$queryRaw`
      INSERT INTO service_providers (name, type, services, cost, status)
      VALUES (${String(name).trim()}, ${type||null}, ${services||null}, ${cost||null}, ${status||null}) RETURNING id`;
    await logAudit(req.user.id, 'SERVICE_PROVIDER_ADDED', 'service_providers', rows[0].id, null, { name, type });
    ok(res, { id: rows[0].id }, 'Service provider added');
  } catch (e) { next(e); }
});

// ── DELETE /api/v1/rails/service-providers/:id — SA deletes a provider ───────
router.delete('/service-providers/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    await prisma.$executeRaw`DELETE FROM service_providers WHERE id = ${req.params.id}::uuid`;
    await logAudit(req.user.id, 'SERVICE_PROVIDER_DELETED', 'service_providers', req.params.id, null, null);
    ok(res, { id: req.params.id }, 'Service provider deleted');
  } catch (e) { next(e); }
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

// A rail cost can be % (rate) and/or flat ₦ (flat_fee), with an optional max cap
// and/or min charge. At least one of rate / flat_fee is required.
router.put('/:id/costs', requireAuth, requireSuperAdmin,
  validate([
    body('service_type').isIn(SERVICE_TYPES).withMessage('Invalid service_type'),
    body('rate').optional().isFloat({ min:0, max:1 }).withMessage('rate must be a fraction 0-1'),
    body('flat_fee').optional().isInt({ min:0 }),
    body('cap').optional().isInt({ min:0 }),
    body('min_charge').optional().isInt({ min:0 }),
    body('vat_rate').optional().isFloat({ min:0, max:1 }),
    body().custom(b => Number(b.rate || 0) > 0 || Number(b.flat_fee || 0) > 0)
      .withMessage('Enter a percentage rate, a flat fee, or both'),
  ]),
  async (req, res, next) => {
    try {
      const rail = await prisma.paymentRail.findUnique({ where: { id: req.params.id } });
      if (!rail) return notFound(res, 'Rail');
      const { service_type, rate=0, flat_fee=0, cap=0, min_charge=0, vat_rate=0.075 } = req.body;

      // Version: close only the active cost for THIS service type on THIS rail.
      await prisma.$executeRaw`
        UPDATE rail_costs SET effective_to = NOW()::date
        WHERE rail_id = ${rail.id}::uuid AND service_type = ${service_type} AND effective_to IS NULL`;

      const cost = await prisma.$queryRaw`
        INSERT INTO rail_costs
          (rail_id, channel, service_type, rate, flat_fee, cap, min_charge, vat_rate, effective_from)
        VALUES
          (${rail.id}::uuid, ${CHANNEL_MAP[service_type]}::"Channel", ${service_type},
           ${Number(rate)}, ${BigInt(Math.round(flat_fee))}, ${BigInt(Math.round(cap))},
           ${BigInt(Math.round(min_charge))}, ${Number(vat_rate)}, NOW()::date)
        RETURNING id`;

      await logAudit(req.user.id, 'RAIL_COST_UPDATED', 'rail_costs', cost[0].id, null,
        { service_type, rate, flat_fee, cap, min_charge, vat_rate });
      ok(res, { id: cost[0].id, service_type }, 'Rail cost updated');
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

// ── DELETE /api/v1/rails/:id — SA deletes a rail. GUARDED. ───────────────────
// Refuses if the rail is in use (any disbursement/payout/transaction/wallet) or
// still holds our float. Otherwise removes the rail + its cost rows.
router.delete('/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;
    const rail = await prisma.paymentRail.findUnique({ where: { id } });
    if (!rail) return notFound(res, 'Rail');

    const [disb, items, wallets, txns] = await Promise.all([
      prisma.$queryRaw`SELECT count(*)::int n FROM rail_disbursements WHERE rail_id = ${id}::uuid`,
      prisma.$queryRaw`SELECT count(*)::int n FROM payout_items WHERE rail_id = ${id}::uuid`,
      prisma.$queryRaw`SELECT count(*)::int n FROM merchant_wallets WHERE rail_id = ${id}::uuid`,
      prisma.transaction.count({ where: { railId: id } }),
    ]);
    const blockers = [];
    if (disb[0].n)    blockers.push(`${disb[0].n} disbursement(s)`);
    if (items[0].n)   blockers.push(`${items[0].n} payout item(s)`);
    if (wallets[0].n) blockers.push(`${wallets[0].n} wallet(s)`);
    if (txns)         blockers.push(`${txns} transaction(s)`);
    if (rail.floatBalance > 0n) blockers.push(`a float balance of ₦${koboToNaira(rail.floatBalance).toLocaleString('en-NG')}`);
    if (blockers.length)
      return res.status(409).json({ status: false, error_code: 'RAIL_IN_USE',
        message: `Cannot delete ${rail.name}: it has ${blockers.join(', ')}. Set it Config-Only / move its traffic first.` });

    await prisma.$transaction(async (tx) => {
      await tx.railCost.deleteMany({ where: { railId: id } });
      await tx.paymentRail.delete({ where: { id } });
    });
    await logAudit(req.user.id, 'RAIL_DELETED', 'payment_rails', id, { name: rail.name }, null);
    ok(res, { id }, `${rail.name} deleted`);
  } catch (e) {
    if (e && e.code === 'P2003')
      return res.status(409).json({ status: false, error_code: 'RAIL_IN_USE', message: 'Rail is referenced by other records and cannot be deleted.' });
    next(e);
  }
});

module.exports = router;
