'use strict';
/**
 * Staff CRM — Prospects (pre-signup leads).
 * Mounted at /api/v1/staff/prospects
 */
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { requireAuth, requireRole } = require('../../../middleware/auth');

const requireStaff = requireRole('SUPER_ADMIN', 'STAFF');
const isSA = (u) => u.role === 'SUPER_ADMIN';

// ── GET /prospects ─────────────────────────────────────────────────────────
router.get('/', requireAuth, requireStaff, async (req, res) => {
  try {
    const { search, stage } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (!isSA(req.user)) {
      params.push(req.user.id);
      where += ` AND p.account_officer_id = $${params.length}::uuid`;
    }
    if (stage) { params.push(stage); where += ` AND p.pipeline_stage = $${params.length}`; }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.business_name ILIKE $${params.length} OR p.contact_name ILIKE $${params.length} OR p.phone ILIKE $${params.length})`;
    }

    const rows = await prisma.$queryRawUnsafe(`
      SELECT p.*, u.first_name || ' ' || u.last_name AS officer_name,
             (SELECT COUNT(*) FROM staff_prospect_engagements e WHERE e.prospect_id=p.id) AS engagement_count,
             (SELECT MAX(e.engaged_at) FROM staff_prospect_engagements e WHERE e.prospect_id=p.id) AS last_engaged_at
      FROM staff_prospects p
      LEFT JOIN users u ON u.id = p.account_officer_id
      ${where}
      ORDER BY p.business_name
      LIMIT 500
    `, ...params);

    res.json({ status: true, data: rows });
  } catch (err) {
    console.error('prospects/list', err);
    res.status(500).json({ status: false, message: 'Failed to load prospects' });
  }
});

// ── GET /prospects/:id ─────────────────────────────────────────────────────
router.get('/:id', requireAuth, requireStaff, async (req, res) => {
  try {
    const officerFilter = isSA(req.user) ? '' : `AND p.account_officer_id = '${req.user.id}'::uuid`;
    const rows = await prisma.$queryRawUnsafe(`
      SELECT p.*, u.first_name || ' ' || u.last_name AS officer_name
      FROM staff_prospects p
      LEFT JOIN users u ON u.id = p.account_officer_id
      WHERE p.id = $1::uuid ${officerFilter}
    `, req.params.id);
    if (!rows.length) return res.status(404).json({ status: false, message: 'Prospect not found' });

    // Load custom field values
    const fields = await prisma.$queryRawUnsafe(`
      SELECT f.id AS field_id, f.field_key, f.label, f.field_type, f.options, f.sort_order, f.required,
             v.value
      FROM staff_crm_field_defs f
      LEFT JOIN staff_prospect_field_values v ON v.field_id=f.id AND v.prospect_id=$1::uuid
      WHERE f.is_active=true
      ORDER BY f.sort_order, f.label
    `, req.params.id);

    res.json({ status: true, data: { ...rows[0], custom_fields: fields } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to load prospect' });
  }
});

// ── POST /prospects ────────────────────────────────────────────────────────
router.post('/', requireAuth, requireStaff, async (req, res) => {
  try {
    const { business_name, address, contact_name, email, phone, pipeline_stage, notes } = req.body;
    if (!business_name) return res.status(400).json({ status: false, message: 'business_name required' });

    const rows = await prisma.$queryRawUnsafe(`
      INSERT INTO staff_prospects(business_name, address, contact_name, email, phone, pipeline_stage, notes, account_officer_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid)
      RETURNING id
    `, business_name, address||null, contact_name||null, email||null, phone||null,
       pipeline_stage||'prospect', notes||null, req.user.id);

    res.json({ status: true, message: 'Prospect created', data: { id: rows[0].id } });
  } catch (err) {
    console.error('prospects/create', err);
    res.status(500).json({ status: false, message: 'Failed to create prospect' });
  }
});

// ── PATCH /prospects/:id ──────────────────────────────────────────────────
router.patch('/:id', requireAuth, requireStaff, async (req, res) => {
  try {
    const allowed = ['business_name','address','contact_name','email','phone','pipeline_stage','notes','off_ramp_reason','first_engagement_at'];
    const sets = []; const vals = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { vals.push(req.body[k]||null); sets.push(`${k}=$${vals.length}`); }
    }
    if (req.body.pipeline_stage === 'churned') sets.push(`off_ramp_at=NOW()`);
    sets.push(`updated_at=NOW()`);
    if (!sets.filter(s=>!s.startsWith('updated')).length) return res.json({ status: true, message: 'Nothing to update' });
    vals.push(req.params.id);
    await prisma.$queryRawUnsafe(`UPDATE staff_prospects SET ${sets.join(',')} WHERE id=$${vals.length}::uuid`, ...vals);
    res.json({ status: true, message: 'Updated' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Update failed' });
  }
});

// ── PUT /prospects/:id/custom-fields ─────────────────────────────────────
// Upsert multiple custom field values at once
router.put('/:id/custom-fields', requireAuth, requireStaff, async (req, res) => {
  try {
    const { values } = req.body; // [{field_id, value}]
    if (!Array.isArray(values) || !values.length) return res.json({ status: true, message: 'Nothing to save' });
    for (const v of values) {
      await prisma.$queryRawUnsafe(`
        INSERT INTO staff_prospect_field_values(prospect_id, field_id, value, updated_by, updated_at)
        VALUES($1::uuid, $2::uuid, $3, $4::uuid, NOW())
        ON CONFLICT (prospect_id, field_id) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()
      `, req.params.id, v.field_id, v.value||null, req.user.id);
    }
    res.json({ status: true, message: 'Fields saved' });
  } catch (err) {
    console.error('prospects/custom-fields', err);
    res.status(500).json({ status: false, message: 'Failed to save fields' });
  }
});

// ── GET /prospects/:id/engagements ────────────────────────────────────────
router.get('/:id/engagements', requireAuth, requireStaff, async (req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT e.id, e.type, e.notes, e.engaged_at, u.first_name || ' ' || u.last_name AS logged_by
      FROM staff_prospect_engagements e
      JOIN users u ON u.id = e.staff_id
      WHERE e.prospect_id = $1::uuid
      ORDER BY e.engaged_at DESC LIMIT 100
    `, req.params.id);
    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// ── POST /prospects/:id/engagements ──────────────────────────────────────
router.post('/:id/engagements', requireAuth, requireStaff, async (req, res) => {
  try {
    const { type, notes, engaged_at } = req.body;
    const VALID = ['call','visit','email','whatsapp','demo','other'];
    if (!VALID.includes(type)) return res.status(400).json({ status: false, message: 'Invalid type' });
    await prisma.$queryRawUnsafe(
      `INSERT INTO staff_prospect_engagements(prospect_id,staff_id,type,notes,engaged_at) VALUES($1::uuid,$2::uuid,$3,$4,$5)`,
      req.params.id, req.user.id, type, notes||null, engaged_at ? new Date(engaged_at) : new Date()
    );
    // Stamp first_engagement_at
    await prisma.$queryRawUnsafe(
      `UPDATE staff_prospects SET first_engagement_at=COALESCE(first_engagement_at,NOW()) WHERE id=$1::uuid`, req.params.id
    );
    res.json({ status: true, message: 'Logged' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// ── POST /prospects/:id/convert ──────────────────────────────────────────
// Link a prospect to an existing merchant (when they sign up)
router.post('/:id/convert', requireAuth, requireStaff, async (req, res) => {
  try {
    const { merchant_id } = req.body;
    if (!merchant_id) return res.status(400).json({ status: false, message: 'merchant_id required' });
    // Set account_officer on the merchant too
    await prisma.$queryRawUnsafe(
      `UPDATE merchants SET account_officer_id=$1::uuid WHERE id=$2::uuid`,
      req.user.id, merchant_id
    );
    await prisma.$queryRawUnsafe(
      `UPDATE staff_prospects SET linked_merchant_id=$1::uuid, pipeline_stage='onboarded', updated_at=NOW() WHERE id=$2::uuid`,
      merchant_id, req.params.id
    );
    res.json({ status: true, message: 'Prospect converted and merchant assigned' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Conversion failed' });
  }
});

module.exports = router;
