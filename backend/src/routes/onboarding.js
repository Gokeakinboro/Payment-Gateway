'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { prisma } = require('../utils/db');
const { ok, fail, created, generateApiKey, hashApiKey } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');
const { sendEmail, getEmailContent } = require('../services/emailService');
const { logger } = require('../utils/logger');
const { requireAuth, requireCompliance } = require('../middleware/auth');
const { CHECK_ITEMS } = require('./documents');
const compliance = require('../services/complianceService');

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
// Dead-letter store: if persisting an onboarding submission ever fails, the full
// payload is written here so a real application is never silently lost (only
// emailed). Surfaced via GET /onboarding/dead-letter + a dashboard banner.
const DEAD_LETTER_DIR = process.env.ONBOARDING_DEAD_LETTER_DIR || path.join(UPLOAD_DIR, '_dead_letter');
function writeDeadLetter(reference, payload, errMsg) {
  try {
    fs.mkdirSync(DEAD_LETTER_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DEAD_LETTER_DIR, reference + '.json'),
      JSON.stringify({ reference, failedAt: new Date().toISOString(), error: errMsg, payload }, null, 2),
    );
    return true;
  } catch (e) { logger.error({ err: e, reference }, 'dead-letter write failed'); return false; }
}

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

// AML/Mastercard screening now lives in services/complianceService.js (screenMerchant).

// ── POST /api/v1/onboarding/invite — SA/admin/aggregator emails a self-onboard link
// type: 'merchant' (default) | 'aggregator'. The applicant completes the public
// onboarding form themselves; approval provisions the account.
router.post('/invite', requireAuth, async (req, res, next) => {
  try {
    const { name, email, phone } = req.body;
    const type = req.body.type === 'aggregator' ? 'aggregator' : 'merchant';
    if (!name || !email) return fail(res, 'name and email are required');
    if (!['SUPER_ADMIN', 'ADMIN', 'AGGREGATOR'].includes(req.user.role))
      return res.status(403).json({ status: false, message: 'Not permitted', error_code: 'FORBIDDEN' });

    const base = process.env.APP_URL || 'https://paylodeservices.com';
    const link = `${base}/onboarding.html?type=${type}&via=invite&email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`;
    const content = await getEmailContent('onboarding_invite',
      { name, email, business: name, link, invite_link: link, type },
      `You're invited to onboard on Paylode`,
      `<h2>Welcome to Paylode</h2><p>Hi ${name},</p>` +
        `<p>You have been invited to open a <strong>${type}</strong> account on Paylode. ` +
        `Click below to complete your onboarding — the link is valid for 7 days:</p>` +
        `<p><a href="${link}">Start onboarding</a></p>` +
        `<p>Or paste this link into your browser:<br>${link}</p>`);
    try {
      await sendEmail({ to: email, subject: content.subject, html: content.html });
    } catch (e) {
      logger.error({ err: e, email }, 'onboarding invite email failed');
      return fail(res, 'Could not send the invite email — please try again.');
    }
    logAudit(req.user.id, 'ONBOARDING_INVITE_SENT', 'onboarding', req.user.id, null, { email, name, type, phone: phone || null }, null, req.ip).catch(() => {});
    ok(res, { email, type }, 'Invitation sent');
  } catch (e) { next(e); }
});

// ── POST /api/v1/onboarding/track — PUBLIC. Invitee opened/started the form. ──
// Lets us see "opened but not submitted" (the WHY behind a delayed application).
// No auth (the applicant isn't logged in); deduped to one event/email/hour.
router.post('/track', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const event = req.body.event === 'started' ? 'started' : 'opened';
    const type  = String(req.body.type || '').slice(0, 40) || null;
    if (!email || !email.includes('@')) return ok(res, { skipped: true }); // nothing to track
    const dup = await prisma.$queryRaw`
      SELECT 1 FROM onboarding_invite_events
      WHERE lower(email) = ${email} AND event = ${event} AND created_at > NOW() - INTERVAL '1 hour' LIMIT 1`;
    if (!dup.length) {
      await prisma.$executeRaw`
        INSERT INTO onboarding_invite_events (email, event, applicant_type, ip_address, user_agent, created_at)
        VALUES (${email}, ${event}, ${type}, ${req.ip || null}, ${String(req.headers['user-agent'] || '').slice(0,300)}, NOW())`;
    }
    ok(res, { tracked: true });
  } catch (e) { ok(res, { tracked: false }); } // never block the applicant on a tracking error
});

// ── GET /api/v1/onboarding/invites — SA/compliance: invite funnel + pending ──
// Cross-references invites sent (audit log) × opens/starts (events) × submissions
// so staff can chase invitees who haven't completed, and see how far they got.
router.get('/invites', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const invites = await prisma.$queryRaw`
      SELECT al.created_at AS invited_at,
             al.after_state->>'email' AS email,
             al.after_state->>'name'  AS name,
             al.after_state->>'type'  AS type,
             al.after_state->>'phone' AS phone,
             u.email AS invited_by
      FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id
      WHERE al.action = 'ONBOARDING_INVITE_SENT'
      ORDER BY al.created_at DESC`;
    const out = [];
    for (const inv of invites) {
      const email = (inv.email || '').toLowerCase();
      if (!email) continue;
      const [sub, ev] = await Promise.all([
        prisma.$queryRaw`SELECT reference, status, submitted_at FROM onboarding_submissions WHERE lower(contact_email) = ${email} ORDER BY submitted_at DESC LIMIT 1`,
        prisma.$queryRaw`SELECT event, MAX(created_at) AS at FROM onboarding_invite_events WHERE lower(email) = ${email} GROUP BY event`,
      ]);
      const opened  = ev.find(e => e.event === 'opened');
      const started = ev.find(e => e.event === 'started');
      const submitted = sub[0] || null;
      const status = submitted ? 'submitted' : started ? 'started' : opened ? 'opened' : 'sent';
      out.push({
        email, name: inv.name, type: inv.type, phone: inv.phone, invited_by: inv.invited_by,
        invited_at: inv.invited_at,
        opened_at: opened ? opened.at : null,
        started_at: started ? started.at : null,
        submitted_at: submitted ? submitted.submitted_at : null,
        submission_status: submitted ? submitted.status : null,
        reference: submitted ? submitted.reference : null,
        status,
        days_pending: submitted ? null : Math.floor((Date.now() - new Date(inv.invited_at).getTime()) / 86400000),
      });
    }
    // de-dupe by email (keep most recent invite), pending first
    const seen = new Set(); const deduped = [];
    for (const r of out) { if (!seen.has(r.email)) { seen.add(r.email); deduped.push(r); } }
    ok(res, deduped);
  } catch (e) { next(e); }
});

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
    // Mastercard Rules screening — BRAM/MCC matrix + sanctions/PEP/MATCH/enhanced-DD.
    // Returns the legacy shape (pepFlag/sanctionsHit/riskLevel/screeningNotes) PLUS
    // exceptions[]/scope/mcc which are persisted against the provisioned merchant below.
    const screening = compliance.screenMerchant({
      applicantType: applicant_type, data, principals: cleanPrincipals, documents,
    });

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
      // write it to the dead-letter store, log, and still notify compliance so
      // onboarding never hard-fails. The dashboard banner surfaces dead letters.
      logger.error({ err: dbErr, reference }, 'Could not persist onboarding submission — writing to dead-letter store');
      writeDeadLetter(reference, {
        form_type, applicant_type, data, principals: cleanPrincipals, documents,
        summary, screening, signature: signature || null, referred_by: referred_by || null,
      }, dbErr.message);
    }

    // Application-time account (Stripe-style): create the merchant + API keys now so
    // the developer can integrate/test in sandbox before KYC. The account is INACTIVE
    // — test keys work immediately, live keys activate on approval. Best-effort; an
    // error here never fails the application.
    let signupProv = null;
    if (record && form_type === 'merchant') {
      try {
        await prisma.$transaction(async (tx) => {
          const prov = await provisionMerchant(tx, record, { active: false });
          await tx.onboardingSubmission.update({ where: { reference }, data: { merchantId: prov.merchantId } });
          signupProv = prov;
        }, { timeout: 20000 });
      } catch (e) { logger.error({ err: e, reference }, 'application-time provisioning failed (non-fatal)'); }
      // Persist compliance exceptions against the merchant + roll up its status.
      // BLOCKING exceptions will prevent activation at approval until SA clears them.
      if (signupProv?.merchantId && screening.exceptions?.length) {
        try { await compliance.persistExceptions('merchant', signupProv.merchantId, screening.exceptions); }
        catch (e) { logger.error({ err: e, reference }, 'persisting compliance exceptions failed (non-fatal)'); }
      }
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

    // New account created at signup → email login + sandbox access details.
    if (signupProv && signupProv.created && signupProv.tempPassword) {
      const loginUrl = (process.env.APP_URL || '') + '/login.html';
      const content = await getEmailContent('sandbox_welcome',
        { business: summary.businessName, email: signupProv.email, temp_password: signupProv.tempPassword, login_url: loginUrl },
        'Your Paylode sandbox access is ready',
        `<h2>Start building now</h2><p>While we review your application, your <strong>test / sandbox</strong> access is ready. Sign in at <a href="${loginUrl}">the dashboard</a> with <strong>${signupProv.email}</strong> and temporary password <strong>${signupProv.tempPassword}</strong> (you'll set a new one on first login).</p>` +
        `<p>Go to <strong>Dashboard → API Keys</strong> to copy your <code>sk_test</code> / <code>pk_test</code> keys and test every product in our sandbox. Your <strong>live</strong> keys activate automatically once your KYC is approved.</p>`);
      sendEmail({ to: signupProv.email, subject: content.subject, html: content.html })
        .catch(e => logger.error({ err: e }, 'sandbox welcome email failed'));
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

// ── Dead-letter store (failed-to-persist onboarding applications) ─────────────
// GET — list dead letters so compliance/SA can see applications that were
// emailed but not saved (powers the dashboard banner).
router.get('/dead-letter', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    let files = [];
    try { files = fs.readdirSync(DEAD_LETTER_DIR).filter((f) => f.endsWith('.json')); }
    catch (e) { /* dir not created yet = none */ }
    const items = files.map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DEAD_LETTER_DIR, f), 'utf8'));
        return {
          reference: j.reference, failedAt: j.failedAt, error: j.error,
          businessName: j.payload && j.payload.summary && j.payload.summary.businessName,
          contactEmail: j.payload && j.payload.summary && j.payload.summary.contactEmail,
          formType: j.payload && j.payload.form_type,
        };
      } catch (e) { return { reference: f.replace('.json', ''), error: 'unreadable' }; }
    }).sort((a, b) => (b.failedAt || '').localeCompare(a.failedAt || ''));
    ok(res, { count: items.length, items });
  } catch (e) { next(e); }
});

// POST /:reference/retry — re-attempt persistence of a dead-lettered application.
router.post('/dead-letter/:reference/retry', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const reference = req.params.reference;
    const file = path.join(DEAD_LETTER_DIR, reference + '.json');
    if (!fs.existsSync(file)) return fail(res, 'Dead-letter entry not found', 'NOT_FOUND', 404);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pl = j.payload || {};
    await prisma.onboardingSubmission.create({
      data: {
        reference,
        formType: pl.form_type,
        applicantType: pl.applicant_type || null,
        businessName: pl.summary && pl.summary.businessName,
        contactEmail: pl.summary && pl.summary.contactEmail,
        contactPhone: pl.summary && pl.summary.contactPhone,
        regNumber: pl.summary && pl.summary.regNumber,
        tin: pl.summary && pl.summary.tin,
        data: pl.data || {}, principals: pl.principals || [], documents: pl.documents || [],
        pepFlag: pl.screening && pl.screening.pepFlag,
        sanctionsHit: pl.screening && pl.screening.sanctionsHit,
        riskLevel: pl.screening && pl.screening.riskLevel,
        screeningNotes: pl.screening && pl.screening.screeningNotes,
        signature: pl.signature || null, referredBy: pl.referred_by || null,
      },
    });
    fs.unlinkSync(file); // recovered — remove from dead-letter store
    await logAudit(req.user.id, 'ONBOARDING_DEAD_LETTER_RECOVERED', 'onboarding', reference, null, { reference }, null, req.ip);
    ok(res, { reference }, 'Application recovered into the review queue');
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
async function provisionMerchant(tx, sub, opts = {}) {
  const active = opts.active !== false; // default active (approval); pass {active:false} at signup
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
    // Compliance: structured MCC + card-acceptance scope (selects local vs intl matrix).
    mcc:                 data.mcc || biz.mcc || ent.mcc || null,
    cardAcceptanceScope: (data.card_acceptance_scope || biz.card_acceptance_scope) === 'international' ? 'international' : 'local',
    kycStatus: active ? 'ACTIVE' : 'PENDING_KYC', kycTier: active ? 1 : null, isActive: active,
    settlementBank:        biz.bank_name || null,
    settlementAccount:     biz.account_number || null,
    settlementAccountName: biz.account_name || null,
    settlementCycle:       biz.settlement_cycle || 't1',
  }});

  const keys = [['sk_live', false], ['pk_live', false], ['sk_test', true], ['pk_test', true]].map(([prefix, sandbox]) => {
    const full = generateApiKey(prefix);
    return { merchantId: merchant.id, keyHash: hashApiKey(full), keyPrefix: prefix, label: 'Issued at signup', isSandbox: sandbox };
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

  return { merchantId: merchant.id, created: true, active, tempPassword, email, businessName };
}

// Provision an AGGREGATOR from a self-onboarding submission (#3). Mirrors the SA
// create in routes/aggregators.js. Idempotent: reuses an existing user / returns
// the existing aggregator. Revenue split is left at 0 for SA to configure.
async function provisionAggregator(tx, sub) {
  const email = sub.contactEmail;
  if (!email) throw new Error('No contact email on submission — cannot provision aggregator');
  const companyName = sub.businessName || 'Aggregator';

  let user = await tx.user.findUnique({ where: { email }, include: { aggregator: true } });
  if (user && user.aggregator) return { aggregatorId: user.aggregator.id, reused: true };

  const principal = (sub.principals && sub.principals[0]) || {};
  const contactName = [principal.first_name, principal.surname].filter(Boolean).join(' ') || companyName;
  const nameParts = contactName.trim().split(' ');

  let tempPassword = null;
  if (!user) {
    tempPassword = crypto.randomBytes(6).toString('base64url');
    user = await tx.user.create({ data: {
      email, passwordHash: await bcrypt.hash(tempPassword, 10),
      firstName: nameParts[0] || companyName, lastName: nameParts.slice(1).join(' ') || '(Aggregator)',
      role: 'AGGREGATOR', mustChangePassword: true,
    }});
  }

  const agg = await tx.aggregator.create({ data: {
    userId: user.id, companyName, rcNumber: sub.regNumber || null,
    revenueSplitPct: 0, status: 'active',
  }});

  return { aggregatorId: agg.id, created: true, tempPassword, email, businessName: companyName };
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

    // Compliance gate: a merchant with an unresolved BLOCKING exception (prohibited
    // MCC / BRAM / MATCH / confirmed sanctions) cannot be activated. SA must clear or
    // force-override it in Compliance → Exceptions first.
    const pre = await prisma.onboardingSubmission.findUnique({ where: { reference } });
    if (pre && pre.formType === 'merchant' && pre.merchantId &&
        await compliance.hasOpenBlocking('merchant', pre.merchantId)) {
      return fail(res, 'Cannot approve — unresolved BLOCKING compliance exceptions. Clear or override them in Compliance → Exceptions first.', 'COMPLIANCE_BLOCKED', 409);
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
      // Idempotency keyed on the STATUS transition: only the approver that actually
      // flipped status→'approved' proceeds (concurrent clicks / re-approval = no-op).
      if (claim.count === 0) { outcome = { already: true }; return; }
      // Aggregator self-onboarding (#3): provision an aggregator account on approval.
      if (sub.formType === 'aggregator') {
        outcome = { provAgg: await provisionAggregator(tx, sub) };
        return;
      }
      if (sub.formType !== 'merchant') { outcome = { skipped: true }; return; }

      if (sub.merchantId) {
        // Account was created at application time (inactive). Activate it so the
        // merchant's existing LIVE keys start working — no re-provisioning.
        const m = await tx.merchant.update({
          where: { id: sub.merchantId },
          data: { isActive: true, kycStatus: 'ACTIVE', kycTier: 1 },
          select: { businessEmail: true, businessName: true },
        });
        outcome = { prov: { merchantId: sub.merchantId, activated: true, email: m.businessEmail, businessName: m.businessName } };
      } else {
        // No account yet (e.g. legacy submission) → provision it active now.
        const prov = await provisionMerchant(tx, sub, { active: true });
        await tx.onboardingSubmission.update({ where: { reference }, data: { merchantId: prov.merchantId } });
        outcome = { prov };
      }
    }, { timeout: 20000 });

    if (outcome.notFound) return fail(res, 'Submission not found', 'NOT_FOUND', 404);

    // Best-effort approval email (outside the transaction) — rendered from template.
    if (outcome.prov && outcome.prov.email) {
      const loginUrl = (process.env.APP_URL || '') + '/login.html';
      // Account created at signup → no temp password to send (they already have it);
      // tell them their live keys are now active. Legacy fresh-provision → temp password.
      const slug = outcome.prov.tempPassword ? 'application_approved' : 'application_approved_live';
      const content = await getEmailContent(slug,
        { business: outcome.prov.businessName, email: outcome.prov.email, temp_password: outcome.prov.tempPassword || '', login_url: loginUrl },
        'Your Paylode merchant account is approved',
        `<h2>Approved</h2><p>Your application for <strong>${outcome.prov.businessName}</strong> has been approved — your <strong>live</strong> API keys are now active.</p>` +
          (outcome.prov.tempPassword
            ? `<p>Sign in at <a href="${loginUrl}">the dashboard</a> with <strong>${outcome.prov.email}</strong> and temporary password <strong>${outcome.prov.tempPassword}</strong> — change it on first login.</p>`
            : `<p>Sign in to your <a href="${loginUrl}">dashboard</a> and switch from your test keys to your live keys (Dashboard → API Keys).</p>`) +
          `<p>Any outstanding KYC documents are listed in your dashboard.</p>`);
      sendEmail({ to: outcome.prov.email, subject: content.subject, html: content.html })
        .catch(e => logger.error({ err: e }, 'approval email failed'));
    }

    // Aggregator approval email (#3) — temp password for newly created accounts.
    if (outcome.provAgg && outcome.provAgg.email) {
      const loginUrl = (process.env.APP_URL || '') + '/login.html';
      const pa = outcome.provAgg;
      const content = await getEmailContent('aggregator_welcome',
        { business: pa.businessName, email: pa.email, temp_password: pa.tempPassword || '', login_url: loginUrl },
        'Your Paylode aggregator account is approved',
        `<h2>Approved</h2><p>Your aggregator application for <strong>${pa.businessName}</strong> has been approved.</p>` +
          (pa.tempPassword
            ? `<p>Sign in at <a href="${loginUrl}">the portal</a> with <strong>${pa.email}</strong> and temporary password <strong>${pa.tempPassword}</strong> — change it on first sign-in.</p>`
            : `<p>Sign in to your <a href="${loginUrl}">dashboard</a> to manage your merchants.</p>`) +
          `<p>Your revenue split will be configured by the Paylode team.</p>`);
      sendEmail({ to: pa.email, subject: content.subject, html: content.html })
        .catch(e => logger.error({ err: e }, 'aggregator approval email failed'));
    }

    const fresh = await prisma.onboardingSubmission.findUnique({ where: { reference } });
    const msg = outcome.already ? 'Already approved (no change)'
      : outcome.provAgg ? 'Approved — aggregator provisioned'
      : outcome.skipped ? 'Approved (no account provisioned for this form type)'
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
