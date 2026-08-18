'use strict';
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { requireAuth, requireSuperAdmin, requireRole } = require('../../../middleware/auth');
const requireStaff = requireRole('SUPER_ADMIN', 'STAFF');

// GET /api/v1/staff/industries — list active industry types (all staff can read)
router.get('/', requireAuth, requireStaff, async (req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, label, sort_order FROM staff_industry_types WHERE is_active=true ORDER BY sort_order, label`
    );
    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to load industry types' });
  }
});

// POST /api/v1/staff/industries — SA creates new industry type
router.post('/', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { label, sort_order } = req.body;
    if (!label) return res.status(400).json({ status: false, message: 'label required' });
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO staff_industry_types(label, sort_order) VALUES($1, $2) RETURNING id, label, sort_order`,
      label.trim(), sort_order || 0
    );
    res.json({ status: true, data: rows[0] });
  } catch (err) {
    if (err.message && err.message.includes('unique')) {
      return res.status(409).json({ status: false, message: 'Industry type already exists' });
    }
    res.status(500).json({ status: false, message: 'Failed to create industry type' });
  }
});

// DELETE /api/v1/staff/industries/:id — SA soft-deletes
router.delete('/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await prisma.$queryRawUnsafe(
      `UPDATE staff_industry_types SET is_active=false WHERE id=$1::uuid`, req.params.id
    );
    res.json({ status: true, message: 'Industry type removed' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to remove industry type' });
  }
});

module.exports = router;
