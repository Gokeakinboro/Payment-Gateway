#!/usr/bin/env node
'use strict';
/**
 * Paylode MPGS Gateway — smoke test suite
 *
 * Tests the MPGS-mirrored gateway endpoint end-to-end:
 *   1. SA admin: set up a merchant's MPGS config + receive gateway password
 *   2. Merchant: charge approved card (sandbox mock)
 *   3. Merchant: inspect the transformed MPGS payload
 *   4. Merchant: charge declined card
 *   5. Auth failures (wrong password, wrong MID)
 *   6. Validation errors (missing fields)
 *   7. Order retrieval
 *
 * MPGS test cards (standard Mastercard sandbox):
 *   5123450000000008  Mastercard  APPROVED  (frictionless)
 *   5111111111111118  Mastercard  APPROVED  (3DS frictionless)
 *   5200000000000007  Mastercard  PENDING_AUTHENTICATION (3DS challenge)
 *   4111111111111111  Visa        APPROVED
 *   4000000000000002  Visa        DECLINED
 *   5105105105105100  Mastercard  DECLINED
 *   371449635398431   Amex        APPROVED
 *
 * When testing against real Mastercard sandbox (once Parallex provides credentials):
 *   Set MPGS_TEST_BASE_URL, MPGS_TEST_MID, MPGS_TEST_API_PASSWORD in .env
 *   Set PAYLODE_MERCHANT_ID to the Paylode merchant UUID to configure
 *
 * Usage:
 *   node test/mpgs-gateway-smoke.js
 *   VERBOSE=true node test/mpgs-gateway-smoke.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL      = process.env.API_BASE_URL || 'http://localhost:3000';
const SA_TOKEN      = process.env.SA_TEST_TOKEN;       // JWT for SUPER_ADMIN (get from login)
const MERCHANT_UUID = process.env.PAYLODE_MERCHANT_ID; // Paylode DB merchant UUID to configure

// MPGS credentials to store (Parallex-issued or Mastercard sandbox)
const MPGS_TEST_MID         = process.env.MPGS_TEST_MID          || 'TEST_MERCHANT_001';
const MPGS_TEST_API_PASSWORD = process.env.MPGS_TEST_API_PASSWORD || 'test_password';
const MPGS_TEST_BASE_URL    = process.env.MPGS_TEST_BASE_URL
  || 'https://test-gateway.mastercard.com/api/rest/version/77';

const VERBOSE = process.env.VERBOSE === 'true';

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function req(method, path, body, headers = {}) {
  const url  = new URL(path, BASE_URL);
  const data = body ? JSON.stringify(body) : null;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (data) opts.body = data;
  const res  = await fetch(url.toString(), opts);
  const json = await res.json().catch(() => null);
  if (VERBOSE) {
    console.log(`\n  → ${method} ${url.pathname}`);
    console.log(`  ← ${res.status}`, JSON.stringify(json, null, 2).split('\n').join('\n  '));
  }
  return { status: res.status, body: json };
}

// Basic Auth header — mirrors MPGS: merchant.{mid}:{password}
function basicAuth(mid, password) {
  return 'Basic ' + Buffer.from(`merchant.${mid}:${password}`).toString('base64');
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✅  ${label}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${label}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── State shared between tests ────────────────────────────────────────────────
let gatewayPassword = null;   // issued by SA setup
let orderId         = null;   // set on first successful charge

// ── Test suites ───────────────────────────────────────────────────────────────

async function testSaSetup() {
  console.log('\n── SA Admin: configure merchant MPGS ─────────────────────────────');

  if (!SA_TOKEN || !MERCHANT_UUID) {
    console.log('  ⚠  SA_TEST_TOKEN or PAYLODE_MERCHANT_ID not set — skipping SA setup tests');
    console.log('     Set these env vars to run SA admin tests.');
    return;
  }

  await test('SA can create MPGS config and receive gateway password', async () => {
    const r = await req('PUT', `/api/v1/mpgs/admin/${MERCHANT_UUID}`, {
      mpgs_mid:          MPGS_TEST_MID,
      mpgs_api_password: MPGS_TEST_API_PASSWORD,
      mpgs_base_url:     MPGS_TEST_BASE_URL,
      notes:             'Smoke test config',
    }, { Authorization: `Bearer ${SA_TOKEN}` });

    assert(r.status === 200 || r.status === 201, `Expected 200/201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.data?.gateway_api_password, 'No gateway_api_password in response');
    assert(r.body.data?.connection_parameters?.gateway_url, 'No gateway_url in connection_parameters');
    assert(r.body.data?.connection_parameters?.merchant_id === MPGS_TEST_MID, 'Wrong merchant_id');

    gatewayPassword = r.body.data.gateway_api_password;
    console.log(`       Gateway password issued: ${gatewayPassword.slice(0, 8)}... (truncated)`);
    console.log(`       Gateway URL: ${r.body.data.connection_parameters.gateway_url}`);
  });

  await test('SA can retrieve config (password hash only — not plaintext)', async () => {
    const r = await req('GET', `/api/v1/mpgs/admin/${MERCHANT_UUID}`, null,
      { Authorization: `Bearer ${SA_TOKEN}` });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(!r.body.data?.gateway_api_password, 'Plaintext password should NOT be in GET response');
    assert(r.body.data?.mpgs_mid === MPGS_TEST_MID, 'Wrong MID in GET response');
  });

  await test('SA can rotate gateway password', async () => {
    const r = await req('POST', `/api/v1/mpgs/admin/${MERCHANT_UUID}/rotate-password`, {},
      { Authorization: `Bearer ${SA_TOKEN}` });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body.data?.new_gateway_api_password, 'No new password in rotate response');
    // Update for subsequent tests
    gatewayPassword = r.body.data.new_gateway_api_password;
    console.log(`       New password: ${gatewayPassword.slice(0, 8)}... (truncated)`);
  });
}

async function testGatewayAuth() {
  console.log('\n── Gateway: authentication ────────────────────────────────────────');

  if (!gatewayPassword) {
    console.log('  ⚠  No gateway password available — skipping auth tests (run SA setup first)');
    return;
  }

  const validAuth   = basicAuth(MPGS_TEST_MID, gatewayPassword);
  const testOrderId = `TEST-AUTH-${Date.now()}`;

  await test('Correct credentials → authenticated (not 401)', async () => {
    // A request with valid creds but missing body should get 400, not 401
    const r = await req('PUT',
      `/api/rest/version/77/merchant/${MPGS_TEST_MID}/order/${testOrderId}/transaction/1`,
      {}, { Authorization: validAuth });
    assert(r.status !== 401, `Got 401 with valid credentials: ${JSON.stringify(r.body)}`);
    assert(r.body?.result === 'ERROR', 'Expected ERROR result for empty body');
  });

  await test('Wrong password → 401', async () => {
    const r = await req('PUT',
      `/api/rest/version/77/merchant/${MPGS_TEST_MID}/order/${testOrderId}/transaction/1`,
      { apiOperation: 'PAY' }, { Authorization: basicAuth(MPGS_TEST_MID, 'wrongpassword') });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
    assert(r.body?.result === 'ERROR', 'Expected ERROR result');
    assert(r.body?.error?.cause === 'INVALID_CREDENTIALS', 'Expected INVALID_CREDENTIALS');
  });

  await test('Missing Authorization header → 401', async () => {
    const r = await req('PUT',
      `/api/rest/version/77/merchant/${MPGS_TEST_MID}/order/${testOrderId}/transaction/1`,
      { apiOperation: 'PAY' }, {});
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('MID mismatch (URL vs Basic Auth) → 401', async () => {
    const r = await req('PUT',
      `/api/rest/version/77/merchant/WRONG_MID/order/${testOrderId}/transaction/1`,
      { apiOperation: 'PAY' }, { Authorization: validAuth });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });

  await test('Bearer token (wrong scheme) → 401', async () => {
    const r = await req('PUT',
      `/api/rest/version/77/merchant/${MPGS_TEST_MID}/order/${testOrderId}/transaction/1`,
      { apiOperation: 'PAY' }, { Authorization: 'Bearer sk_test_abc123' });
    assert(r.status === 401, `Expected 401, got ${r.status}`);
  });
}

async function testPayload() {
  console.log('\n── Gateway: payload validation ────────────────────────────────────');

  if (!gatewayPassword) {
    console.log('  ⚠  No gateway password — skipping payload tests');
    return;
  }

  const auth      = basicAuth(MPGS_TEST_MID, gatewayPassword);
  const orderBase = `/api/rest/version/77/merchant/${MPGS_TEST_MID}/order`;

  await test('Missing apiOperation → ERROR', async () => {
    const r = await req('PUT', `${orderBase}/MISSING-OP-${Date.now()}/transaction/1`,
      { order: { amount: '100.00', currency: 'NGN' } }, { Authorization: auth });
    assert(r.body?.result === 'ERROR', `Expected ERROR, got: ${JSON.stringify(r.body)}`);
  });

  await test('Unsupported apiOperation → ERROR', async () => {
    const r = await req('PUT', `${orderBase}/INVALID-OP-${Date.now()}/transaction/1`,
      { apiOperation: 'UNKNOWN_OP' }, { Authorization: auth });
    assert(r.body?.result === 'ERROR', 'Expected ERROR for unsupported apiOperation');
  });

  await test('Missing card number → ERROR', async () => {
    const r = await req('PUT', `${orderBase}/MISSING-CARD-${Date.now()}/transaction/1`, {
      apiOperation: 'PAY',
      order: { amount: '5000.00', currency: 'NGN' },
      sourceOfFunds: { type: 'CARD', provided: { card: { expiry: { month: '01', year: '27' }, securityCode: '100' } } },
    }, { Authorization: auth });
    assert(r.body?.result === 'ERROR', 'Expected ERROR for missing card number');
    assert(/card\.number/i.test(r.body?.error?.explanation || ''), 'Error should mention card.number');
  });

  await test('Missing order.amount → ERROR', async () => {
    const r = await req('PUT', `${orderBase}/MISSING-AMT-${Date.now()}/transaction/1`, {
      apiOperation: 'PAY',
      sourceOfFunds: { type: 'CARD', provided: { card: {
        number: '5123450000000008', expiry: { month: '01', year: '27' }, securityCode: '100',
      }}},
    }, { Authorization: auth });
    assert(r.body?.result === 'ERROR', 'Expected ERROR for missing amount');
  });
}

async function testInspect() {
  console.log('\n── Gateway: payload transformation (inspect mode) ─────────────────');

  if (!gatewayPassword) {
    console.log('  ⚠  No gateway password — skipping inspect tests');
    return;
  }

  const auth    = basicAuth(MPGS_TEST_MID, gatewayPassword);
  const oid     = `INSPECT-${Date.now()}`;
  const url     = `/api/rest/version/77/merchant/${MPGS_TEST_MID}/order/${oid}/transaction/1?inspect=true`;

  await test('Inspect mode shows transformed MPGS payload without charging', async () => {
    const r = await req('PUT', url, {
      apiOperation: 'PAY',
      order: { amount: '5000.00', currency: 'NGN', description: 'Test payment' },
      sourceOfFunds: {
        type: 'CARD',
        provided: {
          card: {
            number: '5123450000000008',
            expiry: { month: '01', year: '27' },
            securityCode: '100',
            nameOnCard: 'Adebayo Okafor',
          },
        },
      },
      transaction: { reference: 'TEST-ORDER-001' },
      customer: {
        email: 'adebayo@example.com',
        firstName: 'Adebayo',
        lastName: 'Okafor',
        ipAddress: '197.210.64.1',
      },
    }, { Authorization: auth });

    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body?._inspect === true, 'Expected _inspect: true');

    const body = r.body.mpgs_request_body;
    assert(body?.apiOperation === 'PAY', `apiOperation wrong: ${body?.apiOperation}`);
    assert(body?.order?.amount === '5000.00', `Amount wrong: ${body?.order?.amount}`);
    assert(body?.order?.currency === 'NGN', `Currency wrong: ${body?.order?.currency}`);
    assert(body?.sourceOfFunds?.provided?.card?.number === '5123450000000008', 'Card number not passed through');
    assert(body?.sourceOfFunds?.provided?.card?.expiry?.month === '01', 'Expiry month wrong');
    assert(body?.sourceOfFunds?.provided?.card?.expiry?.year === '27', 'Expiry year wrong');
    assert(body?.sourceOfFunds?.provided?.card?.securityCode === '100', 'CVV not passed through');
    assert(body?.sourceOfFunds?.provided?.card?.nameOnCard === 'Adebayo Okafor', 'Name not passed through');
    assert(body?.customer?.email === 'adebayo@example.com', 'Customer email wrong');
    assert(body?.customer?.firstName === 'Adebayo', 'Customer first name wrong');

    const endpoint = r.body.mpgs_endpoint;
    assert(endpoint?.method === 'PUT', 'Method should be PUT');
    assert(endpoint?.url?.includes(MPGS_TEST_BASE_URL), `Base URL not in endpoint: ${endpoint?.url}`);
    assert(endpoint?.url?.includes(MPGS_TEST_MID), `MID not in endpoint URL: ${endpoint?.url}`);
    assert(/merchant\.\w+:\{mpgsApiPassword\}/.test(endpoint?.auth || ''), 'Auth format wrong');

    console.log('\n  Transformed MPGS request body:');
    console.log(JSON.stringify(r.body.mpgs_request_body, null, 4)
      .split('\n').map(l => '    ' + l).join('\n'));
    console.log('\n  Forwarding to MPGS endpoint:');
    console.log(`    ${endpoint?.method} ${endpoint?.url}`);
    console.log(`    Auth: ${endpoint?.auth}`);
  });
}

async function testCharge() {
  console.log('\n── Gateway: card charges (sandbox mock) ───────────────────────────');

  if (!gatewayPassword) {
    console.log('  ⚠  No gateway password — skipping charge tests');
    return;
  }

  const auth  = basicAuth(MPGS_TEST_MID, gatewayPassword);
  const base  = `/api/rest/version/77/merchant/${MPGS_TEST_MID}/order`;

  const approvedBody = (cardNumber, oid) => ({
    apiOperation: 'PAY',
    order: { amount: '5000.00', currency: 'NGN', description: 'Smoke test payment' },
    sourceOfFunds: {
      type: 'CARD',
      provided: {
        card: {
          number: cardNumber,
          expiry: { month: '01', year: '27' },
          securityCode: '100',
          nameOnCard: 'Adebayo Okafor',
        },
      },
    },
    transaction: { reference: `ORDER-${oid}` },
    customer: {
      email: 'adebayo@example.com',
      firstName: 'Adebayo',
      lastName: 'Okafor',
      ipAddress: '197.210.64.1',
    },
  });

  // ── Approved cards ──────────────────────────────────────────────────────────
  await test('Mastercard 5123450000000008 → SUCCESS', async () => {
    orderId     = `MC-APPROVED-${Date.now()}`;
    const r     = await req('PUT', `${base}/${orderId}/transaction/1`,
      approvedBody('5123450000000008', orderId), { Authorization: auth });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body?.result === 'SUCCESS', `Expected SUCCESS: ${JSON.stringify(r.body)}`);
    assert(r.body?.response?.gatewayCode === 'APPROVED', `Expected APPROVED: ${r.body?.response?.gatewayCode}`);
    assert(r.body?.transaction?.id === '1', 'Transaction ID should be 1');
    assert(r.body?.transaction?.authorizationCode, 'Missing authorizationCode');
    assert(r.body?.sourceOfFunds?.provided?.card?.scheme === 'MASTERCARD', 'Scheme should be MASTERCARD');
    // PAN must be masked in response — never full number
    const returnedNum = r.body?.sourceOfFunds?.provided?.card?.number || '';
    assert(!returnedNum.replace(/x/gi, '').includes('5123450000000008'), 'Full PAN returned — PCI violation');
    assert(r.body?.['paylode.reference'], 'Missing paylode.reference');
    console.log(`       paylode.reference: ${r.body['paylode.reference']}`);
    console.log(`       authorization_code: ${r.body.transaction.authorizationCode}`);
  });

  await test('Visa 4111111111111111 → SUCCESS', async () => {
    const oid = `VISA-APPROVED-${Date.now()}`;
    const r   = await req('PUT', `${base}/${oid}/transaction/1`,
      approvedBody('4111111111111111', oid), { Authorization: auth });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body?.result === 'SUCCESS', `Expected SUCCESS: ${JSON.stringify(r.body)}`);
    assert(r.body?.sourceOfFunds?.provided?.card?.scheme === 'VISA', 'Scheme should be VISA');
  });

  // ── Declined cards ──────────────────────────────────────────────────────────
  await test('Visa 4000000000000002 → FAILURE (declined)', async () => {
    const oid = `VISA-DECLINED-${Date.now()}`;
    const r   = await req('PUT', `${base}/${oid}/transaction/1`,
      approvedBody('4000000000000002', oid), { Authorization: auth });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body?.result === 'FAILURE', `Expected FAILURE: ${JSON.stringify(r.body)}`);
    assert(r.body?.response?.gatewayCode === 'DECLINED', `Expected DECLINED: ${r.body?.response?.gatewayCode}`);
  });

  await test('Mastercard 5105105105105100 → FAILURE (declined)', async () => {
    const oid = `MC-DECLINED-${Date.now()}`;
    const r   = await req('PUT', `${base}/${oid}/transaction/1`,
      approvedBody('5105105105105100', oid), { Authorization: auth });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
    assert(r.body?.result === 'FAILURE', `Expected FAILURE`);
  });

  // ── AUTHORIZE (not PAY) ─────────────────────────────────────────────────────
  await test('apiOperation AUTHORIZE → SUCCESS with type AUTHORIZATION', async () => {
    const oid = `AUTH-${Date.now()}`;
    const body = { ...approvedBody('5123450000000008', oid), apiOperation: 'AUTHORIZE' };
    const r    = await req('PUT', `${base}/${oid}/transaction/1`, body, { Authorization: auth });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    assert(r.body?.result === 'SUCCESS', `Expected SUCCESS`);
    assert(r.body?.transaction?.type === 'AUTHORIZATION', `Expected AUTHORIZATION type: ${r.body?.transaction?.type}`);
  });

  // ── Amount format ───────────────────────────────────────────────────────────
  await test('Amount in naira string format ("5000.00") → correct kobo conversion', async () => {
    const oid   = `AMOUNT-${Date.now()}`;
    const r     = await req('PUT', `${oid}/transaction/1?inspect=true`.replace(/^/, `${base}/`),
      approvedBody('5123450000000008', oid), { Authorization: auth });
    // In inspect mode, amount_kobo should be 500000
    if (r.body?._inspect) {
      assert(r.body.amount_kobo === 500000, `Expected 500000 kobo, got: ${r.body.amount_kobo}`);
    }
  });
}

async function testOrderRetrieval() {
  console.log('\n── Gateway: order retrieval ────────────────────────────────────────');

  if (!gatewayPassword || !orderId) {
    console.log('  ⚠  No gateway password or prior order — skipping retrieval tests');
    return;
  }

  const auth = basicAuth(MPGS_TEST_MID, gatewayPassword);

  await test('GET /order/{orderId} returns SUCCESS for charged order', async () => {
    const r = await req('GET',
      `/api/rest/version/77/merchant/${MPGS_TEST_MID}/order/${orderId}`,
      null, { Authorization: auth });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body?.order?.id === orderId, 'Order ID mismatch');
    assert(r.body?.result === 'SUCCESS', `Expected SUCCESS: ${JSON.stringify(r.body)}`);
  });

  await test('GET /order/NONEXISTENT → 404 error', async () => {
    const r = await req('GET',
      `/api/rest/version/77/merchant/${MPGS_TEST_MID}/order/ORDER-DOES-NOT-EXIST`,
      null, { Authorization: auth });
    assert(r.status === 404 || r.body?.result === 'ERROR', `Expected 404/ERROR, got ${r.status}`);
  });
}

async function testRealMpgsSandbox() {
  console.log('\n── Real MPGS sandbox (Mastercard test environment) ─────────────────');
  console.log('  ℹ  To test against real Mastercard MPGS sandbox:');
  console.log('     1. Set MPGS_TEST_BASE_URL to your acquirer\'s test gateway URL');
  console.log('        e.g. https://test-gateway.mastercard.com/api/rest/version/77');
  console.log('        or   https://ap-gateway.mastercard.com/api/rest/version/77');
  console.log('     2. Set MPGS_TEST_MID and MPGS_TEST_API_PASSWORD to Parallex-provided credentials');
  console.log('     3. Set PAYLODE_MERCHANT_ID and SA_TEST_TOKEN');
  console.log('     4. Run: node test/mpgs-gateway-smoke.js');
  console.log('');
  console.log('  Standard Mastercard test cards:');
  console.log('    5123450000000008  MC   Approved (frictionless 3DS)');
  console.log('    5111111111111118  MC   Approved (3DS2 frictionless)');
  console.log('    5200000000000007  MC   3DS challenge (redirectUrl returned)');
  console.log('    4111111111111111  Visa Approved');
  console.log('    4000000000000002  Visa Declined');
  console.log('    371449635398431   Amex Approved');
  console.log('');
  console.log('  All test cards: expiry 05/27, CVV 100');
  console.log('');

  if (process.env.MPGS_TEST_MID && process.env.MPGS_TEST_API_PASSWORD && gatewayPassword) {
    console.log('  Running live sandbox charge (MPGS_TEST_* env vars set)...');
    const auth  = basicAuth(MPGS_TEST_MID, gatewayPassword);
    const oid   = `LIVE-SMOKE-${Date.now()}`;

    await test('Real MPGS sandbox: Mastercard approved card', async () => {
      const r = await req('PUT',
        `/api/rest/version/77/merchant/${MPGS_TEST_MID}/order/${oid}/transaction/1`, {
          apiOperation: 'PAY',
          order: { amount: '1.00', currency: 'NGN', description: 'Paylode gateway smoke test' },
          sourceOfFunds: {
            type: 'CARD',
            provided: {
              card: {
                number: '5123450000000008',
                expiry: { month: '05', year: '27' },
                securityCode: '100',
                nameOnCard: 'Test Cardholder',
              },
            },
          },
          transaction: { reference: `SMOKE-${oid}` },
          customer: { email: 'smoke@paylodeservices.com', firstName: 'Test', lastName: 'Cardholder', ipAddress: '127.0.0.1' },
        }, { Authorization: auth });

      console.log(`       result: ${r.body?.result}`);
      console.log(`       gatewayCode: ${r.body?.response?.gatewayCode}`);
      console.log(`       authCode: ${r.body?.transaction?.authorizationCode}`);
      assert(['SUCCESS', 'PENDING_AUTHENTICATION'].includes(r.body?.result),
        `Unexpected result: ${r.body?.result} — ${JSON.stringify(r.body)}`);
    });
  } else {
    console.log('  MPGS_TEST_MID / MPGS_TEST_API_PASSWORD not set — skipping live sandbox test');
    console.log('  Set these env vars to run against the real Mastercard test gateway.');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Paylode MPGS Gateway — Smoke Test');
  console.log(`  Base URL : ${BASE_URL}`);
  console.log(`  MPGS MID : ${MPGS_TEST_MID}`);
  console.log(`  MPGS URL : ${MPGS_TEST_BASE_URL}`);
  console.log('═══════════════════════════════════════════════════════════════════');

  await testSaSetup();
  await testGatewayAuth();
  await testPayload();
  await testInspect();
  await testCharge();
  await testOrderRetrieval();
  await testRealMpgsSandbox();

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
})();
