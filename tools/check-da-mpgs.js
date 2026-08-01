'use strict';
const { PrismaClient } = require('/opt/paylode-api/backend/node_modules/@prisma/client');
const p = new PrismaClient();

const DA_ID = '7548c579-a281-49cf-9ea5-b5ec87fe3f28';

async function run() {
  const cfg = await p.merchantMpgsConfig.findUnique({ where: { merchantId: DA_ID } });
  if (cfg) {
    console.log('MPGS config EXISTS for Drinks Arena:');
    console.log('  MID      :', cfg.mpgsMid);
    console.log('  Active   :', cfg.isActive);
    console.log('  Base URL :', cfg.mpgsBaseUrl);
    console.log('  GW prefix:', cfg.gatewayApiPasswordPrefix);
  } else {
    console.log('NO MPGS config for Drinks Arena — needs to be created.');
  }
  await p.$disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
