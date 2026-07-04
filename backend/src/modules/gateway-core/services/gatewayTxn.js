'use strict';
/**
 * gateway-core's interface for products that need the core `transaction` table.
 *
 * The Transaction model + the PENDING payer-funded checkout shape are money-core
 * owned. Products (invoicing / wallet) call these instead of writing
 * prisma.transaction directly, so the boundary is an explicit interface rather
 * than the product knowing the core schema (see docs/DATA-OWNERSHIP.md, P2).
 * Mirrors the reverse core→product hook already in payinFinalize.js.
 */
const { prisma } = require('../../../utils/db');
const { generateRef } = require('../../../utils/helpers');

// Same computation the product routes used, kept identical for behavior parity.
const CHECKOUT_BASE = (process.env.CHECKOUT_BASE_URL || 'https://paylodeservices.com').replace(/\/$/, '');

/**
 * Mint a PENDING, payer-funded CARD checkout transaction — the exact shape every
 * product collection flow (invoice / QR / wallet-fund) used inline — and return
 * its reference + hosted-checkout redirect. `client` lets callers pass a
 * $transaction tx; defaults to the shared prisma.
 */
async function createCheckoutTransaction({ merchantId, amount, currency = 'NGN', customerEmail = '',
                                           refPrefix = 'TXN', source, metadata = {} }, client = prisma) {
  const ref = generateRef(refPrefix);
  await client.transaction.create({ data: {
    reference: ref, merchantId, customerEmail: customerEmail || '',
    amount: BigInt(amount), currency, status: 'PENDING', channel: 'CARD',
    authUrl: `${CHECKOUT_BASE}/checkout.html?ref=${ref}`, accessCode: ref, isSandbox: false,
    metadata: { ...metadata, source },
  }});
  return { reference: ref, redirectUrl: `${CHECKOUT_BASE}/checkout.html?ref=${ref}` };
}

/**
 * Find SUCCESS transactions by metadata.source within a window — used by the
 * product reconciler sweeps (invoicing / wallet) instead of querying the core
 * transaction table directly.
 */
async function findSuccessfulTransactionsBySource({ sources, sinceMs, take = 500, select }) {
  const list = Array.isArray(sources) ? sources : [sources];
  return prisma.transaction.findMany({
    where: {
      status: 'SUCCESS',
      createdAt: { gte: new Date(Date.now() - sinceMs) },
      ...(list.length === 1
        ? { metadata: { path: ['source'], equals: list[0] } }
        : { OR: list.map((s) => ({ metadata: { path: ['source'], equals: s } })) }),
    },
    select,
    take,
  });
}

module.exports = { createCheckoutTransaction, findSuccessfulTransactionsBySource };
