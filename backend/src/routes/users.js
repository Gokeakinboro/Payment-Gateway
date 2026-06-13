'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { prisma } = require('../utils/db');
const { ok, fail, created } = require('../utils/helpers');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
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
    const { role } = req.query;
    const where = role ? { role } : {};
    const users = await prisma.user.findMany({
      where,
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

// POST /api/v1/users/invite — create user with auto-generated temp password
router.post('/invite', requireAuth, requireSuperAdmin,
  validate([
    body('email').isEmail().withMessage('Valid email required'),
    body('name').notEmpty().withMessage('Name required'),
    body('role').isIn(['ADMIN', 'COMPLIANCE_OFFICER', 'AUDIT', 'MERCHANT', 'AGGREGATOR'])
      .withMessage('Invalid role'),
  ]),
  async (req, res, next) => {
    try {
      const { email, name, role } = req.body;
      const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (exists) return fail(res, 'Email already in use');

      const nameParts = name.trim().split(' ');
      const firstName = nameParts[0];
      const lastName  = nameParts.slice(1).join(' ') || '-';

      const tempPassword = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6).toUpperCase();
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      const user = await prisma.user.create({
        data: {
          email: email.toLowerCase(), passwordHash, firstName, lastName, role, permissions: [],
        },
        select: { id: true, email: true, firstName: true, lastName: true, role: true, createdAt: true },
      });

      await logAudit(req.user.id, 'USER_INVITED', 'users', user.id, null, { email: user.email, role }, null, req.ip);
      ok(res, { ...user, temp_password: tempPassword,
        message: 'User created. Share the temp password securely.' });
    } catch (e) { next(e); }
  }
);

// POST /api/v1/users
router.post('/', requireAuth, requireSuperAdmin,
  validate([
    body('email').isEmail().withMessage('Valid email required'),
    body('firstName').notEmpty().withMessage('First name required'),
    body('lastName').notEmpty().withMessage('Last name required'),
    body('role').isIn(['ADMIN', 'COMPLIANCE_OFFICER', 'AUDIT', 'MERCHANT', 'AGGREGATOR'])
      .withMessage('Invalid role'),
  ]),
  async (req, res, next) => {
    try {
      const { email, firstName, lastName, role, permissions, password } = req.body;
      const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (exists) return fail(res, 'Email already in use');

      const tempPassword = password || (Math.random().toString(36).slice(2, 12) + 'Aa1!');
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      const user = await prisma.user.create({
        data: {
          email: email.toLowerCase(), passwordHash,
          firstName: firstName.trim(), lastName: lastName.trim(),
          role, permissions: Array.isArray(permissions) ? permissions : [],
        },
        select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true, createdAt: true },
      });

      await logAudit(req.user.id, 'USER_CREATED', 'users', user.id, null, { email: user.email, role }, null, req.ip);
      created(res, { ...user, temp_password: tempPassword }, 'User created successfully');
    } catch (e) { next(e); }
  }
);

// PUT /api/v1/users/:id/activate
router.put('/:id/activate', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return fail(res, 'User not found', 'NOT_FOUND', 404);
    await prisma.user.update({ where: { id: req.params.id }, data: { isActive: true } });
    await logAudit(req.user.id, 'USER_ACTIVATED', 'users', req.params.id, { isActive: false }, { isActive: true }, null, req.ip);
    ok(res, { message: 'User activated' });
  } catch (e) { next(e); }
});

// PUT /api/v1/users/:id/deactivate
router.put('/:id/deactivate', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return fail(res, 'User not found', 'NOT_FOUND', 404);
    if (target.role === 'SUPER_ADMIN') return fail(res, 'Cannot deactivate a Super Admin account');
    await prisma.user.update({ where: { id: req.params.id }, data: { isActive: false } });
    await logAudit(req.user.id, 'USER_DEACTIVATED', 'users', req.params.id, { isActive: true }, { isActive: false }, null, req.ip);
    ok(res, { message: 'User deactivated' });
  } catch (e) { next(e); }
});

// PATCH /api/v1/users/:id/permissions
router.patch('/:id/permissions', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return fail(res, 'User not found', 'NOT_FOUND', 404);
    if (target.role === 'SUPER_ADMIN') return fail(res, 'Cannot modify Super Admin permissions');
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) return fail(res, 'permissions must be an array');
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { permissions },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, permissions: true },
    });
    await logAudit(req.user.id, 'USER_PERMISSIONS_UPDATED', 'users', req.params.id,
      { permissions: target.permissions }, { permissions }, null, req.ip);
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
      where: { id: req.params.id }, data: updates,
      select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true },
    });
    await logAudit(req.user.id, 'USER_UPDATED', 'users', req.params.id,
      { isActive: target.isActive }, updates, null, req.ip);
    ok(res, updated, 'User updated');
  } catch (e) { next(e); }
});

module.exports = router;
