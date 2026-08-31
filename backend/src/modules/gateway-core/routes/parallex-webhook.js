'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Parallex Bank webhooks.
//    POST /api/v1/webhooks/parallex/inflow  — VA pay-in notification
//    POST /api/v1/webhooks/parallex/payout  — outbound NIP transfer result
//    POST /api/v1/webhooks/parallex/        — catch-all (treated as inflow)
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');
const { finalizePayinSuccess } = require('../services/payinFinalize');
const { applyPayoutResult } = require('../services/payoutSettle');
const parallex = require('../services/parallexService');
const tpt = require('../services/parallexTransferService');

const SUCCESS_STATES = new Set(['SUCCESS', 'SUCCESSFUL', 'COMPLETED']);

// Map Parallex bank name strings → NIP bank codes for auto-reversal
const BANK_NAME_TO_CODE = {
  'OPAY DIGITAL SERVICES LIMITED': '999992', 'OPAY DIGITAL SERVICES': '999992', 'OPAY': '999992',
  'PALMPAY': '999991', 'PALMPAY FINANCE': '999991',
  'KUDA MICROFINANCE BANK': '50211', 'KUDA BANK': '50211', 'KUDA': '50211',
  'MONIEPOINT MICROFINANCE BANK': '50515', 'MONIEPOINT MFB': '50515', 'MONIEPOINT': '50515',
  'ACCESS BANK PLC': '044', 'ACCESS BANK': '044',
  'ZENITH BANK PLC': '057', 'ZENITH BANK': '057',
  'GUARANTY TRUST BANK PLC': '058', 'GUARANTY TRUST BANK': '058', 'GTBANK': '058',
  'UNITED BANK FOR AFRICA PLC': '033', 'UNITED BANK FOR AFRICA': '033', 'UBA': '033',
  'FIRST BANK OF NIGERIA PLC': '011', 'FIRST BANK OF NIGERIA': '011', 'FIRST BANK': '011',
  'FIDELITY BANK PLC': '070', 'FIDELITY BANK': '070',
  'UNION BANK OF NIGERIA PLC': '032', 'UNION BANK': '032',
  'STERLING BANK PLC': '232', 'STERLING BANK': '232',
  'WEMA BANK PLC': '035', 'WEMA BANK': '035',
  'FIRST CITY MONUMENT BANK': '214', 'FCMB': '214',
  'STANBIC IBTC BANK PLC': '221', 'STANBIC IBTC BANK': '221',
  'ECOBANK NIGERIA PLC': '050', 'ECOBANK': '050',
  'PROVIDUS BANK': '101', 'PARALLEX BANK': '101',
  'FAIRMONEY MICROFINANCE BANK': '51318', 'FAIRMONEY': '51318',
  'CARBON': '565', 'VFD MICROFINANCE BANK': '566', 'VFD': '566',
  'TITAN TRUST BANK': '102', 'LOTUS BANK': '303', 'JAIZ BANK': '301',
  'POLARIS BANK': '076', 'HERITAGE BANK': '030', 'KEYSTONE BANK': '082',
};

async function autoReverseParallexInflow(b, paidKobo) {
  const bankName    = String(b.originatingBankName || '').toUpperCase().trim();
  const bankCode    = BANK_NAME_TO_CODE[bankName] || null;
  const accountNo   = b.originatingAccountNumber || null;
  const accountName = b.originatingAccountName   || '';
  const orderId     = 'REV-' + (b.sessionId || b.referenceID || Date.now());

  if (!accountNo) {
    logger.warn({ bankName }, 'Parallex inflow reversal skipped — no originating account number');
    return;
  }
  if (!bankCode) {
    logger.warn({ bankName, accountNo, orderId }, 'Parallex inflow reversal skipped — unknown bank, SA intervention needed');
    return;
  }

  logger.info({ bankCode, accountNo, accountName, paidKobo, orderId }, 'Parallex inflow mismatch — auto-reversing');
  try {
    const result = await tpt.sendPayout({
      orderId,
      account_number: accountNo,
      account_name:   accountName,
      bank_code:      bankCode,
      amount:         paidKobo,
      narration:      'Payment reversal — amount mismatch',
    });
    if (result.ok || result.status === 'SENT') {
      logger.info({ orderId, result }, 'Parallex inflow reversal sent');
    } else {
      logger.warn({ orderId, result }, 'Parallex inflow reversal non-success — SA review needed');
    }
  } catch (err) {
    logger.error({ err, orderId }, 'Parallex inflow reversal threw — SA review needed');
  }
}

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
    if (r && r.amountMismatch) {
      logger.warn({ reference: txnReference, expected: r.expected, paid: r.paid }, 'Parallex inflow AMOUNT MISMATCH — reversing');
      autoReverseParallexInflow(b, r.paid).catch(err =>
        logger.error({ err, vaAccount, nipReference }, 'Parallex inflow: auto-reversal error')
      );
    }

    return res.status(200).json({ responseCode: '00', responseDescription: 'Request Successful' });
  } catch (e) {
    logger.error({ err: e, nipReference, vaAccount }, 'Parallex inflow processing failed');
    return res.status(500).json({ responseCode: '99', responseDescription: 'Error' });
  }
}

// ── Parallex payout result webhook ───────────────────────────────────────────
// Parallex notifies us when an outbound NIP transfer settles, fails, or reverses.
// Expected payload fields (Parallex TPT callback):
//   transactionReference — our orderId (what we sent as transactionReference)
//   responseCode         — '00' = success; FAIL_CODES = failed; else pending
//   responseMessage      — human-readable description
//   orderNo              — Parallex's internal session / order reference
//   amount               — naira string
//   secret               — shared webhook secret (same body-field pattern as inflow)
async function handlePayout(req, res) {
  const b = req.body || {};
  const orderId  = b.transactionReference || b.TransactionReference || null;
  const orderNo  = b.orderNo || b.OrderNo || b.sessionId || null;
  const code     = String(b.responseCode || b.ResponseCode || '').trim();
  const msg      = b.responseMessage || b.ResponseMessage || b.description || '';
  const expected = process.env.PARALLEX_PAYOUT_WEBHOOK_SECRET || process.env.PARALLEX_VA_WEBHOOK_SECRET || '';

  logger.info({ orderId, orderNo, code, msg, body: b }, 'Parallex payout webhook');

  if (expected) {
    if (!parallex.verifyInflow(b, expected)) {
      logger.warn({ orderId }, 'Parallex payout webhook: bad secret — rejected');
      return res.status(401).json({ responseCode: '34', responseDescription: 'Authentication Failed.' });
    }
  } else {
    logger.warn({ orderId }, 'Parallex payout webhook: no secret set — SCAFFOLD mode');
  }

  if (!orderId) {
    logger.warn({ body: b }, 'Parallex payout webhook: missing transactionReference');
    return res.status(200).json({ responseCode: '00', responseDescription: 'Request Successful' });
  }

  // Map Parallex response code → orderStatus used by applyPayoutResult
  const FAIL_CODES    = new Set(['05', '06', '12', '16', '51', '57', '94', '95', '96', '97']);
  const PENDING_CODES = new Set(['09', '25', '26', '99']);
  let orderStatus;
  if (code === '00')               orderStatus = '2';   // success
  else if (FAIL_CODES.has(code))   orderStatus = 'X';   // failed (anything not '2'/'0'/'1')
  else if (PENDING_CODES.has(code)) orderStatus = '1';  // still in-flight
  else if (!code)                  orderStatus = '1';   // no code yet
  else                             orderStatus = 'X';   // treat unknown as failed

  try {
    const result = await applyPayoutResult({
      orderId,
      orderNo,
      orderStatus,
      errorMsg: msg,
      source: 'parallex_payout_webhook',
    });
    if (!result) logger.warn({ orderId }, 'Parallex payout webhook: leg not found or already settled');
    return res.status(200).json({ responseCode: '00', responseDescription: 'Request Successful' });
  } catch (e) {
    logger.error({ err: e, orderId }, 'Parallex payout webhook: applyPayoutResult threw');
    return res.status(500).json({ responseCode: '99', responseDescription: 'Error' });
  }
}

router.post('/inflow', handleInflow);
router.post('/payout', handlePayout);
router.post('/', handleInflow);

module.exports = router;
