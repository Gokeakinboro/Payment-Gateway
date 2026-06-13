'use strict';
const nodemailer = require('nodemailer');
const { logger } = require('../utils/logger');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.ethereal.email',
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: parseInt(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendEmail({ to, subject, html, text, attachments }) {
  if (!process.env.SMTP_USER) {
    logger.warn({ to, subject }, 'SMTP not configured — email skipped');
    return { skipped: true };
  }
  try {
    const info = await transporter.sendMail({
      from: `"Paylode Services" <${process.env.EMAIL_FROM || 'product@paylodeservices.com'}>`,
      to, subject, html, text, attachments,
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

module.exports = { sendEmail, renderTemplate, getEmailContent };