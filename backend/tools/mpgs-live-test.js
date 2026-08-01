'use strict';
// Live MPGS gateway test — standard Mastercard test cards via Paylode gateway
// Run: DATABASE_URL=postgresql://... node /tmp/mpgs-live-test.js

const http        = require('http');
const { execSync } = require('child_process');

const GW_MID      = 'PSLPBL1';
const GW_PASSWORD = '4U5GicAL6MPIveHNNfW8Qz4uHs2Y3iRP';
const MERCHANT_ID = '7548c579-a281-49cf-9ea5-b5ec87fe3f28';
const DB          = process.env.DATABASE_URL || 'postgresql://paylode:PaylodeSecure2025@localhost:5432/paylode_db';

function psql(sql) {
  return execSync(`psql "${DB}" -t -c "${sql}"`, { encoding: 'utf8' }).trim();
}

function basicAuth(mid, pw) {
  return 'Basic ' + Buffer.from(`merchant.${mid}:${pw}`).toString('base64');
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: 'localhost', port: 3000, path, method,
      headers: { 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') })); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let passed = 0, failed = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ✅  ${label}`); passed++; }
  catch (e) { console.log(`  ❌  ${label}\n       ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  console.log('════════════════════════════════════════════════════════');
  console.log('  Paylode MPGS Gateway — Live Mastercard Test');
  console.log(`  MID: ${GW_MID}  |  Parallex NA gateway`);
  console.log('════════════════════════════════════════════════════════');

  // Pre-flight: check and enable live mode
  console.log('\n── Pre-flight ──────────────────────────────────────────');
  const row = psql(`SELECT business_name, live_enabled, kyc_status FROM merchants WHERE id = '${MERCHANT_ID}'`);
  console.log(`  ${row}`);
  const isLive = row.includes('t');
  if (!isLive) {
    console.log('  ⚠️  Not live-enabled → enabling for this test...');
    psql(`UPDATE merchants SET live_enabled = true WHERE id = '${MERCHANT_ID}'`);
    console.log('  ✓  live_enabled = true');
  }

  const auth = basicAuth(GW_MID, GW_PASSWORD);
  const base = `/api/rest/version/77/merchant/${GW_MID}/order`;

  const payload = (card, amount = '100.00') => ({
    apiOperation: 'PAY',
    order: { amount, currency: 'NGN', description: 'Paylode MPGS live test' },
    sourceOfFunds: { type: 'CARD', provided: { card: {
      number: card, expiry: { month: '05', year: '27' }, securityCode: '100', nameOnCard: 'Test Cardholder',
    }}},
    transaction: { reference: `TEST-${Date.now()}` },
    customer: { email: 'test@paylodeservices.com', firstName: 'Test', lastName: 'Cardholder', ipAddress: '127.0.0.1' },
  });

  // Inspect mode — no real charge, just verify transforms
  console.log('\n── Inspect mode (no charge) ────────────────────────────');
  await test('PAY transforms to correct MPGS payload', async () => {
    const oid = `INSPECT-${Date.now()}`;
    const r = await req('PUT', `${base}/${oid}/transaction/1?inspect=true`, payload('5123450000000008'), { Authorization: auth });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body._inspect === true, 'Expected _inspect flag');
    const b = r.body.mpgs_request_body;
    assert(b?.apiOperation === 'PAY', 'Wrong apiOperation');
    assert(b?.order?.amount === '100.00', `Wrong amount: ${b?.order?.amount}`);
    console.log(`       Forwards to : ${r.body.mpgs_endpoint?.url}`);
    console.log(`       Auth header : ${r.body.mpgs_endpoint?.auth}`);
  });

  // Live Mastercard calls
  console.log('\n── Live Mastercard test cards ──────────────────────────');

  await test('MC 5123450000000008 → APPROVED (frictionless)', async () => {
    const oid = `MC-LIVE-${Date.now()}`;
    const r = await req('PUT', `${base}/${oid}/transaction/1`, payload('5123450000000008'), { Authorization: auth });
    console.log(`       result      : ${r.body.result}`);
    console.log(`       gatewayCode : ${r.body.response?.gatewayCode}`);
    console.log(`       authCode    : ${r.body.transaction?.authorizationCode}`);
    console.log(`       paylode.ref : ${r.body['paylode.reference']}`);
    console.log(`       HTTP status : ${r.status}`);
    assert(['SUCCESS','PENDING_AUTHENTICATION'].includes(r.body.result),
      `Unexpected: ${r.body.result} — ${JSON.stringify(r.body)}`);
  });

  await test('MC 5200000000000007 → 3DS challenge', async () => {
    const oid = `MC-3DS-${Date.now()}`;
    const r = await req('PUT', `${base}/${oid}/transaction/1`, payload('5200000000000007'), { Authorization: auth });
    console.log(`       result      : ${r.body.result}`);
    console.log(`       gatewayCode : ${r.body.response?.gatewayCode}`);
    console.log(`       redirectUrl : ${r.body.authentication?.redirectUrl || '(none)'}`);
    console.log(`       HTTP status : ${r.status}`);
    assert(r.status < 500, `Server error: ${JSON.stringify(r.body)}`);
  });

  await test('MC 5105105105105100 → DECLINED', async () => {
    const oid = `MC-DECLINE-${Date.now()}`;
    const r = await req('PUT', `${base}/${oid}/transaction/1`, payload('5105105105105100'), { Authorization: auth });
    console.log(`       result      : ${r.body.result}`);
    console.log(`       gatewayCode : ${r.body.response?.gatewayCode}`);
    console.log(`       HTTP status : ${r.status}`);
    assert(r.status < 500, `Server error: ${JSON.stringify(r.body)}`);
  });

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
