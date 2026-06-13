'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { prisma } = require('../utils/db');
const { ok, fail, created, generateApiKey, hashApiKey } = require('../utils/helpers');
const { sendEmail, getEmailContent } = require('../services/emailService');
const { logger } = require('../utils/logger');
const { requireAuth, requireCompliance } = require('../middleware/auth');
const { CHECK_ITEMS } = require('./documents');

// Required documents seeded into kyc_documents when a merchant is provisioned,
// keyed by entity sub-type. Uploaded application docs are marked 'submitted'.
const ENTITY_DOC_SET = {
  llc:        [['cert_incorp','Certificate of Incorporation'],['memart','MEMART'],['status_report','CAC Status Report (or CO2 + CO7)'],['board_resolution','Board Resolution'],['tin_cert','TIN certificate'],['proof_address','Proof of business address']],
  ulc:        [['cert_incorp','Certificate of Incorporation'],['memart','MEMART'],['status_report','CAC Status Report (or CO2 + CO7)'],['board_resolution','Board Resolution'],['tin_cert','TIN certificate'],['proof_address','Proof of business address']],
  sole_prop:  [['cert_incorp','Certificate of Registration of Business Name'],['tin_cert','TIN certificate'],['proof_address','Proof of business address']],
  partnership:[['cert_incorp','Certificate of Registration'],['partnership_deed','Partnership Deed / Agreement'],['tin_cert','TIN certificate'],['proof_address','Proof of business address']],
  trust:      [['cert_incorp','Certificate of Registration (Incorporated Trustees)'],['constitution','Constitution / Trust Deed'],['proof_address','Proof of business address']],
  charity:    [['cert_incorp','Certificate of Registration (Incorporated Trustees)'],['constitution','Constitution / Governing Instrument'],['proof_address','Proof of business address']],
  prof_body:  [['enabling_doc','Enabling Act / extract'],['proof_address','Proof of business address']],
  other:      [['cert_incorp','Registration / incorporation document'],['proof_address','Proof of business address']],
};
const NATURAL_DOC_SET = [['id_document','Government-issued ID'],['proof_address','Proof of address'],['bvn','BVN'],['nin','NIN']];

// Map an uploaded application doc key (or signal) to a kyc_documents doc_key.
function submittedDocKeys(sub) {
  const set = new Set();
  const docs = sub.documents || [];
  const alias = {
    bn_cert:'cert_incorp', partnership_cert:'cert_incorp', trustees_cert:'cert_incorp',
    reg_doc:'cert_incorp', enabling_doc:'enabling_doc', cac_application:'cert_incorp',
    cert_incorp:'cert_incorp', memart:'memart', board_resolution:'board_resolution',
    tin_cert:'tin_cert', partnership_deed:'partnership_deed', constitution:'constitution',
    status_report:'status_report',
  };
  for (const d of docs) {
    const k = (d.key || '').replace(/^doc_/, '');
    if (alias[k]) set.add(alias[k]);
    if (k === 'entity_proof_address' || k === 'np_proof_address') set.add('proof_address');
    if (k === 'np_id_doc') set.add('id_document');
  }
  if (docs.some(d => (d.key || '').startsWith('doc_form_co2')) && docs.some(d => (d.key || '').startsWith('doc_form_co7'))) set.add('status_report');
  const np = (sub.data && sub.data.np_identity) || {};
  if (np.bvn) set.add('bvn');
  if (np.nin) set.add('nin');
  return set;
}

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
      const content = await getEmailContent('application_received',
        { name: summary.businessName, reference, business: summary.businessName },
        `Paylode application received — ${reference}`,
        `<h2>Application Received</h2><p>Thank you for applying to join Paylode. Your application has been received and our compliance team will review it within 1-3 business days.</p><p><strong>Your reference number: ${reference}</strong></p><p>Questions? Contact support@paylodeservices.com</p>`);
      await sendEmail({ to: summary.contactEmail, subject: content.subject, html: content.html })
        .catch(e => logger.error({ err: e }, 'Failed to send applicant confirmation'));
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

// Create the merchant + API keys + seed per-document tracking from a submission.
// Runs inside the approval transaction (tx) so it is atomic with the status claim.
async function provisionMerchant(tx, sub) {
  const data = sub.data || {};
  const np  = data.np_identity || {};
  const ent = data.entity_details || {};
  const biz = data.np_business || {};
  const isNatural = sub.applicantType === 'natural';

  const email = (isNatural ? np.email : ent.business_email) || sub.contactEmail;
  if (!email) throw new Error('No contact email on submission — cannot provision merchant');

  const businessName = sub.businessName || 'Merchant';
  const businessType = isNatural ? 'Individual'
    : ({ llc:'Limited Liability Company', ulc:'Unlimited Liability Company', sole_prop:'Sole Proprietorship',
         partnership:'Partnership', trust:'Registered Trust', charity:'Registered Charity',
         prof_body:'Professional Body', other:(ent.entity_other || 'Other') }[ent.entity_type] || 'Registered Business');

  // One user ⇒ one merchant (Merchant.userId is unique). Reuse an existing user
  // with this email; if they already have a merchant, link to it (idempotent).
  let user = await tx.user.findUnique({ where: { email }, include: { merchant: true } });
  if (user && user.merchant) return { merchantId: user.merchant.id, reused: true };

  let tempPassword = null;
  if (!user) {
    tempPassword = crypto.randomBytes(6).toString('base64url');
    user = await tx.user.create({ data: {
      email, passwordHash: await bcrypt.hash(tempPassword, 10),
      firstName: np.first_name || businessName, lastName: np.surname || '', role: 'MERCHANT',
      mustChangePassword: true,
    }});
  }

  const merchant = await tx.merchant.create({ data: {
    userId:            user.id,
    merchantCode:      'MCH-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    businessName, businessType,
    category:          biz.category || 'Other',
    rcNumber:          isNatural ? null : (ent.reg_number || null),
    state:             (isNatural ? np.state : ent.state) || 'Lagos',
    address:           (isNatural ? np.address : ent.registered_address) || null,
    businessEmail:     email,
    businessPhone:     (isNatural ? np.phone : ent.business_phone) || '',
    website:           biz.website_url || null,
    expectedMonthlyVol: biz.expected_monthly_value || null,
    kycStatus: 'ACTIVE', kycTier: 1, isActive: true,
    settlementBank:        biz.bank_name || null,
    settlementAccount:     biz.account_number || null,
    settlementAccountName: biz.account_name || null,
    settlementCycle:       biz.settlement_cycle || 't1',
  }});

  const keys = [['sk_live', false], ['pk_live', false], ['sk_test', true], ['pk_test', true]].map(([prefix, sandbox]) => {
    const full = generateApiKey(prefix);
    return { merchantId: merchant.id, keyHash: hashApiKey(full), keyPrefix: prefix, label: 'Issued on approval', isSandbox: sandbox };
  });
  await tx.apiKey.createMany({ data: keys });

  // Seed per-document tracking; mark uploaded application docs as 'submitted'.
  const reqDocs   = isNatural ? NATURAL_DOC_SET : (ENTITY_DOC_SET[ent.entity_type] || ENTITY_DOC_SET.other);
  const submitted = submittedDocKeys(sub);
  for (const [key, label] of reqDocs) {
    const st = submitted.has(key) ? 'submitted' : 'outstanding';
    await tx.$executeRaw`
      INSERT INTO kyc_documents (entity_type, entity_id, doc_key, doc_label, status)
      VALUES ('merchant', ${merchant.id}::uuid, ${key}, ${label}, ${st})
      ON CONFLICT (entity_type, entity_id, doc_key) DO NOTHING`;
  }
  // Seed the automated verification checks (BVN/NIN/address/TIN/CAC/ID).
  for (const c of (CHECK_ITEMS || [])) {
    await tx.$executeRaw`
      INSERT INTO kyc_documents (entity_type, entity_id, doc_key, doc_label, status)
      VALUES ('merchant', ${merchant.id}::uuid, ${c.k}, ${c.l}, 'outstanding')
      ON CONFLICT (entity_type, entity_id, doc_key) DO NOTHING`;
  }

  return { merchantId: merchant.id, created: true, tempPassword, email, businessName };
}

// ── PATCH /api/v1/onboarding/submissions/:reference — review decision ─────────
router.patch('/submissions/:reference', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { status, review_notes } = req.body;
    const reference = req.params.reference;
    const allowed = ['pending', 'under_review', 'approved', 'rejected'];
    if (status && !allowed.includes(status)) return fail(res, 'Invalid status');

    // Non-approval transitions are a plain update.
    if (status !== 'approved') {
      const existing = await prisma.onboardingSubmission.findUnique({ where: { reference } });
      if (!existing) return fail(res, 'Submission not found', 'NOT_FOUND', 404);
      const row = await prisma.onboardingSubmission.update({
        where: { reference },
        data: { ...(status ? { status } : {}), ...(review_notes !== undefined ? { reviewNotes: review_notes } : {}), reviewedBy: req.user?.id || null },
      });
      // Notify the applicant on review-status changes (template-driven, best-effort).
      if (row.contactEmail && (status === 'under_review' || status === 'rejected')) {
        const slug = status === 'under_review' ? 'application_under_review' : 'application_rejected';
        const content = await getEmailContent(slug,
          { name: row.businessName, reference, business: row.businessName, notes: review_notes || '' },
          status === 'under_review' ? `Your Paylode application is under review — ${reference}` : `Update on your Paylode application — ${reference}`,
          status === 'under_review'
            ? `<p>Your application (${reference}) for ${row.businessName} is now under review.</p>`
            : `<p>After review, we are unable to approve your application (${reference}) at this time. ${review_notes || ''}</p>`);
        sendEmail({ to: row.contactEmail, subject: content.subject, html: content.html }).catch(e => logger.error({ err: e }, 'review email failed'));
      }
      return ok(res, row, 'Submission updated');
    }

    // Approval: claim + provision atomically so it happens EXACTLY once even under
    // concurrent approve clicks/retries.
    let outcome = {};
    await prisma.$transaction(async (tx) => {
      // Atomic claim — only the first concurrent approver flips the row; the rest
      // get count 0 (the UPDATE takes a row lock, serialising the racers).
      const claim = await tx.onboardingSubmission.updateMany({
        where: { reference, status: { not: 'approved' } },
        data: { status: 'approved', reviewedBy: req.user?.id || null, ...(review_notes !== undefined ? { reviewNotes: review_notes } : {}) },
      });
      const sub = await tx.onboardingSubmission.findUnique({ where: { reference } });
      if (!sub) { outcome = { notFound: true }; return; }
      // Already provisioned (re-approval or lost the claim race) → idempotent no-op.
      if (sub.merchantId || claim.count === 0) { outcome = { already: true }; return; }
      if (sub.formType !== 'merchant') { outcome = { skipped: true }; return; }

      const prov = await provisionMerchant(tx, sub);
      await tx.onboardingSubmission.update({ where: { reference }, data: { merchantId: prov.merchantId } });
      outcome = { prov };
    }, { timeout: 20000 });

    if (outcome.notFound) return fail(res, 'Submission not found', 'NOT_FOUND', 404);

    // Best-effort approval email (outside the transaction) — rendered from template.
    if (outcome.prov && outcome.prov.created) {
      const loginUrl = (process.env.APP_URL || '') + '/login.html';
      const content = await getEmailContent('application_approved',
        { business: outcome.prov.businessName, email: outcome.prov.email, temp_password: outcome.prov.tempPassword || '', login_url: loginUrl },
        'Your Paylode merchant account is approved',
        `<h2>Approved</h2><p>Your application for <strong>${outcome.prov.businessName}</strong> has been approved and your merchant account is live.</p>` +
          (outcome.prov.tempPassword ? `<p>Sign in at <a href="${loginUrl}">the dashboard</a> with <strong>${outcome.prov.email}</strong> and temporary password <strong>${outcome.prov.tempPassword}</strong> — change it on first login.</p>` : '') +
          `<p>Any outstanding KYC documents are listed in your dashboard.</p>`);
      sendEmail({ to: outcome.prov.email, subject: content.subject, html: content.html })
        .catch(e => logger.error({ err: e }, 'approval email failed'));
    }

    const fresh = await prisma.onboardingSubmission.findUnique({ where: { reference } });
    const msg = outcome.already ? 'Already approved (no change)'
      : outcome.skipped ? 'Approved (no merchant provisioned for this form type)'
      : 'Approved — merchant provisioned';
    ok(res, fresh, msg);
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
