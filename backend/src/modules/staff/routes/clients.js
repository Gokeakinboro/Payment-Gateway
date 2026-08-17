'use strict';
/**
 * Staff CRM — staff-facing routes.
 * Mounted at /api/v1/staff/
 * Auth: requireAuth + requireStaff (SUPER_ADMIN or STAFF role).
 */
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { requireAuth, requireRole } = require('../../../middleware/auth');

const requireStaff = requireRole('SUPER_ADMIN', 'STAFF');

// ── helpers ──────────────────────────────────────────────────────────────────
const ngn = (k) => (Number(k || 0) / 100);
const isSA = (u) => u.role === 'SUPER_ADMIN';

// Return the staff_id filter: SA sees all when no filter, staff sees only themselves
function officerFilter(req) {
  if (isSA(req.user)) return null; // SA: no filter unless they explicitly pass one
  return req.user.id;
}

// ── GET /api/v1/staff/clients ─────────────────────────────────────────────
// List all merchants assigned to this staff member.
router.get('/clients', requireAuth, requireStaff, async (req, res) => {
  try {
    const officerId = officerFilter(req);
    const { search, stage } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (officerId) {
      params.push(officerId);
      where += ` AND m.account_officer_id = $${params.length}::uuid`;
    }
    if (stage) {
      params.push(stage);
      where += ` AND m.pipeline_stage = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (m.business_name ILIKE $${params.length} OR m.business_email ILIKE $${params.length} OR m.merchant_code ILIKE $${params.length})`;
    }

    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        m.id, m.merchant_code, m.business_name, m.business_email, m.business_phone,
        m.kyc_status, m.is_active, m.pipeline_stage, m.off_ramp_reason, m.off_ramp_at,
        m.first_engagement_at, m.created_at,
        u.first_name || ' ' || u.last_name AS officer_name,
        u.id AS officer_id,
        (SELECT COUNT(*) FROM transactions t WHERE t.merchant_id = m.id) AS txn_count,
        (SELECT COALESCE(SUM(t.amount_kobo),0) FROM transactions t WHERE t.merchant_id = m.id AND t.status = 'SUCCESS') AS total_vol_kobo,
        (SELECT MAX(t.created_at) FROM transactions t WHERE t.merchant_id = m.id) AS last_txn_at,
        (SELECT COUNT(*) FROM staff_engagements se WHERE se.merchant_id = m.id) AS engagement_count,
        (SELECT MAX(se.engaged_at) FROM staff_engagements se WHERE se.merchant_id = m.id) AS last_engaged_at
      FROM merchants m
      LEFT JOIN users u ON u.id = m.account_officer_id
      ${where}
      ORDER BY m.business_name
      LIMIT 200
    `, ...params);

    res.json({ status: true, data: rows });
  } catch (err) {
    console.error('staff/clients error', err);
    res.status(500).json({ status: false, message: 'Failed to load clients' });
  }
});

// ── GET /api/v1/staff/clients/search-unassigned ───────────────────────────
// Search all merchants (for assigning to self or onboarding)
router.get('/clients/search-unassigned', requireAuth, requireStaff, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ status: true, data: [] });

    const rows = await prisma.$queryRawUnsafe(`
      SELECT m.id, m.merchant_code, m.business_name, m.business_email, m.business_phone,
             m.kyc_status, m.pipeline_stage, m.account_officer_id,
             u.first_name || ' ' || u.last_name AS officer_name
      FROM merchants m
      LEFT JOIN users u ON u.id = m.account_officer_id
      WHERE m.business_name ILIKE $1 OR m.business_email ILIKE $1 OR m.merchant_code ILIKE $1
      ORDER BY m.business_name LIMIT 20
    `, `%${q}%`);

    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Search failed' });
  }
});

// ── GET /api/v1/staff/clients/:merchantId ─────────────────────────────────
router.get('/clients/:merchantId', requireAuth, requireStaff, async (req, res) => {
  try {
    const officerId = officerFilter(req);
    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        m.id, m.merchant_code, m.business_name, m.business_email, m.business_phone,
        m.kyc_status, m.is_active, m.pipeline_stage, m.off_ramp_reason, m.off_ramp_at,
        m.first_engagement_at, m.created_at,
        u.first_name || ' ' || u.last_name AS officer_name, u.id AS officer_id
      FROM merchants m
      LEFT JOIN users u ON u.id = m.account_officer_id
      WHERE m.id = $1::uuid
        ${officerId ? 'AND m.account_officer_id = $2::uuid' : ''}
    `, ...(officerId ? [req.params.merchantId, officerId] : [req.params.merchantId]));

    if (!rows.length) return res.status(404).json({ status: false, message: 'Client not found' });
    res.json({ status: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to load client' });
  }
});

// ── PATCH /api/v1/staff/clients/:merchantId ───────────────────────────────
// Update business info + pipeline stage
router.patch('/clients/:merchantId', requireAuth, requireStaff, async (req, res) => {
  try {
    const officerId = officerFilter(req);
    const { business_name, business_email, business_phone, pipeline_stage, off_ramp_reason, first_engagement_at } = req.body;

    // Verify ownership
    const check = await prisma.$queryRawUnsafe(
      `SELECT id FROM merchants WHERE id = $1::uuid ${officerId ? 'AND account_officer_id = $2::uuid' : ''}`,
      ...(officerId ? [req.params.merchantId, officerId] : [req.params.merchantId])
    );
    if (!check.length) return res.status(404).json({ status: false, message: 'Client not found' });

    const sets = [];
    const vals = [];

    if (business_name !== undefined)   { vals.push(business_name);   sets.push(`business_name=$${vals.length}`); }
    if (business_email !== undefined)  { vals.push(business_email);  sets.push(`business_email=$${vals.length}`); }
    if (business_phone !== undefined)  { vals.push(business_phone);  sets.push(`business_phone=$${vals.length}`); }
    if (pipeline_stage !== undefined)  { vals.push(pipeline_stage);  sets.push(`pipeline_stage=$${vals.length}`); }
    if (off_ramp_reason !== undefined) { vals.push(off_ramp_reason); sets.push(`off_ramp_reason=$${vals.length}`); }
    if (first_engagement_at !== undefined) {
      vals.push(first_engagement_at || null);
      sets.push(`first_engagement_at=$${vals.length}`);
    }
    if (pipeline_stage === 'churned' && off_ramp_reason !== undefined) {
      sets.push(`off_ramp_at=NOW()`);
    }

    if (!sets.length) return res.json({ status: true, message: 'Nothing to update' });

    vals.push(req.params.merchantId);
    await prisma.$queryRawUnsafe(
      `UPDATE merchants SET ${sets.join(',')} WHERE id=$${vals.length}::uuid`,
      ...vals
    );

    res.json({ status: true, message: 'Client updated' });
  } catch (err) {
    console.error('staff/patch-client', err);
    res.status(500).json({ status: false, message: 'Update failed' });
  }
});

// ── POST /api/v1/staff/clients/:merchantId/assign-self ────────────────────
// Staff claims an unassigned merchant (or SA assigns to themselves)
router.post('/clients/:merchantId/assign-self', requireAuth, requireStaff, async (req, res) => {
  try {
    const { reason } = req.body;
    const mid = req.params.merchantId;

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, account_officer_id FROM merchants WHERE id=$1::uuid`, mid
    );
    if (!existing.length) return res.status(404).json({ status: false, message: 'Merchant not found' });

    const prev = existing[0].account_officer_id;

    await prisma.$queryRawUnsafe(
      `UPDATE merchants SET account_officer_id=$1::uuid WHERE id=$2::uuid`,
      req.user.id, mid
    );

    await prisma.$queryRawUnsafe(
      `INSERT INTO staff_reassignments(merchant_id,from_staff_id,to_staff_id,reassigned_by,reason)
       VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5)`,
      mid,
      prev || null,
      req.user.id,
      req.user.id,
      reason || 'self-assigned'
    );

    res.json({ status: true, message: 'Client assigned to you' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Assignment failed' });
  }
});

// ── GET /api/v1/staff/clients/:merchantId/engagements ─────────────────────
router.get('/clients/:merchantId/engagements', requireAuth, requireStaff, async (req, res) => {
  try {
    const officerId = officerFilter(req);
    if (officerId) {
      const check = await prisma.$queryRawUnsafe(
        `SELECT id FROM merchants WHERE id=$1::uuid AND account_officer_id=$2::uuid`,
        req.params.merchantId, officerId
      );
      if (!check.length) return res.status(404).json({ status: false, message: 'Not found' });
    }

    const rows = await prisma.$queryRawUnsafe(`
      SELECT se.id, se.type, se.notes, se.engaged_at,
             u.first_name || ' ' || u.last_name AS logged_by
      FROM staff_engagements se
      JOIN users u ON u.id = se.staff_id
      WHERE se.merchant_id = $1::uuid
      ORDER BY se.engaged_at DESC
      LIMIT 100
    `, req.params.merchantId);

    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to load engagements' });
  }
});

// ── POST /api/v1/staff/clients/:merchantId/engagements ────────────────────
router.post('/clients/:merchantId/engagements', requireAuth, requireStaff, async (req, res) => {
  try {
    const { type, notes, engaged_at } = req.body;
    const VALID_TYPES = ['call', 'visit', 'email', 'whatsapp', 'demo', 'other'];
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ status: false, message: 'Invalid engagement type' });

    const officerId = officerFilter(req);
    if (officerId) {
      const check = await prisma.$queryRawUnsafe(
        `SELECT id FROM merchants WHERE id=$1::uuid AND account_officer_id=$2::uuid`,
        req.params.merchantId, officerId
      );
      if (!check.length) return res.status(404).json({ status: false, message: 'Not found' });
    }

    await prisma.$queryRawUnsafe(
      `INSERT INTO staff_engagements(merchant_id, staff_id, type, notes, engaged_at)
       VALUES($1::uuid, $2::uuid, $3, $4, $5)`,
      req.params.merchantId, req.user.id, type, notes || null,
      engaged_at ? new Date(engaged_at) : new Date()
    );

    // If this is the first engagement, stamp first_engagement_at
    await prisma.$queryRawUnsafe(
      `UPDATE merchants SET first_engagement_at=COALESCE(first_engagement_at, NOW())
       WHERE id=$1::uuid`,
      req.params.merchantId
    );

    res.json({ status: true, message: 'Engagement logged' });
  } catch (err) {
    console.error('staff/log-engagement', err);
    res.status(500).json({ status: false, message: 'Failed to log engagement' });
  }
});

// ── GET /api/v1/staff/clients/:merchantId/transactions ────────────────────
router.get('/clients/:merchantId/transactions', requireAuth, requireStaff, async (req, res) => {
  try {
    const officerId = officerFilter(req);
    if (officerId) {
      const check = await prisma.$queryRawUnsafe(
        `SELECT id FROM merchants WHERE id=$1::uuid AND account_officer_id=$2::uuid`,
        req.params.merchantId, officerId
      );
      if (!check.length) return res.status(404).json({ status: false, message: 'Not found' });
    }

    const rows = await prisma.$queryRawUnsafe(`
      SELECT t.id, t.txn_ref, t.status, t.amount_kobo, t.fee_kobo, t.channel,
             t.customer_email, t.created_at
      FROM transactions t
      WHERE t.merchant_id = $1::uuid
      ORDER BY t.created_at DESC
      LIMIT 100
    `, req.params.merchantId);

    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to load transactions' });
  }
});

// ── GET /api/v1/staff/clients/:merchantId/settlements ────────────────────
router.get('/clients/:merchantId/settlements', requireAuth, requireStaff, async (req, res) => {
  try {
    const officerId = officerFilter(req);
    if (officerId) {
      const check = await prisma.$queryRawUnsafe(
        `SELECT id FROM merchants WHERE id=$1::uuid AND account_officer_id=$2::uuid`,
        req.params.merchantId, officerId
      );
      if (!check.length) return res.status(404).json({ status: false, message: 'Not found' });
    }

    const rows = await prisma.$queryRawUnsafe(`
      SELECT s.id, s.period_from, s.period_to, s.gross_kobo, s.fee_kobo, s.net_kobo,
             s.txn_count, s.status, s.payout_ref, s.created_at
      FROM mw_dept_settlements s
      WHERE s.merchant_id = $1::uuid
      ORDER BY s.created_at DESC
      LIMIT 50
    `, req.params.merchantId);

    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to load settlements' });
  }
});

// ── GET /api/v1/staff/performance ─────────────────────────────────────────
// Monthly KPIs for the logged-in staff member
router.get('/performance', requireAuth, requireStaff, async (req, res) => {
  try {
    const staffId = isSA(req.user) ? (req.query.staff_id || req.user.id) : req.user.id;
    const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
    const from = `${month}-01`;
    const to   = `${month}-01`; // will use date_trunc

    const [clients, engagements, pipeline, txnVol] = await Promise.all([
      // Total assigned clients
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE pipeline_stage='active') AS active_count
         FROM merchants WHERE account_officer_id=$1::uuid`, staffId
      ),
      // Engagements this month
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE type='call') AS calls,
                COUNT(*) FILTER (WHERE type='visit') AS visits,
                COUNT(*) FILTER (WHERE type='email') AS emails,
                COUNT(*) FILTER (WHERE type='whatsapp') AS whatsapps,
                COUNT(*) FILTER (WHERE type='demo') AS demos
         FROM staff_engagements
         WHERE staff_id=$1::uuid
           AND date_trunc('month', engaged_at) = date_trunc('month', $2::date)`,
        staffId, from
      ),
      // Pipeline breakdown
      prisma.$queryRawUnsafe(
        `SELECT pipeline_stage, COUNT(*) AS cnt
         FROM merchants WHERE account_officer_id=$1::uuid
         GROUP BY pipeline_stage`, staffId
      ),
      // Transaction volume for clients this month
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS txn_count, COALESCE(SUM(t.amount_kobo),0) AS vol_kobo,
                COUNT(DISTINCT t.merchant_id) AS active_clients
         FROM transactions t
         JOIN merchants m ON m.id = t.merchant_id
         WHERE m.account_officer_id=$1::uuid
           AND t.status='SUCCESS'
           AND date_trunc('month', t.created_at) = date_trunc('month', $2::date)`,
        staffId, from
      ),
    ]);

    res.json({
      status: true,
      data: {
        month,
        clients: clients[0],
        engagements: engagements[0],
        pipeline,
        txnVol: txnVol[0],
      },
    });
  } catch (err) {
    console.error('staff/performance', err);
    res.status(500).json({ status: false, message: 'Failed to load performance' });
  }
});

module.exports = router;
