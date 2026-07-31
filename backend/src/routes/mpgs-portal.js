'use strict';
/**
 * MPGS / Parallex Bank Merchant Onboarding Portal
 *
 * Three sub-namespaces on /api/v1/mpgs-portal:
 *   /auth/*        — public: register, verify-email, login, forgot/reset password
 *   /portal/*      — requireMpgsAuth: merchant actions
 *   /admin/*       — requireAuth + requireAdminOrCompliance: Paylode staff review
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
    const dir = path.join(UPLOAD_BASE, req.mpgsApplicant.application.id);
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
      include: {
        application: {
          include: {
            documents: true,
            comments: { where: { isInternal: false }, orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
    if (!applicant) return fail(res, 'Account not found', 'UNAUTHORIZED', 401);
    req.mpgsApplicant = applicant;
    next();
  } catch {
    return fail(res, 'Invalid or expired token', 'UNAUTHORIZED', 401);
  }
}

function signMpgsToken(applicantId) {
  return jwt.sign(
    { applicantId, type: 'mpgs_applicant' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// POST /register
router.post('/auth/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    if (!firstName || !lastName || !email || !password)
      return fail(res, 'First name, last name, email and password are required');
    if (password.length < 8)
      return fail(res, 'Password must be at least 8 characters');

    const exists = await prisma.mpgsApplicant.findUnique({ where: { email: email.toLowerCase() } });
    if (exists) return fail(res, 'An account with this email already exists');

    const passwordHash = await bcrypt.hash(password, 12);
    const emailVerifyToken = crypto.randomBytes(32).toString('hex');
    const emailVerifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const applicant = await prisma.mpgsApplicant.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        firstName,
        lastName,
        emailVerifyToken,
        emailVerifyExpiry,
        application: { create: {} },
      },
    });

    const verifyUrl = `${process.env.MPGS_PORTAL_URL || 'https://mpgs.paylodeservices.com'}/mpgs-verify.html?token=${emailVerifyToken}`;
    await sendEmail({
      to: applicant.email,
      subject: 'Verify your email — Paylode MPGS Portal',
      html: `
        <div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
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
    }).catch(e => logger.error({ err: e }, 'MPGS verify email send failed'));

    return created(res, { email: applicant.email }, 'Account created — please check your email to verify your address');
  } catch (e) {
    logger.error({ err: e }, 'MPGS register error');
    return fail(res, 'Registration failed. Please try again.', 'ERROR', 500);
  }
});

// POST /auth/verify-email
router.post('/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return fail(res, 'Verification token is required');

    const applicant = await prisma.mpgsApplicant.findFirst({
      where: { emailVerifyToken: token },
    });
    if (!applicant) return fail(res, 'Invalid or expired verification link');
    if (applicant.emailVerifyExpiry < new Date())
      return fail(res, 'Verification link has expired — please register again');

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

// POST /auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return fail(res, 'Email and password are required');

    const applicant = await prisma.mpgsApplicant.findUnique({
      where: { email: email.toLowerCase() },
      include: { application: true },
    });
    if (!applicant) return fail(res, 'Invalid email or password', 'INVALID_CREDENTIALS', 401);
    if (!applicant.isEmailVerified)
      return fail(res, 'Please verify your email address before logging in', 'EMAIL_NOT_VERIFIED', 403);

    const ok_ = await bcrypt.compare(password, applicant.passwordHash);
    if (!ok_) return fail(res, 'Invalid email or password', 'INVALID_CREDENTIALS', 401);

    const token = signMpgsToken(applicant.id);
    return ok(res, {
      token,
      applicant: {
        id: applicant.id,
        firstName: applicant.firstName,
        lastName: applicant.lastName,
        email: applicant.email,
        applicationStatus: applicant.application?.status || 'DRAFT',
      },
    }, 'Login successful');
  } catch (e) {
    logger.error({ err: e }, 'MPGS login error');
    return fail(res, 'Login failed', 'ERROR', 500);
  }
});

// POST /auth/forgot-password
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
      const resetUrl = `${process.env.MPGS_PORTAL_URL || 'https://mpgs.paylodeservices.com'}/mpgs-reset.html?token=${token}`;
      await sendEmail({
        to: applicant.email,
        subject: 'Reset your password — Paylode MPGS Portal',
        html: `
          <div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
            <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0">
              <p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Portal</p>
            </div>
            <div style="background:#f8fafc;padding:32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">
              <p style="color:#475569">Click the button below to reset your password. This link expires in 1 hour.</p>
              <a href="${resetUrl}" style="display:inline-block;margin:20px 0;background:#7dc534;color:#1a2744;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none">Reset Password</a>
              <p style="font-size:12px;color:#94a3b8">If you did not request a password reset, ignore this email.</p>
            </div>
          </div>`,
      }).catch(e => logger.error({ err: e }, 'MPGS reset email send failed'));
    }
    return ok(res, null, 'If that email is registered you will receive a reset link shortly');
  } catch (e) {
    logger.error({ err: e }, 'MPGS forgot-password error');
    return fail(res, 'Request failed', 'ERROR', 500);
  }
});

// POST /auth/reset-password
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
      data: {
        passwordHash: await bcrypt.hash(password, 12),
        passwordResetToken: null,
        passwordResetExpiry: null,
      },
    });
    return ok(res, null, 'Password reset successfully — you can now log in');
  } catch (e) {
    logger.error({ err: e }, 'MPGS reset-password error');
    return fail(res, 'Password reset failed', 'ERROR', 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MERCHANT PORTAL ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// GET /portal/me
router.get('/portal/me', requireMpgsAuth, (req, res) => {
  const { passwordHash, emailVerifyToken, emailVerifyExpiry, passwordResetToken, passwordResetExpiry, ...safe } = req.mpgsApplicant;
  return ok(res, { ...safe, docsList: MPGS_DOCS });
});

// PUT /portal/questionnaire
router.put('/portal/questionnaire', requireMpgsAuth, async (req, res) => {
  try {
    const { data, submit } = req.body;
    if (!data) return fail(res, 'Form data is required');

    const appId = req.mpgsApplicant.application.id;
    const updateData = submit
      ? { questionnaire: data, questDraft: null }
      : { questDraft: data };

    const app = await prisma.mpgsApplication.update({
      where: { id: appId },
      data: updateData,
    });
    return ok(res, { status: app.status, saved: true, submitted: !!submit });
  } catch (e) {
    logger.error({ err: e }, 'MPGS save questionnaire error');
    return fail(res, 'Failed to save questionnaire', 'ERROR', 500);
  }
});

// PUT /portal/application-form
router.put('/portal/application-form', requireMpgsAuth, async (req, res) => {
  try {
    const { data, submit } = req.body;
    if (!data) return fail(res, 'Form data is required');

    const appId = req.mpgsApplicant.application.id;
    const updateData = submit
      ? { applicationForm: data, formDraft: null }
      : { formDraft: data };

    const app = await prisma.mpgsApplication.update({
      where: { id: appId },
      data: updateData,
    });
    return ok(res, { status: app.status, saved: true, submitted: !!submit });
  } catch (e) {
    logger.error({ err: e }, 'MPGS save application form error');
    return fail(res, 'Failed to save application form', 'ERROR', 500);
  }
});

// POST /portal/documents/:docKey
router.post('/portal/documents/:docKey', requireMpgsAuth, (req, res, next) => {
  if (!MPGS_DOC_KEYS.has(req.params.docKey))
    return fail(res, 'Unknown document type');
  next();
}, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return fail(res, 'No file uploaded');

    const docMeta = MPGS_DOCS.find(d => d.key === req.params.docKey);
    const appId   = req.mpgsApplicant.application.id;

    const doc = await prisma.mpgsDocument.upsert({
      where: { applicationId_docKey: { applicationId: appId, docKey: req.params.docKey } },
      create: {
        applicationId: appId,
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
    return ok(res, doc, 'Document uploaded successfully');
  } catch (e) {
    logger.error({ err: e }, 'MPGS document upload error');
    return fail(res, 'Upload failed', 'ERROR', 500);
  }
});

// DELETE /portal/documents/:docKey
router.delete('/portal/documents/:docKey', requireMpgsAuth, async (req, res) => {
  try {
    const appId = req.mpgsApplicant.application.id;
    const doc   = await prisma.mpgsDocument.findUnique({
      where: { applicationId_docKey: { applicationId: appId, docKey: req.params.docKey } },
    });
    if (!doc) return notFound(res, 'Document');
    if (fs.existsSync(doc.filepath)) fs.unlinkSync(doc.filepath);
    await prisma.mpgsDocument.delete({ where: { id: doc.id } });
    return ok(res, null, 'Document removed');
  } catch (e) {
    logger.error({ err: e }, 'MPGS document delete error');
    return fail(res, 'Delete failed', 'ERROR', 500);
  }
});

// POST /portal/submit
router.post('/portal/submit', requireMpgsAuth, async (req, res) => {
  try {
    const app = req.mpgsApplicant.application;
    if (!app.questionnaire) return fail(res, 'Please complete and save the questionnaire first');
    if (!app.applicationForm) return fail(res, 'Please complete and save the application form first');

    const requiredDocs = MPGS_DOCS.filter(d => d.key !== 'pcidss_cert');
    const uploadedKeys = new Set(app.documents.map(d => d.docKey));
    const missing = requiredDocs.filter(d => !uploadedKeys.has(d.key));
    if (missing.length) {
      return fail(res, `Missing required documents: ${missing.map(d => d.label).join(', ')}`);
    }

    if (['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SENT_TO_BANK'].includes(app.status))
      return fail(res, 'Application has already been submitted');

    const updated = await prisma.mpgsApplication.update({
      where: { id: app.id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });

    // Notify applicant
    await sendEmail({
      to: req.mpgsApplicant.email,
      subject: 'Application submitted — Paylode MPGS Portal',
      html: `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0">
          <p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Onboarding Portal</p>
        </div>
        <div style="background:#f8fafc;padding:32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">
          <p style="color:#1e293b;font-size:15px">Hello ${req.mpgsApplicant.firstName},</p>
          <p style="color:#475569">Your MPGS onboarding application has been successfully submitted. Our team will review it and get back to you within 3–5 business days.</p>
          <p style="color:#475569">You can log back in at any time to check your application status.</p>
        </div>
      </div>`,
    }).catch(e => logger.error({ err: e }, 'MPGS submit confirmation email failed'));

    // Notify Paylode admin
    const adminEmail = process.env.MPGS_ADMIN_NOTIFY_EMAIL || process.env.EMAIL_FROM;
    if (adminEmail) {
      await sendEmail({
        to: adminEmail,
        subject: `[MPGS Portal] New submission — ${req.mpgsApplicant.companyName || req.mpgsApplicant.email}`,
        html: `<p>A new MPGS onboarding application has been submitted by <strong>${req.mpgsApplicant.firstName} ${req.mpgsApplicant.lastName}</strong> (${req.mpgsApplicant.email}).</p>
          <p>Review it in the <a href="${process.env.MPGS_PORTAL_URL || 'https://mpgs.paylodeservices.com'}/mpgs-admin.html">MPGS Admin Portal</a>.</p>`,
      }).catch(() => {});
    }

    return ok(res, { status: updated.status }, 'Application submitted successfully');
  } catch (e) {
    logger.error({ err: e }, 'MPGS submit error');
    return fail(res, 'Submission failed', 'ERROR', 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES (requireAuth + requireAdminOrCompliance)
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/applications
router.get('/admin/applications', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const where = status ? { status } : {};
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

// GET /admin/applications/:id
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
    return ok(res, { app, docsList: MPGS_DOCS });
  } catch (e) {
    logger.error({ err: e }, 'MPGS admin get error');
    return fail(res, 'Failed to fetch application', 'ERROR', 500);
  }
});

// PUT /admin/applications/:id/status
router.put('/admin/applications/:id/status', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { status, note } = req.body;
    const valid = ['UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED'];
    if (!valid.includes(status)) return fail(res, `Status must be one of: ${valid.join(', ')}`);

    const app = await prisma.mpgsApplication.findUnique({
      where: { id: req.params.id },
      include: { applicant: true },
    });
    if (!app) return notFound(res, 'Application');

    await prisma.mpgsApplication.update({ where: { id: req.params.id }, data: { status } });

    if (status === 'ACTION_REQUIRED' && note) {
      await sendEmail({
        to: app.applicant.email,
        subject: 'Action required on your MPGS application — Paylode',
        html: `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0">
            <p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Portal</p>
          </div>
          <div style="background:#fff8ed;padding:32px;border:1px solid #fcd34d;border-top:none;border-radius:0 0 10px 10px">
            <p style="color:#1e293b">Hello ${app.applicant.firstName},</p>
            <p style="color:#475569">Your MPGS onboarding application requires your attention:</p>
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0">
              <p style="color:#334155;white-space:pre-wrap">${note}</p>
            </div>
            <p style="color:#475569">Please log in to your portal to review and take action.</p>
            <a href="${process.env.MPGS_PORTAL_URL || 'https://mpgs.paylodeservices.com'}/mpgs-dashboard.html" style="display:inline-block;background:#7dc534;color:#1a2744;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;margin-top:8px">Go to Portal</a>
          </div>
        </div>`,
      }).catch(e => logger.error({ err: e }, 'MPGS action-required email failed'));
    }

    return ok(res, { status }, 'Status updated');
  } catch (e) {
    logger.error({ err: e }, 'MPGS admin status update error');
    return fail(res, 'Update failed', 'ERROR', 500);
  }
});

// POST /admin/applications/:id/comments
router.post('/admin/applications/:id/comments', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { content, isInternal } = req.body;
    if (!content) return fail(res, 'Comment content is required');

    const app = await prisma.mpgsApplication.findUnique({
      where: { id: req.params.id },
      include: { applicant: true },
    });
    if (!app) return notFound(res, 'Application');

    const authorName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;
    let sentByEmail = false;

    if (!isInternal) {
      await sendEmail({
        to: app.applicant.email,
        subject: 'New feedback on your MPGS application — Paylode',
        html: `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0">
            <p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Portal</p>
          </div>
          <div style="background:#f8fafc;padding:32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">
            <p style="color:#1e293b">Hello ${app.applicant.firstName},</p>
            <p style="color:#475569">The Paylode review team has left a comment on your MPGS application:</p>
            <div style="background:#fff;border-left:4px solid #1a2744;padding:16px 20px;margin:16px 0;border-radius:0 8px 8px 0">
              <p style="color:#334155;white-space:pre-wrap;margin:0">${content}</p>
            </div>
            <a href="${process.env.MPGS_PORTAL_URL || 'https://mpgs.paylodeservices.com'}/mpgs-dashboard.html" style="display:inline-block;background:#7dc534;color:#1a2744;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;margin-top:8px">View in Portal</a>
          </div>
        </div>`,
      }).then(() => { sentByEmail = true; }).catch(e => logger.error({ err: e }, 'MPGS comment email failed'));
    }

    const comment = await prisma.mpgsComment.create({
      data: {
        applicationId: req.params.id,
        authorName,
        content,
        isInternal: !!isInternal,
        sentByEmail,
      },
    });
    return created(res, comment, 'Comment added');
  } catch (e) {
    logger.error({ err: e }, 'MPGS admin comment error');
    return fail(res, 'Failed to add comment', 'ERROR', 500);
  }
});

// PUT /admin/applications/:id/documents/:docKey/status
router.put('/admin/applications/:id/documents/:docKey/status', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['ACCEPTED', 'REJECTED', 'REUPLOAD_REQUESTED'];
    if (!valid.includes(status)) return fail(res, `Status must be one of: ${valid.join(', ')}`);

    const app = await prisma.mpgsApplication.findUnique({
      where: { id: req.params.id },
      include: { applicant: true },
    });
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
          <div style="background:#1a2744;padding:24px 32px;border-radius:10px 10px 0 0">
            <p style="color:#fff;font-size:18px;font-weight:700;margin:0">Paylode MPGS Portal</p>
          </div>
          <div style="background:#fff8ed;padding:32px;border:1px solid #fcd34d;border-top:none;border-radius:0 0 10px 10px">
            <p style="color:#1e293b">Hello ${app.applicant.firstName},</p>
            <p style="color:#475569">Please re-upload the following document: <strong>${doc.docLabel}</strong></p>
            <a href="${process.env.MPGS_PORTAL_URL || 'https://mpgs.paylodeservices.com'}/mpgs-documents.html" style="display:inline-block;background:#7dc534;color:#1a2744;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;margin-top:8px">Go to Documents</a>
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

// GET /admin/applications/:id/documents/:docKey/download
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

// POST /admin/applications/:id/send-to-bank
router.post('/admin/applications/:id/send-to-bank', requireAuth, requireAdminOrCompliance, async (req, res) => {
  try {
    const { docKeys, includeQuestionnaire, includeApplicationForm, recipientEmail, note } = req.body;
    const bankEmail = recipientEmail || process.env.PARALLEX_BANK_EMAIL;
    if (!bankEmail) return fail(res, 'Recipient email is required (set PARALLEX_BANK_EMAIL env var or pass recipientEmail in body)');

    const app = await prisma.mpgsApplication.findUnique({
      where: { id: req.params.id },
      include: {
        applicant: { select: { firstName: true, lastName: true, email: true, companyName: true } },
        documents: true,
      },
    });
    if (!app) return notFound(res, 'Application');

    // Collect file attachments
    const attachments = [];
    if (docKeys && docKeys.length) {
      for (const key of docKeys) {
        const doc = app.documents.find(d => d.docKey === key);
        if (doc && fs.existsSync(doc.filepath)) {
          attachments.push({ filename: `${doc.docKey}_${doc.filename}`, path: doc.filepath });
        }
      }
    }

    const companyName = app.applicant.companyName || `${app.applicant.firstName} ${app.applicant.lastName}`;

    // Build email HTML with form data
    let formHtml = '';
    if (includeQuestionnaire && app.questionnaire) {
      formHtml += buildQuestionnaireHtml(app.questionnaire);
    }
    if (includeApplicationForm && app.applicationForm) {
      formHtml += buildApplicationFormHtml(app.applicationForm);
    }

    await sendEmail({
      to: bankEmail,
      subject: `MPGS Onboarding Application — ${companyName}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
        <div style="background:#1a2744;padding:20px 28px;border-radius:8px 8px 0 0">
          <p style="color:#fff;font-size:16px;font-weight:bold;margin:0">Parallex Bank MPGS Onboarding — Submitted via Paylode Services</p>
        </div>
        <div style="background:#f8fafc;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
          <p><strong>Applicant:</strong> ${companyName}</p>
          <p><strong>Email:</strong> ${app.applicant.email}</p>
          <p><strong>Submitted by Paylode team member:</strong> ${req.user.email}</p>
          ${note ? `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;margin:12px 0"><p style="margin:0;color:#334155">${note}</p></div>` : ''}
          <p><strong>Attached documents:</strong> ${attachments.length ? attachments.map(a => a.filename).join(', ') : 'None'}</p>
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

// ── HTML builders for send-to-bank email ──────────────────────────────────

function buildQuestionnaireHtml(q) {
  return `
    <hr style="margin:24px 0;border:none;border-top:2px solid #e2e8f0">
    <h2 style="color:#1a2744;font-size:16px">WEB BUSINESS — QUESTIONNAIRE</h2>
    <h3 style="font-size:14px;color:#334155">A. GENERAL INFORMATION</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
      <thead><tr style="background:#f1f5f9"><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">S/N</th><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">Item</th><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">Response</th></tr></thead>
      <tbody>
        ${[
          ['1','Company Name',q.companyName],['2','Company Address (Head office)',q.companyAddress],
          ['3','Length of stay at company address',q.lengthOfStay],['4','Country of location',q.country],
          ['5','Full Name and Address of Directors',q.directors],['6','Company Registration Number',q.rcNumber],
          ['7','Company Bank Verification Number (BVN)',q.bvn],['8','Tax Identification Number',q.tin],
          ['9','Number of years/months of operation',q.yearsOfOperation],['10','List of outlets and their address',q.outlets],
          ['11','Website / URL / IP Address',q.website],['12','Customer service contact number and email',q.customerServiceContact],
          ['13a','Type of Goods or Services',q.typeOfGoods],['13b','Merchant Category Code (MCC)',q.mcc],
          ['15','Previous Payment Engines (Yes or No)',q.prevPaymentEngines],
          ['16','Reason for leaving',q.reasonForLeaving],
          ['17','Address of merchant store/Warehouse',q.storeAddress],
        ].map(([n,label,val]) => `<tr><td style="padding:7px 10px;border:1px solid #e2e8f0;color:#64748b">${n}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${label}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${val || '—'}</td></tr>`).join('')}
      </tbody>
    </table>
    <h3 style="font-size:14px;color:#334155">B. PAYMENT INFORMATION</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
      <thead><tr style="background:#f1f5f9"><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">S/N</th><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">Item</th><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">Response</th></tr></thead>
      <tbody>
        ${[
          ['1','Card brands accepted',(q.cardBrands||[]).join(', ')],['2','Card currencies',(q.cardCurrencies||[]).join(', ')],
          ['3','Card types',(q.cardTypes||[]).join(', ')],['4','Time frame for order processing',q.orderProcessingTime],
          ['5','Payment model',q.paymentModel],['6','Transaction model',q.transactionModel],
          ['7','Annual Sales Projection — Volume',q.annualVolume],['7','Annual Sales Projection — Value',q.annualValue],
        ].map(([n,label,val]) => `<tr><td style="padding:7px 10px;border:1px solid #e2e8f0;color:#64748b">${n}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${label}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${val || '—'}</td></tr>`).join('')}
      </tbody>
    </table>
    <h3 style="font-size:14px;color:#334155">C. SECURITY INFORMATION</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
      <thead><tr style="background:#f1f5f9"><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">S/N</th><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">Item</th><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">Response</th></tr></thead>
      <tbody>
        ${[
          ['1','PCIDSS Status',q.pcidssStatus],['2','Advance Functionality',(q.advanceFunctionality||[]).join(', ')],
          ['3','3-D Secure',(q.threeDSecure||[]).join(', ')],['4','Will send unique transaction & order reference',q.uniqueRef],
        ].map(([n,label,val]) => `<tr><td style="padding:7px 10px;border:1px solid #e2e8f0;color:#64748b">${n}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${label}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${val || '—'}</td></tr>`).join('')}
      </tbody>
    </table>
    <h3 style="font-size:14px;color:#334155">D. SALES INFORMATION</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
      <thead><tr style="background:#f1f5f9"><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">S/N</th><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">Item</th><th style="padding:8px 10px;text-align:left;border:1px solid #e2e8f0">Response</th></tr></thead>
      <tbody>
        ${[
          ['1','Estimated Daily Sales',q.salesDaily],['1','Estimated Weekly Sales',q.salesWeekly],
          ['1','Estimated Monthly Sales',q.salesMonthly],['1','Estimated Annual Sales',q.salesAnnual],
          ['2','Highest goods/service value',q.highestValue],['3','Lowest goods/service value',q.lowestValue],
          ['4','List of goods and services',q.goodsList],
        ].map(([n,label,val]) => `<tr><td style="padding:7px 10px;border:1px solid #e2e8f0;color:#64748b">${n}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${label}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${val || '—'}</td></tr>`).join('')}
      </tbody>
    </table>`;
}

function buildApplicationFormHtml(f) {
  return `
    <hr style="margin:24px 0;border:none;border-top:2px solid #e2e8f0">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px">
      <div><strong style="color:#1a2744;font-size:14px">parallex</strong><br><span style="font-size:11px;color:#64748b">Bank</span></div>
      <div style="text-align:right"><strong style="color:#1a2744">PARALLEX BANK LIMITED</strong><br><span style="font-size:12px;color:#64748b">RC 747627</span></div>
    </div>
    <h2 style="color:#1a2744;font-size:15px;text-align:center">PARALLEX PAYMENT GATEWAY — MERCHANT APPLICATION FORM</h2>
    <h3 style="font-size:13px;color:#fff;background:#1a2744;padding:8px 12px;margin-top:16px">SECTION 1: GENERAL INFORMATION</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px">
      ${[['Company Name',f.s1CompanyName],['Company Address',f.s1CompanyAddress],
         ['Type of Ownership',f.s1OwnershipType],['RC Number',f.s1RcNumber],
         ['Trading Name',f.s1TradingName],['Date Registered',f.s1DateRegistered],
         ['Tax Identification Number',f.s1Tin]
        ].map(([l,v]) => `<tr><td style="padding:7px 10px;border:1px solid #e2e8f0;width:200px;background:#f8fafc;font-weight:600">${l}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${v || '—'}</td></tr>`).join('')}
    </table>
    <h3 style="font-size:13px;color:#fff;background:#1a2744;padding:8px 12px;margin-top:16px">SECTION 2: CONTACT INFORMATION</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px">
      <tr><th style="padding:7px 10px;border:1px solid #e2e8f0;background:#f1f5f9">Field</th><th style="padding:7px 10px;border:1px solid #e2e8f0;background:#f1f5f9">Primary Contact</th><th style="padding:7px 10px;border:1px solid #e2e8f0;background:#f1f5f9">Secondary Contact</th></tr>
      ${[['Name','s2PrimaryName','s2SecondaryName'],['Designation','s2PrimaryDesignation','s2SecondaryDesignation'],
         ['Office Tel/Ext','s2PrimaryOfficeTel','s2SecondaryOfficeTel'],['Mobile','s2PrimaryMobile','s2SecondaryMobile'],
         ['Email','s2PrimaryEmail','s2SecondaryEmail']
        ].map(([l,pk,sk]) => `<tr><td style="padding:7px 10px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600">${l}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${f[pk]||'—'}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${f[sk]||'—'}</td></tr>`).join('')}
    </table>
    <h3 style="font-size:13px;color:#fff;background:#1a2744;padding:8px 12px;margin-top:16px">SECTION 3: ECOMMERCE WEBSITE INFORMATION</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px">
      ${[['Products / Services & MCC',f.s3ProductsMcc],['Website Name',f.s3WebsiteName],['Website URL',f.s3WebsiteUrl]
        ].map(([l,v]) => `<tr><td style="padding:7px 10px;border:1px solid #e2e8f0;width:200px;background:#f8fafc;font-weight:600">${l}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${v||'—'}</td></tr>`).join('')}
    </table>
    <h3 style="font-size:13px;color:#fff;background:#1a2744;padding:8px 12px;margin-top:16px">SECTION 4: BANK DETAILS</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px">
      ${[['Account Number',f.s4AccountNumber],['Account Name',f.s4AccountName],['Account Type',f.s4AccountType],
         ['Settlement Account',f.s4SettlementAccount],['Collateral Account',f.s4CollateralAccount],['Branch',f.s4Branch]
        ].map(([l,v]) => `<tr><td style="padding:7px 10px;border:1px solid #e2e8f0;width:200px;background:#f8fafc;font-weight:600">${l}</td><td style="padding:7px 10px;border:1px solid #e2e8f0">${v||'—'}</td></tr>`).join('')}
    </table>
    <h3 style="font-size:13px;color:#fff;background:#1a2744;padding:8px 12px;margin-top:16px">SECTION 5: OTHER DETAILS</h3>
    <p style="padding:8px 10px;border:1px solid #e2e8f0;border-radius:4px;font-size:13px">${f.s5OtherDetails || '—'}</p>
    <p style="font-size:13px;color:#475569"><strong>Declaration:</strong> ${f.s5IndividualName || '—'} on behalf of ${f.s5CompanyName || '—'} | Designation: ${f.s5Designation || '—'} | Date: ${f.s5Date || '—'}</p>
    <h3 style="font-size:13px;color:#fff;background:#1a2744;padding:8px 12px;margin-top:16px">SECTION 6: MERCHANT INFORMATION</h3>
    <p style="font-size:13px;padding:8px 10px"><strong>Onboarding type:</strong> ${f.s6OnboardingType || '—'}</p>`;
}

module.exports = router;
