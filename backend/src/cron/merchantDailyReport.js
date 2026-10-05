'use strict';
/**
 * merchantDailyReport.js — Daily payout-by-bank report for Bucksnostar.
 *
 * Runs at 6am WAT (05:00 UTC) every day via PM2 cron_restart.
 * Queries successful payout items for Bucksnostar from the 1st of the
 * current month through today, groups by destination bank, and emails
 * the breakdown to the super-admin.
 *
 * PM2 ecosystem entry:
 *   {
 *     name: 'bucksnostar-daily-report',
 *     script: 'src/cron/merchantDailyReport.js',
 *     cwd: '/opt/paylode-api/backend',
 *     cron_restart: '0 5 * * *',   // 05:00 UTC = 06:00 WAT
 *     autorestart: false,
 *   }
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { prisma } = require('../utils/db');
const { sendEmail } = require('../services/emailService');

const MERCHANT_ID   = 'f4530c4c-015a-4d18-af38-cd918a0997e3';
const MERCHANT_NAME = 'Bucksnostar';
const REPORT_TO     = 'gokeakinboro@gmail.com';

// Canonical display names for known bank codes (Parallex institution codes).
const CODE_TO_NAME = {
  '100004': 'OPay',
  '100033': 'PalmPay',
  '090267': 'Kuda MFB',
  '090405': 'Moniepoint MFB',
  '090551': 'FairMoney MFB',
  '100026': 'Carbon MFB',
  '090110': 'VFD MFB',
  '120001': '9PSB',
  '090567': 'Flutterwave MFB',
  '090986': 'Paystack MFB',
  '100014': 'FirstMonie Wallet',
  '000016': 'First Bank',
  '000015': 'Zenith Bank',
  '000013': 'GTBank',
  '000004': 'UBA',
  '000014': 'Access Bank',
  '000007': 'Fidelity Bank',
  '000018': 'Union Bank',
  '000003': 'FCMB',
  '000010': 'Ecobank',
  '000012': 'Stanbic IBTC',
  '000001': 'Sterling Bank',
  '000017': 'Wema Bank',
  '000002': 'Keystone Bank',
  '000008': 'Polaris Bank',
  '000023': 'Providus Bank',
  '000030': 'Parallex Bank',
  '000006': 'Jaiz Bank',
  '000025': 'Titan Trust Bank',
  '000029': 'Lotus Bank',
};

const log = (msg) => console.log('[merchant-daily-report]', new Date().toISOString(), msg);

function fmtNaira(kobo) {
  return '₦' + (Number(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function run() {
  const now      = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const dateLabel  = now.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
  const fromLabel  = monthStart.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });

  log(`Generating report for ${MERCHANT_NAME}: ${fromLabel} – ${dateLabel}`);

  const rawRows = await prisma.$queryRawUnsafe(`
    SELECT
      pi.bank_code,
      NULLIF(TRIM(pi.bank_name),'') AS bank_name,
      COUNT(*)::int                 AS count,
      SUM(pi.amount)::text          AS total_kobo
    FROM payout_items pi
    JOIN payout_batches pb ON pb.id = pi.batch_id
    WHERE pb.merchant_id = '${MERCHANT_ID}'::uuid
      AND pi.status = 'success'
      AND pi.created_at >= '${monthStart.toISOString()}'
      AND pi.created_at <  NOW() + INTERVAL '1 second'
    GROUP BY pi.bank_code, NULLIF(TRIM(pi.bank_name),'')
    ORDER BY SUM(pi.amount) DESC
  `);

  // bank_name column often stores the code string — prefer CODE_TO_NAME lookup first,
  // then fall back to stored bank_name only when it differs from the code, then raw code.
  const merged = {};
  for (const r of rawRows) {
    const storedName  = r.bank_name && r.bank_name !== r.bank_code ? r.bank_name : null;
    const displayName = CODE_TO_NAME[r.bank_code] || storedName || r.bank_code || 'Unknown';
    if (!merged[displayName]) merged[displayName] = { count: 0, total_kobo: 0n };
    merged[displayName].count      += r.count;
    merged[displayName].total_kobo += BigInt(r.total_kobo);
  }
  const rows = Object.entries(merged)
    .map(([bank, d]) => ({ bank, count: d.count, total_kobo: d.total_kobo.toString() }))
    .sort((a, b) => Number(BigInt(b.total_kobo) - BigInt(a.total_kobo)));

  const grandCount = rows.reduce((s, r) => s + r.count, 0);
  const grandKobo  = rows.reduce((s, r) => s + BigInt(r.total_kobo), 0n);

  if (grandCount === 0) {
    log('No successful payouts this month — skipping email.');
    return;
  }

  const tableRows = rows.map(r => {
    const pct = grandKobo > 0n
      ? ((Number(BigInt(r.total_kobo)) / Number(grandKobo)) * 100).toFixed(1)
      : '0.0';
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${r.bank}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${r.count.toLocaleString()}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">${fmtNaira(r.total_kobo)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${pct}%</td>
      </tr>`;
  }).join('');

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
      <div style="background:#0f172a;padding:20px 24px;border-radius:8px 8px 0 0">
        <div style="color:#fff;font-size:18px;font-weight:700">Paylode — Daily Payout Report</div>
        <div style="color:#94a3b8;font-size:13px;margin-top:4px">${MERCHANT_NAME} &nbsp;·&nbsp; ${fromLabel} – ${dateLabel}</div>
      </div>

      <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f8fafc">
              <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Bank</th>
              <th style="padding:10px 12px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Count</th>
              <th style="padding:10px 12px;text-align:right;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">Volume</th>
              <th style="padding:10px 12px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">%</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
          <tfoot>
            <tr style="background:#f8fafc;font-weight:700">
              <td style="padding:10px 12px;border-top:2px solid #e2e8f0">Total</td>
              <td style="padding:10px 12px;border-top:2px solid #e2e8f0;text-align:center">${grandCount.toLocaleString()}</td>
              <td style="padding:10px 12px;border-top:2px solid #e2e8f0;text-align:right;font-variant-numeric:tabular-nums">${fmtNaira(grandKobo.toString())}</td>
              <td style="padding:10px 12px;border-top:2px solid #e2e8f0;text-align:center">100%</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style="font-size:11px;color:#94a3b8;margin-top:12px;text-align:center">
        Paylode · Generated ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} WAT
      </div>
    </div>`;

  await sendEmail({
    to:      REPORT_TO,
    subject: `[${MERCHANT_NAME}] Payout breakdown ${fromLabel} – ${dateLabel}`,
    html,
  });

  log(`Report sent to ${REPORT_TO}. ${grandCount} txns / ${fmtNaira(grandKobo.toString())}`);
}

run()
  .then(() => prisma.$disconnect())
  .catch(e => { log('ERROR: ' + e.message); prisma.$disconnect(); process.exit(1); });
