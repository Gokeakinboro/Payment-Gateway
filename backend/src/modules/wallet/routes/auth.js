'use strict';
// Billspay PIN-based login for Social Club members.
// POST /api/v1/wallet/auth/pin-login  { email, pin, merchant_id }
// Returns a JWT (same format as password login) so the member can call /me/* routes.
// On first login the default PIN (issued by admin) is used; must_change_pin=true
// tells the frontend to immediately show the change-PIN screen.
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const router = require('express').Router();
const { prisma } = require('../_shared');
const { ok, fail } = require('../../../utils/helpers');

const PIN_MAX_FAILS = 5;
const PIN_LOCK_MIN  = 15;

router.post('/pin-login', async (req, res, next) => {
  try {
    const b = req.body || {};
    const email      = String(b.email || '').trim().toLowerCase();
    const pin        = String(b.pin   || '');
    const merchantId = String(b.merchant_id || '').trim();

    if (!email || !pin || !merchantId)
      return fail(res, 'email, pin and merchant_id are required');
    if (!/^\d{4,6}$/.test(pin))
      return fail(res, 'PIN must be 4 to 6 digits', 'PIN_INVALID');

    // Resolve user → member in one join to avoid timing oracle.
    const mrows = await prisma.$queryRawUnsafe(
      `SELECT u.id::text AS user_id, u.role,
              m.id::text AS member_id, m.login_pin_hash, m.login_pin_set,
              m.login_pin_failed, m.login_pin_locked_until
         FROM users u
         JOIN mw_members m ON m.user_id=u.id
        WHERE lower(u.email)=$1 AND m.merchant_id=$2::uuid AND m.status='active'
        LIMIT 1`,
      email, merchantId);

    if (!mrows.length) return fail(res, 'Invalid email or PIN', 'BAD_CREDENTIALS', 401);
    const m = mrows[0];

    if (!m.login_pin_hash)
      return fail(res, 'Login PIN not set — contact your club admin', 'PIN_NOT_SET', 401);
    if (m.login_pin_locked_until && new Date(m.login_pin_locked_until) > new Date())
      return fail(res, 'Too many incorrect attempts. Try again later.', 'PIN_LOCKED', 429);

    const good = await bcrypt.compare(pin, m.login_pin_hash);
    if (!good) {
      const fails = (m.login_pin_failed || 0) + 1;
      const lock  = fails >= PIN_MAX_FAILS;
      await prisma.$executeRawUnsafe(
        `UPDATE mw_members SET login_pin_failed=$1, login_pin_locked_until=$2 WHERE id=$3::uuid`,
        lock ? 0 : fails,
        lock ? new Date(Date.now() + PIN_LOCK_MIN * 60000) : null,
        m.member_id);
      const msg = lock
        ? `Too many incorrect attempts. Try again in ${PIN_LOCK_MIN} minutes.`
        : `Incorrect PIN. ${PIN_MAX_FAILS - fails} attempt(s) left.`;
      return fail(res, msg, 'BAD_CREDENTIALS', 401);
    }

    if (m.login_pin_failed)
      await prisma.$executeRawUnsafe(
        `UPDATE mw_members SET login_pin_failed=0, login_pin_locked_until=NULL WHERE id=$1::uuid`,
        m.member_id);

    const token = jwt.sign(
      { userId: m.user_id, role: m.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });

    return ok(res, { token, member_id: m.member_id, must_change_pin: !m.login_pin_set });
  } catch (e) { next(e); }
});

module.exports = router;
