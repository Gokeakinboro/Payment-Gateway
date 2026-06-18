'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Shared pay-in finalizer. Marks a PENDING transaction SUCCESS using the SAME
//  fee logic as the card checkout (computeFeesForTxn), then dispatches the
//  merchant `payment.success` webhook. Used by the PalmPay callbacks
//  (/payin = Pay-with-PalmPay wallet, /va-cashin = virtual-account transfer).
//
//  Idempotent: the SUCCESS write is a status-guarded updateMany, so concurrent
//  PalmPay retries finalize+notify exactly once (losers see count 0, no-op).
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../utils/db');
const { dispatchWebhook } = require('./webhookService');
const { computeFeesForTxn } = require('./feeEngine');

// Finalize by transaction reference. Returns:
//   { finalized:true, fees }          — we flipped PENDING→SUCCESS this call
//   { alreadyDone:true }              — already SUCCESS (idempotent no-op)
//   { notFound:true } | { notPending:true }
async function finalizePayinSuccess({ reference, channel = 'BANK_TRANSFER', processor = 'palmpay', extraMeta = {} }) {
  const txn = await prisma.transaction.findUnique({
    where: { reference },
    include: { merchant: { include: { aggregator: true } } },
  });
  if (!txn) return { notFound: true };
  if (txn.status === 'SUCCESS') return { alreadyDone: true, txn };
  if (txn.status !== 'PENDING') return { notPending: true, txn };

  const merchant = txn.merchant;
  const fees = computeFeesForTxn(BigInt(txn.amount), merchant, null, channel);

  // Atomic claim: only the worker that flips PENDING→SUCCESS proceeds to notify.
  const claim = await prisma.transaction.updateMany({
    where: { id: txn.id, status: 'PENDING' },
    data: {
      status:        'SUCCESS',
      paidAt:        new Date(),
      netRevenue:    fees.netPool,
      merchantFee:   fees.feePlusVat,
      railCost:      fees.railPlusVat,
      vatOutput:     fees.vatOnFee,
      vatInput:      fees.railPlusVat - fees.railRaw,
      aggShare:      fees.aggShare,
      paylodeMargin: fees.paylodeMargin,
      metadata: {
        ...(txn.metadata || {}), ...extraMeta, processor,
        fee_paid_by: fees.feePaidBy, merchant_settlement: Number(fees.merchantSettlement),
      },
    },
  });
  if (claim.count === 0) return { alreadyDone: true, txn };

  if (merchant.webhookUrl) {
    dispatchWebhook(merchant.id, 'payment.success', {
      reference:           txn.reference,
      status:              'SUCCESS',
      channel,
      principal:           Number(txn.amount),
      charge_amount:       Number(fees.chargeAmount),
      merchant_settlement: Number(fees.merchantSettlement),
      fee:                 Number(fees.feePlusVat),
      processor,
    }).catch(() => {});
  }
  return { finalized: true, fees };
}

// Mark a PENDING transaction FAILED (idempotent). Used when PalmPay reports a
// terminal failure on a pay-in we created.
async function failPayin({ reference, failureReason = 'Payment failed' }) {
  const r = await prisma.transaction.updateMany({
    where: { reference, status: 'PENDING' },
    data:  { status: 'FAILED', failureReason: String(failureReason).slice(0, 280) },
  });
  return { failed: r.count > 0 };
}

module.exports = { finalizePayinSuccess, failPayin };
