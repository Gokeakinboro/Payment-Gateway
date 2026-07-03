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

// The ONE sanctioned core→product path: gateway-core/services/payinFinalize.js
// require()s these on a successful pay-in, keyed by txn.metadata.source. Not a raw
// cross-domain query — an explicit function hook. Documented, allowed.
const CORE_TO_PRODUCT_HOOKS = [
  { from: 'modules/gateway-core/services/payinFinalize.js', to: 'modules/invoicing/services/invoicingPay.js', on: "metadata.source in ('invoice','qr')" },
  { from: 'modules/gateway-core/services/payinFinalize.js', to: 'modules/wallet/services/walletFund.js',       on: "metadata.source == 'wallet_fund'" },
];

// KNOWN, catalogued boundary exceptions. The lint PASSES on these (they're
// pre-existing + reviewed) but keeps them visible. FOLLOW-UP (money-staged):
// route the `transaction.create` writes through a gateway-core
// `createGatewayTransaction` hook so products stop writing the core txn table.
const KNOWN_EXCEPTIONS = [
  { where: 'modules/invoicing/routes/public.js',            access: 'prisma.transaction.create',   why: 'public invoice/QR checkout creates the gateway txn for the collection (money-staged: route via core hook)' },
  { where: 'modules/invoicing/services/invoicingPay.js',    access: 'prisma.transaction.findMany',  why: 'reconciles a completed gateway payment against the invoice (read-only)' },
  { where: 'modules/wallet/routes/fund.js',                 access: 'prisma.transaction.create',   why: 'member wallet SA-fund creates the gateway txn (money-staged: route via core hook)' },
  { where: 'modules/wallet/routes/me.js',                   access: 'prisma.transaction.create',   why: 'member self wallet-load creates the gateway txn (money-staged: route via core hook)' },
  { where: 'modules/wallet/services/walletFund.js',         access: 'prisma.transaction.findMany',  why: 'reconciles a completed gateway payment against the wallet load (read-only)' },
  // wallet ↔ invoicing: "pay an Invoice&Collect invoice from wallet balance" feature.
  // FOLLOW-UP (KIV): route these through an invoicing-provided hook (mirror the
  // gateway-core→product payinFinalize pattern) so wallet stops writing inv_* directly.
  { where: 'modules/wallet/services/walletInvoice.js',      access: 'raw:inv_',  why: 'pay-invoice-from-wallet: writes invoice payment + rolls up invoice status (wallet↔invoicing; future: invoicing hook)' },
  { where: 'modules/wallet/routes/me.js',                   access: 'raw:inv_',  why: 'member app lists/pays invoicing invoices + QR from the wallet (wallet↔invoicing; future: invoicing read/pay hook)' },
];

module.exports = {
  DOMAINS, SHARED_READ_MODELS, SHARED_READ_TABLES, SHARED_WRITE_MODELS, SHARED_TABLES,
  CORE_MODELS, CORE_TO_PRODUCT_HOOKS, KNOWN_EXCEPTIONS,
};
