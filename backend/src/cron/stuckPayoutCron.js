'use strict';
/**
 * Stuck Payout Monitor  (runs every 5 minutes inside paylode-core worker 0)
 *
 * Catches payout_batches stuck in 'processing' whose legs were NEVER sent to any
 * rail (sent_at IS NULL).  These arise when dispatchBatch throws after the setup
 * transaction commits (items → 'processing', rail_disbursements → 'pending') but
 * before any NE/transfer fires — e.g. a TDZ bug, uncaught exception, or OOM.
 *
 * The auto-dispatch recovery (Step 0 in autoDispatchDuePayouts) already runs every
 * 30 s, so most stuck batches are cleaned up within half a minute.  This cron is
 * the 5-minute safety net + alert layer:
 *   1. Detect any batch still stuck after 5 minutes.
 *   2. Recover it (return float, delete pending disbursements, reset to queued/needs_routing).
 *   3. Email Goke so the root cause can be investigated.
 *
 * Safety guard: NOT EXISTS (sent_at IS NOT NULL) ensures we never touch a batch
 * where any leg already moved money.  Batches with a mix of sent + unsent legs
 * (partial dispatch) are left to the watchdog + manual review.
 */

const { PrismaClient } = require('../../node_modules/.prisma/client');
const { logger } = require('../utils/logger');
const { sendEmail } = require('../services/emailService');

const p = new PrismaClient();

const ALERT_TO   = 'gokeakinboro@gmail.com';
const GRACE_MIN  = 5;             // minutes a batch must be stuck before we act
const INTERVAL_S = 5 * 60 * 1000; // 5 minutes

async function recoverStuckPayouts() {
  // ── 1. Find stuck batches ──────────────────────────────────────────────────
  const stuck = await p.$queryRaw`
    SELECT DISTINCT
      pb.id::text          AS id,
      pb.batch_ref,
      pb.merchant_id::text AS merchant_id,
      pb.updated_at::text  AS stuck_since,
      m.business_name      AS merchant_name,
      m.merchant_code,
      COUNT(rd.id)         AS leg_count,
      SUM(rd.amount)       AS total_kobo
    FROM payout_batches pb
    JOIN merchants m ON m.id = pb.merchant_id
    JOIN payout_items pi ON pi.batch_id = pb.id
    JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
    WHERE pb.status = 'processing'
      AND pb.updated_at < NOW() - INTERVAL '5 minutes'
      AND rd.status  = 'pending'
      AND rd.sent_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM rail_disbursements rd2
        JOIN payout_items pi2 ON pi2.id = rd2.payout_item_id
        WHERE pi2.batch_id = pb.id AND rd2.sent_at IS NOT NULL
      )
    GROUP BY pb.id, pb.batch_ref, pb.merchant_id, pb.updated_at,
             m.business_name, m.merchant_code
    ORDER BY pb.updated_at ASC
  `;

  if (!stuck.length) {
    logger.info('[stuck-payout-cron] tick OK — no stuck batches');
    return;
  }

  logger.warn({ count: stuck.length, batches: stuck.map(b => b.batch_ref) },
    '[stuck-payout-cron] found stuck processing batches — recovering');

  const recovered = [], failed = [];

  // ── 2. Recover each batch ─────────────────────────────────────────────────
  for (const batch of stuck) {
    try {
      await p.$transaction(async tx => {
        // Return float for all unsent pending disbursements (grouped by rail)
        await tx.$executeRaw`
          UPDATE payment_rails
          SET float_balance = float_balance + sub.refund, updated_at = NOW()
          FROM (
            SELECT rd.rail_id, SUM(rd.amount + rd.rail_cost + rd.rail_vat) AS refund
            FROM rail_disbursements rd
            JOIN payout_items pi ON pi.id = rd.payout_item_id
            WHERE pi.batch_id = ${batch.id}::uuid
              AND rd.status = 'pending' AND rd.sent_at IS NULL
            GROUP BY rd.rail_id
          ) sub
          WHERE payment_rails.id = sub.rail_id
        `;
        // Delete the unsent disbursements so dispatchBatch recreates them fresh
        await tx.$executeRaw`
          DELETE FROM rail_disbursements
          WHERE id IN (
            SELECT rd.id FROM rail_disbursements rd
            JOIN payout_items pi ON pi.id = rd.payout_item_id
            WHERE pi.batch_id = ${batch.id}::uuid
              AND rd.status = 'pending' AND rd.sent_at IS NULL
          )
        `;
        // Reset items to queued
        await tx.$executeRaw`
          UPDATE payout_items SET status = 'queued', updated_at = NOW()
          WHERE batch_id = ${batch.id}::uuid AND status = 'processing'
        `;
        // Reset batch to needs_routing
        await tx.$executeRaw`
          UPDATE payout_batches SET status = 'needs_routing', updated_at = NOW()
          WHERE id = ${batch.id}::uuid AND status = 'processing'
        `;
      });
      recovered.push(batch);
      logger.info({ batchId: batch.id, ref: batch.batch_ref }, '[stuck-payout-cron] recovered → needs_routing');
    } catch (err) {
      failed.push({ batch, err: err.message });
      logger.error({ err, batchId: batch.id }, '[stuck-payout-cron] recovery failed');
    }
  }

  // ── 3. Alert email ────────────────────────────────────────────────────────
  try {
    const rows = stuck.map(b => {
      const wasRecovered = recovered.some(r => r.id === b.id);
      const failErr      = (failed.find(f => f.batch.id === b.id) || {}).err || '';
      const amountNaira  = b.total_kobo ? (Number(b.total_kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 }) : '—';
      return `<tr>
        <td>${b.batch_ref}</td>
        <td>${b.merchant_name} (${b.merchant_code})</td>
        <td>₦${amountNaira}</td>
        <td style="color:${wasRecovered ? '#1a7a1a' : '#c00'}">${wasRecovered ? '✓ Recovered → needs_routing' : '✗ Recovery failed: ' + failErr.slice(0, 60)}</td>
        <td style="font-size:11px;color:#888">${b.stuck_since ? b.stuck_since.slice(0, 19) : '—'}</td>
      </tr>`;
    }).join('');

    await sendEmail({
      to: ALERT_TO,
      subject: `[Paylode] ${recovered.length} stuck payout batch(es) auto-recovered`,
      html: `
        <p><strong>${stuck.length}</strong> payout batch(es) were found stuck in <code>processing</code>
        with no legs sent to the rail.  <strong>${recovered.length}</strong> recovered automatically
        (reset to <code>needs_routing</code> for re-dispatch); <strong>${failed.length}</strong> failed recovery.</p>
        <table border="1" cellpadding="6" cellspacing="0"
               style="border-collapse:collapse;font-size:13px;margin-top:10px">
          <tr style="background:#f5f5f5">
            <th>Batch Ref</th><th>Merchant</th><th>Amount</th>
            <th>Recovery</th><th>Stuck Since</th>
          </tr>
          ${rows}
        </table>
        <p style="margin-top:12px;font-size:12px;color:#666">
          Root cause: dispatchBatch crashed after setup tx but before rail transfer
          (e.g. config error, uncaught exception).  Check logs around the stuck_since
          timestamp for the original error.<br>
          Server: 176.57.188.45 · /opt/paylode-api
        </p>`,
    });
  } catch (mailErr) {
    logger.error({ err: mailErr.message }, '[stuck-payout-cron] alert email failed');
  }

  return { found: stuck.length, recovered: recovered.length, failed: failed.length };
}

module.exports = { recoverStuckPayouts, INTERVAL_S };
