'use strict';
// Per-merchant wallet config. The merchant sets white-label branding + limits and
// can REQUEST the wallet, but ENABLING it is SA-only (see routes/admin.js) because
// it holds customer funds. Admin/owner only (a departmental sub-user cannot change).
const router = require('express').Router();
const { prisma, tenantAuth, getConfig } = require('../_shared');
const { ok, fail } = require('../../../utils/helpers');

router.use(tenantAuth);
const adminOnly = (req, res, next) =>
  req.walletTenant.isDeptUser ? fail(res, 'Only a merchant admin can change wallet settings', 'FORBIDDEN', 403) : next();
const shape = (c) => ({ ...c, max_balance: Number(c.max_balance), low_balance_default: Number(c.low_balance_default) });

router.get('/', async (req, res, next) => {
  try { return ok(res, shape(await getConfig(req.walletTenant.merchantId))); } catch (e) { next(e); }
});

// Merchant requests the wallet (onboarding tick / interest) → enters the SA queue.
router.post('/request', adminOnly, async (req, res, next) => {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO merchant_wallet_config (merchant_id, requested, requested_at)
         VALUES ($1::uuid, true, now())
       ON CONFLICT (merchant_id) DO UPDATE SET requested = true, requested_at = COALESCE(merchant_wallet_config.requested_at, now()), updated_at = now()`,
      req.walletTenant.merchantId);
    return ok(res, { requested: true }, 'Wallet requested — pending Paylode approval');
  } catch (e) { next(e); }
});

// Branding + limits (NOT the enabled switch — that is SA-only).
router.put('/', adminOnly, async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId; const b = req.body || {};
    const maxBal = b.max_balance != null ? BigInt(parseInt(b.max_balance, 10) || 0) : 300000000n;
    const lowDef = b.low_balance_default != null ? BigInt(parseInt(b.low_balance_default, 10) || 0) : 0n;
    await prisma.$executeRawUnsafe(
      `INSERT INTO merchant_wallet_config
         (merchant_id, brand_name, brand_logo_url, brand_color, sender_email, sender_whatsapp,
          max_balance, low_balance_default, notify_email, notify_whatsapp)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (merchant_id) DO UPDATE SET
         brand_name=EXCLUDED.brand_name, brand_logo_url=EXCLUDED.brand_logo_url, brand_color=EXCLUDED.brand_color,
         sender_email=EXCLUDED.sender_email, sender_whatsapp=EXCLUDED.sender_whatsapp,
         max_balance=EXCLUDED.max_balance, low_balance_default=EXCLUDED.low_balance_default,
         notify_email=EXCLUDED.notify_email, notify_whatsapp=EXCLUDED.notify_whatsapp, updated_at=now()`,
      mid, b.brand_name || null, b.brand_logo_url || null, b.brand_color || null,
      b.sender_email || null, b.sender_whatsapp || null, maxBal, lowDef,
      b.notify_email === undefined ? true : !!b.notify_email,
      b.notify_whatsapp === undefined ? true : !!b.notify_whatsapp);
    return ok(res, shape(await getConfig(mid)), 'Wallet settings saved');
  } catch (e) { next(e); }
});

module.exports = router;
