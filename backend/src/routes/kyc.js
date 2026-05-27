'use strict';
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const { prisma }   = require('../utils/db');
const { requireAuth, requireCompliance } = require('../middleware/auth');
const { ok, fail, notFound, created, generateApiKey, hashApiKey } = require('../utils/helpers');
const { sendEmail } = require('../services/emailService');
const { logAudit }  = require('../services/auditService');

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ status:false, message:e.array()[0].msg, error_code:'VALIDATION_ERROR' });
  next();
};

// ── POST /api/v1/kyc/submit — merchant submits KYC application ────────────
router.post('/submit', requireAuth,
  validate([
    body('tier_applied').isIn([1,2,3]).withMessage('tier_applied must be 1, 2, or 3'),
    body('owner.bvn').isLength({min:11,max:11}).matches(/^\d+$/).withMessage('BVN must be 11 digits'),
    body('owner.nin').isLength({min:11,max:11}).matches(/^\d+$/).withMessage('NIN must be 11 digits'),
    body('owner.first_name').notEmpty(),
    body('owner.last_name').notEmpty(),
    body('owner.dob').isDate().withMessage('Date of birth required (YYYY-MM-DD)'),
  ]),
  async (req, res, next) => {
    try {
      if (!req.user.merchant) return fail(res, 'No merchant account. Register as a merchant first.');
      const merchant = req.user.merchant;

      // Check if already has an active submission
      const existing = await prisma.kycSubmission.findFirst({
        where: { merchantId: merchant.id, status: { in: ['submitted','in_review'] } },
      });
      if (existing) return fail(res, 'You already have a KYC application in review. Please wait for a decision.', 'KYC_IN_PROGRESS');

      const submission = await prisma.kycSubmission.create({ data: {
        merchantId:  merchant.id,
        tierApplied: req.body.tier_applied,
        status:      'submitted',
        documents:   [], // documents uploaded separately via /kyc/documents
      }});

      // Update merchant KYC status
      await prisma.merchant.update({
        where: { id: merchant.id },
        data:  { kycStatus: 'KYC_IN_REVIEW' },
      });

      // Notify compliance team
      await sendEmail({
        to:      process.env.COMPLIANCE_EMAIL,
        subject: `New KYC Submission — ${req.user.merchant.businessName} (Tier ${req.body.tier_applied})`,
        html:    kycAlertEmail(req.user.merchant, submission),
      }).catch(() => {});

      created(res, {
        submission_id: submission.id,
        status:        'submitted',
        tier_applied:  submission.tierApplied,
        message:       `Your Tier ${submission.tierApplied} KYC application has been received. We'll review within ${submission.tierApplied === 1 ? 'the same business day' : '1-3 business days'}.`,
      }, 'KYC application submitted');
    } catch (e) { next(e); }
  }
);

// ── GET /api/v1/kyc/status — merchant checks their KYC status ─────────────
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    if (!req.user.merchant) return fail(res, 'No merchant account found');
    const merchant = await prisma.merchant.findUnique({
      where: { id: req.user.merchant.id },
      include: { kycSubmissions: { orderBy: { submittedAt: 'desc' }, take: 1 } },
    });

    const latest = merchant.kycSubmissions[0];
    ok(res, {
      kyc_status:   merchant.kycStatus,
      kyc_tier:     merchant.kycTier,
      is_active:    merchant.isActive,
      latest_submission: latest ? {
        id:             latest.id,
        status:         latest.status,
        tier_applied:   latest.tierApplied,
        rejection_code: latest.rejectionCode,
        review_notes:   latest.reviewNotes,
        submitted_at:   latest.submittedAt,
        approved_at:    latest.approvedAt,
      } : null,
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/kyc/queue — compliance officer: list pending submissions ──
router.get('/queue', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { status='submitted', page=1, perPage=20 } = req.query;
    const submissions = await prisma.kycSubmission.findMany({
      where:   { status },
      skip:    (parseInt(page)-1) * parseInt(perPage),
      take:    parseInt(perPage),
      orderBy: { submittedAt: 'asc' },
      include: {
        merchant: {
          include: { aggregator: { select: { companyName:true } } },
        },
      },
    });

    const counts = await prisma.kycSubmission.groupBy({
      by: ['status'], _count: true,
    });

    ok(res, { submissions: submissions.map(formatSubmission), counts });
  } catch (e) { next(e); }
});

// ── POST /api/v1/kyc/:id/approve — compliance officer approves KYC ────────
router.post('/:id/approve', requireAuth, requireCompliance,
  validate([body('notes').optional().isString()]),
  async (req, res, next) => {
    try {
      const submission = await prisma.kycSubmission.findUnique({
        where: { id: req.params.id },
        include: { merchant: { include: { user: true } } },
      });
      if (!submission) return notFound(res, 'KYC submission');
      if (submission.status === 'approved') return fail(res, 'Already approved');

      const merchant = submission.merchant;
      const tier     = submission.tierApplied;

      // Generate API keys
      const liveSecret = generateApiKey('sk_live');
      const testSecret = generateApiKey('sk_test');
      const livePub    = generateApiKey('pk_live');
      const testPub    = generateApiKey('pk_test');
      const webhookSec = crypto.randomBytes(32).toString('hex');

      await prisma.$transaction([
        // Update KYC submission
        prisma.kycSubmission.update({
          where: { id: submission.id },
          data: {
            status:     'approved',
            reviewedBy: req.user.id,
            approvedAt: new Date(),
            reviewNotes: req.body.notes || null,
          },
        }),
        // Activate merchant
        prisma.merchant.update({
          where: { id: merchant.id },
          data: {
            kycStatus:  'ACTIVE',
            kycTier:    tier,
            isActive:   true,
            webhookSecret: webhookSec,
            processingRate: tier === 1 ? 0.015 : tier === 2 ? 0.015 : 0.015, // set based on tier
          },
        }),
        // Create API keys
        prisma.apiKey.createMany({ data: [
          { merchantId: merchant.id, keyHash: hashApiKey(liveSecret), keyPrefix: 'sk_live', label: 'Live Secret Key',  isSandbox: false },
          { merchantId: merchant.id, keyHash: hashApiKey(testSecret), keyPrefix: 'sk_test', label: 'Test Secret Key',  isSandbox: true  },
          { merchantId: merchant.id, keyHash: hashApiKey(livePub),    keyPrefix: 'pk_live', label: 'Live Public Key',  isSandbox: false },
          { merchantId: merchant.id, keyHash: hashApiKey(testPub),    keyPrefix: 'pk_test', label: 'Test Public Key',  isSandbox: true  },
        ]}),
      ]);

      // Audit log
      await logAudit(req.user.id, 'KYC_APPROVED', 'kyc_submission', submission.id,
        { status: 'submitted' }, { status: 'approved', tier }, req.body.notes);

      // Send activation email to merchant
      await sendEmail({
        to:      merchant.user.email,
        subject: '🎉 Your Paylode account is now active!',
        html:    activationEmail(merchant, { liveSecret, testSecret, livePub, testPub, webhookSec, tier }),
      }).catch(() => {});

      ok(res, {
        merchant_id:     merchant.id,
        business_name:   merchant.businessName,
        kyc_tier:        tier,
        is_active:       true,
        credentials: {
          sk_live:        liveSecret,
          sk_test:        testSecret,
          pk_live:        livePub,
          pk_test:        testPub,
          webhook_secret: webhookSec,
        },
        message: 'Merchant KYC approved and account activated. Credentials sent to merchant email.',
      });
    } catch (e) { next(e); }
  }
);

// ── POST /api/v1/kyc/:id/reject — compliance officer rejects KYC ──────────
router.post('/:id/reject', requireAuth, requireCompliance,
  validate([
    body('rejection_code').notEmpty().withMessage('rejection_code required'),
    body('notes').notEmpty().withMessage('Provide details for the merchant'),
  ]),
  async (req, res, next) => {
    try {
      const submission = await prisma.kycSubmission.findUnique({
        where: { id: req.params.id },
        include: { merchant: { include: { user: true } } },
      });
      if (!submission) return notFound(res, 'KYC submission');

      await prisma.$transaction([
        prisma.kycSubmission.update({
          where: { id: submission.id },
          data: {
            status:        'rejected',
            reviewedBy:    req.user.id,
            rejectionCode: req.body.rejection_code,
            reviewNotes:   req.body.notes,
          },
        }),
        prisma.merchant.update({
          where: { id: submission.merchantId },
          data:  { kycStatus: 'KYC_REJECTED' },
        }),
      ]);

      await logAudit(req.user.id, 'KYC_REJECTED', 'kyc_submission', submission.id,
        { status: 'submitted' }, { status: 'rejected', code: req.body.rejection_code }, req.body.notes);

      await sendEmail({
        to:      submission.merchant.user.email,
        subject: 'Action required — Paylode KYC update',
        html:    rejectionEmail(submission.merchant, req.body.rejection_code, req.body.notes),
      }).catch(() => {});

      ok(res, { message: 'KYC rejected. Merchant has been notified.' });
    } catch (e) { next(e); }
  }
);

function formatSubmission(s) {
  return {
    id:           s.id,
    status:       s.status,
    tier_applied: s.tierApplied,
    merchant: {
      id:            s.merchant.id,
      name:          s.merchant.businessName,
      code:          s.merchant.merchantCode,
      category:      s.merchant.category,
      rc_number:     s.merchant.rcNumber,
      state:         s.merchant.state,
      email:         s.merchant.businessEmail,
      aggregator:    s.merchant.aggregator?.companyName || null,
    },
    submitted_at:  s.submittedAt,
    rejection_code:s.rejectionCode,
  };
}

const kycAlertEmail = (merchant, sub) => `
  <h2>New KYC Submission</h2>
  <p><strong>Merchant:</strong> ${merchant.businessName}</p>
  <p><strong>Tier Applied:</strong> ${sub.tierApplied}</p>
  <p><strong>Submission ID:</strong> ${sub.id}</p>
  <p><a href="${process.env.APP_URL}/compliance/kyc/${sub.id}">Review in Compliance Dashboard →</a></p>
`;

const activationEmail = (merchant, creds) => `
  <h2>🎉 Your Paylode account is active!</h2>
  <p>Hello ${merchant.businessName},</p>
  <p>Your Tier ${creds.tier} KYC has been approved. You can now start accepting payments.</p>
  <h3>Your API Credentials</h3>
  <p><strong>Live Secret Key:</strong> ${creds.liveSecret}</p>
  <p><strong>Test Secret Key:</strong> ${creds.testSecret}</p>
  <p><strong>Live Public Key:</strong> ${creds.livePub}</p>
  <p><strong>Test Public Key:</strong> ${creds.testPub}</p>
  <p><strong>Webhook Secret:</strong> ${creds.webhookSec}</p>
  <p style="color:red"><strong>Keep your secret keys private. Never expose them in client-side code.</strong></p>
  <p><a href="${process.env.APP_URL}/merchant">Access your merchant dashboard →</a></p>
`;

const rejectionEmail = (merchant, code, notes) => `
  <h2>KYC Application Update</h2>
  <p>Hello ${merchant.businessName},</p>
  <p>Your KYC application requires attention. Reason: <strong>${code}</strong></p>
  <p>${notes}</p>
  <p>Please log in to your dashboard to resubmit the corrected documents.</p>
  <p><a href="${process.env.APP_URL}/merchant/kyc">Resubmit documents →</a></p>
`;

module.exports = router;
