'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  PalmPay callbacks (scaffold). Three inbound notifications:
//    POST /api/v1/webhooks/palmpay/payout    — payout result
//    POST /api/v1/webhooks/palmpay/va-cashin — virtual-account pay-in
//    POST /api/v1/webhooks/palmpay/payin     — Pay-with-PalmPay result
//  Each verifies PalmPay's signature (platform public key, sign URL-decoded),
//  then MUST reply the literal "success" (else PalmPay retries 8x over ~24h).
//  Record-wiring (mark txn/payout/VA) is marked TODO — turned on with test keys
//  once the orderStatus code meanings are confirmed against the data dictionary.
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const palmpay = require('../services/palmpayService');
const { logger } = require('../utils/logger');

// Verify the callback signature unless PalmPay isn't configured yet (scaffold).
function verified(body) {
  if (!process.env.PALMPAY_PUBLIC_KEY) {
    logger.warn('PalmPay callback received but PALMPAY_PUBLIC_KEY not set — cannot verify (scaffold mode)');
    return true; // accept in scaffold; once configured, real verification applies
  }
  return palmpay.verifyCallback(body);
}

// POST /api/v1/webhooks/palmpay/payout — payout result notification
router.post('/payout', (req, res) => {
  const b = req.body || {};
  if (!verified(b)) { logger.warn({ orderId: b.orderId }, 'PalmPay payout callback: BAD signature'); return res.status(401).send('invalid signature'); }
  logger.info({ orderId: b.orderId, orderNo: b.orderNo, orderStatus: b.orderStatus, amount: b.amount }, 'PalmPay payout result');
  // TODO(keys): match payout_item/batch by orderId → set status from orderStatus
  //   (success → 'success', failure → 'failed' + failureReason=b.errorMsg). Then
  //   feed railHealth.recordRailResult(palmpayRail, {ok, reason, isLowBalance}).
  res.status(200).send('success');
});

// POST /api/v1/webhooks/palmpay/va-cashin — virtual-account pay-in (collection)
router.post('/va-cashin', (req, res) => {
  const b = req.body || {};
  if (!verified(b)) { logger.warn({ orderNo: b.orderNo }, 'PalmPay VA cash-in callback: BAD signature'); return res.status(401).send('invalid signature'); }
  logger.info({ virtualAccountNo: b.virtualAccountNo, orderNo: b.orderNo, orderStatus: b.orderStatus, amount: b.orderAmount, payer: b.payerAccountName }, 'PalmPay VA cash-in');
  // TODO(keys): resolve the merchant/customer by virtualAccountNo → record the
  //   incoming transfer as a successful bank_transfer transaction + fire merchant webhook.
  res.status(200).send('success');
});

// POST /api/v1/webhooks/palmpay/payin — Pay-with-PalmPay (wallet/checkout) result
router.post('/payin', (req, res) => {
  const b = req.body || {};
  if (!verified(b)) { logger.warn({ orderId: b.orderId }, 'PalmPay pay-in callback: BAD signature'); return res.status(401).send('invalid signature'); }
  logger.info({ orderId: b.orderId, orderNo: b.orderNo, orderStatus: b.orderStatus, amount: b.amount }, 'PalmPay pay-in result');
  // TODO(keys): find transaction by reference (=orderId); on success mark SUCCESS
  //   (mirror checkout confirm: set fees/settlement, dispatch merchant webhook).
  res.status(200).send('success');
});

module.exports = router;
