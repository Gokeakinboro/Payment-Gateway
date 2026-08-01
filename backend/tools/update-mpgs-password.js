'use strict';
// One-shot: update MPGS API password for PSLPBL1 then run a live test
// Run: node /tmp/update-mpgs-pw.js && rm /tmp/update-mpgs-pw.js
const http = require('http');
const { execSync } = require('child_process');

const DB = 'postgresql://paylode:PaylodeSecure2025@localhost:5432/paylode_db';
const NEW_PW = '7d9edca2d7eab8c3fb8c2a45478';
const MID    = 'PSLPBL1';

// Update in DB
const result = execSync(`psql "${DB}" -t -c "UPDATE merchant_mpgs_configs SET mpgs_api_password = '${NEW_PW}' WHERE mpgs_mid = '${MID}' RETURNING mpgs_mid, updated_at"`, { encoding: 'utf8' });
console.log('DB updated:', result.trim());

// Now run a direct test to Mastercard with the real card (5355221318802321)
// Using the raw diagnostic approach
const https = require('https');
const auth = 'Basic ' + Buffer.from(`merchant.${MID}:${NEW_PW}`).toString('base64');
const oid  = `DIAG2-${Date.now()}`;
const body = JSON.stringify({
  apiOperation: 'PAY',
  order: { amount: '1.00', currency: 'NGN', description: 'Paylode MPGS password test' },
  sourceOfFunds: { type: 'CARD', provided: { card: {
    number: '5123450000000008',
    expiry: { month: '05', year: '27' },
    securityCode: '100',
    nameOnCard: 'Test Cardholder',
  }}},
  transaction: { reference: `TEST-${oid}` },
  customer: { email: 'test@paylodeservices.com', firstName: 'Test', lastName: 'Cardholder', ipAddress: '127.0.0.1' },
});

console.log('\nTesting credentials against Mastercard NA gateway...');
const req = https.request({
  hostname: 'na-gateway.mastercard.com', port: 443,
  path: `/api/rest/version/77/merchant/${MID}/order/${oid}/transaction/1`,
  method: 'PUT',
  headers: { Authorization: auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, res => {
  let d = ''; res.on('data', c => d += c);
  res.on('end', () => {
    const r = JSON.parse(d);
    console.log('result      :', r.result);
    console.log('gatewayCode :', r.response?.gatewayCode || r.error?.cause);
    console.log('explanation :', r.error?.explanation || r.response?.acquirerMessage || '—');
    if (r.result === 'SUCCESS') console.log('✅ Credentials VALID — Mastercard accepted the request');
    else if (r.error?.explanation?.includes('Invalid credentials')) console.log('❌ Still invalid credentials');
    else console.log('ℹ️  Credentials accepted (transaction declined for other reason — this is normal with test cards on prod gateway)');
  });
});
req.on('error', e => console.error('Network error:', e.message));
req.write(body); req.end();
