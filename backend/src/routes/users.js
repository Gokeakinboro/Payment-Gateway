'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { prisma } = require('../utils/db');
const { ok, fail, created } = require('../utils/helpers');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { ALL_PERMISSIONS, ROLE_DEFAULTS } = require('../config/permissions');
const { logAudit } = require('../services/auditService');

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ status: false, message: errors.array()[0].msg, error_code: 'VALIDATION_ERROR' });
  next();
};

// GET /api/v1/users
router.get('/', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, firstName: true, lastName: true,
        role: true, permissions: true, isActive: true,
        lastLoginAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    ok(res, users);
  } catch (e) { next(e); }
});

// GET /api/v1/users/permissions/defaults/:role
router.get('/permissions/defaults/:role', requireAuth, requireSuperAdmin, (req, res) => {
  const defaults = ROLE_DEFAULTS[req.params.role];
  if (!defaults) return fail(res, 'Unknown role');
  ok(res, { permissions: defaults, all: ALL_PERMISSIONS });
});

// POST /api/v1/users
router.post('/', requireAuth, requireSuperAdmin,
  validate([
    body('email').isEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('firstName').notEmpty().withMessage('First name required'),
    body('lastName').notEmpty().withMessage('Last name required'),
    body('role').isIn(['ADMIN', 'COMPLIANCE_OFFICER', 'AUDIT', 'MERCHANT', 'AGGREGATOR'])
      .withMessage('Invalid role. Must be ADMIN, COMPLIANCE_OFFICER, AUDIT, MERCHANT, or AGGREGATOR'),
  ]),
  async (req, res, next) => {
    try {
      const { email, password, firstName, lastName, role, permissions } = req.body;

      const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (exists) return fail(res, 'Email already in use');

      const roleDefaults = ROLE_DEFAULTS[role] || [];
      const perms = Array.isArray(permissions)
        ? permissions.filter(p => ALL_PERMISSIONS.includes(p))
        : roleDefaults;

      const passwordHash = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: {
          email: email.toLowerCase(),
          passwordHash,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          role,
          permissions: perms,
        },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          role: true, permissions: true, isActive: true, createdAt: true,
        },
      });

      await logAudit(req.user.id, 'USER_CREATED', 'users', user.id,
        null, { email: user.email, role, permCount: perms.length }, null, req.ip);

      created(res, user, 'User created successfully');
    } catch (e) { next(e); }
  }
);

// PATCH /api/v1/users/:id/permissions
router.patch('/:id/permissions', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return fail(res, 'User not found', 'NOT_FOUND', 404);
    if (target.role === 'SUPER_ADMIN') return fail(res, 'Cannot modify Super Admin permissions');

    const { permissions } = req.body;
    if (!Array.isArray(permissions)) return fail(res, 'permissions must be an array');

    const validPerms = permissions.filter(p => ALL_PERMISSIONS.includes(p));
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { permissions: validPerms },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, permissions: true },
    });

    await logAudit(req.user.id, 'USER_PERMISSIONS_UPDATED', 'users', req.params.id,
      { permissions: target.permissions }, { permissions: validPerms }, null, req.ip);

    ok(res, updated, 'Permissions updated');
  } catch (e) { next(e); }
});

// PATCH /api/v1/users/:id
router.patch('/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return fail(res, 'User not found', 'NOT_FOUND', 404);
    if (target.role === 'SUPER_ADMIN') return fail(res, 'Cannot modify Super Admin account');

    const updates = {};
    if (typeof req.body.isActive === 'boolean') updates.isActive = req.body.isActive;
    if (req.body.firstName) updates.firstName = req.body.firstName.trim();
    if (req.body.lastName)  updates.lastName  = req.body.lastName.trim();

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: updates,
      select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true },
    });

    await logAudit(req.user.id, 'USER_UPDATED', 'users', req.params.id,
      { isActive: target.isActive }, updates, null, req.ip);

    ok(res, updated, 'User updated');
  } catch (e) { next(e); }
});

module.exports = router;
