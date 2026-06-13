'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin, requireCompliance } = require('../middleware/auth');
const { ok, fail, notFound, koboToNaira, generateApiKey, hashApiKey } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');

const VALID_CHANNELS = [
  'CARD_LOCAL',       // Local Naira-issued cards (Verve, local Visa/MC)
  'CARD_INTL',        // International / foreign-issued cards
  'VIRTUAL_ACCOUNT',  // Virtual account receipts / bank transfer in
  'USSD',             // USSD payments
  'PAYOUT',           // Outbound transfers (merchant sends money)
  'ALL',              // Applies to all channels (fallback)
  // Legacy aliases kept for backward compat
  'CARD', 'BANK_TRANSFER', 'DIRECT_DEBIT',
];
const VALID_FEE_MODELS = ['PCT', 'FLAT', 'PCT_PLUS_FLAT', 'GREATER_OF'];
const VALID_PRODUCT_GROUPS = ['CARDS', 'VIRTUAL_ACCOUNT', 'PAYOUT', 'CUSTOM'];

// ── Merchant list / own profile ──────────────────────────────────────────────

router.get('/', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role === 'MERCHANT') {
      const m = await prisma.merchant.findUnique({ where:{ id: req.user.merchant.id }, include:{ aggregator:{select:{companyName:true}} } });
      return ok(res, m);
    }
    const { page=1, perPage=20, kycStatus, aggregatorId } = req.query;
    const where = { isOutlet: false };  // top-level merchants only by default
    if (kycStatus)    where.kycStatus    = kycStatus;
    if (aggregatorId) where.aggregatorId = aggregatorId;
    const [data, total] = await Promise.all([
      prisma.merchant.findMany({ where, skip:(parseInt(page)-1)*parseInt(perPage), take:parseInt(perPage), orderBy:{createdAt:'desc'}, include:{aggregator:{select:{companyName:true}}, _count:{select:{outlets:true}}} }),
      prisma.merchant.count({ where }),
    ]);
    ok(res, { data, meta:{ total, page:parseInt(page), pages:Math.ceil(total/parseInt(perPage)) } });
  } catch (e) { next(e); }
});

// ── Legacy single rate (kept for backwards compat) ───────────────────────────

router.put('/:id/rate', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rate = parseFloat(req.body.processing_rate);
    if (isNaN(rate) || rate < 0 || rate > 0.1) return fail(res, 'processing_rate must be between 0 and 0.1');
    const before = await prisma.merchant.findUnique({ where:{id:req.params.id}, select:{processingRate:true} });
    const m = await prisma.merchant.update({ where:{id:req.params.id}, data:{processingRate:rate} });
    await logAudit(req.user.id, 'RATE_CHANGED', 'merchants', m.id, {processingRate:before?.processingRate}, {processingRate:rate}, req.body.notes);
    ok(res, { merchant_id:m.id, processing_rate:Number(m.processingRate) });
  } catch (e) { next(e); }
});

// ── Per-channel rate configs ─────────────────────────────────────────────────

router.get('/:id/rates', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.role === 'MERCHANT' ? req.user.merchant.id : req.params.id;
    const rates = await prisma.merchantRateConfig.findMany({
      where: { merchantId },
      orderBy: { channel: 'asc' },
    });
    ok(res, rates.map(r => ({
      ...r,
      rate:       Number(r.rate),
      flat_fee:   Number(r.flatFee),
      cap:        Number(r.cap),
      min_charge: Number(r.minCharge),
    })));
  } catch (e) { next(e); }
});

router.post('/:id/rates', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { channel, rate, flat_fee = 0, cap = 0, min_charge = 0, notes } = req.body;
    if (!VALID_CHANNELS.includes(channel)) return fail(res, `channel must be one of: ${VALID_CHANNELS.join(', ')}`);
    const rateNum = parseFloat(rate);
    if (isNaN(rateNum) || rateNum < 0 || rateNum > 0.2) return fail(res, 'rate must be between 0 and 0.2 (20%)');

    const config = await prisma.merchantRateConfig.upsert({
      where: { merchantId_channel: { merchantId: req.params.id, channel } },
      create: {
        merchantId: req.params.id,
        channel,
        rate:      rateNum,
        flatFee:   BigInt(Math.round(Number(flat_fee))),
        cap:       BigInt(Math.round(Number(cap))),
        minCharge: BigInt(Math.round(Number(min_charge))),
        notes,
        setBy: req.user.id,
      },
      update: {
        rate:      rateNum,
        flatFee:   BigInt(Math.round(Number(flat_fee))),
        cap:       BigInt(Math.round(Number(cap))),
        minCharge: BigInt(Math.round(Number(min_charge))),
        notes,
        setBy:     req.user.id,
        updatedAt: new Date(),
      },
    });

    await logAudit(req.user.id, 'MERCHANT_RATE_SET', 'merchant_rate_configs', config.id,
      null, { channel, rate: rateNum, flat_fee, cap, min_charge }, notes);

    ok(res, {
      ...config,
      rate:       Number(config.rate),
      flat_fee:   Number(config.flatFee),
      cap:        Number(config.cap),
      min_charge: Number(config.minCharge),
    });
  } catch (e) { next(e); }
});

router.delete('/:id/rates/:channel', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { id: merchantId, channel } = req.params;
    const existing = await prisma.merchantRateConfig.findUnique({
      where: { merchantId_channel: { merchantId, channel } },
    });
    if (!existing) return notFound(res);
    await prisma.merchantRateConfig.delete({ where: { merchantId_channel: { merchantId, channel } } });
    await logAudit(req.user.id, 'MERCHANT_RATE_DELETED', 'merchant_rate_configs', existing.id, existing, null);
    ok(res, { message: 'Rate config removed' });
  } catch (e) { next(e); }
});

// ── Outlets (sub-merchants) ──────────────────────────────────────────────────

router.get('/:id/outlets', requireAuth, async (req, res, next) => {
  try {
    const parentId = req.user.role === 'MERCHANT' ? req.user.merchant.id : req.params.id;
    const outlets = await prisma.merchant.findMany({
      where: { parentMerchantId: parentId, isOutlet: true },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { transactions: true } } },
    });
    ok(res, outlets);
  } catch (e) { next(e); }
});

router.post('/:id/outlets', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const parent = await prisma.merchant.findUnique({ where: { id: req.params.id } });
    if (!parent) return notFound(res);

    const { outlet_name, business_name, state, address, business_email, business_phone } = req.body;
    if (!outlet_name || !business_name || !state || !business_email || !business_phone) {
      return fail(res, 'outlet_name, business_name, state, business_email, business_phone are required');
    }

    const code = 'OUT-' + Math.random().toString(36).slice(2, 10).toUpperCase();

    // Create a user account for the outlet
    const bcrypt = require('bcryptjs');
    const tempPassword = Math.random().toString(36).slice(2, 12);
    const user = await prisma.user.create({
      data: {
        email: business_email,
        passwordHash: await bcrypt.hash(tempPassword, 10),
        firstName: business_name,
        lastName: '(Outlet)',
        role: 'MERCHANT',
      },
    });

    const outlet = await prisma.merchant.create({
      data: {
        userId:           user.id,
        merchantCode:     code,
        businessName:     business_name,
        businessType:     parent.businessType,
        category:         parent.category,
        state,
        address:          address || parent.address,
        businessEmail:    business_email,
        businessPhone:    business_phone,
        aggregatorId:     parent.aggregatorId,
        kycStatus:        'ACTIVE',         // inherits parent KYC coverage
        isActive:         true,
        settlementBank:   parent.settlementBank,
        settlementAccount:parent.settlementAccount,
        settlementCycle:  parent.settlementCycle,
        parentMerchantId: parent.id,
        isOutlet:         true,
        outletName:       outlet_name,
      },
    });

    await logAudit(req.user.id, 'OUTLET_CREATED', 'merchants', outlet.id, null,
      { parentMerchantId: parent.id, outletName: outlet_name });

    ok(res, { ...outlet, temp_password: tempPassword });
  } catch (e) { next(e); }
});

router.patch('/:id/outlets/:outletId', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const outlet = await prisma.merchant.findFirst({
      where: { id: req.params.outletId, parentMerchantId: req.params.id, isOutlet: true },
    });
    if (!outlet) return notFound(res);

    const { outlet_name, address, business_phone, is_active } = req.body;
    const updated = await prisma.merchant.update({
      where: { id: outlet.id },
      data: {
        ...(outlet_name  !== undefined && { outletName:    outlet_name }),
        ...(address      !== undefined && { address }),
        ...(business_phone !== undefined && { businessPhone: business_phone }),
        ...(is_active    !== undefined && { isActive:      is_active }),
      },
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

router.delete('/:id/outlets/:outletId', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const outlet = await prisma.merchant.findFirst({
      where: { id: req.params.outletId, parentMerchantId: req.params.id, isOutlet: true },
    });
    if (!outlet) return notFound(res);

    // Deactivate rather than hard delete (preserves transaction history)
    await prisma.merchant.update({
      where: { id: outlet.id },
      data: { isActive: false, kycStatus: 'SUSPENDED' },
    });
    await logAudit(req.user.id, 'OUTLET_DEACTIVATED', 'merchants', outlet.id, { isActive: true }, { isActive: false });
    ok(res, { message: 'Outlet deactivated' });
  } catch (e) { next(e); }
});

// ── Suspend / activate ───────────────────────────────────────────────────────

router.put('/:id/suspend', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const m = await prisma.merchant.update({ where:{id:req.params.id}, data:{kycStatus:'SUSPENDED',isActive:false} });
    await logAudit(req.user.id, 'MERCHANT_SUSPENDED', 'merchants', m.id, {isActive:true}, {isActive:false}, req.body.reason);
    ok(res, { message:'Merchant suspended' });
  } catch (e) { next(e); }
});

router.put('/:id/activate', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const m = await prisma.merchant.update({ where:{id:req.params.id}, data:{kycStatus:'ACTIVE',isActive:true} });
    await logAudit(req.user.id, 'MERCHANT_REACTIVATED', 'merchants', m.id, {isActive:false}, {isActive:true});
    ok(res, { message:'Merchant reactivated' });
  } catch (e) { next(e); }
});

// ── API keys ──────────────────────────────────────────────────────────────────

router.get('/me/api-keys', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const keys = await prisma.apiKey.findMany({
      where: { merchantId, isActive: true },
      select: { id:true, keyPrefix:true, label:true, isSandbox:true, lastUsedAt:true, createdAt:true },
      orderBy: { createdAt: 'desc' },
    });
    ok(res, keys);
  } catch (e) { next(e); }
});

router.post('/me/api-keys/rotate', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const { prefix } = req.body;
    if (!prefix) return fail(res, 'prefix required');
    await prisma.apiKey.updateMany({ where:{ merchantId, keyPrefix:prefix }, data:{ isActive:false } });
    const newKey = generateApiKey(prefix);
    await prisma.apiKey.create({ data:{ merchantId, keyHash:hashApiKey(newKey), keyPrefix:prefix, label:req.body.label||'Rotated Key', isSandbox:prefix.includes('test') } });
    ok(res, { key:newKey, prefix, message:'Key rotated. Save this key now — it will not be shown again.' });
  } catch (e) { next(e); }
});

// ── Merchant self-service profile update ─────────────────────────────────────
router.put('/me/profile', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const allowed = ['businessPhone','address','website'];
    const data = {};
    for (const key of allowed) { if (req.body[key] !== undefined) data[key] = req.body[key]; }
    if (!Object.keys(data).length) return fail(res, 'No updatable fields provided');
    const m = await prisma.merchant.update({ where:{ id:merchantId }, data });
    await logAudit(req.user.id, 'MERCHANT_PROFILE_UPDATE', 'merchants', merchantId, {}, data);
    ok(res, m, 'Profile updated');
  } catch (e) { next(e); }
});

// ── Settlement bank update (merchant self-service) ────────────────────────────
router.put('/me/settlement', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const { settlementBank, settlementAccount, settlementAccountName } = req.body;
    if (!settlementBank || !settlementAccount || !settlementAccountName)
      return fail(res, 'Bank, account number and account name are required');
    const m = await prisma.merchant.update({
      where: { id: merchantId },
      data:  { settlementBank, settlementAccount, settlementAccountName, settleVerifyStatus: 'pending_manual' },
    });
    await logAudit(req.user.id, 'SETTLEMENT_BANK_UPDATE', 'merchants', merchantId, {}, { settlementBank, settlementAccount });
    ok(res, m, 'Settlement details submitted for verification');
  } catch (e) { next(e); }
});

// ── Platform-wide default rate configs ───────────────────────────────────────
// GET /api/v1/merchants/platform-rates — any authenticated user can read defaults
// Response includes the available rails so the UI can render a "default rail" selector.
router.get('/platform-rates', requireAuth, async (req, res, next) => {
  try {
    const { group } = req.query;
    const where = group ? { productGroup: group } : {};
    const [rates, rails] = await Promise.all([
      prisma.platformRateConfig.findMany({ where, orderBy: [{ productGroup: 'asc' }, { channel: 'asc' }] }),
      prisma.paymentRail.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: 'asc' } }),
    ]);
    const railMap = {};
    rails.forEach(r => { railMap[r.id] = r.name; });
    ok(res, {
      rates: rates.map(r => _serializeRate(r, railMap)),
      rails: rails.map(r => ({ id: r.id, name: r.name, status: r.status })),
    });
  } catch (e) { next(e); }
});

// PUT /api/v1/merchants/platform-rates — super admin sets or updates a channel default
router.put('/platform-rates', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const {
      channel, rate = 0, flat_fee = 0, cap = 0, min_charge = 0,
      fee_model = 'PCT', vat_rate = 0.075,
      product_group = 'OTHER', label, description, notes,
      is_custom = false, default_rail_id, txn_channel,
    } = req.body;

    if (!channel) return fail(res, 'channel is required');
    // Allow custom channels (CUSTOM_*), international-card scheme channels (CARD_INTL_*), plus standard ones
    if (!channel.startsWith('CUSTOM_') && !channel.startsWith('CARD_INTL_') && !VALID_CHANNELS.includes(channel))
      return fail(res, `channel must be one of: ${VALID_CHANNELS.join(', ')}, or start with CUSTOM_ / CARD_INTL_`);
    if (!VALID_FEE_MODELS.includes(fee_model))
      return fail(res, `fee_model must be one of: ${VALID_FEE_MODELS.join(', ')}`);

    const rateNum   = parseFloat(rate);
    const vatRateNum= parseFloat(vat_rate);
    if (isNaN(rateNum) || rateNum < 0 || rateNum > 1)
      return fail(res, 'rate must be between 0 and 1.0 (100%)');
    if (isNaN(vatRateNum) || vatRateNum < 0 || vatRateNum > 1)
      return fail(res, 'vat_rate must be between 0 and 1.0');

    const data = {
      productGroup:  product_group,
      feeModel:      fee_model,
      rate:          rateNum,
      flatFee:       BigInt(Math.round(Number(flat_fee))),
      cap:           BigInt(Math.round(Number(cap))),
      minCharge:     BigInt(Math.round(Number(min_charge))),
      vatRate:       vatRateNum,
      defaultRailId: default_rail_id || null,
      txnChannel:    txn_channel || null,
      label,
      description,
      notes,
      isCustom:      Boolean(is_custom),
      setBy:         req.user.id,
    };

    const config = await prisma.platformRateConfig.upsert({
      where:  { channel },
      create: { channel, ...data },
      update: { ...data, updatedAt: new Date() },
    });

    await logAudit(req.user.id, 'PLATFORM_RATE_SET', 'platform_rate_configs', config.id,
      null, { channel, fee_model, rate: rateNum, flat_fee, cap, min_charge, vat_rate: vatRateNum }, notes);

    ok(res, _serializeRate(config), 'Platform default rate updated');
  } catch (e) { next(e); }
});

// DELETE /api/v1/merchants/platform-rates/:channel — super admin deletes a custom charge
router.delete('/platform-rates/:channel', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { channel } = req.params;
    const existing = await prisma.platformRateConfig.findUnique({ where: { channel } });
    if (!existing) return notFound(res, 'Rate config');
    // Custom charges and international-card scheme overrides can be deleted; standard products cannot.
    if (!existing.isCustom && !channel.startsWith('CARD_INTL_'))
      return fail(res, 'Only custom charges and card-scheme overrides can be deleted. Standard product rates can be disabled but not deleted.');
    await prisma.platformRateConfig.delete({ where: { channel } });
    await logAudit(req.user.id, 'PLATFORM_RATE_DELETED', 'platform_rate_configs', existing.id, existing, null);
    ok(res, null, 'Custom charge deleted');
  } catch (e) { next(e); }
});

// Helper to serialize a rate config for API responses
function _serializeRate(r, railMap = {}) {
  return {
    id:               r.id,
    channel:          r.channel,
    product_group:    r.productGroup,
    fee_model:        r.feeModel,
    label:            r.label,
    description:      r.description,
    notes:            r.notes,
    is_custom:        r.isCustom,
    is_active:        r.isActive,
    rate:             Number(r.rate),
    rate_pct:         (Number(r.rate) * 100).toFixed(4) + '%',
    flat_fee:         Number(r.flatFee),
    flat_fee_naira:   Number(r.flatFee) / 100,
    cap:              Number(r.cap),
    cap_naira:        Number(r.cap) / 100,
    min_charge:       Number(r.minCharge),
    min_charge_naira: Number(r.minCharge) / 100,
    vat_rate:         Number(r.vatRate),
    vat_rate_pct:     (Number(r.vatRate) * 100).toFixed(1) + '%',
    default_rail_id:  r.defaultRailId || null,
    default_rail_name:r.defaultRailId ? (railMap[r.defaultRailId] || null) : null,
    txn_channel:      r.txnChannel || null,
    set_by:           r.setBy,
    updated_at:       r.updatedAt,
  };
}

// ── Admin-facing API key routes (backward compat) ────────────────────────────
router.get('/:id/api-keys', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.role==='MERCHANT' ? req.user.merchant.id : req.params.id;
    const keys = await prisma.apiKey.findMany({ where:{merchantId,isActive:true}, select:{id:true,keyPrefix:true,label:true,isSandbox:true,lastUsedAt:true,createdAt:true}, orderBy:{createdAt:'desc'} });
    ok(res, keys);
  } catch (e) { next(e); }
});

router.post('/:id/api-keys/rotate', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.role==='MERCHANT' ? req.user.merchant.id : req.params.id;
    const { prefix } = req.body;
    if (!prefix) return fail(res, 'prefix required');
    await prisma.apiKey.updateMany({ where:{merchantId,keyPrefix:prefix}, data:{isActive:false} });
    const newKey = generateApiKey(prefix);
    await prisma.apiKey.create({ data:{ merchantId, keyHash:hashApiKey(newKey), keyPrefix:prefix, label:req.body.label||'Rotated Key', isSandbox:prefix.includes('test') } });
    ok(res, { key:newKey, prefix, message:'Key rotated. Save this — it will not be shown again.' });
  } catch (e) { next(e); }
});

// ── GET /api/v1/merchants/me — current merchant's own full profile ────────────
// MUST be registered before GET /:id so "me" is not treated as a UUID.
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account on this user');
    const m = await prisma.merchant.findUnique({
      where: { id: merchantId },
      include: {
        aggregator: { select: { companyName: true } },
        user:       { select: { email: true, firstName: true, lastName: true } },
      },
    });
    if (!m) return notFound(res, 'Merchant');
    ok(res, m);
  } catch (e) { next(e); }
});

// ── GET /api/v1/merchants/:id — single merchant detail (admin / staff) ─────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    // Merchants may only read their own record
    if (req.user.role === 'MERCHANT' && req.user.merchant?.id !== req.params.id)
      return fail(res, 'You can only view your own merchant profile', 'FORBIDDEN', 403);

    const m = await prisma.merchant.findUnique({
      where: { id: req.params.id },
      include: {
        aggregator: { select: { id: true, companyName: true } },
        user:       { select: { email: true, firstName: true, lastName: true } },
        _count:     { select: { outlets: true, transactions: true } },
      },
    });
    if (!m) return notFound(res, 'Merchant');
    ok(res, m);
  } catch (e) { next(e); }
});

module.exports = router;
