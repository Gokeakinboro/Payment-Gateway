'use strict';
/**
 * Credits a member wallet once its funding transaction succeeds. Idempotent
 * (unique transaction_id in wallet_ledger). Called from payinFinalize (instant
 * bank-transfer) and swept by the worker for card payments. The balance ceiling
 * is enforced at funding INITIATION; here the paid money is always credited.
 */
const { prisma } = require('../_shared');
const ledger = require('./ledger');

async function recordForTransaction(txn) {
  if (!txn || txn.status !== 'SUCCESS') return { skipped: true };
  const meta = txn.metadata || {};
  if (meta.source !== 'wallet_fund' || !meta.wallet_id) return { skipped: true };
  const dup = await prisma.$queryRawUnsafe(`SELECT 1 FROM wallet_ledger WHERE transaction_id = $1::uuid LIMIT 1`, txn.id);
  if (dup.length) return { duplicate: true };
  const w = await prisma.$queryRawUnsafe(`SELECT id::text FROM wallets WHERE id = $1::uuid`, meta.wallet_id);
  if (!w.length) return { skipped: true };
  try {
    const res = await ledger.credit({
      walletId: meta.wallet_id, amount: txn.amount, type: 'fund', maxBalance: null,
      transactionId: txn.id, reference: txn.reference, counterparty: txn.customerEmail || null, note: 'Wallet funding',
    });
    return { recorded: true, ...res };
  } catch (e) { return { error: e.code || e.message }; }
}

// Worker sweep: catch SUCCESS wallet-fund transactions not yet credited (card path).
async function reconcileWalletFunding() {
  const txns = await prisma.transaction.findMany({
    where: {
      status: 'SUCCESS',
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      metadata: { path: ['source'], equals: 'wallet_fund' },
    },
    select: { id: true, reference: true, amount: true, status: true, customerEmail: true, metadata: true },
    take: 500,
  });
  let credited = 0;
  for (const t of txns) { const r = await recordForTransaction(t); if (r.recorded) credited++; }
  return { scanned: txns.length, credited };
}

module.exports = { recordForTransaction, reconcileWalletFunding };
