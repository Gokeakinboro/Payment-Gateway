'use strict';
/**
 * Member Wallet — backend unit tests (pure helpers + module load; no DB).
 * Run: node test/wallet.unit.test.js
 * Ledger math / never-negative are enforced in-DB (row lock + CHECK(balance>=0))
 * and covered by integration tests against a real database.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const assert = require('assert');
const shared = require('../src/modules/wallet/_shared');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`  ✓  ${name}`); passed++; } catch (e) { console.log(`  ✗  ${name}\n     ${e.message}`); failed++; } }

console.log('\n  Member Wallet — unit tests\n');

console.log('  phone normalisation');
test('local 0… → 234…', () => assert.strictEqual(shared.normalizePhone('09073128016'), '2349073128016'));
test('bare 80… → 234…', () => assert.strictEqual(shared.normalizePhone('8012345678'), '2348012345678'));
test('+234 kept', () => assert.strictEqual(shared.normalizePhone('+2348012345678'), '2348012345678'));
test('junk → null', () => assert.strictEqual(shared.normalizePhone('abc'), null));

console.log('\n  temp password (member onboarding)');
test('meets complexity (len, ends A1!)', () => {
  const p = shared.genTempPassword();
  assert.ok(p.length >= 9, 'length');
  assert.ok(/A1!$/.test(p), 'suffix A1!');
  assert.ok(/[a-zA-Z0-9]/.test(p), 'alnum');
});
test('unique each call', () => {
  const s = new Set(Array.from({ length: 50 }, () => shared.genTempPassword()));
  assert.strictEqual(s.size, 50);
});

console.log('\n  refs + email + ceiling default');
test('genRef prefixed + unique', () => {
  assert.ok(shared.genRef('WL').startsWith('WL-'));
  assert.notStrictEqual(shared.genRef(), shared.genRef());
});
test('isValidEmail', () => { assert.ok(shared.isValidEmail('a@b.com')); assert.ok(!shared.isValidEmail('a@b')); });
test('default max balance = ₦3,000,000 (kobo)', () => assert.strictEqual(shared.DEFAULT_MAX_BALANCE, 300000000n));

console.log('\n  module surface');
test('module index loads with all routes', () => { require('../src/modules/wallet'); });
test('ledger exposes the closed-loop ops', () => {
  const l = require('../src/modules/wallet/services/ledger');
  ['credit', 'debit', 'spendToDepartment', 'transferDepartments', 'reconcile'].forEach((f) => assert.strictEqual(typeof l[f], 'function'));
});

console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
