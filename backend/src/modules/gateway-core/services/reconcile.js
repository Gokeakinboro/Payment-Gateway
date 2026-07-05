'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Bank reconciliation matching engine. Matches a merchant's uploaded bank
//  statement CREDIT lines against their settlements (batch-aware: 1 bank credit
//  ↔ 1 settlement's NET). A credit matches a settlement when the amounts agree
//  (within tolerance) AND the credit date falls in the settlement's expected
//  landing window (settlement day .. +lagDays, for T+1/T+2 bank lag). Each
//  settlement matches at most one bank line (1:1). "matched" = exact amount,
//  "partial" = within tolerance but not exact.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../../../utils/db');

const DAY_MS = 86400000;

async function autoMatch(merchantId, { amountToleranceKobo = 100, lagDays = 3 } = {}) {
  // Unmatched bank credits (oldest first) + settlements not yet matched (net > 0).
  const lines = await prisma.$queryRawUnsafe(
    `SELECT id::text, txn_date, credit_kobo::text AS credit FROM bank_statement_lines
      WHERE merchant_id = $1::uuid AND match_status = 'unmatched' AND credit_kobo > 0
      ORDER BY txn_date ASC NULLS LAST, created_at ASC`, merchantId);
  const setts = await prisma.$queryRawUnsafe(
    `SELECT s.id::text, s.period_start, s.net_settled::text AS net
       FROM settlements s
      WHERE s.merchant_id = $1::uuid AND s.net_settled > 0
        AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.matched_settlement_id = s.id)
      ORDER BY s.period_start ASC`, merchantId);

  const used = new Set();
  const tol = BigInt(amountToleranceKobo);
  let matched = 0, partial = 0;

  for (const ln of lines) {
    const credit = BigInt(ln.credit);
    const lnDate = ln.txn_date ? new Date(ln.txn_date) : null;
    let best = null, bestDiff = null;
    for (const s of setts) {
      if (used.has(s.id)) continue;
      const net = BigInt(s.net);
      const diff = credit > net ? credit - net : net - credit;
      if (diff > tol) continue;
      // Date window: bank credit lands on/after the settlement day, within lagDays
      // (allow 1 day of slack before to absorb same-day/tz edges).
      if (lnDate && s.period_start) {
        const ps = new Date(s.period_start).getTime();
        if (lnDate.getTime() < ps - DAY_MS || lnDate.getTime() > ps + (lagDays + 1) * DAY_MS) continue;
      }
      if (bestDiff === null || diff < bestDiff) { best = s; bestDiff = diff; }
    }
    if (best) {
      used.add(best.id);
      const status = bestDiff === 0n ? 'matched' : 'partial';
      await prisma.$executeRawUnsafe(
        `UPDATE bank_statement_lines SET match_status = $2, matched_settlement_id = $3::uuid WHERE id = $1::uuid`,
        ln.id, status, best.id);
      if (status === 'matched') matched++; else partial++;
    }
  }
  return { matched, partial, bank_credits: lines.length, open_settlements: setts.length };
}

module.exports = { autoMatch };
