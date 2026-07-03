'use strict';
/**
 * Shared boot logic for the P3 per-service entrypoints. Each service is the SAME
 * codebase + appFactory, differing only in which module subset it mounts, its
 * port, and whether it runs the gateway-core background jobs. nginx path-routes
 * public traffic to the right service, so external paths are unchanged.
 */
const { createApp } = require('../appFactory');
const { logger }    = require('../utils/logger');
const { prisma }    = require('../utils/db');

function bootService({ serviceName, modules, port, withCoreJobs = false }) {
  process.env.SERVICE_NAME = process.env.SERVICE_NAME || serviceName;
  const { app, moduleHealth } = createApp({ logger, modules });

  async function start() {
    try {
      await prisma.$connect();
      logger.info(`✓ [${serviceName}] Database connected`);
      // Bind loopback only — these services sit BEHIND the 176 nginx router
      // (which proxies to 127.0.0.1:<port>), so they must not be publicly reachable.
      app.listen(port, '127.0.0.1', () => {
        logger.info(`✓ ${serviceName} on 127.0.0.1:${port} [${process.env.NODE_ENV}]`);
        logger.info(`  Health:  http://localhost:${port}/health`);
        logger.info(`  Modules: ${modules.map(m => m.name).join(', ') || '(none)'}`);
      });
      if (withCoreJobs) require('../modules/gateway-core/jobs').startCoreJobs({ logger });
    } catch (err) {
      logger.error(`Failed to start ${serviceName}:`, err);
      process.exit(1);
    }
  }

  process.on('SIGTERM', async () => {
    logger.info(`SIGTERM — ${serviceName} shutting down gracefully`);
    await prisma.$disconnect();
    process.exit(0);
  });

  return { app, moduleHealth, start };
}

module.exports = { bootService };
