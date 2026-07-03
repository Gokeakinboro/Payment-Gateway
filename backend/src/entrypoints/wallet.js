'use strict';
/** paylode-wallet service — mounts only the wallet/Paymula module (/api/v1/wallet). */
const { MODULES } = require('../modules/registry');
const { bootService } = require('./_boot');

const svc = bootService({
  serviceName: 'paylode-wallet',
  modules: MODULES.filter((m) => m.name === 'wallet'),
  port: process.env.WALLET_PORT || 3102,
});

if (require.main === module) svc.start();
module.exports = svc;
