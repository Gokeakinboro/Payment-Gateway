'use strict';
// Members + their mw_wallets. Admin onboards members (individually or via a list);
// each gets a login (email + one-time temp password, forced change on first sign-in)
// — same flow as departmental users. A member is created with a wallet in one step.
const router = require('express').Router();
const { prisma, tenantAuth, requireWalletEnabled, getConfig, isValidEmail, normalizePhone,
        genTempPassword, hashPassword, LOGIN_URL } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');
const { sendEmail } = require('../../../services/emailService');

router.use(tenantAuth, requireWalletEnabled);

const num = (v) => (v === null || v === undefined ? null : Number(v));
const SELECT = `m.id::text, m.name, m.email, m.phone, m.kyc_tier, m.status, m.user_id::text AS user_id, m.created_at,
  w.id::text AS wallet_id, w.balance::text AS balance, w.currency, w.low_balance_threshold::text AS low_balance_threshold`;
const shapeMember = (r) => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, kyc_tier: r.kyc_tier, status: r.status,
  has_login: !!r.user_id, wallet_id: r.wallet_id || null, balance: num(r.balance), currency: r.currency || 'NGN',
  low_balance_threshold: num(r.low_balance_threshold), created_at: r.created_at,
});

// Onboard one member: create login user (temp pw) + member + wallet. Returns temp password.
async function onboardMember(mid, body, cfg) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = body.phone ? normalizePhone(body.phone) : null;
  if (!name) return { error: 'Member name is required' };
  if (!isValidEmail(email)) return { error: 'A valid email is required (members sign in with it)' };
  if (body.phone && !phone) return { error: 'Invalid phone number' };
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) return { error: 'A user with that email already exists', email };

  const [firstName, ...rest] = name.split(' ');
  const tempPassword = genTempPassword();
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(tempPassword), firstName: firstName || name,
            lastName: rest.join(' ') || '-', role: 'MERCHANT', permissions: [], mustChangePassword: true },
    select: { id: true },
  });
  const mrows = await prisma.$queryRawUnsafe(
    `INSERT INTO mw_members (merchant_id, user_id, name, email, phone, kyc_tier)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,'low') RETURNING id::text`, mid, user.id, name, email, phone);
  await prisma.$executeRawUnsafe(
    `INSERT INTO mw_wallets (merchant_id, member_id, low_balance_threshold) VALUES ($1::uuid,$2::uuid,$3)`,
    mid, mrows[0].id, cfg.low_balance_default);

  sendEmail({
    to: email,
    subject: `Your ${cfg.brand_name || 'wallet'} account`,
    html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;color:#222">
      <p>A wallet account has been created for you.</p>
      <p>Sign in at <a href="${LOGIN_URL}">${LOGIN_URL}</a> with:</p>
      <p>Email: <strong>${email}</strong><br>Temporary password: <strong>${tempPassword}</strong></p>
      <p>You'll be asked to set your own password on first sign-in.</p></div>`,
    text: `Wallet account created. Sign in at ${LOGIN_URL}\nEmail: ${email}\nTemporary password: ${tempPassword}\nYou must change it on first sign-in.`,
  }).catch(() => {});
  return { id: mrows[0].id, email, temp_password: tempPassword };
}

// List members.
router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${SELECT} FROM mw_members m LEFT JOIN mw_wallets w ON w.member_id = m.id
         WHERE m.merchant_id = $1::uuid AND m.status <> 'deleted' ORDER BY m.created_at DESC LIMIT 2000`, req.walletTenant.merchantId);
    return ok(res, rows.map(shapeMember));
  } catch (e) { next(e); }
});

// Onboard a single member.
router.post('/', async (req, res, next) => {
  try {
    const cfg = await getConfig(req.walletTenant.merchantId);
    const r = await onboardMember(req.walletTenant.merchantId, req.body, cfg);
    if (r.error) return fail(res, r.error, r.email ? 'DUPLICATE' : 'INVALID', r.email ? 409 : 400);
    return created(res, r, 'Member onboarded and emailed a temporary password');
  } catch (e) { next(e); }
});

// Bulk onboard from a list. body: { members: [{name,email,phone?}, …] }
router.post('/import', async (req, res, next) => {
  try {
    const list = Array.isArray(req.body.members) ? req.body.members : [];
    if (!list.length) return fail(res, 'No members to import');
    if (list.length > 2000) return fail(res, 'Too many members in one import (max 2000)');
    const cfg = await getConfig(req.walletTenant.merchantId);
    const onboarded = []; const errors = [];
    for (let i = 0; i < list.length; i++) {
      try {
        const r = await onboardMember(req.walletTenant.merchantId, list[i] || {}, cfg);
        if (r.error) errors.push({ row: i + 1, email: list[i] && list[i].email, error: r.error });
        else onboarded.push({ email: r.email, temp_password: r.temp_password });
      } catch (e) { errors.push({ row: i + 1, error: 'failed' }); }
    }
    return created(res, { onboarded_count: onboarded.length, failed: errors.length, onboarded, errors: errors.slice(0, 200) },
      `Onboarded ${onboarded.length}, ${errors.length} failed.`);
  } catch (e) { next(e); }
});

// Member detail + wallet + recent ledger.
router.get('/:id', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${SELECT} FROM mw_members m LEFT JOIN mw_wallets w ON w.member_id = m.id
         WHERE m.id = $1::uuid AND m.merchant_id = $2::uuid`, req.params.id, mid);
    if (!rows.length) return notFound(res, 'Member');
    const member = shapeMember(rows[0]);
    const ledger = await prisma.$queryRawUnsafe(
      `SELECT direction, amount::text AS amount, balance_after::text AS balance_after, type, reference,
              department_id::text AS department_id, note, created_at
         FROM mw_ledger WHERE wallet_id = $1::uuid ORDER BY created_at DESC LIMIT 100`, member.wallet_id);
    return ok(res, { ...member, ledger: ledger.map((l) => ({ ...l, amount: num(l.amount), balance_after: num(l.balance_after) })) });
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId; const b = req.body || {};
    const sets = []; const vals = []; let i = 1;
    if (b.name !== undefined) { sets.push(`name = $${i++}`); vals.push(String(b.name).trim()); }
    if (b.status !== undefined) {
      const st = ['active', 'suspended', 'deactivated'].includes(b.status) ? b.status : 'active';
      sets.push(`status = $${i++}`); vals.push(st);
    }
    if (sets.length) {
      sets.push('updated_at = now()'); vals.push(req.params.id, mid);
      const r = await prisma.$queryRawUnsafe(
        `UPDATE mw_members SET ${sets.join(', ')} WHERE id = $${i++}::uuid AND merchant_id = $${i}::uuid RETURNING id::text`, ...vals);
      if (!r.length) return notFound(res, 'Member');
    }
    if (b.low_balance_threshold !== undefined)
      await prisma.$executeRawUnsafe(`UPDATE mw_wallets SET low_balance_threshold = $1, updated_at = now() WHERE member_id = $2::uuid AND merchant_id = $3::uuid`,
        BigInt(parseInt(b.low_balance_threshold, 10) || 0), req.params.id, mid);
    return ok(res, { id: req.params.id }, 'Member updated');
  } catch (e) { next(e); }
});

// Soft-delete a member (status='deleted') — removed from the address book but the
// ledger/audit trail is preserved (hard delete would CASCADE-wipe mw_ledger).
// Blocked while the member still holds a balance.
router.delete('/:id', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT w.balance::text AS balance FROM mw_members m JOIN mw_wallets w ON w.member_id = m.id
         WHERE m.id = $1::uuid AND m.merchant_id = $2::uuid`, req.params.id, mid);
    if (!rows.length) return notFound(res, 'Member');
    if (BigInt(rows[0].balance || '0') > 0n)
      return fail(res, 'This member still has a balance — zero it out before deleting.', 'HAS_BALANCE', 400);
    const r = await prisma.$queryRawUnsafe(
      `UPDATE mw_members SET status='deleted', updated_at=now() WHERE id=$1::uuid AND merchant_id=$2::uuid RETURNING id::text`,
      req.params.id, mid);
    if (!r.length) return notFound(res, 'Member');
    return ok(res, { id: req.params.id }, 'Member deleted');
  } catch (e) { next(e); }
});

module.exports = router;
