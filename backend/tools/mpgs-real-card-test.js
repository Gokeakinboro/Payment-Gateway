'use strict';
// Real card test — fill in your card details below, run once, then delete.
// Run: node /tmp/mpgs-real-card-test.js

const http = require('http');

const GW_MID      = 'PSLPBL1';
const GW_PASSWORD = '4U5GicAL6MPIveHNNfW8Qz4uHs2Y3iRP';

// ── FILL THESE IN ─────────────────────────────────────────────────────────────
const CARD_NUMBER  = '';        // e.g. '5399999999999999'
const CARD_EXPIRY_MONTH = '';   // e.g. '12'
const CARD_EXPIRY_YEAR  = '';   // e.g. '27'
const CARD_CVV     = '';        // e.g. '123'
const CARD_NAME    = '';        // name on card
const AMOUNT_NGN   = '100.00';  // ₦100 — change if needed
// ─────────────────────────────────────────────────────────────────────────────

if (!CARD_NUMBER || !CARD_CVV) {
  console.error('Fill in the card details in the script before running.');
  process.exit(1);
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const auth = 'Basic ' + Buffer.from(`merchant.${GW_MID}:${GW_PASSWORD}`).toString('base64');
    const r = http.request({
      hostname: 'localhost', port: 3000, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': auth },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') })); });
    r.on('error', reject);
    r.write(data); r.end();
  });
}

(async () => {
  const oid = `REAL-${Date.now()}`;
  console.log(`\nSending ₦${AMOUNT_NGN} charge to Mastercard...`);
  console.log(`Order ID : ${oid}`);

  const r = await req('PUT',
    `/api/rest/version/77/merchant/${GW_MID}/order/${oid}/transaction/1`,
    {
      apiOperation: 'PAY',
      order: { amount: AMOUNT_NGN, currency: 'NGN', description: 'Paylode gateway live test' },
      sourceOfFunds: { type: 'CARD', provided: { card: {
        number: CARD_NUMBER,
        expiry: { month: CARD_EXPIRY_MONTH, year: CARD_EXPIRY_YEAR },
        securityCode: CARD_CVV,
        nameOnCard: CARD_NAME,
      }}},
      transaction: { reference: `LIVE-TEST-${oid}` },
      customer: { email: 'test@paylodeservices.com', firstName: 'Paylode', lastName: 'Test', ipAddress: '127.0.0.1' },
    }
  );

  console.log('\n── Result ──────────────────────────────────────────────');
  console.log(`  HTTP status : ${r.status}`);
  console.log(`  result      : ${r.body.result}`);
  console.log(`  gatewayCode : ${r.body.response?.gatewayCode}`);
  console.log(`  authCode    : ${r.body.transaction?.authorizationCode || '(none)'}`);
  console.log(`  paylode.ref : ${r.body['paylode.reference'] || '(none)'}`);
  if (r.body.authentication?.redirectUrl)
    console.log(`  3DS redirect: ${r.body.authentication.redirectUrl}`);
  if (r.body.result === 'FAILURE')
    console.log(`  decline     : ${r.body.response?.gatewayCode} / ${r.body.response?.acquirerMessage || ''}`);
  console.log('────────────────────────────────────────────────────────\n');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
