'use strict';
// Parallex NIP connectivity check — hourly, 24 runs from 7am WAT.
// Step 1: name enquiry (free, no money movement).
// Step 2: only if NE succeeds, real N10 InterbankTransfer to OPay + GTBank in parallel.
//         NE alone is insufficient — NE passes while InterbankTransfer can still fail.
//
// Cron (server 176):
//   0 * * * * cd /opt/paylode-api/backend && node test/parallex-nip-check.js >> /var/log/parallex-nip-check.log 2>&1

const MAX_RUNS        = 24;
const AMOUNT_KOBO     = 1000;  // N10 per probe
const START_AFTER_UTC = '2026-08-27T06:00:00.000Z'; // 7am WAT = 6am UTC

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs       = require('fs');
const transfer = require('../src/modules/gateway-core/services/parallexTransferService');

const STATE = '/var/log/parallex-nip-check-state.json';

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function readState()  { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return { run: 0 }; } }
function writeState(s){ try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch (_) {} }

(async () => {
  if (Date.now() < Date.parse(START_AFTER_UTC)) {
    log(`Before monitoring window (opens ${START_AFTER_UTC}) — skipping`);
    process.exit(0);
  }

  const state  = readState();
  const runIdx = state.run;

  if (runIdx >= MAX_RUNS) {
    log(`NIP monitoring complete — all ${MAX_RUNS} runs done. Remove cron entry.`);
    process.exit(0);
  }

  log(`=== Parallex NIP check ${runIdx + 1}/${MAX_RUNS} ===`);

  // ── 1. Name enquiry (no money) ─────────────────────────────────────────────
  let ne;
  const t0 = Date.now();
  try {
    ne = await transfer.nameEnquiry('100004', '7030000266');
    log(`  NE: ok=${ne.ok} name="${ne.accountName || ''}" sessionId=${ne.sessionId ? 'YES' : 'NO'} ${Date.now() - t0}ms`);
  } catch (e) {
    log(`  NE ERROR: ${e.message}`);
    writeState({ run: runIdx + 1, lastCheck: new Date().toISOString(), result: 'NE_ERROR' });
    process.exit(0);
  }

  if (!ne.ok || !ne.sessionId) {
    log('  NE failed — no transfer attempted');
    writeState({ run: runIdx + 1, lastCheck: new Date().toISOString(), result: 'NE_FAIL' });
    process.exit(0);
  }

  // ── 2. Real InterbankTransfer — OPay + GTBank in parallel ──────────────────
  const refOpay = `NIP-CHK-R${runIdx}-OPAY-${Date.now()}`;
  const refGT   = `NIP-CHK-R${runIdx}-GT-${Date.now()}`;
  log(`  NE passed. Sending N${AMOUNT_KOBO / 100} to OPay 7030000266 + GTBank 0005061067 in parallel ...`);

  async function probe(label, bankCode, account, ref) {
    const t1 = Date.now();
    try {
      const r = await transfer.sendPayout({
        orderId: ref, amount: AMOUNT_KOBO,
        bank_code: bankCode, account_number: account,
        account_name: '', narration: 'Paylode NIP connectivity check',
      });
      log(`  ${label}: code=${r.code} ${Date.now() - t1}ms  ${r.reason || ''}`);
      return r;
    } catch (e) {
      log(`  ${label} ERROR: ${e.message} ${Date.now() - t1}ms`);
      return { ok: false, code: 'ERR', reason: e.message };
    }
  }

  const [rOpay, rGT] = await Promise.all([
    probe('OPay(7030000266)',   '305', '7030000266', refOpay),
    probe('GTBank(0005061067)', '058', '0005061067', refGT),
  ]);

  const anyOk = rOpay.code === '00' || rGT.code === '00';
  if (anyOk) {
    const ok = [rOpay.code === '00' && 'OPay', rGT.code === '00' && 'GTBank'].filter(Boolean).join('+');
    log(`  ✅ NIP OK — ${ok} successful`);
  } else {
    log(`  ❌ NIP FAIL — OPay:${rOpay.code} GTBank:${rGT.code}`);
  }

  writeState({ run: runIdx + 1, lastCheck: new Date().toISOString(), opay: rOpay.code, gt: rGT.code });
  process.exit(0);
})();
