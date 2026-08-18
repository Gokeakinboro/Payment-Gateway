'use strict';
// One-shot test: confirm intrabank payout FROM the VA collections account.
//
// Flow being tested:
//   1000362856 (VA collections / settlement) → 1000362849 (payout debit float)
//   Amount: ₦102 (10200 kobo) — intrabank, no NIBSS needed.
//
// Run on server 176 (VPN must be up):
//   node backend/test/parallex-intrabank-test.js
//
// Override any value via env:
//   DEBIT_FROM=1000362856 RECIPIENT_ACCOUNT=1000362849 AMOUNT_KOBO=10200 \
//     node backend/test/parallex-intrabank-test.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// Override debit account to VA collections account BEFORE the service reads env.
// The service default (PARALLEX_TRANSFER_DEBIT_ACCOUNT) is the payout float account;
// here we're testing the VA→payout direction so we debit the collections account.
const DEBIT_FROM        = process.env.DEBIT_FROM        || '1000362856';
const RECIPIENT_ACCOUNT = process.env.RECIPIENT_ACCOUNT || '1000362849';
const RECIPIENT_NAME    = process.env.RECIPIENT_NAME    || 'PAYLODE PAYOUT FLOAT';
const AMOUNT_KOBO       = Number(process.env.AMOUNT_KOBO || '10200');   // ₦102
const BANK_CODE         = process.env.PARALLEX_TRANSFER_BANK_CODE || '999015';  // Parallex = intrabank

// Patch env so the service module uses our chosen debit account.
process.env.PARALLEX_TRANSFER_DEBIT_ACCOUNT = DEBIT_FROM;

const transfer = require('../src/modules/gateway-core/services/parallexTransferService');

function line(label, value) { console.log(`  ${label.padEnd(26)} ${value}`); }
function sep() { console.log('─'.repeat(64)); }

(async () => {
  sep();
  console.log('Parallex TPT — VA collections → Payout float (intrabank)');
  console.log(`  Base URL        : ${transfer.BASE_URL}`);
  console.log(`  Debit (FROM)    : ${DEBIT_FROM}  (VA collections account)`);
  console.log(`  Recipient (TO)  : ${RECIPIENT_ACCOUNT}  (${RECIPIENT_NAME})`);
  console.log(`  Amount          : ₦${(AMOUNT_KOBO / 100).toFixed(2)}`);
  console.log(`  Bank code       : ${BANK_CODE} (Parallex — intrabank, no NIBSS)`);
  sep();

  if (!transfer.isConfigured()) {
    console.error('ERROR: PARALLEX_TRANSFER_USERNAME / PASSWORD / SUBKEY not set in .env');
    process.exit(1);
  }

  // ─── 1. Balance on the VA collections account ─────────────────────────────
  console.log('\n[1/3] Checking VA collections account balance...');
  let balanceKobo;
  try {
    balanceKobo = await transfer.getBalance();
    line('Balance (1000362856):', `₦${(Number(balanceKobo) / 100).toFixed(2)}`);
    if (Number(balanceKobo) < AMOUNT_KOBO) {
      console.error(`  ⚠  Insufficient — need ₦${(AMOUNT_KOBO/100).toFixed(2)}, have ₦${(Number(balanceKobo)/100).toFixed(2)}`);
      process.exit(1);
    }
    console.log('  ✓ Sufficient balance');
  } catch (err) {
    console.error('  ✗ Balance check failed:', err.message);
    console.error('    (VPN up? Check /var/log/parallex-vpn.log on server 176)');
    process.exit(1);
  }

  // ─── 2. Intrabank transfer ────────────────────────────────────────────────
  const orderId = `VA-OUT-TEST-${Date.now()}`;
  console.log(`\n[2/3] Sending ₦${(AMOUNT_KOBO/100).toFixed(2)} intrabank (ref: ${orderId})...`);
  let result;
  try {
    result = await transfer.sendPayout({
      orderId,
      amount:         AMOUNT_KOBO,
      bank_code:      BANK_CODE,
      account_number: RECIPIENT_ACCOUNT,
      account_name:   RECIPIENT_NAME,
      narration:      'VA collections test payout',
    });
  } catch (err) {
    console.error('  ✗ sendPayout threw:', err.message);
    process.exit(1);
  }

  sep();
  line('ok:',          String(result.ok));
  line('code:',        result.code || '(none)');
  line('orderStatus:', result.orderStatus || '(none)');
  line('reason:',      result.reason || '(none)');
  line('providerRef:', result.providerRef || '(none)');
  sep();
  if (result.raw) {
    console.log('\nRaw Parallex response:');
    console.log(JSON.stringify(result.raw, null, 2));
    sep();
  }

  // ─── 3. Immediate requery ─────────────────────────────────────────────────
  console.log('\n[3/3] TransactionQuery (immediate requery)...');
  try {
    const rq = await transfer.queryPayoutResult({
      orderId,
      amount:        AMOUNT_KOBO,
      accountNumber: RECIPIENT_ACCOUNT,
      bankCode:      BANK_CODE,
    });
    line('requery.code:',        rq.code || '(none)');
    line('requery.orderStatus:', rq.orderStatus || '(none)');
    line('requery.reason:',      rq.reason || '(none)');
    if (rq.raw) {
      console.log('\nRequery raw:');
      console.log(JSON.stringify(rq.raw, null, 2));
    }
  } catch (err) {
    console.error('  ✗ requery failed:', err.message);
  }

  sep();
  if (result.ok && result.orderStatus === '2') {
    console.log('RESULT: ✅  SETTLED — VA collections → payout float confirmed');
    console.log(`         ₦${(AMOUNT_KOBO/100).toFixed(2)} moved from 1000362856 → ${RECIPIENT_ACCOUNT}`);
  } else if (result.ok) {
    console.log('RESULT: 🟡  ACCEPTED & IN-FLIGHT — poller will confirm settlement');
    console.log(`         orderStatus=${result.orderStatus}, code=${result.code}`);
  } else {
    console.log('RESULT: ❌  FAILED — see code/reason above');
    process.exit(1);
  }
  sep();
})();
