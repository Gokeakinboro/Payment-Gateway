'use strict';
const router = require('express').Router();
const { ok, fail } = require('../utils/helpers');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../services/emailService');
const { logAudit } = require('../services/auditService');
const { logger } = require('../utils/logger');

// ── POST /api/v1/support/report — staff reports a dashboard glitch / issue ─────
// Any authenticated staff member (admin / compliance / audit / SA) can submit a
// technical issue from their dashboard. Emails the ops inbox; best-effort.
router.post('/report', requireAuth, async (req, res, next) => {
  try {
    const { category, message, page } = req.body || {};
    if (!message || !String(message).trim()) return fail(res, 'Please describe the issue');

    const u = req.user;
    const who = `${u.firstName || ''} ${u.lastName || ''}`.trim() + ` <${u.email}> (${u.role})`;
    const cat = category || 'General';
    const html =
      `<h3>Staff issue report — ${cat}</h3>` +
      `<p><strong>From:</strong> ${who}</p>` +
      `<p><strong>Page:</strong> ${page || '—'}</p>` +
      `<p><strong>Message:</strong></p><p>${String(message).replace(/</g, '&lt;')}</p>` +
      `<p style="color:#888;font-size:12px">Submitted ${new Date().toISOString()}</p>`;

    sendEmail({
      to: process.env.OPS_EMAIL || 'product@paylodeservices.com',
      subject: `[Staff Issue] ${cat} — ${u.email}`,
      html,
    }).catch((e) => logger.error({ err: e }, 'support report email failed'));

    // Best-effort audit trail (email is the source of truth).
    logAudit(u.id, 'STAFF_ISSUE_REPORT', 'support', u.id, null,
      { category: cat, page: page || null, message: String(message).slice(0, 2000) }, null, req.ip)
      .catch(() => {});

    ok(res, null, 'Thanks — your report has been sent to the Paylode technical team.');
  } catch (e) { next(e); }
});

module.exports = router;
