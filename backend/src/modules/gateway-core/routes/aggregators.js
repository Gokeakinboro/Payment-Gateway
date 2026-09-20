'use strict';
const aggRouter = require('express').Router();
const bcrypt = require('bcryptjs');
const { prisma } = require('../../../utils/db');
const { requireAuth, requireSuperAdmin, requireAggregator, requirePermission } = require('../../../middleware/auth');
const { ok, fail, notFound, koboToNaira } = require('../../../utils/helpers');
const { logAudit } = require('../../../services/auditService');
const { sendEmail, getEmailContent } = require('../../../services/emailService');
const { logger } = require('../../../utils/logger');
const { hasPermission } = require('../../../config/permissions');

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
    const [aggs, vaPlat, payPlat] = await Promise.all([
      prisma.aggregator.findMany({
        include: { _count:{select:{merchants:true}}, user:{select:{email:true,firstName:true,lastName:true}} },
        orderBy: { createdAt:'desc' },
      }),
      prisma.platformRateConfig.findFirst({ where: { channel: 'VIRTUAL_ACCOUNT' } }),
      prisma.platformRateConfig.findFirst({ where: { channel: 'PAYOUT' } }),
    ]);
    const platVaRate   = vaPlat  ? Number(vaPlat.rate)    : 0;
    const platPayFloor = payPlat ? Number(payPlat.flatFee) : 0;
    const platVaCap    = vaPlat  ? Number(vaPlat.cap)      : 0;
    ok(res, aggs.map(a => redactAggContact({
      ...a,
      merchant_count:         a._count.merchants,
      _platform_va_rate:      platVaRate,
      _platform_payout_floor: platPayFloor,
      _platform_va_cap:       platVaCap,
    }, req.user)));
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
    const { company_name, rc_number, settlement_bank, settlement_account, revenue_split_pct, payout_floor_kobo, va_cap_kobo } = req.body;
    const data = {};
    if (company_name       !== undefined) data.companyName       = String(company_name).trim();
    if (rc_number          !== undefined) data.rcNumber          = rc_number || null;
    if (settlement_bank    !== undefined) data.settlementBank    = settlement_bank || null;
    if (settlement_account !== undefined) data.settlementAccount = settlement_account || null;
    if (revenue_split_pct  !== undefined) {
      const split = parseFloat(revenue_split_pct);
      if (isNaN(split) || split < 0 || split > 1) return fail(res, 'revenue_split_pct must be 0-1 (e.g. 0.30 for 30%)');
      data.revenueSplitPct = split;
    }
    // per-aggregator pricing overrides (null clears to platform default)
    if (payout_floor_kobo !== undefined)
      data.payoutFloorKobo = payout_floor_kobo === null ? null : BigInt(Math.max(0, Math.round(Number(payout_floor_kobo))));
    if (va_cap_kobo !== undefined)
      data.vaCapKobo = va_cap_kobo === null ? null : BigInt(Math.max(0, Math.round(Number(va_cap_kobo))));

    if (!Object.keys(data).length) return fail(res, 'Nothing to update');
    const updated = await prisma.aggregator.update({ where: { id: req.params.id }, data });
    await logAudit(req.user.id, 'AGGREGATOR_UPDATED', 'aggregators', updated.id, null, data, null, req.ip);
    ok(res, {
      aggregator_id:      updated.id,
      company_name:       updated.companyName,
      revenue_split_pct:  Number(updated.revenueSplitPct),
      payout_floor_kobo:  updated.payoutFloorKobo != null ? Number(updated.payoutFloorKobo) : null,
      va_cap_kobo:        updated.vaCapKobo        != null ? Number(updated.vaCapKobo)        : null,
    }, 'Aggregator updated');
  } catch (e) { next(e); }
});

// ── Per-merchant rate overrides (SA) ─────────────────────────────────────────

aggRouter.get('/:id/rates', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const agg = await prisma.aggregator.findUnique({ where:{id:req.params.id}, select:{id:true,companyName:true,revenueSplitPct:true,payoutFloorKobo:true,vaCapKobo:true} });
    if (!agg) return notFound(res);

    const overrides = await prisma.aggregatorRateConfig.findMany({
      where: { aggregatorId: req.params.id },
      include: { merchant: { select:{ id:true, businessName:true, merchantCode:true } } },
      orderBy: [{ merchantId: 'asc' }, { channel: 'asc' }],
    });

    ok(res, {
      aggregator_id:      agg.id,
      company_name:       agg.companyName,
      default_split_pct:  Number(agg.revenueSplitPct),
      payout_floor_kobo:  agg.payoutFloorKobo != null ? Number(agg.payoutFloorKobo) : null,
      va_cap_kobo:        agg.vaCapKobo        != null ? Number(agg.vaCapKobo)        : null,
      overrides: overrides.map(o => ({
        id:          o.id,
        merchant_id: o.merchantId,
        merchant:    o.merchant,
        channel:     o.channel,
        rate:        Number(o.rate),
        flat_fee:    Number(o.flatFee    || 0),
        min_charge:  Number(o.minCharge  || 0),
        max_charge:  Number(o.maxCharge  || 0),
        notes:       o.notes,
        created_at:  o.createdAt,
      })),
    });
  } catch(e){next(e);}
});

// SA sets a per-merchant per-channel rate override.
// channel: VIRTUAL_ACCOUNT | PAYOUT (required when merchant_id is set)
aggRouter.post('/:id/rates', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const { merchant_id = null, channel = 'VIRTUAL_ACCOUNT', rate, flat_fee, min_charge, notes } = req.body;
    const rateVal      = rate      != null ? parseFloat(rate)                                              : null;
    const flatFee      = flat_fee  != null ? BigInt(Math.max(0, Math.round(Number(flat_fee))))             : 0n;
    const minCharge    = min_charge!= null ? BigInt(Math.max(0, Math.round(Number(min_charge))))           : 0n;
    if (rateVal != null && (isNaN(rateVal) || rateVal < 0 || rateVal > 1)) return fail(res, 'rate must be 0-1');

    // no merchant_id → update aggregator's default VA base rate
    if (!merchant_id) {
      if (rateVal == null) return fail(res, 'rate required when updating default');
      const agg = await prisma.aggregator.update({ where:{id:req.params.id}, data:{revenueSplitPct:rateVal} });
      await logAudit(req.user.id,'AGG_DEFAULT_SPLIT_CHANGED','aggregators',agg.id,null,{rate:rateVal},notes);
      return ok(res,{aggregator_id:agg.id,default_split_pct:rateVal,scope:'default'});
    }

    const agg = await prisma.aggregator.findUnique({where:{id:req.params.id},select:{revenueSplitPct:true}});
    if (channel==='VIRTUAL_ACCOUNT' && rateVal != null && agg && rateVal < Number(agg.revenueSplitPct))
      return fail(res,`VA rate (${(rateVal*100).toFixed(2)}%) cannot be below aggregator base rate of ${(Number(agg.revenueSplitPct)*100).toFixed(2)}%`);

    const config = await prisma.aggregatorRateConfig.upsert({
      where: { aggregatorId_merchantId_channel: { aggregatorId: req.params.id, merchantId: merchant_id, channel } },
      create: { aggregatorId: req.params.id, merchantId: merchant_id, channel, rate: rateVal ?? 0, flatFee, minCharge, notes, setBy: req.user.id },
      update: { rate: rateVal ?? 0, flatFee, minCharge, notes, setBy: req.user.id, updatedAt: new Date() },
    });
    await logAudit(req.user.id,'AGG_MERCHANT_RATE_SET','aggregator_rate_configs',config.id,
      null,{merchant_id,channel,rate:rateVal,flat_fee:Number(flatFee),min_charge:Number(minCharge)},notes);
    ok(res, { id: config.id, merchant_id, channel, rate: Number(config.rate), flat_fee: Number(config.flatFee), min_charge: Number(config.minCharge), scope: 'merchant-override' });
  } catch(e){next(e);}
});

aggRouter.delete('/:id/rates/:merchantId', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const channel = req.query.channel || null;
    const where = channel
      ? { aggregatorId_merchantId_channel: { aggregatorId: req.params.id, merchantId: req.params.merchantId, channel } }
      : undefined;
    if (where) {
      const config = await prisma.aggregatorRateConfig.findUnique({ where });
      if (!config) return notFound(res);
      await prisma.aggregatorRateConfig.delete({ where: { id: config.id } });
      await logAudit(req.user.id,'AGG_MERCHANT_RATE_REMOVED','aggregator_rate_configs',config.id,config,null);
    } else {
      // delete all channels for this merchant
      await prisma.aggregatorRateConfig.deleteMany({ where: { aggregatorId: req.params.id, merchantId: req.params.merchantId } });
    }
    ok(res, { message: 'Override removed' });
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

// ── SA: list all agg_payouts (monthly margin buckets) ────────────────────────
aggRouter.get('/payouts', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rows = await prisma.aggPayout.findMany({
      orderBy: [{ periodMonth: 'desc' }, { createdAt: 'desc' }],
      include: { aggregator: { select: { id: true, companyName: true, settlementBank: true, settlementAccount: true } } },
    });
    ok(res, rows.map(r => ({
      id:                  r.id,
      aggregator_id:       r.aggregatorId,
      aggregator:          r.aggregator,
      period_month:        r.periodMonth,
      total_merchant_fees: Number(r.totalMerchantFees),
      rail_deduction:      Number(r.railDeduction),
      net_pool:            Number(r.netPool),
      agg_share_amount:    Number(r.aggShareAmount),
      txn_count:           r.txnCount,
      status:              r.status,
      paid_at:             r.paidAt,
      created_at:          r.createdAt,
    })));
  } catch (e) { next(e); }
});

// ── SA: mark an agg_payout as PAID ───────────────────────────────────────────
aggRouter.put('/payouts/:id/mark-paid', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const payout = await prisma.aggPayout.findUnique({ where: { id: req.params.id } });
    if (!payout) return notFound(res, 'Payout record not found');
    if (payout.status === 'PAID') return fail(res, 'Already marked as paid');
    const updated = await prisma.aggPayout.update({
      where: { id: payout.id },
      data:  { status: 'PAID', paidAt: new Date() },
    });
    await logAudit(req.user.id, 'AGG_PAYOUT_MARKED_PAID', 'agg_payouts', payout.id,
      { status: 'PENDING' }, { status: 'PAID', paid_at: updated.paidAt }, req.body.notes || null, req.ip);
    ok(res, { id: payout.id, status: 'PAID', paid_at: updated.paidAt }, 'Payout marked as paid');
  } catch (e) { next(e); }
});

// ── Aggregator self-service: view own rate config ────────────────────────────
aggRouter.get('/my/rates', requireAuth, requireAggregator, async (req, res, next) => {
  try {
    const agg = req.user.aggregator;
    if (!agg) return fail(res, 'No aggregator account');

    const [overrides, payoutPlatform, vaPlatform, fullAgg] = await Promise.all([
      prisma.aggregatorRateConfig.findMany({
        where: { aggregatorId: agg.id },
        include: { merchant: { select: { id: true, businessName: true, merchantCode: true } } },
        orderBy: [{ merchantId: 'asc' }, { channel: 'asc' }],
      }),
      prisma.platformRateConfig.findFirst({ where: { channel: 'PAYOUT' } }),
      prisma.platformRateConfig.findFirst({ where: { channel: 'VIRTUAL_ACCOUNT' } }),
      prisma.aggregator.findUnique({ where: { id: agg.id }, select: { revenueSplitPct: true, payoutFloorKobo: true, vaCapKobo: true } }),
    ]);

    const rawBasePct = Number(fullAgg?.revenueSplitPct ?? agg.revenueSplitPct);

    // Per-aggregator floor/cap overrides; fall back to platform defaults
    const platformPayoutFloor = payoutPlatform ? Number(payoutPlatform.flatFee) : 0;
    const platformVaCap       = vaPlatform     ? Number(vaPlatform.cap)         : 0;
    const platformVaRate      = vaPlatform     ? Number(vaPlatform.rate)        : 0;
    const basePct        = rawBasePct > 0 ? rawBasePct : platformVaRate;
    const payoutBaseCost = fullAgg?.payoutFloorKobo != null ? Number(fullAgg.payoutFloorKobo) : platformPayoutFloor;
    const vaCap          = fullAgg?.vaCapKobo        != null ? Number(fullAgg.vaCapKobo)        : platformVaCap;
    const vaMinCharge    = vaPlatform ? Number(vaPlatform.minCharge) : 0;

    // Group overrides by merchant for convenience
    const overrideMap = {};
    overrides.forEach(o => {
      if (!overrideMap[o.merchantId]) overrideMap[o.merchantId] = { merchant: o.merchant };
      overrideMap[o.merchantId][o.channel] = {
        rate:        Number(o.rate),
        flat_fee:    Number(o.flatFee    || 0),
        min_charge:  Number(o.minCharge  || 0),
        max_charge:  Number(o.maxCharge  || 0),
        notes:       o.notes,
        created_at:  o.createdAt,
      };
    });

    ok(res, {
      base_rate:         basePct,
      default_split_pct: basePct,           // backward compat
      platform_va_rate:  platformVaRate,    // raw platform default (0 = not set)
      payout_base_cost:  payoutBaseCost,    // Paylode's payout flat fee (kobo) — floor
      va_min_charge:     vaMinCharge,       // platform VA min charge (kobo) — info only
      va_cap:            vaCap,             // SA cap on VA (kobo) — read-only for agg
      overrides: Object.entries(overrideMap).map(([merchantId, data]) => ({
        merchant_id: merchantId,
        merchant:    data.merchant,
        va:          data['VIRTUAL_ACCOUNT'] || null,
        payout:      data['PAYOUT'] || null,
      })),
    });
  } catch (e) { next(e); }
});

// ── Aggregator self-service: set rate for one of their own merchants ──────────
// Body: { channel: 'VIRTUAL_ACCOUNT'|'PAYOUT', rate, flat_fee, min_charge, notes }
// rate, flat_fee, min_charge all optional; channel defaults to VIRTUAL_ACCOUNT.
aggRouter.put('/my/merchants/:merchantId/rates', requireAuth, requireAggregator, async (req, res, next) => {
  try {
    const agg = req.user.aggregator;
    if (!agg) return fail(res, 'No aggregator account');

    const merchant = await prisma.merchant.findFirst({
      where: { id: req.params.merchantId, aggregatorId: agg.id },
      select: { id: true, businessName: true },
    });
    if (!merchant) return fail(res, 'Merchant not found under your account', 'NOT_FOUND');

    const channel   = (req.body.channel || 'VIRTUAL_ACCOUNT').toUpperCase();
    if (!['VIRTUAL_ACCOUNT','PAYOUT'].includes(channel))
      return fail(res, 'channel must be VIRTUAL_ACCOUNT or PAYOUT');

    const rateVal   = req.body.rate      != null ? parseFloat(req.body.rate)                                    : 0;
    const flatFee   = req.body.flat_fee  != null ? BigInt(Math.max(0, Math.round(Number(req.body.flat_fee))))   : 0n;
    const minCharge = req.body.min_charge!= null ? BigInt(Math.max(0, Math.round(Number(req.body.min_charge)))) : 0n;

    if (isNaN(rateVal) || rateVal < 0 || rateVal > 1)
      return fail(res, 'rate must be between 0 and 1 (e.g. 0.035 for 3.5%)');

    // Floor guards
    const [fullAgg, payoutPlatform] = await Promise.all([
      prisma.aggregator.findUnique({ where: { id: agg.id }, select: { revenueSplitPct: true, payoutFloorKobo: true, vaCapKobo: true } }),
      prisma.platformRateConfig.findFirst({ where: { channel: 'PAYOUT' } }),
    ]);

    if (channel === 'VIRTUAL_ACCOUNT' && rateVal > 0 && fullAgg && rateVal < Number(fullAgg.revenueSplitPct))
      return fail(res, `VA rate (${(rateVal*100).toFixed(2)}%) cannot be below your base rate of ${(Number(fullAgg.revenueSplitPct)*100).toFixed(2)}%`);

    if (channel === 'PAYOUT') {
      // Use per-aggregator floor if SA set one, else platform default
      const platformPayoutFloor = payoutPlatform ? BigInt(payoutPlatform.flatFee) : 0n;
      const payoutFloor = fullAgg?.payoutFloorKobo != null ? BigInt(fullAgg.payoutFloorKobo) : platformPayoutFloor;
      if (flatFee > 0n && flatFee < payoutFloor)
        return fail(res, `Payout flat fee (₦${Number(flatFee)/100}) cannot be below your Paylode base cost of ₦${Number(payoutFloor)/100}`);
    }

    const config = await prisma.aggregatorRateConfig.upsert({
      where: { aggregatorId_merchantId_channel: { aggregatorId: agg.id, merchantId: merchant.id, channel } },
      create: { aggregatorId: agg.id, merchantId: merchant.id, channel, rate: rateVal, flatFee, minCharge, notes: req.body.notes || null, setBy: req.user.id },
      update: { rate: rateVal, flatFee, minCharge, notes: req.body.notes || null, setBy: req.user.id, updatedAt: new Date() },
    });
    await logAudit(req.user.id, 'AGG_SELF_SET_MERCHANT_RATE', 'aggregator_rate_configs', config.id,
      null, { merchant_id: merchant.id, channel, rate: rateVal, flat_fee: Number(flatFee), min_charge: Number(minCharge) }, req.body.notes || null, req.ip);
    ok(res, { merchant_id: merchant.id, merchant_name: merchant.businessName, channel, rate: rateVal, flat_fee: Number(flatFee), min_charge: Number(minCharge) },
      `Rate set for ${merchant.businessName}`);
  } catch (e) { next(e); }
});

// ── Aggregator self-service: remove a merchant rate override ─────────────────
// ?channel=VIRTUAL_ACCOUNT removes just that channel; omit to remove all
aggRouter.delete('/my/merchants/:merchantId/rates', requireAuth, requireAggregator, async (req, res, next) => {
  try {
    const agg = req.user.aggregator;
    if (!agg) return fail(res, 'No aggregator account');
    const channel = req.query.channel || null;
    if (channel) {
      const config = await prisma.aggregatorRateConfig.findUnique({
        where: { aggregatorId_merchantId_channel: { aggregatorId: agg.id, merchantId: req.params.merchantId, channel } },
      });
      if (!config) return notFound(res, 'Rate override not found');
      await prisma.aggregatorRateConfig.delete({ where: { id: config.id } });
      await logAudit(req.user.id, 'AGG_SELF_REMOVE_MERCHANT_RATE', 'aggregator_rate_configs', config.id, config, null, null, req.ip);
    } else {
      await prisma.aggregatorRateConfig.deleteMany({ where: { aggregatorId: agg.id, merchantId: req.params.merchantId } });
    }
    ok(res, { message: 'Override removed — merchant now uses your default rate' });
  } catch (e) { next(e); }
});

// ── Aggregator self-service: full transaction visibility ──────────────────────
aggRouter.get('/my/transactions', requireAuth, requireAggregator, async (req, res, next) => {
  try {
    const agg = req.user.aggregator;
    if (!agg) return fail(res, 'No aggregator account');

    const page    = Math.max(1, parseInt(req.query.page  || '1'));
    const limit   = Math.min(100, Math.max(1, parseInt(req.query.limit || '50')));
    const skip    = (page - 1) * limit;
    const status  = req.query.status  || undefined;
    const channel = req.query.channel || undefined;
    const from    = req.query.from ? new Date(req.query.from) : undefined;
    const to      = req.query.to   ? new Date(req.query.to)   : undefined;

    const merchants = await prisma.merchant.findMany({
      where: { aggregatorId: agg.id },
      select: { id: true },
    });
    const merchantIds = merchants.map(m => m.id);
    if (!merchantIds.length) return ok(res, { data: [], total: 0, page, limit });

    const where = {
      merchantId: { in: merchantIds },
      isSandbox:  false,
      ...(status  && { status: status.toUpperCase() }),
      ...(channel && { channel: channel.toUpperCase() }),
      ...(from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } },
    };

    const [txns, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { merchant: { select: { id: true, businessName: true, merchantCode: true } } },
      }),
      prisma.transaction.count({ where }),
    ]);

    ok(res, {
      data: txns.map(t => ({
        id:                  t.id,
        reference:           t.reference,
        merchant_id:         t.merchantId,
        merchant:            t.merchant,
        status:              t.status,
        channel:             t.channel,
        amount:              Number(t.amount),
        fee:                 Number(t.merchantFee),
        agg_share:           Number(t.aggShare),
        currency:            t.currency,
        customer_email:      t.customerEmail,
        created_at:          t.createdAt,
        paid_at:             t.paidAt,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (e) { next(e); }
});

// ── Aggregator self-service: daily earnings / margin breakdown ───────────────
aggRouter.get('/my/earnings', requireAuth, requireAggregator, async (req, res, next) => {
  try {
    const agg = req.user.aggregator;
    if (!agg) return fail(res, 'No aggregator account');

    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();
    const filterMerchantId = req.query.merchant_id || null;

    const merchants = await prisma.merchant.findMany({
      where: { aggregatorId: agg.id, ...(filterMerchantId && { id: filterMerchantId }) },
      select: { id: true, businessName: true, merchantCode: true },
    });
    const merchantIds = merchants.map(m => m.id);
    if (!merchantIds.length) return ok(res, { merchants: [], data: [], total_agg_share: 0, total_txn_count: 0 });

    const txns = await prisma.transaction.findMany({
      where: { merchantId: { in: merchantIds }, status: 'SUCCESS', isSandbox: false, createdAt: { gte: from, lte: to } },
      select: { merchantId: true, aggShare: true, merchantFee: true, amount: true, currency: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    const merchantMap = Object.fromEntries(merchants.map(m => [m.id, m.businessName]));
    const grouped = {};
    for (const t of txns) {
      const day = t.createdAt.toISOString().slice(0, 10);
      const key = `${day}|${t.merchantId}|${t.currency}`;
      if (!grouped[key]) grouped[key] = { day, merchant_id: t.merchantId, merchant_name: merchantMap[t.merchantId] || '', currency: t.currency, agg_share: 0, merchant_fees: 0, volume: 0, txn_count: 0 };
      grouped[key].agg_share    += Number(t.aggShare);
      grouped[key].merchant_fees += Number(t.merchantFee);
      grouped[key].volume       += Number(t.amount);
      grouped[key].txn_count++;
    }
    const data = Object.values(grouped).sort((a, b) => b.day.localeCompare(a.day) || a.merchant_name.localeCompare(b.merchant_name));

    const total_agg_share = data.reduce((s, r) => s + r.agg_share, 0);
    const total_txn_count = data.reduce((s, r) => s + r.txn_count, 0);

    ok(res, { merchants, data, total_agg_share, total_txn_count });
  } catch (e) { next(e); }
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
