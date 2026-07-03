'use strict';
/**
 * Paylode Services Limited — API Server
 * CBN Licensed PSSP
 */

require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const compression = require('compression');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

const { logger }   = require('./utils/logger');
// KYC deferral-expiry sweep self-schedules on require (advisory-locked, all workers).
// Guarded so a failure here can't crash boot.
try { require('./services/deferralExpiryService'); }
catch (e) { logger.error({ err: e }, '✗ deferralExpiryService failed to load (continuing)'); }
const { prisma }   = require('./utils/db');
const errorHandler = require('./middleware/errorHandler');

// Guarded, ordered module mounting (see modules/registry.js). Replaces the old
// top-level route requires: a bad require in any one module no longer crashes boot.
const { mountModules } = require('./modules/registry');

// Populated by mountModules() below; read by the /health endpoints.
const moduleHealth = {};

const app  = express();
const PORT = process.env.PORT || 3000;

// res.json can't serialize BigInt (kobo amounts) — emit them as numbers so any
// endpoint returning a raw Prisma row (e.g. payment_rails float/cost) won't 500.
app.set('json replacer', (key, value) => (typeof value === 'bigint' ? Number(value) : value));

// ── Security middleware ────────────────────────────────────────────────────
app.set('trust proxy', 1); // Behind nginx/Cloudflare

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      scriptSrc:  ["'self'"],
      imgSrc:     ["'self'", 'data:'],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));

app.use(cors({
  origin: [
    process.env.APP_URL,
    'https://merchant.paylodeservices.com',
    'https://compliance.paylodeservices.com',
    ...(process.env.NODE_ENV === 'development' ? ['http://localhost:3001', 'http://localhost:5173'] : []),
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Paylode-Signature'],
}));

app.use(compression());
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// ── Body parsing ──────────────────────────────────────────────────────────
// Raw body preserved for webhook signature verification
app.use('/api/v1/webhooks/inbound', express.raw({ type: 'application/json' }));
// Onboarding submit carries base64 document scans + the signature image in one
// JSON body — needs a much larger limit than the default API requests.
app.use('/api/v1/onboarding/submit', express.json({ limit: process.env.ONBOARDING_BODY_LIMIT || '50mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Global rate limiting ───────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { status: false, message: 'Too many requests, please try again later.', error_code: 'RATE_LIMIT_EXCEEDED' },
});
app.use('/api/', globalLimiter);

// Stricter limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { status: false, message: 'Too many login attempts.', error_code: 'AUTH_RATE_LIMIT' },
});
app.use('/api/v1/auth/login', authLimiter);

// Public onboarding submit creates an (inactive) account per call — limit abuse.
const onboardingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: parseInt(process.env.ONBOARDING_RATE_MAX) || 10,
  standardHeaders: true, legacyHeaders: false,
  message: { status: false, message: 'Too many onboarding submissions. Please try again later.', error_code: 'ONBOARDING_RATE_LIMIT' },
});
app.use('/api/v1/onboarding/submit', onboardingLimiter);

// ── Health check ──────────────────────────────────────────────────────────
// Summarise per-module load status (ok/failed/disabled) so a partially-degraded
// gateway is observable rather than silently down.
const moduleSummary = () => {
  const s = { ok: 0, failed: 0, disabled: 0 };
  const failed = [];
  for (const [name, m] of Object.entries(moduleHealth)) {
    s[m.status] = (s[m.status] || 0) + 1;
    if (m.status === 'failed') failed.push(name);
  }
  return { counts: s, failed };
};

app.get('/health', async (req, res) => {
  const mods = moduleSummary();
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status:    mods.counts.failed > 0 ? 'degraded' : 'healthy',
      service:   'Paylode API',
      version:   '1.0.0',
      db:        'connected',
      modules:   mods,
      timestamp: new Date().toISOString(),
      cbn:       process.env.CBN_LICENSE_NO || 'configured',
    });
  } catch (e) {
    res.status(503).json({ status: 'unhealthy', db: 'disconnected', modules: mods, error: e.message });
  }
});

// Per-module detail (which loaded, which failed + why, which are toggled off).
app.get('/health/modules', (req, res) => {
  res.json({ status: true, modules: moduleHealth });
});

// ── API Routes ────────────────────────────────────────────────────────────
// Each module is loaded lazily inside try/catch (see modules/registry.js). One
// module failing to load records `failed` + serves 503 at its path — the rest of
// the gateway still boots. Order is preserved from the registry (significant for
// overlapping prefixes like /webhooks vs /webhooks/palmpay).
mountModules(app, { logger, health: moduleHealth });

// ── 404 handler ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ status: false, message: `Route ${req.method} ${req.path} not found`, error_code: 'NOT_FOUND' });
});

// ── Global error handler ──────────────────────────────────────────────────
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────────
async function start() {
  try {
    await prisma.$connect();
    logger.info('✓ Database connected');

    app.listen(PORT, () => {
      logger.info(`✓ Paylode API running on port ${PORT} [${process.env.NODE_ENV}]`);
      logger.info(`  Health: http://localhost:${PORT}/health`);
      logger.info(`  CBN License: ${process.env.CBN_LICENSE_NO}`);
    });

    // Background jobs run on ONE pm2 worker only (instance 0) to avoid N× polling.
    // Each job is started inside its own try/catch so a failure to load/schedule
    // one can't crash boot (same guarantee the module registry gives the routes).
    if ((process.env.NODE_APP_INSTANCE || '0') === '0') {
      // Rail-float poll — refresh OUR balance on each payout rail (PalmPay etc.).
      try {
        const { syncAllFloats } = require('./services/railFloat');
        const POLL_MS = Number(process.env.RAIL_FLOAT_POLL_MS || 10 * 60 * 1000); // 10 min
        const run = () => syncAllFloats().catch(e => logger.error({ err: e }, 'rail float poll failed'));
        setTimeout(run, 15000);          // once shortly after boot
        setInterval(run, POLL_MS);       // then on a schedule
        logger.info(`  Rail-float poll every ${Math.round(POLL_MS / 60000)} min (worker 0)`);
      } catch (e) {
        logger.error({ err: e }, '  ✗ rail-float poll failed to start (continuing)');
      }

      // Stuck-'sent' payout reconciliation — backstop for payout legs whose rail
      // webhook never landed. Queries the rail's payout-result API and settles/refunds
      // via the same shared logic as the webhook. Worker 0 only.
      try {
        const { reconcileSentPayouts } = require('./services/payoutSettle');
        const RECON_MS = Number(process.env.PAYOUT_RECON_MS || 3 * 60 * 1000); // 3 min
        const recon = () => reconcileSentPayouts().catch(e => logger.error({ err: e }, 'payout reconciliation failed'));
        setTimeout(recon, 25000);        // once shortly after boot
        setInterval(recon, RECON_MS);    // then on a schedule
        logger.info(`  Stuck-sent payout reconciliation every ${Math.round(RECON_MS / 60000)} min (worker 0)`);
      } catch (e) {
        logger.error({ err: e }, '  ✗ payout reconciliation failed to start (continuing)');
      }
    }
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  await prisma.$disconnect();
  process.exit(0);
});

// Auto-start only when run directly (`node src/server.js`). When required by a
// test/tooling harness (route-parity dump, future per-service entrypoints), the
// app is returned without connecting the DB or binding a port.
if (require.main === module) start();

module.exports = { app, start, moduleHealth };
