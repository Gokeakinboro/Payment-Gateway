'use strict';
// Monzo / real-card 3DS challenge test.
// Run on server 176:
//   node /opt/paylode-api/backend/tools/mpgs-monzo-test.js
//
// Supply card details via env vars (never hard-code real PANs):
//   CARD_NUMBER=5123... CARD_MONTH=05 CARD_YEAR=27 CARD_CVV=100 CARD_NAME="Test User"
//   CURRENCY=USD  (default: USD)

const https = require('https');

const GW_MID  = 'PSLPBL1';
const GW_PASS = '4U5GicAL6MPIveHNNfW8Qz4uHs2Y3iRP';
const HOST    = process.env.MPGS_HOST || 'api.paylodeservices.com';
const auth    = 'Basic ' + Buffer.from(`merchant.${GW_MID}:${GW_PASS}`).toString('base64');

const CARD = {
  number:       process.env.CARD_NUMBER   || '',
  month:        process.env.CARD_MONTH    || '05',
  year:         process.env.CARD_YEAR     || '27',
  cvv:          process.env.CARD_CVV      || '100',
  name:         process.env.CARD_NAME     || 'Test Cardholder',
};
const CURRENCY = process.env.CURRENCY || 'USD';
const AMOUNT   = process.env.AMOUNT   || '1.00';

if (!CARD.number) {
  console.error('\nUsage: CARD_NUMBER=XXXX... CARD_MONTH=MM CARD_YEAR=YY CARD_CVV=CVV node tools/mpgs-monzo-test.js\n');
  process.exit(1);
}

function req(orderId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      apiOperation: 'PAY',
      order:        { amount: AMOUNT, currency: CURRENCY, description: 'Paylode Monzo 3DS test' },
      sourceOfFunds: { type: 'CARD', provided: { card: {
        number:       CARD.number,
        expiry:       { month: CARD.month, year: CARD.year },
        securityCode: CARD.cvv,
        nameOnCard:   CARD.name,
      }}},
      transaction: { reference: 'MONZO-' + Date.now() },
      customer:    { email: 'test@paylodeservices.com', firstName: 'Monzo', lastName: 'Tester' },
    });
    const options = {
      hostname: HOST,
      path:     `/api/rest/version/77/merchant/${GW_MID}/order/${orderId}/transaction/1`,
      method:   'PUT',
      headers:  {
        Authorization:    auth,
        'Content-Type':   'application/json',
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

(async () => {
  const last4 = CARD.number.slice(-4);
  const orderId = `MONZO-${last4}-${Date.now()}`;

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  Monzo 3DS Test  |  MID: ${GW_MID}  |  currency: ${CURRENCY}`);
  console.log(`  Card: **** **** **** ${last4}  |  host: ${HOST}`);
  console.log('══════════════════════════════════════════════════════════\n');

  try {
    const { status, body: b } = await req(orderId);
    console.log(`  HTTP status      : ${status}`);
    console.log(`  result           : ${b.result || '?'}`);

    if (b.result === 'PENDING_AUTHENTICATION') {
      console.log('\n  ✓ 3DS challenge triggered!\n');
      if (b.authentication?.challengeUrl) {
        console.log('  ┌─────────────────────────────────────────────────────┐');
        console.log('  │  Open this URL in your browser to complete 3DS:     │');
        console.log('  │                                                     │');
        console.log(`  │  ${b.authentication.challengeUrl}`);
        console.log('  │                                                     │');
        console.log('  └─────────────────────────────────────────────────────┘\n');
      }
      if (b.authentication?.redirectHtml) {
        console.log(`  redirectHtml : (${b.authentication.redirectHtml.length} bytes)`);
      }
      if (b.authentication?.redirectUrl) {
        console.log(`  redirectUrl  : ${b.authentication.redirectUrl}`);
      }
      console.log(`  paylode.ref  : ${b['paylode.reference']}`);
      console.log('\n  After completing 3DS in browser, check transaction status:');
      console.log(`  curl https://${HOST}/api/rest/version/77/merchant/${GW_MID}/order/${orderId}`);
    } else if (b.result === 'SUCCESS') {
      console.log('  ✓ Payment approved (frictionless 3DS or no 3DS required)');
      console.log(`  authCode     : ${b.transaction?.authorizationCode || '—'}`);
      console.log(`  gatewayCode  : ${b.response?.gatewayCode || '—'}`);
    } else {
      console.log(`  gatewayCode  : ${b.response?.gatewayCode || '—'}`);
      console.log(`  acquirerCode : ${b.response?.acquirerCode || '—'}`);
      if (b.error) console.log(`  error        : ${b.error.explanation || JSON.stringify(b.error)}`);
      if (b._raw)  console.log(`  raw          : ${b._raw.slice(0, 300)}`);
    }
  } catch (e) {
    console.error(`  FATAL: ${e.message}`);
    process.exit(1);
  }

  console.log('\n══════════════════════════════════════════════════════════\n');
})();
