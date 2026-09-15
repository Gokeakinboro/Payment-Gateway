'use strict';
/**
 * NIBSS NPS — backend unit tests (pure helpers, no DB / no network).
 * Run: node test/nibss-nps.unit.test.js
 *
 * Zero-dependency runner (matches the invoicing suite). Nothing here calls out:
 * every function under test is a message builder or a response parser.
 *
 * The point of these tests is the two things that MOVE MONEY incorrectly if they
 * are wrong: (a) kobo↔naira conversion at the ISO 20022 boundary, and (b) the
 * pacs.002 TxSts → orderStatus mapping that decides success/failure/in-flight.
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.NIBSS_NPS_CLIENT_ID        = 'test-client';
process.env.NIBSS_NPS_INSTITUTION_CODE = '999999';
process.env.NIBSS_NPS_DEBIT_ACCOUNT    = '1234567890';
process.env.NIBSS_NPS_DEBIT_NAME       = 'Paylode Test Float';

// Throwaway keypair so the signing path is exercised for real. Set BEFORE the
// require: the service reads its keys from env at load time.
const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.NIBSS_NPS_PRIVATE_KEY = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.NIBSS_NPS_PUBLIC_KEY  = kp.publicKey.export({ type: 'spki', format: 'pem' });

const nps = require('../src/modules/gateway-core/services/nibssNpsService');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++; }
  catch (e) { console.log(`  ✗  ${name}\n     ${e.message}`); failed++; }
}

console.log('\n  NIBSS NPS — backend unit tests\n');

console.log('  amount conversion (kobo ↔ ISO 20022 decimal NGN)');
test('₦50,000 (5000000 kobo) → "50000.00"', () => {
  assert.strictEqual(nps.nairaFromKobo(5000000), '50000.00');
});
test('₦1.07 (107 kobo) → "1.07" — no float drift', () => {
  assert.strictEqual(nps.nairaFromKobo(107), '1.07');
});
test('round-trips back to the same kobo', () => {
  assert.strictEqual(nps.koboFromNaira(nps.nairaFromKobo(123456)), 123456n);
});
test('"50000.00" → 5000000n kobo', () => {
  assert.strictEqual(nps.koboFromNaira('50000.00'), 5000000n);
});

console.log('\n  pacs.002 TxSts → orderStatus (payoutSettle.legStatusFor contract)');
test('ACSC (settled) → "2" = success', () => {
  assert.strictEqual(nps.orderStatusFor('ACSC'), '2');
});
test('ACCC (credited) → "2" = success', () => {
  assert.strictEqual(nps.orderStatusFor('ACCC'), '2');
});
test('RJCT (rejected) → "3" ⇒ failed downstream', () => {
  assert.strictEqual(nps.orderStatusFor('RJCT'), '3');
});
test('PDNG (pending) → "1" = still in flight', () => {
  assert.strictEqual(nps.orderStatusFor('PDNG'), '1');
});
test('ACSP (in settlement) → "1" = still in flight', () => {
  assert.strictEqual(nps.orderStatusFor('ACSP'), '1');
});
test('an UNKNOWN status is in-flight, never failed (no wrong refund)', () => {
  assert.strictEqual(nps.orderStatusFor('WAT'), '1');
  assert.strictEqual(nps.orderStatusFor(undefined), '1');
  assert.strictEqual(nps.orderStatusFor(''), '1');
});
test('lower-case status still maps (case-insensitive)', () => {
  assert.strictEqual(nps.orderStatusFor('acsc'), '2');
});

console.log('\n  pacs.008 credit transfer builder');
const pacs008 = nps.buildCreditTransfer({
  orderId: 'PO-TEST-0001', amountKobo: 5000000, bankCode: '000014',
  accountNumber: '0123456789', accountName: 'Jane Doe', narration: 'Payout test',
});
const tx = pacs008.CdtTrfTxInf[0];
test('settlement amount is decimal NGN, not kobo', () => {
  assert.strictEqual(tx.IntrBkSttlmAmt.value, '50000.00');
  assert.strictEqual(tx.IntrBkSttlmAmt.Ccy, 'NGN');
});
test('EndToEndId is our rail_order_id (what pacs.002 echoes back)', () => {
  assert.strictEqual(tx.PmtId.EndToEndId, 'PO-TEST-0001');
});
test('creditor agent carries the beneficiary bank code', () => {
  assert.strictEqual(tx.CdtrAgt.FinInstnId.ClrSysMmbId.MmbId, '000014');
});
test('debtor agent carries OUR institution code', () => {
  assert.strictEqual(tx.DbtrAgt.FinInstnId.ClrSysMmbId.MmbId, '999999');
});
test('debtor account is our configured float NUBAN', () => {
  assert.strictEqual(tx.DbtrAcct.Id.Othr.Id, '1234567890');
});
test('beneficiary account + name are set', () => {
  assert.strictEqual(tx.CdtrAcct.Id.Othr.Id, '0123456789');
  assert.strictEqual(tx.Cdtr.Nm, 'Jane Doe');
});
test('narration lands in RmtInf.Ustrd', () => {
  assert.strictEqual(tx.RmtInf.Ustrd[0], 'Payout test');
});
test('BVN from the name-enquiry prefetch is carried on the creditor', () => {
  const withBvn = nps.buildCreditTransfer({
    orderId: 'X', amountKobo: 100, bankCode: '000014', accountNumber: '1', bvn: '22222222222',
  });
  assert.strictEqual(withBvn.CdtTrfTxInf[0].Cdtr.Id.PrvtId.Othr[0].Id, '22222222222');
});
test('omits the creditor Id entirely when no BVN is known', () => {
  assert.strictEqual(tx.Cdtr.Id, undefined);
});
test('narration is truncated to ISO 20022 Max140Text', () => {
  const long = nps.buildCreditTransfer({
    orderId: 'X', amountKobo: 100, bankCode: '000014', accountNumber: '1', narration: 'z'.repeat(300),
  });
  assert.strictEqual(long.CdtTrfTxInf[0].RmtInf.Ustrd[0].length, 140);
});

console.log('\n  identifiers');
test('MsgId respects ISO 20022 Max35Text', () => {
  assert.ok(nps.msgId('PO').length <= 35);
  assert.ok(nps.msgId('VERYLONGPREFIXVERYLONGPREFIXVERYLONGPREFIX').length <= 35);
});
test('MsgId is unique across calls', () => {
  assert.notStrictEqual(nps.msgId('PO'), nps.msgId('PO'));
});
test('group header carries our institution code and NbOfTxs', () => {
  const h = nps.groupHeader('PO');
  assert.strictEqual(h.InstgAgt.FinInstnId.ClrSysMmbId.MmbId, '999999');
  assert.strictEqual(h.NbOfTxs, '1');
});

console.log('\n  response parsing (nested ISO vs flattened REST)');
const nested = { FIToFIPmtStsRpt: { GrpHdr: { MsgId: 'NIBSS-1' }, TxInfAndSts: {
  OrgnlEndToEndId: 'PO-TEST-0001', OrgnlTxId: 'NIBSS-TX-9', TxSts: 'ACSC' } } };
test('reads TxSts from the nested pacs.002 shape', () => {
  assert.strictEqual(nps.txStatusOf(nested), 'ACSC');
});
test('reads TxSts from a flattened shape', () => {
  assert.strictEqual(nps.txStatusOf({ data: { status: 'RJCT' } }), 'RJCT');
});
test('reads the end-to-end id (session id) from the nested shape', () => {
  assert.strictEqual(nps.sessionIdOf(nested), 'PO-TEST-0001');
});
test('reads the provider ref (OrgnlTxId) from the nested shape', () => {
  assert.strictEqual(nps.providerRefOf(nested), 'NIBSS-TX-9');
});
test('TxInfAndSts as an ARRAY parses the same as a single object', () => {
  const arr = { FIToFIPmtStsRpt: { TxInfAndSts: [{ OrgnlEndToEndId: 'E2E-1', TxSts: 'ACSC' }] } };
  assert.strictEqual(nps.txStatusOf(arr), 'ACSC');
  assert.strictEqual(nps.sessionIdOf(arr), 'E2E-1');
});
test('joins rejection reason code + additional info', () => {
  const rjct = { FIToFIPmtStsRpt: { TxInfAndSts: { TxSts: 'RJCT',
    StsRsnInf: { Rsn: { Cd: 'AC03' }, AddtlInf: 'Invalid creditor account' } } } };
  assert.strictEqual(nps.reasonOf(rjct), 'AC03 — Invalid creditor account');
});
test('missing fields parse to undefined, not a throw', () => {
  assert.strictEqual(nps.txStatusOf({}), undefined);
  assert.strictEqual(nps.sessionIdOf({}), null);
  assert.strictEqual(nps.reasonOf({}), '');
});
test('callFailed flags HTTP errors and unparseable bodies', () => {
  assert.strictEqual(nps.callFailed({ httpStatus: 200 }), false);
  assert.strictEqual(nps.callFailed({ httpStatus: 500 }), true);
  assert.strictEqual(nps.callFailed({ _parseError: true }), true);
});

console.log('\n  camt.054 amount extraction (exact-amount enforcement depends on it)');
test('unwraps the ISO { Ccy, value } amount node', () => {
  assert.strictEqual(nps.amountOf({ Ccy: 'NGN', value: '100.00' }), '100.00');
});
test('passes a BARE SCALAR amount through — reading .value would lose it', () => {
  // Regression: losing this yields undefined ⇒ paidAmount null ⇒ the exact-amount
  // check is skipped ⇒ an underpayment gets credited in full.
  assert.strictEqual(nps.amountOf('100.00'), '100.00');
});
test('unwraps an amount node wrapped in an array', () => {
  assert.strictEqual(nps.amountOf([{ Ccy: 'NGN', value: '250.50' }]), '250.50');
});
test('returns undefined for a missing amount (caller must reject, not credit)', () => {
  assert.strictEqual(nps.amountOf(undefined), undefined);
  assert.strictEqual(nps.amountOf(null), undefined);
});
test('a camt.054 with a scalar Amt still resolves via dig + amountOf', () => {
  const camt054 = { Ntfctn: { Ntry: { Amt: '100.00', CdtDbtInd: 'CRDT' } } };
  const naira = nps.amountOf(nps.dig(camt054, 'Ntfctn.Ntry.Amt', 'data.amount', 'amount'));
  assert.strictEqual(naira, '100.00');
  assert.strictEqual(nps.koboFromNaira(naira), 10000n);
});
test('a camt.054 with a nested Amt resolves to the same kobo', () => {
  const camt054 = { Ntfctn: { Ntry: { Amt: { Ccy: 'NGN', value: '100.00' }, CdtDbtInd: 'CRDT' } } };
  const naira = nps.amountOf(nps.dig(camt054, 'Ntfctn.Ntry.Amt', 'data.amount', 'amount'));
  assert.strictEqual(nps.koboFromNaira(naira), 10000n);
});

console.log('\n  request signing / callback verification');
test('a signed body verifies with the matching public key', () => {
  const body = JSON.stringify({ GrpHdr: { MsgId: 'M1' }, amount: '100.00' });
  assert.strictEqual(nps.verifyBody(body, nps.signBody(body)), true);
});
test('a TAMPERED body fails verification', () => {
  const body = JSON.stringify({ amount: '100.00' });
  const sig = nps.signBody(body);
  assert.strictEqual(nps.verifyBody(JSON.stringify({ amount: '900000.00' }), sig), false);
});
test('a garbage signature fails instead of throwing', () => {
  assert.strictEqual(nps.verifyBody('{}', 'not-a-signature'), false);
});
test('an empty signature fails', () => {
  assert.strictEqual(nps.verifyBody('{}', ''), false);
});
test('verifyCallback prefers RAW bytes over the re-serialised body', () => {
  // Keys deliberately in a different order than JSON.stringify would emit.
  const raw = '{"b":2,"a":1}';
  const sig = nps.signBody(raw);
  assert.strictEqual(nps.verifyCallback({ a: 1, b: 2 }, sig, raw), true);
  // Without the raw bytes the re-serialisation reorders and the signature fails —
  // this is exactly why appFactory.js stashes req.rawBody for this path.
  assert.strictEqual(nps.verifyCallback({ a: 1, b: 2 }, sig), false);
});
test('toPem wraps a bare base64 key and leaves a PEM untouched', () => {
  const pem = process.env.NIBSS_NPS_PUBLIC_KEY;
  assert.strictEqual(nps.toPem(pem, 'PUBLIC KEY'), pem);
  const bare = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  assert.ok(nps.toPem(bare, 'PUBLIC KEY').startsWith('-----BEGIN PUBLIC KEY-----'));
});

console.log('\n  rail adapter registration');
test('a CONFIGURED NPS rail resolves to the NPS adapter', () => {
  const { payoutAdapterForName } = require('../src/modules/gateway-core/services/payoutRailAdapter');
  assert.strictEqual(nps.isConfigured(), true);
  assert.strictEqual(payoutAdapterForName('NIBSS NPS'), nps);
  assert.strictEqual(payoutAdapterForName('NIBSS'), nps);
});
test('the NPS adapter satisfies the full rail contract', () => {
  for (const fn of ['isConfigured', 'getBalance', 'sendPayout', 'queryPayoutResult', 'nameEnquiry', 'getBanks']) {
    assert.strictEqual(typeof nps[fn], 'function', `missing ${fn}`);
  }
});
test('an unrelated rail name does NOT resolve to NPS', () => {
  const { payoutAdapterForName } = require('../src/modules/gateway-core/services/payoutRailAdapter');
  assert.notStrictEqual(payoutAdapterForName('Parallex Bank'), nps);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
