'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  PalmPay callbacks. Three inbound notifications:
//    POST /api/v1/webhooks/palmpay/payout    — payout result
//    POST /api/v1/webhooks/palmpay/va-cashin — virtual-account pay-in
//    POST /api/v1/webhooks/palmpay/payin     — Pay-with-PalmPay result
//  Payout + Pay-with-PalmPay calls set their per-request notifyUrl to the
//  matching subpath (see palmpayService). VA cash-in has no per-request notify
//  URL (configured at PalmPay account level) so it arrives at the BASE path —
//  handled by the base dispatcher below, which also acts as a catch-all so no
//  PalmPay callback ever 404s.
//  Each verifies PalmPay's signature, then MUST reply the literal "success"
//  (else PalmPay retries 8x over ~24h).
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const palmpay = require('../services/palmpayService');
const { prisma } = require('../utils/db');
const { logger } = require('../utils/logger');

// PalmPay orderStatus → our leg status. (2 = success; 1/0 = still processing;
// anything else = failed.) Confirm exact codes against PalmPay's data dictionary.
function legStatusFor(orderStatus) {
  const s = String(orderStatus);
  if (s === '2') return 'success';
  if (s === '1' || s === '0') return null;   // not terminal yet
  return 'failed';
}

// Verify the callback signature unless PalmPay isn't configured yet (scaffold).
function verified(body) {
  if (!process.env.PALMPAY_PUBLIC_KEY) {
    logger.warn('PalmPay callback received but PALMPAY_PUBLIC_KEY not set — cannot verify (scaffold mode)');
    return true; // accept in scaffold; once configured, real verification applies
  }
  return palmpay.verifyCallback(body);
}

// ── payout result ──────────────────────────────────────────────────────────────
// Matches the leg by rail_order_id (=orderId we sent), records the rail's order
// number + NIBSS sessionId (recon key), and rolls the result up to the item/batch.
async function handlePayout(b, res) {
  if (!verified(b)) { logger.warn({ orderId: b.orderId }, 'PalmPay payout callback: BAD signature'); return res.status(401).send('invalid signature'); }
  logger.info({ orderId: b.orderId, orderNo: b.orderNo, orderStatus: b.orderStatus, sessionId: b.sessionId }, 'PalmPay payout result');
  const legs = await prisma.$queryRaw`SELECT id, payout_item_id, batch_id FROM rail_disbursements WHERE rail_order_id = ${b.orderId}`;
  if (!legs.length) { logger.warn({ orderId: b.orderId }, 'PalmPay payout callback: no matching leg'); return res.status(200).send('success'); }
  const leg = legs[0];
  const status = legStatusFor(b.orderStatus);
  const settledAt = (status === 'success' || status === 'failed') ? new Date() : null;
  // Update the ledger leg (always capture orderNo + sessionId; set status if terminal).
  await prisma.$executeRaw`
    UPDATE rail_disbursements
    SET rail_order_no = ${b.orderNo || null}, rail_session_id = ${b.sessionId || null},
        error_msg = ${b.errorMsg || null},
        status = COALESCE(${status}, status),
        settled_at = COALESCE(${settledAt}, settled_at), updated_at = NOW()
    WHERE id = ${leg.id}::uuid`;
  if (status) {
    const itemStatus = status === 'success' ? 'success' : 'failed';
    await prisma.$executeRaw`
      UPDATE payout_items SET status = ${itemStatus}, failure_reason = ${status === 'failed' ? (b.errorMsg || 'Rail reported failure') : null},
        provider_ref = ${b.orderNo || null}, processed_at = NOW()
      WHERE id = ${leg.payout_item_id}::uuid`;
    // Roll the batch up: counts + terminal status when every item is done.
    await prisma.$executeRaw`
      UPDATE payout_batches pb SET
        processed_items = (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status = 'success'),
        failed_items    = (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status = 'failed'),
        status = CASE
          WHEN (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status IN ('queued','processing')) > 0 THEN pb.status
          WHEN (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status = 'failed') = 0 THEN 'completed'
          WHEN (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status = 'success') = 0 THEN 'failed'
          ELSE 'partially_failed' END,
        updated_at = NOW()
      WHERE pb.id = ${leg.batch_id}::uuid`;
  }
  return res.status(200).send('success');
}

// ── virtual-account pay-in (collection) ──────────────────────────────────────────
function handleVaCashin(b, res) {
  if (!verified(b)) { logger.warn({ orderNo: b.orderNo }, 'PalmPay VA cash-in callback: BAD signature'); return res.status(401).send('invalid signature'); }
  logger.info({ virtualAccountNo: b.virtualAccountNo, orderNo: b.orderNo, orderStatus: b.orderStatus, amount: b.orderAmount, payer: b.payerAccountName }, 'PalmPay VA cash-in');
  // TODO(keys): resolve the merchant/customer by virtualAccountNo → record the
  //   incoming transfer as a successful bank_transfer transaction + fire merchant webhook.
  return res.status(200).send('success');
}

// ── Pay-with-PalmPay (wallet/checkout) result ────────────────────────────────────
function handlePayin(b, res) {
  if (!verified(b)) { logger.warn({ orderId: b.orderId }, 'PalmPay pay-in callback: BAD signature'); return res.status(401).send('invalid signature'); }
  logger.info({ orderId: b.orderId, orderNo: b.orderNo, orderStatus: b.orderStatus, amount: b.amount }, 'PalmPay pay-in result');
  // TODO(keys): find transaction by reference (=orderId); on success mark SUCCESS
  //   (mirror checkout confirm: set fees/settlement, dispatch merchant webhook).
  return res.status(200).send('success');
}

// Subpath routes — payout + payin are targeted here via per-request notifyUrl.
router.post('/payout', async (req, res) => {
  try { return await handlePayout(req.body || {}, res); }
  catch (e) { logger.error({ err: e, orderId: (req.body || {}).orderId }, 'PalmPay payout callback processing failed'); return res.status(500).send('error'); }
});
router.post('/va-cashin', (req, res) => handleVaCashin(req.body || {}, res));
router.post('/payin', (req, res) => handlePayin(req.body || {}, res));

// Base route — VA cash-in arrives here (no per-request notifyUrl); also a
// catch-all that routes by payload shape so no PalmPay callback ever 404s.
router.post('/', async (req, res) => {
  const b = req.body || {};
  try {
    if (b.virtualAccountNo) return handleVaCashin(b, res);
    const legs = await prisma.$queryRaw`SELECT id FROM rail_disbursements WHERE rail_order_id = ${b.orderId} LIMIT 1`;
    if (legs.length) return handlePayout(b, res);
    return handlePayin(b, res);
  } catch (e) {
    logger.error({ err: e, orderId: b.orderId }, 'PalmPay base callback dispatch failed');
    return res.status(500).send('error');   // PalmPay will retry
  }
});

module.exports = router;
