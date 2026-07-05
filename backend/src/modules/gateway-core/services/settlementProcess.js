'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Settlement generation for one day, grouped by (merchant, currency).
//  Days are keyed to the NIGERIAN calendar day (Africa/Lagos = UTC+1, no DST):
//  a settlement for day D covers transactions from Lagos D 00:00 → 23:59:59.
//  Used by BOTH the /settlements/process route AND the daily cron (jobs.js), and
//  IDEMPOTENT (skips a (merchant, currency, day) already settled) so cron +
//  manual runs can never duplicate.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../../../utils/db');
const { generateRef } = require('../../../utils/helpers');

const WAT_MS = 60 * 60 * 1000; // Africa/Lagos = UTC+1, no DST

// Target Lagos calendar day parts (m is 0-based): an explicit 'YYYY-MM-DD', else
// the PRIOR Lagos day (for the daily cron).
function lagosDayParts(date) {
  if (date) { const [Y, M, D] = String(date).split('-').map(Number); return { y: Y, m: M - 1, d: D }; }
  const lagosNow = new Date(Date.now() + WAT_MS); // shift so UTC fields read as Lagos wall-clock
  const prior = new Date(Date.UTC(lagosNow.getUTCFullYear(), lagosNow.getUTCMonth(), lagosNow.getUTCDate()) - 24 * 60 * 60 * 1000);
  return { y: prior.getUTCFullYear(), m: prior.getUTCMonth(), d: prior.getUTCDate() };
}

function dayWindow(date) {
  const { y, m, d } = lagosDayParts(date);
  // Stored period (@db.Date) = the Lagos calendar day D (its UTC date-part reads as D).
  const periodStart = new Date(Date.UTC(y, m, d));
  const periodEnd = periodStart;
  // Transaction window in UTC = Lagos D 00:00 .. 23:59:59.999 (Lagos = UTC+1).
  const gte = new Date(Date.UTC(y, m, d) - WAT_MS);
  const lte = new Date(Date.UTC(y, m, d) + 24 * 60 * 60 * 1000 - WAT_MS - 1);
  return { periodStart, periodEnd, gte, lte };
}

async function generateSettlements({ date, sandbox = false } = {}) {
  const { periodStart, periodEnd, gte, lte } = dayWindow(date);

  const groups = await prisma.transaction.groupBy({
    by: ['merchantId', 'currency'],
    where: { status: 'SUCCESS', isSandbox: sandbox, createdAt: { gte, lte } },
    _count: true,
    _sum: { amount: true, merchantFee: true },
  });

  let processed = 0, skipped = 0;
  const results = [];
  for (const g of groups) {
    if (!g._count) continue;
    const ccy = g.currency || 'NGN';
    // Idempotency guard: one settlement per (merchant, currency, day).
    const existing = await prisma.settlement.findFirst({
      where: { merchantId: g.merchantId, currency: ccy, periodStart }, select: { id: true },
    });
    if (existing) { skipped++; continue; }

    const gross = g._sum.amount || 0n;
    const fees = g._sum.merchantFee || 0n;
    const net = gross - fees;
    await prisma.settlement.create({ data: {
      merchantId: g.merchantId, currency: ccy, periodStart, periodEnd,
      grossAmount: gross, feesDeducted: fees, netSettled: net,
      txnCount: g._count, status: 'PENDING',
      settlementRef: generateRef(ccy === 'USD' ? 'SETUSD' : 'SET'),
    }});
    processed++;
    results.push({ merchant_id: g.merchantId, currency: ccy, txn_count: g._count, net_kobo: Number(net), net_major: Number(net) / 100 });
  }
  return { date: periodStart.toISOString().split('T')[0], processed, skipped, results };
}

module.exports = { generateSettlements };
