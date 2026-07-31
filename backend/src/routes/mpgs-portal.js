'use strict';
/**
 * MPGS / Parallex Bank Merchant Onboarding Portal
 *
 * Three sub-namespaces on /api/v1/mpgs-portal:
 *   /auth/*        — public: register, verify-email, login, forgot/reset password
 *   /portal/*      — requireMpgsAuth: merchant self-service
 *   /admin/*       — requireAuth + requireAdminOrCompliance: Paylode staff review
 *
 * Design:
 *   - One MpgsApplicant (portal account) can have MANY MpgsApplication rows,
 *     one per merchant they are onboarding (e.g. an aggregator submitting 5 merchants).
 *   - The applicant's dashboard lists all their submissions.
 *   - Admin can set parallexMerchantId, parallexOperatorId, and paylodeMerchantId
 *     on each approved application (the last one links the MPGS record into the
 *     gateway's merchant_mpgs_configs table).
 */
const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const { prisma }  = require('../utils/db');
const { ok, fail, created, notFound } = require('../utils/helpers');
const { requireAuth, requireAdminOrCompliance } = require('../middleware/auth');
const { sendEmail } = require('../services/emailService');
const { logger } = require('../utils/logger');

// ── Upload directory ───────────────────────────────────────────────────────
const UPLOAD_BASE = process.env.MPGS_UPLOAD_DIR
  || path.join(__dirname, '../../uploads/mpgs');

// ── Required documents list ────────────────────────────────────────────────
const MPGS_DOCS = [
  { key: 'cert_incorp',       label: 'Certificate of Incorporation / Business Name Registration' },
  { key: 'memart',            label: 'MEMART (Memorandum and Articles of Association)' },
  { key: 'cac_status',        label: 'CAC Status Report (Form CO2 + CO7)' },
  { key: 'board_resolution',  label: 'Board Resolution authorising MPGS onboarding' },
  { key: 'tin_cert',          label: 'Tax Identification Number (TIN) Certificate' },
  { key: 'directors_id',      label: "Directors' Valid IDs + BVN" },
  { key: 'proof_address',     label: 'Proof of Business Address (utility bill, ≤3 months)' },
  { key: 'bank_statement',    label: 'Bank Statement (3-6 months)' },
  { key: 'website_evidence',  label: 'Website Evidence / Screenshot' },
  { key: 'pcidss_cert',       label: 'PCIDSS Certificate (if certified — otherwise skip)' },
];
const MPGS_DOC_KEYS = new Set(MPGS_DOCS.map(d => d.key));

// ── Multer storage ─────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const appId = req.params.appId;
    const dir = path.join(UPLOAD_BASE, appId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `${req.params.docKey}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];
    if (!allowed.includes(path.extname(file.originalname).toLowerCase()))
      return cb(new Error('Only PDF, JPG, PNG, DOC and DOCX files are accepted'));
    cb(null, true);
  },
});

// ── MPGS JWT middleware ────────────────────────────────────────────────────
async function requireMpgsAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return fail(res, 'Authentication required', 'UNAUTHORIZED', 401);
  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.type !== 'mpgs_applicant')
      return fail(res, 'Invalid token type', 'UNAUTHORIZED', 401);

    const applicant = await prisma.mpgsApplicant.findUnique({
      where: { id: decoded.applicantId },
    });
    if (!applicant) return fail(res, 'Account not found', 'UNAUTHORIZED', 401);
    req.mpgsApplicant = applicant;
    next();
  } catch {
    return fail(res, 'Invalid or expired token', 'UNAUTHORIZED', 401);
  }
}

// Middleware: load and authorise a specific application for the logged-in applicant
async function requireOwnApp(req, res, next) {
  const app = await prisma.mpgsApplication.findFirst({
    where: { id: req.params.appId, applicantId: req.mpgsApplicant.id },
    include: { documents: true, comments: { where: { isInternal: false }, orderBy: { createdAt: 'asc' } } },
  });
  if (!app) return notFound(res, 'Application');
  req.mpgsApp = app;
  next();
}

function signMpgsToken(applicantId) {
  return jwt.sign(
    { applicantId, type: 'mpgs_applicant' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

const PORTAL_URL = () => process.env.MPGS_PORTAL_URL || 'https://mpgs.paylodeservices.com';

// ═══════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

router.post('/auth/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    if (!firstName || !lastName || !email || !password)
      return fail(res, 'First name, last name, email and password are required');
    if (password.length < 8)
      return fail(res, 'Password must be at least 8 characters');

    const exists = await prisma.mpgsApplicant.findUnique({ where: { email: email.toLowerCase() } });
    if (exists) return fail(res, 'An account with this email already exists');

    const passwordHash      = await bcrypt.hash(password, 12);
    const emailVerifyToken  = crypto.randomBytes(32).toString('hex');
    const emailVerifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const applicant = await prisma.mpgsApplicant.create({
      data: { email: email.toLowerCase(), passwordHash, firstName, lastName, emailVerifyToken, emailVerifyExpiry },
    });

    const verifyUrl = `${PORTAL_URL()}/mpgs-verify.html?token=${emailVerifyToken}`;
    await sendEmail({
      to: applicant.email,
      subject: 'Verify your email — Paylode MPGS Portal',
      html: `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0">
          <p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Onboarding Portal</p>
        </div>
        <div style="background:#f8fafc;padding:32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">
          <p style="font-size:15px;color:#1e293b">Hello ${firstName},</p>
          <p style="color:#475569">Click the button below to verify your email address and activate your MPGS onboarding account.</p>
          <a href="${verifyUrl}" style="display:inline-block;margin:20px 0;background:#7dc534;color:#1a2744;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none">Verify Email Address</a>
          <p style="font-size:12px;color:#94a3b8">This link expires in 24 hours. If you did not create an account, ignore this email.</p>
        </div>
      </div>`,
    }).catch(e => logger.error({ err: e }, 'MPGS verify email failed'));

    return created(res, { email: applicant.email }, 'Account created — please check your email to verify your address');
  } catch (e) {
    logger.error({ err: e }, 'MPGS register error');
    return fail(res, 'Registration failed. Please try again.', 'ERROR', 500);
  }
});

router.post('/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return fail(res, 'Verification token is required');
    const applicant = await prisma.mpgsApplicant.findFirst({ where: { emailVerifyToken: token } });
    if (!applicant) return fail(res, 'Invalid or expired verification link');
    if (applicant.emailVerifyExpiry < new Date()) return fail(res, 'Verification link has expired — please register again');
    await prisma.mpgsApplicant.update({
      where: { id: applicant.id },
      data: { isEmailVerified: true, emailVerifyToken: null, emailVerifyExpiry: null },
    });
    return ok(res, null, 'Email verified successfully — you can now log in');
  } catch (e) {
    logger.error({ err: e }, 'MPGS verify-email error');
    return fail(res, 'Verification failed', 'ERROR', 500);
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return fail(res, 'Email and password are required');
    const applicant = await prisma.mpgsApplicant.findUnique({ where: { email: email.toLowerCase() } });
    if (!applicant) return fail(res, 'Invalid email or password', 'INVALID_CREDENTIALS', 401);
    if (!applicant.isEmailVerified)
      return fail(res, 'Please verify your email address before logging in', 'EMAIL_NOT_VERIFIED', 403);
    const valid = await bcrypt.compare(password, applicant.passwordHash);
    if (!valid) return fail(res, 'Invalid email or password', 'INVALID_CREDENTIALS', 401);
    const token = signMpgsToken(applicant.id);
    return ok(res, {
      token,
      applicant: { id: applicant.id, firstName: applicant.firstName, lastName: applicant.lastName, email: applicant.email },
    }, 'Login successful');
  } catch (e) {
    logger.error({ err: e }, 'MPGS login error');
    return fail(res, 'Login failed', 'ERROR', 500);
  }
});

router.post('/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return fail(res, 'Email is required');
    const applicant = await prisma.mpgsApplicant.findUnique({ where: { email: email.toLowerCase() } });
    if (applicant) {
      const token = crypto.randomBytes(32).toString('hex');
      await prisma.mpgsApplicant.update({
        where: { id: applicant.id },
        data: { passwordResetToken: token, passwordResetExpiry: new Date(Date.now() + 60 * 60 * 1000) },
      });
      const resetUrl = `${PORTAL_URL()}/mpgs-reset.html?token=${token}`;
      await sendEmail({
        to: applicant.email,
        subject: 'Reset your password — Paylode MPGS Portal',
        html: `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0"><p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Portal</p></div>
          <div style="background:#f8fafc;padding:32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">
            <p style="color:#475569">Click below to reset your password. Expires in 1 hour.</p>
            <a href="${resetUrl}" style="display:inline-block;margin:20px 0;background:#7dc534;color:#1a2744;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none">Reset Password</a>
          </div>
        </div>`,
      }).catch(e => logger.error({ err: e }, 'MPGS reset email failed'));
    }
    return ok(res, null, 'If that email is registered you will receive a reset link shortly');
  } catch (e) {
    logger.error({ err: e }, 'MPGS forgot-password error');
    return fail(res, 'Request failed', 'ERROR', 500);
  }
});

router.post('/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return fail(res, 'Token and new password are required');
    if (password.length < 8) return fail(res, 'Password must be at least 8 characters');
    const applicant = await prisma.mpgsApplicant.findFirst({ where: { passwordResetToken: token } });
    if (!applicant) return fail(res, 'Invalid or expired reset link');
    if (applicant.passwordResetExpiry < new Date()) return fail(res, 'Reset link has expired');
    await prisma.mpgsApplicant.update({
      where: { id: applicant.id },
      data: { passwordHash: await bcrypt.hash(password, 12), passwordResetToken: null, passwordResetExpiry: null },
    });
    return ok(res, null, 'Password reset successfully — you can now log in');
  } catch (e) {
    logger.error({ err: e }, 'MPGS reset-password error');
    return fail(res, 'Password reset failed', 'ERROR', 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MERCHANT PORTAL ROUTES  (one applicant → many applications)
// ═══════════════════════════════════════════════════════════════════════════

// GET /portal/me — profile + list of all merchant submissions
router.get('/portal/me', requireMpgsAuth, async (req, res) => {
  try {
    const applications = await prisma.mpgsApplication.findMany({
      where: { applicantId: req.mpgsApplicant.id },
      include: {
        documents: { select: { docKey: true, status: true } },
        comments:  { where: { isInternal: false }, select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const { passwordHash, emailVerifyToken, emailVerifyExpiry, passwordResetToken, passwordResetExpiry, ...safe } = req.mpgsApplicant;
    return ok(res, { ...safe, applications, docsList: MPGS_DOCS });
  } catch (e) {
    logger.error({ err: e }, 'MPGS /portal/me error');
    return fail(res, 'Failed to load account', 'ERROR', 500);
  }
});

// POST /portal/applications — start a new merchant submission
router.post('/portal/applications', requireMpgsAuth, async (req, res) => {
  try {
    const { merchantName } = req.body;
    if (!merchantName) return fail(res, 'Merchant name is required');
    const app = await prisma.mpgsApplication.create({
      data: { applicantId: req.mpgsApplicant.id, merchantName },
    });
    return created(res, app, 'New merchant submission created');
  } catch (e) {
    logger.error({ err: e }, 'MPGS create application error');
    return fail(res, 'Failed to create submission', 'ERROR', 500);
  }
});

// GET /portal/applications/:appId
router.get('/portal/applications/:appId', requireMpgsAuth, requireOwnApp, (req, res) => {
  return ok(res, { application: req.mpgsApp, docsList: MPGS_DOCS });
});

// PUT /portal/applications/:appId/questionnaire
router.put('/portal/applications/:appId/questionnaire', requireMpgsAuth, requireOwnApp, async (req, res) => {
  try {
    const { data, submit } = req.body;
    if (!data) return fail(res, 'Form data is required');
    const updateData = submit ? { questionnaire: data, questDraft: null } : { questDraft: data };
    const app = await prisma.mpgsApplication.update({ where: { id: req.mpgsApp.id }, data: updateData });
    return ok(res, { status: app.status, saved: true, submitted: !!submit });
  } catch (e) {
    logger.error({ err: e }, 'MPGS save questionnaire error');
    return fail(res, 'Failed to save questionnaire', 'ERROR', 500);
  }
});

// PUT /portal/applications/:appId/application-form
router.put('/portal/applications/:appId/application-form', requireMpgsAuth, requireOwnApp, async (req, res) => {
  try {
    const { data, submit } = req.body;
    if (!data) return fail(res, 'Form data is required');
    const updateData = submit ? { applicationForm: data, formDraft: null } : { formDraft: data };
    const app = await prisma.mpgsApplication.update({ where: { id: req.mpgsApp.id }, data: updateData });
    return ok(res, { status: app.status, saved: true, submitted: !!submit });
  } catch (e) {
    logger.error({ err: e }, 'MPGS save application form error');
    return fail(res, 'Failed to save form', 'ERROR', 500);
  }
});

// POST /portal/applications/:appId/documents/:docKey
router.post('/portal/applications/:appId/documents/:docKey',
  requireMpgsAuth,
  requireOwnApp,
  (req, res, next) => {
    if (!MPGS_DOC_KEYS.has(req.params.docKey)) return fail(res, 'Unknown document type');
    next();
  },
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return fail(res, 'No file uploaded');
      const docMeta = MPGS_DOCS.find(d => d.key === req.params.docKey);
      const doc = await prisma.mpgsDocument.upsert({
        where: { applicationId_docKey: { applicationId: req.mpgsApp.id, docKey: req.params.docKey } },
        create: {
          applicationId: req.mpgsApp.id,
          docKey: req.params.docKey,
          docLabel: docMeta.label,
          filename: req.file.originalname,
          filepath: req.file.path,
          mimetype: req.file.mimetype,
          filesize: req.file.size,
          status: 'PENDING',
        },
        update: {
          filename: req.file.originalname,
          filepath: req.file.path,
          mimetype: req.file.mimetype,
          filesize: req.file.size,
          status: 'PENDING',
          uploadedAt: new Date(),
        },
      });
      return ok(res, doc, 'Document uploaded');
    } catch (e) {
      logger.error({ err: e }, 'MPGS doc upload error');
      return fail(res, 'Upload failed', 'ERROR', 500);
    }
  }
);

// DELETE /portal/applications/:appId/documents/:docKey
router.delete('/portal/applications/:appId/documents/:docKey', requireMpgsAuth, requireOwnApp, async (req, res) => {
  try {
    const doc = await prisma.mpgsDocument.findUnique({
      where: { applicationId_docKey: { applicationId: req.mpgsApp.id, docKey: req.params.docKey } },
    });
    if (!doc) return notFound(res, 'Document');
    if (fs.existsSync(doc.filepath)) fs.unlinkSync(doc.filepath);
    await prisma.mpgsDocument.delete({ where: { id: doc.id } });
    return ok(res, null, 'Document removed');
  } catch (e) {
    logger.error({ err: e }, 'MPGS doc delete error');
    return fail(res, 'Delete failed', 'ERROR', 500);
  }
});

// PUT /portal/applications/:appId/website-details — domain, hosting, VPS info
router.put('/portal/applications/:appId/website-details', requireMpgsAuth, requireOwnApp, async (req, res) => {
  try {
    const { domainName, domainHost, domainCredentials, vpsProvider, vpsIp, vpsCredentials, websiteNotes } = req.body;
    const data = {};
    if (domainName        !== undefined) data.domainName        = domainName        || null;
    if (domainHost        !== undefined) data.domainHost        = domainHost        || null;
    if (domainCredentials !== undefined) data.domainCredentials = domainCredentials || null;
    if (vpsProvider       !== undefined) data.vpsProvider       = vpsProvider       || null;
    if (vpsIp             !== undefined) data.vpsIp             = vpsIp             || null;
    if (vpsCredentials    !== undefined) data.vpsCredentials    = vpsCredentials    || null;
    if (websiteNotes      !== undefined) data.websiteNotes      = websiteNotes      || null;
    await prisma.mpgsApplication.update({ where: { id: req.mpgsApp.id }, data });
    return ok(res, data, 'Website & hosting details saved');
  } catch (e) {
    logger.error({ err: e }, 'MPGS website-details error');
    return fail(res, 'Save failed', 'ERROR', 500);
  }
});

// PATCH /portal/profile — update applicant's own profile (name, company)
router.patch('/portal/profile', requireMpgsAuth, async (req, res) => {
  try {
    const { firstName, lastName, companyName } = req.body;
    const data = {};
    if (firstName   !== undefined) data.firstName   = firstName   || undefined;
    if (lastName    !== undefined) data.lastName    = lastName    || undefined;
    if (companyName !== undefined) data.companyName = companyName || null;
    if (!Object.keys(data).length) return fail(res, 'No fields provided');
    const updated = await prisma.mpgsApplicant.update({ where: { id: req.mpgsApplicant.id }, data });
    const { passwordHash, emailVerifyToken, emailVerifyExpiry, passwordResetToken, passwordResetExpiry, ...safe } = updated;
    return ok(res, safe, 'Profile updated');
  } catch (e) {
    logger.error({ err: e }, 'MPGS profile update error');
    return fail(res, 'Update failed', 'ERROR', 500);
  }
});

// POST /portal/applications/:appId/submit
router.post('/portal/applications/:appId/submit', requireMpgsAuth, requireOwnApp, async (req, res) => {
  try {
    const app = req.mpgsApp;
    if (!app.questionnaire) return fail(res, 'Please complete and save the questionnaire first');
    if (!app.applicationForm) return fail(res, 'Please complete and save the application form first');

    const requiredDocs = MPGS_DOCS.filter(d => d.key !== 'pcidss_cert');
    const uploadedKeys = new Set(app.documents.map(d => d.docKey));
    const missing = requiredDocs.filter(d => !uploadedKeys.has(d.key));
    if (missing.length) return fail(res, `Missing required documents: ${missing.map(d => d.label).join(', ')}`);
    if (['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SENT_TO_BANK'].includes(app.status))
      return fail(res, 'This application has already been submitted');

    await prisma.mpgsApplication.update({
      where: { id: app.id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });

    await sendEmail({
      to: req.mpgsApplicant.email,
      subject: `Application submitted — ${app.merchantName} — Paylode MPGS Portal`,
      html: `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0">
          <p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Portal</p>
        </div>
        <div style="background:#f8fafc;padding:32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">
          <p style="color:#1e293b">Hello ${req.mpgsApplicant.firstName},</p>
          <p style="color:#475569">Your MPGS onboarding application for <strong>${app.merchantName}</strong> has been submitted. Our team will review it and get back to you within 3–5 business days.</p>
        </div>
      </div>`,
    }).catch(e => logger.error({ err: e }, 'MPGS submit email failed'));

    const adminEmail = process.env.MPGS_ADMIN_NOTIFY_EMAIL || process.env.EMAIL_FROM;
    if (adminEmail) {
      await sendEmail({
        to: adminEmail,
        subject: `[MPGS Portal] New submission — ${app.merchantName}`,
        html: `<p>New MPGS application submitted: <strong>${app.merchantName}</strong> by ${req.mpgsApplicant.firstName} ${req.mpgsApplicant.lastName} (${req.mpgsApplicant.email}).</p>
          <p><a href="${PORTAL_URL()}/mpgs-admin.html">Review in Admin Portal</a></p>`,
      }).catch(() => {});
    }

    return ok(res, { status: 'SUBMITTED' }, 'Application submitted successfully');
  } catch (e) {
    logger.error({ err: e }, 'MPGS submit error');
    return fail(res, 'Submission failed', 'ERROR', 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/admin/applications', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { merchantName: { contains: search, mode: 'insensitive' } },
        { applicant: { email: { contains: search, mode: 'insensitive' } } },
        { applicant: { firstName: { contains: search, mode: 'insensitive' } } },
        { applicant: { lastName: { contains: search, mode: 'insensitive' } } },
      ];
    }
    const [apps, total] = await Promise.all([
      prisma.mpgsApplication.findMany({
        where,
        include: {
          applicant: { select: { id: true, email: true, firstName: true, lastName: true, companyName: true, createdAt: true } },
          documents: { select: { id: true, docKey: true, status: true } },
          comments:  { select: { id: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.mpgsApplication.count({ where }),
    ]);
    return ok(res, { apps, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    logger.error({ err: e }, 'MPGS admin list error');
    return fail(res, 'Failed to fetch applications', 'ERROR', 500);
  }
});

router.get('/admin/applications/:id', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const app = await prisma.mpgsApplication.findUnique({
      where: { id: req.params.id },
      include: {
        applicant: { select: { id: true, email: true, firstName: true, lastName: true, companyName: true, createdAt: true } },
        documents: { orderBy: { uploadedAt: 'asc' } },
        comments:  { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!app) return notFound(res, 'Application');
    // If there's a paylodeMerchantId, fetch some gateway merchant info too
    let paylodeMerchant = null;
    if (app.paylodeMerchantId) {
      paylodeMerchant = await prisma.merchant.findUnique({
        where: { id: app.paylodeMerchantId },
        select: { id: true, businessName: true, merchantCode: true, kycStatus: true, isActive: true },
      }).catch(() => null);
    }
    return ok(res, { app, paylodeMerchant, docsList: MPGS_DOCS });
  } catch (e) {
    logger.error({ err: e }, 'MPGS admin get error');
    return fail(res, 'Failed to fetch application', 'ERROR', 500);
  }
});

router.put('/admin/applications/:id/status', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { status, note } = req.body;
    const valid = ['UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED'];
    if (!valid.includes(status)) return fail(res, `Status must be one of: ${valid.join(', ')}`);
    const app = await prisma.mpgsApplication.findUnique({ where: { id: req.params.id }, include: { applicant: true } });
    if (!app) return notFound(res, 'Application');
    await prisma.mpgsApplication.update({ where: { id: req.params.id }, data: { status } });
    if (status === 'ACTION_REQUIRED' && note) {
      await sendEmail({
        to: app.applicant.email,
        subject: `Action required — ${app.merchantName} — Paylode MPGS Portal`,
        html: `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0"><p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Portal</p></div>
          <div style="background:#fff8ed;padding:32px;border:1px solid #fcd34d;border-top:none;border-radius:0 0 10px 10px">
            <p style="color:#1e293b">Hello ${app.applicant.firstName},</p>
            <p style="color:#475569">Your MPGS application for <strong>${app.merchantName}</strong> requires action:</p>
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0"><p style="color:#334155;white-space:pre-wrap;margin:0">${note}</p></div>
            <a href="${PORTAL_URL()}/mpgs-dashboard.html" style="display:inline-block;background:#7dc534;color:#1a2744;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none">Go to Portal</a>
          </div>
        </div>`,
      }).catch(e => logger.error({ err: e }, 'MPGS action-required email failed'));
    }
    return ok(res, { status }, 'Status updated');
  } catch (e) {
    logger.error({ err: e }, 'MPGS admin status error');
    return fail(res, 'Update failed', 'ERROR', 500);
  }
});

// PUT /admin/applications/:id/ids — set Parallex Merchant ID, Operator ID, Paylode merchant link
router.put('/admin/applications/:id/ids', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { parallexMerchantId, parallexOperatorId, paylodeMerchantId } = req.body;
    const updateData = {};
    if (parallexMerchantId !== undefined) updateData.parallexMerchantId = parallexMerchantId || null;
    if (parallexOperatorId !== undefined) updateData.parallexOperatorId = parallexOperatorId || null;
    if (paylodeMerchantId  !== undefined) updateData.paylodeMerchantId  = paylodeMerchantId  || null;
    if (!Object.keys(updateData).length) return fail(res, 'No fields provided');

    await prisma.mpgsApplication.update({ where: { id: req.params.id }, data: updateData });

    // If paylodeMerchantId was set, push the Parallex merchant ID into merchant_mpgs_configs
    if (paylodeMerchantId && parallexMerchantId) {
      await prisma.merchantMpgsConfig.upsert({
        where: { merchantId: paylodeMerchantId },
        create: { merchantId: paylodeMerchantId, mpgsMid: parallexMerchantId },
        update: { mpgsMid: parallexMerchantId },
      }).catch(e => logger.warn({ err: e }, 'MPGS config upsert skipped (table may not exist yet)'));
    }

    return ok(res, updateData, 'IDs updated');
  } catch (e) {
    logger.error({ err: e }, 'MPGS admin ids error');
    return fail(res, 'Update failed', 'ERROR', 500);
  }
});

router.post('/admin/applications/:id/comments', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { content, isInternal } = req.body;
    if (!content) return fail(res, 'Comment content is required');
    const app = await prisma.mpgsApplication.findUnique({ where: { id: req.params.id }, include: { applicant: true } });
    if (!app) return notFound(res, 'Application');
    const authorName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;
    let sentByEmail = false;
    if (!isInternal) {
      await sendEmail({
        to: app.applicant.email,
        subject: `New feedback on your MPGS application — ${app.merchantName}`,
        html: `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0"><p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Portal</p></div>
          <div style="background:#f8fafc;padding:32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">
            <p style="color:#1e293b">Hello ${app.applicant.firstName},</p>
            <p style="color:#475569">New feedback on <strong>${app.merchantName}</strong>:</p>
            <div style="background:#fff;border-left:4px solid #1a2744;padding:16px 20px;margin:16px 0;border-radius:0 8px 8px 0"><p style="color:#334155;white-space:pre-wrap;margin:0">${content}</p></div>
            <a href="${PORTAL_URL()}/mpgs-dashboard.html" style="display:inline-block;background:#7dc534;color:#1a2744;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none">View in Portal</a>
          </div>
        </div>`,
      }).then(() => { sentByEmail = true; }).catch(e => logger.error({ err: e }, 'MPGS comment email failed'));
    }
    const comment = await prisma.mpgsComment.create({
      data: { applicationId: req.params.id, authorName, content, isInternal: !!isInternal, sentByEmail },
    });
    return created(res, comment, 'Comment added');
  } catch (e) {
    logger.error({ err: e }, 'MPGS admin comment error');
    return fail(res, 'Failed to add comment', 'ERROR', 500);
  }
});

router.put('/admin/applications/:id/documents/:docKey/status', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['ACCEPTED', 'REJECTED', 'REUPLOAD_REQUESTED'];
    if (!valid.includes(status)) return fail(res, `Status must be one of: ${valid.join(', ')}`);
    const app = await prisma.mpgsApplication.findUnique({ where: { id: req.params.id }, include: { applicant: true } });
    if (!app) return notFound(res, 'Application');
    const doc = await prisma.mpgsDocument.findUnique({
      where: { applicationId_docKey: { applicationId: req.params.id, docKey: req.params.docKey } },
    });
    if (!doc) return notFound(res, 'Document');
    await prisma.mpgsDocument.update({ where: { id: doc.id }, data: { status } });
    if (status === 'REUPLOAD_REQUESTED') {
      await sendEmail({
        to: app.applicant.email,
        subject: `Document re-upload needed — ${doc.docLabel}`,
        html: `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0"><p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Portal</p></div>
          <div style="background:#fff8ed;padding:32px;border:1px solid #fcd34d;border-top:none;border-radius:0 0 10px 10px">
            <p style="color:#1e293b">Hello ${app.applicant.firstName},</p>
            <p style="color:#475569">Please re-upload: <strong>${doc.docLabel}</strong> for <strong>${app.merchantName}</strong>.</p>
            <a href="${PORTAL_URL()}/mpgs-documents.html?app=${req.params.id}" style="display:inline-block;background:#7dc534;color:#1a2744;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none">Go to Documents</a>
          </div>
        </div>`,
      }).catch(e => logger.error({ err: e }, 'MPGS reupload email failed'));
    }
    return ok(res, { status }, 'Document status updated');
  } catch (e) {
    logger.error({ err: e }, 'MPGS admin doc status error');
    return fail(res, 'Update failed', 'ERROR', 500);
  }
});

router.get('/admin/applications/:id/documents/:docKey/download', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const doc = await prisma.mpgsDocument.findUnique({
      where: { applicationId_docKey: { applicationId: req.params.id, docKey: req.params.docKey } },
    });
    if (!doc) return notFound(res, 'Document');
    if (!fs.existsSync(doc.filepath)) return fail(res, 'File not found on server', 'NOT_FOUND', 404);
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.setHeader('Content-Type', doc.mimetype);
    fs.createReadStream(doc.filepath).pipe(res);
  } catch (e) {
    logger.error({ err: e }, 'MPGS doc download error');
    return fail(res, 'Download failed', 'ERROR', 500);
  }
});

router.post('/admin/applications/:id/send-to-bank', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { docKeys, includeQuestionnaire, includeApplicationForm, recipientEmail, note } = req.body;
    const bankEmail = recipientEmail || process.env.PARALLEX_BANK_EMAIL;
    if (!bankEmail) return fail(res, 'Recipient email is required (set PARALLEX_BANK_EMAIL env var or pass recipientEmail)');
    const app = await prisma.mpgsApplication.findUnique({
      where: { id: req.params.id },
      include: { applicant: { select: { firstName: true, lastName: true, email: true, companyName: true } }, documents: true },
    });
    if (!app) return notFound(res, 'Application');
    const attachments = [];
    if (docKeys && docKeys.length) {
      for (const key of docKeys) {
        const doc = app.documents.find(d => d.docKey === key);
        if (doc && fs.existsSync(doc.filepath)) {
          attachments.push({ filename: `${doc.docKey}_${doc.filename}`, path: doc.filepath });
        }
      }
    }
    let formHtml = '';
    if (includeQuestionnaire && app.questionnaire)    formHtml += buildQuestionnaireHtml(app.questionnaire);
    if (includeApplicationForm && app.applicationForm) formHtml += buildApplicationFormHtml(app.applicationForm);
    await sendEmail({
      to: bankEmail,
      subject: `MPGS Onboarding Application — ${app.merchantName}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
        <div style="background:#1a2744;padding:20px 28px;border-radius:8px 8px 0 0">
          <p style="color:#fff;font-size:16px;font-weight:bold;margin:0">Parallex Bank MPGS Onboarding — Submitted via Paylode Services</p>
        </div>
        <div style="background:#f8fafc;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
          <p><strong>Merchant:</strong> ${app.merchantName}</p>
          <p><strong>Submitted by:</strong> ${app.applicant.firstName} ${app.applicant.lastName} (${app.applicant.email})</p>
          <p><strong>Paylode staff:</strong> ${req.user.email}</p>
          ${app.parallexMerchantId ? `<p><strong>Parallex Merchant ID:</strong> ${app.parallexMerchantId}</p>` : ''}
          ${app.parallexOperatorId ? `<p><strong>Parallex Operator ID:</strong> ${app.parallexOperatorId}</p>` : ''}
          ${note ? `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;margin:12px 0"><p style="margin:0;color:#334155">${note}</p></div>` : ''}
          <p><strong>Attachments:</strong> ${attachments.length ? attachments.map(a => a.filename).join(', ') : 'None'}</p>
          ${formHtml}
        </div>
      </div>`,
      attachments,
    });
    await prisma.mpgsApplication.update({
      where: { id: req.params.id },
      data: { sentToBankAt: new Date(), sentToBankBy: req.user.email, status: 'SENT_TO_BANK' },
    });
    return ok(res, { sentTo: bankEmail, attachments: attachments.length }, `Application sent to ${bankEmail}`);
  } catch (e) {
    logger.error({ err: e }, 'MPGS send-to-bank error');
    return fail(res, 'Failed to send application', 'ERROR', 500);
  }
});

// ── Email HTML builders ────────────────────────────────────────────────────

function buildQuestionnaireHtml(q) {
  const row = (n, label, val) => `<tr><td style="padding:7px 10px;border:1px solid #e2e8f0;color:#64748b;width:30px">${n}</td><td style="padding:7px 10px;border:1px solid #e2e8f0;width:220px">${label}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${Array.isArray(val) ? val.join(', ') : (val || '—')}</td></tr>`;
  const table = (title, rows) => `<h3 style="font-size:14px;color:#334155;margin:16px 0 4px">${title}</h3><table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px"><tbody>${rows.join('')}</tbody></table>`;
  return `<hr style="margin:24px 0;border:none;border-top:2px solid #e2e8f0">
    <h2 style="color:#1a2744;font-size:16px">WEB BUSINESS — QUESTIONNAIRE</h2>
    ${table('A. GENERAL INFORMATION',[
      row(1,'Company Name',q.companyName),row(2,'Company Address',q.companyAddress),
      row(3,'Length of stay',q.lengthOfStay),row(4,'Country',q.country),
      row(5,'Directors',q.directors),row(6,'RC Number',q.rcNumber),
      row(7,'BVN',q.bvn),row(8,'TIN',q.tin),row(9,'Years of operation',q.yearsOfOperation),
      row(10,'Outlets',q.outlets),row(11,'Website',q.website),
      row(12,'Customer Service Contact',q.customerServiceContact),
      row('13a','Type of Goods/Services',q.typeOfGoods),row('13b','MCC',q.mcc),
      row(15,'Previous Payment Engines',q.prevPaymentEngines),
      row(16,'Reason for leaving',q.reasonForLeaving),row(17,'Store/Warehouse Address',q.storeAddress),
    ])}
    ${table('B. PAYMENT INFORMATION',[
      row(1,'Card Brands',q.cardBrands),row(2,'Card Currencies',q.cardCurrencies),
      row(3,'Card Types',q.cardTypes),row(4,'Order Processing Time',q.orderProcessingTime),
      row(5,'Payment Model',q.paymentModel),row(6,'Transaction Model',q.transactionModel),
      row(7,'Annual Volume',q.annualVolume),row(7,'Annual Value',q.annualValue),
    ])}
    ${table('C. SECURITY INFORMATION',[
      row(1,'PCIDSS Status',q.pcidssStatus),row(2,'Advance Functionality',q.advanceFunctionality),
      row(3,'3D Secure',q.threeDSecure),row(4,'Unique Reference',q.uniqueRef),
    ])}
    ${table('D. SALES INFORMATION',[
      row(1,'Daily Sales',q.salesDaily),row(1,'Weekly Sales',q.salesWeekly),
      row(1,'Monthly Sales',q.salesMonthly),row(1,'Annual Sales',q.salesAnnual),
      row(2,'Highest Value',q.highestValue),row(3,'Lowest Value',q.lowestValue),
      row(4,'Goods/Services List',q.goodsList),
    ])}`;
}

function buildApplicationFormHtml(f) {
  const r = (l, v) => `<tr><td style="padding:7px 10px;border:1px solid #e2e8f0;width:200px;background:#f8fafc;font-weight:600;font-size:13px">${l}</td><td style="padding:7px 10px;border:1px solid #e2e8f0;font-size:13px">${v || '—'}</td></tr>`;
  return `<hr style="margin:24px 0;border:none;border-top:2px solid #e2e8f0">
    <p style="font-weight:bold;color:#1c2b6e;font-size:15px;text-align:center">PARALLEX BANK MERCHANT APPLICATION FORM</p>
    <h3 style="font-size:13px;color:#fff;background:#1c2b6e;padding:8px 12px;margin-top:12px">SECTION 1: GENERAL INFORMATION</h3>
    <table style="width:100%;border-collapse:collapse">${[r('Company Name',f.s1CompanyName),r('Company Address',f.s1CompanyAddress),r('Ownership Type',f.s1OwnershipType),r('RC Number',f.s1RcNumber),r('Trading Name',f.s1TradingName),r('Date Registered',f.s1DateRegistered),r('TIN',f.s1Tin)].join('')}</table>
    <h3 style="font-size:13px;color:#fff;background:#1c2b6e;padding:8px 12px;margin-top:12px">SECTION 2: CONTACT INFORMATION</h3>
    <table style="width:100%;border-collapse:collapse">${[r('Primary Name',f.s2PrimaryName),r('Primary Designation',f.s2PrimaryDesignation),r('Primary Tel',f.s2PrimaryOfficeTel),r('Primary Mobile',f.s2PrimaryMobile),r('Primary Email',f.s2PrimaryEmail),r('Secondary Name',f.s2SecondaryName),r('Secondary Designation',f.s2SecondaryDesignation),r('Secondary Email',f.s2SecondaryEmail)].join('')}</table>
    <h3 style="font-size:13px;color:#fff;background:#1c2b6e;padding:8px 12px;margin-top:12px">SECTION 3: WEBSITE</h3>
    <table style="width:100%;border-collapse:collapse">${[r('Products/MCC',f.s3ProductsMcc),r('Website Name',f.s3WebsiteName),r('Website URL',f.s3WebsiteUrl)].join('')}</table>
    <h3 style="font-size:13px;color:#fff;background:#1c2b6e;padding:8px 12px;margin-top:12px">SECTION 4: BANK DETAILS</h3>
    <table style="width:100%;border-collapse:collapse">${[r('Account Number',f.s4AccountNumber),r('Account Name',f.s4AccountName),r('Account Type',f.s4AccountType),r('Settlement Account',f.s4SettlementAccount),r('Collateral Account',f.s4CollateralAccount),r('Branch',f.s4Branch)].join('')}</table>
    <h3 style="font-size:13px;color:#fff;background:#1c2b6e;padding:8px 12px;margin-top:12px">SECTION 5: OTHER DETAILS & DECLARATION</h3>
    <p style="font-size:13px;padding:8px 10px;border:1px solid #e2e8f0">${f.s5OtherDetails || '—'}</p>
    <p style="font-size:13px;color:#475569">Signed by: ${f.s5IndividualName || '—'} on behalf of ${f.s5CompanyName || '—'} | Designation: ${f.s5Designation || '—'} | Date: ${f.s5Date || '—'}</p>
    <h3 style="font-size:13px;color:#fff;background:#1c2b6e;padding:8px 12px;margin-top:12px">SECTION 6: MERCHANT INFORMATION</h3>
    <p style="font-size:13px;padding:8px 10px;border:1px solid #e2e8f0"><strong>Onboarding Type:</strong> ${f.s6OnboardingType || '—'}</p>`;
}

module.exports = router;
