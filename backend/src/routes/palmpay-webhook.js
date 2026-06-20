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
const { finalizePayinSuccess, failPayin } = require('../services/payinFinalize');

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

// Roll a batch up: item counts + terminal status once nothing is still in flight.
async function rollupBatch(batchId) {
  await prisma.$executeRaw`
    UPDATE payout_batches pb SET
      processed_items = (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status = 'success'),
      failed_items    = (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status = 'failed'),
      status = CASE
        WHEN (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status IN ('queued','processing')) > 0 THEN 'processing'
        WHEN (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status = 'failed') = 0 THEN 'completed'
        WHEN (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status = 'success') = 0 THEN 'failed'
        ELSE 'partially_failed' END,
      updated_at = NOW()
    WHERE pb.id = ${batchId}::uuid`;
}

// ── payout result ──────────────────────────────────────────────────────────────
// The AUTHORITATIVE settle confirmation. Matches the leg by rail_order_id (=orderId
// we sent), records the rail's order number + NIBSS sessionId (recon keys), and on
// a terminal result transitions the in-flight leg and rolls up the item/batch. On a
// FAILURE it refunds the merchant wallet + rail float (the disburse step only debits
// + sends; settlement success/failure is decided here). All transitions are GUARDED
// to `status IN ('pending','sent')` so a retried callback can't double-refund or
// overturn a leg the disburse step already settled.
async function handlePayout(b, res) {
  if (!verified(b)) { logger.warn({ orderId: b.orderId }, 'PalmPay payout callback: BAD signature'); return res.status(401).send('invalid signature'); }
  logger.info({ orderId: b.orderId, orderNo: b.orderNo, orderStatus: b.orderStatus, sessionId: b.sessionId }, 'PalmPay payout result');
  const legs = await prisma.$queryRaw`
    SELECT rd.id, rd.payout_item_id, rd.batch_id, rd.rail_id, rd.merchant_id, rd.status,
           rd.amount, rd.rail_cost, rd.rail_vat, pi.item_fee, pi.item_vat
    FROM rail_disbursements rd JOIN payout_items pi ON rd.payout_item_id = pi.id
    WHERE rd.rail_order_id = ${b.orderId}`;
  if (!legs.length) { logger.warn({ orderId: b.orderId }, 'PalmPay payout callback: no matching leg'); return res.status(200).send('success'); }
  const leg = legs[0];
  const status = legStatusFor(b.orderStatus);

  // Always capture the recon keys (order number + sessionId) and any error message.
  await prisma.$executeRaw`
    UPDATE rail_disbursements
    SET rail_order_no = COALESCE(${b.orderNo || null}, rail_order_no),
        rail_session_id = COALESCE(${b.sessionId || null}, rail_session_id),
        error_msg = COALESCE(${b.errorMsg || null}, error_msg), updated_at = NOW()
    WHERE id = ${leg.id}::uuid`;

  if (status === 'success') {
    await prisma.$executeRaw`
      UPDATE rail_disbursements SET status='success', settled_at=NOW(), updated_at=NOW()
      WHERE id=${leg.id}::uuid AND status IN ('pending','sent')`;
    await prisma.$executeRaw`
      UPDATE payout_items SET status='success', provider_ref=${b.orderNo || null}, processed_at=NOW()
      WHERE id=${leg.payout_item_id}::uuid AND status IN ('queued','processing')`;
    await rollupBatch(leg.batch_id);
  } else if (status === 'failed') {
    // Guarded transition → refund EXACTLY ONCE, only from an in-flight state.
    const flipped = await prisma.$queryRaw`
      UPDATE rail_disbursements SET status='failed', settled_at=NOW(), updated_at=NOW()
      WHERE id=${leg.id}::uuid AND status IN ('pending','sent') RETURNING id`;
    if (flipped.length) {
      const floatBack = BigInt(leg.amount) + BigInt(leg.rail_cost || 0) + BigInt(leg.rail_vat || 0);
      const merchBack = BigInt(leg.amount) + BigInt(leg.item_fee || 0) + BigInt(leg.item_vat || 0);
      await prisma.$executeRaw`UPDATE payment_rails SET float_balance = float_balance + ${floatBack}, updated_at=NOW() WHERE id=${leg.rail_id}::uuid`;
      await prisma.$executeRaw`UPDATE merchant_wallets SET balance = balance + ${merchBack}, updated_at=NOW() WHERE merchant_id=${leg.merchant_id}::uuid`;
      logger.warn({ orderId: b.orderId, merchant: leg.merchant_id, floatBack: String(floatBack), merchBack: String(merchBack) },
        'PalmPay payout FAILED via webhook — refunded rail float + merchant wallet');
    }
    await prisma.$executeRaw`
      UPDATE payout_items SET status='failed', failure_reason=${b.errorMsg || 'Rail reported failure'},
        provider_ref=${b.orderNo || null}, processed_at=NOW()
      WHERE id=${leg.payout_item_id}::uuid AND status IN ('queued','processing')`;
    await rollupBatch(leg.batch_id);
  }
  // status null → still processing: recon keys recorded above, no state change.
  return res.status(200).send('success');
}

// ── virtual-account pay-in (collection) ──────────────────────────────────────────
// Two cases, matched by virtualAccountNo:
//   (1) a PENDING checkout txn carrying this VA (dynamic per-checkout VA) → finalize
//       it as a customer payment (fees + settlement + merchant webhook); OR
//   (2) a merchant's STATIC VA → wallet top-up: credit full amount to the payout
//       wallet (no fee — merchant funding own float), idempotent on PalmPay orderNo.
async function handleVaCashin(b, res) {
  if (!verified(b)) { logger.warn({ orderNo: b.orderNo }, 'PalmPay VA cash-in callback: BAD signature'); return res.status(401).send('invalid signature'); }
  logger.info({ virtualAccountNo: b.virtualAccountNo, orderNo: b.orderNo, orderStatus: b.orderStatus, amount: b.orderAmount, payer: b.payerAccountName }, 'PalmPay VA cash-in');
  const vaNo = b.virtualAccountNo;
  const isSuccess = legStatusFor(b.orderStatus) === 'success';
  if (!vaNo) return res.status(200).send('success');
  try {
    // (1) dynamic checkout VA → a PENDING transaction tagged with this VA number
    const t = await prisma.$queryRaw`
      SELECT reference FROM transactions
      WHERE status = 'PENDING' AND metadata->>'palmpay_va_no' = ${vaNo}
      ORDER BY created_at DESC LIMIT 1`;
    if (t.length) {
      if (isSuccess) {
        const r = await finalizePayinSuccess({
          reference: t[0].reference, channel: 'BANK_TRANSFER', processor: 'palmpay_va',
          extraMeta: { method: 'palmpay_va', palmpay_va_no: vaNo, palmpay_order_no: b.orderNo, payer: b.payerAccountName },
          paidAmount: (b.orderAmount != null ? b.orderAmount : null),   // enforce exact amount
        });
        if (r && r.amountMismatch) {
          logger.warn({ vaNo, orderNo: b.orderNo, expected: r.expected, paid: r.paid }, 'PalmPay VA cash-in AMOUNT MISMATCH — not credited, auto-reversing');
          await autoReverse(t[0].reference, r.paid);
        }
      }
      return res.status(200).send('success');
    }

    // (2) static per-merchant VA → wallet top-up (full credit, no fee)
    const mva = await prisma.$queryRaw`SELECT merchant_id FROM merchant_virtual_accounts WHERE va_number = ${vaNo} AND status = 'active' LIMIT 1`;
    if (mva.length && isSuccess) {
      const merchantId = mva[0].merchant_id;
      const amt = BigInt(b.orderAmount || 0);
      const ref = 'PPVA-' + b.orderNo;
      const seen = await prisma.$queryRaw`SELECT 1 FROM wallet_ledger WHERE reference = ${ref} LIMIT 1`;
      if (!seen.length && amt > 0n) {
        await prisma.$transaction(async (tx) => {
          const w = await tx.$queryRaw`SELECT balance FROM merchant_wallets WHERE merchant_id = ${merchantId}::uuid FOR UPDATE`;
          const before = w.length ? BigInt(w[0].balance) : 0n;
          if (w.length) {
            await tx.$executeRaw`UPDATE merchant_wallets SET balance = balance + ${amt}, last_funded_at = NOW(), updated_at = NOW() WHERE merchant_id = ${merchantId}::uuid`;
          } else {
            await tx.$executeRaw`INSERT INTO merchant_wallets (id, merchant_id, balance, last_funded_at, created_at, updated_at) VALUES (gen_random_uuid(), ${merchantId}::uuid, ${amt}, NOW(), NOW(), NOW())`;
          }
          await tx.$executeRaw`
            INSERT INTO wallet_ledger (id, merchant_id, entry_type, amount, balance_before, balance_after, reference, description, created_at)
            VALUES (gen_random_uuid(), ${merchantId}::uuid, 'CREDIT', ${amt}, ${before}, ${before + amt}, ${ref}, ${'PalmPay VA top-up from ' + (b.payerAccountName || 'payer')}, NOW())`;
        });
        logger.info({ merchantId, amount: Number(amt), vaNo, orderNo: b.orderNo }, 'PalmPay VA top-up credited to wallet');
      }
    } else if (!mva.length) {
      logger.warn({ vaNo, orderNo: b.orderNo }, 'PalmPay VA cash-in: no matching checkout txn or merchant VA');
    }
    return res.status(200).send('success');
  } catch (e) {
    logger.error({ err: e, orderNo: b.orderNo, vaNo }, 'PalmPay VA cash-in processing failed');
    return res.status(500).send('error');   // PalmPay will retry
  }
}

// ── Pay-with-PalmPay (wallet/checkout) result ────────────────────────────────────
// orderId = our transaction reference. On success, finalize the PENDING txn.
async function handlePayin(b, res) {
  if (!verified(b)) { logger.warn({ orderId: b.orderId }, 'PalmPay pay-in callback: BAD signature'); return res.status(401).send('invalid signature'); }
  logger.info({ orderId: b.orderId, orderNo: b.orderNo, orderStatus: b.orderStatus, amount: b.amount }, 'PalmPay pay-in result');
  const status = legStatusFor(b.orderStatus);
  try {
    if (status === 'success') {
      const r = await finalizePayinSuccess({
        reference: b.orderId, channel: 'BANK_TRANSFER', processor: 'palmpay_wallet',
        extraMeta: { method: 'palmpay_wallet', palmpay_order_no: b.orderNo },
        paidAmount: (b.amount != null ? b.amount : null),   // enforce exact amount
      });
      if (r && r.amountMismatch) {
        logger.warn({ orderId: b.orderId, expected: r.expected, paid: r.paid }, 'PalmPay pay-in AMOUNT MISMATCH — not credited, auto-reversing');
        await autoReverse(b.orderId, r.paid);
      }
    } else if (status === 'failed') {
      await failPayin({ reference: b.orderId, failureReason: b.errorMsg || 'PalmPay payment failed' });
    }
    return res.status(200).send('success');
  } catch (e) {
    logger.error({ err: e, orderId: b.orderId }, 'PalmPay pay-in processing failed');
    return res.status(500).send('error');   // PalmPay will retry
  }
}

// Auto-reverse a wrong-amount collection back to the ORIGINAL payer via PalmPay
// refund. Records the reversal on the txn. Runs once per txn: the mismatch path
// flips the txn to FAILED, so PalmPay webhook retries won't re-trigger a refund.
async function autoReverse(reference, paidAmountKobo) {
  const refRef = 'RFD-' + reference + '-' + Date.now().toString(36).toUpperCase();
  try {
    const rf = await palmpay.refundOrder({ orderId: refRef, originOrderId: reference, amountKobo: paidAmountKobo, remark: 'Auto-reversal: wrong amount paid' });
    const meta = { ref: refRef, ok: rf.ok, code: rf.code, orderNo: rf.orderNo || null, amount: Number(paidAmountKobo), at: new Date().toISOString(), status: rf.ok ? 'pending' : 'failed' };
    await prisma.$executeRaw`
      UPDATE transactions SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{reversal}', ${JSON.stringify(meta)}::jsonb)
      WHERE reference = ${reference}`;
    logger.info({ reference, refRef, ok: rf.ok, code: rf.code, orderNo: rf.orderNo }, rf.ok ? 'Auto-reversal initiated' : 'Auto-reversal REJECTED by PalmPay — manual refund needed');
    return rf;
  } catch (e) {
    logger.error({ err: e, reference, refRef }, 'Auto-reversal FAILED — manual refund needed');
    return { ok: false };
  }
}

// ── refund result (refund-result-notify) ─────────────────────────────────────────
// b.orderId here = our refund ref (RFD-…). Roll the final status onto the original txn.
async function handleRefund(b, res) {
  if (!verified(b)) { logger.warn({ orderId: b.orderId }, 'PalmPay refund callback: BAD signature'); return res.status(401).send('invalid signature'); }
  logger.info({ orderId: b.orderId, orderNo: b.orderNo, orderStatus: b.orderStatus, amount: b.amount }, 'PalmPay refund result');
  const status = legStatusFor(b.orderStatus); // 2 = success
  const mapped = status === 'success' ? 'completed' : status === 'failed' ? 'failed' : 'pending';
  try {
    await prisma.$executeRaw`
      UPDATE transactions SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{reversal,status}', to_jsonb(${mapped}::text))
      WHERE metadata->'reversal'->>'ref' = ${b.orderId}`;
  } catch (e) { logger.error({ err: e, orderId: b.orderId }, 'refund callback update failed'); }
  return res.status(200).send('success');
}

// Subpath routes — payout + payin are targeted here via per-request notifyUrl.
router.post('/payout', async (req, res) => {
  try { return await handlePayout(req.body || {}, res); }
  catch (e) { logger.error({ err: e, orderId: (req.body || {}).orderId }, 'PalmPay payout callback processing failed'); return res.status(500).send('error'); }
});
router.post('/va-cashin', (req, res) => handleVaCashin(req.body || {}, res));
router.post('/payin', (req, res) => handlePayin(req.body || {}, res));
router.post('/refund', (req, res) => handleRefund(req.body || {}, res));

// Base route — VA cash-in arrives here (no per-request notifyUrl); also a
// catch-all that routes by payload shape so no PalmPay callback ever 404s.
router.post('/', async (req, res) => {
  const b = req.body || {};
  try {
    if (String(b.orderId || '').startsWith('RFD-')) return handleRefund(b, res);
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
