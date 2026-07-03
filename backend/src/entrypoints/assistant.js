'use strict';
/** paylode-assistant service — mounts only the assistant module (/api/v1/assistant). */
const { MODULES } = require('../modules/registry');
const { bootService } = require('./_boot');

const svc = bootService({
  serviceName: 'paylode-assistant',
  modules: MODULES.filter((m) => m.name === 'assistant'),
  port: process.env.ASSISTANT_PORT || 3103,
});

if (require.main === module) svc.start();
module.exports = svc;
