'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Parallex Bank VA INFLOW webhook.
//    POST /api/v1/webhooks/parallex/inflow  (and the base path, as a catch-all)
//  Parallex sends the NIP session ID as `referenceID` (not our mint reference),
//  so we fall back to matching by VA account number stored in transaction metadata.
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');
const { finalizePayinSuccess } = require('../services/payinFinalize');
const parallex = require('../services/parallexService');

const SUCCESS_STATES = new Set(['SUCCESS', 'SUCCESSFUL', 'COMPLETED']);

// Possible field names Parallex uses for the credited VA number
function extractVaAccount(b) {
  return b.destinationAccountNumber || b.beneficiaryAccountNumber ||
         b.beneficiaryAccount       || b.virtualAccountNumber     ||
         b.accountNumber            || null;
}

async function handleInflow(req, res) {
  const b = req.body || {};
  const nipReference = b.referenceID || b.referenceId || null;
  const vaAccount    = extractVaAccount(b);
  const expected     = process.env.PARALLEX_VA_WEBHOOK_SECRET || '';

  if (expected) {
    if (!parallex.verifyInflow(b, expected)) {
      logger.warn({ nipReference }, 'Parallex inflow: bad secret — rejected');
      return res.status(401).json({ responseCode: '34', responseDescription: 'Authentication Failed.' });
    }
  } else {
    logger.warn({ nipReference }, 'Parallex inflow: no PARALLEX_VA_WEBHOOK_SECRET set — SCAFFOLD mode');
  }

  const status = String(b.status || '').toUpperCase();
  logger.info({ nipReference, vaAccount, amount: b.amount, status, sessionId: b.sessionId, fullBody: b }, 'Parallex VA inflow');

  try {
    if (!SUCCESS_STATES.has(status)) {
      return res.status(200).json({ responseCode: '00', responseDescription: 'Request Successful' });
    }

    // Step 1: try direct reference match (in case Parallex echoes our mint referenceId)
    let txnReference = null;
    if (nipReference) {
      const byRef = await prisma.transaction.findUnique({
        where:  { reference: nipReference },
        select: { reference: true, status: true },
      });
      if (byRef) txnReference = byRef.reference;
    }

    // Step 2: fall back to VA account number stored in transaction metadata.
    // Parallex sends the NIP session ID as referenceID, not our mint referenceId.
    if (!txnReference && vaAccount) {
      const byVa = await prisma.transaction.findFirst({
        where: {
          status:   'PENDING',
          metadata: { path: ['parallex_va_no'], equals: vaAccount },
        },
        select:  { reference: true },
        orderBy: { createdAt: 'desc' },
      });
      if (byVa) {
        txnReference = byVa.reference;
        logger.info({ vaAccount, txnReference }, 'Parallex inflow: matched via VA account number');
      }
    }

    if (!txnReference) {
      logger.warn({ nipReference, vaAccount }, 'Parallex inflow: no matching PENDING transaction — ACKing without credit');
      return res.status(200).json({ responseCode: '00', responseDescription: 'Request Successful' });
    }

    const paidKobo = Number(parallex.koboFromNaira(b.amount));
    const r = await finalizePayinSuccess({
      reference: txnReference,
      channel:   'BANK_TRANSFER',
      processor: 'parallex_va',
      extraMeta: {
        method:                       'parallex_va',
        parallex_session_id:          b.sessionId || null,
        parallex_nip_reference:       nipReference,
        parallex_va_account:          vaAccount,
        parallex_originating_account: b.originatingAccountNumber || null,
        parallex_originating_name:    b.originatingAccountName   || null,
        parallex_originating_bank:    b.originatingBankName      || null,
      },
      paidAmount: Number.isFinite(paidKobo) ? paidKobo : null,
    });
    if (r && r.amountMismatch)
      logger.warn({ reference: txnReference, expected: r.expected, paid: r.paid }, 'Parallex inflow AMOUNT MISMATCH — not credited');

    return res.status(200).json({ responseCode: '00', responseDescription: 'Request Successful' });
  } catch (e) {
    logger.error({ err: e, nipReference, vaAccount }, 'Parallex inflow processing failed');
    return res.status(500).json({ responseCode: '99', responseDescription: 'Error' });
  }
}

router.post('/inflow', handleInflow);
router.post('/', handleInflow);

module.exports = router;
