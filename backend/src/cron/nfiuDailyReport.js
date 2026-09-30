'use strict';
/**
 * nfiuDailyReport.js — Daily NFIU compliance reports for Paylode Services.
 *
 * Generates and emails two CBN/NFIU-required reports for the previous calendar day:
 *   1. Large Transaction Report (LTR) — all transactions ≥ ₦5,000,000
 *   2. Suspicious Transaction Report (STR) — structuring, velocity, and reversal patterns
 *
 * Runs at 00:01 WAT (23:01 UTC previous day) via PM2 cron_restart.
 * Covers the full preceding calendar day in WAT (UTC+1).
 *
 * PM2 ecosystem entry:
 *   {
 *     name: 'nfiu-daily-report',
 *     script: 'src/cron/nfiuDailyReport.js',
 *     cwd: '/opt/paylode-api/backend',
 *     cron_restart: '1 23 * * *',   // 23:01 UTC = 00:01 WAT next day
 *     autorestart: false,
 *   }
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { prisma } = require('../utils/db');
const { sendEmail } = require('../services/emailService');

const REPORT_TO  = 'financeadmin@paylodeservices.com';
const REPORT_CC  = 'gokeakinboro@paylodeservices.com';

// NFIU LTR threshold: ₦5,000,000 (single transaction)
const LTR_KOBO = 500_000_000n;

// STR: flag if same customer email has ≥ 5 transactions in one day
const STR_VELOCITY_COUNT = 5;
// STR structuring: 3+ transactions each < LTR_KOBO but total ≥ ₦3M
const STR_STRUCT_TOTAL_KOBO = 300_000_000n;
const STR_STRUCT_MIN_COUNT  = 3;
// STR reversal: reversed transactions ≥ ₦1M
const STR_REVERSAL_KOBO = 100_000_000n;

function csvRow(vals) {
  return vals.map(v => {
    const s = v == null ? '' : String(v).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
  }).join(',');
}

function buildCsv(headers, rows) {
  return [csvRow(headers), ...rows.map(r => csvRow(r))].join('\r\n');
}

function plainAmt(kobo) {
  return (Number(kobo) / 100).toFixed(2);
}

function fmt(kobo) {
  return '₦' + (Number(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  return new Date(d).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
}

// WAT midnight boundaries for the reporting day.
// BACKFILL_DAYS_AGO=N shifts the window N days into the past (default 1 = yesterday).
function yesterdayWAT() {
  const daysAgo = parseInt(process.env.BACKFILL_DAYS_AGO || '1', 10);
  const now = new Date();
  const watNow = new Date(now.getTime() + 60 * 60 * 1000); // UTC+1
  const watTarget = new Date(watNow);
  watTarget.setUTCDate(watTarget.getUTCDate() - daysAgo);
  const from = new Date(Date.UTC(watTarget.getUTCFullYear(), watTarget.getUTCMonth(), watTarget.getUTCDate()) - 60 * 60 * 1000);
  const to   = new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { from, to };
}

function tbl(headers, rows, emptyMsg) {
  if (!rows.length) return `<p style="color:#666;font-style:italic">${emptyMsg}</p>`;
  const th = headers.map(h => `<th style="padding:8px 12px;background:#1a3c5e;color:#fff;text-align:left;font-size:12px;white-space:nowrap">${h}</th>`).join('');
  const tr = rows.map((r, i) => {
    const bg = i % 2 === 0 ? '#f8f9fa' : '#fff';
    const td = r.map(c => `<td style="padding:7px 12px;font-size:12px;border-bottom:1px solid #e5e7eb;white-space:nowrap">${c ?? ''}</td>`).join('');
    return `<tr style="background:${bg}">${td}</tr>`;
  }).join('');
  return `<div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;min-width:600px"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

function section(title, badge, content) {
  return `
    <div style="margin-bottom:32px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;border-bottom:2px solid #1a3c5e;padding-bottom:8px">
        <h2 style="margin:0;font-size:15px;color:#1a3c5e;font-family:sans-serif">${title}</h2>
        <span style="background:${badge.bg};color:${badge.fg};border-radius:12px;padding:2px 10px;font-size:11px;font-weight:700">${badge.label}</span>
      </div>
      ${content}
    </div>`;
}

async function run() {
  const { from, to } = yesterdayWAT();
  const reportDate = from.toLocaleDateString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'full' });

  const ltrThresh = Number(LTR_KOBO);
  const strRevThresh = Number(STR_REVERSAL_KOBO);
  const strStructThresh = Number(STR_STRUCT_TOTAL_KOBO);

  // ── 1. LTR — card/VA/USSD collections ≥ ₦5M ─────────────────────────────────
  const ltrCollections = await prisma.$queryRawUnsafe(`
    SELECT t.reference, t.customer_email, t.amount, t.channel, t.status,
           m.business_name AS merchant, t.paid_at, t.created_at
    FROM transactions t
    JOIN merchants m ON m.id = t.merchant_id
    WHERE t.amount >= ${ltrThresh}
      AND t.is_sandbox = false
      AND t.created_at BETWEEN $1 AND $2
    ORDER BY t.amount DESC`,
    from, to
  );

  // ── 2. LTR — wallet funding credits ≥ ₦5M ───────────────────────────────────
  // Merchants fund payout wallets via large bank transfers; these appear in
  // wallet_ledger as CREDIT entries and must be declared as large transactions.
  const ltrFunding = await prisma.$queryRawUnsafe(`
    SELECT wl.reference, wl.amount, wl.description, wl.created_at,
           m.business_name AS merchant
    FROM wallet_ledger wl
    JOIN merchants m ON m.id = wl.merchant_id
    WHERE wl.entry_type = 'CREDIT'
      AND wl.amount >= ${ltrThresh}
      AND wl.created_at BETWEEN $1 AND $2
    ORDER BY wl.amount DESC`,
    from, to
  );

  // ── 3. LTR — payout items ≥ ₦5M ─────────────────────────────────────────────
  const ltrPayouts = await prisma.$queryRawUnsafe(`
    SELECT pi.id, pi.account_number, pi.account_name, pi.bank_name,
           pi.amount, pi.status, pi.narration, pi.processed_at,
           pb.batch_ref, m.business_name AS merchant
    FROM payout_items pi
    JOIN payout_batches pb ON pb.id = pi.batch_id
    JOIN merchants m ON m.id = pb.merchant_id
    WHERE pi.amount >= ${ltrThresh}
      AND pi.created_at BETWEEN $1 AND $2
    ORDER BY pi.amount DESC`,
    from, to
  );

  // ── 4. STR — high-velocity customer (same email, ≥ 5 collections) ────────────
  const strVelocity = await prisma.$queryRawUnsafe(`
    SELECT t.customer_email, COUNT(*) AS txn_count,
           SUM(t.amount) AS total_kobo, MAX(m.business_name) AS merchant
    FROM transactions t
    JOIN merchants m ON m.id = t.merchant_id
    WHERE t.is_sandbox = false
      AND t.created_at BETWEEN $1 AND $2
      AND t.customer_email IS NOT NULL AND t.customer_email != ''
    GROUP BY t.customer_email
    HAVING COUNT(*) >= ${STR_VELOCITY_COUNT}
    ORDER BY txn_count DESC`,
    from, to
  );

  // ── 5. STR — payout beneficiary velocity (same account, ≥ 5 payouts in day) ──
  const strPayoutVelocity = await prisma.$queryRawUnsafe(`
    SELECT pi.account_number, pi.bank_name, COUNT(*) AS payout_count,
           SUM(pi.amount) AS total_kobo, MAX(m.business_name) AS merchant
    FROM payout_items pi
    JOIN payout_batches pb ON pb.id = pi.batch_id
    JOIN merchants m ON m.id = pb.merchant_id
    WHERE pi.created_at BETWEEN $1 AND $2
    GROUP BY pi.account_number, pi.bank_name
    HAVING COUNT(*) >= ${STR_VELOCITY_COUNT}
    ORDER BY total_kobo DESC`,
    from, to
  );

  // ── 6. STR — structuring (3+ txns each < ₦5M but total ≥ ₦3M) ───────────────
  const strStructuring = await prisma.$queryRawUnsafe(`
    SELECT t.customer_email, COUNT(*) AS txn_count,
           SUM(t.amount) AS total_kobo, MAX(t.amount) AS max_single_kobo,
           MAX(m.business_name) AS merchant
    FROM transactions t
    JOIN merchants m ON m.id = t.merchant_id
    WHERE t.is_sandbox = false
      AND t.status = 'SUCCESS'
      AND t.amount < ${ltrThresh}
      AND t.created_at BETWEEN $1 AND $2
      AND t.customer_email IS NOT NULL AND t.customer_email != ''
    GROUP BY t.customer_email
    HAVING COUNT(*) >= ${STR_STRUCT_MIN_COUNT} AND SUM(t.amount) >= ${strStructThresh}
    ORDER BY total_kobo DESC`,
    from, to
  );

  // ── 7. STR — reversals ≥ ₦1M ─────────────────────────────────────────────────
  const strReversals = await prisma.$queryRawUnsafe(`
    SELECT t.reference, t.customer_email, t.amount, t.channel,
           m.business_name AS merchant, t.updated_at AS reversed_at
    FROM transactions t
    JOIN merchants m ON m.id = t.merchant_id
    WHERE t.status = 'REVERSED'
      AND t.amount >= ${strRevThresh}
      AND t.is_sandbox = false
      AND t.updated_at BETWEEN $1 AND $2
    ORDER BY t.amount DESC`,
    from, to
  );

  const ltrCount = ltrCollections.length + ltrFunding.length + ltrPayouts.length;
  const strCount = strVelocity.length + strPayoutVelocity.length + strStructuring.length + strReversals.length;
  const totalLtrValue = [...ltrCollections, ...ltrFunding, ...ltrPayouts].reduce((s, r) => s + BigInt(r.amount), 0n);

  // ── Build HTML ────────────────────────────────────────────────────────────────
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
<div style="max-width:860px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">

  <!-- Header -->
  <div style="background:#1a3c5e;padding:24px 32px;color:#fff">
    <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:.7;margin-bottom:4px">Paylode Services Limited — NFIU Compliance</div>
    <div style="font-size:20px;font-weight:700">Daily NFIU Regulatory Report</div>
    <div style="font-size:13px;margin-top:6px;opacity:.85">Period: ${reportDate} (00:00 – 23:59 WAT)</div>
  </div>

  <div style="padding:28px 32px">

    <!-- Summary chips -->
    <div style="display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap">
      <div style="flex:1;min-width:160px;background:#eff6ff;border-radius:8px;padding:14px 18px">
        <div style="font-size:11px;color:#3b82f6;font-weight:700;text-transform:uppercase;letter-spacing:.5px">LTR Transactions</div>
        <div style="font-size:24px;font-weight:700;color:#1e3a5f;margin-top:4px">${ltrCount}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px">Total: ${fmt(totalLtrValue)}</div>
      </div>
      <div style="flex:1;min-width:160px;background:${strCount > 0 ? '#fff7ed' : '#f0fdf4'};border-radius:8px;padding:14px 18px">
        <div style="font-size:11px;color:${strCount > 0 ? '#f97316' : '#16a34a'};font-weight:700;text-transform:uppercase;letter-spacing:.5px">STR Flags</div>
        <div style="font-size:24px;font-weight:700;color:#1e3a5f;margin-top:4px">${strCount}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px">${strCount > 0 ? 'Review required' : 'No flags'}</div>
      </div>
    </div>

    <!-- LTR Collections -->
    ${section('Large Transaction Report — Incoming Collections', { bg: '#dbeafe', fg: '#1d4ed8', label: 'LTR · COLLECTIONS' },
      tbl(
        ['Reference', 'Customer Email', 'Merchant', 'Amount', 'Channel', 'Status', 'Date'],
        ltrCollections.map(r => [
          `<code style="font-size:11px">${r.reference}</code>`,
          r.customer_email || '—',
          r.merchant,
          fmt(r.amount),
          r.channel,
          `<span style="font-weight:600;color:${r.status==='SUCCESS'?'#16a34a':'#dc2626'}">${r.status}</span>`,
          fmtDate(r.paid_at || r.created_at),
        ]),
        'No incoming collections met the ₦5,000,000 threshold yesterday.'
      )
    )}

    <!-- LTR Funding -->
    ${section('Large Transaction Report — Merchant Wallet Funding ≥ ₦5M', { bg: '#dbeafe', fg: '#1d4ed8', label: 'LTR · FUNDING' },
      tbl(
        ['Reference', 'Merchant', 'Description', 'Amount', 'Date'],
        ltrFunding.map(r => [
          `<code style="font-size:11px">${r.reference}</code>`,
          r.merchant,
          r.description || '—',
          fmt(r.amount),
          fmtDate(r.created_at),
        ]),
        'No wallet funding transactions met the ₦5,000,000 threshold yesterday.'
      )
    )}

    <!-- LTR Payouts -->
    ${section('Large Transaction Report — Outgoing Payouts', { bg: '#dbeafe', fg: '#1d4ed8', label: 'LTR · PAYOUTS' },
      tbl(
        ['Batch Ref', 'Merchant', 'Beneficiary', 'Account', 'Bank', 'Amount', 'Status', 'Date'],
        ltrPayouts.map(r => [
          `<code style="font-size:11px">${r.batch_ref}</code>`,
          r.merchant,
          r.account_name || '—',
          r.account_number,
          r.bank_name || '—',
          fmt(r.amount),
          `<span style="font-weight:600;color:${r.status==='success'?'#16a34a':'#dc2626'}">${r.status}</span>`,
          fmtDate(r.processed_at || r.created_at),
        ]),
        'No outgoing payouts met the ₦5,000,000 threshold yesterday.'
      )
    )}

    <!-- STR Velocity -->
    ${section('Suspicious Transaction Report — High-Velocity Customers', { bg: '#fef3c7', fg: '#b45309', label: 'STR · VELOCITY' },
      tbl(
        ['Customer Email', 'Merchant', 'Transaction Count', 'Total Amount'],
        strVelocity.map(r => [
          r.customer_email,
          r.merchant,
          r.txn_count.toString(),
          fmt(r.total_kobo),
        ]),
        `No customers exceeded ${STR_VELOCITY_COUNT} transactions yesterday.`
      )
    )}

    <!-- STR Payout Velocity -->
    ${section('Suspicious Transaction Report — Repeat Payout Beneficiaries (≥5 receipts/day)', { bg: '#fef3c7', fg: '#b45309', label: 'STR · PAYOUT VELOCITY' },
      tbl(
        ['Account Number', 'Bank', 'Merchant', 'Payout Count', 'Total Amount'],
        strPayoutVelocity.map(r => [
          r.account_number,
          r.bank_name || '—',
          r.merchant,
          r.payout_count.toString(),
          fmt(r.total_kobo),
        ]),
        `No payout beneficiary received ${STR_VELOCITY_COUNT}+ payouts yesterday.`
      )
    )}

    <!-- STR Structuring -->
    ${section('Suspicious Transaction Report — Possible Structuring', { bg: '#fef3c7', fg: '#b45309', label: 'STR · STRUCTURING' },
      tbl(
        ['Customer Email', 'Merchant', 'Count', 'Total Amount', 'Largest Single'],
        strStructuring.map(r => [
          r.customer_email,
          r.merchant,
          r.txn_count.toString(),
          fmt(r.total_kobo),
          fmt(r.max_single_kobo),
        ]),
        'No structuring patterns detected yesterday.'
      )
    )}

    <!-- STR Reversals -->
    ${section('Suspicious Transaction Report — Large Reversals ≥ ₦1,000,000', { bg: '#fef3c7', fg: '#b45309', label: 'STR · REVERSALS' },
      tbl(
        ['Reference', 'Customer Email', 'Merchant', 'Amount', 'Channel', 'Reversed At'],
        strReversals.map(r => [
          `<code style="font-size:11px">${r.reference}</code>`,
          r.customer_email || '—',
          r.merchant,
          fmt(r.amount),
          r.channel,
          fmtDate(r.reversed_at),
        ]),
        'No large reversals recorded yesterday.'
      )
    )}

    <!-- Footer note -->
    <div style="margin-top:24px;padding:16px 20px;background:#f8fafc;border-left:4px solid #1a3c5e;border-radius:0 6px 6px 0;font-size:12px;color:#475569;line-height:1.6">
      <strong>Note:</strong> This report is generated automatically by Paylode Services Limited as part of its AML/CFT obligations under the CBN AML/CFT Regulations 2022 and NFIU guidelines. LTR threshold: ₦5,000,000 per transaction. STR flags are indicative — compliance officer review required before filing. This report covers ${reportDate} (00:00–23:59 WAT).
    </div>

  </div>

  <div style="background:#f1f5f9;padding:14px 32px;font-size:11px;color:#94a3b8;text-align:center;border-top:1px solid #e2e8f0">
    Paylode Services Limited — Automated NFIU Compliance Report — CONFIDENTIAL
  </div>
</div>
</body>
</html>`;

  // ── Build CSV attachments ─────────────────────────────────────────────────────
  const dateSlug = from.toISOString().slice(0, 10);

  const ltrCsv = buildCsv(
    ['Type', 'Reference/Batch', 'Merchant', 'Customer/Beneficiary', 'Amount (NGN)', 'Channel/Bank', 'Status', 'Date'],
    [
      ...ltrCollections.map(r => ['Collection', r.reference, r.merchant, r.customer_email || '', plainAmt(r.amount), r.channel, r.status, fmtDate(r.paid_at || r.created_at)]),
      ...ltrFunding.map(r => ['Wallet Funding', r.reference, r.merchant, '', plainAmt(r.amount), 'Bank Transfer', 'CREDIT', fmtDate(r.created_at)]),
      ...ltrPayouts.map(r => ['Payout', r.batch_ref, r.merchant, `${r.account_name || ''} ${r.account_number}`, plainAmt(r.amount), r.bank_name || '', r.status, fmtDate(r.processed_at || r.created_at)]),
    ]
  );

  const strCsv = buildCsv(
    ['Flag Type', 'Identifier', 'Merchant', 'Count', 'Total Amount (NGN)', 'Max Single (NGN)', 'Notes'],
    [
      ...strVelocity.map(r => ['High-Velocity Customer', r.customer_email, r.merchant, r.txn_count.toString(), plainAmt(r.total_kobo), '', `${r.txn_count} collections in one day`]),
      ...strPayoutVelocity.map(r => ['Repeat Payout Beneficiary', r.account_number, r.merchant, r.payout_count.toString(), plainAmt(r.total_kobo), '', `${r.bank_name || ''} — ${r.payout_count} payouts in one day`]),
      ...strStructuring.map(r => ['Possible Structuring', r.customer_email, r.merchant, r.txn_count.toString(), plainAmt(r.total_kobo), plainAmt(r.max_single_kobo), 'Multiple txns each below ₦5M, total ≥ ₦3M']),
      ...strReversals.map(r => ['Large Reversal', r.reference, r.merchant, '1', plainAmt(r.amount), '', `${r.channel} — reversed ${fmtDate(r.reversed_at)}`]),
    ]
  );

  const attachments = [
    { filename: `NFIU_LTR_${dateSlug}.csv`, content: Buffer.from(ltrCsv, 'utf-8'), contentType: 'text/csv' },
    { filename: `NFIU_STR_${dateSlug}.csv`, content: Buffer.from(strCsv, 'utf-8'), contentType: 'text/csv' },
  ];

  const subject = `NFIU Daily Report — ${reportDate} | LTR: ${ltrCount} | STR flags: ${strCount}`;

  if (ltrCount === 0 && strCount === 0) {
    await sendEmail({ to: REPORT_TO, cc: REPORT_CC, subject: `NFIU Daily Nil Return — ${reportDate}`, html, attachments });
    console.log(`[nfiu-report] Nil return sent for ${reportDate}`);
  } else {
    await sendEmail({ to: REPORT_TO, cc: REPORT_CC, subject, html, attachments });
    console.log(`[nfiu-report] Sent for ${reportDate} — LTR:${ltrCount} STR:${strCount}`);
  }
}

run()
  .then(() => prisma.$disconnect())
  .catch(e => {
    console.error('[nfiu-report] FATAL:', e.message);
    prisma.$disconnect();
    process.exit(1);
  });
