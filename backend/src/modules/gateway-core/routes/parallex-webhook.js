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

// Map Parallex originatingBankName strings → Parallex institutionCode for auto-reversal.
// ⚠️ These are Parallex's own institution codes from getBanks(), NOT CBN sort codes.
// Verified 2026-09-02 via live getBanks() call (766 banks total).
const BANK_NAME_TO_CODE = {
  // Fintechs — verified live
  'OPAY DIGITAL SERVICES LIMITED': '100004', 'OPAY DIGITAL SERVICES': '100004', 'OPAY': '100004',
  'PALMPAY': '100033', 'PALMPAY FINANCE': '100033',
  'KUDA MICROFINANCE BANK': '090267', 'KUDA BANK': '090267', 'KUDA': '090267',
  'MONIEPOINT MICROFINANCE BANK': '090405', 'Moniepoint Microfinance Bank': '090405', 'MONIEPOINT MFB': '090405', 'MONIEPOINT': '090405',
  'FAIRMONEY MICROFINANCE BANK': '090551', 'FAIRMONEY': '090551',
  'CARBON MFB': '100026', 'CARBON': '100026',
  'VFD MFB': '090110', 'VFD MICROFINANCE BANK': '090110', 'VFD': '090110',
  '9 payment service Bank': '120001', '9PSB': '120001',
  'FLUTTERWAVE MFB': '090567',
  'PAYSTACK MFB': '090986',
  'FIRSTMONIE WALLET': '100014',
  // Commercial banks
  'FIRST BANK OF NIGERIA': '000016', 'FIRST BANK OF NIGERIA PLC': '000016', 'FIRST BANK': '000016',
  'ZENITH BANK PLC': '000015', 'ZENITH BANK': '000015',
  'GTBANK PLC': '000013', 'GUARANTY TRUST BANK PLC': '000013', 'GUARANTY TRUST BANK': '000013', 'GTBANK': '000013',
  'UNITED BANK FOR AFRICA': '000004', 'UNITED BANK FOR AFRICA PLC': '000004', 'UBA': '000004',
  'ACCESS BANK': '000014', 'ACCESS BANK PLC': '000014',
  'FIDELITY BANK': '000007', 'FIDELITY BANK PLC': '000007',
  'UNION BANK': '000018', 'UNION BANK OF NIGERIA PLC': '000018',
  'FCMB': '000003', 'FIRST CITY MONUMENT BANK': '000003',
  'ECOBANK': '000010', 'ECOBANK NIGERIA PLC': '000010',
  'STANBICIBTC BANK': '000012', 'STANBIC IBTC BANK PLC': '000012', 'STANBIC IBTC BANK': '000012',
  'STERLING BANK': '000001', 'STERLING BANK PLC': '000001',
  'WEMA BANK': '000017', 'WEMA BANK PLC': '000017',
  'KEYSTONE BANK': '000002',
  'POLARIS BANK': '000008',
  'PROVIDUS BANK': '000023',
  'PARALLEX BANK': '000030',
  'JAIZ BANK': '000006',
  'TITAN TRUST BANK': '000025',
  'Lotus Bank': '000029', 'LOTUS BANK': '000029',
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
  const reversalCtx = { orderId, bankCode, accountNo, accountName, paidKobo, bankName };
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
      logger.warn({ ...reversalCtx, result }, 'Parallex inflow reversal non-success — SA must reverse manually');
    }
  } catch (err) {
    logger.error({ err: err.message, ...reversalCtx }, 'Parallex inflow reversal failed — SA must reverse manually');
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
      // Check if this inflow is for a payout pre-funding VA (table may not exist yet).
      let fundingVa = null;
      try {
        fundingVa = nipReference
          ? await prisma.payoutFundingVa.findUnique({ where: { referenceId: nipReference } })
          : null;
        if (!fundingVa && vaAccount) {
          fundingVa = await prisma.payoutFundingVa.findFirst({
            where: { vaAccountNumber: vaAccount, status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
          });
        }
      } catch (_) { /* table not yet migrated — skip */ }

      if (fundingVa && fundingVa.status === 'PENDING') {
        const paidKobo = BigInt(parallex.koboFromNaira(b.amount));
        await prisma.$transaction(async (tx) => {
          // Upsert the merchant_wallets row for this rail.
          let wallet = await tx.merchantWallet.findFirst({
            where: { merchantId: fundingVa.merchantId, railId: fundingVa.railId },
          });
          const before = wallet ? wallet.balance : 0n;
          const after  = before + paidKobo;
          if (!wallet) {
            await tx.merchantWallet.create({
              data: { merchantId: fundingVa.merchantId, railId: fundingVa.railId, balance: after, lastFundedAt: new Date() },
            });
          } else {
            await tx.merchantWallet.update({
              where: { id: wallet.id },
              data:  { balance: after, lastFundedAt: new Date() },
            });
          }
          // Ledger entry.
          await tx.walletLedger.create({
            data: {
              merchantId:    fundingVa.merchantId,
              railId:        fundingVa.railId,
              entryType:     'CREDIT',
              amount:        paidKobo,
              balanceBefore: before,
              balanceAfter:  after,
              reference:     fundingVa.referenceId,
              description:   `Payout wallet funding via VA (Parallex) — ${b.originatingAccountName || 'transfer'}`,
            },
          });
          // Mark the funding VA completed.
          await tx.payoutFundingVa.update({
            where: { id: fundingVa.id },
            data:  { status: 'COMPLETED', completedAt: new Date(), paidKobo },
          });
        });
        logger.info({ merchantId: fundingVa.merchantId, paidKobo: paidKobo.toString(), referenceId: fundingVa.referenceId }, 'Payout funding VA credited');
        return res.status(200).json({ responseCode: '00', responseDescription: 'Request Successful' });
      }

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
