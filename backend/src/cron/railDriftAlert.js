'use strict';
/**
 * railDriftAlert — runs twice daily (08:00 and 18:00 WAT = 07:00 and 17:00 UTC).
 * For each active payout rail, compares:
 *   • Live bank/wallet balance (from rail adapter API)
 *   • Sum of merchant wallet balances on that rail in Paylode DB
 * Emails an alert if drift exceeds ₦10,000 (1,000,000 kobo) on any rail.
 *
 * PM2 ecosystem entry:
 *   { name: 'rail-drift-alert', script: 'src/cron/railDriftAlert.js',
 *     exec_mode: 'fork', instances: 1,
 *     cron_restart: '0 7,17 * * *', autorestart: false,
 *     env: { NODE_ENV: 'production' } }
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { PrismaClient }   = require('@prisma/client');
const { sendEmail }      = require('../services/emailService');
const parallexTransfer   = require('../modules/gateway-core/services/parallexTransferService');
const palmpayService     = require('../modules/gateway-core/services/palmpayService');

const p            = new PrismaClient();
const ALERT_TO     = 'gokeakinboro@gmail.com';
const DRIFT_KOBO   = 1_000_000n; // ₦10,000

const ADAPTERS = [
  { railPattern: /parallex/i, name: 'Parallex Bank', svc: parallexTransfer },
  { railPattern: /palmpay/i,  name: 'PalmPay',       svc: palmpayService   },
];

(async () => {
  const snapTime = new Date().toISOString();

  // Sum of merchant wallet balances per rail
  const walletSums = await p.$queryRawUnsafe(`
    SELECT pr.name AS rail_name, SUM(mw.balance) AS total_balance
    FROM merchant_wallets mw
    JOIN payment_rails pr ON pr.id = mw.rail_id
    GROUP BY pr.name
  `);

  const results = [];

  for (const { railPattern, name, svc } of ADAPTERS) {
    const row = walletSums.find(r => railPattern.test(r.rail_name));
    const merchantSum = BigInt(row?.total_balance || 0);

    let liveKobo = null;
    let liveErr  = null;
    if (svc.isConfigured()) {
      try {
        liveKobo = BigInt(await svc.getBalance());
      } catch (e) {
        liveErr = e.message;
      }
    } else {
      liveErr = 'not configured';
    }

    if (liveKobo !== null) {
      const drift = liveKobo - merchantSum;
      results.push({ name, liveKobo, merchantSum, drift, ok: drift >= -DRIFT_KOBO });
    } else {
      results.push({ name, liveKobo: null, merchantSum, drift: null, ok: false, err: liveErr });
    }
  }

  const hasAlert = results.some(r => !r.ok);

  const fmt = (kobo) => kobo === null ? 'N/A' : '₦' + (Number(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
  const driftColor = (r) => {
    if (r.drift === null) return '#c00';
    if (r.drift < -DRIFT_KOBO) return '#c00';
    if (r.drift < 0n) return '#e80';
    return '#060';
  };

  const rows = results.map(r =>
    `<tr>
      <td>${r.name}</td>
      <td>${fmt(r.liveKobo)}</td>
      <td>${fmt(r.merchantSum)}</td>
      <td style="color:${driftColor(r)}"><strong>${r.drift !== null ? fmt(r.drift) : 'ERROR: ' + r.err}</strong></td>
      <td style="color:${r.ok ? '#060' : '#c00'}">${r.ok ? '✓ OK' : '⚠ INVESTIGATE'}</td>
    </tr>`
  ).join('');

  const subject = hasAlert
    ? `[Paylode] ⚠️ Rail balance drift detected — ${results.filter(r => !r.ok).map(r => r.name).join(', ')}`
    : `[Paylode] ✓ Rail balance drift check OK`;

  if (hasAlert) {
    await sendEmail({
      to: ALERT_TO,
      subject,
      html: `<p>Rail balance drift check at ${snapTime}. One or more rails show drift &gt; ₦10,000:</p>
             <table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:13px">
             <tr style="background:#f5f5f5">
               <th>Rail</th><th>Live Bank Balance</th><th>Merchant Wallets (DB)</th><th>Drift (bank − DB)</th><th>Status</th>
             </tr>
             ${rows}
             </table>
             <p style="margin-top:12px;font-size:11px;color:#666">
               Negative drift means DB wallets > bank balance — merchants are owed more than the bank holds.<br>
               Common causes: NIP fees not deducted from merchant wallets, or a double-credit in DB.<br>
               Server: 176.57.188.45 · rail-drift-alert
             </p>`,
    });
    console.log('[rail-drift-alert]', snapTime, 'ALERT sent —', subject);
  } else {
    console.log('[rail-drift-alert]', snapTime, 'OK — no drift > ₦10,000');
  }

  await p.$disconnect();
})().catch(e => {
  console.error('[rail-drift-alert] ERROR:', e.message);
  process.exit(1);
});
