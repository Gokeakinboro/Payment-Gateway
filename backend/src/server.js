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
require('./services/deferralExpiryService');
const { prisma }   = require('./utils/db');
const errorHandler = require('./middleware/errorHandler');

// Routes
const authRoutes        = require('./routes/auth');
const merchantRoutes    = require('./routes/merchants');
const transactionRoutes = require('./routes/transactions');
const webhookRoutes     = require('./routes/webhooks');
const aggregatorRoutes  = require('./routes/aggregators');
const adminRoutes       = require('./routes/admin');
const kycRoutes         = require('./routes/kyc');
const settlementRoutes  = require('./routes/settlements');
const reportRoutes      = require('./routes/reports');
const railRoutes        = require('./routes/rails');
const checkoutRoutes    = require('./routes/checkout');

const app  = express();
const PORT = process.env.PORT || 3000;

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
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status:    'healthy',
      service:   'Paylode API',
      version:   '1.0.0',
      db:        'connected',
      timestamp: new Date().toISOString(),
      cbn:       process.env.CBN_LICENSE_NO || 'configured',
    });
  } catch (e) {
    res.status(503).json({ status: 'unhealthy', db: 'disconnected', error: e.message });
  }
});

// ── API Routes ────────────────────────────────────────────────────────────
app.use('/api/v1/auth',         authRoutes);
app.use('/api/v1/merchants',    merchantRoutes);
app.use('/api/v1/transactions', transactionRoutes);
app.use('/api/v1/webhooks',     webhookRoutes);
app.use('/api/v1/aggregators',  aggregatorRoutes);
app.use('/api/v1/admin',        adminRoutes);
app.use('/api/v1/kyc',          kycRoutes);
app.use('/api/v1/settlements',  settlementRoutes);
app.use('/api/v1/reports',      reportRoutes);
app.use('/api/v1/rails',        railRoutes);
app.use('/api/v1/checkout',     checkoutRoutes);
app.use('/api/v1/onboarding',          require('./routes/onboarding'));
app.use('/api/v1/payouts',             require('./routes/payouts'));
app.use('/api/v1/users',               require('./routes/users'));
app.use('/api/v1/chargebacks',         require('./routes/chargebacks'));
app.use('/api/v1/compliance',          require('./routes/compliance'));
app.use('/api/v1/uploads',             require('./routes/uploads'));
app.use('/api/v1/statements',          require('./routes/statements'));
app.use('/api/v1/admin/email-templates', require('./routes/email-templates'));

app.use('/api/v1/webhooks/youverify', require('./routes/youverify-webhook'));
app.use('/api/v1/webhooks/palmpay', require('./routes/palmpay-webhook'));
app.use('/api/v1/deferrals', require('./routes/deferrals'));
app.use('/api/v1/documents', require('./routes/documents'));
app.use('/api/v1/support', require('./routes/support'));

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

start();
