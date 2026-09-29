'use strict';
/**
 * palmpayBalanceGuard — runs every 10 min.
 * Watches PalmPay balance. When it drops below ₦2M:
 *   1. Switches any merchant pinned to PalmPay back to Parallex (if Parallex is up)
 *   2. Emails an alert
 *
 * PM2 ecosystem entry:
 *   { name: 'palmpay-balance-guard', script: 'src/cron/palmpayBalanceGuard.js',
 *     exec_mode: 'fork', instances: 1,
 *     cron_restart: '*\/10 * * * *', autorestart: false,
 *     env: { NODE_ENV: 'production' } }
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { PrismaClient } = require('@prisma/client');
const { sendEmail }    = require('../services/emailService');
const palmpay          = require('../modules/gateway-core/services/palmpayService');
const parallex         = require('../modules/gateway-core/services/parallexTransferService');

const p = new PrismaClient();

const LOW_KOBO         = 200_000_000n;  // ₦2M threshold
const PALMPAY_RAIL_ID  = '101976a6-74c4-45b4-965c-b54d29a0de69';
const PARALLEX_RAIL_ID = '8fbc8c22-daba-4fcb-98ee-33ce7d8ffc74';
const ALERT_TO         = 'financeadmin@paylodeservices.com';
const ALERT_CC         = 'gokeakinboro@paylodeservices.com';

(async () => {
  let pmBal;
  try {
    pmBal = BigInt(await palmpay.getBalance());
  } catch (e) {
    console.error('PalmPay getBalance failed:', e.message);
    await p.$disconnect();
    return;
  }

  const pmNaira = (Number(pmBal) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
  console.log(`PalmPay balance: ₦${pmNaira}`);

  if (pmBal >= LOW_KOBO) {
    console.log('Balance above threshold — no action.');
    await p.$disconnect();
    return;
  }

  console.log('Balance below ₦2M — checking for merchants pinned to PalmPay…');

  // Find merchants currently pinned to PalmPay
  const pinned = await p.$queryRawUnsafe(
    `SELECT id::text, business_name FROM merchants WHERE payout_rail_id = '${PALMPAY_RAIL_ID}'::uuid AND is_active = true`
  );

  // Check if Parallex is available before switching
  let parallexUp = false;
  try {
    await parallex.getBalance();
    parallexUp = true;
  } catch (_) {
    parallexUp = false;
  }

  const switched = [];
  if (pinned.length > 0 && parallexUp) {
    await p.$queryRawUnsafe(
      `UPDATE merchants SET payout_rail_id = '${PARALLEX_RAIL_ID}'::uuid, updated_at = NOW() WHERE payout_rail_id = '${PALMPAY_RAIL_ID}'::uuid AND is_active = true`
    );
    switched.push(...pinned.map(m => m.business_name));
    console.log('Switched back to Parallex:', switched.join(', '));
  } else if (pinned.length > 0 && !parallexUp) {
    console.warn('Parallex still down — cannot switch back yet. Alert sent.');
  }

  const parallexStatus = parallexUp ? 'UP — merchants switched back' : 'STILL DOWN — merchants remain on PalmPay';

  if (process.env.PALMPAY_GUARD_ALERTS !== 'false') {
    await sendEmail({
      to: ALERT_TO,
      cc: ALERT_CC,
      subject: `⚠️ PalmPay balance low — ₦${pmNaira}`,
      html: `
        <p>PalmPay payout balance has dropped below the ₦2,000,000 threshold.</p>
        <table style="border-collapse:collapse;font-family:monospace">
          <tr><td style="padding:4px 12px"><b>Current balance</b></td><td>₦${pmNaira}</td></tr>
          <tr><td style="padding:4px 12px"><b>Threshold</b></td><td>₦2,000,000.00</td></tr>
          <tr><td style="padding:4px 12px"><b>Parallex status</b></td><td>${parallexStatus}</td></tr>
          ${switched.length > 0 ? `<tr><td style="padding:4px 12px"><b>Switched to Parallex</b></td><td>${switched.join(', ')}</td></tr>` : ''}
        </table>
        ${!parallexUp ? '<p><b>Action required:</b> Fund PalmPay or wait for Parallex to recover.</p>' : ''}
        <p style="color:#888;font-size:12px">palmpayBalanceGuard · ${new Date().toISOString()}</p>
      `,
    });
    console.log('Alert sent.');
  } else {
    console.log('Alert suppressed (PALMPAY_GUARD_ALERTS=false).');
  }
  await p.$disconnect();
})().catch(async e => {
  console.error('palmpayBalanceGuard error:', e.message);
  await p.$disconnect().catch(() => {});
  process.exit(1);
});
