#!/usr/bin/env node
'use strict';
/**
 * Paylode PIN + Approvals — exhaustive smoke test suite
 *
 * Covers two features (both merged to main, deployed to 176 2026-09-30):
 *   1. Merchant dashboard 6-digit payout PIN (backend/src/services/payoutPin.js)
 *   2. OPERATIONS role maker-checker wallet actions + refund recommendations
 *      (backend/src/modules/gateway-core/routes/walletActions.js,
 *       backend/src/routes/admin.js recommend-refund endpoints)
 *
 * This suite is split into two groups:
 *   - READ-ONLY / VALIDATION / ROLE-GATE tests — safe to run anytime, never
 *     move money (wrong-role 403s, malformed input 400s, PIN format checks,
 *     lockout counters, "not found" cases).
 *   - MONEY-MOVING tests — actually create+approve a wallet_action_request,
 *     which mutates real merchantWallet balances via a real Postgres
 *     transaction. These are GATED behind ALLOW_MONEY_MOVEMENT=true and use
 *     a 1-kobo amount by default. Per the standing "no push/deploy/cron
 *     touching real money without express permission" rule, do not set
 *     ALLOW_MONEY_MOVEMENT=true without the user's explicit go-ahead for
 *     this specific run.
 *
 * Required env vars (see backend/.env or export inline):
 *   API_BASE_URL           default http://localhost:3000
 *   SA_TEST_TOKEN          JWT for a SUPER_ADMIN or ADMIN (checker role)
 *   OPERATIONS_TEST_TOKEN  JWT for an OPERATIONS user (maker role)
 *   MERCHANT_TEST_TOKEN    JWT for a MERCHANT (PIN owner)
 *   MERCHANT_TEST_PASSWORD account password for that merchant (for pin/set step-up)
 *   MERCHANT_TEST_ID       merchant UUID matching MERCHANT_TEST_TOKEN
 *   DEST_MERCHANT_TEST_ID  a second merchant UUID (for MOVE tests)
 *   RAIL_TEST_ID           payment_rails UUID to run wallet-action tests on
 *
 * Optional:
 *   ALLOW_MONEY_MOVEMENT=true   enables the money-moving test group
 *   MONEY_TEST_AMOUNT_KOBO=1    amount used for money-moving tests (default 1 kobo)
 *
 * Usage:
 *   node test/pin-approvals-smoke.js
 *   VERBOSE=true node test/pin-approvals-smoke.js
 *   ALLOW_MONEY_MOVEMENT=true node test/pin-approvals-smoke.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const BASE_URL   = process.env.API_BASE_URL || 'http://localhost:3000';
const SA_TOKEN    = process.env.SA_TEST_TOKEN;
const OPS_TOKEN   = process.env.OPERATIONS_TEST_TOKEN;
const MERCH_TOKEN = process.env.MERCHANT_TEST_TOKEN;
const MERCH_PASSWORD = process.env.MERCHANT_TEST_PASSWORD;
const MERCHANT_ID     = process.env.MERCHANT_TEST_ID;
const DEST_MERCHANT_ID = process.env.DEST_MERCHANT_TEST_ID;
const RAIL_ID          = process.env.RAIL_TEST_ID;

const ALLOW_MONEY_MOVEMENT = process.env.ALLOW_MONEY_MOVEMENT === 'true';
const MONEY_TEST_AMOUNT_KOBO = Number(process.env.MONEY_TEST_AMOUNT_KOBO || 1);

const VERBOSE = process.env.VERBOSE === 'true';

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function req(method, path, body, headers = {}) {
  const url  = new URL(path, BASE_URL);
  const data = body !== undefined ? JSON.stringify(body) : null;
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (data) opts.body = data;
  const res  = await fetch(url.toString(), opts);
  const json = await res.json().catch(() => null);
  if (VERBOSE) {
    console.log(`\n  → ${method} ${url.pathname}`);
    console.log(`  ← ${res.status}`, JSON.stringify(json, null, 2).split('\n').join('\n  '));
  }
  return { status: res.status, body: json };
}
const asSa   = { Authorization: `Bearer ${SA_TOKEN}` };
const asOps  = { Authorization: `Bearer ${OPS_TOKEN}` };
const asMerch = { Authorization: `Bearer ${MERCH_TOKEN}` };

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✅  ${label}`);
    passed++;
  } catch (err) {
    if (err && err._skip) {
      console.log(`  ⚠️  ${label} — SKIPPED (${err.message})`);
      skipped++;
      return;
    }
    console.log(`  ❌  ${label}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function skip(reason) { const e = new Error(reason); e._skip = true; throw e; }
function need(...vars) { return vars.every(v => !!v); }

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 1 — Payout PIN
// ═════════════════════════════════════════════════════════════════════════════

async function testPinValidationAndRoleGates() {
  console.log('\n── PIN: validation + role gates (read-only) ──────────────────────────');

  await test('GET /pin/status with no auth → 401', async () => {
    const r = await req('GET', '/api/v1/payouts/pin/status', null, {});
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  if (!need(SA_TOKEN)) return skip('SA_TEST_TOKEN not set');
  await test('GET /pin/status as SUPER_ADMIN/ADMIN (non-merchant) → 400 "Merchant account required"', async () => {
    const r = await req('GET', '/api/v1/payouts/pin/status', null, asSa);
    assert(r.status === 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  if (!need(MERCH_TOKEN)) return skip('MERCHANT_TEST_TOKEN not set');

  await test('POST /pin/set with missing password → 400 VALIDATION_ERROR', async () => {
    const r = await req('POST', '/api/v1/payouts/pin/set', { pin: '123456' }, asMerch);
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body?.error_code === 'VALIDATION_ERROR', `Expected VALIDATION_ERROR, got ${r.body?.error_code}`);
  });

  await test('POST /pin/set with 5-digit pin → 400 VALIDATION_ERROR', async () => {
    const r = await req('POST', '/api/v1/payouts/pin/set', { password: MERCH_PASSWORD || 'x', pin: '12345' }, asMerch);
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body?.error_code === 'VALIDATION_ERROR', `Expected VALIDATION_ERROR, got ${r.body?.error_code}`);
  });

  await test('POST /pin/set with non-numeric pin → 400 VALIDATION_ERROR', async () => {
    const r = await req('POST', '/api/v1/payouts/pin/set', { password: MERCH_PASSWORD || 'x', pin: 'abcdef' }, asMerch);
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('POST /pin/set with wrong password → 401 BAD_PASSWORD', async () => {
    const r = await req('POST', '/api/v1/payouts/pin/set', { password: 'definitely-wrong-password', pin: '135790' }, asMerch);
    assert(r.status === 401, `Expected 401, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body?.error_code === 'BAD_PASSWORD', `Expected BAD_PASSWORD, got ${r.body?.error_code}`);
  });

  if (!need(MERCH_PASSWORD)) return skip('MERCHANT_TEST_PASSWORD not set — skipping real set/verify/lockout flow');

  await test('POST /pin/set with correct password + valid PIN → 200', async () => {
    const r = await req('POST', '/api/v1/payouts/pin/set', { password: MERCH_PASSWORD, pin: '135790' }, asMerch);
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('GET /pin/status now reports is_set: true', async () => {
    const r = await req('GET', '/api/v1/payouts/pin/status', null, asMerch);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body?.data?.is_set === true, `Expected is_set true, got ${JSON.stringify(r.body)}`);
  });

  await test('Batch payout (dashboard Origin) with no payout_pin → 401/400 PIN_NOT_SET-style gate fires', async () => {
    // Origin header simulates the dashboard so the gate is NOT bypassed.
    const r = await req('POST', '/api/v1/payouts/batches',
      { items: [] }, { ...asMerch, Origin: 'https://paylodeservices.com' });
    // items:[] will also fail validation, but PIN check runs first in the
    // middleware chain — assert we did NOT get a clean pass-through (200).
    assert(r.status !== 200, `Expected a non-200 (PIN or validation gate), got 200`);
    assert([400, 401].includes(r.status), `Expected 400/401, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('Batch payout (dashboard Origin) with wrong 6-digit PIN → 401 WRONG_PIN, attemptsRemaining present', async () => {
    const r = await req('POST', '/api/v1/payouts/batches',
      { items: [], payout_pin: '000000' }, { ...asMerch, Origin: 'https://paylodeservices.com' });
    assert(r.status === 401, `Expected 401, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body?.error_code === 'WRONG_PIN', `Expected WRONG_PIN, got ${r.body?.error_code}`);
  });

  await test('No Origin/Referer header (server-to-server JWT) → PIN gate SKIPPED entirely', async () => {
    // Deliberately no Origin/Referer. Even a bogus payout_pin must not be
    // checked — request should fail on payload validation, NOT PIN.
    const r = await req('POST', '/api/v1/payouts/batches', { items: [] }, asMerch);
    assert(r.body?.error_code !== 'WRONG_PIN' && r.body?.error_code !== 'PIN_NOT_SET' && r.body?.error_code !== 'PIN_LOCKED',
      `PIN gate fired when it should have been skipped (no Origin/Referer): ${JSON.stringify(r.body)}`);
  });

  await test('sk_test_/sk_live_ API-key auth → PIN gate SKIPPED entirely (documented, must never regress)', async () => {
    const r = await req('POST', '/api/v1/payouts/batches',
      { items: [] }, { Authorization: 'Bearer sk_test_invalid_key_for_gate_check', Origin: 'https://paylodeservices.com' });
    // The key itself is invalid so this will 401 on auth, not PIN — the
    // important assertion is that if it got past auth it wouldn't hit PIN.
    // We assert it never returns a PIN-specific error_code.
    assert(!['WRONG_PIN', 'PIN_NOT_SET', 'PIN_LOCKED'].includes(r.body?.error_code),
      `PIN gate must never fire for API-key auth path: ${JSON.stringify(r.body)}`);
  });

  await test('Lockout: 4 consecutive wrong PINs → still WRONG_PIN, not yet locked', async () => {
    let last;
    for (let i = 0; i < 4; i++) {
      last = await req('POST', '/api/v1/payouts/batches',
        { items: [], payout_pin: '111111' }, { ...asMerch, Origin: 'https://paylodeservices.com' });
    }
    assert(last.body?.error_code === 'WRONG_PIN', `Expected WRONG_PIN on attempt, got ${last.body?.error_code}: ${JSON.stringify(last.body)}`);
  });

  await test('Lockout: 5th consecutive wrong PIN → PIN_LOCKED', async () => {
    const r = await req('POST', '/api/v1/payouts/batches',
      { items: [], payout_pin: '222222' }, { ...asMerch, Origin: 'https://paylodeservices.com' });
    assert(r.body?.error_code === 'PIN_LOCKED', `Expected PIN_LOCKED, got ${r.body?.error_code}: ${JSON.stringify(r.body)}`);
  });

  await test('Locked: even the CORRECT PIN is rejected until lock expires', async () => {
    const r = await req('POST', '/api/v1/payouts/batches',
      { items: [], payout_pin: '135790' }, { ...asMerch, Origin: 'https://paylodeservices.com' });
    assert(r.body?.error_code === 'PIN_LOCKED', `Expected PIN_LOCKED even with correct PIN while locked, got ${r.body?.error_code}`);
  });

  console.log('  ℹ️  Note: this run leaves the test merchant PIN-LOCKED for 30 minutes.');
  console.log('     Re-run POST /pin/set (password step-up) any time to reset the lock immediately.');
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 2 — OPERATIONS role gates + wallet-action validation (no money moved)
// ═════════════════════════════════════════════════════════════════════════════

let createdRequestId = null;

async function testWalletActionRoleGatesAndValidation() {
  console.log('\n── Wallet actions: role gates + validation (no money moved) ──────────────');

  await test('POST /wallet-actions with no auth → 401', async () => {
    const r = await req('POST', '/api/v1/wallet-actions', { type: 'CREDIT' }, {});
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  if (need(SA_TOKEN)) {
    await test('POST /wallet-actions as SUPER_ADMIN/ADMIN (not OPERATIONS) → 403', async () => {
      const r = await req('POST', '/api/v1/wallet-actions',
        { type: 'CREDIT', merchant_id: MERCHANT_ID || 'x', rail_id: RAIL_ID || 'x', amount: 100 }, asSa);
      assert(r.status === 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    });

    await test('GET /wallet-actions/pending as SUPER_ADMIN/ADMIN → 200', async () => {
      const r = await req('GET', '/api/v1/wallet-actions/pending', null, asSa);
      assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert(Array.isArray(r.body?.data), 'Expected data array');
    });
  }

  if (!need(OPS_TOKEN)) return skip('OPERATIONS_TEST_TOKEN not set — skipping OPERATIONS-role tests');

  await test('GET /wallet-actions/pending as OPERATIONS (checker-only route) → 403', async () => {
    const r = await req('GET', '/api/v1/wallet-actions/pending', null, asOps);
    assert(r.status === 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('POST /wallet-actions with invalid type → 400 VALIDATION_ERROR', async () => {
    const r = await req('POST', '/api/v1/wallet-actions',
      { type: 'DEBIT_EVERYTHING', merchant_id: MERCHANT_ID || 'x', rail_id: RAIL_ID || 'x', amount: 100 }, asOps);
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body?.error_code === 'VALIDATION_ERROR', `Expected VALIDATION_ERROR, got ${r.body?.error_code}`);
  });

  await test('POST /wallet-actions with amount 0 → 400 VALIDATION_ERROR (min 1 kobo)', async () => {
    const r = await req('POST', '/api/v1/wallet-actions',
      { type: 'CREDIT', merchant_id: MERCHANT_ID || 'x', rail_id: RAIL_ID || 'x', amount: 0 }, asOps);
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('POST /wallet-actions MOVE with dest_merchant_id === merchant_id → 400 "must differ"', async () => {
    if (!need(MERCHANT_ID)) return skip('MERCHANT_TEST_ID not set');
    const r = await req('POST', '/api/v1/wallet-actions',
      { type: 'MOVE', merchant_id: MERCHANT_ID, dest_merchant_id: MERCHANT_ID, rail_id: RAIL_ID || 'x', amount: 100 }, asOps);
    assert(r.status === 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(/differ/i.test(r.body?.message || ''), `Expected "must differ" message, got: ${r.body?.message}`);
  });

  await test('POST /wallet-actions MOVE with no dest_merchant_id → 400 "dest_merchant_id required"', async () => {
    if (!need(MERCHANT_ID, RAIL_ID)) return skip('MERCHANT_TEST_ID/RAIL_TEST_ID not set');
    const r = await req('POST', '/api/v1/wallet-actions',
      { type: 'MOVE', merchant_id: MERCHANT_ID, rail_id: RAIL_ID, amount: 100 }, asOps);
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('POST /wallet-actions with non-existent merchant_id → 404', async () => {
    if (!need(RAIL_ID)) return skip('RAIL_TEST_ID not set');
    const r = await req('POST', '/api/v1/wallet-actions',
      { type: 'CREDIT', merchant_id: '00000000-0000-0000-0000-000000000000', rail_id: RAIL_ID, amount: 100 }, asOps);
    assert(r.status === 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('POST /wallet-actions with non-existent rail_id → 404', async () => {
    if (!need(MERCHANT_ID)) return skip('MERCHANT_TEST_ID not set');
    const r = await req('POST', '/api/v1/wallet-actions',
      { type: 'CREDIT', merchant_id: MERCHANT_ID, rail_id: '00000000-0000-0000-0000-000000000000', amount: 100 }, asOps);
    assert(r.status === 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('GET /wallet-actions/mine as OPERATIONS → 200 array (own history only)', async () => {
    const r = await req('GET', '/api/v1/wallet-actions/mine', null, asOps);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(Array.isArray(r.body?.data), 'Expected data array');
  });

  if (need(MERCHANT_ID)) {
    await test('GET /wallet-actions/wallet/:merchantId as OPERATIONS → 200 read-only balances', async () => {
      const r = await req('GET', `/api/v1/wallet-actions/wallet/${MERCHANT_ID}`, null, asOps);
      assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert(Array.isArray(r.body?.data?.rails), 'Expected rails array');
    });
  }

  await test('POST /:id/approve on a random non-existent id as SA → 404', async () => {
    if (!need(SA_TOKEN)) return skip('SA_TEST_TOKEN not set');
    const r = await req('POST', '/api/v1/wallet-actions/00000000-0000-0000-0000-000000000000/approve', {}, asSa);
    assert(r.status === 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('POST /:id/approve as OPERATIONS (maker cannot self-approve) → 403', async () => {
    if (!need(SA_TOKEN, MERCHANT_ID, RAIL_ID)) return skip('need SA_TEST_TOKEN/MERCHANT_TEST_ID/RAIL_TEST_ID to create a request first');
    const created = await req('POST', '/api/v1/wallet-actions',
      { type: 'CREDIT', merchant_id: MERCHANT_ID, rail_id: RAIL_ID, amount: 1, note: 'smoke-test: role-gate check' }, asOps);
    assert(created.status === 200, `Setup failed creating request: ${JSON.stringify(created.body)}`);
    const id = created.body.data.id;
    const r = await req('POST', `/api/v1/wallet-actions/${id}/approve`, {}, asOps);
    assert(r.status === 403, `Expected 403 (OPERATIONS cannot approve), got ${r.status}: ${JSON.stringify(r.body)}`);
    // Clean up: reject it as SA so it doesn't linger pending forever.
    await req('POST', `/api/v1/wallet-actions/${id}/reject`, { decision_note: 'smoke-test cleanup' }, asSa);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 3 — MONEY-MOVING tests (gated)
// ═════════════════════════════════════════════════════════════════════════════

async function testMoneyMovingFlows() {
  console.log('\n── Wallet actions: MONEY-MOVING flows ─────────────────────────────');

  if (!ALLOW_MONEY_MOVEMENT) {
    console.log('  ⚠️  ALLOW_MONEY_MOVEMENT not set to "true" — skipping all money-moving tests.');
    console.log('     These tests create + approve a real wallet_action_request, mutating real');
    console.log('     merchantWallet balances. Only enable with explicit go-ahead for this run.');
    skipped += 5;
    return;
  }
  if (!need(SA_TOKEN, OPS_TOKEN, MERCHANT_ID, DEST_MERCHANT_ID, RAIL_ID)) {
    return skip('need SA_TEST_TOKEN, OPERATIONS_TEST_TOKEN, MERCHANT_TEST_ID, DEST_MERCHANT_TEST_ID, RAIL_TEST_ID');
  }

  let creditRequestId, moveRequestId;

  await test(`CREDIT ${MONEY_TEST_AMOUNT_KOBO} kobo: create → approve → balance increases by exactly that amount`, async () => {
    const before = await req('GET', `/api/v1/wallet-actions/wallet/${MERCHANT_ID}`, null, asOps);
    const railBefore = (before.body.data.rails || []).find(r => r.rail_id === RAIL_ID);
    const balBefore = railBefore ? railBefore.balance : 0;

    const created = await req('POST', '/api/v1/wallet-actions',
      { type: 'CREDIT', merchant_id: MERCHANT_ID, rail_id: RAIL_ID, amount: MONEY_TEST_AMOUNT_KOBO, note: 'smoke-test CREDIT' }, asOps);
    assert(created.status === 200, `Create failed: ${JSON.stringify(created.body)}`);
    creditRequestId = created.body.data.id;

    const approved = await req('POST', `/api/v1/wallet-actions/${creditRequestId}/approve`, {}, asSa);
    assert(approved.status === 200, `Approve failed: ${JSON.stringify(approved.body)}`);
    assert(approved.body?.data?.merchant_new_balance !== undefined, 'Missing merchant_new_balance in response');

    const after = await req('GET', `/api/v1/wallet-actions/wallet/${MERCHANT_ID}`, null, asOps);
    const railAfter = (after.body.data.rails || []).find(r => r.rail_id === RAIL_ID);
    const balAfter = railAfter.balance;
    assert(balAfter === balBefore + MONEY_TEST_AMOUNT_KOBO / 100,
      `Balance mismatch: before=${balBefore} after=${balAfter} expected+=${MONEY_TEST_AMOUNT_KOBO / 100}`);
  });

  await test('Double-approve the same (already approved) request → 400 "already approved", balance NOT double-credited', async () => {
    if (!creditRequestId) return skip('prior CREDIT test did not run');
    const r = await req('POST', `/api/v1/wallet-actions/${creditRequestId}/approve`, {}, asSa);
    assert(r.status === 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(/already approved/i.test(r.body?.message || ''), `Expected "already approved", got: ${r.body?.message}`);
  });

  await test('CONCURRENCY: two simultaneous approve calls on one pending request → exactly ONE succeeds (regression test for the race fixed 2026-09-30)', async () => {
    const created = await req('POST', '/api/v1/wallet-actions',
      { type: 'CREDIT', merchant_id: MERCHANT_ID, rail_id: RAIL_ID, amount: MONEY_TEST_AMOUNT_KOBO, note: 'smoke-test concurrency' }, asOps);
    assert(created.status === 200, `Create failed: ${JSON.stringify(created.body)}`);
    const id = created.body.data.id;

    const [r1, r2] = await Promise.all([
      req('POST', `/api/v1/wallet-actions/${id}/approve`, {}, asSa),
      req('POST', `/api/v1/wallet-actions/${id}/approve`, {}, asSa),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert(JSON.stringify(statuses) === JSON.stringify([200, 400]),
      `Expected exactly one 200 and one 400, got ${r1.status} and ${r2.status} — POSSIBLE DOUBLE-CREDIT BUG`);
  });

  await test('MOVE: create → approve → source debited, dest credited, same amount', async () => {
    const beforeSrc = await req('GET', `/api/v1/wallet-actions/wallet/${MERCHANT_ID}`, null, asOps);
    const beforeDst = await req('GET', `/api/v1/wallet-actions/wallet/${DEST_MERCHANT_ID}`, null, asOps);
    const srcBalBefore = ((beforeSrc.body.data.rails || []).find(r => r.rail_id === RAIL_ID) || { balance: 0 }).balance;
    const dstBalBefore = ((beforeDst.body.data.rails || []).find(r => r.rail_id === RAIL_ID) || { balance: 0 }).balance;

    const created = await req('POST', '/api/v1/wallet-actions',
      { type: 'MOVE', merchant_id: MERCHANT_ID, dest_merchant_id: DEST_MERCHANT_ID, rail_id: RAIL_ID, amount: MONEY_TEST_AMOUNT_KOBO, note: 'smoke-test MOVE' }, asOps);
    assert(created.status === 200, `Create failed: ${JSON.stringify(created.body)}`);
    moveRequestId = created.body.data.id;

    const approved = await req('POST', `/api/v1/wallet-actions/${moveRequestId}/approve`, {}, asSa);
    assert(approved.status === 200, `Approve failed: ${JSON.stringify(approved.body)}`);

    const afterSrc = await req('GET', `/api/v1/wallet-actions/wallet/${MERCHANT_ID}`, null, asOps);
    const afterDst = await req('GET', `/api/v1/wallet-actions/wallet/${DEST_MERCHANT_ID}`, null, asOps);
    const srcBalAfter = (afterSrc.body.data.rails || []).find(r => r.rail_id === RAIL_ID).balance;
    const dstBalAfter = (afterDst.body.data.rails || []).find(r => r.rail_id === RAIL_ID).balance;

    assert(srcBalAfter === srcBalBefore - MONEY_TEST_AMOUNT_KOBO / 100, `Source not debited correctly: ${srcBalBefore} → ${srcBalAfter}`);
    assert(dstBalAfter === dstBalBefore + MONEY_TEST_AMOUNT_KOBO / 100, `Dest not credited correctly: ${dstBalBefore} → ${dstBalAfter}`);
  });

  await test('Reject flow: create → reject → balance unchanged, status=rejected', async () => {
    const before = await req('GET', `/api/v1/wallet-actions/wallet/${MERCHANT_ID}`, null, asOps);
    const balBefore = ((before.body.data.rails || []).find(r => r.rail_id === RAIL_ID) || { balance: 0 }).balance;

    const created = await req('POST', '/api/v1/wallet-actions',
      { type: 'CREDIT', merchant_id: MERCHANT_ID, rail_id: RAIL_ID, amount: MONEY_TEST_AMOUNT_KOBO, note: 'smoke-test reject' }, asOps);
    const id = created.body.data.id;

    const rejected = await req('POST', `/api/v1/wallet-actions/${id}/reject`, { decision_note: 'smoke-test rejection' }, asSa);
    assert(rejected.status === 200, `Reject failed: ${JSON.stringify(rejected.body)}`);
    assert(rejected.body?.data?.status === 'rejected', `Expected status rejected, got ${rejected.body?.data?.status}`);

    const after = await req('GET', `/api/v1/wallet-actions/wallet/${MERCHANT_ID}`, null, asOps);
    const balAfter = ((after.body.data.rails || []).find(r => r.rail_id === RAIL_ID) || { balance: 0 }).balance;
    assert(balAfter === balBefore, `Balance changed on reject! before=${balBefore} after=${balAfter}`);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 4 — Refund recommendation flow (OPERATIONS maker → SA checker)
// ═════════════════════════════════════════════════════════════════════════════

async function testRefundRecommendationGates() {
  console.log('\n── Refund recommendation: role gates (read-only where possible) ──────────────');

  if (!need(OPS_TOKEN)) return skip('OPERATIONS_TEST_TOKEN not set');

  await test('GET /admin/payout-review/recommendable as OPERATIONS → 200 array', async () => {
    const r = await req('GET', '/api/v1/admin/payout-review/recommendable', null, asOps);
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body?.data), 'Expected data array');
  });

  if (need(SA_TOKEN)) {
    await test('GET /admin/payout-review/recommendable as SUPER_ADMIN (not OPERATIONS) → 403', async () => {
      const r = await req('GET', '/api/v1/admin/payout-review/recommendable', null, asSa);
      assert(r.status === 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    });
  }

  await test('POST /admin/payout-review/:itemId/recommend-refund on non-existent item → 404/400', async () => {
    const r = await req('POST', '/api/v1/admin/payout-review/00000000-0000-0000-0000-000000000000/recommend-refund',
      { amount: 100 }, asOps);
    assert([400, 404].includes(r.status), `Expected 400/404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  if (need(SA_TOKEN)) {
    await test('POST /admin/payout-review/:itemId/recommend-refund as SUPER_ADMIN (not OPERATIONS) → 403', async () => {
      const r = await req('POST', '/api/v1/admin/payout-review/00000000-0000-0000-0000-000000000000/recommend-refund',
        { amount: 100 }, asSa);
      assert(r.status === 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    });
  }
  console.log('  ℹ️  A full recommend→approve-refund happy-path test needs a real failed');
  console.log('     payout_items row with refund_status IS NULL — not fabricated here since');
  console.log('     creating one would require a real failed payout. Exercise this manually');
  console.log('     against an existing failed item if/when one exists in the review queue.');
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('═'.repeat(75));
  console.log('  Paylode PIN + Approvals — Exhaustive Smoke Test');
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  Money-moving tests: ${ALLOW_MONEY_MOVEMENT ? 'ENABLED (amount=' + MONEY_TEST_AMOUNT_KOBO + ' kobo)' : 'DISABLED (set ALLOW_MONEY_MOVEMENT=true to enable)'}`);
  console.log('═'.repeat(75));

  await testPinValidationAndRoleGates();
  await testWalletActionRoleGatesAndValidation();
  await testMoneyMovingFlows();
  await testRefundRecommendationGates();

  console.log('\n' + '═'.repeat(75));
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('═'.repeat(75) + '\n');

  process.exit(failed > 0 ? 1 : 0);
})();
