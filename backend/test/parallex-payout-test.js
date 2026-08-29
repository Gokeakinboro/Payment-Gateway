'use strict';
// Parallex VA + payout rail test — escalating amounts, every 30 min (5 runs).
//
// Run 1: N30 to each bank, Run 2: N31, ..., Run 5: N34.
// VA creation is a health probe only (no money movement).
// Payouts are real — deducts from the Parallex payout float.
//
// Setup on server 176:
//   1. scp backend/test/parallex-payout-test.js root@176.57.188.45:/opt/paylode-api/backend/test/
//   2. Add cron (crontab -e):
//      */30 * * * * cd /opt/paylode-api/backend && node test/parallex-payout-test.js >> /opt/paylode-api/logs/parallex-payout-cron.log 2>&1
//   3. Run once immediately to start: node test/parallex-payout-test.js
//
// ⚠  Real money: N30→N34 × 2 banks per run = N320 total over 5 runs.
//    Script self-expires after 5 runs — remove the cron entry when done.
//
// State file tracks run number so the same cron command works for all 5 runs.

const MAX_RUNS       = 5;
const BASE_KOBO      = 3000;       // N30 in kobo
const GTBANK_CODE    = '058';      // → NIP 000013
const GTBANK_ACCOUNT = '0005061067';
const OPAY_CODE      = '305';      // → NIP 100004
const OPAY_ACCOUNT   = '7030000266';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs   = require('fs');
const path = require('path');

const va       = require('../src/modules/gateway-core/services/parallexService');
const transfer = require('../src/modules/gateway-core/services/parallexTransferService');

const LOG_DIR    = process.env.PARALLEX_PAYOUT_TEST_LOG_DIR || '/opt/paylode-api/logs';
const LOG_FILE   = process.env.PARALLEX_PAYOUT_TEST_LOG     || path.join(LOG_DIR, 'parallex-payout-test.log');
const STATE_FILE = process.env.PARALLEX_PAYOUT_TEST_STATE   || path.join(LOG_DIR, 'parallex-payout-test-state.json');

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return { run: 0 }; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) {
    log(`WARN: could not write state file: ${e.message}`);
  }
}

function mark(name, ok, code, reason, ms) {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  code=${code}  ${ms}ms  ${reason || ''}`);
  return { name, ok };
}

async function checkVA(runIdx) {
  if (!va.isConfigured()) { log('  SKIP  VA (PARALLEX_VA_* not set)'); return null; }
  const ref = `PT-VA-R${runIdx}-${Date.now()}`;
  const t0  = Date.now();
  try {
    const r = await va.createTimedAccount({
      firstName: 'Paylode', lastName: 'Test',
      amountKobo: 100000, referenceId: ref, expiryMinutes: 30,
    });
    return mark('VA:createTimedAccount', r.ok, r.code, r.reason, Date.now() - t0);
  } catch (e) {
    return mark('VA:createTimedAccount', false, 'ERR', e.message, Date.now() - t0);
  }
}

async function checkBalance() {
  if (!transfer.isConfigured()) return null;
  const t0 = Date.now();
  try {
    const kobo  = await transfer.getBalance();
    const naira = Number(kobo) / 100;
    log(`  INFO  Transfer:balance  N${naira.toLocaleString('en-NG')}  ${Date.now() - t0}ms`);
    return { name: 'Transfer:balance', ok: true };
  } catch (e) {
    return mark('Transfer:balance', false, 'ERR', e.message, Date.now() - t0);
  }
}

async function sendTo(label, bankCode, accountNumber, amountKobo, runIdx) {
  if (!transfer.isConfigured()) { log(`  SKIP  Payout:${label} (PARALLEX_TRANSFER_* not set)`); return null; }
  const ref = `PT-${label.toUpperCase()}-R${runIdx}-${Date.now()}`;
  const t0  = Date.now();
  try {
    const r = await transfer.sendPayout({
      orderId:        ref,
      amount:         amountKobo,
      bank_code:      bankCode,
      account_number: accountNumber,
      account_name:   '',
      narration:      `Paylode rail test run ${runIdx + 1}/${MAX_RUNS}`,
    });
    return mark(`Payout:${label}(${accountNumber})`, r.ok, r.code, r.reason, Date.now() - t0);
  } catch (e) {
    return mark(`Payout:${label}(${accountNumber})`, false, 'ERR', e.message, Date.now() - t0);
  }
}

(async () => {
  const state = readState();

  if (state.run >= MAX_RUNS) {
    log(`Parallex payout test complete — all ${MAX_RUNS} runs done. Remove the cron entry.`);
    process.exit(0);
  }

  const runIdx   = state.run;
  const amtKobo  = BASE_KOBO + (runIdx * 100);
  const amtNaira = amtKobo / 100;

  log(`=== Parallex payout test — run ${runIdx + 1}/${MAX_RUNS}, N${amtNaira} per bank ===`);

  if (!va.isConfigured() && !transfer.isConfigured()) {
    log('ERROR: No Parallex env vars set — check .env');
    process.exit(1);
  }

  // Balance check first (sequential — informational, no money movement)
  await checkBalance();

  // VA probe + both payouts in parallel
  const checks = await Promise.all([
    checkVA(runIdx),
    sendTo('GTBank', GTBANK_CODE, GTBANK_ACCOUNT, amtKobo, runIdx),
    sendTo('OPay',   OPAY_CODE,   OPAY_ACCOUNT,   amtKobo, runIdx),
  ]);

  const valid  = checks.filter(Boolean);
  const passed = valid.filter(c => c.ok).length;
  const failed = valid.filter(c => !c.ok).length;

  log(`=== END run ${runIdx + 1} — ${passed}/${valid.length} passed, ${failed} failed ===\n`);

  writeState({ run: runIdx + 1, lastRun: new Date().toISOString(), lastAmount: amtNaira });

  process.exit(failed > 0 ? 1 : 0);
})();
