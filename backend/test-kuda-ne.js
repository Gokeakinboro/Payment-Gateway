'use strict';
// Quick smoke-test: PalmPay NE for a Kuda account.
// Run on server 176:
//   node /opt/paylode-api/backend/test-kuda-ne.js <kuda_account_number>
// Example: node test-kuda-ne.js 2088393403
// Uses the same palmpayService.js the live API uses — no DB, no real money.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const palmpay = require('./src/modules/gateway-core/services/palmpayService');

const KUDA_CODES = ['090267', '100002', '100'];

async function main() {
  const accountNumber = process.argv[2];
  if (!accountNumber) {
    console.error('Usage: node test-kuda-ne.js <kuda_account_number>');
    process.exit(1);
  }

  if (!palmpay.isConfigured()) {
    console.error('PalmPay not configured — check PALMPAY_APP_ID / PALMPAY_MERCHANT_ID env vars');
    process.exit(1);
  }

  console.log(`\nTesting PalmPay NE for Kuda account: ${accountNumber}\n`);

  for (const code of KUDA_CODES) {
    process.stdout.write(`  bankCode=${code} → `);
    try {
      const r = await palmpay.nameEnquiry(code, accountNumber);
      if (r.ok) {
        console.log(`✓ SUCCESS — accountName: "${r.accountName}"`);
      } else {
        console.log(`✗ FAILED  — reason: "${r.reason}"`);
      }
    } catch (err) {
      console.log(`✗ THREW   — ${err.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
