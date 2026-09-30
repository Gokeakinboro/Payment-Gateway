'use strict';
/**
 * Payout stuck-item escalation alert.
 * Every 30 min: finds payout_items that have been in 'held' or
 * 'failed + refund_status=pending_review' for longer than ALERT_AFTER_MS,
 * and emails a digest so they can be reviewed and manually resolved.
 *
 * READ-ONLY — makes zero DB writes. No auto-refunds, no wallet touches.
 * Resolution is always manual: SA dashboard → Approve Refund / No Refund.
 *
 * PM2 entry (ecosystem.config.js):
 *   { name: 'payout-stuck-alert', script: 'src/cron/payoutStuckAlert.js',
 *     exec_mode: 'fork', instances: 1,
 *     cron_restart: '0 * * * *', autorestart: false,
 *     env: { NODE_ENV: 'production' } }
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { PrismaClient } = require('@prisma/client');
const { sendEmail }    = require('../services/emailService');
const { logger }       = require('../utils/logger');

const p          = new PrismaClient();
const ALERT_TO   = 'gokeakinboro@paylodeservices.com';
const ALERT_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

function age(createdAt) {
  const ms  = Date.now() - new Date(createdAt).getTime();
  const hrs = Math.floor(ms / 3_600_000);
  const min = Math.floor((ms % 3_600_000) / 60_000);
  return hrs > 0 ? `${hrs}h ${min}m` : `${min}m`;
}

async function run() {
  try {
    const cutoff = new Date(Date.now() - ALERT_AFTER_MS);

    const rows = await p.$queryRawUnsafe(`
      SELECT
        pi.id,
        pi.status,
        pi.refund_status,
        pi.amount,
        pi.bank_code,
        pi.account_number,
        pi.account_name,
        pi.failure_reason,
        pi.created_at,
        pb.batch_ref,
        m.business_name,
        m.merchant_code,
        pr.name AS rail_name
      FROM payout_items pi
      JOIN payout_batches pb ON pb.id = pi.batch_id
      JOIN merchants m       ON m.id  = pi.merchant_id
      LEFT JOIN payment_rails pr ON pr.id = pb.rail_id
      WHERE
        pi.created_at < $1
        AND (
          pi.status = 'held'
          OR (pi.status = 'failed' AND pi.refund_status = 'pending_review')
        )
      ORDER BY pi.created_at ASC
      LIMIT 100
    `, cutoff);

    if (!rows.length) {
      logger.info('[stuck-alert] no stuck items older than 6h');
      await p.$disconnect();
      return;
    }

    const heldCount           = rows.filter(r => r.status === 'held').length;
    const pendingReviewCount  = rows.filter(r => r.status === 'failed' && r.refund_status === 'pending_review').length;
    const totalNaira          = rows.reduce((s, r) => s + Number(r.amount) / 100, 0);

    const tableRows = rows.map(r => `
      <tr>
        <td>${r.merchant_code || '-'}</td>
        <td>${r.business_name || '-'}</td>
        <td style="font-weight:600">₦${(Number(r.amount) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td>
        <td>${r.bank_code} / ${r.account_number}</td>
        <td>${r.account_name || '-'}</td>
        <td>
          <span style="background:${r.status === 'held' ? '#fef3c7' : '#fee2e2'};
                       color:${r.status === 'held' ? '#92400e' : '#991b1b'};
                       padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600">
            ${r.status === 'held' ? 'HELD' : 'FAILED / pending review'}
          </span>
        </td>
        <td style="color:#666;font-size:11px">${age(r.created_at)} ago</td>
        <td style="font-size:11px;color:#555;max-width:220px">${r.batch_ref}</td>
        <td style="font-size:11px;color:#555;max-width:220px">${(r.failure_reason || '').slice(0, 120)}</td>
      </tr>`).join('');

    await sendEmail({
      to: ALERT_TO,
      subject: `⚠️ [Paylode] ${rows.length} payout item(s) need review — ₦${totalNaira.toLocaleString('en-NG', { minimumFractionDigits: 2 })} at risk`,
      html: `
        <p>The following payout items have been stuck for <strong>more than 6 hours</strong> and need manual review.</p>
        <p>
          <strong>${heldCount}</strong> held for manual review &nbsp;·&nbsp;
          <strong>${pendingReviewCount}</strong> failed / pending wallet refund approval
        </p>
        <p style="color:#b91c1c;font-weight:600">
          Total amount: ₦${totalNaira.toLocaleString('en-NG', { minimumFractionDigits: 2 })}
        </p>
        <p>
          Go to <strong>SA Dashboard → Payouts → Stuck Payouts</strong>.<br>
          Use <strong>Check Rail</strong> to confirm status from Parallex, then <strong>Refund to Wallet</strong> (if NO RECORD) or <strong>No Refund</strong> (if settled).
        </p>

        <table border="1" cellpadding="6" cellspacing="0"
               style="border-collapse:collapse;font-size:13px;margin-top:12px;width:100%">
          <thead>
            <tr style="background:#f3f4f6;font-size:12px">
              <th>Code</th>
              <th>Merchant</th>
              <th>Amount</th>
              <th>Bank / Account</th>
              <th>Name</th>
              <th>Status</th>
              <th>Age</th>
              <th>Batch Ref</th>
              <th>Failure Reason</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>

        <p style="margin-top:16px;font-size:12px;color:#d00">
          ⚠ No automatic action has been taken. Wallet credits require your explicit approval.
        </p>
        <p style="font-size:11px;color:#999">payout-stuck-alert · 176.57.188.45</p>
      `,
    });

    logger.info({ count: rows.length, heldCount, pendingReviewCount }, '[stuck-alert] digest sent');
  } catch (e) {
    logger.error({ err: e.message }, '[stuck-alert] run error');
  } finally {
    await p.$disconnect();
  }
}

run();
