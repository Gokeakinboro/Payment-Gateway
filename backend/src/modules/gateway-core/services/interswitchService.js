'use strict';
const https  = require('https');
const { logger } = require('../../../utils/logger');

const IS_PROD    = process.env.NODE_ENV === 'production';
const ISW_BASE   = IS_PROD
  ? 'https://webpay.interswitchng.com'
  : 'https://sandbox.interswitchng.com';
const ISW_PASS   = IS_PROD
  ? 'https://passport.interswitchng.com'
  : 'https://sandbox.interswitchng.com';

// ── OAuth token cache (reused until 60s before expiry) ─────────────────────────
let _cache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (_cache.token && Date.now() < _cache.expiresAt) return _cache.token;

  const creds = Buffer.from(
    process.env.ISW_CLIENT_ID + ':' + process.env.ISW_CLIENT_SECRET
  ).toString('base64');

  const resp = await _request('POST', ISW_PASS + '/passport/oauth/token', {
    'Authorization': 'Basic ' + creds,
    'Content-Type':  'application/x-www-form-urlencoded',
  }, 'grant_type=client_credentials');

  if (!resp.access_token) throw new Error('Interswitch token request failed: ' + JSON.stringify(resp));

  _cache = {
    token:     resp.access_token,
    expiresAt: Date.now() + ((resp.expires_in || 3600) - 60) * 1000,
  };
  logger.info('Interswitch: access token refreshed');
  return _cache.token;
}

// ── Initialize card purchase ────────────────────────────────────────────────────
async function initializePurchase({ reference, amount, customerEmail, pan, expiry, cvv, pin, redirectUrl }) {
  const token = await getAccessToken();

  // Normalise expiry → 4-digit MMYY
  const exp = expiry.replace(/\D/g, '');
  const formattedExpiry = exp.length === 4 ? exp : exp.slice(0,2) + exp.slice(-2);

  const body = {
    customerId:           customerEmail,
    amount,                           // kobo
    merchantCode:         process.env.ISW_MERCHANT_CODE,
    payableCode:          process.env.ISW_PAYABLE_CODE,
    redirectUrl,
    transactionReference: reference,
    currencyCode:         '566',      // NGN ISO 4217 numeric
    cardData: {
      pan:        pan.replace(/\D/g, ''),
      expiryDate: formattedExpiry,
      cvv,
      pin,
    },
  };

  return _request('POST', ISW_BASE + '/api/v2/purchases', {
    'Authorization': 'Bearer ' + token,
    'Content-Type':  'application/json',
  }, JSON.stringify(body));
}

// ── Submit OTP (for 3DS / issuer OTP challenge) ────────────────────────────────
async function submitOtp({ reference, otp }) {
  const token = await getAccessToken();
  return _request('POST', ISW_BASE + '/api/v2/otp/auths', {
    'Authorization': 'Bearer ' + token,
    'Content-Type':  'application/json',
  }, JSON.stringify({ transactionRef: reference, otp }));
}

// ── Verify transaction status ───────────────────────────────────────────────────
async function verifyTransaction(reference) {
  const token = await getAccessToken();
  return _request('GET', ISW_BASE + '/api/v2/purchases/' + encodeURIComponent(reference), {
    'Authorization': 'Bearer ' + token,
  });
}

// ── Low-level HTTPS helper ──────────────────────────────────────────────────────
function _request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port:     443,
      path:     u.pathname + u.search,
      method,
      headers:  { Accept: 'application/json', ...headers },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('ISW parse error: ' + raw.slice(0,200))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { getAccessToken, initializePurchase, submitOtp, verifyTransaction };
