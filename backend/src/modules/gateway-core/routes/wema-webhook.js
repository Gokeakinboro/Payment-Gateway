'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Wema Bank inbound callbacks — three routes:
//
//  POST /api/v1/webhooks/wema/account-lookup
//    Wema calls us to validate a virtual account before crediting it.
//    Response: { accountname, status, status_desc, bvn/nin }
//
//  POST /api/v1/webhooks/wema/transaction-notify
//    Wema notifies us of a successful VA inflow. We credit the merchant.
//    Response: { transactionreference, status: "00", status_desc: "Okay" }
//    Deduplicate on sessionid (Wema retries until we return "00").
//
//  POST /api/v1/webhooks/wema/payout
//    Wema notifies us of a payout status (Stage: DebitCredit / NIPTransfer /
//    REVERSAL). We settle the leg only on FINAL status — SUCCESSFUL or a
//    REVERSAL/SUCCESS (= failed + refund). Intermediate FAILED callbacks are
//    ignored; REVERSAL/SUCCESS triggers the refund.
//
//  Auth on all routes: static Bearer token Wema sends in Authorization header.
//  We set WEMA_VA_BEARER_TOKEN (VA routes) and WEMA_PAYOUT_CALLBACK_TOKEN
//  (payout callback) in .env and validate before processing.
// ─────────────────────────────────────────────────────────────────────────────
const router  = require('express').Router();
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');
const { applyPayoutResult } = require('../services/payoutSettle');
const { dispatchWebhook }   = require('../../../services/webhookService');
const { finalizePayinSuccess } = require('../services/payinFinalize');

// Static Bearer tokens Wema sends on inbound calls — configure in .env
const VA_TOKEN     = process.env.WEMA_VA_BEARER_TOKEN        || '';
const PAYOUT_TOKEN = process.env.WEMA_PAYOUT_CALLBACK_TOKEN  || '';

// Responsible-party BVN/NIN for dynamic/anonymous VAs (regulatory fallback).
// Set to Paylode's own BVN/NIN in .env.
const PAYLODE_BVN  = process.env.WEMA_PAYLODE_BVN            || '';
const PAYLODE_NIN  = process.env.WEMA_PAYLODE_NIN            || '';

// ── Auth helpers ─────────────────────────────────────────────────────────────
function checkBearer(req, expected) {
  if (!expected) {
    // Scaffold mode — token not set yet, accept and warn
    logger.warn({ path: req.path }, 'Wema webhook: Bearer token not configured (scaffold mode)');
    return true;
  }
  const auth = req.headers['authorization'] || '';
  return auth.replace(/^Bearer\s+/i, '').trim() === expected;
}

// ── 1. Account Lookup ────────────────────────────────────────────────────────
// Wema calls this before crediting any VA to validate account + get name.
// Returns 00 (active), 07 (invalid/inactive).
// Account name format: "Paylode/[Customer or Merchant Name]"
router.post('/account-lookup', async (req, res) => {
  if (!checkBearer(req, VA_TOKEN)) {
    logger.warn({ ip: req.ip }, 'Wema account-lookup: bad Bearer token');
    return res.status(401).json({ accountname: '', status: '07', status_desc: 'Unauthorized' });
  }

  const { accountnumber } = req.body || {};
  logger.info({ accountnumber }, 'Wema account-lookup');

  if (!accountnumber) {
    return res.json({ accountname: '', status: '07', status_desc: 'Invalid Account', bvn: PAYLODE_BVN || undefined, nin: PAYLODE_NIN || undefined });
  }

  try {
    // Look up VA in our DB (merchant_virtual_accounts table)
    const rows = await prisma.$queryRaw`
      SELECT
        mva.merchant_id,
        mva.account_name,
        mva.status       AS va_status,
        mva.metadata,
        m.name           AS merchant_name,
        m.bvn,
        m.nin
      FROM merchant_virtual_accounts mva
      JOIN merchants m ON m.id = mva.merchant_id
      WHERE mva.va_number = ${accountnumber}
        AND mva.provider = 'wema'
      LIMIT 1`;

    if (!rows.length) {
      logger.warn({ accountnumber }, 'Wema account-lookup: VA not found');
      return res.json({ accountname: '', status: '07', status_desc: 'Invalid Account', bvn: PAYLODE_BVN || undefined, nin: PAYLODE_NIN || undefined });
    }

    const va = rows[0];

    if (va.va_status !== 'active') {
      return res.json({
        accountname: `Paylode/${va.merchant_name || va.account_name || ''}`,
        status: '07', status_desc: 'Inactive Account',
        bvn: va.bvn || PAYLODE_BVN || undefined,
        nin: va.nin || PAYLODE_NIN || undefined,
      });
    }

    // For dynamic VAs, return expected amount (stored in metadata)
    const meta       = va.metadata || {};
    const isDynamic  = !!meta.expected_amount;
    const response   = {
      accountname:  `Paylode/${va.account_name || va.merchant_name || ''}`,
      status:       '00',
      status_desc:  'Okay',
      bvn:          va.bvn || PAYLODE_BVN || undefined,
      nin:          va.nin || PAYLODE_NIN || undefined,
    };
    if (isDynamic) response.amount = String(Number(meta.expected_amount) / 100); // kobo → naira

    return res.json(response);
  } catch (e) {
    logger.error({ err: e, accountnumber }, 'Wema account-lookup: DB error');
    // Return invalid to prevent Wema from crediting on our error
    return res.status(500).json({ accountname: '', status: '07', status_desc: 'Service error', bvn: PAYLODE_BVN || undefined, nin: PAYLODE_NIN || undefined });
  }
});

// ── 2. Transaction Notification ──────────────────────────────────────────────
// Wema notifies us of a confirmed VA inflow. Give value, return "00" to stop retries.
// Idempotent on sessionid.
router.post('/transaction-notify', async (req, res) => {
  if (!checkBearer(req, VA_TOKEN)) {
    logger.warn({ ip: req.ip }, 'Wema transaction-notify: bad Bearer token');
    return res.status(401).json({ transactionreference: '', status: '07', status_desc: 'Unauthorized' });
  }

  const b = req.body || {};
  const { sessionid, craccount, amount, originatorname, originatoraccountnumber, bankcode, paymentreference } = b;

  logger.info({ sessionid, craccount, amount, payer: originatorname }, 'Wema VA inflow notification');

  if (!sessionid || !craccount) {
    return res.json({ transactionreference: paymentreference || '', status: '07', status_desc: 'Missing fields' });
  }

  // Deduplicate: if we've already processed this sessionid, return 00 immediately
  const dup = await prisma.$queryRaw`
    SELECT reference FROM transactions WHERE reference = ${'WEMA-' + sessionid} LIMIT 1`;
  if (dup.length) {
    logger.info({ sessionid }, 'Wema VA inflow: duplicate notification, returning 00');
    return res.json({ transactionreference: 'WEMA-' + sessionid, status: '00', status_desc: 'Okay' });
  }

  try {
    // Resolve VA → merchant
    const rows = await prisma.$queryRaw`
      SELECT mva.merchant_id, mva.metadata, m.name AS merchant_name, m.webhook_url AS webhookUrl
      FROM merchant_virtual_accounts mva
      JOIN merchants m ON m.id = mva.merchant_id
      WHERE mva.va_number = ${craccount}
        AND mva.provider = 'wema'
        AND mva.status = 'active'
      LIMIT 1`;

    if (!rows.length) {
      logger.warn({ craccount, sessionid }, 'Wema VA inflow: no active VA found for account');
      return res.json({ transactionreference: 'WEMA-' + sessionid, status: '00', status_desc: 'Okay' });
    }

    const va         = rows[0];
    const merchantId = va.merchant_id;
    const meta       = va.metadata || {};
    const isDynamic  = !!meta.expected_amount;
    const faceKobo   = BigInt(Math.round(Number(amount || 0) * 100)); // naira → kobo

    if (faceKobo <= 0n) {
      return res.json({ transactionreference: 'WEMA-' + sessionid, status: '00', status_desc: 'Okay' });
    }

    if (isDynamic) {
      // Dynamic VA → look for a matching PENDING checkout transaction
      const txRef = meta.transaction_reference || null;
      if (txRef) {
        const r = await finalizePayinSuccess({
          reference: txRef, channel: 'BANK_TRANSFER', processor: 'wema_va',
          extraMeta: { method: 'wema_va', wema_session_id: sessionid, craccount, payer: originatorname },
          paidAmount: faceKobo,
        });
        if (r && r.amountMismatch) {
          logger.warn({ txRef, sessionid, expected: r.expected, paid: Number(faceKobo) },
            'Wema dynamic VA: amount mismatch — not credited');
        }
      }
    } else {
      // Static merchant VA → collection: record transaction, settle to merchant bank
      const ref   = 'WEMA-' + sessionid;
      const railRow = await prisma.$queryRaw`SELECT id FROM payment_rails WHERE name ILIKE 'wema' LIMIT 1`;
      const railId  = railRow.length ? railRow[0].id : null;

      // Fee calc (same pattern as PalmPay static VA)
      const rateRow = (await prisma.merchantRateConfig.findFirst({
        where: { merchantId, channel: { in: ['VIRTUAL_ACCOUNT', 'ALL'] } }, orderBy: { channel: 'desc' },
      })) || (await prisma.platformRateConfig.findFirst({
        where: { channel: { in: ['VIRTUAL_ACCOUNT', 'ALL'] } }, orderBy: { channel: 'desc' },
      }));
      const rate    = rateRow ? Number(rateRow.rate) : 0;
      const cap     = rateRow ? BigInt(rateRow.cap || 0)     : 0n;
      const flat    = rateRow ? BigInt(rateRow.flatFee || 0) : 0n;
      let feeRaw    = faceKobo * BigInt(Math.round(rate * 1_000_000)) / 1_000_000n + flat;
      if (cap > 0n && feeRaw > cap) feeRaw = cap;
      const vatOnFee    = feeRaw * 75n / 1000n;
      const merchantFee = feeRaw + vatOnFee;
      const settlement  = faceKobo - merchantFee;

      await prisma.transaction.create({ data: {
        reference: ref, merchantId,
        customerEmail: 'wema-va@collections.local',
        amount: faceKobo, currency: 'NGN', status: 'SUCCESS', channel: 'BANK_TRANSFER',
        railId, merchantFee, netRevenue: feeRaw, vatOutput: vatOnFee, paidAt: new Date(),
        metadata: {
          method: 'wema_static_va', wema_session_id: sessionid, craccount,
          payer: originatorname || null, payer_account: originatoraccountnumber || null,
          payer_bank_code: bankcode || null, fee_paid_by: 'merchant',
          merchant_settlement: Number(settlement),
        },
      }});

      if (va.webhookUrl) {
        dispatchWebhook(merchantId, 'payment.success', {
          reference: ref, status: 'SUCCESS', channel: 'BANK_TRANSFER',
          amount: Number(faceKobo), merchant_settlement: Number(settlement), fee: Number(merchantFee),
          processor: 'wema_static_va',
        }).catch(() => {});
      }

      logger.info({ merchantId, amount: Number(faceKobo), settlement: Number(settlement), sessionid },
        'Wema static VA collection recorded → settles to merchant bank');
    }

    return res.json({ transactionreference: 'WEMA-' + sessionid, status: '00', status_desc: 'Okay' });
  } catch (e) {
    logger.error({ err: e, sessionid, craccount }, 'Wema VA inflow processing failed');
    // Return 500 so Wema retries — do NOT return 00 if we haven't credited
    return res.status(500).json({ transactionreference: '', status: '99', status_desc: 'Service error' });
  }
});

// ── 3. Payout Callback ───────────────────────────────────────────────────────
// Wema sends payout status updates. Final states:
//   Stage=DebitCredit/NIPTransfer, Status=SUCCESS  → settled
//   Stage=REVERSAL, Status=SUCCESS                 → failed (refund merchant)
//   Stage=DebitCredit/NIPTransfer, Status=FAILED   → intermediate; wait for REVERSAL
router.post('/payout', async (req, res) => {
  if (!checkBearer(req, PAYOUT_TOKEN)) {
    logger.warn({ ip: req.ip }, 'Wema payout callback: bad Bearer token');
    return res.status(401).json({ status: 'error' });
  }

  const b = req.body || {};
  const { TransactionReference: orderId, Sessionid: sessionId, Stage: stage, Status: status, Description: description } = b;

  logger.info({ orderId, sessionId, stage, status }, 'Wema payout callback');

  if (!orderId) return res.status(200).json({ status: 'ok' });

  const stageUp  = String(stage  || '').toUpperCase();
  const statusUp = String(status || '').toUpperCase();

  // Determine final orderStatus to pass to applyPayoutResult
  let orderStatus = null;

  if ((stageUp === 'DEBITCREDIT' || stageUp === 'NIPTRANSFER') && statusUp === 'SUCCESS') {
    orderStatus = '2'; // success
  } else if (stageUp === 'REVERSAL' && statusUp === 'SUCCESS') {
    orderStatus = '3'; // reversal confirmed — final failure; applyPayoutResult will refund
  }
  // DebitCredit/NIPTransfer FAILED → intermediate; REVERSAL callback will follow; ignore

  if (orderStatus !== null) {
    try {
      const result = await applyPayoutResult({
        orderId,
        orderNo:     sessionId || null,
        sessionId:   sessionId || null,
        orderStatus,
        errorMsg:    orderStatus === '3' ? (description || 'Reversed by Wema') : null,
        source:      'wema_payout_webhook',
      });
      if (!result || !result.matched) {
        logger.warn({ orderId, stage, status }, 'Wema payout callback: leg not found or already settled');
      }
    } catch (e) {
      logger.error({ err: e, orderId }, 'Wema payout callback: applyPayoutResult threw');
      return res.status(500).json({ status: 'error' });
    }
  } else {
    logger.info({ orderId, stage, status }, 'Wema payout callback: intermediate stage — no action');
  }

  return res.status(200).json({ status: 'ok' });
});

// ── 4. Fetch Mini Statement ──────────────────────────────────────────────────
// Wema calls this for regulatory/fraud review — last 10 days of VA transactions.
// Returns credits and debits; for dynamic/pass-through VAs, credits only.
router.post('/mini-statement', async (req, res) => {
  if (!checkBearer(req, VA_TOKEN)) {
    logger.warn({ ip: req.ip }, 'Wema mini-statement: bad Bearer token');
    return res.status(401).json({ transactions: [] });
  }

  const { accountnumber } = req.body || {};
  if (!accountnumber) return res.json({ transactions: [] });

  try {
    const since = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();

    // Transactions credited via this VA (inflows)
    const txns = await prisma.$queryRaw`
      SELECT
        t.metadata->>'payer_account'   AS "accountNo",
        t.metadata->>'payer_bank_code' AS "bankName",
        (t.amount::numeric / 100)::text AS "amount",
        'Credit'                        AS "direction",
        t.paid_at                       AS "transactionDate"
      FROM transactions t
      WHERE t.status = 'SUCCESS'
        AND t.created_at >= ${since}::timestamptz
        AND (
          t.metadata->>'wema_session_id' IS NOT NULL
          OR t.metadata->>'craccount' = ${accountnumber}
        )
        AND t.metadata->>'craccount' = ${accountnumber}
      ORDER BY t.created_at DESC
      LIMIT 50`;

    return res.json({ transactions: txns });
  } catch (e) {
    logger.error({ err: e, accountnumber }, 'Wema mini-statement: error');
    return res.status(500).json({ transactions: [] });
  }
});

// ── 5. Get KYC Details ───────────────────────────────────────────────────────
// Wema calls this for regulatory KYC verification on a VA.
router.post('/kyc-details', async (req, res) => {
  if (!checkBearer(req, VA_TOKEN)) {
    logger.warn({ ip: req.ip }, 'Wema kyc-details: bad Bearer token');
    return res.status(401).json({ status_desc: 'Unauthorized' });
  }

  const { accountnumber } = req.body || {};
  if (!accountnumber) {
    return res.json({ accountname: '', bvn: PAYLODE_BVN || undefined, nin: PAYLODE_NIN || undefined, mobilenumber: '', walletbalance: '0.00', status_desc: 'Invalid Account' });
  }

  try {
    const rows = await prisma.$queryRaw`
      SELECT
        mva.account_name,
        mva.status       AS va_status,
        mva.metadata,
        m.name           AS merchant_name,
        m.bvn,
        m.nin,
        m.phone
      FROM merchant_virtual_accounts mva
      JOIN merchants m ON m.id = mva.merchant_id
      WHERE mva.va_number = ${accountnumber}
        AND mva.provider = 'wema'
      LIMIT 1`;

    if (!rows.length) {
      return res.json({ accountname: '', bvn: PAYLODE_BVN || undefined, nin: PAYLODE_NIN || undefined, mobilenumber: '', walletbalance: '0.00', status_desc: 'Invalid Account' });
    }

    const va   = rows[0];
    const meta = va.metadata || {};

    return res.json({
      accountname:   `Paylode/${va.account_name || va.merchant_name || ''}`,
      bvn:           va.bvn  || PAYLODE_BVN || undefined,
      nin:           va.nin  || PAYLODE_NIN || undefined,
      mobilenumber:  va.phone || '',
      walletbalance: meta.expected_amount
        ? String(Number(meta.expected_amount) / 100)
        : '0.00',
      status_desc:   va.va_status === 'active' ? 'Active' : 'Inactive',
    });
  } catch (e) {
    logger.error({ err: e, accountnumber }, 'Wema kyc-details: error');
    return res.status(500).json({ status_desc: 'Service error' });
  }
});

// ── 6. Block Account ─────────────────────────────────────────────────────────
// Wema calls this to immediately block a VA suspected of fraud.
// Blocked accounts must return "Inactive" on all subsequent account-lookup calls.
router.post('/block-account', async (req, res) => {
  if (!checkBearer(req, VA_TOKEN)) {
    logger.warn({ ip: req.ip }, 'Wema block-account: bad Bearer token');
    return res.status(401).json({ status: '07', status_desc: 'Unauthorized' });
  }

  const { accountnumber, blockReason } = req.body || {};
  logger.warn({ accountnumber, blockReason }, 'Wema block-account request');

  if (!accountnumber) {
    return res.json({ status: '07', status_desc: 'Invalid Account' });
  }

  try {
    const result = await prisma.$executeRaw`
      UPDATE merchant_virtual_accounts
      SET status = 'blocked',
          metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{block_reason}', to_jsonb(${String(blockReason || '').slice(0, 200)}::text)),
          updated_at = NOW()
      WHERE va_number = ${accountnumber}
        AND provider = 'wema'`;

    if (result === 0) {
      return res.json({ status: '07', status_desc: 'Invalid Account' });
    }

    logger.warn({ accountnumber, blockReason }, 'Wema VA blocked by bank fraud request');
    return res.json({ status: '00', status_desc: 'Account blocked successfully' });
  } catch (e) {
    logger.error({ err: e, accountnumber }, 'Wema block-account: error');
    return res.status(500).json({ status: '99', status_desc: 'Service error' });
  }
});

module.exports = router;
