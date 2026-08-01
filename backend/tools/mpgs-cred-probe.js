'use strict';
// Update DB + probe with correct Integration Access passwords
// Run: node /tmp/mpgs-cred-probe.js && rm /tmp/mpgs-cred-probe.js
const https = require('https');
const { execSync } = require('child_process');

const MID   = 'PSLPBL1';
const OPID  = 'PSLPBL2';
const PW1   = 'b01b56b68d634bb280c60088c2b';  // Integration Access PW1 (5:10 PM)
const PW2   = '09f963eeabed0d9ed632e740ab1';  // Integration Access PW2 (4:22 PM)
const DB    = 'postgresql://paylode:PaylodeSecure2025@localhost:5432/paylode_db';

// Update DB with PW1
try {
  const r = execSync(`psql "${DB}" -t -c "UPDATE merchant_mpgs_configs SET mpgs_api_password = '${PW1}' WHERE mpgs_mid = 'PSLPBL1' RETURNING mpgs_mid"`, { encoding: 'utf8' });
  console.log('DB updated with PW1:', r.trim());
} catch(e) { console.error('DB update failed:', e.message); }

const combos = [
  { host: 'na-gateway.mastercard.com',  user: `merchant.${MID}`,                  pw: PW1, label: 'na-gw / PW1 / merchant.MID' },
  { host: 'na-gateway.mastercard.com',  user: `merchant.${MID}.operator.${OPID}`, pw: PW1, label: 'na-gw / PW1 / merchant.MID.operator.OPID' },
  { host: 'na-gateway.mastercard.com',  user: `merchant.${MID}`,                  pw: PW2, label: 'na-gw / PW2 / merchant.MID' },
  { host: 'mtf.gateway.mastercard.com', user: `merchant.${MID}`,                  pw: PW1, label: 'mtf-gw / PW1 / merchant.MID' },
  { host: 'mtf.gateway.mastercard.com', user: `merchant.${MID}.operator.${OPID}`, pw: PW1, label: 'mtf-gw / PW1 / merchant.MID.operator.OPID' },
];

const mkBody = () => JSON.stringify({
  apiOperation: 'PAY',
  order: { amount: '1.00', currency: 'NGN', description: 'Paylode integration probe' },
  sourceOfFunds: { type: 'CARD', provided: { card: {
    number: '5123450000000008', expiry: { month: '05', year: '27' }, securityCode: '100',
  }}},
  transaction: { reference: `P-${Date.now()}` },
});

async function probe(c) {
  return new Promise(resolve => {
    const body = mkBody();
    const auth = 'Basic ' + Buffer.from(`${c.user}:${c.pw}`).toString('base64');
    const oid  = `P${Date.now()}${Math.random().toString(36).slice(2,5)}`;
    const req  = https.request({
      hostname: c.host, port: 443,
      path: `/api/rest/version/77/merchant/${MID}/order/${oid}/transaction/1`,
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', x => d += x);
      res.on('end', () => {
        const r = JSON.parse(d);
        const credOk = !r.error?.explanation?.toLowerCase().includes('invalid credentials');
        console.log(`${credOk ? '✅' : '❌'}  ${c.label}`);
        console.log(`    result: ${r.result} | ${r.error?.explanation || r.response?.gatewayCode || r.response?.acquirerMessage || '—'}`);
        if (credOk) console.log(`\n    *** WORKING — host: ${c.host}  user: ${c.user}  pw: ${c.pw} ***\n`);
        resolve({ credOk, host: c.host, user: c.user, pw: c.pw });
      });
    });
    req.on('error', e => { console.log(`⚠️   ${c.label} — ${e.message}`); resolve({ credOk: false }); });
    req.write(body); req.end();
  });
}

(async () => {
  console.log('\nProbing with correct Integration Access passwords...\n');
  for (const c of combos) { await probe(c); await new Promise(r => setTimeout(r, 600)); }
  console.log('\nDone.');
})();
