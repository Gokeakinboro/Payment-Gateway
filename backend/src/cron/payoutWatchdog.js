'use strict';
/**
 * Paylode Payout Watchdog
 * Every 5 minutes:
 *  1. Find payout_items stuck in 'processing' for > 15 minutes
 *  2. Query Parallex to determine true status
 *  3. Auto-fix: mark success OR fail+refund based on Parallex response
 *  4. Email summary of fixes to Goke (only when something is fixed)
 */
require('dotenv').config({ path: '/opt/paylode-api/backend/.env' });
const { PrismaClient } = require('/opt/paylode-api/backend/node_modules/.prisma/client');
const { sendEmail } = require('/opt/paylode-api/backend/src/services/emailService');
const parallexTransfer = require('/opt/paylode-api/backend/src/modules/gateway-core/services/parallexTransferService');
const { logger } = require('/opt/paylode-api/backend/src/utils/logger');

const p = new PrismaClient();
const ALERT_TO = 'gokeakinboro@gmail.com';
const INTERVAL_MS = 5 * 60 * 1000;
const STUCK_THRESHOLD_MS = 15 * 60 * 1000;

const alreadyFixed = new Set();

async function autoFix(item, railOrderId) {
  // Guard: re-read live state before acting — another process (manual script, cron,
  // or a prior watchdog tick) may have already refunded or settled this item.
  const liveState = await p['$queryRawUnsafe'](
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

  let parallelStatus = null;
  try {
    const r = await parallexTransfer.queryPayoutResult({ orderId: railOrderId });
    parallelStatus = r;
  } catch (e) {
    logger.warn({ orderId: railOrderId, err: e.message }, '[watchdog] Parallex query failed');
  }

  const isSuccess = parallelStatus && (parallelStatus.orderStatus === '2');
  const isFailed  = !parallelStatus || parallelStatus.ok === false ||
                    (parallelStatus.orderStatus && parallelStatus.orderStatus !== '0' && parallelStatus.orderStatus !== '1' && parallelStatus.orderStatus !== '2');

  if (isSuccess) {
    // Mark leg + item as success
    await p['$queryRawUnsafe'](
      `UPDATE rail_disbursements SET status='success', settled_at=NOW(), updated_at=NOW() WHERE rail_order_id=$1`,
      railOrderId
    );
    await p['$queryRawUnsafe'](
      `UPDATE payout_items SET status='success', processed_at=NOW() WHERE id=$1::uuid`,
      item.id
    );
    return { action: 'success', reason: `Parallex orderStatus=${parallelStatus.orderStatus}` };
  }

  // Default: treat as failed, refund merchant
  const refundKobo = BigInt(item.amount) + BigInt(item.itemFee || 0) + BigInt(item.itemVat || 0);
  const floatKobo  = BigInt(item.amount) + BigInt(item.leg?.railCost || 0) + BigInt(item.leg?.railVat || 0);
  const failReason = parallelStatus
    ? `Watchdog: Parallex ${parallelStatus.orderStatus || 'no record'} — ${parallelStatus.reason || 'auto-resolved'}`
    : 'Watchdog: Parallex query failed — auto-resolved after 15 min';

  // Refund float
  if (item.leg?.railId) {
    await p['$queryRawUnsafe'](
      `UPDATE payment_rails SET float_balance=float_balance+$1, updated_at=NOW() WHERE id=$2::uuid`,
      floatKobo, item.leg.railId
    );
  }

  // Credit merchant wallet + write REVERSAL ledger
  // Target the specific rail wallet (leg.railId); fall back to the highest-balance
  // wallet if the leg has no railId. Never update ALL wallets — that causes over-refunds.
  const walletRows = item.leg?.railId
    ? await p['$queryRawUnsafe'](
        `UPDATE merchant_wallets SET balance=balance+$1, updated_at=NOW()
         WHERE merchant_id=$2::uuid AND rail_id=$3::uuid
         RETURNING id, balance-$1 AS bal_before, balance AS bal_after`,
        refundKobo, item.merchantId, item.leg.railId
      )
    : await p['$queryRawUnsafe'](
        `UPDATE merchant_wallets SET balance=balance+$1, updated_at=NOW()
         WHERE id=(SELECT id FROM merchant_wallets WHERE merchant_id=$2::uuid ORDER BY balance DESC LIMIT 1)
         RETURNING id, balance-$1 AS bal_before, balance AS bal_after`,
        refundKobo, item.merchantId
      );
  const wallet = walletRows[0];
  if (wallet) {
    const railId = item.leg?.railId;
    await p['$queryRawUnsafe'](
      `INSERT INTO wallet_ledger(merchant_id,rail_id,entry_type,amount,balance_before,balance_after,reference,description,created_by,created_at)
       VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,NULL,NOW())`,
      item.merchantId, railId || null, 'REVERSAL', refundKobo,
      wallet.bal_before, wallet.bal_after,
      railOrderId || item.id,
      'Watchdog auto-refund: ' + failReason.slice(0, 200)
    );
  }

  // Mark leg + item failed
  await p['$queryRawUnsafe'](
    `UPDATE rail_disbursements SET status='failed', error_msg=$1, updated_at=NOW() WHERE id=$2::uuid`,
    failReason.slice(0, 280), item.leg?.id
  );
  await p['$queryRawUnsafe'](
    `UPDATE payout_items
     SET status='failed', failure_reason=$1, refund_status='approved',
         refund_reviewed_at=NOW(), refund_reviewed_by=NULL, refund_amount=$2
     WHERE id=$3::uuid`,
    failReason.slice(0, 280), refundKobo, item.id
  );

  return {
    action: 'failed+refunded',
    refundKobo: Number(refundKobo),
    reason: failReason,
  };
}

async function check() {
  try {
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);

    const stuckRows = await p['$queryRawUnsafe'](`
      SELECT pi.id, pi.amount, pi.item_fee AS "itemFee", pi.item_vat AS "itemVat",
             pi.bank_code AS "bankCode", pi.account_number AS "accountNumber",
             pi.merchant_id AS "merchantId", pi.created_at AS "createdAt",
             m.business_name AS "businessName", m.merchant_code AS "merchantCode",
             rd.id AS "legId", rd.rail_order_id AS "railOrderId",
             rd.rail_cost AS "railCost", rd.rail_vat AS "railVat", rd.rail_id AS "railId"
      FROM payout_items pi
      JOIN payout_batches pb ON pb.id = pi.batch_id
      JOIN merchants m ON m.id = pi.merchant_id
      LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id AND rd.sent_at IS NOT NULL
      WHERE pi.status = 'processing' AND pi.created_at < $1
    `, cutoff);

    // Deduplicate by item id (multi-leg items appear multiple times)
    const seen = new Map();
    for (const row of stuckRows) {
      if (!seen.has(row.id)) seen.set(row.id, { ...row, leg: row.legId ? { id: row.legId, railOrderId: row.railOrderId, railCost: row.railCost, railVat: row.railVat, railId: row.railId } : null });
    }
    const stuck = [...seen.values()];

    const fresh = stuck.filter(i => !alreadyFixed.has(i.id));
    if (!fresh.length) {
      logger.info({ checked: stuck.length }, '[watchdog] tick OK — no stuck items');
      return;
    }

    const results = [];
    for (const item of fresh) {
      const leg = item.disbursements?.[0] || null;
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

    // Email summary
    const rows = results.map(({ item, outcome }) => {
      return `<tr>
        <td>${item.merchantCode || '-'}</td>
        <td>${item.businessName || '-'}</td>
        <td>₦${(Number(item.amount)/100).toLocaleString()}</td>
        <td>${item.bankCode} / ${item.accountNumber}</td>
        <td><strong>${outcome.action}</strong></td>
        <td style="font-size:11px;color:#666">${(outcome.reason||'').slice(0,80)}</td>
      </tr>`;
    }).join('');

    await sendEmail({
      to: ALERT_TO,
      subject: `[Paylode Watchdog] Auto-fixed ${results.length} stuck payout(s)`,
      html: `<p>Paylode watchdog detected and auto-fixed <strong>${results.length}</strong> payout item(s) stuck in processing for &gt;15 minutes:</p>
             <table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:13px">
             <tr style="background:#f5f5f5"><th>Code</th><th>Merchant</th><th>Amount</th><th>Bank/Account</th><th>Action Taken</th><th>Reason</th></tr>
             ${rows}
             </table>
             <p style="margin-top:12px;font-size:12px;color:#666">Server: 176.57.188.45 · /opt/paylode-api</p>`,
    });

    logger.info({ fixed: results.length }, '[watchdog] tick complete — email sent');
  } catch (e) {
    logger.error({ err: e.message }, '[watchdog] check error');
  }
}

check();
setInterval(check, INTERVAL_MS);
logger.info('[watchdog] Paylode payout watchdog started (5-min interval, auto-fix enabled)');
