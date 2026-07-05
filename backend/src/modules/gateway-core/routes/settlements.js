'use strict';
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { requireAuth, requireCompliance, requirePermission } = require('../../../middleware/auth');
const { ok, fail, notFound, koboToNaira, generateRef } = require('../../../utils/helpers');
const settlementFire = require('../services/settlementFire');
const { generateSettlements } = require('../services/settlementProcess');

// Format a minor-unit amount in its currency (kobo→₦, cents→$)
function fmtMinor(minor, ccy) {
  const sym = ccy === 'USD' ? '$' : '₦';
  return sym + (Number(minor || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── GET /api/v1/settlements ───────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const where = req.user.role === 'MERCHANT' ? { merchantId: req.user.merchant.id } : {};
    const settlements = await prisma.settlement.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 200,
      include: { merchant: { select: { businessName: true, merchantCode: true, settlementBank: true, settlementAccount: true } } },
    });
    ok(res, settlements.map(s => ({
      ...s,
      // BigInt kobo fields can't be JSON-serialized — return as Numbers.
      grossAmount:   Number(s.grossAmount),
      feesDeducted:  Number(s.feesDeducted),
      netSettled:    Number(s.netSettled),
      currency:      s.currency || 'NGN',
      gross_major:   Number(s.grossAmount) / 100,
      fees_major:    Number(s.feesDeducted) / 100,
      net_major:     Number(s.netSettled) / 100,
      gross_display: fmtMinor(s.grossAmount, s.currency),
      fees_display:  fmtMinor(s.feesDeducted, s.currency),
      net_display:   fmtMinor(s.netSettled, s.currency),
      // legacy keys kept for any old callers
      gross_naira:   koboToNaira(s.grossAmount),
      net_naira:     koboToNaira(s.netSettled),
    })));
  } catch (e) { next(e); }
});

// ── GET /api/v1/settlements/:id/breakdown ─────────────────────────────────────
// Per-CHANNEL report for one settlement (CARD / BANK_TRANSFER / USSD / DIRECT_DEBIT):
// txn count, gross, fee, net for the settlement's (merchant, currency, period).
// SUPER_ADMIN additionally sees our **margin** per channel (profitability):
//   margin = Σ(merchant_fee − vat_output) − Σ(rail_cost − vat_input)
// Merchants see only their own settlement and never the margin fields.
router.get('/:id/breakdown', requireAuth, async (req, res, next) => {
  try {
    const s = await prisma.settlement.findUnique({ where: { id: req.params.id } });
    if (!s) return notFound(res, 'Settlement');
    if (req.user.role === 'MERCHANT' && s.merchantId !== req.user.merchant.id) return notFound(res, 'Settlement');
    const isSA = req.user.role === 'SUPER_ADMIN';

    const rows = await prisma.$queryRawUnsafe(
      `SELECT channel::text AS channel,
              COUNT(*)::int                                                   AS txn_count,
              COALESCE(SUM(amount),0)                                          AS gross,
              COALESCE(SUM(merchant_fee),0)                                    AS fee,
              COALESCE(SUM(amount - merchant_fee),0)                           AS net,
              COALESCE(SUM((merchant_fee - vat_output) - (rail_cost - vat_input)),0) AS margin
         FROM transactions
        WHERE merchant_id = $1::uuid AND currency = $2 AND status = 'SUCCESS' AND is_sandbox = false
          AND created_at >= $3 AND created_at < ($4::date + interval '1 day')
        GROUP BY channel ORDER BY channel`,
      s.merchantId, s.currency, s.periodStart, s.periodEnd);

    const channels = rows.map((r) => {
      const o = { channel: r.channel, txn_count: r.txn_count, gross: Number(r.gross), fee: Number(r.fee), net: Number(r.net) };
      if (isSA) o.margin = Number(r.margin);
      return o;
    });
    const totals = channels.reduce((t, c) => ({
      gross: t.gross + c.gross, fee: t.fee + c.fee, net: t.net + c.net, margin: t.margin + (c.margin || 0),
    }), { gross: 0, fee: 0, net: 0, margin: 0 });

    return ok(res, {
      settlement_id: s.id, currency: s.currency, status: s.status,
      period_start: s.periodStart, period_end: s.periodEnd,
      channels,
      totals: isSA ? totals : { gross: totals.gross, fee: totals.fee, net: totals.net },
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/settlements/process ──────────────────────────────────────────
// Generates one settlement PER (merchant, currency). USD intl-card txns settle in USD.
router.post('/process', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const sandbox = req.body.sandbox === true;
    // Idempotent shared generator (same one the daily cron uses) — safe to re-run.
    const out = await generateSettlements({ date: req.body.date, sandbox });
    const results = out.results.map(r => ({ ...r, net_display: fmtMinor(r.net_kobo, r.currency) }));

    const byCurrency = results.reduce((acc, r) => {
      acc[r.currency] = acc[r.currency] || { batches: 0, net_major: 0 };
      acc[r.currency].batches += 1;
      acc[r.currency].net_major += r.net_major;
      return acc;
    }, {});

    ok(res, {
      processed: out.processed,
      skipped:   out.skipped,
      date:      out.date,
      sandbox,
      by_currency: byCurrency,
      results,
      message: `${out.processed} settlement batch(es) created` + (out.skipped ? `, ${out.skipped} already existed` : ''),
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/settlements/:id/fire ─────────────────────────────────────────
// SUPER_ADMIN (always) or an admin SA has granted `edit_settlement_fire` releases a
// settlement's NET to the merchant's settlement bank via a chosen payout rail.
// body: { rail_id, scheduled_at? }. scheduled_at in the future → the worker fires it
// then; blank/near-now → fire immediately. FAILED settlements can be re-fired.
router.post('/:id/fire', requireAuth, requirePermission('edit_settlement_fire'), async (req, res, next) => {
  try {
    const { rail_id, scheduled_at } = req.body || {};
    if (!rail_id) return fail(res, 'A payout rail is required', 'RAIL_REQUIRED');
    const s = await prisma.settlement.findUnique({ where: { id: req.params.id } });
    if (!s) return notFound(res, 'Settlement');
    if (!['PENDING', 'FAILED'].includes(s.status)) return fail(res, `Settlement is ${s.status} — cannot fire`, 'NOT_FIREABLE', 409);

    // Validate the rail up-front for a clean error (before scheduling / sending money).
    const rr = await settlementFire.resolveFireRail(rail_id);
    if (rr.error) return fail(res, rr.error, 'RAIL_INVALID');

    if (scheduled_at) {
      const when = new Date(scheduled_at);
      if (isNaN(when.getTime())) return fail(res, 'Invalid schedule time');
      if (when.getTime() > Date.now() + 30000) {
        const okScheduled = await settlementFire.scheduleSettlement(s.id, { railId: rail_id, when, actorId: req.user.id });
        if (!okScheduled) return fail(res, 'Could not schedule (settlement no longer PENDING/FAILED)', 'NOT_FIREABLE', 409);
        return ok(res, { id: s.id, scheduled_at: when, rail_id }, `Settlement scheduled for ${when.toISOString()}`);
      }
    }

    const out = await settlementFire.fireSettlement(s.id, { railId: rail_id, actorId: req.user.id });
    if (out.ok) return ok(res, out, out.message);
    return fail(res, out.message, out.status || 'FIRE_FAILED', 400);
  } catch (e) { next(e); }
});

module.exports = router;
