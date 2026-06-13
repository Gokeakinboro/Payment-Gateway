'use strict';
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const { prisma }   = require('../utils/db');
const { requireAuth, requireCompliance, requireAdminOrCompliance } = require('../middleware/auth');
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { verifyBvn, verifyNin, verifyCac } = require('../services/youverifyService');

const ADDR_UPLOAD_DIR = '/var/www/paylode/uploads/kyc/addr-reports';
if (!fs.existsSync(ADDR_UPLOAD_DIR)) fs.mkdirSync(ADDR_UPLOAD_DIR, { recursive: true });
const addrUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ADDR_UPLOAD_DIR),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, 'addr-' + req.params.id + '-' + Date.now() + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.(pdf|jpg|jpeg|png)$/.test(path.extname(file.originalname).toLowerCase()))
      return cb(new Error('Only PDF, JPG and PNG files are allowed'));
    cb(null, true);
  },
});
const { ok, fail, notFound, created, generateApiKey, hashApiKey } = require('../utils/helpers');
const { sendEmail, getEmailContent } = require('../services/emailService');
const { logAudit }  = require('../services/auditService');

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ status:false, message:e.array()[0].msg, error_code:'VALIDATION_ERROR' });
  next();
};

// ── YouVerify background checks ──────────────────────────────────────────────
// Fires after KYC submission is created. Does NOT block the response.
async function runYouVerifyChecks(submissionId, merchantId, owner, isBusinessMerchant, rcNumber, businessName) {
  try {
    const updates = {
      bvnCheckStatus: 'running',
      ninCheckStatus: 'running',
      ...(isBusinessMerchant && rcNumber ? { cacCheckStatus: 'running' } : {}),
    };
    await prisma.kycSubmission.update({ where: { id: submissionId }, data: updates });

    const [bvnResult, ninResult] = await Promise.allSettled([
      verifyBvn(owner.bvn, owner.first_name, owner.last_name, owner.dob),
      verifyNin(owner.nin, owner.first_name, owner.last_name),
    ]);

    const bvn = bvnResult.status === 'fulfilled' ? bvnResult.value : { success: false, message: bvnResult.reason?.message };
    const nin = ninResult.status === 'fulfilled' ? ninResult.value : { success: false, message: ninResult.reason?.message };

    const bvnStatus = bvn.success ? 'verified' : 'failed';
    const ninStatus = nin.success ? 'verified' : 'failed';

    const kycUpdates = {
      bvnCheckStatus: bvnStatus,
      ninCheckStatus: ninStatus,
      bvnVerified:    bvn.success,
      ninVerified:    nin.success,
      bvnData:        bvn.raw || null,
      ninData:        nin.raw || null,
      ...(bvn.requestId ? { yvBvnRef: bvn.requestId } : {}),
      ...(nin.requestId ? { yvNinRef: nin.requestId } : {}),
    };

    // CAC check for business merchants
    if (isBusinessMerchant && rcNumber) {
      try {
        const cac = await verifyCac(rcNumber, businessName);
        kycUpdates.cacCheckStatus = cac.success ? 'verified' : 'failed';
        kycUpdates.cacVerified    = cac.success;
        kycUpdates.cacData        = cac.raw || null;
        if (cac.requestId) kycUpdates.yvCacRef = cac.requestId;
      } catch {
        kycUpdates.cacCheckStatus = 'failed';
      }
    }

    await prisma.kycSubmission.update({ where: { id: submissionId }, data: kycUpdates });

    // Auto-approve Tier 1 if BVN + NIN both pass (CAC not required for Tier 1)
    const submission = await prisma.kycSubmission.findUnique({ where: { id: submissionId } });
    if (submission?.tierApplied === 1 && bvn.success && nin.success) {
      await autoApproveTier1(submissionId, merchantId);
    }

    await logAudit(null, 'YOUVERIFY_CHECKS_COMPLETE', 'kyc_submissions', submissionId, {}, {
      bvn: bvnStatus, nin: ninStatus,
      cac: kycUpdates.cacCheckStatus || 'not_required',
    });
  } catch (err) {
    // Failures logged but do not affect the submitted KYC
    await prisma.kycSubmission.update({
      where: { id: submissionId },
      data: { bvnCheckStatus: 'failed', ninCheckStatus: 'failed' },
    }).catch(() => {});
  }
}

async function autoApproveTier1(submissionId, merchantId) {
  const existing = await prisma.kycSubmission.findUnique({ where: { id: submissionId } });
  if (!existing || existing.status !== 'submitted') return;

  const liveSecret = generateApiKey('sk_live');
  const testSecret = generateApiKey('sk_test');
  const livePub    = generateApiKey('pk_live');
  const testPub    = generateApiKey('pk_test');
  const webhookSec = crypto.randomBytes(32).toString('hex');

  await prisma.$transaction([
    prisma.kycSubmission.update({
      where: { id: submissionId },
      data: { status: 'approved', approvedAt: new Date(), reviewNotes: 'Auto-approved via YouVerify (BVN + NIN verified)' },
    }),
    prisma.merchant.update({
      where: { id: merchantId },
      data: { kycStatus: 'ACTIVE', kycTier: 1, isActive: true, webhookSecret: webhookSec, processingRate: 0.015 },
    }),
    prisma.apiKey.createMany({ data: [
      { merchantId, keyHash: hashApiKey(liveSecret), keyPrefix: 'sk_live', label: 'Live Secret Key',  isSandbox: false },
      { merchantId, keyHash: hashApiKey(testSecret), keyPrefix: 'sk_test', label: 'Test Secret Key',  isSandbox: true  },
      { merchantId, keyHash: hashApiKey(livePub),    keyPrefix: 'pk_live', label: 'Live Public Key',  isSandbox: false },
      { merchantId, keyHash: hashApiKey(testPub),    keyPrefix: 'pk_test', label: 'Test Public Key',  isSandbox: true  },
    ]}),
  ]);

  await logAudit(null, 'KYC_AUTO_APPROVED_TIER1', 'kyc_submissions', submissionId, {}, {
    reason: 'BVN + NIN verified via YouVerify',
    merchantId,
  });
}

// ── POST /api/v1/kyc/submit ──────────────────────────────────────────────────
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

      const existing = await prisma.kycSubmission.findFirst({
        where: { merchantId: merchant.id, status: { in: ['submitted','in_review'] } },
      });
      if (existing) return fail(res, 'You already have a KYC application in review.', 'KYC_IN_PROGRESS');

      const submission = await prisma.kycSubmission.create({ data: {
        merchantId:      merchant.id,
        tierApplied:     req.body.tier_applied,
        status:          'submitted',
        documents:       [],
        bvnCheckStatus:  'pending',
        ninCheckStatus:  'pending',
        cacCheckStatus:  merchant.businessType === 'individual' ? 'not_required' : 'pending',
      }});

      await prisma.merchant.update({ where: { id: merchant.id }, data: { kycStatus: 'KYC_IN_REVIEW' } });

      // Fire YouVerify checks in background — does not block response
      const isBusinessMerchant = merchant.businessType !== 'individual';
      setImmediate(() => {
        runYouVerifyChecks(
          submission.id, merchant.id, req.body.owner,
          isBusinessMerchant, merchant.rcNumber, merchant.businessName
        );
      });

      const _alertEmail = await getEmailContent('kyc_alert',
        { merchant_name: merchant.businessName, tier_applied: req.body.tier_applied, submission_id: submission.id, submitted_at: new Date().toLocaleString(), dashboard_url: (process.env.APP_URL||'')+'/dashboard.html' },
        `New KYC Submission — ${merchant.businessName} (Tier ${req.body.tier_applied})`,
        kycAlertEmail(merchant, submission));
      await sendEmail({ to: process.env.COMPLIANCE_EMAIL, subject: _alertEmail.subject, html: _alertEmail.html }).catch(() => {});

      created(res, {
        submission_id:    submission.id,
        status:           'submitted',
        tier_applied:     submission.tierApplied,
        youverify_checks: 'running',
        message: `Your Tier ${submission.tierApplied} KYC application has been received. Identity checks are running automatically.`,
      }, 'KYC application submitted');
    } catch (e) { next(e); }
  }
);

// ── GET /api/v1/kyc/status ───────────────────────────────────────────────────
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
        id:               latest.id,
        status:           latest.status,
        tier_applied:     latest.tierApplied,
        rejection_code:   latest.rejectionCode,
        review_notes:     latest.reviewNotes,
        submitted_at:     latest.submittedAt,
        approved_at:      latest.approvedAt,
        checks: {
          bvn: latest.bvnCheckStatus,
          nin: latest.ninCheckStatus,
          cac: latest.cacCheckStatus,
        },
      } : null,
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/kyc/queue ────────────────────────────────────────────────────
router.get('/queue', requireAuth, requireAdminOrCompliance, async (req, res, next) => {
  try {
    const { status='submitted', page=1, perPage=20 } = req.query;
    const submissions = await prisma.kycSubmission.findMany({
      where:   { status },
      skip:    (parseInt(page)-1) * parseInt(perPage),
      take:    parseInt(perPage),
      orderBy: { submittedAt: 'asc' },
      include: { merchant: { include: { aggregator: { select: { companyName: true } } } } },
    });
    const counts = await prisma.kycSubmission.groupBy({ by: ['status'], _count: true });
    ok(res, { submissions: submissions.map(formatSubmission), counts });
  } catch (e) { next(e); }
});

// ── POST /api/v1/kyc/:id/approve ─────────────────────────────────────────────
router.post('/:id/approve', requireAuth, requireAdminOrCompliance,
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

      const liveSecret = generateApiKey('sk_live');
      const testSecret = generateApiKey('sk_test');
      const livePub    = generateApiKey('pk_live');
      const testPub    = generateApiKey('pk_test');
      const webhookSec = crypto.randomBytes(32).toString('hex');

      await prisma.$transaction([
        prisma.kycSubmission.update({ where: { id: submission.id }, data: { status: 'approved', reviewedBy: req.user.id, approvedAt: new Date(), reviewNotes: req.body.notes || null } }),
        prisma.merchant.update({ where: { id: merchant.id }, data: { kycStatus: 'ACTIVE', kycTier: tier, isActive: true, webhookSecret: webhookSec, processingRate: 0.015 } }),
        prisma.apiKey.createMany({ data: [
          { merchantId: merchant.id, keyHash: hashApiKey(liveSecret), keyPrefix: 'sk_live', label: 'Live Secret Key',  isSandbox: false },
          { merchantId: merchant.id, keyHash: hashApiKey(testSecret), keyPrefix: 'sk_test', label: 'Test Secret Key',  isSandbox: true  },
          { merchantId: merchant.id, keyHash: hashApiKey(livePub),    keyPrefix: 'pk_live', label: 'Live Public Key',  isSandbox: false },
          { merchantId: merchant.id, keyHash: hashApiKey(testPub),    keyPrefix: 'pk_test', label: 'Test Public Key',  isSandbox: true  },
        ]}),
      ]);

      await logAudit(req.user.id, 'KYC_APPROVED', 'kyc_submission', submission.id, { status: 'submitted' }, { status: 'approved', tier }, req.body.notes);

      const _activEmail = await getEmailContent('kyc_approved',
        { merchant_name: merchant.businessName, tier, live_secret: liveSecret, test_secret: testSecret, live_pub: livePub, webhook_secret: webhookSec, dashboard_url: (process.env.APP_URL||'')+'/dashboard.html' },
        '🎉 Your Paylode account is now active!',
        activationEmail(merchant, { liveSecret, testSecret, livePub, testPub, webhookSec, tier }));
      await sendEmail({ to: merchant.user.email, subject: _activEmail.subject, html: _activEmail.html }).catch(() => {});

      ok(res, {
        merchant_id: merchant.id, business_name: merchant.businessName, kyc_tier: tier, is_active: true,
        credentials: { sk_live: liveSecret, sk_test: testSecret, pk_live: livePub, pk_test: testPub, webhook_secret: webhookSec },
        message: 'Merchant KYC approved and account activated.',
      });
    } catch (e) { next(e); }
  }
);

// ── POST /api/v1/kyc/:id/reject ──────────────────────────────────────────────
router.post('/:id/reject', requireAuth, requireAdminOrCompliance,
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
        prisma.kycSubmission.update({ where: { id: submission.id }, data: { status: 'rejected', reviewedBy: req.user.id, rejectionCode: req.body.rejection_code, reviewNotes: req.body.notes } }),
        prisma.merchant.update({ where: { id: submission.merchantId }, data: { kycStatus: 'KYC_REJECTED' } }),
      ]);

      await logAudit(req.user.id, 'KYC_REJECTED', 'kyc_submission', submission.id, { status: 'submitted' }, { status: 'rejected', code: req.body.rejection_code }, req.body.notes);

      const _rejEmail = await getEmailContent('kyc_rejected',
        { merchant_name: submission.merchant.businessName, rejection_code: req.body.rejection_code, review_notes: req.body.notes, resubmit_url: (process.env.APP_URL||'')+'/dashboard.html' },
        'Action required — Paylode KYC update',
        rejectionEmail(submission.merchant, req.body.rejection_code, req.body.notes));
      await sendEmail({ to: submission.merchant.user.email, subject: _rejEmail.subject, html: _rejEmail.html }).catch(() => {});

      ok(res, { message: 'KYC rejected. Merchant has been notified.' });
    } catch (e) { next(e); }
  }
);

// ── POST /api/v1/kyc/bulk-approve ────────────────────────────────────────────
router.post('/bulk-approve', requireAuth, requireAdminOrCompliance, async (req, res, next) => {
  try {
    const { ids, tier } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return fail(res, 'ids array required');
    const t = parseInt(tier);
    if (![1, 2, 3].includes(t)) return fail(res, 'tier must be 1, 2, or 3');
    const results = { approved: [], failed: [] };
    for (const id of ids) {
      try {
        const sub = await prisma.kycSubmission.findUnique({ where: { id }, include: { merchant: true } });
        if (!sub) { results.failed.push({ id, reason: 'not found' }); continue; }
        if (!['submitted', 'in_review'].includes(sub.status)) { results.failed.push({ id, reason: 'already processed' }); continue; }
        await prisma.$transaction([
          prisma.kycSubmission.update({ where: { id }, data: { status: 'approved', tierApplied: t, reviewedBy: req.user.id, approvedAt: new Date() } }),
          prisma.merchant.update({ where: { id: sub.merchantId }, data: { kycStatus: 'ACTIVE', kycTier: t, isActive: true } }),
        ]);
        await logAudit(req.user.id, 'KYC_BULK_APPROVED', 'kyc_submissions', id, { status: sub.status }, { status: 'approved', tier: t }, null, req.ip);
        results.approved.push(id);
      } catch (e) { results.failed.push({ id, reason: e.message }); }
    }
    ok(res, results, results.approved.length + ' approved, ' + results.failed.length + ' failed');
  } catch (e) { next(e); }
});

// ── Address check routes ──────────────────────────────────────────────────────
router.post('/:id/address-check/upload', requireAuth, requireAdminOrCompliance, addrUpload.single('report'), async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 'No file uploaded');
    const submission = await prisma.kycSubmission.findUnique({ where: { id: req.params.id } });
    if (!submission) return notFound(res, 'KYC submission');
    const reportUrl = process.env.APP_URL + '/uploads/kyc/addr-reports/' + req.file.filename;
    await prisma.kycSubmission.update({ where: { id: req.params.id }, data: { addrReportUrl: reportUrl } });
    await logAudit(req.user.id, 'ADDR_REPORT_UPLOADED', 'kyc_submission', req.params.id, {}, { report_url: reportUrl });
    ok(res, { report_url: reportUrl }, 'Address verification report uploaded');
  } catch (e) { next(e); }
});

router.put('/:id/address-check/approve', requireAuth, requireAdminOrCompliance, async (req, res, next) => {
  try {
    const submission = await prisma.kycSubmission.findUnique({ where: { id: req.params.id } });
    if (!submission) return notFound(res, 'KYC submission');
    await prisma.kycSubmission.update({ where: { id: req.params.id }, data: { addrCheckStatus: 'passed', addrCheckNotes: req.body.notes || null, addrCheckedBy: req.user.id, addrCheckedAt: new Date(), addrReportUrl: req.body.report_url || submission.addrReportUrl } });
    await logAudit(req.user.id, 'ADDR_CHECK_APPROVED', 'kyc_submission', req.params.id, { addr_check_status: 'pending' }, { addr_check_status: 'passed' }, req.body.notes);
    ok(res, { message: 'Address verification approved' });
  } catch (e) { next(e); }
});

router.put('/:id/address-check/reject', requireAuth, requireAdminOrCompliance, async (req, res, next) => {
  try {
    if (!req.body.notes) return fail(res, 'A rejection reason is required');
    const submission = await prisma.kycSubmission.findUnique({ where: { id: req.params.id } });
    if (!submission) return notFound(res, 'KYC submission');
    await prisma.kycSubmission.update({ where: { id: req.params.id }, data: { addrCheckStatus: 'failed', addrCheckNotes: req.body.notes, addrCheckedBy: req.user.id, addrCheckedAt: new Date() } });
    await logAudit(req.user.id, 'ADDR_CHECK_REJECTED', 'kyc_submission', req.params.id, { addr_check_status: 'pending' }, { addr_check_status: 'failed' }, req.body.notes);
    ok(res, { message: 'Address verification rejected.' });
  } catch (e) { next(e); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatSubmission(s) {
  return {
    id:           s.id,
    status:       s.status,
    tier_applied: s.tierApplied,
    merchant: {
      id: s.merchant.id, name: s.merchant.businessName, code: s.merchant.merchantCode,
      category: s.merchant.category, rc_number: s.merchant.rcNumber, state: s.merchant.state,
      email: s.merchant.businessEmail, aggregator: s.merchant.aggregator?.companyName || null,
    },
    submitted_at:      s.submittedAt,
    rejection_code:    s.rejectionCode,
    bvn_verified:      s.bvnVerified,
    nin_verified:      s.ninVerified,
    cac_verified:      s.cacVerified,
    pep_clear:         s.pepClear,
    aml_score:         s.amlScore,
    addr_check_status: s.addrCheckStatus || 'pending',
    addr_report_url:   s.addrReportUrl   || null,
    addr_check_notes:  s.addrCheckNotes  || null,
    addr_checked_at:   s.addrCheckedAt   || null,
    checks: {
      bvn: s.bvnCheckStatus || 'pending',
      nin: s.ninCheckStatus || 'pending',
      cac: s.cacCheckStatus || 'not_required',
    },
  };
}

const kycAlertEmail = (merchant, sub) => `<h2>New KYC Submission</h2><p><strong>Merchant:</strong> ${merchant.businessName}</p><p><strong>Tier Applied:</strong> ${sub.tierApplied}</p><p><strong>Submission ID:</strong> ${sub.id}</p><p>YouVerify checks are running automatically.</p>`;
const activationEmail = (merchant, creds) => `<h2>Your Paylode account is active!</h2><p>Hello ${merchant.businessName},</p><p>Your Tier ${creds.tier} KYC has been approved. You can now start accepting payments.</p><h3>Your API Credentials</h3><p><strong>Live Secret Key:</strong> ${creds.liveSecret}</p><p><strong>Test Secret Key:</strong> ${creds.testSecret}</p><p><strong>Webhook Secret:</strong> ${creds.webhookSec}</p>`;
const rejectionEmail = (merchant, code, notes) => `<h2>KYC Application Update</h2><p>Hello ${merchant.businessName},</p><p>Your KYC application requires attention. Reason: <strong>${code}</strong></p><p>${notes}</p>`;

module.exports = router;
