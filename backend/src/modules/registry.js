'use strict';
/**
 * Module registry — the single ordered list of everything mounted on the API,
 * plus the guarded-mount machinery.
 *
 * WHY: previously server.js require()d every route at top-level and mounted them
 * unguarded. A single bad require (e.g. the 2026-07-01 missing `interswitchService`)
 * threw at boot and took the WHOLE gateway down. Here each module is loaded lazily
 * inside try/catch at mount time: if one fails to load it's recorded as `failed`
 * and its base path serves 503 — every other module still boots.
 *
 * ORDER IS SIGNIFICANT. Express matches `app.use(prefix, router)` in registration
 * order, and some prefixes overlap (`/webhooks` before `/webhooks/palmpay`,
 * `/admin` before `/admin/email-templates`). This array preserves the exact order
 * the routes were mounted in server.js — do not reorder without checking parity.
 *
 * TOGGLES: set `<enabledEnv>=off` to skip a module's mount without deleting code
 * (recorded as `disabled`). Default is on when the env var is unset.
 */

// [ name, basePath, loader, enabledEnv, category ]
// `loader` is lazy so a broken require can't crash module load of the registry itself.
const MODULES = [
  // ── Core / platform ──────────────────────────────────────────────────────
  { name: 'auth',            basePath: '/api/v1/auth',                 load: () => require('../routes/auth'),              enabledEnv: 'MODULE_AUTH_ENABLED',            category: 'core' },
  { name: 'merchants',       basePath: '/api/v1/merchants',            load: () => require('./gateway-core/routes/merchants'),         enabledEnv: 'MODULE_MERCHANTS_ENABLED',       category: 'core' },
  { name: 'transactions',    basePath: '/api/v1/transactions',         load: () => require('./gateway-core/routes/transactions'),      enabledEnv: 'MODULE_TRANSACTIONS_ENABLED',    category: 'money' },
  { name: 'webhooks',        basePath: '/api/v1/webhooks',             load: () => require('../routes/webhooks'),          enabledEnv: 'MODULE_WEBHOOKS_ENABLED',        category: 'core' },
  { name: 'aggregators',     basePath: '/api/v1/aggregators',          load: () => require('./gateway-core/routes/aggregators'),       enabledEnv: 'MODULE_AGGREGATORS_ENABLED',     category: 'core' },
  { name: 'admin',           basePath: '/api/v1/admin',                load: () => require('../routes/admin'),             enabledEnv: 'MODULE_ADMIN_ENABLED',           category: 'core' },
  { name: 'kyc',             basePath: '/api/v1/kyc',                  load: () => require('../routes/kyc'),               enabledEnv: 'MODULE_KYC_ENABLED',             category: 'core' },
  { name: 'settlements',     basePath: '/api/v1/settlements',          load: () => require('./gateway-core/routes/settlements'),       enabledEnv: 'MODULE_SETTLEMENTS_ENABLED',     category: 'money' },
  { name: 'reconciliation',  basePath: '/api/v1/reconciliation',       load: () => require('./gateway-core/routes/reconciliation'),    enabledEnv: 'MODULE_RECONCILIATION_ENABLED',  category: 'money' },
  { name: 'reports',         basePath: '/api/v1/reports',              load: () => require('./gateway-core/routes/reports'),           enabledEnv: 'MODULE_REPORTS_ENABLED',         category: 'core' },
  { name: 'rails',           basePath: '/api/v1/rails',                load: () => require('./gateway-core/routes/rails'),             enabledEnv: 'MODULE_RAILS_ENABLED',           category: 'money' },
  { name: 'checkout',        basePath: '/api/v1/checkout',             load: () => require('./gateway-core/routes/checkout'),          enabledEnv: 'MODULE_CHECKOUT_ENABLED',        category: 'money' },
  { name: 'onboarding',      basePath: '/api/v1/onboarding',           load: () => require('../routes/onboarding'),        enabledEnv: 'MODULE_ONBOARDING_ENABLED',      category: 'core' },
  { name: 'payouts',         basePath: '/api/v1/payouts',              load: () => require('./gateway-core/routes/payouts'),           enabledEnv: 'MODULE_PAYOUTS_ENABLED',         category: 'money' },
  { name: 'routing',         basePath: '/api/v1/routing',              load: () => require('./gateway-core/routes/rail-routing'),      enabledEnv: 'MODULE_ROUTING_ENABLED',         category: 'money' },
  { name: 'users',           basePath: '/api/v1/users',                load: () => require('../routes/users'),             enabledEnv: 'MODULE_USERS_ENABLED',           category: 'core' },
  { name: 'chargebacks',     basePath: '/api/v1/chargebacks',          load: () => require('./gateway-core/routes/chargebacks'),       enabledEnv: 'MODULE_CHARGEBACKS_ENABLED',     category: 'money' },
  { name: 'compliance',      basePath: '/api/v1/compliance',           load: () => require('../routes/compliance'),        enabledEnv: 'MODULE_COMPLIANCE_ENABLED',      category: 'core' },
  { name: 'uploads',         basePath: '/api/v1/uploads',              load: () => require('../routes/uploads'),           enabledEnv: 'MODULE_UPLOADS_ENABLED',         category: 'core' },
  { name: 'statements',      basePath: '/api/v1/statements',           load: () => require('../routes/statements'),        enabledEnv: 'MODULE_STATEMENTS_ENABLED',      category: 'core' },
  { name: 'email-templates', basePath: '/api/v1/admin/email-templates', load: () => require('../routes/email-templates'), enabledEnv: 'MODULE_EMAIL_TEMPLATES_ENABLED', category: 'core' },

  // ── Provider webhooks (specific sub-paths — must stay AFTER /webhooks) ────
  { name: 'youverify-webhook', basePath: '/api/v1/webhooks/youverify', load: () => require('../routes/youverify-webhook'), enabledEnv: 'MODULE_YOUVERIFY_WEBHOOK_ENABLED', category: 'webhook' },
  { name: 'palmpay-webhook',   basePath: '/api/v1/webhooks/palmpay',   load: () => require('./gateway-core/routes/palmpay-webhook'),   enabledEnv: 'MODULE_PALMPAY_WEBHOOK_ENABLED',   category: 'money' },
  { name: 'parallex-webhook',  basePath: '/api/v1/webhooks/parallex',  load: () => require('./gateway-core/routes/parallex-webhook'),  enabledEnv: 'MODULE_PARALLEX_WEBHOOK_ENABLED', category: 'money' },

  // ── More core ────────────────────────────────────────────────────────────
  { name: 'deferrals',     basePath: '/api/v1/deferrals',      load: () => require('./gateway-core/routes/deferrals'),    enabledEnv: 'MODULE_DEFERRALS_ENABLED',     category: 'core' },
  { name: 'documents',     basePath: '/api/v1/documents',      load: () => require('../routes/documents'),    enabledEnv: 'MODULE_DOCUMENTS_ENABLED',     category: 'core' },
  { name: 'support',       basePath: '/api/v1/support',        load: () => require('../routes/support'),      enabledEnv: 'MODULE_SUPPORT_ENABLED',       category: 'core' },
  { name: 'payment-links', basePath: '/api/v1/payment-links',  load: () => require('../routes/paymentLinks'), enabledEnv: 'MODULE_PAYMENT_LINKS_ENABLED', category: 'money' },

  // ── Self-contained product modules ───────────────────────────────────────
  { name: 'invoicing', basePath: '/api/v1/invoicing', load: () => require('./invoicing'), enabledEnv: 'MODULE_INVOICING_ENABLED', category: 'product' },
  { name: 'wallet',    basePath: '/api/v1/wallet',    load: () => require('./wallet'),    enabledEnv: 'MODULE_WALLET_ENABLED',    category: 'product' },
  { name: 'assistant', basePath: '/api/v1/assistant', load: () => require('./assistant'), enabledEnv: 'MODULE_ASSISTANT_ENABLED', category: 'product' },
];

const isDisabled = (m) => String(process.env[m.enabledEnv] || '').toLowerCase() === 'off';

/**
 * Guarded-mount every registered module onto `app`, in order.
 * Populates and returns a health map: { [name]: { status, category, basePath, error? } }.
 * A load failure mounts a 503 stub at the base path instead of crashing boot.
 */
function mountModules(app, { logger, health = {}, modules = MODULES } = {}) {
  for (const m of modules) {
    if (isDisabled(m)) {
      health[m.name] = { status: 'disabled', category: m.category, basePath: m.basePath };
      if (logger) logger.warn(`  ⊘ module '${m.name}' disabled via ${m.enabledEnv}=off (${m.basePath})`);
      continue;
    }
    try {
      const router = m.load();
      app.use(m.basePath, router);
      health[m.name] = { status: 'ok', category: m.category, basePath: m.basePath };
    } catch (err) {
      health[m.name] = { status: 'failed', category: m.category, basePath: m.basePath, error: err.message };
      if (logger) logger.error({ err, module: m.name }, `  ✗ module '${m.name}' failed to load — mounting 503 stub (${m.basePath})`);
      // A failed module must not take down the rest of the gateway.
      app.use(m.basePath, (req, res) => {
        res.status(503).json({
          status: false,
          message: `The '${m.name}' module is temporarily unavailable.`,
          error_code: 'MODULE_UNAVAILABLE',
          module: m.name,
        });
      });
    }
  }
  return health;
}

module.exports = { MODULES, mountModules, isDisabled };
