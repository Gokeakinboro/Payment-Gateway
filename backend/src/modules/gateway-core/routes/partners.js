'use strict';
/**
 * Paylode Partner Gateway — SA management + partner-facing API.
 *
 * Partners (e.g. Payonus) route their own merchants through Paylode's MPGS
 * gateway. Paylode sits in the middle for full AML/PEP/MCC visibility.
 *
 * SA routes  (JWT auth, SUPER_ADMIN / ADMIN):
 *   GET    /api/v1/partners                          — list all partners
 *   POST   /api/v1/partners                          — create partner + issue API key
 *   GET    /api/v1/partners/:id                      — partner detail
 *   PUT    /api/v1/partners/:id                      — update partner settings
 *   PUT    /api/v1/partners/:id/suspend              — suspend partner
 *   PUT    /api/v1/partners/:id/activate             — reactivate partner
 *   GET    /api/v1/partners/:id/merchants            — list partner's merchants
 *   PUT    /api/v1/partners/:id/merchants/:mid/configure  — SA sets MPGS MID + credentials
 *   PUT    /api/v1/partners/:id/merchants/:mid/kyc   — SA approve/reject KYC
 *   POST   /api/v1/partners/:id/rotate-key           — rotate partner API key
 *
 * Partner API (X-Partner-Key auth):
 *   POST   /api/v1/partners/gateway/merchants        — submit new merchant
 *   GET    /api/v1/partners/gateway/merchants        — list own merchants
 *   GET    /api/v1/partners/gateway/merchants/:id    — merchant status + connection params
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const { prisma }  = require('../../../utils/db');
const { ok, fail, notFound, created } = require('../../../utils/helpers');
const { requireAuth, requireAdmin }   = require('../../../middleware/auth');
const { logger } = require('../../../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateApiKey() {
  const plaintext = 'pk_' + crypto.randomBytes(28).toString('base64url');
  const hash      = crypto.createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash, prefix: plaintext.slice(0, 12) };
}

function generateGatewayPassword() {
  const plaintext = crypto.randomBytes(24).toString('base64url');
  const hash      = crypto.createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash, prefix: plaintext.slice(0, 8) };
}

// ── Partner API key middleware ─────────────────────────────────────────────────
async function requirePartnerKey(req, res, next) {
  const raw = req.headers['x-partner-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!raw) return fail(res, 'X-Partner-Key header required', 'UNAUTHORIZED', 401);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const partner = await prisma.partner.findFirst({ where: { apiKeyHash: hash, status: 'active' } });
  if (!partner) return fail(res, 'Invalid or inactive partner API key', 'UNAUTHORIZED', 401);
  req.partner = partner;
  next();
}

const VALID_KYC = ['none', 'basic', 'full'];

// ─────────────────────────────────────────────────────────────────────────────
//  SA: list all partners
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const partners = await prisma.partner.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { merchants: true } } },
    });
    return ok(res, partners.map(p => ({
      id: p.id, name: p.name, slug: p.slug,
      contact_email: p.contactEmail, contact_phone: p.contactPhone,
      kyc_requirement: p.kycRequirement, status: p.status,
      api_key_prefix: p.apiKeyPrefix,
      merchant_count: p._count.merchants,
      notes: p.notes, created_at: p.createdAt,
    })));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: create partner + issue API key
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { name, slug, contact_email, contact_phone, kyc_requirement = 'none', notes } = req.body;
    if (!name || !slug) return fail(res, 'name and slug are required');
    if (!VALID_KYC.includes(kyc_requirement))
      return fail(res, `kyc_requirement must be one of: ${VALID_KYC.join(', ')}`);

    const exists = await prisma.partner.findUnique({ where: { slug } });
    if (exists) return fail(res, `Partner with slug '${slug}' already exists`);

    const key = generateApiKey();
    const partner = await prisma.partner.create({
      data: {
        name, slug,
        contactEmail:   contact_email || null,
        contactPhone:   contact_phone || null,
        kycRequirement: kyc_requirement,
        apiKeyHash:     key.hash,
        apiKeyPrefix:   key.prefix,
        status:         'active',
        notes:          notes || null,
        createdBy:      req.user.id,
      },
    });

    return created(res, {
      id:              partner.id,
      name:            partner.name,
      slug:            partner.slug,
      kyc_requirement: partner.kycRequirement,
      status:          partner.status,
      // ⚠️ SHOW ONCE — share securely with partner
      api_key:         key.plaintext,
      api_key_prefix:  key.prefix,
      note: 'API key shown once — store securely and share with partner. They must include it as X-Partner-Key header in all API calls.',
    }, 'Partner created');
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: get partner detail
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const p = await prisma.partner.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { merchants: true } } },
    });
    if (!p) return notFound(res, 'Partner');
    return ok(res, {
      id: p.id, name: p.name, slug: p.slug,
      contact_email: p.contactEmail, contact_phone: p.contactPhone,
      kyc_requirement: p.kycRequirement, status: p.status,
      api_key_prefix: p.apiKeyPrefix, notes: p.notes,
      merchant_count: p._count.merchants,
      created_at: p.createdAt, updated_at: p.updatedAt,
    });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: update partner settings
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { name, contact_email, contact_phone, kyc_requirement, notes } = req.body;
    const data = {};
    if (name            !== undefined) data.name           = name;
    if (contact_email   !== undefined) data.contactEmail   = contact_email || null;
    if (contact_phone   !== undefined) data.contactPhone   = contact_phone || null;
    if (notes           !== undefined) data.notes          = notes || null;
    if (kyc_requirement !== undefined) {
      if (!VALID_KYC.includes(kyc_requirement)) return fail(res, `kyc_requirement must be: ${VALID_KYC.join(', ')}`);
      data.kycRequirement = kyc_requirement;
    }
    if (!Object.keys(data).length) return fail(res, 'No updatable fields provided');
    const p = await prisma.partner.update({ where: { id: req.params.id }, data });
    return ok(res, p, 'Partner updated');
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: suspend / activate partner
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/suspend',  requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await prisma.partner.update({ where: { id: req.params.id }, data: { status: 'suspended' } });
    return ok(res, { status: 'suspended' });
  } catch (e) { next(e); }
});
router.put('/:id/activate', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await prisma.partner.update({ where: { id: req.params.id }, data: { status: 'active' } });
    return ok(res, { status: 'active' });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: rotate partner API key
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/rotate-key', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
    if (!partner) return notFound(res, 'Partner');
    const key = generateApiKey();
    await prisma.partner.update({
      where: { id: req.params.id },
      data: { apiKeyHash: key.hash, apiKeyPrefix: key.prefix },
    });
    return ok(res, {
      // ⚠️ SHOW ONCE
      new_api_key:    key.plaintext,
      api_key_prefix: key.prefix,
      note: 'Old key is immediately invalidated. Share new key with partner securely.',
    });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: list merchants for a partner
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/merchants', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { status, kyc_status } = req.query;
    const where = { partnerId: req.params.id };
    if (status)     where.status    = status;
    if (kyc_status) where.kycStatus = kyc_status;
    const merchants = await prisma.partnerMerchant.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: { partner: { select: { name: true, slug: true } } },
    });
    return ok(res, merchants.map(m => ({
      id: m.id, partner: m.partner.name, partner_slug: m.partner.slug,
      business_name: m.businessName, mcc: m.mcc, country: m.country, state: m.state,
      contact_email: m.contactEmail, contact_phone: m.contactPhone,
      registration_number: m.registrationNumber, website: m.website,
      kyc_status: m.kycStatus, kyc_notes: m.kycNotes,
      mpgs_mid: m.mpgsMid, status: m.status,
      gateway_password_prefix: m.gatewayApiPasswordPrefix,
      activated_at: m.activatedAt, created_at: m.createdAt,
    })));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: configure MPGS credentials for a partner merchant + issue gateway password
//  Body: { mpgs_mid, mpgs_api_password, mpgs_base_url? }
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:partnerId/merchants/:merchantId/configure', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { partnerId, merchantId } = req.params;
    const { mpgs_mid, mpgs_api_password, mpgs_base_url } = req.body;
    if (!mpgs_mid || !mpgs_api_password) return fail(res, 'mpgs_mid and mpgs_api_password are required');

    const merchant = await prisma.partnerMerchant.findFirst({ where: { id: merchantId, partnerId } });
    if (!merchant) return notFound(res, 'Partner merchant');

    // Block if KYC is required but not yet approved
    if (merchant.kycStatus === 'pending') return fail(res, 'KYC review is still pending — approve before configuring MPGS');
    if (merchant.kycStatus === 'rejected') return fail(res, 'KYC was rejected — merchant cannot be activated');

    // Check MID not already used by another merchant
    const midExists = await prisma.partnerMerchant.findFirst({
      where: { mpgsMid: mpgs_mid, id: { not: merchantId } },
    });
    if (midExists) return fail(res, `MID '${mpgs_mid}' is already configured for another merchant`);

    const gw = generateGatewayPassword();
    const updated = await prisma.partnerMerchant.update({
      where: { id: merchantId },
      data: {
        mpgsMid:                  mpgs_mid.trim(),
        mpgsApiPassword:          mpgs_api_password.trim(),
        mpgsBaseUrl:              (mpgs_base_url || 'https://na-gateway.mastercard.com/api/rest/version/77').replace(/\/$/, ''),
        gatewayApiPasswordHash:   gw.hash,
        gatewayApiPasswordPrefix: gw.prefix,
        status:                   'active',
        activatedAt:              new Date(),
      },
    });

    const gatewayUrl = `${process.env.APP_URL || 'https://api.paylodeservices.com'}/api/rest/version/77`;
    return ok(res, {
      id:      updated.id,
      partner: partnerId,
      mpgs_mid: updated.mpgsMid,
      status:   updated.status,
      // ⚠️ SHOW ONCE — share with partner for this merchant
      gateway_api_password: gw.plaintext,
      connection_parameters: {
        gateway_url:  gatewayUrl,
        merchant_id:  updated.mpgsMid,
        api_password: gw.plaintext,
        note: 'Password shown once. Partner must share this securely with their merchant.',
      },
    }, 'Merchant configured and activated');
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SA: KYC review — approve or reject a partner merchant
//  Body: { decision: 'approved' | 'rejected', notes? }
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:partnerId/merchants/:merchantId/kyc', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { partnerId, merchantId } = req.params;
    const { decision, notes } = req.body;
    if (!['approved', 'rejected'].includes(decision)) return fail(res, "decision must be 'approved' or 'rejected'");

    const merchant = await prisma.partnerMerchant.findFirst({ where: { id: merchantId, partnerId } });
    if (!merchant) return notFound(res, 'Partner merchant');
    if (merchant.kycStatus === 'not_required') return fail(res, 'KYC is not required for this merchant');

    const updated = await prisma.partnerMerchant.update({
      where: { id: merchantId },
      data: {
        kycStatus:     decision,
        kycNotes:      notes || null,
        kycReviewedBy: req.user.id,
        kycReviewedAt: new Date(),
        // On rejection, set status back to pending_mid so partner can resubmit
        ...(decision === 'rejected' ? { status: 'rejected' } : {}),
      },
    });
    return ok(res, { id: updated.id, kyc_status: updated.kycStatus, status: updated.status }, `KYC ${decision}`);
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PARTNER API: submit a new merchant
//  Auth: X-Partner-Key
//  Body: { business_name, mcc, country?, state?, contact_name?, contact_email?,
//          contact_phone?, registration_number?, website?, kyc_documents? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/gateway/merchants', requirePartnerKey, async (req, res, next) => {
  try {
    const partner = req.partner;
    const {
      business_name, mcc, country, state,
      contact_name, contact_email, contact_phone,
      registration_number, website, kyc_documents,
    } = req.body;

    if (!business_name) return fail(res, 'business_name is required');
    if (!mcc)           return fail(res, 'mcc is required');

    // Determine initial KYC status based on partner's KYC requirement
    const kycStatus = partner.kycRequirement === 'none' ? 'not_required' : 'pending';
    const status    = kycStatus === 'pending' ? 'pending_kyc' : 'pending_mid';

    const merchant = await prisma.partnerMerchant.create({
      data: {
        partnerId:          partner.id,
        businessName:       business_name,
        mcc:                mcc.trim(),
        country:            country || 'NG',
        state:              state || null,
        contactName:        contact_name || null,
        contactEmail:       contact_email || null,
        contactPhone:       contact_phone || null,
        registrationNumber: registration_number || null,
        website:            website || null,
        kycStatus,
        status,
        kycDocuments:       Array.isArray(kyc_documents) ? kyc_documents : [],
      },
    });

    return created(res, {
      id:            merchant.id,
      business_name: merchant.businessName,
      mcc:           merchant.mcc,
      kyc_status:    merchant.kycStatus,
      status:        merchant.status,
      message:       kycStatus === 'pending'
        ? 'Merchant submitted. Paylode will review KYC before issuing connection parameters.'
        : 'Merchant submitted. Paylode will issue connection parameters once a MID is assigned.',
    }, 'Merchant submitted');
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PARTNER API: list own merchants
// ─────────────────────────────────────────────────────────────────────────────
router.get('/gateway/merchants', requirePartnerKey, async (req, res, next) => {
  try {
    const merchants = await prisma.partnerMerchant.findMany({
      where: { partnerId: req.partner.id },
      orderBy: { createdAt: 'desc' },
    });
    return ok(res, merchants.map(m => ({
      id:            m.id,
      business_name: m.businessName,
      mcc:           m.mcc,
      kyc_status:    m.kycStatus,
      status:        m.status,
      mpgs_mid:      m.mpgsMid || null,
      created_at:    m.createdAt,
    })));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PARTNER API: get merchant detail + connection params (once active)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/gateway/merchants/:id', requirePartnerKey, async (req, res, next) => {
  try {
    const m = await prisma.partnerMerchant.findFirst({
      where: { id: req.params.id, partnerId: req.partner.id },
    });
    if (!m) return notFound(res, 'Merchant');

    const resp = {
      id:            m.id,
      business_name: m.businessName,
      mcc:           m.mcc,
      kyc_status:    m.kycStatus,
      kyc_notes:     m.kycStatus === 'rejected' ? m.kycNotes : undefined,
      status:        m.status,
      created_at:    m.createdAt,
    };

    if (m.status === 'active' && m.mpgsMid) {
      const gatewayUrl = `${process.env.APP_URL || 'https://api.paylodeservices.com'}/api/rest/version/77`;
      resp.connection_parameters = {
        gateway_url:          gatewayUrl,
        merchant_id:          m.mpgsMid,
        api_password_prefix:  m.gatewayApiPasswordPrefix,
        note: 'Use these to connect to Paylode gateway. API password was issued at activation — contact Paylode if you need a reset.',
      };
    }
    return ok(res, resp);
  } catch (e) { next(e); }
});

module.exports = router;
