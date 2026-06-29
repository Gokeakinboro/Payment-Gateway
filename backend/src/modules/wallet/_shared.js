'use strict';
/**
 * Member Wallet — shared helpers. Closed-loop, merchant-owned, white-label.
 * Tenant = merchant. Management endpoints resolve a merchant (API key / owner JWT)
 * or a departmental sub-user (maker), exactly like the Invoice & Collect module.
 * Member-facing (app) endpoints authenticate the member separately (see services/memberAuth).
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma } = require('../../utils/db');
const { requireAuth, requireApiKey } = require('../../middleware/auth');
const { fail } = require('../../utils/helpers');

const DEFAULT_MAX_BALANCE = 300000000n; // ₦3,000,000 in kobo
const LOGIN_URL = (process.env.APP_BASE_URL || process.env.CHECKOUT_BASE_URL || 'https://paylodeservices.com').replace(/\/$/, '') + '/login.html';

// One-time temp password for member onboarding (mirrors departmental users).
const genTempPassword = () => crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) + 'A1!';
const hashPassword = (pw) => bcrypt.hash(pw, 12);

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
const normalizePhone = (p) => {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '234' + s.slice(1);
  else if (/^[789]\d{9}$/.test(s)) s = '234' + s;
  return /^\d{10,15}$/.test(s) ? s : null;
};
const genRef = (prefix = 'WLT') =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

// ── Tenant resolution (management side) ──────────────────────────────────────
// req.walletTenant = { merchantId, merchant, userId, departmentId|null, isDeptUser, isApiKey }
function tenantAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (tok.startsWith('sk_live_') || tok.startsWith('sk_test_')) {
    return requireApiKey(req, res, () => {
      req.walletTenant = { merchantId: req.merchant.id, merchant: req.merchant, userId: null, departmentId: null, isDeptUser: false, isApiKey: true };
      next();
    });
  }
  return requireAuth(req, res, async () => {
    try {
      const owner = req.user && req.user.merchant;
      if (owner) {
        req.walletTenant = { merchantId: owner.id, merchant: owner, userId: req.user.id, departmentId: null, isDeptUser: false, isApiKey: false };
        return next();
      }
      const rows = await prisma.$queryRawUnsafe(
        `SELECT merchant_id::text AS merchant_id, department_id::text AS department_id
           FROM inv_department_users WHERE user_id = $1::uuid LIMIT 1`, req.user.id);
      if (!rows.length) return fail(res, 'Only merchants can use the Wallet system', 'NOT_A_MERCHANT', 403);
      req.walletTenant = { merchantId: rows[0].merchant_id, merchant: null, userId: req.user.id, departmentId: rows[0].department_id, isDeptUser: true, isApiKey: false };
      next();
    } catch (e) { next(e); }
  });
}

// Gate: only when the merchant has the wallet module enabled.
async function requireWalletEnabled(req, res, next) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT enabled FROM merchant_wallet_config WHERE merchant_id = $1::uuid`, req.walletTenant.merchantId);
    if (!rows.length || !rows[0].enabled)
      return fail(res, 'The Wallet system is not enabled for this merchant', 'WALLET_DISABLED', 403);
    next();
  } catch (e) { next(e); }
}

// Effective config (defaults when no row yet).
async function getConfig(merchantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT enabled, brand_name, brand_logo_url, brand_color, sender_email, sender_whatsapp,
            max_balance::text AS max_balance, low_balance_default::text AS low_balance_default,
            notify_email, notify_whatsapp
       FROM merchant_wallet_config WHERE merchant_id = $1::uuid`, merchantId);
  const r = rows[0] || {};
  return {
    enabled: !!r.enabled,
    brand_name: r.brand_name || null,
    brand_logo_url: r.brand_logo_url || null,
    brand_color: r.brand_color || null,
    sender_email: r.sender_email || null,
    sender_whatsapp: r.sender_whatsapp || null,
    max_balance: r.max_balance ? BigInt(r.max_balance) : DEFAULT_MAX_BALANCE,
    low_balance_default: r.low_balance_default ? BigInt(r.low_balance_default) : 0n,
    notify_email: r.notify_email === undefined ? true : !!r.notify_email,
    notify_whatsapp: r.notify_whatsapp === undefined ? true : !!r.notify_whatsapp,
  };
}

// ── Member self-service auth ─────────────────────────────────────────────────
// Resolves the logged-in user (member) → req.walletMember. Members log in with the
// same /auth endpoints (temp-pw, force change, forgot-password) as everyone else.
function memberAuth(req, res, next) {
  return requireAuth(req, res, async () => {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT m.id::text AS member_id, m.merchant_id::text AS merchant_id, m.name, m.email, m.phone, m.status,
                w.id::text AS wallet_id, w.balance::text AS balance, w.currency, w.low_balance_threshold::text AS low_balance_threshold
           FROM wallet_members m JOIN wallets w ON w.member_id = m.id WHERE m.user_id = $1::uuid`, req.user.id);
      if (!rows.length) return fail(res, 'No wallet member is linked to this account', 'NOT_A_MEMBER', 403);
      if (rows[0].status !== 'active') return fail(res, 'Your wallet account is suspended', 'MEMBER_SUSPENDED', 403);
      req.walletMember = rows[0];
      next();
    } catch (e) { next(e); }
  });
}

module.exports = {
  prisma, DEFAULT_MAX_BALANCE, LOGIN_URL, isValidEmail, normalizePhone, genRef,
  genTempPassword, hashPassword, tenantAuth, requireWalletEnabled, memberAuth, getConfig,
};
