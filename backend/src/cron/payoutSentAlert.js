'use strict';
/**
 * payoutSentAlert — cron that fires every 10 minutes.
 * Finds rail_disbursements legs stuck in 'sent' for > 20 minutes and emails an alert.
 * "Sent" means money left our Parallex account but no success/failure confirmation yet.
 *
 * PM2 ecosystem entry:
 *   { name: 'payout-sent-alert', script: 'src/cron/payoutSentAlert.js',
 *     exec_mode: 'fork', instances: 1,
 *     cron_restart: '*\/10 * * * *', autorestart: false,
 *     env: { NODE_ENV: 'production' } }
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { PrismaClient } = require('@prisma/client');
const { sendEmail }    = require('../services/emailService');

const p = new PrismaClient();
const ALERT_TO       = 'gokeakinboro@gmail.com';
const STUCK_MINS     = 20;

(async () => {
  const cutoff = new Date(Date.now() - STUCK_MINS * 60 * 1000);

  const stuck = await p.$queryRawUnsafe(`
    SELECT
      rd.id            AS leg_id,
      rd.rail_order_id,
      rd.sent_at,
      rd.rail_cost,
      pi.amount,
      pi.account_number,
      pi.bank_name,
      pi.status        AS item_status,
      m.business_name,
      m.merchant_code,
      pr.name          AS rail_name
    FROM rail_disbursements rd
    JOIN payout_items pi  ON pi.id  = rd.payout_item_id
    JOIN merchants m      ON m.id   = pi.merchant_id
    JOIN payment_rails pr ON pr.id  = rd.rail_id
    WHERE rd.status = 'sent'
      AND rd.sent_at < $1
    ORDER BY rd.sent_at ASC
  `, cutoff);

  if (!stuck.length) {
    console.log('[payout-sent-alert]', new Date().toISOString(), 'OK — no stuck sent legs');
    await p.$disconnect();
    return;
  }

  const rows = stuck.map(r => {
    const ageMin = Math.round((Date.now() - new Date(r.sent_at).getTime()) / 60000);
    return `<tr>
      <td>${r.merchant_code || '-'}</td>
      <td>${r.business_name || '-'}</td>
      <td>${r.rail_name}</td>
      <td>₦${(Number(r.amount) / 100).toLocaleString()}</td>
      <td>${r.account_number} / ${r.bank_name || '-'}</td>
      <td>${r.rail_order_id || '-'}</td>
      <td style="color:#c00"><strong>${ageMin} min</strong></td>
      <td>${r.item_status}</td>
    </tr>`;
  }).join('');

  const totalKobo = stuck.reduce((s, r) => s + Number(r.amount || 0), 0);

  await sendEmail({
    to: ALERT_TO,
    subject: `[Paylode] ⚠️ ${stuck.length} payout leg(s) stuck as SENT > ${STUCK_MINS} min`,
    html: `<p><strong>${stuck.length}</strong> payout disbursement leg(s) have been in <code>sent</code> status
           for more than ${STUCK_MINS} minutes (total: ₦${(totalKobo / 100).toLocaleString()}).</p>
           <p>The reconciler runs every 3 minutes and will close these automatically. This alert fires
           when legs persist beyond ${STUCK_MINS} minutes — investigate if any remain after 30 minutes.</p>
           <table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:12px">
           <tr style="background:#f5f5f5">
             <th>Code</th><th>Merchant</th><th>Rail</th><th>Amount</th>
             <th>Account</th><th>Order ID</th><th>Age</th><th>Item Status</th>
           </tr>
           ${rows}
           </table>
           <p style="margin-top:12px;font-size:11px;color:#666">
             To close manually: UPDATE rail_disbursements SET status='failed' WHERE id='&lt;leg_id&gt;' AND status='sent';<br>
             Server: 176.57.188.45 · payout-sent-alert
           </p>`,
  });

  console.log('[payout-sent-alert]', new Date().toISOString(),
    `ALERT sent — ${stuck.length} stuck legs, ₦${(totalKobo / 100).toLocaleString()}`);

  await p.$disconnect();
})().catch(e => {
  console.error('[payout-sent-alert] ERROR:', e.message);
  process.exit(1);
});
