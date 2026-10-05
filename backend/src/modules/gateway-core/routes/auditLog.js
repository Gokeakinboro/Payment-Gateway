'use strict';
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { requireAuth, requireSuperAdmin, requireAdmin } = require('../../../middleware/auth');
const { ok, fail } = require('../../../utils/helpers');

// SA and Admin can read the audit log.
const requireAdminOrAbove = (req, res, next) => {
  const role = req.user?.role;
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') return next();
  return res.status(403).json({ success: false, message: 'Forbidden' });
};

/**
 * GET /api/v1/audit-log
 * Query: page, perPage, entityType, entityId, action, actorId, from, to, search
 */
router.get('/', requireAuth, requireAdminOrAbove, async (req, res, next) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page    || '1',  10));
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage || '50', 10)));
    const skip    = (page - 1) * perPage;

    const where = {};
    if (req.query.entityType) where.entityType = req.query.entityType;
    if (req.query.entityId)   where.entityId   = req.query.entityId;
    if (req.query.action)     where.action      = req.query.action;
    if (req.query.actorId)    where.actorId     = req.query.actorId;
    if (req.query.search) {
      where.OR = [
        { action:     { contains: req.query.search, mode: 'insensitive' } },
        { entityType: { contains: req.query.search, mode: 'insensitive' } },
        { entityId:   { contains: req.query.search, mode: 'insensitive' } },
        { notes:      { contains: req.query.search, mode: 'insensitive' } },
      ];
    }
    if (req.query.from || req.query.to) {
      where.createdAt = {};
      if (req.query.from) where.createdAt.gte = new Date(req.query.from);
      if (req.query.to)   where.createdAt.lte = new Date(req.query.to);
    }

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        skip,
        take: perPage,
        orderBy: { createdAt: 'desc' },
        select: {
          id:          true,
          action:      true,
          entityType:  true,
          entityId:    true,
          beforeState: true,
          afterState:  true,
          notes:       true,
          ipAddress:   true,
          createdAt:   true,
          actor: { select: { id: true, email: true, name: true, role: true } },
        },
      }),
    ]);

    ok(res, {
      rows: rows.map(r => ({ ...r, id: r.id.toString() })),
      pagination: { page, perPage, total, pages: Math.ceil(total / perPage) },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/audit-log/actions
 * Returns distinct action strings for the filter dropdown.
 */
router.get('/actions', requireAuth, requireAdminOrAbove, async (req, res, next) => {
  try {
    const raw = await prisma.auditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
    });
    ok(res, raw.map(r => r.action));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
