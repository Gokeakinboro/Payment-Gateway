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
const { computeFeesForPayin, resolvePayinRail, resolvePayinRateConfig } = require('./feeEngine');

// Finalize by transaction reference. Returns:
//   { finalized:true, fees }          — we flipped PENDING→SUCCESS this call
//   { alreadyDone:true }              — already SUCCESS (idempotent no-op)
//   { notFound:true } | { notPending:true }
async function finalizePayinSuccess({ reference, channel = 'BANK_TRANSFER', processor = 'palmpay', extraMeta = {}, paidAmount = null }) {
  const txn = await prisma.transaction.findUnique({
    where: { reference },
    include: { merchant: { include: { aggregator: true } } },
  });
  if (!txn) return { notFound: true };
  if (txn.status === 'SUCCESS') return { alreadyDone: true, txn };
  if (txn.status !== 'PENDING') return { notPending: true, txn };

  const merchant = txn.merchant;

  // Rail that processed this collection: prefer the one stamped at mint, else pick the
  // cheapest LIVE collection rail (config-driven; scales to multiple pay-in rails).
  let railId = txn.railId || null;
  if (!railId) {
    const rail = await resolvePayinRail(prisma);
    railId = (rail && rail.id) || null;
  }

  // Pay-in pricing — PAYER-FUNDED (customer pays the gross; merchant settles the full
  // face). Prefer the breakdown computed + stored when the VA was minted, so what we
  // RECORD exactly matches what the customer was CHARGED (even if a rate is later
  // edited). Otherwise resolve from config for the resolved rail (DB — nothing hardcoded).
  let fees;
  const stored = txn.metadata && txn.metadata.payin;
  if (stored && stored.charge != null) {
    fees = {
      principal:          BigInt(stored.principal),
      chargeAmount:       BigInt(stored.charge),
      merchantSettlement: BigInt(stored.principal),
      feeRaw:             BigInt(stored.feeRaw || 0),
      feePlusVat:         BigInt(stored.fee),
      vatOnFee:           BigInt(stored.vatOnFee || 0),
      railRaw:            BigInt(stored.railRaw || 0),
      railPlusVat:        BigInt(stored.railPlusVat || 0),
      netPool:            BigInt(stored.netPool || 0),
      aggShare:           BigInt(stored.aggShare || 0),
      paylodeMargin:      BigInt(stored.paylodeMargin || 0),
      feePaidBy:          'customer',
    };
  } else {
    const cfg = await resolvePayinRateConfig(prisma, merchant, railId);
    fees = computeFeesForPayin(BigInt(txn.amount), cfg);
  }

  // EXACT-AMOUNT ENFORCEMENT — a VA / collection must be paid for the EXACT gross we
  // minted. If the rail reports a different collected amount (under- or over-payment),
  // do NOT credit the merchant: mark it for reversal so the payer is refunded.
  if (paidAmount != null && BigInt(paidAmount) !== BigInt(fees.chargeAmount)) {
    await prisma.transaction.updateMany({
      where: { id: txn.id, status: 'PENDING' },
      data: {
        status: 'FAILED',
        failureReason: `Amount mismatch — expected ₦${(Number(fees.chargeAmount)/100).toFixed(2)}, received ₦${(Number(paidAmount)/100).toFixed(2)}. Wrong-amount transfer; to be reversed.`,
        metadata: { ...(txn.metadata || {}), ...extraMeta, processor,
          amount_mismatch: true, expected_amount: Number(fees.chargeAmount), paid_amount: Number(paidAmount),
          reversal_required: true },
      },
    });
    return { amountMismatch: true, expected: Number(fees.chargeAmount), paid: Number(paidAmount) };
  }

  // Atomic claim: only the worker that flips PENDING→SUCCESS proceeds to notify.
  const claim = await prisma.transaction.updateMany({
    where: { id: txn.id, status: 'PENDING' },
    data: {
      status:        'SUCCESS',
      paidAt:        new Date(),
      railId:        railId,
      amount:        fees.chargeAmount,    // gross the customer actually transferred
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

  // Payment-link bookkeeping (best-effort): count the payment, and auto-disable a
  // one-off link now that it has been paid. Reusable links stay active.
  const linkSlug = txn.metadata && txn.metadata.payment_link_slug;
  if (linkSlug) {
    prisma.$executeRawUnsafe(
      `UPDATE payment_links
          SET paid_count = paid_count + 1,
              status = CASE WHEN is_reusable THEN status ELSE 'disabled' END,
              updated_at = now()
        WHERE slug = $1`,
      linkSlug
    ).catch(() => {});
  }

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
