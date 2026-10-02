'use strict';
// Quick smoke-test: Dojah KYC + AML sandbox — BVN, NIN, CAC lookups and
// AML/PEP/sanctions screening using Dojah's own published sandbox test
// values (deterministic mock data, no real PII).
// Run:
//   node backend/test-dojah-kyc.js
// Requires env vars: DOJAH_APP_ID, DOJAH_SECRET_KEY (sandbox secret key from
// Developers > Configuration > Reveal key). DOJAH_ENV defaults to 'sandbox'.
// Uses the same dojahKycService.js the live API would use — no DB writes.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const dojah = require('./src/services/dojahKycService');

async function main() {
  if (!dojah.isConfigured()) {
    console.error('Dojah not configured — set DOJAH_APP_ID / DOJAH_SECRET_KEY env vars');
    process.exit(1);
  }

  console.log('\nTesting Dojah KYC sandbox lookups\n');

  process.stdout.write('  BVN 22222222222 → ');
  try {
    const r = await dojah.verifyBvn('22222222222');
    console.log(r.success ? `✓ SUCCESS — ${r.data.firstName} ${r.data.lastName}` : `✗ FAILED — ${r.message}`);
  } catch (err) { console.log(`✗ THREW — ${err.message}`); }

  process.stdout.write('  NIN 70123456789 → ');
  try {
    const r = await dojah.verifyNin('70123456789');
    console.log(r.success ? `✓ SUCCESS — ${r.data.firstName} ${r.data.lastName}` : `✗ FAILED — ${r.message}`);
  } catch (err) { console.log(`✗ THREW — ${err.message}`); }

  for (const rc of ['1261103', '14320749']) {
    process.stdout.write(`  CAC rc_number=${rc} → `);
    try {
      const r = await dojah.verifyCac(rc, 'COMPANY');
      console.log(r.success ? `✓ SUCCESS — ${r.data.companyName}` : `✗ FAILED — ${r.message}`);
    } catch (err) { console.log(`✗ THREW — ${err.message}`); }
  }

  console.log('\nTesting Dojah AML/PEP/sanctions screening sandbox\n');

  process.stdout.write('  AML screen "Dojah Handsome" (sandbox no-match fixture) → ');
  try {
    const r = await dojah.screenAml({ names: 'Dojah Handsome' });
    console.log(r.success
      ? `✓ SUCCESS — match_status=${r.matchStatus}, risk=${r.riskLevel}, results=${r.totalResults}`
      : `✗ FAILED — ${r.message}`);
  } catch (err) { console.log(`✗ THREW — ${err.message}`); }

  process.stdout.write('  AML screen "John Doe" (likely PEP/sanctions hit) → ');
  try {
    const r = await dojah.screenAml({ names: 'John Doe', dateOfBirth: '1985-04-15', nationality: 'NG' });
    console.log(r.success
      ? `✓ SUCCESS — match_status=${r.matchStatus}, risk=${r.riskLevel}, results=${r.totalResults}`
      : `✗ FAILED — ${r.message}`);
  } catch (err) { console.log(`✗ THREW — ${err.message}`); }

  process.stdout.write('  AML screen organization "Dojah Inc" → ');
  try {
    const r = await dojah.screenAml({ schema: 'organization', names: 'Dojah Inc' });
    console.log(r.success
      ? `✓ SUCCESS — match_status=${r.matchStatus}, risk=${r.riskLevel}, results=${r.totalResults}`
      : `✗ FAILED — ${r.message}`);
  } catch (err) { console.log(`✗ THREW — ${err.message}`); }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
