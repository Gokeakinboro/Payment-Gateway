'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Settlement generation for one day, grouped by (merchant, currency).
//  Used by BOTH the /settlements/process route AND the daily cron (jobs.js), so
//  cron + manual runs can NEVER create duplicate settlements: a (merchant,
//  currency, day) that already has a settlement is skipped (idempotent).
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../../../utils/db');
const { generateRef } = require('../../../utils/helpers');

// Default = yesterday (the prior day). Times set so the whole day is covered.
function dayWindow(date) {
  const target = date ? new Date(date) : (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d; })();
  target.setHours(0, 0, 0, 0);
  const periodStart = new Date(target);
  const periodEnd = new Date(target); periodEnd.setHours(23, 59, 59, 999);
  return { periodStart, periodEnd };
}

async function generateSettlements({ date, sandbox = false } = {}) {
  const { periodStart, periodEnd } = dayWindow(date);

  const groups = await prisma.transaction.groupBy({
    by: ['merchantId', 'currency'],
    where: { status: 'SUCCESS', isSandbox: sandbox, createdAt: { gte: periodStart, lte: periodEnd } },
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
