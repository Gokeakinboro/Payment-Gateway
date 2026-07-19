'use strict';
// Parallex connectivity health check — fires one VA creation + two transfer probes.
// Designed to run every 6 hours via cron on server 176.
//
// Usage:
//   node test/parallex-health-check.js
//
// Cron (server 176) — every 6 hours, self-expiring 2026-07-17:
//   0 */6 * * * cd /opt/paylode-api/backend && node test/parallex-health-check.js
//
// ⚠  The intra-Parallex transfer (2001095808) sends real ₦1000 per run (₦4k/day).
//    The sandbox transfer (bank 999998) is Parallex's internal test bank — no real money.

// Self-expiry: stops firing after 3 days (2026-07-16 inclusive).
const EXPIRY = new Date('2026-07-17T00:00:00Z');
if (new Date() >= EXPIRY) {
  console.log(`[${new Date().toISOString()}] Parallex health check expired (3-day trial ended 2026-07-17). Remove cron entry.`);
  process.exit(0);
}

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs   = require('fs');
const path = require('path');

const va       = require('../src/modules/gateway-core/services/parallexService');
const transfer = require('../src/modules/gateway-core/services/parallexTransferService');

// Append-only log file on the server; silently falls back to console-only locally.
const LOG_FILE = process.env.PARALLEX_HEALTH_LOG || '/opt/paylode-api/logs/parallex-health.log';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function check(name, ok, code, reason, ms) {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  code=${code}  ${ms}ms  ${reason || ''}`);
  return { name, ok };
}

// ─── 1. VA: create a timed ₦1000 account (no money movement) ────────────────
async function testVA() {
  if (!va.isConfigured()) { log('  SKIP VA (PARALLEX_VA_* not set)'); return null; }
  const ref = `HC-VA-${Date.now()}`;
  const t0  = Date.now();
  try {
    const r = await va.createTimedAccount({
      firstName: 'Health', lastName: 'Check',
      amountKobo: 100000, referenceId: ref, expiryMinutes: 30,
    });
    return check('VA:createTimedAccount', r.ok, r.code, r.reason, Date.now() - t0);
  } catch (e) {
    return check('VA:createTimedAccount', false, 'ERR', e.message, Date.now() - t0);
  }
}

// ─── 2. Transfer: sandbox payload (bank 999998 = Parallex internal test bank) ─
// Uses the raw InterbankTransfer call directly because the service-module path
// runs a name enquiry first, which returns X91 for sandbox bank 999998.
// This is the payload confirmed working on 2026-07-13.
async function testTransferSandbox() {
  if (!transfer.isConfigured()) { log('  SKIP Transfer(sandbox) (PARALLEX_TRANSFER_* not set)'); return null; }
  const ref = `HC-SB-${Date.now()}`;
  const t0  = Date.now();
  try {
    const body = {
      accountToDebit: '1000111700',
      channel: '0',
      interTransferDetails: [{
        amount: '1000',
        beneficiaryAccountName: 'SANDBOX TEST',
        beneficiaryAccountNumber: '2030070786',
        beneficiaryBankCode: '999998',
        nameEnquirySessionID: '379992268455626366377760672676',
        transactionReference: ref,
        beneficiaryBVN: '11111111111',
        beneficiaryKYC: '0',
        beneficiaryBankName: 'Parallex Test Bank',
        customerRemark: 'Paylode health check',
      }],
      transactionLocation: 'Lagos',
      userName: 'pet',
    };
    const r   = await transfer.call('POST', '/api/ThirdPartyTransfer/InterbankTransfer', { body });
    const ok  = String((r && (r.responseCode ?? r.ResponseCode)) ?? '') === '00';
    const code = String((r && (r.responseCode ?? r.ResponseCode)) ?? 'ERR');
    const msg  = (r && (r.responseMessage || r.responseDescription)) || '';
    return check('Transfer:sandbox(999998)', ok, code, msg, Date.now() - t0);
  } catch (e) {
    return check('Transfer:sandbox(999998)', false, 'ERR', e.message, Date.now() - t0);
  }
}

// ─── 3. Transfer: intra-Parallex ₦1000 → 2001095808 (real money, live rails) ─
async function testTransferIntra() {
  if (!transfer.isConfigured()) { log('  SKIP Transfer(intra) (PARALLEX_TRANSFER_* not set)'); return null; }
  const ref = `HC-IN-${Date.now()}`;
  const t0  = Date.now();
  try {
    const r = await transfer.sendPayout({
      orderId: ref, amount: 100000,  // 100000 kobo = ₦1000
      bank_code: '999015',           // Parallex (intra — skips name enquiry)
      account_number: '2001095808',
      account_name: 'SHADE ADIJA MUDASIRU',
      narration: 'Paylode health check',
    });
    return check('Transfer:intra(2001095808)', r.ok, r.code, r.reason, Date.now() - t0);
  } catch (e) {
    return check('Transfer:intra(2001095808)', false, 'ERR', e.message, Date.now() - t0);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
(async () => {
  log('=== Parallex health check START ===');

  if (!va.isConfigured() && !transfer.isConfigured()) {
    log('ERROR: No Parallex env vars set — check PARALLEX_VA_* and PARALLEX_TRANSFER_* in .env');
    process.exit(1);
  }

  const results = await Promise.all([
    testVA(),
    testTransferSandbox(),
    testTransferIntra(),
  ]);

  const checks  = results.filter(Boolean);
  const passed  = checks.filter(c => c.ok).length;
  const failed  = checks.filter(c => !c.ok).length;
  log(`=== END — ${passed}/${checks.length} passed, ${failed} failed ===\n`);

  process.exit(failed > 0 ? 1 : 0);
})();
