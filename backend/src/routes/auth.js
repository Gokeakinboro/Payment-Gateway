'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { prisma }  = require('../utils/db');
const { ok, fail, created } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../services/auditService');
const { sendEmail, getEmailContent } = require('../services/emailService');
const { logger } = require('../utils/logger');

function genTempPassword() {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6).toUpperCase() + '!';
}

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ status: false, message: errors.array()[0].msg, errors: errors.array(), error_code: 'VALIDATION_ERROR' });
  next();
};

function signToken(userId, role) {
  return jwt.sign({ userId, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });
}

// ── TOTP helpers (no external library needed) ─────────────────────────────────
const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32Decode(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const idx = B32_ALPHA.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function b32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += B32_ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32_ALPHA[(val << (5 - bits)) & 31];
  return out;
}

function totpCode(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', b32Decode(secret)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off+1] << 16) | (hmac[off+2] << 8) | hmac[off+3];
  return String(code % 1000000).padStart(6, '0');
}

function verifyTOTP(secret, token, window = 1) {
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    if (totpCode(secret, step + i) === String(token).replace(/\s/g, '')) return true;
  }
  return false;
}

function newTotpSecret() {
  return b32Encode(crypto.randomBytes(20));
}

// ── POST /api/v1/auth/login ───────────────────────────────────────────────────
router.post('/login',
  validate([
    body('email').isEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password required'),
  ]),
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        include: {
          merchant:   { select: { id:true, merchantCode:true, kycStatus:true, isActive:true, businessName:true }},
          aggregator: { select: { id:true, companyName:true }},
        },
      });

      if (!user || !await bcrypt.compare(password, user.passwordHash))
        return fail(res, 'Invalid email or password', 'INVALID_CREDENTIALS', 401);

      if (!user.isActive)
        return fail(res, 'Account has been suspended. Contact support@paylodeservices.com', 'ACCOUNT_SUSPENDED', 401);

      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      // Activity log: record the sign-in (staff vs customer derived from role).
      logAudit(user.id, 'LOGIN', 'users', user.id, null, { role: user.role }, null, req.ip).catch(() => {});

      // 2FA check
      if (user.totpEnabled && user.totpSecret) {
        const tempToken = jwt.sign({ userId: user.id, twofa_pending: true }, process.env.JWT_SECRET, { expiresIn: '5m' });
        return ok(res, { twofa_required: true, temp_token: tempToken, user_email: user.email });
      }

      const token = signToken(user.id, user.role);
      const { passwordHash, totpSecret, ...safeUser } = user;
      ok(res, { token, user: safeUser });
    } catch (e) { next(e); }
  }
);

// ── POST /api/v1/auth/2fa/validate (complete login after 2FA) ─────────────────
router.post('/2fa/validate', async (req, res, next) => {
  try {
    const { temp_token, code } = req.body;
    if (!temp_token || !code) return fail(res, 'temp_token and code required');

    let decoded;
    try { decoded = jwt.verify(temp_token, process.env.JWT_SECRET); } catch { return fail(res, 'Session expired. Please log in again.', 'TOKEN_EXPIRED', 401); }
    if (!decoded.twofa_pending) return fail(res, 'Invalid session', 'INVALID_SESSION', 401);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        merchant:   { select: { id:true, merchantCode:true, kycStatus:true, isActive:true, businessName:true }},
        aggregator: { select: { id:true, companyName:true }},
      },
    });
    if (!user || !user.totpEnabled || !user.totpSecret) return fail(res, 'Invalid session');

    if (!verifyTOTP(user.totpSecret, code)) return fail(res, 'Incorrect code. Try again.', 'INVALID_2FA_CODE', 401);

    const token = signToken(user.id, user.role);
    const { passwordHash, totpSecret, ...safeUser } = user;
    ok(res, { token, user: safeUser });
  } catch (e) { next(e); }
});

// ── POST /api/v1/auth/2fa/setup (generate secret + QR URI) ───────────────────
router.post('/2fa/setup', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user.totpEnabled) return fail(res, '2FA is already enabled');

    const secret = newTotpSecret();
    // Temporarily store the secret (user must confirm before it is "enabled")
    await prisma.user.update({ where: { id: req.user.id }, data: { totpSecret: secret } });

    const label = encodeURIComponent(`Paylode:${user.email}`);
    const issuer = encodeURIComponent('Paylode Services');
    const otpUri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

    ok(res, { secret, otp_uri: otpUri });
  } catch (e) { next(e); }
});

// ── POST /api/v1/auth/2fa/confirm (verify code to enable) ────────────────────
router.post('/2fa/confirm', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return fail(res, 'Authenticator code required');

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user.totpSecret) return fail(res, 'Run /2fa/setup first');
    if (user.totpEnabled) return fail(res, '2FA is already active');

    if (!verifyTOTP(user.totpSecret, code)) return fail(res, 'Code is incorrect. Make sure your device clock is synced.', 'INVALID_CODE', 400);

    await prisma.user.update({ where: { id: req.user.id }, data: { totpEnabled: true } });
    ok(res, null, '2FA enabled successfully. All future logins will require your authenticator code.');
  } catch (e) { next(e); }
});

// ── POST /api/v1/auth/2fa/disable ────────────────────────────────────────────
router.post('/2fa/disable', requireAuth, async (req, res, next) => {
  try {
    const { password, code } = req.body;
    if (!password || !code) return fail(res, 'Current password and authenticator code required');

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user.totpEnabled) return fail(res, '2FA is not enabled');

    if (!await bcrypt.compare(password, user.passwordHash)) return fail(res, 'Incorrect password');
    if (!verifyTOTP(user.totpSecret, code)) return fail(res, 'Incorrect authenticator code');

    await prisma.user.update({ where: { id: req.user.id }, data: { totpEnabled: false, totpSecret: null } });
    ok(res, null, '2FA has been disabled.');
  } catch (e) { next(e); }
});

// ── GET /api/v1/auth/me ───────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const { passwordHash, totpSecret, ...safe } = req.user;
  ok(res, safe);
});

// ── POST /api/v1/auth/change-password ────────────────────────────────────────
router.post('/change-password', requireAuth,
  validate([
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ]),
  async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!await bcrypt.compare(req.body.currentPassword, user.passwordHash))
        return fail(res, 'Current password is incorrect', 'WRONG_PASSWORD');

      const newHash = await bcrypt.hash(req.body.newPassword, 12);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash, mustChangePassword: false } });
      ok(res, null, 'Password updated successfully');
    } catch (e) { next(e); }
  }
);

// ── POST /api/v1/auth/forgot-password — PUBLIC self-service password reset ────
// Issues a new temporary password to the REGISTERED email (so no takeover) and
// forces a change on next sign-in. Always returns the same response so it can't
// be used to discover which emails exist.
router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return fail(res, 'A valid email is required');
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const tempPassword = genTempPassword();
      await prisma.user.update({ where: { id: user.id }, data: {
        passwordHash: await bcrypt.hash(tempPassword, 12), mustChangePassword: true,
      }});
      const loginUrl = (process.env.APP_URL || 'https://paylodeservices.com') + '/login.html';
      const content = await getEmailContent('password_reset',
        { name: user.firstName || '', email, temp_password: tempPassword, login_url: loginUrl },
        'Reset your Paylode password',
        `<h2>Password reset</h2><p>Hi ${user.firstName || ''},</p>` +
          `<p>We received a request to reset your Paylode password. Sign in with this temporary password and you'll be prompted to set a new one:</p>` +
          `<p><strong>Email:</strong> ${email}<br><strong>Temporary password:</strong> ${tempPassword}</p>` +
          `<p><a href="${loginUrl}">Sign in to Paylode</a>. If you didn't request this, you can ignore this email.</p>`);
      sendEmail({ to: email, subject: content.subject, html: content.html })
        .catch(e => logger.error({ err: e, email }, 'forgot-password email failed'));
      logAudit(user.id, 'PASSWORD_RESET_REQUESTED', 'users', user.id, null, { email }, null, req.ip).catch(() => {});
    }
    ok(res, { requested: true }, 'If that email is registered, a temporary password has been sent. Please check your inbox (and spam).');
  } catch (e) { next(e); }
});

module.exports = router;
