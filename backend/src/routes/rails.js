'use strict';
// ─── rails.js ─────────────────────────────────────────────────────────────────
const railRouter = require('express').Router();
const { body, validationResult } = require('express-validator');
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { ok, created, fail, notFound } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ status:false, message:e.array()[0].msg, error_code:'VALIDATION_ERROR' });
  next();
};

// GET all rails
railRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const rails = await prisma.paymentRail.findMany({
      include: { costs: { where: { effectiveTo: null }, orderBy: { channel: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    ok(res, rails);
  } catch (e) { next(e); }
});

// POST create rail
railRouter.post('/', requireAuth, requireSuperAdmin,
  validate([body('name').notEmpty().withMessage('Rail name required')]),
  async (req, res, next) => {
    try {
      const rail = await prisma.paymentRail.create({
        data: { name: req.body.name, status: 'CONFIG_ONLY', notes: req.body.notes },
      });
      await logAudit(req.user.id, 'RAIL_CREATED', 'payment_rails', rail.id, null, { name: rail.name });
      created(res, rail, 'Rail created');
    } catch (e) { next(e); }
  }
);

// PUT update rail costs
railRouter.put('/:id/costs', requireAuth, requireSuperAdmin,
  validate([
    body('channel').isIn(['CARD','BANK_TRANSFER','USSD','DIRECT_DEBIT']),
    body('rate').isFloat({ min:0, max:1 }).withMessage('Rate must be between 0 and 1 (e.g. 0.015 for 1.5%)'),
  ]),
  async (req, res, next) => {
    try {
      const rail = await prisma.paymentRail.findUnique({ where: { id: req.params.id } });
      if (!rail) return notFound(res, 'Rail');

      // Close existing active cost for this channel
      await prisma.railCost.updateMany({
        where: { railId: rail.id, channel: req.body.channel, effectiveTo: null },
        data:  { effectiveTo: new Date() },
      });

      // Insert new cost record
      const cost = await prisma.railCost.create({ data: {
        railId:        rail.id,
        channel:       req.body.channel,
        rate:          req.body.rate,
        effectiveFrom: new Date(),
      }});

      await logAudit(req.user.id, 'RAIL_COST_UPDATED', 'rail_costs', cost.id,
        { channel: req.body.channel }, { rate: req.body.rate });

      ok(res, cost, 'Rail cost updated');
    } catch (e) { next(e); }
  }
);

// PUT update rail status
railRouter.put('/:id/status', requireAuth, requireSuperAdmin,
  validate([body('status').isIn(['CONFIG_ONLY','TESTING','LIVE'])]),
  async (req, res, next) => {
    try {
      const rail = await prisma.paymentRail.update({
        where: { id: req.params.id },
        data:  { status: req.body.status },
      });
      await logAudit(req.user.id, 'RAIL_STATUS_CHANGED', 'payment_rails', rail.id, null, { status: req.body.status });
      ok(res, rail, 'Rail status updated');
    } catch (e) { next(e); }
  }
);

module.exports = railRouter;
