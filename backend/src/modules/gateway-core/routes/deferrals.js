'use strict';
const router  = require('express').Router();
const { body, validationResult } = require('express-validator');
const { prisma }  = require('../../../utils/db');
const { ok, fail, notFound } = require('../../../utils/helpers');
const { requireAuth, requireSuperAdmin } = require('../../../middleware/auth');
const { logAudit } = require('../../../services/auditService');
const { sendEmail, getEmailContent } = require('../../../services/emailService');
const { logger } = require('../../../utils/logger');

const MAX_DEFERRALS    = 2;
const VALID_DURATIONS  = [1, 2, 3, 6];

// Notify the applicant their documents were deferred — which docs, the period,
// and that their ability to transact may be impaired if not corrected in time.
async function sendDeferralEmail(to, name, reason, durationMonths, expiresAt) {
  if (!to) return;
  const by = new Date(expiresAt).toLocaleDateString('en-NG', { year:'numeric', month:'long', day:'numeric' });
  const docs = (reason && reason.trim()) ? reason.trim() : 'the outstanding documents';
  const content = await getEmailContent('documents_deferred',
    { name, business: name, documents: docs, duration_months: durationMonths, expires_at: by },
    'Action needed: documents deferred on your Paylode account',
    `<h2>Documents deferred</h2><p>Hi ${name},</p>` +
      `<p>Your account is active, but we have <strong>deferred</strong> the following document(s): <strong>${docs}</strong>.</p>` +
      `<p>Please provide or correct them within <strong>${durationMonths} month${durationMonths>1?'s':''}</strong> — by <strong>${by}</strong>.</p>` +
      `<p style="color:#b91c1c"><strong>Important:</strong> if these documents are not provided/corrected before ${by}, your ability to carry out transactions may be impaired or suspended.</p>`);
  await sendEmail({ to, subject: content.subject, html: content.html });
}

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ status:false, message:e.array()[0].msg });
  next();
};

const deferBody = [
  body('duration_months').isIn(VALID_DURATIONS).withMessage('duration_months must be 1, 2, 3 or 6'),
  body('reason').optional().isString().trim().isLength({ max:500 }),
];

// ── POST /api/v1/deferrals/merchants/:id ──────────────────────────────────────
router.post('/merchants/:id', requireAuth, requireSuperAdmin, validate(deferBody),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { duration_months, reason } = req.body;

      const merchant = await prisma.merchant.findUnique({ where:{ id } });
      if (!merchant) return notFound(res, 'Merchant');

      const [row] = await prisma.$queryRaw`
        SELECT COUNT(*)::int AS cnt FROM document_deferrals
        WHERE entity_type = 'merchant' AND entity_id = ${id}::uuid
      `;
      if (row.cnt >= MAX_DEFERRALS)
        return fail(res, `This merchant has already used the maximum of ${MAX_DEFERRALS} deferrals.`, 'MAX_DEFERRALS_REACHED');

      await prisma.$executeRaw`
        UPDATE document_deferrals SET status = 'superseded'
        WHERE entity_type = 'merchant' AND entity_id = ${id}::uuid AND status = 'active'
      `;

      const now      = new Date();
      const expiresAt = new Date(now);
      expiresAt.setMonth(expiresAt.getMonth() + Number(duration_months));

      const [deferral] = await prisma.$queryRaw`
        INSERT INTO document_deferrals
          (entity_type, entity_id, deferred_by, duration_months, reason, deferred_at, expires_at, status)
        VALUES ('merchant', ${id}::uuid, ${req.user.id}::uuid, ${Number(duration_months)},
                ${reason||null}, ${now}, ${expiresAt}, 'active')
        RETURNING *
      `;

      await prisma.merchant.update({
        where:{ id },
        data:{ isActive:true, kycStatus:'ACTIVE' },
      });

      await logAudit(req.user.id, 'MERCHANT_DOCS_DEFERRED', 'merchants', id, {}, {
        duration_months, reason, expires_at:expiresAt, deferrals_used: row.cnt + 1,
      });

      sendDeferralEmail(merchant.businessEmail, merchant.businessName, reason, Number(duration_months), expiresAt)
        .catch(e => logger.error({ err: e, id }, 'merchant deferral email failed'));

      ok(res, {
        deferral_id:      deferral.id,
        expires_at:       expiresAt,
        deferrals_used:   row.cnt + 1,
        deferrals_max:    MAX_DEFERRALS,
        can_defer_again:  (row.cnt + 1) < MAX_DEFERRALS,
        merchant_name:    merchant.businessName,
      }, `Documents deferred ${duration_months} month${duration_months>1?'s':''}. Account is now active.`);

    } catch(e) { next(e); }
  }
);

// ── POST /api/v1/deferrals/aggregators/:id ───────────────────────────────────
router.post('/aggregators/:id', requireAuth, requireSuperAdmin, validate(deferBody),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { duration_months, reason } = req.body;

      const agg = await prisma.aggregator.findUnique({ where:{ id }, include:{ user:{ select:{ email:true } } } });
      if (!agg) return notFound(res, 'Aggregator');

      const [row] = await prisma.$queryRaw`
        SELECT COUNT(*)::int AS cnt FROM document_deferrals
        WHERE entity_type = 'aggregator' AND entity_id = ${id}::uuid
      `;
      if (row.cnt >= MAX_DEFERRALS)
        return fail(res, `This aggregator has already used the maximum of ${MAX_DEFERRALS} deferrals.`, 'MAX_DEFERRALS_REACHED');

      await prisma.$executeRaw`
        UPDATE document_deferrals SET status = 'superseded'
        WHERE entity_type = 'aggregator' AND entity_id = ${id}::uuid AND status = 'active'
      `;

      const now       = new Date();
      const expiresAt = new Date(now);
      expiresAt.setMonth(expiresAt.getMonth() + Number(duration_months));

      const [deferral] = await prisma.$queryRaw`
        INSERT INTO document_deferrals
          (entity_type, entity_id, deferred_by, duration_months, reason, deferred_at, expires_at, status)
        VALUES ('aggregator', ${id}::uuid, ${req.user.id}::uuid, ${Number(duration_months)},
                ${reason||null}, ${now}, ${expiresAt}, 'active')
        RETURNING *
      `;

      await prisma.aggregator.update({ where:{ id }, data:{ status:'active' } });

      await logAudit(req.user.id, 'AGGREGATOR_DOCS_DEFERRED', 'aggregators', id, {}, {
        duration_months, reason, expires_at:expiresAt, deferrals_used: row.cnt + 1,
      });

      sendDeferralEmail(agg.user && agg.user.email, agg.companyName, reason, Number(duration_months), expiresAt)
        .catch(e => logger.error({ err: e, id }, 'aggregator deferral email failed'));

      ok(res, {
        deferral_id:      deferral.id,
        expires_at:       expiresAt,
        deferrals_used:   row.cnt + 1,
        deferrals_max:    MAX_DEFERRALS,
        can_defer_again:  (row.cnt + 1) < MAX_DEFERRALS,
        aggregator_name:  agg.companyName,
      }, `Documents deferred ${duration_months} month${duration_months>1?'s':''}. Account is now active.`);

    } catch(e) { next(e); }
  }
);

// ── GET /api/v1/deferrals/merchants/:id ──────────────────────────────────────
router.get('/merchants/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const deferrals = await prisma.$queryRaw`
      SELECT d.*, u.email AS deferred_by_email
      FROM document_deferrals d
      LEFT JOIN users u ON d.deferred_by = u.id
      WHERE d.entity_type = 'merchant' AND d.entity_id = ${req.params.id}::uuid
      ORDER BY d.created_at DESC
    `;
    ok(res, {
      deferrals,
      deferrals_used:      deferrals.length,
      deferrals_remaining: Math.max(0, MAX_DEFERRALS - deferrals.length),
      can_defer:           deferrals.length < MAX_DEFERRALS,
      active_deferral:     deferrals.find(d => d.status === 'active') || null,
    });
  } catch(e) { next(e); }
});

// ── GET /api/v1/deferrals/aggregators/:id ────────────────────────────────────
router.get('/aggregators/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const deferrals = await prisma.$queryRaw`
      SELECT d.*, u.email AS deferred_by_email
      FROM document_deferrals d
      LEFT JOIN users u ON d.deferred_by = u.id
      WHERE d.entity_type = 'aggregator' AND d.entity_id = ${req.params.id}::uuid
      ORDER BY d.created_at DESC
    `;
    ok(res, {
      deferrals,
      deferrals_used:      deferrals.length,
      deferrals_remaining: Math.max(0, MAX_DEFERRALS - deferrals.length),
      can_defer:           deferrals.length < MAX_DEFERRALS,
      active_deferral:     deferrals.find(d => d.status === 'active') || null,
    });
  } catch(e) { next(e); }
});

module.exports = router;
