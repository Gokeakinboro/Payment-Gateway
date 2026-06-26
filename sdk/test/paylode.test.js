'use strict';
/**
 * Paylode SDK — Test Suite
 * Run: node test/paylode.test.js
 * Uses sk_test_ key — no real charges
 */

const Paylode = require('../src/paylode');
const { PaylodeError } = require('../src/paylode');

let passed = 0; let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++; }
  catch(e) { console.log(`  ✗  ${name}\n     ${e.message}`); failed++; }
}

function assert(condition, msg) { if (!condition) throw new Error(msg || 'Assertion failed'); }
function assertThrows(fn, code) {
  try { fn(); throw new Error('Expected error but none thrown'); }
  catch(e) { if (e.code !== code) throw new Error(`Expected code ${code}, got ${e.code || e.message}`); }
}

console.log('\n  Paylode Node.js SDK — Unit Tests\n');

// ── Instantiation ──
console.log('  Instantiation');
test('accepts sk_live_ key', () => {
  const p = new Paylode('sk_live_testxxxxxxxxxxxxxxxx');
  assert(p.sandbox === false);
});
test('accepts sk_test_ key and sets sandbox mode', () => {
  const p = new Paylode('sk_test_testxxxxxxxxxxxxxxxx');
  assert(p.sandbox === true);
});
test('throws on missing key', () => {
  assertThrows(() => new Paylode(), 'MISSING_KEY');
});
test('throws on invalid key format', () => {
  assertThrows(() => new Paylode('pk_live_wrong'), 'INVALID_KEY');
});
test('exposes version string', () => {
  const p = new Paylode('sk_test_xxx');
  assert(typeof p.version === 'string' && p.version.length > 0);
});
test('exposes kycLimits', () => {
  const p = new Paylode('sk_test_xxx');
  assert(p.kycLimits.tier_1.single_txn === 5000000);
  assert(p.kycLimits.tier_2.single_txn === 100000000);
  assert(p.kycLimits.tier_3.single_txn === 500000000);
});

// ── Transaction validation (no network) ──
console.log('\n  Transaction validation');
test('throws MISSING_FIELD when email absent', async () => {
  const p = new Paylode('sk_test_xxx');
  try { await p.transaction.initialize({ amount: 100000 }); }
  catch(e) { assert(e.code === 'MISSING_FIELD' && e.message.includes('email')); return; }
  throw new Error('should have thrown');
});
test('throws MISSING_FIELD when amount absent', async () => {
  const p = new Paylode('sk_test_xxx');
  try { await p.transaction.initialize({ email: 'a@b.com' }); }
  catch(e) { assert(e.code === 'MISSING_FIELD' && e.message.includes('amount')); return; }
  throw new Error('should have thrown');
});
test('throws INVALID_AMOUNT when amount below minimum', async () => {
  const p = new Paylode('sk_test_xxx');
  try { await p.transaction.initialize({ email: 'a@b.com', amount: 5000 }); }
  catch(e) { assert(e.code === 'INVALID_AMOUNT'); return; }
  throw new Error('should have thrown');
});
test('throws MISSING_FIELD on verify with no reference', async () => {
  const p = new Paylode('sk_test_xxx');
  try { await p.transaction.verify(); }
  catch(e) { assert(e.code === 'MISSING_FIELD'); return; }
  throw new Error('should have thrown');
});

// ── Subaccount validation ──
console.log('\n  Subaccount validation');
test('throws MISSING_FIELD when business_name absent', async () => {
  const p = new Paylode('sk_test_xxx');
  try { await p.subaccount.create({ settlement_bank:'044', account_number:'0123456789', percentage_charge:30 }); }
  catch(e) { assert(e.code === 'MISSING_FIELD'); return; }
  throw new Error('should have thrown');
});

// ── Webhook verification ──
console.log('\n  Webhook signature');
test('verifies a correct HMAC-SHA512 signature', () => {
  const secret = 'whsec_paylode_test_secret_xyz';
  const body = JSON.stringify({ event: 'payment.success', data: { reference: 'TXN-001' } });
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha512', secret).update(body).digest('hex');
  assert(Paylode.webhooks.verify(body, sig, secret) === true);
});
test('rejects a tampered signature', () => {
  assert(Paylode.webhooks.verify('body', 'badsignature', 'secret') === false);
});
test('handles Buffer rawBody', () => {
  const secret = 'test_secret';
  const body = Buffer.from('{"event":"test"}');
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha512', secret).update(body.toString()).digest('hex');
  assert(Paylode.webhooks.verify(body, sig, secret) === true);
});

// ── Utils ──
console.log('\n  Utils');
test('generateRef returns non-empty string', () => {
  const ref = Paylode.utils.generateRef();
  assert(typeof ref === 'string' && ref.startsWith('TXN-'));
});
test('generateRef accepts custom prefix', () => {
  const ref = Paylode.utils.generateRef('ORD');
  assert(ref.startsWith('ORD-'));
});
test('generateRef is unique each call', () => {
  const refs = new Set(Array.from({ length: 100 }, () => Paylode.utils.generateRef()));
  assert(refs.size === 100);
});
test('koboToNaira converts correctly', () => {
  assert(Paylode.utils.koboToNaira(100000) === '1000.00');
  assert(Paylode.utils.koboToNaira(5000000) === '50000.00');
});
test('nairaToKobo converts correctly', () => {
  assert(Paylode.utils.nairaToKobo(1000) === 100000);
  assert(Paylode.utils.nairaToKobo(50000) === 5000000);
});

// ── Summary ──
console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
