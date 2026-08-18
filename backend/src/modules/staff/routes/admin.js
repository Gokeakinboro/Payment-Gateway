'use strict';
/**
 * Staff CRM — SA admin routes.
 * Mounted at /api/v1/staff/admin/
 * Auth: requireAuth + requireSuperAdmin (SA only).
 */
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { requireAuth, requireSuperAdmin } = require('../../../middleware/auth');
const bcrypt = require('bcryptjs');
const { sendEmail, buildPlatformWelcomeEmail } = require('../../../services/emailService');


// ── GET /api/v1/staff/admin/staff-list ───────────────────────────────────
router.get('/staff-list', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.job_title,
             u.contract_type, u.is_active, u.created_at,
             COUNT(m.id) AS client_count
      FROM users u
      LEFT JOIN merchants m ON m.account_officer_id = u.id
      WHERE u.role = 'STAFF'
      GROUP BY u.id
      ORDER BY u.first_name, u.last_name
    `);
    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to load staff' });
  }
});

// ── POST /api/v1/staff/admin/staff ───────────────────────────────────────
// Create a new staff user
router.post('/staff', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { first_name, last_name, email, password, phone, job_title, contract_type } = req.body;
    if (!first_name || !last_name || !email || !password)
      return res.status(400).json({ status: false, message: 'first_name, last_name, email, password required' });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ status: false, message: 'Email already in use' });

    const hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        firstName: first_name,
        lastName:  last_name,
        email,
        passwordHash: hash,
        role: 'STAFF',
        mustChangePassword: true,
        phone:        phone         || undefined,
        jobTitle:     job_title     || undefined,
        contractType: contract_type || undefined,
      },
    });

    const { subject, html } = buildPlatformWelcomeEmail({ firstName: first_name, email, tempPassword: password, role: 'STAFF', jobTitle: job_title });
    sendEmail({ to: email, subject, html }).catch(err =>
      console.error('staff onboarding email failed:', err.message)
    );

    res.json({ status: true, message: 'Staff created', data: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('staff/create', err);
    res.status(500).json({ status: false, message: 'Failed to create staff' });
  }
});

// ── PATCH /api/v1/staff/admin/staff/:staffId ─────────────────────────────
// Activate / deactivate
router.patch('/staff/:staffId', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { is_active, first_name, last_name, phone, job_title, contract_type } = req.body;
    const data = {};
    if (is_active !== undefined)      data.isActive      = Boolean(is_active);
    if (first_name)                   data.firstName     = first_name;
    if (last_name)                    data.lastName      = last_name;
    if (phone !== undefined)          data.phone         = phone || null;
    if (job_title !== undefined)      data.jobTitle      = job_title || null;
    if (contract_type !== undefined)  data.contractType  = contract_type || null;

    await prisma.user.update({ where: { id: req.params.staffId }, data });
    res.json({ status: true, message: 'Staff updated' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Update failed' });
  }
});

// ── GET /api/v1/staff/admin/clients ──────────────────────────────────────
// All merchants with their officer details
router.get('/clients', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { officer_id, stage, search, industry } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (officer_id) {
      params.push(officer_id);
      where += ` AND m.account_officer_id = $${params.length}::uuid`;
    }
    if (officer_id === 'unassigned') {
      where = 'WHERE m.account_officer_id IS NULL';
    }
    if (stage) {
      params.push(stage);
      where += ` AND m.pipeline_stage = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (m.business_name ILIKE $${params.length} OR m.business_email ILIKE $${params.length})`;
    }
    if (industry) {
      params.push(industry);
      where += ` AND m.industry_type = $${params.length}`;
    }

    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        m.id, m.merchant_code, m.business_name, m.business_email, m.business_phone,
        m.kyc_status, m.is_active, m.pipeline_stage, m.industry_type, m.created_at,
        m.first_engagement_at, m.off_ramp_at, m.off_ramp_reason,
        u.id AS officer_id, u.first_name || ' ' || u.last_name AS officer_name,
        (SELECT COUNT(*) FROM staff_engagements se WHERE se.merchant_id=m.id) AS engagement_count,
        (SELECT MAX(se.engaged_at) FROM staff_engagements se WHERE se.merchant_id=m.id) AS last_engaged_at,
        (SELECT COALESCE(SUM(t.amount),0) FROM transactions t WHERE t.merchant_id=m.id AND t.status='SUCCESS') AS total_vol_kobo
      FROM merchants m
      LEFT JOIN users u ON u.id = m.account_officer_id
      ${where}
      ORDER BY m.business_name
      LIMIT 500
    `, ...params);

    res.json({ status: true, data: rows });
  } catch (err) {
    console.error('staff/admin/clients', err);
    res.status(500).json({ status: false, message: 'Failed to load clients' });
  }
});

// ── POST /api/v1/staff/admin/clients/:merchantId/transfer ─────────────────
// Transfer a merchant from one officer to another
router.post('/clients/:merchantId/transfer', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { to_staff_id, reason } = req.body;
    if (!to_staff_id) return res.status(400).json({ status: false, message: 'to_staff_id required' });

    const merchant = await prisma.$queryRawUnsafe(
      `SELECT id, account_officer_id FROM merchants WHERE id=$1::uuid`,
      req.params.merchantId
    );
    if (!merchant.length) return res.status(404).json({ status: false, message: 'Merchant not found' });

    const prevOfficer = merchant[0].account_officer_id;

    await prisma.$queryRawUnsafe(
      `UPDATE merchants SET account_officer_id=$1::uuid WHERE id=$2::uuid`,
      to_staff_id, req.params.merchantId
    );

    await prisma.$queryRawUnsafe(
      `INSERT INTO staff_reassignments(merchant_id,from_staff_id,to_staff_id,reassigned_by,reason)
       VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5)`,
      req.params.merchantId,
      prevOfficer || null,
      to_staff_id,
      req.user.id,
      reason || 'SA transfer'
    );

    res.json({ status: true, message: 'Client transferred' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Transfer failed' });
  }
});

// ── POST /api/v1/staff/admin/bulk-reassign ────────────────────────────────
// Move all clients from one officer to another (on staff departure)
router.post('/bulk-reassign', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { from_staff_id, to_staff_id, reason } = req.body;
    if (!from_staff_id || !to_staff_id)
      return res.status(400).json({ status: false, message: 'from_staff_id and to_staff_id required' });

    const merchants = await prisma.$queryRawUnsafe(
      `SELECT id FROM merchants WHERE account_officer_id=$1::uuid`, from_staff_id
    );

    await prisma.$queryRawUnsafe(
      `UPDATE merchants SET account_officer_id=$1::uuid WHERE account_officer_id=$2::uuid`,
      to_staff_id, from_staff_id
    );

    if (merchants.length) {
      const vals = merchants.map((m, i) => {
        const base = i * 5;
        return `($${base+1}::uuid,$${base+2}::uuid,$${base+3}::uuid,$${base+4}::uuid,$${base+5})`;
      }).join(',');
      const flat = merchants.flatMap((m) => [m.id, from_staff_id, to_staff_id, req.user.id, reason || 'bulk reassign on departure']);
      await prisma.$queryRawUnsafe(
        `INSERT INTO staff_reassignments(merchant_id,from_staff_id,to_staff_id,reassigned_by,reason) VALUES ${vals}`,
        ...flat
      );
    }

    res.json({ status: true, message: `${merchants.length} clients reassigned`, count: merchants.length });
  } catch (err) {
    console.error('staff/bulk-reassign', err);
    res.status(500).json({ status: false, message: 'Bulk reassign failed' });
  }
});

// ── GET /api/v1/staff/admin/performance ───────────────────────────────────
// Monthly leaderboard across all staff
router.get('/performance', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const from = `${month}-01`;

    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        u.id AS staff_id,
        u.first_name || ' ' || u.last_name AS officer_name,
        COUNT(DISTINCT m.id) AS total_clients,
        COUNT(DISTINCT m.id) FILTER (WHERE m.pipeline_stage = 'active') AS active_clients,
        COUNT(DISTINCT m.id) FILTER (WHERE date_trunc('month', m.created_at) = date_trunc('month', $1::date) AND m.account_officer_id = u.id) AS new_onboarded,
        COALESCE(eng.eng_count, 0) AS engagements,
        COALESCE(vol.vol_kobo, 0) AS vol_kobo,
        COALESCE(vol.txn_count, 0) AS txn_count
      FROM users u
      LEFT JOIN merchants m ON m.account_officer_id = u.id
      LEFT JOIN (
        SELECT staff_id, COUNT(*) AS eng_count
        FROM staff_engagements
        WHERE date_trunc('month', engaged_at) = date_trunc('month', $1::date)
        GROUP BY staff_id
      ) eng ON eng.staff_id = u.id
      LEFT JOIN (
        SELECT m2.account_officer_id, SUM(t.amount) AS vol_kobo, COUNT(*) AS txn_count
        FROM transactions t
        JOIN merchants m2 ON m2.id = t.merchant_id
        WHERE t.status = 'SUCCESS'
          AND date_trunc('month', t.created_at) = date_trunc('month', $1::date)
        GROUP BY m2.account_officer_id
      ) vol ON vol.account_officer_id = u.id
      WHERE u.role IN ('STAFF', 'SUPER_ADMIN') AND u.is_active = true
      GROUP BY u.id, u.first_name, u.last_name, eng.eng_count, vol.vol_kobo, vol.txn_count
      ORDER BY vol_kobo DESC, engagements DESC
    `, from);

    res.json({ status: true, data: rows, month });
  } catch (err) {
    console.error('staff/admin/performance', err);
    res.status(500).json({ status: false, message: 'Failed to load performance' });
  }
});

// ── GET /api/v1/staff/admin/reassignment-history/:merchantId ─────────────
router.get('/reassignment-history/:merchantId', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        sr.reassigned_at, sr.reason,
        f.first_name || ' ' || f.last_name AS from_name,
        t.first_name || ' ' || t.last_name AS to_name,
        b.first_name || ' ' || b.last_name AS by_name
      FROM staff_reassignments sr
      LEFT JOIN users f ON f.id = sr.from_staff_id
      LEFT JOIN users t ON t.id = sr.to_staff_id
      LEFT JOIN users b ON b.id = sr.reassigned_by
      WHERE sr.merchant_id = $1::uuid
      ORDER BY sr.reassigned_at DESC
    `, req.params.merchantId);
    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to load history' });
  }
});

module.exports = router;
