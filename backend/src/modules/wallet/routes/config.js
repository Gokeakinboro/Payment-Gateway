'use strict';
// Per-merchant wallet config: the on/off toggle, white-label branding, ceiling.
// Admin/owner only (a departmental sub-user cannot change config).
const router = require('express').Router();
const { prisma, tenantAuth, getConfig } = require('../_shared');
const { ok, fail } = require('../../../utils/helpers');

router.use(tenantAuth);

const adminOnly = (req, res, next) =>
  req.walletTenant.isDeptUser ? fail(res, 'Only a merchant admin can change wallet settings', 'FORBIDDEN', 403) : next();

router.get('/', async (req, res, next) => {
  try {
    const c = await getConfig(req.walletTenant.merchantId);
    return ok(res, { ...c, max_balance: Number(c.max_balance), low_balance_default: Number(c.low_balance_default) });
  } catch (e) { next(e); }
});

// Upsert config. body: { enabled?, brand_name?, brand_logo_url?, brand_color?,
//   sender_email?, sender_whatsapp?, max_balance?, low_balance_default?, notify_email?, notify_whatsapp? }
router.put('/', adminOnly, async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const b = req.body || {};
    const maxBal = b.max_balance != null ? BigInt(parseInt(b.max_balance, 10) || 0) : 300000000n;
    const lowDef = b.low_balance_default != null ? BigInt(parseInt(b.low_balance_default, 10) || 0) : 0n;
    await prisma.$executeRawUnsafe(
      `INSERT INTO merchant_wallet_config
         (merchant_id, enabled, brand_name, brand_logo_url, brand_color, sender_email, sender_whatsapp,
          max_balance, low_balance_default, notify_email, notify_whatsapp)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (merchant_id) DO UPDATE SET
         enabled=EXCLUDED.enabled, brand_name=EXCLUDED.brand_name, brand_logo_url=EXCLUDED.brand_logo_url,
         brand_color=EXCLUDED.brand_color, sender_email=EXCLUDED.sender_email, sender_whatsapp=EXCLUDED.sender_whatsapp,
         max_balance=EXCLUDED.max_balance, low_balance_default=EXCLUDED.low_balance_default,
         notify_email=EXCLUDED.notify_email, notify_whatsapp=EXCLUDED.notify_whatsapp, updated_at=now()`,
      mid, b.enabled === undefined ? false : !!b.enabled,
      b.brand_name || null, b.brand_logo_url || null, b.brand_color || null,
      b.sender_email || null, b.sender_whatsapp || null, maxBal, lowDef,
      b.notify_email === undefined ? true : !!b.notify_email,
      b.notify_whatsapp === undefined ? true : !!b.notify_whatsapp);
    const c = await getConfig(mid);
    return ok(res, { ...c, max_balance: Number(c.max_balance), low_balance_default: Number(c.low_balance_default) }, 'Wallet settings saved');
  } catch (e) { next(e); }
});

module.exports = router;
