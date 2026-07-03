'use strict';
/** paylode-invoicing service — mounts only the invoicing module (/api/v1/invoicing). */
const { MODULES } = require('../modules/registry');
const { bootService } = require('./_boot');

const svc = bootService({
  serviceName: 'paylode-invoicing',
  modules: MODULES.filter((m) => m.name === 'invoicing'),
  port: process.env.INVOICING_PORT || 3101,
});

if (require.main === module) svc.start();
module.exports = svc;
