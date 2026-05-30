'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const { prisma } = require('../utils/db');
const { ok, fail, created } = require('../utils/helpers');
const { sendEmail } = require('../services/emailService');
const { logger } = require('../utils/logger');

// POST /api/v1/onboarding/submit — public endpoint, no auth required
router.post('/submit', async (req, res, next) => {
  try {
    const { form_type, data, yn_answers, signature, submitted_at } = req.body;

    if (!form_type || !data) return fail(res, 'form_type and data are required');

    // Generate reference
    const reference = 'PLY-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();

    // Extract key fields based on form type
    const institutionData = data.institution || {};
    const contactData     = data.contact     || {};
    const websiteData     = data.website     || {};
    const paymentData     = data.payments    || {};
    const ddData          = data.dd_institution || {};

    const businessName = institutionData.business_name || ddData.dd_institution_name || 'Unknown';
    const email        = contactData.business_email || req.body.email || 'noreply@unknown.com';
    const rcNumber     = institutionData.rc_number   || ddData.dd_reg_number || null;

    // Store in audit log as a pending KYC submission record
    // In production this creates a user + merchant record in pending state
    // For now log and notify compliance

    logger.info({
      reference, form_type, businessName, email, rcNumber,
    }, 'New onboarding submission received');

    // Notify compliance team
    await sendEmail({
      to:      process.env.COMPLIANCE_EMAIL || 'compliance@paylodeservices.com',
      subject: `New ${form_type} onboarding — ${businessName} [${reference}]`,
      html: `
        <h2>New Onboarding Application</h2>
        <p><strong>Reference:</strong> ${reference}</p>
        <p><strong>Type:</strong> ${form_type}</p>
        <p><strong>Business:</strong> ${businessName}</p>
        <p><strong>RC Number:</strong> ${rcNumber || 'Not provided'}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Submitted:</strong> ${submitted_at || new Date().toISOString()}</p>
        <p><strong>Payment Options:</strong> ${Object.entries(paymentData).filter(([k,v])=>k.startsWith('pay_')&&v).map(([k])=>k.replace('pay_','')).join(', ') || 'Not specified'}</p>
        <hr>
        <p>Log in to the compliance dashboard to review: <a href="${process.env.APP_URL}/login.html">Review Application →</a></p>
      `,
    }).catch(e => logger.error({ err: e }, 'Failed to send onboarding notification'));

    // Send confirmation to applicant
    await sendEmail({
      to:      email,
      subject: `Paylode application received — ${reference}`,
      html: `
        <h2>Application Received</h2>
        <p>Dear ${contactData.surname || businessName},</p>
        <p>Thank you for applying to join the Paylode payment gateway. We have received your application and our compliance team will review it within 1-3 business days.</p>
        <p><strong>Your reference number: ${reference}</strong></p>
        <p>Please keep this reference for your records. You can use it when contacting us about your application.</p>
        <p>If you have any questions, please contact us at <a href="mailto:support@paylodeservices.com">support@paylodeservices.com</a></p>
        <p>Best regards,<br>Paylode Services Limited</p>
      `,
    }).catch(e => logger.error({ err: e }, 'Failed to send applicant confirmation'));

    created(res, {
      reference,
      message:    'Application submitted successfully',
      form_type,
      business:   businessName,
      next_steps: 'Our compliance team will review your application within 1-3 business days. You will receive an email notification.',
    }, 'Application submitted');

  } catch (e) { next(e); }
});

// GET /api/v1/onboarding/submissions — compliance officer reviews
router.get('/submissions', async (req, res, next) => {
  // This will be built out when we add the onboarding_submissions table
  // For now return empty
  ok(res, [], 'No submissions table yet — coming in next migration');
});

module.exports = router;
