'use strict';
const jwt  = require('jsonwebtoken');
const { prisma }      = require('../utils/db');
const { hashApiKey, unauthorized } = require('../utils/helpers');

// ── JWT Authentication ─────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return unauthorized(res, 'No token provided');

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id:true, email:true, role:true, permissions:true, isActive:true, mustChangePassword:true,
                merchant:{ select:{ id:true, merchantCode:true, kycStatus:true, isActive:true, kycTier:true, processingRate:true, aggregatorId:true }},
                aggregator:{ select:{ id:true, revenueSplitPct:true }} },
    });
    if (!user || !user.isActive) return unauthorized(res, 'Account inactive');
    req.user = user;

    // First-time password: until the temp password is changed, the only thing the
    // user may do is read their profile or change their password.
    if (user.mustChangePassword) {
      const url = req.originalUrl || '';
      const allowed = url.includes('/auth/change-password') || url.includes('/auth/me') || url.includes('/auth/logout');
      if (!allowed)
        return res.status(403).json({ status: false, message: 'You must change your temporary password before continuing.', error_code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    next();
  } catch {
    return unauthorized(res, 'Invalid or expired token');
  }
}

// ── API Key Authentication (for SDK calls) ─────────────────────────────────
async function requireApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return unauthorized(res, 'API key required');

  const rawKey = header.split(' ')[1];
  if (!rawKey.startsWith('sk_live_') && !rawKey.startsWith('sk_test_'))
    return unauthorized(res, 'Invalid key format. Use sk_live_ or sk_test_ key');

  const keyHash  = hashApiKey(rawKey);
  const apiKey   = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: {
      merchant: {
        include: { aggregator: true },
      },
    },
  });

  if (!apiKey || !apiKey.isActive)
    return unauthorized(res, 'Invalid API key');

  // Sandbox/test keys work immediately (so developers can integrate before KYC);
  // only LIVE keys require the merchant to be KYC-active — EXCEPT the payout route,
  // which lets a merchant still in KYC run LIVE payouts as long as their prepaid
  // wallet is funded (the funded balance is the safeguard). That route opts in via
  // req.allowInactiveLivePayout; a SUSPENDED/REJECTED account is still blocked in
  // the payout handler.
  if (!apiKey.isSandbox && !apiKey.merchant.isActive && !req.allowInactiveLivePayout)
    return unauthorized(res, 'Merchant account is not active. Complete KYC to enable live payments.');

  // Update last used (non-blocking)
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  req.merchant  = apiKey.merchant;
  req.isSandbox = apiKey.isSandbox;
  next();
}

// ── Role guards ────────────────────────────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return unauthorized(res);
  if (!roles.includes(req.user.role))
    return res.status(403).json({ status: false, message: 'Insufficient permissions', error_code: 'FORBIDDEN' });
  next();
};

const requireSuperAdmin        = requireRole('SUPER_ADMIN');
const requireAdmin             = requireRole('SUPER_ADMIN', 'ADMIN');
const requireCompliance        = requireRole('SUPER_ADMIN', 'COMPLIANCE_OFFICER');
const requireAdminOrCompliance = requireRole('SUPER_ADMIN', 'ADMIN', 'COMPLIANCE_OFFICER');
const requireAggregator        = requireRole('SUPER_ADMIN', 'AGGREGATOR');
const requireMerchant          = requireRole('SUPER_ADMIN', 'MERCHANT');

// ── Granular permission guard (functionality view/edit perms) ────────────────
// Additive on top of role guards. SUPER_ADMIN always passes. Use for staff
// (ADMIN/COMPLIANCE/AUDIT) granularity, e.g. requirePermission('edit_compliance').
const { hasPermission } = require('../config/permissions');
const requirePermission = (...perms) => (req, res, next) => {
  if (!req.user) return unauthorized(res);
  if (req.user.role === 'SUPER_ADMIN') return next();
  const okPerm = perms.some((p) => hasPermission(req.user, p));
  if (!okPerm)
    return res.status(403).json({ status: false, message: 'You do not have permission to perform this action', error_code: 'FORBIDDEN' });
  next();
};

module.exports = { requireAuth, requireApiKey, requireRole,
                   requireSuperAdmin, requireAdmin, requireCompliance,
                   requireAdminOrCompliance, requireAggregator, requireMerchant,
                   requirePermission };
