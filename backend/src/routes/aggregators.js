'use strict';
const aggRouter = require('express').Router();
const bcrypt = require('bcryptjs');
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin, requireAggregator, requirePermission } = require('../middleware/auth');
const { ok, fail, notFound, koboToNaira } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');
const { sendEmail, getEmailContent } = require('../services/emailService');
const { logger } = require('../utils/logger');
const { hasPermission } = require('../config/permissions');

// #8: only viewers with view_merchant_contact (SUPER_ADMIN default) see contact PII.
function redactAggContact(a, viewer) {
  if (!a || hasPermission(viewer, 'view_merchant_contact')) return a;
  const copy = { ...a };
  ['email', 'phone', 'contactName', 'contactEmail', 'contactPhone'].forEach((f) => { if (f in copy) copy[f] = null; });
  if (copy.user) copy.user = { redacted: true };
  copy._contactRedacted = true;
  return copy;
}

// Read access for staff with view_aggregators (SA bypasses); contact redacted per #8.
aggRouter.get('/', requireAuth, requirePermission('view_aggregators'), async (req,res,next) => {
  try {
    const aggs = await prisma.aggregator.findMany({
      include: { _count:{select:{merchants:true}}, user:{select:{email:true,firstName:true,lastName:true}} },
      orderBy: { createdAt:'desc' },
    });
    ok(res, aggs.map(a => redactAggContact({ ...a, merchant_count: a._count.merchants }, req.user)));
  } catch(e){next(e);}
});

// ── POST /api/v1/aggregators — SA creates an aggregator (user + aggregator) ───
aggRouter.post('/', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const { company_name, contact_name, email, rc_number, split_pct, settlement_bank, settlement_account } = req.body;
    if (!company_name || !email) return fail(res, 'company_name and email are required');
    const lower = email.toLowerCase();
    if (await prisma.user.findUnique({ where:{ email: lower } })) return fail(res, 'Email already in use');

    const pct = Number(split_pct);
    const split = (isFinite(pct) && pct > 0) ? (pct > 1 ? pct/100 : pct) : 0;  // accept 30 or 0.30
    const tempPassword = Math.random().toString(36).slice(2,12) + Math.random().toString(36).slice(2,6).toUpperCase() + '!';
    const nameParts = (contact_name || company_name).trim().split(' ');

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: {
        email: lower, passwordHash: await bcrypt.hash(tempPassword, 12),
        firstName: nameParts[0], lastName: nameParts.slice(1).join(' ') || '(Aggregator)',
        role: 'AGGREGATOR', mustChangePassword: true,
      }});
      const agg = await tx.aggregator.create({ data: {
        userId: user.id, companyName: company_name, rcNumber: rc_number || null,
        revenueSplitPct: split, settlementBank: settlement_bank || null,
        settlementAccount: settlement_account || null, status: 'active',
      }});
      return { user, agg };
    });

    const loginUrl = (process.env.APP_URL || '') + '/login.html';
    const content = await getEmailContent('aggregator_welcome',
      { business: company_name, email: lower, temp_password: tempPassword, login_url: loginUrl },
      'Your Paylode aggregator account — first-time sign-in',
      `<h2>Welcome to Paylode</h2><p>An aggregator account for <strong>${company_name}</strong> has been created.</p>` +
        `<p>Sign in at <a href="${loginUrl}">the portal</a> with <strong>${lower}</strong> and temporary password <strong>${tempPassword}</strong>. You must change it on first sign-in.</p>`);
    sendEmail({ to: lower, subject: content.subject, html: content.html })
      .catch(e => logger.error({ err: e }, 'aggregator welcome email failed'));

    await logAudit(req.user.id, 'AGGREGATOR_CREATED', 'aggregators', result.agg.id, null,
      { company_name, email: lower, split_pct: split }, null, req.ip);
    ok(res, { aggregator_id: result.agg.id, company_name, email: lower, revenue_split_pct: split, temp_password: tempPassword },
      'Aggregator created and emailed a temporary password.');
  } catch(e){ next(e); }
});

// ── Default split (flat rate for entire aggregator) ───────────────────────────

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

// ── PUT /api/v1/aggregators/:id — SA edits aggregator details ────────────────
aggRouter.put('/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const agg = await prisma.aggregator.findUnique({ where: { id: req.params.id } });
    if (!agg) return notFound(res, 'Aggregator');
    const { company_name, rc_number, settlement_bank, settlement_account, revenue_split_pct } = req.body;
    const data = {};
    if (company_name      !== undefined) data.companyName       = String(company_name).trim();
    if (rc_number         !== undefined) data.rcNumber          = rc_number || null;
    if (settlement_bank   !== undefined) data.settlementBank    = settlement_bank || null;
    if (settlement_account!== undefined) data.settlementAccount = settlement_account || null;
    if (revenue_split_pct !== undefined) {
      const split = parseFloat(revenue_split_pct);
      if (isNaN(split) || split < 0 || split > 1) return fail(res, 'revenue_split_pct must be 0-1 (e.g. 0.30 for 30%)');
      data.revenueSplitPct = split;
    }
    if (!Object.keys(data).length) return fail(res, 'Nothing to update');
    const updated = await prisma.aggregator.update({ where: { id: req.params.id }, data });
    await logAudit(req.user.id, 'AGGREGATOR_UPDATED', 'aggregators', updated.id, null, data, null, req.ip);
    ok(res, { aggregator_id: updated.id, company_name: updated.companyName, revenue_split_pct: Number(updated.revenueSplitPct) }, 'Aggregator updated');
  } catch (e) { next(e); }
});

// ── Per-merchant split overrides ─────────────────────────────────────────────

aggRouter.get('/:id/rates', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const agg = await prisma.aggregator.findUnique({ where:{id:req.params.id}, select:{id:true,companyName:true,revenueSplitPct:true} });
    if (!agg) return notFound(res);

    const overrides = await prisma.aggregatorRateConfig.findMany({
      where: { aggregatorId: req.params.id },
      include: { merchant: { select:{ id:true, businessName:true, merchantCode:true } } },
      orderBy: { createdAt: 'desc' },
    });

    ok(res, {
      aggregator_id:    agg.id,
      company_name:     agg.companyName,
      default_split_pct: Number(agg.revenueSplitPct),
      overrides: overrides.map(o => ({
        id:          o.id,
        merchant_id: o.merchantId,
        merchant:    o.merchant,
        split_pct:   Number(o.splitPct),
        notes:       o.notes,
        created_at:  o.createdAt,
      })),
    });
  } catch(e){next(e);}
});

aggRouter.post('/:id/rates', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const { merchant_id = null, split_pct, notes } = req.body;
    const split = parseFloat(split_pct);
    if (isNaN(split) || split < 0 || split > 1) return fail(res, 'split_pct must be 0-1');

    // merchant_id = null means default override (replaces aggregator.revenueSplitPct)
    if (!merchant_id) {
      const agg = await prisma.aggregator.update({
        where: { id: req.params.id },
        data: { revenueSplitPct: split },
      });
      await logAudit(req.user.id, 'AGG_DEFAULT_SPLIT_CHANGED', 'aggregators', agg.id, null, { split_pct: split }, notes);
      return ok(res, { aggregator_id: agg.id, default_split_pct: split, scope: 'default' });
    }

    const config = await prisma.aggregatorRateConfig.upsert({
      where: { aggregatorId_merchantId: { aggregatorId: req.params.id, merchantId: merchant_id } },
      create: { aggregatorId: req.params.id, merchantId: merchant_id, splitPct: split, notes, setBy: req.user.id },
      update: { splitPct: split, notes, setBy: req.user.id, updatedAt: new Date() },
    });

    await logAudit(req.user.id, 'AGG_MERCHANT_SPLIT_SET', 'aggregator_rate_configs', config.id,
      null, { merchant_id, split_pct: split }, notes);

    ok(res, { ...config, split_pct: Number(config.splitPct), scope: 'merchant-override' });
  } catch(e){next(e);}
});

aggRouter.delete('/:id/rates/:merchantId', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const config = await prisma.aggregatorRateConfig.findUnique({
      where: { aggregatorId_merchantId: { aggregatorId: req.params.id, merchantId: req.params.merchantId } },
    });
    if (!config) return notFound(res);
    await prisma.aggregatorRateConfig.delete({ where: { id: config.id } });
    await logAudit(req.user.id, 'AGG_MERCHANT_SPLIT_REMOVED', 'aggregator_rate_configs', config.id, config, null);
    ok(res, { message: 'Override removed — merchant now uses aggregator default split' });
  } catch(e){next(e);}
});

// ── Aggregator self-service ───────────────────────────────────────────────────

// ── GET /api/v1/aggregators/:id/merchants — super admin views an aggregator's merchants ──
aggRouter.get('/:id/merchants', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const merchants = await prisma.merchant.findMany({
      where: { aggregatorId: req.params.id, isOutlet: false },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { outlets: true } } },
    });
    ok(res, merchants);
  } catch(e){ next(e); }
});

aggRouter.get('/my/merchants', requireAuth, requireAggregator, async (req,res,next) => {
  try {
    const agg = req.user.aggregator;
    if (!agg) return fail(res,'No aggregator account');
    const merchants = await prisma.merchant.findMany({
      where: { aggregatorId: agg.id, isOutlet: false },
      orderBy: { createdAt:'desc' },
      include: { _count: { select: { outlets: true } } },
    });
    ok(res, merchants);
  } catch(e){next(e);}
});

aggRouter.get('/my/revenue', requireAuth, requireAggregator, async (req,res,next) => {
  try {
    const agg = req.user.aggregator;
    if (!agg) return fail(res,'No aggregator account');

    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Aggregator's own merchants
    const merchants = await prisma.merchant.findMany({ where:{ aggregatorId: agg.id }, select:{ id:true } });
    const merchantIds = merchants.map(m => m.id);

    // Legacy monthly rollups (NGN)
    const months = await prisma.aggPayout.findMany({
      where:{ aggregatorId: agg.id }, orderBy:{ periodMonth:'desc' }, take:12,
    });

    // Live per-currency share — computed straight from transactions (no FX conversion)
    const blank = () => ({ agg_share:0, merchant_fees:0, txn_count:0 });
    const mtdBy = { NGN: blank(), USD: blank() };
    const allBy = { NGN: blank(), USD: blank() };

    if (merchantIds.length) {
      const [mtdGroups, allGroups] = await Promise.all([
        prisma.transaction.groupBy({
          by:['currency'],
          where:{ merchantId:{ in: merchantIds }, status:'SUCCESS', isSandbox:false, createdAt:{ gte: monthStart } },
          _sum:{ aggShare:true, merchantFee:true }, _count:true,
        }),
        prisma.transaction.groupBy({
          by:['currency'],
          where:{ merchantId:{ in: merchantIds }, status:'SUCCESS', isSandbox:false },
          _sum:{ aggShare:true, merchantFee:true }, _count:true,
        }),
      ]);
      const fill = (target, groups) => groups.forEach(g => {
        const c = g.currency === 'USD' ? 'USD' : 'NGN';
        target[c] = {
          agg_share:     Number(g._sum.aggShare||0)/100,
          merchant_fees: Number(g._sum.merchantFee||0)/100,
          txn_count:     g._count,
        };
      });
      fill(mtdBy, mtdGroups);
      fill(allBy, allGroups);
    }

    ok(res, {
      // legacy monthly list (NGN)
      data: months.map(m=>({ ...m,
        total_merchant_fees_naira: koboToNaira(m.totalMerchantFees),
        agg_share_naira:           koboToNaira(m.aggShareAmount),
      })),
      // live currency-separated shares (no conversion — NGN and USD reported side by side)
      share_mtd_by_currency: mtdBy,
      share_all_by_currency: allBy,
    });
  } catch(e){ next(e); }
});

// ── DELETE an aggregator — SUPER_ADMIN only. GUARDED hard delete. ─────────────
// Removes an aggregator ONLY if it has no sub-merchants and no payout history.
// Otherwise it must be retained (off-board the merchants first) → use closure.
aggRouter.delete('/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;
    const agg = await prisma.aggregator.findUnique({ where: { id } });
    if (!agg) return notFound(res, 'Aggregator not found');

    const [merchants, payouts] = await Promise.all([
      prisma.merchant.count({ where: { aggregatorId: id } }),
      prisma.aggPayout.count({ where: { aggregatorId: id } }),
    ]);
    const blockers = [];
    if (merchants) blockers.push(`${merchants} linked merchant(s)`);
    if (payouts)   blockers.push(`${payouts} payout record(s)`);
    if (blockers.length) {
      return res.status(409).json({
        status: false,
        error_code: 'AGGREGATOR_HAS_HISTORY',
        message: `This aggregator has ${blockers.join(' and ')} and cannot be deleted. Re-assign or off-board its merchants first.`,
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.aggregatorRateConfig.deleteMany({ where: { aggregatorId: id } });
      await tx.aggregator.delete({ where: { id } });
      await tx.user.delete({ where: { id: agg.userId } });
    });
    await logAudit(req.user.id, 'AGGREGATOR_DELETED', 'aggregators', id,
      { companyName: agg.companyName }, null, req.body?.reason || 'Hard delete (no merchants/payouts)');
    ok(res, { id }, 'Aggregator deleted');
  } catch (e) {
    if (e && e.code === 'P2003')
      return res.status(409).json({ status: false, error_code: 'AGGREGATOR_HAS_HISTORY',
        message: 'This aggregator is referenced by other records and cannot be deleted.' });
    next(e);
  }
});

module.exports = aggRouter;
