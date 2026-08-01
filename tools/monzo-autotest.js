'use strict';
require('dotenv').config({ path: '/opt/paylode-api/backend/.env' });
const https      = require('https');
const nodemailer = require('/opt/paylode-api/backend/node_modules/nodemailer');

const GW_MID  = 'PSLPBL1';
const GW_PASS = '4U5GicAL6MPIveHNNfW8Qz4uHs2Y3iRP';
const HOST    = 'api.paylodeservices.com';
const auth    = 'Basic ' + Buffer.from('merchant.' + GW_MID + ':' + GW_PASS).toString('base64');

const CARD = { number: '5355221318802321', month: '06', year: '29', cvv: '412', name: 'Samuel Akinboro' };
const CURRENCY = 'USD';
const AMOUNT   = '1.00';

function mpgsReq(orderId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      apiOperation: 'PAY',
      order: { amount: AMOUNT, currency: CURRENCY, description: 'Monzo 3DS auto-test' },
      sourceOfFunds: { type: 'CARD', provided: { card: {
        number: CARD.number, expiry: { month: CARD.month, year: CARD.year },
        securityCode: CARD.cvv, nameOnCard: CARD.name,
      }}},
      transaction: { reference: 'MONZO-AUTO-' + Date.now() },
      customer: { email: 'akinboroo@gmail.com', firstName: 'Samuel', lastName: 'Akinboro' },
    });
    const options = {
      hostname: HOST,
      path: '/api/rest/version/77/merchant/' + GW_MID + '/order/' + orderId + '/transaction/1',
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const r = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: { _raw: d } }); }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: parseInt(process.env.SMTP_PORT) === 465,
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

(async () => {
  const orderId = 'MONZO-' + CARD.number.slice(-4) + '-' + Date.now();
  console.log('[monzo-autotest] started — order:', orderId);

  let subject, html;
  try {
    const { status, body: b } = await mpgsReq(orderId);
    console.log('[monzo-autotest] HTTP', status, 'result:', b.result);

    if (b.result === 'PENDING_AUTHENTICATION') {
      const challengeUrl = b.authentication && (b.authentication.challengeUrl || b.authentication.redirectUrl) || '(none)';
      const ref          = b['paylode.reference'] || orderId;
      subject = 'Paylode Card Payment — Action Required';
      html = [
        '<div style="font-family:Arial,sans-serif;max-width:600px;color:#1e293b">',
        '<div style="background:#1a2744;padding:16px 24px;border-radius:8px 8px 0 0">',
        '<p style="color:#fff;font-size:15px;font-weight:bold;margin:0">Paylode — Card Verification</p>',
        '</div>',
        '<div style="padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">',
        '<p>Please click the link below to verify your card payment of <strong>USD 1.00</strong>:</p>',
        '<p><a href="' + challengeUrl + '" style="display:inline-block;background:#1a2744;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">Verify Payment</a></p>',
        '<p style="color:#64748b;font-size:12px">Or copy this URL into your browser:<br>' + challengeUrl + '</p>',
        '<p style="color:#dc2626;font-size:12px">This link expires in a few minutes.</p>',
        '<p style="color:#94a3b8;font-size:11px">Ref: ' + ref + '</p>',
        '</div></div>',
      ].join('');
    } else if (b.result === 'SUCCESS') {
      subject = '[Paylode] Monzo PAY Approved (frictionless)';
      html = '<p>Frictionless 3DS — payment approved without challenge.</p><pre>' + JSON.stringify(b, null, 2) + '</pre>';
    } else {
      subject = '[Paylode] Monzo 3DS Test — ' + (b.result || 'UNKNOWN');
      html = '<p>Result: ' + (b.result || 'UNKNOWN') + ' / ' + (b.response && b.response.gatewayCode || '') + '</p>'
           + '<pre>' + JSON.stringify(b, null, 2) + '</pre>';
    }
  } catch (err) {
    subject = '[Paylode] Monzo 3DS Auto-test Error';
    html = '<p>Error: ' + err.message + '</p>';
  }

  try {
    await transporter.sendMail({
      from: '"Paylode Services" <' + (process.env.EMAIL_FROM || 'product@paylodeservices.com') + '>',
      to:  'akinboroo@gmail.com',
      cc:  'akinborogoke@gmail.com',
      subject,
      html,
    });
    console.log('[monzo-autotest] email sent to akinboroo@gmail.com, cc akinborogoke@gmail.com');
  } catch (e) {
    console.error('[monzo-autotest] email failed:', e.message);
  }
  process.exit(0);
})();
