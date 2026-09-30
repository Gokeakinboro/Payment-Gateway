'use strict';
// Notifies SUPER_ADMIN/ADMIN staff by email whenever a maker-checker item
// (wallet credit/move request, or a recommended refund) is waiting on them.
// Fire-and-forget: never throws, never blocks the request that created the
// pending item — a failed email must not undo or delay the underlying record.
const { prisma } = require('../utils/db');
const { sendEmail } = require('./emailService');
const { logger } = require('../utils/logger');

async function notifyApprovers({ subject, summaryHtml, actionUrl }) {
  try {
    const approvers = await prisma.user.findMany({
      where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] }, isActive: true },
      select: { email: true },
    });
    const to = approvers.map(a => a.email).filter(Boolean);
    if (!to.length) return;
    const html = `
      <p>${summaryHtml}</p>
      ${actionUrl ? `<p><a href="${actionUrl}">Review and decide</a></p>` : ''}
      <p style="color:#888;font-size:12px">Automated notice from Paylode Services — you are receiving this because you can approve pending wallet/refund actions.</p>`;
    await sendEmail({ to, subject, html });
  } catch (err) {
    logger.error({ err }, 'notifyApprovers failed (non-blocking)');
  }
}

module.exports = { notifyApprovers };
