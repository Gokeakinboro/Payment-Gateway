'use strict';
// Tests what Cardinal Commerce actually returns when we submit a CReq.
// Run: node /opt/paylode-api/backend/tools/mpgs-creq-probe.js

const https = require('https');
const MID  = 'PSLPBL1';
const PASS = '09f963eeabed0d9ed632e740ab19b6ed';
const auth = 'Basic ' + Buffer.from('merchant.' + MID + ':' + PASS).toString('base64');
const oid  = 'CREQPROBE-' + Date.now();

function mpgsPut(txnId, body) {
  const s = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'na-gateway.mastercard.com',
      path: '/api/rest/version/77/merchant/' + MID + '/order/' + oid + '/transaction/' + txnId,
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    r.on('error', reject); r.write(s); r.end();
  });
}

function httpPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const s = body;
    const r = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(s) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject); r.write(s); r.end();
  });
}

(async () => {
  const pan = process.env.CARD_NUMBER || '5199111186151739';
  const exp = { month: process.env.CARD_MONTH || '05', year: process.env.CARD_YEAR || '27' };
  const cvv = process.env.CARD_CVV || '819';

  console.log('\n=== STEP 1: INITIATE_AUTHENTICATION ===');
  await mpgsPut('1', {
    apiOperation: 'INITIATE_AUTHENTICATION',
    authentication: { channel: 'PAYER_BROWSER', purpose: 'PAYMENT_TRANSACTION' },
    order: { currency: 'NGN' },
    sourceOfFunds: { type: 'CARD', provided: { card: { number: pan, expiry: exp } } }
  });
  console.log('Done.');

  console.log('\n=== STEP 2: AUTHENTICATE_PAYER ===');
  const a = await mpgsPut('1', {
    apiOperation: 'AUTHENTICATE_PAYER',
    authentication: { redirectResponseUrl: 'https://api.paylodeservices.com/api/rest/3ds/callback?ref=PROBE' },
    device: {
      browser: 'MOZILLA',
      browserDetails: {
        '3DSecureChallengeWindowSize': '500_X_600', acceptHeaders: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        colorDepth: 24, javaEnabled: false, language: 'en-NG', screenHeight: 900, screenWidth: 1440, timeZone: 0
      },
      ipAddress: '102.89.33.100'
    },
    order: { currency: 'NGN', amount: '100.00' },
    sourceOfFunds: { provided: { card: { number: pan, expiry: exp, securityCode: cvv } } }
  });

  const redir     = (a.authentication || {}).redirect || {};
  const html      = redir.html || '';
  const creqMatch = html.match(/name="creq"\s+value="([^"]+)"/);
  const actMatch  = html.match(/action="([^"]+)"/);

  console.log('result:', a.result, '| payerInteraction:', a.authentication && a.authentication.payerInteraction);
  if (!creqMatch) { console.log('No creq found in HTML. Auth result:', JSON.stringify(a, null, 2).slice(0, 800)); return; }

  const creq   = creqMatch[1];
  const action = actMatch && actMatch[1];
  console.log('ACS action URL:', action);
  console.log('creq decoded:', Buffer.from(creq, 'base64').toString('utf8'));

  console.log('\n=== STEP 3: POST CReq to Cardinal ===');
  const u    = new URL(action);
  const body = 'creq=' + encodeURIComponent(creq);
  const resp = await httpPost(u.hostname, u.pathname + u.search, body);

  console.log('Cardinal HTTP status:', resp.status);
  console.log('Location (redirect):', resp.headers.location || '(none)');
  console.log('Content-Type:', resp.headers['content-type'] || '(none)');
  console.log('Body length:', resp.body.length);
  console.log('Body (first 800 chars):\n', resp.body.slice(0, 800));
})();
