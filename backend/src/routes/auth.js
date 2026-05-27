'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { prisma }  = require('../utils/db');
const { ok, fail, created } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');

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

// POST /api/v1/auth/login
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

      const token = signToken(user.id, user.role);
      const { passwordHash, ...safeUser } = user;

      ok(res, { token, user: safeUser });
    } catch (e) { next(e); }
  }
);

// POST /api/v1/auth/me
router.get('/me', requireAuth, (req, res) => {
  const { passwordHash, ...safe } = req.user;
  ok(res, safe);
});

// POST /api/v1/auth/change-password
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
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
      ok(res, null, 'Password updated successfully');
    } catch (e) { next(e); }
  }
);

module.exports = router;
