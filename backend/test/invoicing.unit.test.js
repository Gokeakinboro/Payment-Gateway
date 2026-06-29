'use strict';
/**
 * Invoice & Collect — backend unit tests (pure helpers, no DB / no network).
 * Run: node test/invoicing.unit.test.js   (after `npm install`)
 *
 * Zero-dependency runner (matches the SDK suite) so it works without jest.
 * Requires the generated Prisma client to be present because _shared.js pulls
 * utils/db at load — but it never opens a connection here.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.INVOICE_VAT_RATE = '0.075';

const assert = require('assert');
const { computeVat, signRecipient, verifyRecipient, isValidEmail, randToken } =
  require('../src/modules/invoicing/_shared');
const { formatInvoiceNumber } = require('../src/modules/invoicing/services/invoiceNumber');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++; }
  catch (e) { console.log(`  ✗  ${name}\n     ${e.message}`); failed++; }
}

console.log('\n  Invoice & Collect — backend unit tests\n');

console.log('  computeVat (7.5% on invoice face, kobo)');
test('returns 0n when charge_vat is false', () => {
  assert.strictEqual(computeVat(5_000_000, false), 0n);
});
test('charges 7.5% on ₦50,000 → 375000 kobo', () => {
  assert.strictEqual(computeVat(5_000_000, true), 375000n);
});
test('charges 7.5% on ₦1 → 7 kobo (integer, no float drift)', () => {
  assert.strictEqual(computeVat(100, true), 7n);
});
test('handles BigInt input', () => {
  assert.strictEqual(computeVat(10_000_000n, true), 750000n);
});

console.log('\n  formatInvoiceNumber');
test('zero-pads to 6 digits with upper-cased code', () => {
  assert.strictEqual(formatInvoiceNumber(482, 'club'), 'CLUB-INV-000482');
});
test('falls back to PYL when no code', () => {
  assert.strictEqual(formatInvoiceNumber(1, null), 'PYL-INV-000001');
});
test('does not truncate sequences past 6 digits', () => {
  assert.strictEqual(formatInvoiceNumber(1234567, 'ACME'), 'ACME-INV-1234567');
});

console.log('\n  Recipient token (HMAC, stateless)');
test('round-trips a normalised email', () => {
  const t = signRecipient('  Ada@Example.COM ');
  assert.strictEqual(verifyRecipient(t), 'ada@example.com');
});
test('rejects a tampered signature', () => {
  const t = signRecipient('ada@example.com');
  const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
  assert.strictEqual(verifyRecipient(tampered), null);
});
test('rejects a malformed token', () => {
  assert.strictEqual(verifyRecipient('garbage'), null);
  assert.strictEqual(verifyRecipient(''), null);
  assert.strictEqual(verifyRecipient(null), null);
});

console.log('\n  isValidEmail / randToken');
test('accepts a normal address, rejects junk', () => {
  assert.ok(isValidEmail('a@b.com'));
  assert.ok(!isValidEmail('a@b'));
  assert.ok(!isValidEmail('nope'));
  assert.ok(!isValidEmail(''));
});
test('randToken is url-safe and unique', () => {
  const a = randToken(18), b = randToken(18);
  assert.ok(!/[^A-Za-z0-9_-]/.test(a), 'should be base64url');
  assert.notStrictEqual(a, b);
});

console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
