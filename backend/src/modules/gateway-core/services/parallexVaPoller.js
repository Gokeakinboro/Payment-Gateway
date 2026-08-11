'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Parallex VA — pay-in polling backstop.
//  Webhook delivery from Parallex is not guaranteed (pilot + production issues).
//  This poller queries TemporaryVirtualAccountRequery every POLL_MS minutes for
//  every PENDING parallex_va transaction and finalizes or expires it — exactly
//  as the webhook handler would, via the same finalizePayinSuccess / failPayin
//  shared logic. Idempotent: concurrent finalizations resolve to alreadyDone.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma }  = require('../../../utils/db');
const { logger }  = require('../../../utils/logger');
const parallex    = require('./parallexService');
const { finalizePayinSuccess, failPayin } = require('./payinFinalize');

const LOOK_BACK_MS = 65 * 60 * 1000;  // 65 min — VA TTL is 30 min, extra buffer

async function pollParallexVaPending() {
  if (!parallex.isConfigured()) return;

  const cutoff = new Date(Date.now() - LOOK_BACK_MS);

  const pending = await prisma.$queryRawUnsafe(
    `SELECT id, reference, amount,
            metadata->>'parallex_va_no'               AS va_no,
            metadata->>'parallex_va_order_expires_at'  AS expires_at
       FROM transactions
      WHERE status = 'PENDING'
        AND metadata->>'method' = 'parallex_va'
        AND metadata->>'parallex_va_no' IS NOT NULL
        AND created_at > $1::timestamptz
      ORDER BY created_at ASC
      LIMIT 30`,
    cutoff,
  );

  if (!pending.length) return;

  logger.info({ count: pending.length }, 'Parallex VA poller: checking pending transactions');

  for (const txn of pending) {
    try {
      const r = await parallex.temporaryRequery({
        referenceId:   txn.reference,
        accountNumber: txn.va_no,
      });

      const status = String((r.data && r.data.status) || '').toUpperCase();

      if (r.ok && (status === 'SUCCESSFUL' || status === 'SUCCESS')) {
        const rawAmount  = r.data && r.data.amount;
        const paidKobo   = rawAmount ? Number(parallex.koboFromNaira(rawAmount)) : null;
        const result     = await finalizePayinSuccess({
          reference:  txn.reference,
          channel:    'BANK_TRANSFER',
          processor:  'parallex_va',
          extraMeta:  { method: 'parallex_va', polled: true,
                        parallex_txn_ref: (r.data && r.data.transactionReference) || null },
          paidAmount: Number.isFinite(paidKobo) ? paidKobo : null,
        });
        if (result.finalized) {
          logger.info({ reference: txn.reference, va: txn.va_no, paid: rawAmount }, 'Parallex VA poller: finalized');
        } else if (result.amountMismatch) {
          logger.warn({ reference: txn.reference, expected: result.expected, paid: result.paid }, 'Parallex VA poller: amount mismatch — failed');
        }
        // alreadyDone / notFound / notPending — no-op, log silently

      } else if (!r.ok && r.code === '10') {
        // Not found: either no payment yet, or the VA expired with no payment.
        // Only fail it if the order window has closed (so we don't expire early).
        const exp = txn.expires_at ? new Date(txn.expires_at) : null;
        if (exp && exp < new Date()) {
          await failPayin({ reference: txn.reference, failureReason: 'Virtual account expired — no payment received' });
          logger.info({ reference: txn.reference, expires_at: txn.expires_at }, 'Parallex VA poller: expired, failed');
        }
        // else: still within window, no payment yet — leave PENDING, will poll again

      } else if (r.code === 'TIMEOUT') {
        // Transient VPN/network issue — skip silently, retry next poll
      } else {
        logger.debug({ reference: txn.reference, code: r.code, reason: r.reason }, 'Parallex VA poller: no-op');
      }
    } catch (e) {
      logger.warn({ err: e, reference: txn.reference }, 'Parallex VA poller: error (skipping)');
    }
  }
}

module.exports = { pollParallexVaPending };
