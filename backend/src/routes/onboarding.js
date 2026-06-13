'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { prisma } = require('../utils/db');
const { ok, fail, created } = require('../utils/helpers');
const { sendEmail } = require('../services/emailService');
const { logger } = require('../utils/logger');
const { requireAuth, requireCompliance } = require('../middleware/auth');

const UPLOAD_DIR = process.env.ONBOARDING_UPLOAD_DIR || path.join(__dirname, '../../uploads/onboarding');

// Placeholder consolidated sanctions list. Replace with a live feed (NFIU / UN /
// OFAC / EU) or route names through the YouVerify screening API before go-live.
const SANCTIONS_NAMES = (process.env.SANCTIONS_NAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ── helpers ───────────────────────────────────────────────────────────────────
function genReference() {
  return 'PLY-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

// Decode a `data:<mime>;base64,...` URL and write it to disk; return the saved path.
function saveDataUrl(dataUrl, destDir, baseName) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
  const safe = baseName.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 60);
  const filename = `${safe}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, filename), buf);
  return path.relative(UPLOAD_DIR, path.join(destDir, filename));
}

function fullName(p) {
  return [p.first_name, p.other_names, p.surname].filter(Boolean).join(' ').trim();
}

// Derive the headline business name + contact from whichever form was submitted.
function deriveSummary(formType, applicantType, data, principals) {
  const np = data.np_identity || {};
  const ent = data.entity_details || {};
  const biz = data.np_business || {};
  const inst = data.institution || {};        // legacy merchant form
  const dd = data.dd_institution || {};       // due-diligence form

  if (formType === 'merchant' && applicantType === 'natural') {
    return {
      businessName: biz.trading_name || fullName(np) || 'Individual applicant',
      contactEmail: np.email || null,
      contactPhone: np.phone || null,
      regNumber: null,
      tin: null,
    };
  }
  if (formType === 'merchant' && applicantType === 'entity') {
    return {
      businessName: ent.registered_name || 'Registered business',
      contactEmail: ent.business_email || null,
      contactPhone: ent.business_phone || null,
      regNumber: ent.reg_number || null,
      tin: ent.tin || null,
    };
  }
  // aggregator / due-diligence / legacy
  return {
    businessName: inst.business_name || dd.dd_institution_name || 'Unknown',
    contactEmail: (data.contact && data.contact.business_email) || null,
    contactPhone: (data.contact && data.contact.mobile) || null,
    regNumber: inst.rc_number || dd.dd_reg_number || null,
    tin: null,
  };
}

// Basic AML screening — PEP self-declaration + sanctions name match + risk band.
function screen(applicantType, data, principals) {
  const np = data.np_identity || {};
  const biz = data.np_business || {};
  const notes = [];

  let pepFlag = (np.is_pep === 'yes');
  if (pepFlag) notes.push('Individual applicant self-declared as a PEP.');

  const names = [];
  if (applicantType === 'natural') names.push(fullName(np));
  (principals || []).forEach(p => {
    names.push(fullName(p));
    if (p.is_pep) { pepFlag = true; notes.push(`${p.role || 'Principal'} ${fullName(p)} declared as a PEP.`); }
  });

  let sanctionsHit = false;
  for (const n of names) {
    const low = (n || '').toLowerCase();
    if (low && SANCTIONS_NAMES.some(s => low.includes(s))) {
      sanctionsHit = true;
      notes.push(`Possible sanctions-list match: "${n}" — requires manual review.`);
    }
  }

  const intl = biz.mkt_intl === '1';
  const highVol = ['50to200m', 'above200m'].includes(biz.expected_monthly_value);
  let riskLevel = 'low';
  if (pepFlag || sanctionsHit) riskLevel = 'high';
  else if (highVol || intl) riskLevel = 'medium';
  else if (biz.expected_monthly_value && biz.expected_monthly_value !== 'below1m') riskLevel = 'medium';

  if (SANCTIONS_NAMES.length === 0) notes.push('Note: live sanctions list not configured — only PEP self-declaration screened.');

  return { pepFlag, sanctionsHit, riskLevel, screeningNotes: notes };
}

// ── POST /api/v1/onboarding/submit — public, no auth ──────────────────────────
router.post('/submit', async (req, res, next) => {
  try {
    const {
      form_type, applicant_type, data = {}, principals = [],
      uploads = {}, signature, referred_by, submitted_at,
    } = req.body;

    if (!form_type) return fail(res, 'form_type is required');

    const reference = genReference();
    const destDir = path.join(UPLOAD_DIR, reference);

    // Persist uploaded files (data-URLs) to disk; keep only metadata + path in DB.
    const documents = [];
    for (const [key, file] of Object.entries(uploads)) {
      if (!file || !file.dataUrl) { if (file) documents.push({ key, docType: file.docType, name: file.name, path: null }); continue; }
      const saved = saveDataUrl(file.dataUrl, destDir, key);
      documents.push({ key, docType: file.docType, name: file.name, path: saved });
    }

    // Principal ID uploads + strip data-URLs out of the principals JSON.
    const cleanPrincipals = (principals || []).map((p, i) => {
      const copy = { ...p };
      if (copy.id_file && copy.id_file.dataUrl) {
        const saved = saveDataUrl(copy.id_file.dataUrl, destDir, `principal_${i}_id`);
        documents.push({ key: `principal_${i}_id`, docType: 'principal_id', name: copy.id_file.name, path: saved, principal: fullName(copy) });
        copy.id_file = { name: copy.id_file.name, path: saved };
      }
      return copy;
    });

    const summary = deriveSummary(form_type, applicant_type, data, cleanPrincipals);
    const screening = screen(applicant_type, data, cleanPrincipals);

    let record = null;
    try {
      record = await prisma.onboardingSubmission.create({
        data: {
          reference,
          formType: form_type,
          applicantType: applicant_type || null,
          businessName: summary.businessName,
          contactEmail: summary.contactEmail,
          contactPhone: summary.contactPhone,
          regNumber: summary.regNumber,
          tin: summary.tin,
          data,
          principals: cleanPrincipals,
          documents,
          pepFlag: screening.pepFlag,
          sanctionsHit: screening.sanctionsHit,
          riskLevel: screening.riskLevel,
          screeningNotes: screening.screeningNotes,
          signature: signature || null,
          referredBy: referred_by || null,
        },
      });
    } catch (dbErr) {
      // If the table/migration isn't applied yet, don't lose the application —
      // log it and still notify compliance so onboarding never hard-fails.
      logger.error({ err: dbErr, reference }, 'Could not persist onboarding submission — falling back to email only');
    }

    logger.info({
      reference, form_type, applicant_type,
      business: summary.businessName, risk: screening.riskLevel,
      pep: screening.pepFlag, sanctions: screening.sanctionsHit,
      docs: documents.length, principals: cleanPrincipals.length,
    }, 'New onboarding submission received');

    // Notify compliance
    const riskBadge = screening.riskLevel.toUpperCase();
    await sendEmail({
      to: process.env.COMPLIANCE_EMAIL || 'compliance@paylodeservices.com',
      subject: `New ${form_type} application — ${summary.businessName} [${riskBadge} risk] ${reference}`,
      html: `
        <h2>New Onboarding Application</h2>
        <p><strong>Reference:</strong> ${reference}</p>
        <p><strong>Type:</strong> ${form_type}${applicant_type ? ' / ' + applicant_type : ''}</p>
        <p><strong>Business:</strong> ${summary.businessName}</p>
        <p><strong>Reg. number:</strong> ${summary.regNumber || '—'} &nbsp; <strong>TIN:</strong> ${summary.tin || '—'}</p>
        <p><strong>Contact:</strong> ${summary.contactEmail || '—'} / ${summary.contactPhone || '—'}</p>
        <p><strong>Risk level:</strong> ${riskBadge} &nbsp; <strong>PEP:</strong> ${screening.pepFlag ? 'YES' : 'No'} &nbsp; <strong>Sanctions match:</strong> ${screening.sanctionsHit ? 'YES — REVIEW' : 'No'}</p>
        <p><strong>Principals:</strong> ${cleanPrincipals.length} &nbsp; <strong>Documents:</strong> ${documents.length}</p>
        ${screening.screeningNotes.length ? '<p><strong>Screening notes:</strong></p><ul>' + screening.screeningNotes.map(n => `<li>${n}</li>`).join('') + '</ul>' : ''}
        <hr>
        <p>Review in the compliance dashboard: <a href="${process.env.APP_URL || ''}/login.html">Open dashboard →</a></p>
      `,
    }).catch(e => logger.error({ err: e }, 'Failed to send onboarding notification'));

    // Confirmation to applicant
    if (summary.contactEmail) {
      await sendEmail({
        to: summary.contactEmail,
        subject: `Paylode application received — ${reference}`,
        html: `
          <h2>Application Received</h2>
          <p>Thank you for applying to join Paylode. We have received your application and our compliance team will review it within 1–3 business days.</p>
          <p><strong>Your reference number: ${reference}</strong></p>
          <p>Please keep this reference for your records.</p>
          <p>Questions? Contact <a href="mailto:support@paylodeservices.com">support@paylodeservices.com</a></p>
          <p>Best regards,<br>Paylode Services Limited</p>
        `,
      }).catch(e => logger.error({ err: e }, 'Failed to send applicant confirmation'));
    }

    created(res, {
      reference,
      message: 'Application submitted successfully',
      form_type,
      business: summary.businessName,
      risk_level: screening.riskLevel,
      next_steps: 'Our compliance team will review your application within 1-3 business days. You will receive an email notification.',
    }, 'Application submitted');

  } catch (e) { next(e); }
});

// ── GET /api/v1/onboarding/submissions — compliance only ──────────────────────
router.get('/submissions', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { status, form_type } = req.query;
    const where = {};
    if (status) where.status = status;
    if (form_type) where.formType = form_type;
    const rows = await prisma.onboardingSubmission.findMany({
      where,
      orderBy: { submittedAt: 'desc' },
      take: 200,
      select: {
        id: true, reference: true, formType: true, applicantType: true, status: true,
        businessName: true, contactEmail: true, contactPhone: true, regNumber: true, tin: true,
        pepFlag: true, sanctionsHit: true, riskLevel: true, submittedAt: true,
      },
    });
    ok(res, rows, 'Onboarding submissions');
  } catch (e) { next(e); }
});

// ── GET /api/v1/onboarding/submissions/:reference — full detail, compliance only
router.get('/submissions/:reference', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const row = await prisma.onboardingSubmission.findUnique({ where: { reference: req.params.reference } });
    if (!row) return fail(res, 'Submission not found', 'NOT_FOUND', 404);
    ok(res, row, 'Onboarding submission detail');
  } catch (e) { next(e); }
});

// ── PATCH /api/v1/onboarding/submissions/:reference — review decision ─────────
router.patch('/submissions/:reference', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { status, review_notes } = req.body;
    const allowed = ['pending', 'under_review', 'approved', 'rejected'];
    if (status && !allowed.includes(status)) return fail(res, 'Invalid status');
    const row = await prisma.onboardingSubmission.update({
      where: { reference: req.params.reference },
      data: {
        ...(status ? { status } : {}),
        ...(review_notes !== undefined ? { reviewNotes: review_notes } : {}),
        reviewedBy: req.user?.id || null,
      },
    });
    ok(res, row, 'Submission updated');
  } catch (e) { next(e); }
});

// ── GET /api/v1/onboarding/submissions/:reference/document/:key — stream a file
router.get('/submissions/:reference/document/:key', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const row = await prisma.onboardingSubmission.findUnique({ where: { reference: req.params.reference } });
    if (!row) return fail(res, 'Submission not found', 'NOT_FOUND', 404);
    const doc = (row.documents || []).find(d => d.key === req.params.key);
    if (!doc || !doc.path) return fail(res, 'Document not found', 'NOT_FOUND', 404);
    const abs = path.resolve(UPLOAD_DIR, doc.path);
    // Prevent path traversal outside the upload dir
    if (!abs.startsWith(path.resolve(UPLOAD_DIR))) return fail(res, 'Invalid path', 'FORBIDDEN', 403);
    if (!fs.existsSync(abs)) return fail(res, 'File missing on server', 'NOT_FOUND', 404);
    res.download(abs, doc.name || path.basename(abs));
  } catch (e) { next(e); }
});

module.exports = router;
