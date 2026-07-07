'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Shared payout settlement — the SINGLE source of truth for turning a PalmPay
//  payout result into ledger state. Used by BOTH:
//    • the payout WEBHOOK (palmpay-webhook.js) — the authoritative push, and
//    • the stuck-'sent' POLLER (reconcileSentPayouts, below) — the backstop that
//      queries PalmPay for legs whose webhook never landed.
//  Keeping the logic here means the two paths can never diverge on money.
//
//  The disburse step (payouts.js) only DEBITS the merchant wallet + rail float and
//  sends; success/failure is decided HERE. All transitions are GUARDED to
//  `status IN ('pending','sent')` so a retried webhook / overlapping poll can never
//  double-refund or overturn a leg that's already terminal.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');

// PalmPay orderStatus → our leg status. 2 = success; 1/0 = still processing (null,
// no state change); anything else = failed. (Confirmed against the PalmPay portal.)
function legStatusFor(orderStatus) {
  const s = String(orderStatus);
  if (s === '2') return 'success';
  if (s === '1' || s === '0') return null;
  return 'failed';
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

// Apply a payout RESULT to its leg, idempotently. Matches by rail_order_id, records
// the recon keys, and on a terminal result transitions the in-flight leg + (on
// failure) refunds the rail float + merchant wallet exactly once.
// Returns { matched, status } — status is 'success' | 'failed' | null (pending).
async function applyPayoutResult({ orderId, orderNo, sessionId, orderStatus, errorMsg, source = 'webhook' }) {
  const legs = await prisma.$queryRaw`
    SELECT rd.id, rd.payout_item_id, rd.batch_id, rd.rail_id, rd.merchant_id, rd.status,
           rd.amount, rd.rail_cost, rd.rail_vat, pi.item_fee, pi.item_vat
    FROM rail_disbursements rd JOIN payout_items pi ON rd.payout_item_id = pi.id
    WHERE rd.rail_order_id = ${orderId}`;
  if (!legs.length) { logger.warn({ orderId, source }, 'payout result: no matching leg'); return { matched: false, status: null }; }
  const leg = legs[0];
  const status = legStatusFor(orderStatus);

  // Always capture the recon keys (order number + sessionId) and any error message.
  await prisma.$executeRaw`
    UPDATE rail_disbursements
    SET rail_order_no = COALESCE(${orderNo || null}, rail_order_no),
        rail_session_id = COALESCE(${sessionId || null}, rail_session_id),
        error_msg = COALESCE(${errorMsg || null}, error_msg), updated_at = NOW()
    WHERE id = ${leg.id}::uuid`;

  if (status === 'success') {
    await prisma.$executeRaw`
      UPDATE rail_disbursements SET status='success', settled_at=NOW(), updated_at=NOW()
      WHERE id=${leg.id}::uuid AND status IN ('pending','sent')`;
    await prisma.$executeRaw`
      UPDATE payout_items SET status='success', provider_ref=${orderNo || null}, processed_at=NOW()
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
      // Pooled refund (rail-agnostic balance) — return the money to the merchant's
      // route-rail row if it exists, else their largest row.
      await prisma.$executeRaw`
        UPDATE merchant_wallets SET balance = balance + ${merchBack}, updated_at=NOW()
        WHERE id = (SELECT id FROM merchant_wallets WHERE merchant_id=${leg.merchant_id}::uuid
                    ORDER BY (rail_id = ${leg.rail_id}::uuid) DESC, balance DESC LIMIT 1)`;
      logger.warn({ orderId, source, merchant: leg.merchant_id, floatBack: String(floatBack), merchBack: String(merchBack) },
        `payout FAILED (${source}) — refunded rail float + merchant wallet`);
    }
    await prisma.$executeRaw`
      UPDATE payout_items SET status='failed', failure_reason=${errorMsg || 'Rail reported failure'},
        provider_ref=${orderNo || null}, processed_at=NOW()
      WHERE id=${leg.payout_item_id}::uuid AND status IN ('queued','processing')`;
    await rollupBatch(leg.batch_id);
  }
  // status null → still processing: recon keys recorded above, no state change.
  return { matched: true, status };
}

// Backstop poller — reconcile legs stuck 'sent' (the rail accepted the payout but
// the webhook never landed) by querying the rail's payout-result API and applying
// the result. Only rails with a query adapter are polled (PalmPay today). Legs are
// given a grace period so we don't race a webhook that's about to arrive.
async function reconcileSentPayouts({ olderThanMs = 120000, limit = 100 } = {}) {
  const palmpay = require('./palmpayService');
  const cutoff = new Date(Date.now() - olderThanMs);
  const legs = await prisma.$queryRaw`
    SELECT rd.rail_order_id, pr.name AS rail_name
    FROM rail_disbursements rd JOIN payment_rails pr ON rd.rail_id = pr.id
    WHERE rd.status = 'sent' AND rd.updated_at < ${cutoff}
    ORDER BY rd.updated_at ASC LIMIT ${limit}`;
  let checked = 0, settled = 0, failed = 0;
  for (const leg of legs) {
    if (!/palmpay/i.test(leg.rail_name || '') || !palmpay.isConfigured()) continue;
    let r;
    try { r = await palmpay.queryPayoutResult({ orderId: leg.rail_order_id }); }
    catch (e) { logger.error({ err: e, orderId: leg.rail_order_id }, 'payout recon query failed'); continue; }
    if (!r || !r.ok) continue;                       // query itself failed → retry next cycle
    checked++;
    const out = await applyPayoutResult({
      orderId: leg.rail_order_id, orderNo: r.raw && r.raw.data && r.raw.data.orderNo,
      sessionId: r.sessionId, orderStatus: r.orderStatus, errorMsg: r.reason, source: 'poller',
    });
    if (out.status === 'success') settled++;
    else if (out.status === 'failed') failed++;
  }
  if (legs.length) logger.info({ stuck: legs.length, checked, settled, failed }, 'stuck-sent payout reconciliation');
  return { stuck: legs.length, checked, settled, failed };
}

module.exports = { legStatusFor, rollupBatch, applyPayoutResult, reconcileSentPayouts };
