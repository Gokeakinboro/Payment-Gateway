'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Parallex Bank VA INFLOW webhook.
//    POST /api/v1/webhooks/parallex/inflow  (and the base path, as a catch-all)
//  When a customer pays into a Parallex virtual account, Parallex POSTs the inflow
//  here. We verify the shared `secret` (constant-time) against the secret Parallex
//  returned from AddWebHookURL (env PARALLEX_VA_WEBHOOK_SECRET), then finalize the
//  collection — keyed by referenceID = our txn reference (set at VA mint). Uses the
//  SAME finalizePayinSuccess as PalmPay, so pay-in accounting can't diverge.
//  Parallex amounts are NAIRA strings → converted to kobo for the exact-amount check.
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');
const { finalizePayinSuccess } = require('../services/payinFinalize');
const parallex = require('../services/parallexService');

const SUCCESS_STATES = new Set(['SUCCESS', 'SUCCESSFUL', 'COMPLETED']);

async function handleInflow(req, res) {
  const b = req.body || {};
  const reference = b.referenceID || b.referenceId || null;
  const expected = process.env.PARALLEX_VA_WEBHOOK_SECRET || '';

  // Verify the shared secret. If we haven't stored one yet (webhook not registered),
  // reject rather than trust an unverified inflow.
  if (!expected || !parallex.verifyInflow(b, expected)) {
    logger.warn({ referenceID: reference }, 'Parallex inflow: bad or missing secret — rejected');
    return res.status(401).json({ responseCode: '34', responseDescription: 'Authentication Failed.' });
  }

  const status = String(b.status || '').toUpperCase();
  logger.info({ referenceID: reference, amount: b.amount, status, sessionId: b.sessionId }, 'Parallex VA inflow');
  try {
    if (reference && SUCCESS_STATES.has(status)) {
      const paidKobo = Number(parallex.koboFromNaira(b.amount));   // "1500.75" → 150075
      const r = await finalizePayinSuccess({
        reference, channel: 'BANK_TRANSFER', processor: 'parallex_va',
        extraMeta: {
          method: 'parallex_va',
          parallex_session_id: b.sessionId || null,
          parallex_originating_account: b.originatingAccountNumber || null,
          parallex_originating_name: b.originatingAccountName || null,
          parallex_originating_bank: b.originatingBankName || null,
        },
        paidAmount: Number.isFinite(paidKobo) ? paidKobo : null,   // enforce exact amount
      });
      if (r && r.amountMismatch)
        logger.warn({ reference, expected: r.expected, paid: r.paid }, 'Parallex inflow AMOUNT MISMATCH — not credited');
    }
    // ACK — Parallex expects a success response (else it may retry).
    return res.status(200).json({ responseCode: '00', responseDescription: 'Request Successful' });
  } catch (e) {
    logger.error({ err: e, reference }, 'Parallex inflow processing failed');
    return res.status(500).json({ responseCode: '99', responseDescription: 'Error' });
  }
}

router.post('/inflow', handleInflow);
router.post('/', handleInflow);   // base path — in case Parallex posts to the root

module.exports = router;
