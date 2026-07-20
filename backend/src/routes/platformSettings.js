'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { ok, fail } = require('../utils/helpers');

// GET  /api/v1/platform/settings/:key  — SA reads a platform setting
// PATCH /api/v1/platform/settings/:key — SA updates a platform setting
//   Body: { value: { ...fields } }  — merged into the existing value object

router.get('/:key', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const row = await prisma.platformSettings.findUnique({ where: { key: req.params.key } });
    ok(res, { key: req.params.key, value: row ? row.value : {} });
  } catch (e) { next(e); }
});

router.patch('/:key', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { value } = req.body;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(res, 'value must be a plain object');
    const existing = await prisma.platformSettings.findUnique({ where: { key: req.params.key } });
    const merged = { ...(existing?.value || {}), ...value };
    const row = await prisma.platformSettings.upsert({
      where:  { key: req.params.key },
      update: { value: merged, updatedBy: req.user.id },
      create: { key: req.params.key, value: merged, updatedBy: req.user.id },
    });
    ok(res, { key: req.params.key, value: row.value });
  } catch (e) { next(e); }
});

module.exports = router;
