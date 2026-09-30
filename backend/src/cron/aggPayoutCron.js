'use strict';
/**
 * Aggregator T+1 margin sweep.
 *
 * Runs daily at 01:00 Africa/Lagos (00:00 UTC+1):
 *  1. Sum `agg_share` from all SUCCESS transactions for each aggregator's
 *     merchants on the PREVIOUS Lagos day.
 *  2. Upsert into `agg_payouts` (monthly bucket) — accumulates day-by-day.
 *  3. Email SA a daily summary of what each aggregator accrued and their
 *     running monthly total, so SA can release payment at their discretion.
 *
 * Does NOT automatically trigger bank transfers — margin accrues in agg_payouts
 * with status PENDING. SA reviews and settles via the dashboard.
 *
 * Idempotent: re-running for the same day updates the monthly bucket rather
 * than creating duplicate records.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { PrismaClient } = require('@prisma/client');
const { sendEmail }    = require('../services/emailService');
const { logger }       = require('../utils/logger');

const p       = new PrismaClient();
const ALERT   = process.env.ADMIN_ALERT_EMAIL || 'gokeakinboro@gmail.com';
// Run daily at 01:00 Africa/Lagos = 00:00 UTC
const HOUR_UTC = 0;
const MIN_UTC  = 0;

async function runSweep() {
  // Yesterday in Africa/Lagos (UTC+1, no DST)
  const now       = new Date();
  const lagosNow  = new Date(now.getTime() + 60 * 60 * 1000); // UTC+1
  const yesterday = new Date(lagosNow);
  yesterday.setDate(yesterday.getDate() - 1);
  const dayStart  = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), -1)); // 23:00 UTC day-2 = 00:00 Lagos yesterday
  const dayEnd    = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 23)); // 23:00 UTC yesterday = 00:00 Lagos today

  // Monthly bucket key (first day of current Lagos month)
  const monthStart = new Date(Date.UTC(lagosNow.getUTCFullYear(), lagosNow.getUTCMonth(), 1));

  logger.info({ dayStart, dayEnd, monthStart }, '[agg-payout] sweep start');

  // All active aggregators with at least one merchant
  const aggregators = await p.aggregator.findMany({
    where:   { status: 'active', merchants: { some: {} } },
    select:  { id: true, companyName: true, settlementBank: true, settlementAccount: true },
  });

  const results = [];

  for (const agg of aggregators) {
    // All merchant IDs under this aggregator
    const merchants = await p.merchant.findMany({
      where:  { aggregatorId: agg.id },
      select: { id: true },
    });
    const merchantIds = merchants.map(m => m.id);
    if (!merchantIds.length) continue;

    // Yesterday's agg_share from SUCCESS transactions
    const [agg_result] = await p.$queryRaw`
      SELECT
        COALESCE(SUM(agg_share),  0)::bigint  AS agg_share,
        COALESCE(SUM(merchant_fee),0)::bigint AS merchant_fees,
        COALESCE(SUM(net_revenue), 0)::bigint AS net_pool,
        COUNT(*)::int                          AS txn_count
      FROM transactions
      WHERE merchant_id  = ANY(${merchantIds}::uuid[])
        AND status       = 'SUCCESS'
        AND is_sandbox   = false
        AND created_at  >= ${dayStart}
        AND created_at  <  ${dayEnd}
        AND agg_share    > 0
    `;

    const aggShare     = BigInt(agg_result.agg_share   || 0);
    const merchantFees = BigInt(agg_result.merchant_fees|| 0);
    const netPool      = BigInt(agg_result.net_pool     || 0);
    const txnCount     = Number(agg_result.txn_count    || 0);

    if (aggShare === 0n && txnCount === 0) continue; // nothing to record

    // Upsert monthly agg_payout bucket
    const existing = await p.aggPayout.findUnique({
      where: { aggregatorId_periodMonth: { aggregatorId: agg.id, periodMonth: monthStart } },
    });

    let payout;
    if (existing) {
      payout = await p.aggPayout.update({
        where: { id: existing.id },
        data: {
          totalMerchantFees: existing.totalMerchantFees + merchantFees,
          netPool:           existing.netPool           + netPool,
          aggShareAmount:    existing.aggShareAmount     + aggShare,
          txnCount:          existing.txnCount           + txnCount,
          updatedAt:         new Date(),
        },
      });
    } else {
      payout = await p.aggPayout.create({
        data: {
          aggregatorId:     agg.id,
          periodMonth:      monthStart,
          totalMerchantFees: merchantFees,
          railDeduction:    0n,
          netPool,
          aggShareAmount:   aggShare,
          txnCount,
          status:           'PENDING',
        },
      });
    }

    results.push({
      company:        agg.companyName,
      yesterday_naira: Number(aggShare) / 100,
      month_total_naira: Number(payout.aggShareAmount) / 100,
      txn_count:      txnCount,
      settlement_bank: agg.settlementBank,
      settlement_acct: agg.settlementAccount,
    });

    logger.info({ aggregatorId: agg.id, aggShare: Number(aggShare), txnCount }, '[agg-payout] upserted');
  }

  if (!results.length) {
    logger.info('[agg-payout] no aggregator activity yesterday');
    return;
  }

  // Email SA daily summary
  const rows = results.map(r =>
    `<tr>
      <td>${r.company}</td>
      <td style="text-align:right">₦${r.yesterday_naira.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td>
      <td style="text-align:right">₦${r.month_total_naira.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td>
      <td style="text-align:right">${r.txn_count}</td>
      <td>${r.settlement_bank || '—'} ${r.settlement_acct || ''}</td>
    </tr>`
  ).join('');

  const dayLabel = yesterday.toISOString().split('T')[0];
  await sendEmail({
    to:      ALERT,
    subject: `Aggregator margin sweep — ${dayLabel}`,
    html: `
      <h2 style="font-family:sans-serif">Aggregator T+1 Margin — ${dayLabel}</h2>
      <p style="font-family:sans-serif">Yesterday's accrued margins for each aggregator. Settle at your discretion.</p>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-family:monospace;font-size:13px">
        <thead style="background:#f5f5f5">
          <tr><th>Aggregator</th><th>Yesterday</th><th>Month total</th><th>Txns</th><th>Settlement account</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-family:sans-serif;font-size:12px;color:#888">Paylode · agg-payout-cron · ${new Date().toISOString()}</p>
    `,
  }).catch(e => logger.error({ err: e }, '[agg-payout] email failed'));

  logger.info({ count: results.length }, '[agg-payout] sweep complete');
}

// ── Self-correcting daily schedule ─────────────────────────────────────────────
function scheduleNext() {
  const now  = Date.now();
  const next = new Date(now);
  next.setUTCHours(HOUR_UTC, MIN_UTC, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next.getTime() - now;
  setTimeout(() => {
    runSweep().catch(e => logger.error({ err: e }, '[agg-payout] sweep error'));
    scheduleNext();
  }, delay);
  logger.info({ next: next.toISOString() }, '[agg-payout] next run scheduled');
}

// Boot catch-up: if started after 01:00 Lagos today, run the sweep for yesterday now.
const lagosHour = new Date(Date.now() + 3600_000).getUTCHours();
if (lagosHour >= 1) {
  setTimeout(() => {
    runSweep().catch(e => logger.error({ err: e }, '[agg-payout] boot sweep error'));
  }, 10_000);
}

scheduleNext();
logger.info('[agg-payout] Aggregator T+1 margin sweep started');

module.exports = { runSweep };
