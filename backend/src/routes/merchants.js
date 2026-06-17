'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin, requireCompliance, requireAdmin, requireAdminOrCompliance, requirePermission } = require('../middleware/auth');
const { ok, fail, notFound, koboToNaira, generateApiKey, hashApiKey } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');
const { hasPermission } = require('../config/permissions');
const { sendEmail, getEmailContent } = require('../services/emailService');

// Field-level gate (#8): only viewers with view_merchant_contact (SUPER_ADMIN by
// default) may see merchant contact details. Strips PII from list/detail payloads.
const CONTACT_FIELDS = ['email', 'businessEmail', 'businessPhone', 'phone', 'address', 'website'];
function redactContact(m, viewer) {
  if (!m || hasPermission(viewer, 'view_merchant_contact')) return m;
  const copy = { ...m };
  CONTACT_FIELDS.forEach((f) => { if (f in copy) copy[f] = null; });
  if (copy.user) copy.user = { redacted: true };
  copy._contactRedacted = true;
  return copy;
}

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
    const safe = data.map((m) => redactContact(m, req.user));
    ok(res, { data: safe, meta:{ total, page:parseInt(page), pages:Math.ceil(total/parseInt(perPage)) } });
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
      vat_rate:   Number(r.vatRate),
    })));
  } catch (e) { next(e); }
});

router.post('/:id/rates', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { channel, rate, flat_fee = 0, cap = 0, min_charge = 0, vat_rate, notes } = req.body;
    if (!VALID_CHANNELS.includes(channel)) return fail(res, `channel must be one of: ${VALID_CHANNELS.join(', ')}`);
    const rateNum = parseFloat(rate);
    if (isNaN(rateNum) || rateNum < 0 || rateNum > 0.2) return fail(res, 'rate must be between 0 and 0.2 (20%)');
    const flatN   = Number(flat_fee);
    const vatNum  = (vat_rate !== undefined && !isNaN(parseFloat(vat_rate))) ? parseFloat(vat_rate) : 0.075;
    // Derive the fee model from what was entered (% and/or flat).
    const feeModel = (rateNum > 0 && flatN > 0) ? 'PCT_PLUS_FLAT' : (flatN > 0 && rateNum === 0 ? 'FLAT' : 'PCT');

    const config = await prisma.merchantRateConfig.upsert({
      where: { merchantId_channel: { merchantId: req.params.id, channel } },
      create: {
        merchantId: req.params.id,
        channel,    feeModel,
        rate:      rateNum,
        flatFee:   BigInt(Math.round(flatN)),
        cap:       BigInt(Math.round(Number(cap))),
        minCharge: BigInt(Math.round(Number(min_charge))),
        vatRate:   vatNum,
        notes,
        setBy: req.user.id,
      },
      update: {
        feeModel,
        rate:      rateNum,
        flatFee:   BigInt(Math.round(flatN)),
        cap:       BigInt(Math.round(Number(cap))),
        minCharge: BigInt(Math.round(Number(min_charge))),
        vatRate:   vatNum,
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

// Suspend / activate = a KYC decision: SA, Admin or Compliance Officer may act.
// (Activation despite OUTSTANDING documents still requires an SA deferral — that
//  path is the documents /defer endpoint, which is SUPER_ADMIN only.)
router.put('/:id/suspend', requireAuth, requireAdminOrCompliance, async (req, res, next) => {
  try {
    const m = await prisma.merchant.update({ where:{id:req.params.id}, data:{kycStatus:'SUSPENDED',isActive:false} });
    await logAudit(req.user.id, 'MERCHANT_SUSPENDED', 'merchants', m.id, {isActive:true}, {isActive:false}, req.body.reason);
    ok(res, { message:'Merchant suspended' });
  } catch (e) { next(e); }
});

router.put('/:id/activate', requireAuth, requireAdminOrCompliance, async (req, res, next) => {
  try {
    const m = await prisma.merchant.update({ where:{id:req.params.id}, data:{kycStatus:'ACTIVE',isActive:true} });
    await logAudit(req.user.id, 'MERCHANT_REACTIVATED', 'merchants', m.id, {isActive:false}, {isActive:true});
    // Notify the merchant their account is active (best-effort — never blocks the action).
    if (m.businessEmail) {
      const login = (process.env.APP_URL || 'https://paylodeservices.com') + '/login.html';
      getEmailContent('account_activated',
        { name: m.businessName, business: m.businessName, login_url: login },
        'Your Paylode account is active',
        `<h2>Your account is active</h2><p>Hi ${m.businessName},</p>` +
          `<p>Good news — your Paylode account has been <strong>activated</strong>. ` +
          `You can now sign in and use your live keys and dashboard.</p>` +
          `<p><a href="${login}">Sign in to Paylode</a></p>`)
        .then(c => sendEmail({ to: m.businessEmail, subject: c.subject, html: c.html }))
        .catch(() => {});
    }
    ok(res, { message:'Merchant reactivated' });
  } catch (e) { next(e); }
});

// Close (off-board) a merchant — SA + Admin only. Deactivates and marks closed.
router.put('/:id/close', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const m = await prisma.merchant.update({ where:{id:req.params.id}, data:{kycStatus:'SUSPENDED',isActive:false} });
    await logAudit(req.user.id, 'MERCHANT_CLOSED', 'merchants', m.id, {isActive:true}, {isActive:false, closed:true}, req.body.reason || 'Account closed');
    ok(res, { message:'Merchant account closed' });
  } catch (e) { next(e); }
});

// ── DELETE a merchant — SUPER_ADMIN only. GUARDED hard delete. ────────────────
// Permanently removes a merchant ONLY if it has no financial history (no
// transactions / settlements / payouts and no wallet balance) — i.e. test,
// duplicate or abandoned accounts. Accounts WITH history (or sub-merchant
// outlets) cannot be deleted for audit/compliance reasons → use Close instead.
router.delete('/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;
    const merchant = await prisma.merchant.findUnique({ where: { id } });
    if (!merchant) return notFound(res, 'Merchant not found');

    const [txns, setts, batches, outlets, fundedWallets] = await Promise.all([
      prisma.transaction.count({ where: { merchantId: id } }),
      prisma.settlement.count({ where: { merchantId: id } }),
      prisma.payoutBatch.count({ where: { merchantId: id } }),
      prisma.merchant.count({ where: { parentMerchantId: id } }),
      prisma.merchantWallet.count({ where: { merchantId: id, balance: { gt: 0n } } }),
    ]);
    const blockers = [];
    if (txns)          blockers.push(`${txns} transaction(s)`);
    if (setts)         blockers.push(`${setts} settlement(s)`);
    if (batches)       blockers.push(`${batches} payout batch(es)`);
    if (outlets)       blockers.push(`${outlets} sub-merchant outlet(s)`);
    if (fundedWallets) blockers.push('a funded wallet balance');
    if (blockers.length) {
      return res.status(409).json({
        status: false,
        error_code: 'MERCHANT_HAS_HISTORY',
        message: `This account has ${blockers.join(', ')} and cannot be deleted for audit/compliance. Use "Close" to off-board it instead.`,
      });
    }

    // No history — safe to hard delete. Remove dependents then the account + its
    // login user, all in ONE transaction so a partial delete can never happen.
    await prisma.$transaction(async (tx) => {
      await tx.apiKey.deleteMany({ where: { merchantId: id } });
      await tx.merchantWallet.deleteMany({ where: { merchantId: id } });
      await tx.kycSubmission.deleteMany({ where: { merchantId: id } });
      await tx.amlFlag.deleteMany({ where: { merchantId: id } });
      await tx.merchantRateConfig.deleteMany({ where: { merchantId: id } });
      await tx.aggregatorRateConfig.deleteMany({ where: { merchantId: id } });
      await tx.$executeRaw`DELETE FROM kyc_documents WHERE merchant_id = ${id}::uuid`;
      await tx.merchant.delete({ where: { id } });
      await tx.user.delete({ where: { id: merchant.userId } });
    });
    await logAudit(req.user.id, 'MERCHANT_DELETED', 'merchants', id,
      { businessName: merchant.businessName, businessEmail: merchant.businessEmail }, null,
      req.body?.reason || 'Hard delete (no financial history)');
    ok(res, { id }, 'Merchant deleted');
  } catch (e) {
    if (e && e.code === 'P2003')
      return res.status(409).json({ status: false, error_code: 'MERCHANT_HAS_HISTORY',
        message: 'This account is referenced by other records and cannot be deleted. Use "Close" instead.' });
    next(e);
  }
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

// ── Settlement bank CHANGE REQUEST (merchant self-service) ────────────────────
// #5: the change is held as PENDING and does NOT touch the live settlement fields
// until an admin/SA approves it. Payouts keep using the current verified account.
router.put('/me/settlement', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const { settlementBank, settlementAccount, settlementAccountName } = req.body;
    if (!settlementBank || !settlementAccount || !settlementAccountName)
      return fail(res, 'Bank, account number and account name are required');
    const m = await prisma.merchant.update({
      where: { id: merchantId },
      data:  {
        pendingSettlementBank: settlementBank,
        pendingSettlementAccount: settlementAccount,
        pendingSettlementAccountName: settlementAccountName,
        pendingSettlementAt: new Date(),
        settleVerifyStatus: 'pending_manual',
      },
    });
    await logAudit(req.user.id, 'SETTLEMENT_CHANGE_REQUESTED', 'merchants', merchantId, {}, { settlementBank, settlementAccount });
    ok(res, { settleVerifyStatus: m.settleVerifyStatus },
      'Settlement change submitted for approval. Your current account stays active until it is approved.');
  } catch (e) { next(e); }
});

// ── Settlement change queue (admin/SA) ────────────────────────────────────────
router.get('/settlement/pending', requireAuth, requirePermission('view_settlements'), async (req, res, next) => {
  try {
    const status = req.query.status || 'pending_manual';
    const where = (status === 'all') ? {}
      : (status === 'verified') ? { settleVerifyStatus: { in: ['verified', 'auto_verified', 'manual_approved'] } }
      : { settleVerifyStatus: status };
    const rows = await prisma.merchant.findMany({
      where: { ...where, isOutlet: false },
      orderBy: { pendingSettlementAt: 'desc' },
      select: {
        id: true, businessName: true, merchantCode: true,
        settlementBank: true, settlementAccount: true, settlementAccountName: true,
        pendingSettlementBank: true, pendingSettlementAccount: true, pendingSettlementAccountName: true,
        pendingSettlementAt: true,
        settleVerifyStatus: true, settleEnquiryName: true, settleVerifyNotes: true, settleVerifiedAt: true,
      },
    });
    ok(res, rows);
  } catch (e) { next(e); }
});

// Approve a pending settlement change → apply pending values to the live account.
router.put('/:id/settlement/approve', requireAuth, requirePermission('edit_settlements'), async (req, res, next) => {
  try {
    const id = req.params.id;
    const m = await prisma.merchant.findUnique({ where: { id } });
    if (!m) return notFound(res, 'Merchant');
    if (!m.pendingSettlementAccount)
      return fail(res, 'No pending settlement change to approve for this merchant');
    const updated = await prisma.merchant.update({
      where: { id },
      data: {
        settlementBank: m.pendingSettlementBank,
        settlementAccount: m.pendingSettlementAccount,
        settlementAccountName: m.pendingSettlementAccountName,
        settleVerifyStatus: 'verified',
        settleVerifyNotes: req.body.notes || 'Manually verified by administrator',
        settleVerifiedAt: new Date(),
        pendingSettlementBank: null, pendingSettlementAccount: null,
        pendingSettlementAccountName: null, pendingSettlementAt: null,
      },
    });
    await logAudit(req.user.id, 'SETTLEMENT_CHANGE_APPROVED', 'merchants', id, {}, { settlementAccount: updated.settlementAccount });
    ok(res, { id, settleVerifyStatus: updated.settleVerifyStatus }, 'Settlement account approved and applied');
  } catch (e) { next(e); }
});

// Reject a pending settlement change → discard pending; live account unchanged.
router.put('/:id/settlement/reject', requireAuth, requirePermission('edit_settlements'), async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!req.body.notes) return fail(res, 'A rejection reason is required');
    const m = await prisma.merchant.findUnique({ where: { id } });
    if (!m) return notFound(res, 'Merchant');
    await prisma.merchant.update({
      where: { id },
      data: {
        settleVerifyStatus: 'rejected',
        settleVerifyNotes: req.body.notes,
        pendingSettlementBank: null, pendingSettlementAccount: null,
        pendingSettlementAccountName: null, pendingSettlementAt: null,
      },
    });
    await logAudit(req.user.id, 'SETTLEMENT_CHANGE_REJECTED', 'merchants', id, {}, { reason: req.body.notes });
    ok(res, { id }, 'Settlement change rejected; merchant must resubmit');
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
    // Own record (MERCHANT viewing self) is never redacted; staff are gated by #8.
    ok(res, req.user.role === 'MERCHANT' ? m : redactContact(m, req.user));
  } catch (e) { next(e); }
});

module.exports = router;
