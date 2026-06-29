'use strict';
// Members + their wallets. A member is created with a wallet in one step.
const router = require('express').Router();
const { prisma, tenantAuth, requireWalletEnabled, getConfig, isValidEmail, normalizePhone } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');

router.use(tenantAuth, requireWalletEnabled);

const num = (v) => (v === null || v === undefined ? null : Number(v));
const shapeMember = (r) => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, kyc_tier: r.kyc_tier, status: r.status,
  wallet_id: r.wallet_id || null,
  balance: num(r.balance), currency: r.currency || 'NGN',
  low_balance_threshold: num(r.low_balance_threshold), created_at: r.created_at,
});

const SELECT = `m.id::text, m.name, m.email, m.phone, m.kyc_tier, m.status, m.created_at,
  w.id::text AS wallet_id, w.balance::text AS balance, w.currency, w.low_balance_threshold::text AS low_balance_threshold`;

// List members (with wallet balance).
router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${SELECT} FROM wallet_members m LEFT JOIN wallets w ON w.member_id = m.id
         WHERE m.merchant_id = $1::uuid ORDER BY m.created_at DESC LIMIT 1000`, req.walletTenant.merchantId);
    return ok(res, rows.map(shapeMember));
  } catch (e) { next(e); }
});

// Create a member + wallet (very-low-tier KYC: name + email/phone).
router.post('/', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const name = String(req.body.name || '').trim();
    if (!name) return fail(res, 'Member name is required');
    const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
    const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
    if (!email && !phone) return fail(res, 'An email or phone number is required');
    if (email && !isValidEmail(email)) return fail(res, 'Invalid email address');
    if (req.body.phone && !phone) return fail(res, 'Invalid phone number');

    const cfg = await getConfig(mid);
    const lowThreshold = req.body.low_balance_threshold != null
      ? BigInt(parseInt(req.body.low_balance_threshold, 10) || 0) : cfg.low_balance_default;

    const mrows = await prisma.$queryRawUnsafe(
      `INSERT INTO wallet_members (merchant_id, name, email, phone, kyc_tier)
       VALUES ($1::uuid,$2,$3,$4,'low') RETURNING id::text`, mid, name, email, phone);
    const memberId = mrows[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO wallets (merchant_id, member_id, low_balance_threshold) VALUES ($1::uuid,$2::uuid,$3)`,
      mid, memberId, lowThreshold);

    const out = await prisma.$queryRawUnsafe(
      `SELECT ${SELECT} FROM wallet_members m LEFT JOIN wallets w ON w.member_id = m.id WHERE m.id = $1::uuid`, memberId);
    return created(res, shapeMember(out[0]), 'Member created');
  } catch (e) {
    if (String(e.message || '').includes('uq_wallet_members')) return fail(res, 'A member with that email/phone already exists', 'DUPLICATE', 409);
    next(e);
  }
});

// Member detail + wallet + recent ledger.
router.get('/:id', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${SELECT} FROM wallet_members m LEFT JOIN wallets w ON w.member_id = m.id
         WHERE m.id = $1::uuid AND m.merchant_id = $2::uuid`, req.params.id, mid);
    if (!rows.length) return notFound(res, 'Member');
    const member = shapeMember(rows[0]);
    const ledger = await prisma.$queryRawUnsafe(
      `SELECT direction, amount::text AS amount, balance_after::text AS balance_after, type, reference,
              department_id::text AS department_id, note, created_at
         FROM wallet_ledger WHERE wallet_id = $1::uuid ORDER BY created_at DESC LIMIT 100`, member.wallet_id);
    return ok(res, { ...member, ledger: ledger.map((l) => ({ ...l, amount: num(l.amount), balance_after: num(l.balance_after) })) });
  } catch (e) { next(e); }
});

// Update member (name/email/phone/status/threshold).
router.patch('/:id', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const b = req.body || {};
    const sets = []; const vals = []; let i = 1;
    if (b.name !== undefined) { sets.push(`name = $${i++}`); vals.push(String(b.name).trim()); }
    if (b.status !== undefined) { sets.push(`status = $${i++}`); vals.push(b.status === 'suspended' ? 'suspended' : 'active'); }
    if (sets.length) {
      sets.push('updated_at = now()');
      vals.push(req.params.id, mid);
      const r = await prisma.$queryRawUnsafe(
        `UPDATE wallet_members SET ${sets.join(', ')} WHERE id = $${i++}::uuid AND merchant_id = $${i}::uuid RETURNING id::text`, ...vals);
      if (!r.length) return notFound(res, 'Member');
    }
    if (b.low_balance_threshold !== undefined) {
      await prisma.$executeRawUnsafe(`UPDATE wallets SET low_balance_threshold = $1, updated_at = now() WHERE member_id = $2::uuid AND merchant_id = $3::uuid`,
        BigInt(parseInt(b.low_balance_threshold, 10) || 0), req.params.id, mid);
    }
    return ok(res, { id: req.params.id }, 'Member updated');
  } catch (e) { next(e); }
});

module.exports = router;
