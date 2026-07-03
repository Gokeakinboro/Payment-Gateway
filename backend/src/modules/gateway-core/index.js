'use strict';
/**
 * gateway-core — the money organism of Paylode.
 *
 * Checkout, virtual-accounts (PalmPay webhook), transactions, payouts,
 * settlements, rails, merchants, reports, chargebacks, aggregators and deferrals,
 * plus the shared money engine (feeEngine, payinFinalize, payoutSettle,
 * palmpayService, cardRouter, interswitchService, railFloat, railHealth,
 * receiptEmail) live under this folder. They share one Transaction table + one
 * PrismaClient and cannot be cut apart without a shared settlement library — so
 * they stay ONE cohesive unit (see plan: keep the money core whole; split only
 * the product modules for independent deploy).
 *
 * These modules are still mounted individually (at their existing external paths,
 * in order) by the top-level registry — this file does NOT re-mount them for the
 * monolith. It exists to (a) name the boundary and (b) give the future
 * gateway-core *service* (P3) a single entrypoint: everything that is not a
 * self-contained product module (invoicing / wallet / assistant).
 *
 * Cross-cutting infra deliberately kept OUTSIDE gateway-core because product
 * modules also depend on it: webhookService, emailService, complianceService,
 * auditService, amlService (src/services/), middleware/auth, utils/*.
 */
const { MODULES, mountModules } = require('../registry');

// The gateway-core service = the whole API minus the product modules.
const GATEWAY_CORE_MODULES = MODULES.filter((m) => m.category !== 'product');

/**
 * Mount the gateway-core surface onto an app (used by the P3 core-service
 * entrypoint). Reuses the registry's guarded mounting + health map.
 */
function mountGatewayCore(app, opts = {}) {
  return mountModules(app, { ...opts, modules: GATEWAY_CORE_MODULES });
}

module.exports = { GATEWAY_CORE_MODULES, mountGatewayCore };
