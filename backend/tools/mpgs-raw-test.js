'use strict';
// Calls Mastercard NA gateway directly — shows raw response for diagnosis.
// Run: node /tmp/mpgs-raw-test.js && rm /tmp/mpgs-raw-test.js

const https = require('https');

const MID      = 'PSLPBL1';
const PASSWORD = '@Sulaimon+1@';
const BASE     = 'na-gateway.mastercard.com';

// ── FILL IN ───────────────────────────────────────────────────────────────────
const CARD_NUMBER = '';
const CARD_MONTH  = '';
const CARD_YEAR   = '';
const CARD_CVV    = '';
const CARD_NAME   = '';
// ─────────────────────────────────────────────────────────────────────────────

const oid  = `DIAG-${Date.now()}`;
const auth = 'Basic ' + Buffer.from(`merchant.${MID}:${PASSWORD}`).toString('base64');
const body = JSON.stringify({
  apiOperation: 'PAY',
  order: { amount: '100.00', currency: 'NGN', description: 'Paylode diag test' },
  sourceOfFunds: { type: 'CARD', provided: { card: {
    number: CARD_NUMBER, expiry: { month: CARD_MONTH, year: CARD_YEAR },
    securityCode: CARD_CVV, nameOnCard: CARD_NAME,
  }}},
  transaction: { reference: `DIAG-${oid}` },
  customer: { email: 'test@paylodeservices.com', firstName: 'Paylode', lastName: 'Test', ipAddress: '127.0.0.1' },
});

const req = https.request({
  hostname: BASE, port: 443,
  path: `/api/rest/version/77/merchant/${MID}/order/${oid}/transaction/1`,
  method: 'PUT',
  headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const r = JSON.parse(d);
    console.log('\n── Raw Mastercard response ─────────────────────────────');
    console.log(JSON.stringify(r, null, 2));
    console.log('────────────────────────────────────────────────────────\n');
  });
});
req.on('error', e => console.error('Network error:', e.message));
req.write(body); req.end();
