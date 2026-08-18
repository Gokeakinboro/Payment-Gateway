'use strict';
const nodemailer = require('nodemailer');
const { logger } = require('../utils/logger');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.ethereal.email',
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: parseInt(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendEmail({ to, cc, subject, html, text, attachments }) {
  if (!process.env.SMTP_USER) {
    logger.warn({ to, subject }, 'SMTP not configured — email skipped');
    return { skipped: true };
  }
  try {
    const info = await transporter.sendMail({
      from: `"Paylode Services" <${process.env.EMAIL_FROM || 'product@paylodeservices.com'}>`,
      to, cc, subject, html, text, attachments,
    });
    logger.info({ to, subject, messageId: info.messageId }, 'Email sent');
    return info;
  } catch (e) {
    logger.error({ err: e, to, subject }, 'Email failed');
    throw e;
  }
}

async function renderTemplate(slug, vars) {
  try {
    const { prisma } = require('../utils/db');
    const tpl = await prisma.emailTemplate.findUnique({ where: { slug } });
    if (!tpl || !tpl.isActive) return null;
    let html = tpl.htmlBody, subject = tpl.subject;
    Object.entries(vars || {}).forEach(([k, v]) => {
      const re = new RegExp('\\{\\{' + k + '\\}\\}', 'g');
      html = html.replace(re, v != null ? String(v) : '');
      subject = subject.replace(re, v != null ? String(v) : '');
    });
    return { subject, html };
  } catch(e) { logger.error({ err:e, slug }, 'Template render failed'); return null; }
}

async function getEmailContent(slug, vars, fallbackSubject, fallbackHtml) {
  const tpl = await renderTemplate(slug, vars).catch(() => null);
  return tpl || { subject: fallbackSubject, html: fallbackHtml };
}

function buildPlatformWelcomeEmail({ firstName, email, tempPassword, role, jobTitle }) {
  const PLATFORM_URL = process.env.PLATFORM_URL || 'https://paylodeservices.com';
  const isStaff = role === 'STAFF';
  const loginUrl = isStaff ? `${PLATFORM_URL}/staff.html` : `${PLATFORM_URL}/login.html`;

  const roleLabel = {
    SUPER_ADMIN:        'Super Administrator',
    ADMIN:              'Administrator',
    COMPLIANCE_OFFICER: 'Compliance Officer',
    AUDIT:              'Auditor',
    STAFF:              jobTitle || 'Staff',
    MERCHANT:           'Merchant',
    AGGREGATOR:         'Aggregator',
  }[role] || role;

  let faqItems;
  if (isStaff) {
    faqItems = [
      'Sign in at the link below and change your password immediately.',
      '<strong>Change password</strong> — top-right profile menu → Change Password.',
      '<strong>Dashboard</strong> — shows assigned clients, open leads, and your leaderboard position.',
      '<strong>Leads tab</strong> — add and track prospects; update the pipeline stage as you progress.',
      '<strong>Clients tab</strong> — view assigned merchants, transaction history, and settlement records.',
      'Locked out? Contact your Super Administrator to reset your password.',
    ];
  } else if (['SUPER_ADMIN', 'ADMIN', 'COMPLIANCE_OFFICER', 'AUDIT'].includes(role)) {
    faqItems = [
      'Sign in at the link below and change your password immediately.',
      '<strong>Change password</strong> — top-right profile menu → Change Password.',
      `Your account has been configured as <strong>${roleLabel}</strong> with the appropriate permissions.`,
      '<strong>Dashboard</strong> — platform-wide overview: transactions, settlements, and merchant activity.',
      '<strong>Merchants tab</strong> — search, view, and manage merchants and their KYC status.',
      'Locked out? Contact your Super Administrator to reset your password.',
    ];
  } else {
    faqItems = [
      'Sign in at the link below and change your password immediately.',
      '<strong>Change password</strong> — top-right profile menu → Change Password.',
      '<strong>Dashboard</strong> — shows your transaction history, balances, and settlements.',
      '<strong>Settings</strong> — configure your API keys, webhooks, and settlement preferences.',
      'Need help? Contact your account manager or <a href="mailto:support@paylodeservices.com">support@paylodeservices.com</a>.',
    ];
  }

  const subject = `Welcome to Paylode — your account is ready`;
  const html = `<!DOCTYPE html><html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f5f8fd;font-family:system-ui,-apple-system,Arial,sans-serif;color:#1a2b40}
  .wrap{max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
  .top{background:#0a1a35;padding:28px 32px}
  .top h1{margin:0;font-size:22px;font-weight:900;color:#fff;letter-spacing:-.5px}
  .top h1 span{color:#6dc42a}
  .body{padding:28px 32px}
  h2{font-size:17px;font-weight:700;margin:0 0 6px;color:#0a1a35}
  p{font-size:14px;line-height:1.65;color:#4a5b70;margin:0 0 14px}
  .cred{background:#f5f8fd;border:1px solid #dce5f2;border-radius:8px;padding:14px 18px;margin:18px 0}
  .cred p{margin:0;font-size:13px;color:#4a5b70}
  .cred strong{color:#0a1a35;font-size:15px;display:block;margin-top:4px}
  .btn{display:inline-block;background:#6dc42a;color:#0a1a35;font-weight:800;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;margin:6px 0 20px}
  .faq{background:#f5f8fd;border-radius:8px;padding:18px 20px;margin:18px 0}
  .faq h3{font-size:13px;font-weight:700;color:#0a1a35;margin:0 0 12px;text-transform:uppercase;letter-spacing:.5px}
  .faq ol{margin:0;padding-left:18px}
  .faq li{font-size:13px;color:#4a5b70;line-height:1.65;margin-bottom:8px}
  .faq li strong{color:#0a1a35}
  .footer{background:#f5f8fd;padding:16px 32px;border-top:1px solid #dce5f2}
  .footer p{margin:0;font-size:12px;color:#7a8fa8;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>Pay<span>lode</span></h1>
  </div>
  <div class="body">
    <h2>Welcome, ${firstName}!</h2>
    <p>Your Paylode account has been created as <strong>${roleLabel}</strong>. Use the credentials below to sign in for the first time.</p>
    <div class="cred">
      <p>Email address<strong>${email}</strong></p>
      <p style="margin-top:10px">Temporary password<strong style="font-family:monospace;font-size:16px;letter-spacing:1px">${tempPassword}</strong></p>
    </div>
    <a href="${loginUrl}" class="btn">Sign in to Paylode →</a>
    <div class="faq">
      <h3>Quick start</h3>
      <ol>
        ${faqItems.map(item => `<li>${item}</li>`).join('\n        ')}
      </ol>
    </div>
    <p style="font-size:13px;color:#7a8fa8">This email contains your temporary login credentials. Do not share it. You will be asked to set a permanent password when you first sign in.</p>
  </div>
  <div class="footer">
    <p>Paylode Services Limited · payment infrastructure for Nigeria<br>
    Questions? Contact <a href="mailto:support@paylodeservices.com" style="color:#6dc42a">support@paylodeservices.com</a></p>
  </div>
</div>
</body></html>`.trim();

  return { subject, html };
}

module.exports = { sendEmail, renderTemplate, getEmailContent, buildPlatformWelcomeEmail };