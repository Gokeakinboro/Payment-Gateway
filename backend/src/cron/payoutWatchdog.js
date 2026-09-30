'use strict';
/**
 * Paylode Payout Watchdog
 * Every 5 minutes:
 *  1. Find payout_items stuck in 'processing' for > 15 minutes
 *  2. Query Parallex to determine true status
 *  3. Auto-fix: mark success OR fail+refund based on Parallex response
 *  4. Email summary of fixes to Goke (only when something is fixed)
 *  5. Close any payout_batches whose items have all reached terminal status
 *
 * PM2 ecosystem entry (fork, persistent — uses setInterval):
 *   { name: 'payout-watchdog', script: 'src/cron/payoutWatchdog.js',
 *     exec_mode: 'fork', instances: 1, autorestart: true,
 *     env: { NODE_ENV: 'production' } }
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { PrismaClient } = require('@prisma/client');
const { sendEmail }    = require('../services/emailService');
const parallexTransfer = require('../modules/gateway-core/services/parallexTransferService');
const { logger }       = require('../utils/logger');

const p = new PrismaClient();
const ALERT_TO           = 'gokeakinboro@gmail.com';
const INTERVAL_MS        = 5 * 60 * 1000;
const STUCK_THRESHOLD_MS = 15 * 60 * 1000;
const PARALLEX_RAIL_ID   = '8fbc8c22-daba-4fcb-98ee-33ce7d8ffc74';

const alreadyFixed = new Set();

async function autoFix(item, railOrderId) {
  // Guard: re-read live state — another process may have already settled this item.
  const liveState = await p.$queryRawUnsafe(
    `SELECT status, refund_status FROM payout_items WHERE id = $1::uuid`, item.id
  );
  const live = liveState[0];
  if (!live || live.status !== 'processing') {
    logger.info({ itemId: item.id, status: live?.status }, '[watchdog] item no longer processing — skipping');
    return { action: 'skipped', reason: `status is ${live?.status || 'gone'} — already handled` };
  }
  if (live.refund_status === 'approved' || live.refund_status === 'pending_review') {
    logger.warn({ itemId: item.id, refund_status: live.refund_status },
      '[watchdog] item already refunded — skipping to prevent double reversal');
    return { action: 'skipped', reason: `refund_status=${live.refund_status} — double reversal prevented` };
  }

  // Safety: if no rail_order_id we cannot verify with Parallex — hold for manual review.
  if (!railOrderId) {
    logger.warn({ itemId: item.id }, '[watchdog] no rail_order_id — holding for manual review');
    await p.$queryRawUnsafe(
      `UPDATE payout_items SET status='held', failure_reason=$1 WHERE id=$2::uuid AND status='processing'`,
      'Watchdog: no rail_order_id — held for manual review', item.id
    );
    return { action: 'held', reason: 'no rail_order_id — cannot verify; manual review required' };
  }

  // Only query Parallex for Parallex-rail payouts; non-Parallex rails need a different adapter.
  if (item.leg?.railId && item.leg.railId !== PARALLEX_RAIL_ID) {
    const reason = `Watchdog: non-Parallex rail ${item.leg.railId} — held for manual review`;
    logger.warn({ itemId: item.id, railId: item.leg.railId }, '[watchdog] non-Parallex rail — holding');
    await p.$queryRawUnsafe(
      `UPDATE payout_items SET status='held', failure_reason=$1 WHERE id=$2::uuid AND status='processing'`,
      reason.slice(0, 280), item.id
    );
    return { action: 'held', reason };
  }

  // BUG 1 FIX: query failure is NOT a confirmed transfer failure — hold immediately, never auto-refund.
  let parallelStatus = null;
  try {
    const r = await parallexTransfer.queryPayoutResult({ orderId: railOrderId });
    parallelStatus = r;
  } catch (e) {
    logger.warn({ orderId: railOrderId, err: e.message }, '[watchdog] Parallex query failed — holding for manual review');
    const reason = ('Watchdog: Parallex query failed — held for manual review. ' + e.message).slice(0, 280);
    await p.$queryRawUnsafe(
      `UPDATE payout_items SET status='held', failure_reason=$1 WHERE id=$2::uuid AND status='processing'`,
      reason, item.id
    );
    return { action: 'held', reason };
  }

  const isSuccess = parallelStatus.orderStatus === '2';
  // Definitive failure only when Parallex returns code 30 NO RECORD (ok=true, orderStatus=null).
  // Every other non-success (ok=false, orderStatus '1'/'3'/unknown) is ambiguous — hold, never auto-refund.
  const isDefinitiveFail = parallelStatus.ok === true && parallelStatus.orderStatus === null;

  if (isSuccess) {
    await p.$queryRawUnsafe(
      `UPDATE rail_disbursements SET status='success', settled_at=NOW(), updated_at=NOW()
       WHERE rail_order_id=$1`, railOrderId
    );
    await p.$queryRawUnsafe(
      `UPDATE payout_items SET status='success', processed_at=NOW() WHERE id=$1::uuid`, item.id
    );
    return { action: 'success', reason: `Parallex orderStatus=${parallelStatus.orderStatus}` };
  }

  if (!isDefinitiveFail) {
    // Ambiguous: query returned ok=false (rail/network error), orderStatus '1' (in-flight),
    // orderStatus '3' (unknown), or any other non-null status that isn't confirmed success.
    // Hold without touching wallets — SA will review.
    const reason = `Watchdog: ambiguous status — orderStatus=${parallelStatus.orderStatus ?? 'null'}, ok=${parallelStatus.ok} — held for manual review`;
    logger.warn({ itemId: item.id, parallelStatus }, '[watchdog] ambiguous Parallex status — item held');
    await p.$queryRawUnsafe(
      `UPDATE payout_items SET status='held', failure_reason=$1 WHERE id=$2::uuid AND status='processing'`,
      reason.slice(0, 280), item.id
    );
    return { action: 'held', reason };
  }

  // isDefinitiveFail: Parallex code 30 NO RECORD — money never left the bank.
  // Restore rail float. Do NOT touch merchant wallet — SA must approve any refund.
  const refundKobo = BigInt(item.amount) + BigInt(item.itemFee || 0) + BigInt(item.itemVat || 0);
  const floatKobo  = BigInt(item.amount) + BigInt(item.leg?.railCost || 0) + BigInt(item.leg?.railVat || 0);
  const failReason = `Watchdog: Parallex code 30 NO RECORD — payout not sent — ${parallelStatus.reason || 'auto-resolved'}`;

  if (item.leg?.railId) {
    await p.$queryRawUnsafe(
      `UPDATE payment_rails SET float_balance=float_balance+$1, updated_at=NOW() WHERE id=$2::uuid`,
      floatKobo, item.leg.railId
    );
  }

  // Mark leg failed
  if (item.leg?.id) {
    await p.$queryRawUnsafe(
      `UPDATE rail_disbursements SET status='failed', error_msg=$1, updated_at=NOW()
       WHERE id=$2::uuid AND status IN ('pending','sent')`,
      failReason.slice(0, 280), item.leg.id
    );
  }
  // Mark item failed; refund_status='pending_review' so SA must approve before wallet is credited.
  await p.$queryRawUnsafe(
    `UPDATE payout_items
     SET status='failed', failure_reason=$1, refund_status='pending_review',
         refund_amount=$2
     WHERE id=$3::uuid AND status IN ('queued','processing')`,
    failReason.slice(0, 280), refundKobo, item.id
  );

  return { action: 'failed (pending_review)', reason: failReason };
}

// Re-poll Parallex for items in 'held' state (Parallex rail only).
// Success → mark resolved silently. Code-30 NO RECORD → mark failed/pending_review. Ambiguous → stay held.
async function recheckHeld() {
  try {
    const heldRows = await p.$queryRawUnsafe(`
      SELECT pi.id, pi.amount, pi.item_fee AS "itemFee", pi.item_vat AS "itemVat",
             pi.merchant_id AS "merchantId",
             m.business_name AS "businessName", m.merchant_code AS "merchantCode",
             rd.id AS "legId", rd.rail_order_id AS "railOrderId",
             rd.rail_cost AS "railCost", rd.rail_vat AS "railVat", rd.rail_id AS "railId"
      FROM payout_items pi
      JOIN payout_batches pb ON pb.id = pi.batch_id
      JOIN merchants m ON m.id = pi.merchant_id
      LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
      WHERE pi.status = 'held'
        AND rd.rail_id = '${PARALLEX_RAIL_ID}'::uuid
        AND rd.rail_order_id IS NOT NULL
      LIMIT 50
    `);

    if (!heldRows.length) return;

    let resolved = 0;
    for (const row of heldRows) {
      try {
        const r = await parallexTransfer.queryPayoutResult({ orderId: row.railOrderId });
        if (r && r.orderStatus === '2') {
          // Confirmed success — mark resolved, no wallet touch
          await p.$queryRawUnsafe(
            `UPDATE rail_disbursements SET status='success', settled_at=NOW(), updated_at=NOW() WHERE rail_order_id=$1`,
            row.railOrderId
          );
          await p.$queryRawUnsafe(
            `UPDATE payout_items SET status='success', processed_at=NOW(), failure_reason=NULL WHERE id=$1::uuid`,
            row.id
          );
          resolved++;
          logger.info({ itemId: row.id, orderId: row.railOrderId }, '[watchdog] held item confirmed success — resolved silently');
        } else if (r && r.ok === true && r.orderStatus === null) {
          // Definitive fail (code 30 NO RECORD) — mark failed/pending_review, restore rail float, NO wallet touch
          const refundKobo = BigInt(row.amount) + BigInt(row.itemFee || 0) + BigInt(row.itemVat || 0);
          const floatKobo  = BigInt(row.amount) + BigInt(row.railCost || 0) + BigInt(row.railVat || 0);
          const failReason = 'Watchdog re-check: Parallex code 30 NO RECORD — payout not sent';
          if (row.railId) {
            await p.$queryRawUnsafe(
              `UPDATE payment_rails SET float_balance=float_balance+$1, updated_at=NOW() WHERE id=$2::uuid`,
              floatKobo, row.railId
            );
          }
          if (row.legId) {
            await p.$queryRawUnsafe(
              `UPDATE rail_disbursements SET status='failed', error_msg=$1, updated_at=NOW() WHERE id=$2::uuid AND status IN ('pending','sent')`,
              failReason, row.legId
            );
          }
          await p.$queryRawUnsafe(
            `UPDATE payout_items SET status='failed', failure_reason=$1, refund_status='pending_review', refund_amount=$2 WHERE id=$3::uuid AND status='held'`,
            failReason, refundKobo, row.id
          );
          logger.info({ itemId: row.id }, '[watchdog] held item confirmed code-30 fail — pending_review');
        }
        // Ambiguous → leave as held; will be re-checked next tick
      } catch (e) {
        logger.warn({ itemId: row.id, err: e.message }, '[watchdog] recheck query failed — leaving held');
      }
    }

    if (resolved > 0) {
      logger.info({ resolved }, '[watchdog] recheck: silently resolved held items');
    }
  } catch (e) {
    logger.error({ err: e.message }, '[watchdog] recheckHeld error');
  }
}

// Re-poll Parallex for items in failed/pending_review state.
// If Parallex now says success (orderStatus=2) → money WAS sent → mark success + send urgent alert.
// Code 30 still NO RECORD → no change (stays pending_review, SA can still approve refund).
// Ambiguous → no change.
async function recheckPendingReview() {
  try {
    const rows = await p.$queryRawUnsafe(`
      SELECT pi.id, pi.amount, pi.item_fee AS "itemFee", pi.item_vat AS "itemVat",
             pi.merchant_id AS "merchantId",
             m.business_name AS "businessName", m.merchant_code AS "merchantCode",
             m.email AS "merchantEmail",
             pi.account_name AS "accountName", pi.account_number AS "accountNumber", pi.bank_code AS "bankCode",
             rd.id AS "legId", rd.rail_order_id AS "railOrderId", rd.rail_id AS "railId"
      FROM payout_items pi
      JOIN payout_batches pb ON pb.id = pi.batch_id
      JOIN merchants m ON m.id = pi.merchant_id
      LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
      WHERE pi.status = 'failed'
        AND pi.refund_status = 'pending_review'
        AND rd.rail_id = '${PARALLEX_RAIL_ID}'::uuid
        AND rd.rail_order_id IS NOT NULL
      LIMIT 50
    `);

    if (!rows.length) return;

    let settled = 0;
    const urgentAlerts = [];

    for (const row of rows) {
      try {
        const r = await parallexTransfer.queryPayoutResult({ orderId: row.railOrderId });

        if (r && r.orderStatus === '2') {
          // Money DID go out — flip to success and cancel the pending refund
          await p.$queryRawUnsafe(
            `UPDATE rail_disbursements SET status='success', settled_at=NOW(), updated_at=NOW() WHERE rail_order_id=$1`,
            row.railOrderId
          );
          await p.$queryRawUnsafe(
            `UPDATE payout_items SET status='success', processed_at=NOW(), refund_status='rejected',
             failure_reason='Watchdog: Parallex confirms SETTLED — money went out, refund cancelled'
             WHERE id=$1::uuid`,
            row.id
          );
          settled++;
          urgentAlerts.push(row);
          logger.warn({ itemId: row.id, orderId: row.railOrderId },
            '[watchdog] pending_review item confirmed SETTLED — refund cancelled, marked success');
        }
        // code 30 or ambiguous → no change; SA can still decide
      } catch (e) {
        logger.warn({ itemId: row.id, err: e.message }, '[watchdog] pending_review recheck query failed');
      }
    }

    if (urgentAlerts.length) {
      const alertRows = urgentAlerts.map(r =>
        `<tr>
          <td>${r.merchantCode || '—'}</td><td>${r.businessName || '—'}</td>
          <td>₦${(Number(r.amount) / 100).toLocaleString()}</td>
          <td>${r.bankCode} / ${r.accountNumber}</td><td>${r.accountName || '—'}</td>
        </tr>`
      ).join('');
      await sendEmail({
        to: ALERT_TO,
        subject: `[URGENT] Paylode: ${settled} pending-review payout(s) confirmed SENT by Parallex`,
        html: `<p style="color:#dc2626"><strong>⚠ URGENT — DO NOT approve refund for these items.</strong></p>
               <p>The watchdog queried Parallex and found that the following payout(s), which were in <em>pending_review</em>, have now been confirmed as <strong>SETTLED</strong> (money went out). Their status has been changed to <strong>success</strong> and pending refund cancelled.</p>
               <table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:13px">
               <tr style="background:#f5f5f5"><th>Code</th><th>Merchant</th><th>Amount</th><th>Bank/Account</th><th>Acct Name</th></tr>
               ${alertRows}
               </table>
               <p style="font-size:12px;color:#666">Server: 176.57.188.45 · payout-watchdog</p>`,
      });
    }
  } catch (e) {
    logger.error({ err: e.message }, '[watchdog] recheckPendingReview error');
  }
}

async function check() {
  try {
    // Re-check held items + pending_review items every tick
    await recheckHeld();
    await recheckPendingReview();

    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);

    const stuckRows = await p.$queryRawUnsafe(`
      SELECT pi.id, pi.amount, pi.item_fee AS "itemFee", pi.item_vat AS "itemVat",
             pi.bank_code AS "bankCode", pi.account_number AS "accountNumber",
             pi.merchant_id AS "merchantId", pi.created_at AS "createdAt",
             m.business_name AS "businessName", m.merchant_code AS "merchantCode",
             rd.id AS "legId", rd.rail_order_id AS "railOrderId",
             rd.rail_cost AS "railCost", rd.rail_vat AS "railVat", rd.rail_id AS "railId"
      FROM payout_items pi
      JOIN payout_batches pb ON pb.id = pi.batch_id
      JOIN merchants m ON m.id = pi.merchant_id
      LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
      WHERE pi.status = 'processing' AND pi.created_at < $1
    `, cutoff);

    const seen = new Map();
    for (const row of stuckRows) {
      if (!seen.has(row.id)) {
        seen.set(row.id, {
          ...row,
          leg: row.legId
            ? { id: row.legId, railOrderId: row.railOrderId, railCost: row.railCost, railVat: row.railVat, railId: row.railId }
            : null,
        });
      }
    }
    const stuck = [...seen.values()];
    const fresh = stuck.filter(i => !alreadyFixed.has(i.id));

    if (!fresh.length) {
      logger.info({ checked: stuck.length }, '[watchdog] tick OK — no stuck items');
      return;
    }

    const results = [];
    for (const item of fresh) {
      const leg = item.leg;                        // FIXED: was item.disbursements?.[0] || null
      const railOrderId = leg?.railOrderId || null;
      alreadyFixed.add(item.id);
      try {
        const outcome = await autoFix({ ...item, leg }, railOrderId);
        results.push({ item, outcome });
        logger.info({ itemId: item.id, outcome }, '[watchdog] auto-fixed stuck item');
      } catch (e) {
        logger.error({ itemId: item.id, err: e.message }, '[watchdog] auto-fix failed');
        results.push({ item, outcome: { action: 'fix-failed', reason: e.message } });
      }
    }

    const rows = results.map(({ item, outcome }) =>
      `<tr>
        <td>${item.merchantCode || '-'}</td>
        <td>${item.businessName || '-'}</td>
        <td>₦${(Number(item.amount) / 100).toLocaleString()}</td>
        <td>${item.bankCode} / ${item.accountNumber}</td>
        <td><strong>${outcome.action}</strong></td>
        <td style="font-size:11px;color:#666">${(outcome.reason || '').slice(0, 100)}</td>
      </tr>`
    ).join('');

    const heldCount    = results.filter(r => r.outcome.action === 'held').length;
    const failedCount  = results.filter(r => r.outcome.action.startsWith('failed')).length;
    const successCount = results.filter(r => r.outcome.action === 'success').length;

    await sendEmail({
      to: ALERT_TO,
      subject: `[Paylode Watchdog] ${results.length} stuck payout(s) — ${heldCount} held, ${failedCount} failed, ${successCount} success`,
      html: `<p>Paylode watchdog detected <strong>${results.length}</strong> payout item(s) stuck in processing for &gt;15 minutes.</p>
             <p><strong style="color:#d97706">${heldCount} held for manual review</strong> — no wallet touched.<br>
             ${failedCount} marked failed (refund_status=pending_review — SA must approve before wallet is credited).<br>
             ${successCount} confirmed success.</p>
             <table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:13px">
             <tr style="background:#f5f5f5"><th>Code</th><th>Merchant</th><th>Amount</th><th>Bank/Account</th><th>Action</th><th>Reason</th></tr>
             ${rows}
             </table>
             <p style="margin-top:12px;font-size:12px;color:#d00"><strong>⚠ No auto-refunds are applied.</strong> Review held/failed items in the SA dashboard before crediting any wallet.</p>
             <p style="font-size:12px;color:#666">Server: 176.57.188.45 · payout-watchdog</p>`,
    });

    await reconcileStuckBatches();
    logger.info({ fixed: results.length }, '[watchdog] tick complete — email sent');
  } catch (e) {
    logger.error({ err: e.message }, '[watchdog] check error');
  }
}

async function reconcileStuckBatches() {
  try {
    const closed = await p.$queryRaw`
      WITH terminal_batches AS (
        SELECT pb.id,
          COUNT(*) FILTER (WHERE pi.status = 'success') AS success_count,
          COUNT(*) FILTER (WHERE pi.status = 'failed')  AS fail_count
        FROM payout_batches pb
        JOIN payout_items pi ON pi.batch_id = pb.id
        WHERE pb.status = 'processing'
        GROUP BY pb.id
        HAVING COUNT(*) FILTER (WHERE pi.status NOT IN ('success','failed')) = 0
      )
      UPDATE payout_batches pb SET
        status          = CASE
                            WHEN tb.fail_count    = 0 THEN 'completed'
                            WHEN tb.success_count = 0 THEN 'failed'
                            ELSE 'partially_failed'
                          END,
        processed_items = tb.success_count,
        failed_items    = tb.fail_count,
        completed_at    = NOW(),
        updated_at      = NOW()
      FROM terminal_batches tb
      WHERE pb.id = tb.id
      RETURNING pb.id, pb.status
    `;
    if (closed.length) {
      logger.info({ batches: closed }, '[watchdog] reconciled stuck processing batches');
    }
  } catch (e) {
    logger.error({ err: e.message }, '[watchdog] reconcileStuckBatches error');
  }
}

// 30s startup delay — avoids competing for DB connections during a pm2 reload
// when paylode-core instances are also initialising.
setTimeout(() => {
  check();
  setInterval(check, INTERVAL_MS);
}, 30_000);
logger.info('[watchdog] Paylode payout watchdog started (5-min interval, first tick in 30s)');
