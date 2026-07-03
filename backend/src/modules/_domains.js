'use strict';
/**
 * Data-ownership manifest (P2 DB boundaries). The single source of truth for who
 * owns which tables/models, what products may share-READ, and the catalogued
 * exceptions. Drives tools/db-boundary-check.js and documents the boundary.
 *
 * Rule of thumb: a PRODUCT module (invoicing/wallet/assistant) may touch only its
 * own prefixed tables + the shared-read identity set. Everything money/core lives
 * in gateway-core + the core routes and is owned by the core domain. Core reaches
 * INTO a product only through the sanctioned payment hooks (never a raw query).
 */

// Product domains own raw-SQL table prefixes (their Prisma-less tables live in
// prisma/migrations/*.sql). assistant is stateless.
const DOMAINS = {
  invoicing: { path: 'src/modules/invoicing', kind: 'product', ownsPrefixes: ['inv_'] },
  wallet:    { path: 'src/modules/wallet',    kind: 'product', ownsPrefixes: ['mw_'] },
  assistant: { path: 'src/modules/assistant', kind: 'product', ownsPrefixes: [] },
  // Everything else under src/ (gateway-core, core routes, services, middleware…)
  // is the core domain and owns the 25 Prisma models + their tables.
};

// Products may READ these core identity models/tables for tenant auth. Reads only —
// a WRITE to any of them from a product is a violation (unless in SHARED_WRITE_MODELS).
const SHARED_READ_MODELS = ['merchant', 'user', 'apiKey'];
const SHARED_READ_TABLES = ['merchants', 'users', 'api_keys'];

// Sub-users and wallet members ARE core Users by design (single `users` table with
// roles — there is no separate sub-user table), so products legitimately create/
// update their own sub-user Users. merchant/apiKey stay read-only for products.
const SHARED_WRITE_MODELS = ['user'];

// Genuinely shared tables used by BOTH invoicing and wallet: the departmental
// structure (see modules/*/_shared.js tenantAuth). Cross-product read/write ok.
const SHARED_TABLES = ['inv_department_users', 'inv_departments'];

// All 25 core Prisma models (prisma/schema.prisma). Product code must not touch
// these except the SHARED_READ_MODELS above (read-only), unless catalogued below.
const CORE_MODELS = [
  'user', 'aggregator', 'merchant', 'apiKey', 'paymentRail', 'railCost', 'transaction',
  'settlement', 'aggPayout', 'kycSubmission', 'amlFlag', 'complianceException',
  'onboardingSubmission', 'emailTemplate', 'auditLog', 'merchantRateConfig',
  'platformRateConfig', 'aggregatorRateConfig', 'merchantWallet', 'walletLedger',
  'railRebalance', 'payoutBatch', 'payoutItem', 'nigerianBank', 'webhookDelivery',
];

// Sanctioned cross-domain interfaces (explicit function hooks, NOT raw cross-domain
// queries). This is how a domain touches another's data — through the owner's code.
const CORE_TO_PRODUCT_HOOKS = [
  // core → product: on a successful pay-in, keyed by txn.metadata.source.
  { from: 'modules/gateway-core/services/payinFinalize.js', to: 'modules/invoicing/services/invoicingPay.js', on: "metadata.source in ('invoice','qr')" },
  { from: 'modules/gateway-core/services/payinFinalize.js', to: 'modules/wallet/services/walletFund.js',       on: "metadata.source == 'wallet_fund'" },
];
const PRODUCT_TO_CORE_HOOKS = [
  // product → gateway-core: products mint/read the core `transaction` via this
  // interface instead of prisma.transaction directly (gatewayTxn owns the schema).
  { hook: 'modules/gateway-core/services/gatewayTxn.js', exposes: 'createCheckoutTransaction, findSuccessfulTransactionsBySource', usedBy: 'invoicing (public, invoicingPay), wallet (fund, me, walletFund)' },
];
const PRODUCT_TO_PRODUCT_HOOKS = [
  // wallet → invoicing: "pay an Invoice&Collect invoice from wallet balance" writes
  // through invoicing's hooks (passed the wallet's tx) instead of raw inv_* SQL.
  { hook: 'modules/invoicing/services/invoicePayHooks.js', exposes: 'lockInvoiceForUpdate, applyInvoicePayment', usedBy: 'wallet (walletInvoice)' },
];

// KNOWN, catalogued boundary exceptions. The lint PASSES on these (reviewed) but
// keeps them visible. The former transaction.create/findMany + walletInvoice inv_*
// writes were removed by routing them through the hooks above (2026-07-03).
const KNOWN_EXCEPTIONS = [
  // wallet member app READS invoicing invoice/QR tables for display (read-only —
  // acceptable cross-product read; the WRITES go through invoicePayHooks). A future
  // invoicing read-hook could remove even this, but reads don't risk the boundary.
  { where: 'modules/wallet/routes/me.js', access: 'raw:inv_', why: 'member app lists/reads invoicing invoices + QR for display (read-only cross-product)' },
];

module.exports = {
  DOMAINS, SHARED_READ_MODELS, SHARED_READ_TABLES, SHARED_WRITE_MODELS, SHARED_TABLES,
  CORE_MODELS, CORE_TO_PRODUCT_HOOKS, PRODUCT_TO_CORE_HOOKS, PRODUCT_TO_PRODUCT_HOOKS,
  KNOWN_EXCEPTIONS,
};
