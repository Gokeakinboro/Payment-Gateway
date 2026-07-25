'use strict';
/**
 * Paylode — MPGS SA admin routes.
 * Manages per-merchant MPGS configs: stores Parallex-issued MID + MPGS API
 * password, and generates the Paylode gateway password that merchants use
 * to authenticate against our MPGS-mirrored endpoints.
 *
 * Merchant-facing charges are handled by the MPGS-mirrored gateway at /api/rest/*
 * (see mpgs-gateway.js). This file is internal/SA only.
 *
 *   GET    /api/v1/mpgs/admin               — list all MPGS-configured merchants
 *   GET    /api/v1/mpgs/admin/:merchantId   — get config (password hash only, never plaintext)
 *   PUT    /api/v1/mpgs/admin/:merchantId   — create or update config + issue gateway password
 *   POST   /api/v1/mpgs/admin/:merchantId/rotate-password  — rotate gateway password
 *   DELETE /api/v1/mpgs/admin/:merchantId   — deactivate config
 *
 *   GET    /api/v1/mpgs/status              — merchant checks their MPGS gateway status (requireApiKey)
 */
const router  = require('express').Router();
const crypto  = require('crypto');
const { prisma }  = require('../../../utils/db');
const { ok, fail, notFound, created } = require('../../../utils/helpers');
const { requireApiKey, requireAdmin } = require('../../../middleware/auth');

// ── Gateway password generation ───────────────────────────────────────────────
// Generates a strong API password for merchant → Paylode gateway auth.
// Format mirrors MPGS API password style (random alphanumeric).
// Returns { plaintext, hash, prefix } — store hash only; show plaintext once.
function generateGatewayPassword() {
  const plaintext = crypto.randomBytes(24).toString('base64url');  // 32-char URL-safe base64
  const hash      = crypto.createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash, prefix: plaintext.slice(0, 8) };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SA: list all configured merchants
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const configs = await prisma.merchantMpgsConfig.findMany({
      orderBy: { createdAt: 'desc' },
      include: { merchant: { select: { id: true, businessName: true, merchantCode: true } } },
    });
    return ok(res, configs.map(c => ({
      id:                    c.id,
      merchant:              c.merchant,
      mpgs_mid:              c.mpgsMid,
      mpgs_base_url:         c.mpgsBaseUrl,
      gateway_password_prefix: c.gatewayApiPasswordPrefix || null,
      is_active:             c.isActive,
      notes:                 c.notes,
      created_at:            c.createdAt,
      updated_at:            c.updatedAt,
    })));
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: get one merchant's config
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/:merchantId', requireAdmin, async (req, res, next) => {
  try {
    const config = await prisma.merchantMpgsConfig.findUnique({
      where:   { merchantId: req.params.merchantId },
      include: { merchant: { select: { id: true, businessName: true, merchantCode: true } } },
    });
    if (!config) return notFound(res, 'MPGS config');
    return ok(res, {
      id:                      config.id,
      merchant:                config.merchant,
      mpgs_mid:                config.mpgsMid,
      mpgs_base_url:           config.mpgsBaseUrl,
      gateway_password_prefix: config.gatewayApiPasswordPrefix || null,
      is_active:               config.isActive,
      notes:                   config.notes,
      created_at:              config.createdAt,
      updated_at:              config.updatedAt,
      // Connection parameters to share with merchant
      connection_parameters: {
        gateway_url:  `${process.env.APP_URL || 'https://api.paylodeservices.com'}/api/rest/version/77`,
        merchant_id:  config.mpgsMid,
        note:         'Use your gateway API password (issued at config creation or last rotation). Authenticate with: Basic base64(merchant.{merchant_id}:{api_password})',
      },
      // Real MPGS API password is never returned (write-only)
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: create or update config + issue gateway password
//  Body: { mpgs_mid, mpgs_api_password, mpgs_base_url, notes? }
//  Returns the gateway_api_password ONCE — must be shared with merchant immediately.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/admin/:merchantId', requireAdmin, async (req, res, next) => {
  try {
    const { merchantId } = req.params;
    const { mpgs_mid, mpgs_api_password, mpgs_base_url, notes } = req.body;

    const missing = [!mpgs_mid && 'mpgs_mid', !mpgs_api_password && 'mpgs_api_password', !mpgs_base_url && 'mpgs_base_url'].filter(Boolean);
    if (missing.length) return fail(res, `Missing required fields: ${missing.join(', ')}`);

    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true } });
    if (!merchant) return notFound(res, 'Merchant');

    const gw = generateGatewayPassword();

    const data = {
      mpgsMid:                 mpgs_mid.trim(),
      mpgsApiPassword:         mpgs_api_password.trim(),
      mpgsBaseUrl:             mpgs_base_url.trim().replace(/\/$/, ''),
      gatewayApiPasswordHash:  gw.hash,
      gatewayApiPasswordPrefix: gw.prefix,
      isActive:                true,
      notes:                   notes || null,
      createdBy:               req.user?.id || null,
    };

    const existing = await prisma.merchantMpgsConfig.findUnique({ where: { merchantId } });
    const cfg = existing
      ? await prisma.merchantMpgsConfig.update({ where: { merchantId }, data })
      : await prisma.merchantMpgsConfig.create({ data: { merchantId, ...data } });

    // Connection parameters to hand to the merchant — share securely, show once
    const gatewayUrl = `${process.env.APP_URL || 'https://api.paylodeservices.com'}/api/rest/version/77`;
    const response = {
      id:                  cfg.id,
      mpgs_mid:            cfg.mpgsMid,
      is_active:           cfg.isActive,
      // ⚠ SHOW ONCE — store securely and share with merchant immediately
      gateway_api_password: gw.plaintext,
      connection_parameters: {
        gateway_url:  gatewayUrl,
        merchant_id:  cfg.mpgsMid,
        api_password: gw.plaintext,
        note:         'This password will not be shown again. Share it securely with the merchant. They should set it as their MPGS API password in their integration.',
      },
    };

    return existing ? ok(res, response) : created(res, response);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: rotate gateway password (use when merchant reports credential compromise)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/admin/:merchantId/rotate-password', requireAdmin, async (req, res, next) => {
  try {
    const config = await prisma.merchantMpgsConfig.findUnique({ where: { merchantId: req.params.merchantId } });
    if (!config) return notFound(res, 'MPGS config');

    const gw = generateGatewayPassword();
    await prisma.merchantMpgsConfig.update({
      where: { merchantId: req.params.merchantId },
      data:  { gatewayApiPasswordHash: gw.hash, gatewayApiPasswordPrefix: gw.prefix },
    });

    return ok(res, {
      mpgs_mid:             config.mpgsMid,
      // ⚠ SHOW ONCE
      new_gateway_api_password: gw.plaintext,
      note: 'New password issued. The old password is immediately invalidated. Share the new password with the merchant securely.',
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: deactivate config
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/admin/:merchantId', requireAdmin, async (req, res, next) => {
  try {
    const config = await prisma.merchantMpgsConfig.findUnique({ where: { merchantId: req.params.merchantId } });
    if (!config) return notFound(res, 'MPGS config');
    await prisma.merchantMpgsConfig.update({ where: { merchantId: req.params.merchantId }, data: { isActive: false } });
    return ok(res, { deactivated: true });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Merchant: GET /status — check gateway configuration (requireApiKey)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', requireApiKey, async (req, res, next) => {
  try {
    const config = await prisma.merchantMpgsConfig.findUnique({
      where:  { merchantId: req.merchant.id },
      select: { isActive: true, mpgsMid: true, gatewayApiPasswordPrefix: true, createdAt: true },
    });
    const gatewayUrl = `${process.env.APP_URL || 'https://api.paylodeservices.com'}/api/rest/version/77`;
    return ok(res, {
      enabled:         !!(config && config.isActive),
      merchant_id:     config?.mpgsMid || null,
      gateway_url:     config?.isActive ? gatewayUrl : null,
      password_prefix: config?.gatewayApiPasswordPrefix || null,
      configured_at:   config?.createdAt || null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
