'use strict';
/**
 * paylode-core service — the money organism + all non-product core routes
 * (everything except invoicing / wallet / assistant). Runs the gateway-core
 * background jobs. Default port 3000 so it can drop-in replace the monolith.
 */
const { GATEWAY_CORE_MODULES } = require('../modules/gateway-core');
const { bootService } = require('./_boot');

const svc = bootService({
  serviceName: 'paylode-core',
  modules: GATEWAY_CORE_MODULES,
  port: process.env.CORE_PORT || process.env.PORT || 3000,
  withCoreJobs: true,
});

if (require.main === module) svc.start();
module.exports = svc;
