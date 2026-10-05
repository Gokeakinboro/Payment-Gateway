'use strict';
/**
 * Staff CRM — Custom field definitions management (SA only).
 * Mounted at /api/v1/staff/fields
 */
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { requireAuth, requireRole, requireSuperAdmin } = require('../../../middleware/auth');

const requireStaff = requireRole('SUPER_ADMIN', 'STAFF');

// ── GET /fields — list all active field definitions (staff + SA) ──────────
router.get('/', requireAuth, requireStaff, async (req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT id, field_key, label, field_type, options, required, sort_order, is_active, created_at
      FROM staff_crm_field_defs
      ORDER BY sort_order, label
    `);
    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to load fields' });
  }
});

// ── POST /fields — create new field (SA only) ──────────────────────────────
router.post('/', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { label, field_type, options, required, sort_order } = req.body;
    if (!label || !field_type) return res.status(400).json({ status: false, message: 'label and field_type required' });
    const VALID_TYPES = ['text','number','date','select','boolean'];
    if (!VALID_TYPES.includes(field_type)) return res.status(400).json({ status: false, message: 'Invalid field_type' });

    // Generate field_key from label
    const field_key = label.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,60)
      + '_' + Date.now().toString(36);

    const rows = await prisma.$queryRawUnsafe(`
      INSERT INTO staff_crm_field_defs(field_key, label, field_type, options, required, sort_order, created_by)
      VALUES($1, $2, $3, $4, $5, $6, $7::uuid)
      RETURNING id, field_key, label, field_type, options, required, sort_order
    `,
      field_key, label, field_type,
      options ? JSON.stringify(options) : null,
      Boolean(required), Number(sort_order||99),
      req.user.id
    );

    res.json({ status: true, message: 'Field created', data: rows[0] });
  } catch (err) {
    console.error('fields/create', err);
    res.status(500).json({ status: false, message: 'Failed to create field' });
  }
});

// ── PATCH /fields/:id — update field (SA only) ────────────────────────────
router.patch('/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { label, options, required, sort_order, is_active } = req.body;
    const sets = []; const vals = [];
    if (label !== undefined)     { vals.push(label);                     sets.push(`label=$${vals.length}`); }
    if (options !== undefined)   { vals.push(options?JSON.stringify(options):null); sets.push(`options=$${vals.length}`); }
    if (required !== undefined)  { vals.push(Boolean(required));          sets.push(`required=$${vals.length}`); }
    if (sort_order !== undefined){ vals.push(Number(sort_order));         sets.push(`sort_order=$${vals.length}`); }
    if (is_active !== undefined) { vals.push(Boolean(is_active));         sets.push(`is_active=$${vals.length}`); }
    if (!sets.length) return res.json({ status: true, message: 'Nothing to update' });
    vals.push(req.params.id);
    await prisma.$queryRawUnsafe(`UPDATE staff_crm_field_defs SET ${sets.join(',')} WHERE id=$${vals.length}::uuid`, ...vals);
    res.json({ status: true, message: 'Field updated' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Update failed' });
  }
});

// ── DELETE /fields/:id — soft-delete (deactivate) ─────────────────────────
router.delete('/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await prisma.$queryRawUnsafe(
      `UPDATE staff_crm_field_defs SET is_active=false WHERE id=$1::uuid`, req.params.id
    );
    res.json({ status: true, message: 'Field deactivated' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// ── GET /fields/merchant/:merchantId/values ────────────────────────────────
router.get('/merchant/:merchantId/values', requireAuth, requireStaff, async (req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT f.id AS field_id, f.field_key, f.label, f.field_type, f.options, f.sort_order, f.required,
             v.value
      FROM staff_crm_field_defs f
      LEFT JOIN staff_crm_field_values v ON v.field_id=f.id AND v.merchant_id=$1::uuid
      WHERE f.is_active=true
      ORDER BY f.sort_order, f.label
    `, req.params.merchantId);
    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// ── PUT /fields/merchant/:merchantId/values ───────────────────────────────
router.put('/merchant/:merchantId/values', requireAuth, requireStaff, async (req, res) => {
  try {
    const { values } = req.body;
    if (!Array.isArray(values)) return res.status(400).json({ status: false, message: 'values array required' });
    for (const v of values) {
      await prisma.$queryRawUnsafe(`
        INSERT INTO staff_crm_field_values(merchant_id, field_id, value, updated_by, updated_at)
        VALUES($1::uuid, $2::uuid, $3, $4::uuid, NOW())
        ON CONFLICT (merchant_id, field_id) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()
      `, req.params.merchantId, v.field_id, v.value||null, req.user.id);
    }
    res.json({ status: true, message: 'Saved' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to save' });
  }
});

module.exports = router;
