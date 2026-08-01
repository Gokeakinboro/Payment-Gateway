'use strict';
// Run on server 176: node /opt/paylode-api/backend/tools/mpgs-live-card-test.js
// Or locally:        node backend/tools/mpgs-live-card-test.js

const https = require('https');

const GW_MID  = 'PSLPBL1';
const GW_PASS = '4U5GicAL6MPIveHNNfW8Qz4uHs2Y3iRP';
const HOST    = process.env.MPGS_HOST || 'api.paylodeservices.com';
const auth    = 'Basic ' + Buffer.from(`merchant.${GW_MID}:${GW_PASS}`).toString('base64');

function req(orderId, card) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      apiOperation: 'PAY',
      order:        { amount: '100.00', currency: 'NGN', description: 'Paylode MPGS live test' },
      sourceOfFunds: { type: 'CARD', provided: { card: {
        number: card, expiry: { month: '05', year: '27' },
        securityCode: '100', nameOnCard: 'Test Cardholder',
      }}},
      transaction: { reference: 'LIVETEST-' + Date.now() },
      customer:    { email: 'test@paylodeservices.com', firstName: 'Test', lastName: 'Cardholder' },
      authentication: { redirectResponseUrl: `https://paylodeservices.com/checkout.html?3ds=1` },
    });
    const options = {
      hostname: HOST,
      path:     `/api/rest/version/77/merchant/${GW_MID}/order/${orderId}/transaction/1`,
      method:   'PUT',
      headers:  {
        Authorization:   auth,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const r = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: { _raw: d } }); }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

const CARDS = [
  ['5123450000000008', 'MC  5123...0008', 'frictionless → APPROVED'],
  ['5200000000000007', 'MC  5200...0007', '3DS challenge → PENDING'],
  ['5105105105105100', 'MC  5105...5100', 'declined      → DECLINED'],
  ['4111111111111111', 'Visa 4111...1111', 'frictionless → APPROVED'],
];

(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Paylode MPGS Live Test  |  MID: ${GW_MID}  |  host: ${HOST}`);
  console.log('═══════════════════════════════════════════════════════');

  let passed = 0, failed = 0;

  for (const [card, label, expectation] of CARDS) {
    const oid = `LIVE-${card.slice(-4)}-${Date.now()}`;
    console.log(`\n  ── ${label}  (${expectation})`);
    try {
      const { status, body: b } = await req(oid, card);
      console.log(`     HTTP status : ${status}`);
      console.log(`     result      : ${b.result || b.error?.cause || '?'}`);
      console.log(`     gatewayCode : ${b.response?.gatewayCode || '—'}`);
      if (b.transaction?.authorizationCode)    console.log(`     authCode     : ${b.transaction.authorizationCode}`);
      if (b.authentication?.redirectUrl)       console.log(`     redirectUrl  : ${b.authentication.redirectUrl}`);
      if (b.authentication?.challengeUrl)      console.log(`     challengeUrl : ${b.authentication.challengeUrl}`);
      if (b.authentication?.redirectHtml)      console.log(`     redirectHtml : (${b.authentication.redirectHtml.length} bytes — open challengeUrl in browser)`);
      if (b.error?.explanation)                console.log(`     error        : ${b.error.explanation}`);
      if (b['paylode.reference'])           console.log(`     paylodeRef  : ${b['paylode.reference']}`);
      if (b._raw)                           console.log(`     raw         : ${b._raw.slice(0, 200)}`);
      if (status < 500) passed++; else failed++;
    } catch (e) {
      console.log(`     FATAL: ${e.message}`);
      failed++;
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  ${passed} passed  ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
})();
