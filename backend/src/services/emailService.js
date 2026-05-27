'use strict';
const nodemailer = require('nodemailer');
const { logger } = require('../utils/logger');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.ethereal.email',
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: parseInt(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail({ to, subject, html, text }) {
  if (!process.env.SMTP_USER) {
    logger.warn({ to, subject }, 'SMTP not configured — email skipped');
    return { skipped: true };
  }
  try {
    const info = await transporter.sendMail({
      from:    `"Paylode Services" <${process.env.EMAIL_FROM || 'noreply@paylodeservices.com'}>`,
      to, subject, html, text,
    });
    logger.info({ to, subject, messageId: info.messageId }, 'Email sent');
    return info;
  } catch (e) {
    logger.error({ err: e, to, subject }, 'Email failed');
    throw e;
  }
}

module.exports = { sendEmail };
