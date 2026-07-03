'use strict';
/**
 * Shared Express app factory. ONE definition of the gateway's middleware stack,
 * health endpoints, guarded module mounting, 404 + error handler — used by both
 * the monolith (server.js, all modules) and the P3 per-service entrypoints
 * (entrypoints/*.js, each a module subset). Keeps the services byte-identical in
 * behavior to the monolith and prevents middleware drift.
 *
 * Does NOT connect the DB, bind a port, or start background jobs — callers do
 * that. See entrypoints/ and modules/gateway-core/jobs.js.
 */
require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const { logger: defaultLogger } = require('./utils/logger');
const { prisma }      = require('./utils/db');
const errorHandler    = require('./middleware/errorHandler');
const { mountModules, MODULES } = require('./modules/registry');

/**
 * Build an Express app for the given module subset.
 * @param {object}  opts
 * @param {Array}   opts.modules  registry descriptors to mount (default: all)
 * @param {object}  opts.logger   pino logger (default: shared)
 * @returns {{ app, moduleHealth }}
 */
function createApp({ modules = MODULES, logger = defaultLogger } = {}) {
  const app = express();
  const moduleHealth = {};

  // res.json can't serialize BigInt (kobo amounts) — emit them as numbers so any
  // endpoint returning a raw Prisma row (e.g. payment_rails float/cost) won't 500.
  app.set('json replacer', (key, value) => (typeof value === 'bigint' ? Number(value) : value));

  // ── Security middleware ──────────────────────────────────────────────────
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

  // ── Body parsing ─────────────────────────────────────────────────────────
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

  // ── Health check ───────────────────────────────────────────────────────────
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
        service:   process.env.SERVICE_NAME || 'Paylode API',
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
    res.json({ status: true, service: process.env.SERVICE_NAME || 'Paylode API', modules: moduleHealth });
  });

  // ── API Routes — guarded, ordered (see modules/registry.js) ────────────────
  mountModules(app, { logger, health: moduleHealth, modules });

  // ── 404 handler ────────────────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({ status: false, message: `Route ${req.method} ${req.path} not found`, error_code: 'NOT_FOUND' });
  });

  // ── Global error handler ───────────────────────────────────────────────────
  app.use(errorHandler);

  return { app, moduleHealth };
}

module.exports = { createApp };
