'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Settlement firing — remit a settlement's NET to the merchant's settlement bank
//  as a real payout. Settlement pays out COLLECTED funds (Paylode-funded); it does
//  NOT draw the merchant's pre-funded payout wallet, so this uses a DEDICATED
//  dispatch (palmpay.initiatePayout direct) rather than the wallet-debiting
//  payouts.js / rail_disbursements path. Because there's no rail_disbursement leg,
//  the payout webhook can't match it — results are confirmed by the poller
//  (reconcileFiredSettlements), wired worker-0-only in jobs.js.
//
//  Status: PENDING/FAILED --fire--> PROCESSING --(poll/immediate)--> COMPLETED|FAILED.
//  The PROCESSING claim is guarded so two firers / the scheduled worker can't
//  double-send the same settlement.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');
const palmpay = require('./palmpayService');
const { resolveBank } = require('../../../data/nibssBanks');

// Resolve the rail the SA chose. MVP: only the (LIVE) PalmPay payout rail is supported.
async function resolveFireRail(railId) {
  if (!railId) return { error: 'A payout rail is required to fire a settlement' };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id::text, name, status FROM payment_rails WHERE id = $1::uuid`, railId);
  if (!rows.length) return { error: 'Unknown payout rail' };
  const rail = rows[0];
  if (rail.status !== 'LIVE') return { error: `Rail "${rail.name}" is not LIVE` };
  if (!/palmpay/i.test(rail.name || '')) return { error: `Settlement firing supports the PalmPay rail only for now (got "${rail.name}")` };
  return { rail };
}

// Fire one settlement NOW. Returns { ok, status, message, payout_ref? }.
// actorId = the SA/admin who fired (null when the scheduled worker fires it).
async function fireSettlement(settlementId, { railId, actorId = null } = {}) {
  const s0 = await prisma.settlement.findUnique({ where: { id: settlementId }, include: { merchant: true } });
  if (!s0) return { ok: false, message: 'Settlement not found' };
  if (!['PENDING', 'FAILED'].includes(s0.status)) return { ok: false, message: `Settlement is ${s0.status} — only PENDING/FAILED can be fired` };
  if (s0.currency !== 'NGN') return { ok: false, message: 'Only NGN settlements can be paid to a Nigerian bank rail' };
  const net = BigInt(s0.netSettled);
  if (net <= 0n) return { ok: false, message: 'Nothing to settle (net ≤ 0)' };

  const rr = await resolveFireRail(railId || s0.railId);
  if (rr.error) return { ok: false, message: rr.error };

  const m = s0.merchant;
  if (!m.settlementBank || !m.settlementAccount) return { ok: false, message: 'Merchant has no settlement bank on file' };
  const bank = resolveBank(m.settlementBank);
  if (!bank) return { ok: false, message: `Could not resolve settlement bank "${m.settlementBank}" to a bank code` };

  // Name-enquiry confirms the beneficiary account is valid BEFORE we move money.
  let acctName = m.settlementAccountName || undefined;
  if (palmpay.isConfigured()) {
    let enq;
    try { enq = await palmpay.nameEnquiry(bank.code, m.settlementAccount); }
    catch (e) { return { ok: false, message: `Account name-enquiry error: ${e.message}` }; }
    if (!enq || !enq.ok || !enq.accountName) return { ok: false, message: `Account name-enquiry failed for ${m.settlementAccount} @ ${bank.name}: ${(enq && enq.reason) || 'unknown'}` };
    acctName = enq.accountName;
  }

  // Atomically CLAIM the settlement (PENDING/FAILED → PROCESSING) so a second firer
  // or the scheduled worker can never double-send. New orderId per attempt (re-fire safe).
  const orderId = `${s0.settlementRef || 'SET'}-${Date.now()}`;
  const claimed = await prisma.$queryRawUnsafe(
    `UPDATE settlements SET status = 'PROCESSING', rail_id = $2::uuid, fired_by = $3::uuid,
            fired_at = now(), scheduled_at = NULL, payout_order_id = $4, failure_reason = NULL
      WHERE id = $1::uuid AND status IN ('PENDING','FAILED') RETURNING id::text`,
    settlementId, rr.rail.id, actorId, orderId);
  if (!claimed.length) return { ok: false, message: 'Settlement is already being processed' };

  // Dispatch the real transfer to the merchant's settlement account.
  let out;
  try {
    out = await palmpay.initiatePayout({
      orderId, amountKobo: net, bankCode: bank.code,
      accountNumber: m.settlementAccount, accountName: acctName,
      narration: `Paylode settlement ${s0.settlementRef || ''}`.trim(),
    });
  } catch (e) {
    await prisma.$executeRawUnsafe(
      `UPDATE settlements SET status = 'FAILED', failure_reason = $2 WHERE id = $1::uuid AND status = 'PROCESSING'`,
      settlementId, `Dispatch error: ${e.message}`.slice(0, 500));
    logger.error({ err: e, settlementId }, 'settlement fire dispatch error');
    return { ok: false, status: 'FAILED', message: `Dispatch error: ${e.message}` };
  }

  if (out.ok) {
    if (String(out.orderStatus) === '2') { // immediate success
      await prisma.$executeRawUnsafe(
        `UPDATE settlements SET status = 'COMPLETED', settled_at = now(), payout_ref = $2 WHERE id = $1::uuid AND status = 'PROCESSING'`,
        settlementId, out.providerRef || null);
      logger.info({ settlementId, ref: s0.settlementRef, net: String(net) }, 'settlement fired → COMPLETED');
      return { ok: true, status: 'COMPLETED', payout_ref: out.providerRef || null, message: 'Settlement paid' };
    }
    await prisma.$executeRawUnsafe(
      `UPDATE settlements SET payout_ref = $2 WHERE id = $1::uuid AND status = 'PROCESSING'`,
      settlementId, out.providerRef || null);
    return { ok: true, status: 'PROCESSING', payout_ref: out.providerRef || null, message: 'Settlement sent — awaiting rail confirmation' };
  }

  // Rail declined synchronously → FAILED (re-fireable).
  await prisma.$executeRawUnsafe(
    `UPDATE settlements SET status = 'FAILED', failure_reason = $2 WHERE id = $1::uuid AND status = 'PROCESSING'`,
    settlementId, (out.reason || 'Rail declined the payout').slice(0, 500));
  return { ok: false, status: 'FAILED', message: out.reason || 'Rail declined the payout' };
}

// Poller: finalize settlements stuck PROCESSING (no rail_disbursement leg → the payout
// webhook can't match them, so we query the rail's payout-result API). Worker-0 only.
async function reconcileFiredSettlements({ olderThanMs = 120000, limit = 100 } = {}) {
  if (!palmpay.isConfigured()) return { processing: 0, completed: 0, failed: 0 };
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id::text, payout_order_id FROM settlements
      WHERE status = 'PROCESSING' AND payout_order_id IS NOT NULL AND fired_at < $1
      ORDER BY fired_at ASC LIMIT ${Number(limit)}`, cutoff);
  let completed = 0, failed = 0;
  for (const r of rows) {
    let q;
    try { q = await palmpay.queryPayoutResult({ orderId: r.payout_order_id }); }
    catch (e) { logger.error({ err: e, id: r.id }, 'settlement recon query failed'); continue; }
    if (!q || !q.ok) continue;                    // query itself failed → retry next cycle
    const st = String(q.orderStatus);
    if (st === '2') {
      await prisma.$executeRawUnsafe(
        `UPDATE settlements SET status = 'COMPLETED', settled_at = now(), payout_ref = COALESCE($2, payout_ref) WHERE id = $1::uuid AND status = 'PROCESSING'`,
        r.id, (q.raw && q.raw.data && q.raw.data.orderNo) || null);
      completed++;
    } else if (st !== '1' && st !== '0') {        // terminal failure (1/0 = still processing)
      await prisma.$executeRawUnsafe(
        `UPDATE settlements SET status = 'FAILED', failure_reason = $2 WHERE id = $1::uuid AND status = 'PROCESSING'`,
        r.id, (q.reason || 'Rail reported failure').slice(0, 500));
      failed++;
    }
  }
  if (rows.length) logger.info({ processing: rows.length, completed, failed }, 'settlement fire reconciliation');
  return { processing: rows.length, completed, failed };
}

// Scheduled firing: fire any settlement whose scheduled_at is due. Worker-0 only.
async function processScheduledSettlements({ limit = 100 } = {}) {
  const due = await prisma.$queryRawUnsafe(
    `SELECT id::text, rail_id::text AS rail_id FROM settlements
      WHERE status = 'PENDING' AND scheduled_at IS NOT NULL AND scheduled_at <= now() AND rail_id IS NOT NULL
      ORDER BY scheduled_at ASC LIMIT ${Number(limit)}`);
  let fired = 0;
  for (const r of due) {
    try { const out = await fireSettlement(r.id, { railId: r.rail_id, actorId: null }); if (out.ok) fired++; }
    catch (e) { logger.error({ err: e, id: r.id }, 'scheduled settlement fire failed'); }
  }
  if (due.length) logger.info({ due: due.length, fired }, 'scheduled settlement firing');
  return { due: due.length, fired };
}

// Store a future schedule on a settlement (no money moves now; the worker fires it).
async function scheduleSettlement(settlementId, { railId, when, actorId = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE settlements SET status = 'PENDING', rail_id = $2::uuid, scheduled_at = $3,
            fired_by = $4::uuid, failure_reason = NULL
      WHERE id = $1::uuid AND status IN ('PENDING','FAILED') RETURNING id::text`,
    settlementId, railId, when, actorId);
  return rows.length > 0;
}

module.exports = { fireSettlement, reconcileFiredSettlements, processScheduledSettlements, scheduleSettlement, resolveFireRail };
