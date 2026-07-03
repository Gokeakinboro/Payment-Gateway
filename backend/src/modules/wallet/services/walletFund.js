'use strict';
/**
 * Credits a member wallet once its funding transaction succeeds. Idempotent
 * (unique transaction_id in mw_ledger). Called from payinFinalize (instant
 * bank-transfer / VA) and swept by the worker (card + any late settlement).
 *
 * Pay-ins are PAYER-FUNDED: the member pays the gross (principal + fee) and the
 * merchant settles exactly the principal into its float. The wallet must be
 * credited the PRINCIPAL (= merchant_settlement), NOT the gross — otherwise the
 * member is over-credited by the fee and the closed-loop float (merchant holds
 * Σ wallet balances) stops reconciling. Note: finalizePayinSuccess OVERWRITES
 * transaction.amount to the gross charge, so we read the principal from
 * metadata.merchant_settlement (set at finalize), falling back to amount only
 * when that is absent (pre-finalize / legacy). The balance ceiling is enforced
 * at funding INITIATION; here the settled money is always credited.
 */
const { prisma } = require('../_shared');
const ledger = require('./ledger');
const { findSuccessfulTransactionsBySource } = require('../../gateway-core/services/gatewayTxn');

async function recordForTransaction(txn) {
  if (!txn || txn.status !== 'SUCCESS') return { skipped: true };
  const meta = txn.metadata || {};
  if (meta.source !== 'wallet_fund' || !meta.wallet_id) return { skipped: true };
  const dup = await prisma.$queryRawUnsafe(`SELECT 1 FROM mw_ledger WHERE transaction_id = $1::uuid LIMIT 1`, txn.id);
  if (dup.length) return { duplicate: true };
  const w = await prisma.$queryRawUnsafe(`SELECT id::text FROM mw_wallets WHERE id = $1::uuid`, meta.wallet_id);
  if (!w.length) return { skipped: true };
  // Credit the settled principal, not the gross charge (see file header).
  const creditAmount = meta.merchant_settlement != null ? BigInt(meta.merchant_settlement) : BigInt(txn.amount);
  try {
    const res = await ledger.credit({
      walletId: meta.wallet_id, amount: creditAmount, type: 'fund', maxBalance: null,
      transactionId: txn.id, reference: txn.reference, counterparty: txn.customerEmail || null, note: 'Wallet funding',
    });
    require('./walletNotify').memberFunded(meta.wallet_id, creditAmount, res.balanceAfter).catch(() => {});
    return { recorded: true, ...res };
  } catch (e) { return { error: e.code || e.message }; }
}

// Worker sweep: catch SUCCESS wallet-fund transactions not yet credited — card
// payments AND any settlement path whose inline hook didn't run (e.g. PalmPay VA,
// or a finalize that early-returned 'alreadyDone' before the credit hook). Wide
// 14-day window (low volume + idempotent) so a missed credit is never stranded.
async function reconcileWalletFunding() {
  const txns = await findSuccessfulTransactionsBySource({
    sources: 'wallet_fund', sinceMs: 14 * 24 * 60 * 60 * 1000,
    select: { id: true, reference: true, amount: true, status: true, customerEmail: true, metadata: true },
  });
  let credited = 0;
  for (const t of txns) { const r = await recordForTransaction(t); if (r.recorded) credited++; }
  return { scanned: txns.length, credited };
}

module.exports = { recordForTransaction, reconcileWalletFunding };
