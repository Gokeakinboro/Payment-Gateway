'use strict';
/**
 * Paylode Services Limited — API Server (monolith entry).
 * CBN Licensed PSSP.
 *
 * Runs the WHOLE gateway in one process: all modules (via the shared appFactory)
 * plus the gateway-core background jobs. This is the current production process
 * (`paylode-api`). The P3 per-service entrypoints (entrypoints/*.js) reuse the
 * same appFactory with module subsets; this monolith stays as the safe fallback.
 */
const { createApp } = require('./appFactory');
const { logger }     = require('./utils/logger');
const { prisma }     = require('./utils/db');
const { startCoreJobs } = require('./modules/gateway-core/jobs');

const PORT = process.env.PORT || 3000;
const { app, moduleHealth } = createApp({ logger });

async function start() {
  try {
    await prisma.$connect();
    logger.info('✓ Database connected');

    app.listen(PORT, () => {
      logger.info(`✓ Paylode API running on port ${PORT} [${process.env.NODE_ENV}]`);
      logger.info(`  Health: http://localhost:${PORT}/health`);
      logger.info(`  CBN License: ${process.env.CBN_LICENSE_NO}`);
    });

    startCoreJobs({ logger });
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

// Auto-start only when run directly (`node src/server.js`); required by tooling
// (route-parity, tests) returns the app without connecting the DB or binding a port.
if (require.main === module) start();

module.exports = { app, start, moduleHealth };
