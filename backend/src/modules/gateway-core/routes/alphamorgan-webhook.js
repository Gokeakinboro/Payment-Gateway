'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Alpha Morgan Bank inbound callback — VA inflow notification.
//
//  POST /api/v1/webhooks/alphamorgan/inflow
//    Alpha Morgan calls our `callbackUrl` (set at RegisterMerchant time) when
//    a customer pays into one of our virtual accounts. We credit the merchant.
//
//  ⚠️ SCAFFOLD — the API spec document did not include a webhook payload
//  sample or expected response shape, only the sentence "for the notification
//  when customers receive inflow". Field names below (accountNo, amount,
//  reference, sender*) are best-guess, matching the naming style used
//  elsewhere in the spec (CreateAccount/GetAccountDetail use accountNo,
//  customerReference). CONFIRM the real payload with Alpha Morgan before
//  going live — this route currently accepts a superset of likely field
//  name variants defensively, but that is not a substitute for the real spec.
//
//  Auth: static Bearer token, if Alpha Morgan supports one (TODO: confirm —
//  not documented). Falls back to accept-and-warn like the Wema scaffold did
//  before its token was configured.
// ─────────────────────────────────────────────────────────────────────────────
const router  = require('express').Router();
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');

const INFLOW_TOKEN = process.env.ALPHAMORGAN_VA_WEBHOOK_TOKEN || '';

function checkBearer(req, expected) {
  if (!expected) {
    logger.warn({ path: req.path }, 'Alpha Morgan webhook: Bearer token not configured (scaffold mode)');
    return true;
  }
  const auth = req.headers['authorization'] || '';
  return auth.replace(/^Bearer\s+/i, '').trim() === expected;
}

router.post('/inflow', async (req, res) => {
  if (!checkBearer(req, INFLOW_TOKEN)) {
    logger.warn({ ip: req.ip }, 'Alpha Morgan inflow webhook: bad Bearer token');
    return res.status(401).json({ responseCode: '07', responseMessage: 'Unauthorized' });
  }

  const b = req.body || {};
  // TODO: confirm exact field names — best guess pending real payload sample.
  const accountNo  = b.accountNo || b.accountNumber || b.craccount;
  const amount     = b.amount;
  const reference  = b.reference || b.sessionId || b.transactionReference;
  const senderName = b.senderName || b.originatorName || b.payerName;

  logger.info({ accountNo, amount, reference, senderName }, 'Alpha Morgan VA inflow notification (scaffold)');

  if (!accountNo || !reference) {
    return res.status(400).json({ responseCode: '07', responseMessage: 'Missing fields' });
  }

  // Deduplicate on reference
  const dup = await prisma.$queryRaw`
    SELECT reference FROM transactions WHERE reference = ${'ALPHAMORGAN-' + reference} LIMIT 1`;
  if (dup.length) {
    logger.info({ reference }, 'Alpha Morgan inflow: duplicate notification, returning 00');
    return res.json({ responseCode: '00', responseMessage: 'Successful' });
  }

  try {
    const rows = await prisma.$queryRaw`
      SELECT mva.merchant_id, mva.metadata, m.name AS merchant_name, m.webhook_url AS "webhookUrl"
      FROM merchant_virtual_accounts mva
      JOIN merchants m ON m.id = mva.merchant_id
      WHERE mva.va_number = ${accountNo}
        AND mva.provider = 'alphamorgan'
        AND mva.status = 'active'
      LIMIT 1`;

    if (!rows.length) {
      logger.warn({ accountNo, reference }, 'Alpha Morgan inflow: no active VA found for account');
      return res.json({ responseCode: '00', responseMessage: 'Successful' });
    }

    // TODO: once payload/response spec is confirmed, wire this up the same way
    // wema-webhook.js's transaction-notify does — record the transaction,
    // compute fees via merchantRateConfig/platformRateConfig, and
    // dispatchWebhook(merchantId, 'payment.success', ...) to the merchant.
    logger.warn({ accountNo, reference, amount }, 'Alpha Morgan inflow: VA matched but crediting logic not yet wired (scaffold)');

    return res.json({ responseCode: '00', responseMessage: 'Successful' });
  } catch (e) {
    logger.error({ err: e, accountNo, reference }, 'Alpha Morgan inflow webhook: error');
    return res.status(500).json({ responseCode: '99', responseMessage: 'Service error' });
  }
});

module.exports = router;
