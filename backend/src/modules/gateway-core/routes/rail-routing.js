'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  SA Rail Routing Matrix API — per-CHANNEL routing (CARDS | VA | PAYOUT).
//    GET  /api/v1/routing/matrix                     → channel defaults + rail list
//    PUT  /api/v1/routing/defaults/:channel          → set the SA default for a channel
//    GET  /api/v1/routing/merchants                  → active merchants + per-channel overrides
//    GET  /api/v1/routing/merchant/:merchantId       → one merchant's effective routes
//    PUT  /api/v1/routing/merchant/:merchantId/:channel → set/clear a merchant override
//  All writes go through railRouting.js (matrix authoritative, legacy columns
//  kept in sync). SA only. Rails are Paylode-internal — never exposed to merchants.
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { requireAuth, requireSuperAdmin } = require('../../../middleware/auth');
const { ok, fail, notFound } = require('../../../utils/helpers');
const railRouting = require('../services/railRouting');

const CARD_ADAPTER_RE = /interswitch/i;   // rails with a built CARD adapter today

// All rails SA can route to, with per-channel eligibility hints for the dropdowns.
async function railList() {
  const rails = await prisma.paymentRail.findMany({
    select: { id: true, name: true, status: true, payoutEnabled: true },
    orderBy: { name: 'asc' },
  });
  return rails.map((r) => ({
    id: r.id, name: r.name, status: r.status, payout_enabled: r.payoutEnabled,
    eligible: {
      CARDS:  CARD_ADAPTER_RE.test(r.name),        // has a card adapter
      VA:     true,                                 // any rail may carry VA (cost row optional)
      PAYOUT: !!r.payoutEnabled,
    },
  }));
}

// GET the matrix: channel defaults + the rail list for the dropdowns.
router.get('/matrix', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const [channels, rails] = await Promise.all([railRouting.getMatrix(prisma), railList()]);
    ok(res, { channels, rails });
  } catch (e) { next(e); }
});

// PUT a channel's SA default. body { rail_id }.
router.put('/defaults/:channel', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rail_id = req.body && req.body.rail_id;
    if (!rail_id) return fail(res, 'A rail is required', 'RAIL_REQUIRED');
    const r = await railRouting.setChannelDefault(prisma, req.params.channel, rail_id, req.user.id);
    ok(res, r, `${r.channel} default set to ${r.rail_name}`);
  } catch (e) {
    if (e && e._client) return fail(res, e.message, e._code);
    next(e);
  }
});

// GET active merchants with their per-channel OVERRIDES (blank = uses the default).
router.get('/merchants', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT m.id::text AS merchant_id, m.business_name, m.merchant_code,
             mrr.channel, mrr.rail_id::text AS rail_id, pr.name AS rail_name
      FROM merchants m
      LEFT JOIN merchant_rail_routes mrr ON mrr.merchant_id = m.id
      LEFT JOIN payment_rails pr ON pr.id = mrr.rail_id
      WHERE m.is_active = true
      ORDER BY m.business_name ASC`;
    // Fold the LEFT-JOINed rows into one entry per merchant with a channel map.
    const byId = new Map();
    for (const r of rows) {
      let m = byId.get(r.merchant_id);
      if (!m) { m = { merchant_id: r.merchant_id, business_name: r.business_name, merchant_code: r.merchant_code, overrides: {} }; byId.set(r.merchant_id, m); }
      if (r.channel) m.overrides[r.channel] = { rail_id: r.rail_id, rail_name: r.rail_name };
    }
    ok(res, { merchants: [...byId.values()] });
  } catch (e) { next(e); }
});

// GET one merchant's effective routes (override → default) across all channels.
router.get('/merchant/:merchantId', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const m = await prisma.merchant.findUnique({ where: { id: req.params.merchantId }, select: { id: true, businessName: true } });
    if (!m) return notFound(res, 'Merchant');
    const routes = await railRouting.getMerchantRoutes(prisma, m.id);
    ok(res, { merchant_id: m.id, business_name: m.businessName, routes });
  } catch (e) { next(e); }
});

// PUT set/clear one merchant's override for a channel. body { rail_id } — null clears.
router.put('/merchant/:merchantId/:channel', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const m = await prisma.merchant.findUnique({ where: { id: req.params.merchantId }, select: { id: true } });
    if (!m) return notFound(res, 'Merchant');
    const rail_id = (req.body && req.body.rail_id) || null;
    const r = await railRouting.setMerchantRoute(prisma, m.id, req.params.channel, rail_id, req.user.id);
    ok(res, r, rail_id ? `${r.channel} route updated` : `${r.channel} override cleared — uses the default`);
  } catch (e) {
    if (e && e._client) return fail(res, e.message, e._code);
    next(e);
  }
});

module.exports = router;
