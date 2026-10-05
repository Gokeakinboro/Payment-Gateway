'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  OPay callbacks.
//    POST /api/v1/webhooks/opay/payout  — payout result
//    POST /api/v1/webhooks/opay/cashin  — bank-transfer pay-in result
//    POST /api/v1/webhooks/opay/payin   — Pay-with-OPay (wallet QR) result
//    POST /api/v1/webhooks/opay/refund  — refund result
//    POST /api/v1/webhooks/opay/        — catch-all (routes by payload shape)
//
//  OPay sends the HMAC-SHA512 signature in the `Sign` request header.
//  Respond HTTP 200 on success; HTTP 500 triggers OPay retry.
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const opay   = require('../services/opayService');
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');
const { finalizePayinSuccess, failPayin } = require('../services/payinFinalize');
const { applyPayoutResult } = require('../services/payoutSettle');
const { dispatchWebhook } = require('../../../services/webhookService');

// Verify OPay HMAC-SHA3-512 callback signature.
// OPay embeds the signature in the body as `sha512` (NOT a request header).
// Pass the already-parsed body object — verifyWebhook builds the canonical string internally.
function verified(parsedBody) {
  return opay.verifyWebhook(parsedBody);
}

// ── Payout result ─────────────────────────────────────────────────────────────
async function handlePayout(b, res) {
  if (!verified(b)) {
    logger.warn({ reference: b.reference || b.orderId }, 'OPay payout callback: BAD signature');
    return res.status(401).send('invalid signature');
  }
  const orderId = b.reference || b.orderId || b.merchantOrderNo;
  const orderNo = b.orderNo;
  logger.info({ orderId, orderNo, status: b.status }, 'OPay payout result');
  await applyPayoutResult({
    orderId, orderNo,
    orderStatus: mapOrderStatus(b.status),
    errorMsg:    b.failureReason || b.errorMsg || '',
    source: 'webhook',
  });
  return res.status(200).send('SUCCESS'); // OPay payout notification ACK must be plain text "SUCCESS"
}

// ── Bank-transfer pay-in (collection) ────────────────────────────────────────
// Matches by the orderId (reference) we set on createBankTransferOrder.
async function handleCashin(b, res) {
  if (!verified(b)) {
    logger.warn({ orderNo: b.orderNo }, 'OPay cashin callback: BAD signature');
    return res.status(401).send('invalid signature');
  }
  const orderId = b.reference || b.merchantOrderNo;
  const amount  = b.amount && (b.amount.total != null ? b.amount.total : b.amount);
  logger.info({ orderId, orderNo: b.orderNo, status: b.status, amount }, 'OPay bank-transfer cashin');

  const status = mapPayinStatus(b.status);
  try {
    // Is this a dynamic per-checkout VA? Match the pending txn.
    const t = await prisma.$queryRaw`
      SELECT reference FROM transactions
      WHERE status = 'PENDING' AND reference = ${orderId}
      LIMIT 1`;
    if (t.length) {
      if (status === 'success') {
        const r = await finalizePayinSuccess({
          reference: orderId, channel: 'BANK_TRANSFER', processor: 'opay_va',
          extraMeta: { method: 'opay_va', opay_order_no: b.orderNo },
          paidAmount: amount != null ? Number(amount) : null,
        });
        if (r && r.amountMismatch) {
          logger.warn({ orderId, expected: r.expected, paid: r.paid }, 'OPay cashin AMOUNT MISMATCH — auto-reversing');
          await autoReverse(orderId, r.paid);
        }
      } else if (status === 'failed') {
        await failPayin({ reference: orderId, failureReason: b.failureReason || 'OPay payment failed' });
      }
      return res.status(200).json({ code: '00', message: 'success' });
    }

    // Static merchant VA — record as a collection transaction.
    const mva = await prisma.$queryRaw`
      SELECT merchant_id FROM merchant_virtual_accounts
      WHERE va_number = ${b.virtualAccountNumber || b.transferAccountNumber || ''} AND status = 'active'
      LIMIT 1`;
    if (mva.length && status === 'success') {
      const merchantId = mva[0].merchant_id;
      const face  = BigInt(amount || 0);
      const ref   = 'TXN-OPY-' + b.orderNo;
      const seen  = await prisma.$queryRaw`SELECT 1 FROM transactions WHERE reference = ${ref} LIMIT 1`;
      if (!seen.length && face > 0n) {
        const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
        const rateRow  = (await prisma.merchantRateConfig.findFirst({ where: { merchantId, channel: { in: ['VIRTUAL_ACCOUNT', 'ALL'] } }, orderBy: { channel: 'desc' } }))
                      || (await prisma.platformRateConfig.findFirst({ where: { channel: { in: ['VIRTUAL_ACCOUNT', 'ALL'] } }, orderBy: { channel: 'desc' } }));
        const rate  = rateRow ? Number(rateRow.rate) : 0;
        const cap   = rateRow ? BigInt(rateRow.cap  || 0) : 0n;
        const flat  = rateRow ? BigInt(rateRow.flatFee || 0) : 0n;
        let feeRaw  = face * BigInt(Math.round(rate * 1_000_000)) / 1_000_000n + flat;
        if (cap > 0n && feeRaw > cap) feeRaw = cap;
        const vatOnFee    = feeRaw * 75n / 1000n;
        const merchantFee = feeRaw + vatOnFee;
        const settlement  = face - merchantFee;
        const railRow = await prisma.$queryRaw`SELECT id FROM payment_rails WHERE name = 'OPay' LIMIT 1`;
        const railId  = railRow.length ? railRow[0].id : null;
        await prisma.transaction.create({ data: {
          reference: ref, merchantId,
          customerEmail: 'opay-va@collections.local',
          amount: face, currency: 'NGN', status: 'SUCCESS', channel: 'BANK_TRANSFER',
          railId, merchantFee, netRevenue: feeRaw, vatOutput: vatOnFee, paidAt: new Date(),
          metadata: {
            method: 'opay_static_va', opay_order_no: b.orderNo,
            payer: b.payerAccountName || null, fee_paid_by: 'merchant',
            merchant_settlement: Number(settlement), description: 'Static VA collection',
          },
        }});
        if (merchant && merchant.webhookUrl) {
          dispatchWebhook(merchantId, 'payment.success', {
            reference: ref, status: 'SUCCESS', channel: 'BANK_TRANSFER',
            amount: Number(face), merchant_settlement: Number(settlement), fee: Number(merchantFee),
            processor: 'opay_static_va',
          }).catch(() => {});
        }
        logger.info({ merchantId, face: Number(face), settlement: Number(settlement), orderNo: b.orderNo }, 'OPay static-VA COLLECTION recorded');
      }
    } else if (!mva.length) {
      logger.warn({ orderNo: b.orderNo, orderId }, 'OPay cashin: no matching txn or merchant VA');
    }
    return res.status(200).json({ code: '00', message: 'success' });
  } catch (e) {
    logger.error({ err: e, orderNo: b.orderNo, orderId }, 'OPay cashin processing failed');
    return res.status(500).json({ code: '99', message: 'error' });
  }
}

// ── Pay-with-OPay (wallet QR) result ─────────────────────────────────────────
async function handlePayin(b, res) {
  if (!verified(b)) {
    logger.warn({ orderId: b.reference }, 'OPay pay-in callback: BAD signature');
    return res.status(401).send('invalid signature');
  }
  const orderId = b.reference || b.merchantOrderNo;
  const amount  = b.amount && (b.amount.total != null ? b.amount.total : b.amount);
  logger.info({ orderId, orderNo: b.orderNo, status: b.status, amount }, 'OPay pay-in result');
  const status = mapPayinStatus(b.status);
  try {
    if (status === 'success') {
      const r = await finalizePayinSuccess({
        reference: orderId, channel: 'BANK_TRANSFER', processor: 'opay_wallet',
        extraMeta: { method: 'opay_wallet', opay_order_no: b.orderNo },
        paidAmount: amount != null ? Number(amount) : null,
      });
      if (r && r.amountMismatch) {
        logger.warn({ orderId, expected: r.expected, paid: r.paid }, 'OPay pay-in AMOUNT MISMATCH — auto-reversing');
        await autoReverse(orderId, r.paid);
      }
    } else if (status === 'failed') {
      await failPayin({ reference: orderId, failureReason: b.failureReason || 'OPay wallet payment failed' });
    }
    return res.status(200).json({ code: '00', message: 'success' });
  } catch (e) {
    logger.error({ err: e, orderId }, 'OPay pay-in processing failed');
    return res.status(500).json({ code: '99', message: 'error' });
  }
}

// ── Refund result ─────────────────────────────────────────────────────────────
async function handleRefund(b, res) {
  if (!verified(b)) return res.status(401).send('invalid signature');
  const refRef = b.reference || b.orderId || b.refundOrderNo;
  logger.info({ refRef, orderNo: b.orderNo, status: b.status }, 'OPay refund result');
  const mapped = mapPayinStatus(b.status) === 'success' ? 'completed' : 'failed';
  try {
    await prisma.$executeRaw`
      UPDATE transactions SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{reversal,status}', to_jsonb(${mapped}::text))
      WHERE metadata->'reversal'->>'ref' = ${refRef}`;
  } catch (e) { logger.error({ err: e, refRef }, 'OPay refund callback update failed'); }
  return res.status(200).json({ code: '00', message: 'success' });
}

// ── Auto-reverse a mismatched collection ──────────────────────────────────────
async function autoReverse(reference, paidAmountKobo) {
  const refRef = 'RFD-' + reference + '-' + Date.now().toString(36).toUpperCase();
  try {
    const rf = await opay.refundPayment({ refundId: refRef, originalOrderId: reference, amountKobo: paidAmountKobo, reason: 'Auto-reversal: wrong amount' });
    const meta = { ref: refRef, ok: rf.ok, code: rf.code, orderNo: rf.orderNo || null, amount: Number(paidAmountKobo), at: new Date().toISOString(), status: rf.ok ? 'pending' : 'failed' };
    await prisma.$executeRaw`
      UPDATE transactions SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{reversal}', ${JSON.stringify(meta)}::jsonb)
      WHERE reference = ${reference}`;
    logger.info({ reference, refRef, ok: rf.ok }, rf.ok ? 'OPay auto-reversal initiated' : 'OPay auto-reversal REJECTED — manual refund needed');
  } catch (e) {
    logger.error({ err: e, reference, refRef }, 'OPay auto-reversal FAILED');
  }
}

// ── Status mapping ────────────────────────────────────────────────────────────
// OPay order status strings (verify against live callbacks and adjust if needed).
function mapPayinStatus(s) {
  const v = String(s || '').toUpperCase();
  if (['SUCCESS', 'SUCCESSFUL', 'COMPLETE', 'PAID'].includes(v)) return 'success';
  if (['FAIL', 'FAILED', 'CANCELLED', 'CLOSED', 'EXPIRED'].includes(v)) return 'failed';
  return 'pending';
}
// legStatusFor() in payoutSettle expects: '2'=success, '1'/'0'=pending, else=failed.
// OPay payout status enum: SUCCESS, FAIL, CLOSE, RETURN, INITIAL, PENDING, CHECKING.
function mapOrderStatus(s) {
  const v = String(s || '').toUpperCase();
  if (v === 'SUCCESS' || v === 'SUCCESSFUL') return '2';
  if (['INITIAL', 'PENDING', 'CHECKING'].includes(v)) return '1';
  return 'failed'; // FAIL, CLOSE, RETURN → legStatusFor returns 'failed'
}

// ── Routes ────────────────────────────────────────────────────────────────────
// OPay signature is in the body's `sha512` field — express.json() parsing is fine.

router.post('/payout', (req, res) => {
  handlePayout(req.body || {}, res).catch(e => {
    logger.error({ err: e }, 'OPay payout callback error'); res.status(500).json({ code: '99', message: 'error' });
  });
});
router.post('/cashin', (req, res) => {
  handleCashin(req.body || {}, res).catch(e => {
    logger.error({ err: e }, 'OPay cashin callback error'); res.status(500).json({ code: '99', message: 'error' });
  });
});
router.post('/payin', (req, res) => {
  handlePayin(req.body || {}, res).catch(e => {
    logger.error({ err: e }, 'OPay payin callback error'); res.status(500).json({ code: '99', message: 'error' });
  });
});
router.post('/refund', (req, res) => {
  handleRefund(req.body || {}, res).catch(e => {
    logger.error({ err: e }, 'OPay refund callback error'); res.status(500).json({ code: '99', message: 'error' });
  });
});

// Catch-all — route by payload shape when OPay uses a single webhook URL.
router.post('/', async (req, res) => {
  const b = req.body || {};
  try {
    const ref = String((b.payload && b.payload.reference) || b.reference || b.merchantOrderNo || '');
    if (ref.startsWith('RFD-')) return handleRefund(b, res);
    const legs = await prisma.$queryRaw`SELECT id FROM rail_disbursements WHERE rail_order_id = ${ref} LIMIT 1`;
    if (legs.length) return handlePayout(b, res);
    if (b.transferAccountNumber || b.virtualAccountNumber) return handleCashin(b, res);
    return handlePayin(b, res);
  } catch (e) {
    logger.error({ err: e }, 'OPay base callback dispatch failed');
    return res.status(500).json({ code: '99', message: 'error' });
  }
});

module.exports = router;
