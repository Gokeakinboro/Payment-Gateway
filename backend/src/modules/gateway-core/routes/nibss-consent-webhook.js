'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  NIBSS Consent Hub callback webhook.
//    POST /api/v1/webhooks/nibss/consent
//
//  NIBSS POSTs here after a customer authenticates and approves BVN consent.
//  The body contains:
//    { sessionId, retrievalToken, status: "Approved"|"Denied", bvn }
//
//  We store the retrievalToken against the sessionId so the KYC flow can pick
//  it up and pass it to nibssFasService.verifyBvn().
//
//  Storage: prisma.nibssConsentToken (table: nibss_consent_tokens).
//  The KYC flow queries by sessionId and marks used after FAS call.
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');

// Always acknowledge 200 immediately — NIBSS may not retry on non-2xx.
router.post('/', async (req, res) => {
  res.json({ status: 'received' });

  const body = req.body || {};
  const { sessionId, retrievalToken, status, bvn } = body;

  logger.info({ sessionId, status, bvnMasked: bvn ? `${String(bvn).slice(0, 4)}****` : null }, 'NIBSS consent callback received');

  if (!sessionId || !retrievalToken) {
    logger.warn({ body }, 'NIBSS consent callback missing sessionId or retrievalToken — ignored');
    return;
  }

  try {
    await prisma.$executeRaw`
      INSERT INTO nibss_consent_tokens
        (session_id, retrieval_token, consent_status, bvn_masked, received_at)
      VALUES (
        ${sessionId},
        ${retrievalToken},
        ${status || 'Unknown'},
        ${bvn ? String(bvn).slice(0, 4) + '****' + String(bvn).slice(-2) : null},
        NOW()
      )
      ON CONFLICT (session_id) DO UPDATE
        SET retrieval_token = EXCLUDED.retrieval_token,
            consent_status  = EXCLUDED.consent_status,
            received_at     = NOW()
    `;
    logger.info({ sessionId }, 'NIBSS consent token stored');
  } catch (e) {
    logger.error({ err: e.message, sessionId }, 'Failed to store NIBSS consent token');
  }
});

module.exports = router;
