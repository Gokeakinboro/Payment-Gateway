'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Parallex TPT smoke test — sandbox + pilot
//
//  Usage:
//    # Sandbox (no VPN, no real money):
//    PARALLEX_TRANSFER_USERNAME=pet \
//    PARALLEX_TRANSFER_PASSWORD=<sandbox-pw> \
//    PARALLEX_TRANSFER_SUBKEY=<sandbox-subkey> \
//    PARALLEX_TRANSFER_DEBIT_ACCOUNT=1000111700 \
//    node test/parallex-tpt-smoke.js --sandbox
//
//    # Pilot (VPN must be up, real money):
//    node test/parallex-tpt-smoke.js --pilot
//
//  Flags:
//    --sandbox   Use sandbox intra-bank transfer (beneficiaryBankCode 999998, no NIP hop)
//    --pilot     Use pilot env vars from .env, send N10 to GTBank
//    --skip-transfer   Run login + balance + NE only, no money movement
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const args = process.argv.slice(2);
const isSandbox     = args.includes('--sandbox');
const isPilot       = args.includes('--pilot');
const skipTransfer  = args.includes('--skip-transfer');

const svc = require('../src/modules/gateway-core/services/parallexTransferService');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function ok(label)  { log(`  ✅ ${label}`); }
function fail(label) { log(`  ❌ ${label}`); }
function section(t)  { console.log(`\n${'─'.repeat(60)}\n  ${t}\n${'─'.repeat(60)}`); }

(async () => {
  if (!isSandbox && !isPilot) {
    console.log('Pass --sandbox or --pilot');
    process.exit(1);
  }

  section(isSandbox ? 'SANDBOX smoke (no VPN, no real money)' : 'PILOT smoke (VPN required)');

  // ── 1. isConfigured ─────────────────────────────────────────────────────────
  if (!svc.isConfigured()) {
    fail('isConfigured: missing env vars (USERNAME / PASSWORD / SUBKEY / DEBIT_ACCOUNT)');
    process.exit(1);
  }
  ok('isConfigured');

  // ── 2. GetBalance ───────────────────────────────────────────────────────────
  section('GetBalance');
  try {
    const bal = await svc.getBalance();
    ok(`Balance: N${(Number(bal) / 100).toLocaleString()}`);
  } catch (e) {
    fail(`GetBalance: ${e.message}`);
  }

  if (isSandbox) {
    // ── Sandbox: intrabank transfer (999998 is Parallex sandbox test bank) ──
    if (!skipTransfer) {
      section('IntrabankTransfer (sandbox bank 999998)');
      const ref = `SMOKE-SB-${Date.now()}`;
      const t = Date.now();
      try {
        const r = await svc.sendPayout({
          orderId: ref,
          amount: 1000,             // N10 in kobo
          bank_code: '999015',      // Parallex own code → isIntra=true path
          account_number: '1000111700',
          account_name: 'SANDBOX TEST',
          narration: 'TPT smoke test',
        });
        const ms = Date.now() - t;
        if (r.code === '00') ok(`Transfer: code=${r.code} ${ms}ms  ${r.reason}`);
        else fail(`Transfer: code=${r.code} ${ms}ms  ${r.reason}`);
        console.log(JSON.stringify(r.raw, null, 2));
      } catch (e) {
        fail(`Transfer ERROR (${Date.now()-t}ms): ${e.message}`);
      }
    }
  }

  if (isPilot) {
    // ── Pilot: NE + interbank NIP ────────────────────────────────────────────
    const GT_ACCOUNT = '0005061067';
    const GT_NIP     = '000013';

    section('NameEnquiry → GTBank 0005061067');
    let ne;
    const t0 = Date.now();
    try {
      ne = await svc.nameEnquiry(GT_NIP, GT_ACCOUNT);
      if (ne.ok) ok(`NE: name="${ne.accountName}" sessionId=${ne.sessionId} (${Date.now()-t0}ms)`);
      else fail(`NE failed: ${ne.reason} (${Date.now()-t0}ms)`);
    } catch (e) {
      fail(`NE ERROR (${Date.now()-t0}ms): ${e.message}`);
      process.exit(1);
    }

    if (!skipTransfer && ne && ne.ok) {
      section('InterbankTransfer → GTBank N10');
      const ref = `SMOKE-PIL-${Date.now()}`;
      const t1 = Date.now();
      try {
        const r = await svc.sendPayout({
          orderId: ref,
          amount: 1000,           // N10
          bank_code: '058',       // GTBank CBN code
          account_number: GT_ACCOUNT,
          account_name: ne.accountName || '',
          narration: undefined,
        });
        const ms = Date.now() - t1;
        if (r.code === '00') ok(`Transfer: code=${r.code} ${ms}ms  ${r.reason}`);
        else fail(`Transfer: code=${r.code} orderStatus=${r.orderStatus} ${ms}ms  ${r.reason}`);
        console.log(JSON.stringify(r.raw, null, 2));
      } catch (e) {
        fail(`Transfer ERROR (${Date.now()-t1}ms): ${e.message}`);
      }
    }
  }

  console.log('\n');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
