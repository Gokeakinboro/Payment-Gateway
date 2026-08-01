'use strict';
// Full end-to-end test through Paylode MPGS gateway in sandbox mode
// Run: node /tmp/mpgs-sandbox-test.js && rm /tmp/mpgs-sandbox-test.js
const http = require('http');
const { execSync } = require('child_process');

const DB            = 'postgresql://paylode:PaylodeSecure2025@localhost:5432/paylode_db';
const GW_MID        = 'PSLPBL1';
const GW_PASSWORD   = '4U5GicAL6MPIveHNNfW8Qz4uHs2Y3iRP'; // Paylode-issued gateway pw
const MERCHANT_UUID = '7548c579-a281-49cf-9ea5-b5ec87fe3f28';

// Set live_enabled = false → sandbox mode
execSync(`psql "${DB}" -c "UPDATE merchants SET live_enabled = false WHERE id = '${MERCHANT_UUID}'"`, { encoding: 'utf8' });
console.log('✓ Drinks Arena set to sandbox mode\n');

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const auth = 'Basic ' + Buffer.from(`merchant.${GW_MID}:${GW_PASSWORD}`).toString('base64');
    const r = http.request({
      hostname: 'localhost', port: 3000, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: auth },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') })); });
    r.on('error', reject);
    r.write(data); r.end();
  });
}

const base = `/api/rest/version/77/merchant/${GW_MID}/order`;

const payload = (card, amount = '5000.00') => ({
  apiOperation: 'PAY',
  order: { amount, currency: 'NGN', description: 'Paylode sandbox test' },
  sourceOfFunds: { type: 'CARD', provided: { card: {
    number: card, expiry: { month: '05', year: '27' }, securityCode: '100', nameOnCard: 'Test Cardholder',
  }}},
  transaction: { reference: `SANDBOX-${Date.now()}` },
  customer: { email: 'test@paylodeservices.com', firstName: 'Test', lastName: 'Cardholder', ipAddress: '127.0.0.1' },
});

let passed = 0, failed = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ✅  ${label}`); passed++; }
  catch (e) { console.log(`  ❌  ${label}\n       ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

(async () => {
  console.log('── Paylode MPGS Gateway — Sandbox Test ──────────────────\n');

  await test('Auth check — correct credentials pass', async () => {
    const oid = `AUTH-${Date.now()}`;
    const r = await req('PUT', `${base}/${oid}/transaction/1`, {});
    assert(r.status !== 401, `Got 401 — auth rejected`);
  });

  await test('Mastercard approved card → SUCCESS', async () => {
    const oid = `MC-${Date.now()}`;
    const r = await req('PUT', `${base}/${oid}/transaction/1`, payload('5123450000000008'));
    console.log(`       result: ${r.body.result}  gatewayCode: ${r.body.response?.gatewayCode}  ref: ${r.body['paylode.reference']}`);
    assert(r.body.result === 'SUCCESS', `Expected SUCCESS, got ${r.body.result}: ${JSON.stringify(r.body)}`);
    assert(r.body.response?.gatewayCode === 'APPROVED', `Expected APPROVED`);
    assert(r.body['paylode.reference'], 'Missing paylode.reference');
  });

  await test('Visa approved card → SUCCESS', async () => {
    const oid = `VISA-${Date.now()}`;
    const r = await req('PUT', `${base}/${oid}/transaction/1`, payload('4111111111111111'));
    console.log(`       result: ${r.body.result}  scheme: ${r.body.sourceOfFunds?.provided?.card?.scheme}`);
    assert(r.body.result === 'SUCCESS', `Expected SUCCESS`);
    assert(r.body.sourceOfFunds?.provided?.card?.scheme === 'VISA', 'Scheme should be VISA');
  });

  await test('Declined card → FAILURE', async () => {
    const oid = `DCL-${Date.now()}`;
    const r = await req('PUT', `${base}/${oid}/transaction/1`, payload('4000000000000002'));
    console.log(`       result: ${r.body.result}  gatewayCode: ${r.body.response?.gatewayCode}`);
    assert(r.body.result === 'FAILURE', `Expected FAILURE`);
    assert(r.body.response?.gatewayCode === 'DECLINED', `Expected DECLINED`);
  });

  await test('PAN is masked in response (PCI)', async () => {
    const oid = `PCI-${Date.now()}`;
    const r = await req('PUT', `${base}/${oid}/transaction/1`, payload('5123450000000008'));
    const returned = r.body.sourceOfFunds?.provided?.card?.number || '';
    assert(!returned.includes('5123450000000008'), `Full PAN exposed — PCI violation: ${returned}`);
    console.log(`       masked PAN: ${returned}`);
  });

  await test('USD currency accepted', async () => {
    const oid = `USD-${Date.now()}`;
    const body = { ...payload('5123450000000008', '50.00'), order: { amount: '50.00', currency: 'USD', description: 'USD test' } };
    const r = await req('PUT', `${base}/${oid}/transaction/1`, body);
    console.log(`       result: ${r.body.result}  currency: USD`);
    assert(r.body.result === 'SUCCESS', `Expected SUCCESS for USD`);
  });

  console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
