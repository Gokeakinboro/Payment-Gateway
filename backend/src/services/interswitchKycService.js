'use strict';
/**
 * Interswitch KYC / Identity Verification client.
 *
 * Replaces the (abandoned) YouVerify integration. Returns the SAME normalise()
 * shape as youverifyService so it plugs straight into the per-requirement
 * PASS/FAIL verification framework (documents.js / matchAgainstForm).
 *
 * Separate from interswitchService.js (that file is the Interswitch CARD-PAYMENT
 * client). KYC lives on Interswitch's data-service (api-gateway) but shares the
 * same OAuth2 passport credentials from the Developer Console.
 *
 * Auth:  OAuth2 client-credentials. POST {AUTH_URL}/passport/oauth/token with
 *        Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET),
 *        Content-Type: application/x-www-form-urlencoded, grant_type=client_credentials.
 *
 * Identity (BVN/NIN):
 *        POST {BASE_URL}/isw-data-service/api/v1/request/verification
 *        Bearer token; body { validationType:'BVN'|'NIN', validationId, firstname,
 *        lastname, birthDate(yyyy-MM-dd), gender, phone }
 *        -> { responseCode:'00', responseMessage, data:{ status:'VERIFIED',
 *             identityNumber, firstName, lastName, birthDate, reference } }
 *
 * Business (CAC) and Address endpoints live under the same data-service; their
 * exact paths/payloads must be CONFIRMED in the Developer Console once the
 * data-service product is subscribed — marked TODO below.
 *
 * Config (env):
 *   ISW_KYC_CLIENT_ID / ISW_KYC_CLIENT_SECRET  (fall back to ISW_CLIENT_ID/SECRET)
 *   ISW_KYC_AUTH_URL   (default sandbox passport)
 *   ISW_KYC_BASE_URL   (default api-gateway)
 *   ISW_KYC_ENV        'test' | 'live'  (default 'test')
 */
const https = require('https');
let logger = { info() {}, error() {}, warn() {} };
try { logger = require('../utils/logger').logger || logger; } catch (e) {}

const CLIENT_ID     = process.env.ISW_KYC_CLIENT_ID     || process.env.ISW_CLIENT_ID;
const CLIENT_SECRET = process.env.ISW_KYC_CLIENT_SECRET || process.env.ISW_CLIENT_SECRET;
const AUTH_URL      = process.env.ISW_KYC_AUTH_URL || 'https://sandbox.interswitchng.com';
const BASE_URL      = process.env.ISW_KYC_BASE_URL || 'https://api-gateway.interswitchng.com';
const ENV           = process.env.ISW_KYC_ENV || 'test';

function httpRequest(method, fullUrl, headers, body, isForm) {
  return new Promise((resolve, reject) => {
    const url     = new URL(fullUrl);
    const payload = body == null ? null : (isForm ? body : JSON.stringify(body));
    const opts = {
      hostname: url.hostname,
      port:     443,
      path:     url.pathname + url.search,
      method,
      headers: Object.assign({ Accept: 'application/json' }, headers,
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── OAuth2 token (cached until 60s before expiry) ────────────────────────────
let _token = null;

async function getAccessToken() {
  if (_token && Date.now() < _token.expiresAt) return _token.value;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    const e = new Error('Interswitch KYC credentials not configured (ISW_KYC_CLIENT_ID / ISW_KYC_CLIENT_SECRET)');
    e.code = 'ISW_NO_CREDENTIALS';
    throw e;
  }
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await httpRequest('POST', `${AUTH_URL}/passport/oauth/token`,
    { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    'grant_type=client_credentials&scope=profile', true);
  const tok = res.data && res.data.access_token;
  if (!tok) {
    const e = new Error('Interswitch KYC token request failed: ' + JSON.stringify(res.data).slice(0, 300));
    e.code = 'ISW_AUTH_FAILED';
    throw e;
  }
  const ttl = Number(res.data.expires_in || 3600) * 1000;
  _token = { value: tok, expiresAt: Date.now() + ttl - 60000 };
  logger.info('Interswitch KYC: access token refreshed');
  return tok;
}

async function authed(path, body) {
  const token = await getAccessToken();
  return httpRequest('POST', `${BASE_URL}${path}`, {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'env':           ENV,
  }, body);
}

// ── Identity: BVN / NIN ──────────────────────────────────────────────────────
// Unlike YouVerify, Interswitch ACCEPTS the name/DOB and matches server-side,
// returning data.status === 'VERIFIED'. We still surface the returned fields so
// the framework can do its own NAME/DOB match and flag exceptions.
async function verifyIdentity(validationType, validationId, fields = {}) {
  const res = await authed('/isw-data-service/api/v1/request/verification', {
    validationType,
    validationId,
    ...(fields.firstName && { firstname: fields.firstName }),
    ...(fields.lastName  && { lastname:  fields.lastName  }),
    ...(fields.birthDate && { birthDate: fields.birthDate }), // yyyy-MM-dd
    ...(fields.gender    && { gender:    fields.gender    }),
    ...(fields.phone     && { phone:     fields.phone     }),
  });
  return normalise(res, validationType.toLowerCase());
}

function verifyBvn(bvn, fields = {}) { return verifyIdentity('BVN', bvn, fields); }
function verifyNin(nin, fields = {}) { return verifyIdentity('NIN', nin, fields); }

// ── Business (CAC) — TODO: confirm exact path/payload in Developer Console ─────
async function verifyCac(rcNumber, businessName) {
  const res = await authed('/isw-data-service/api/v1/request/business-verification', {
    rcNumber,
    ...(businessName && { businessName }),
  });
  return normalise(res, 'cac');
}

// ── Address — TODO: confirm exact path/payload in Developer Console ───────────
async function verifyAddress(payload) {
  const res = await authed('/isw-data-service/api/v1/request/address-verification', payload || {});
  return normalise(res, 'address');
}

/**
 * Map an Interswitch response to the common verification shape used by the KYC
 * framework. Success = responseCode '00' and/or data.status === 'VERIFIED'.
 */
function normalise(res, type) {
  const b = res.data || {};
  const d = b.data || {};
  const ok = (b.responseCode === '00') || /verified|success/i.test(d.status || '');
  return {
    success:   ok,
    requestId: d.reference || b.reference || null,
    status:    d.status || (ok ? 'VERIFIED' : 'NOT_VERIFIED'),
    message:   b.responseMessage || b.message || (res.status >= 400 ? `HTTP ${res.status}` : ''),
    data: {
      firstName:      d.firstName || d.firstname,
      lastName:       d.lastName  || d.lastname,
      middleName:     d.middleName,
      birthDate:      d.birthDate || d.dateOfBirth,
      gender:         d.gender,
      phone:          d.phone || d.phoneNumber,
      identityNumber: d.identityNumber,
      companyName:    d.companyName || d.businessName,
      rcNumber:       d.rcNumber || d.registrationNumber,
    },
    raw:  b,
    type,
  };
}

module.exports = {
  getAccessToken,
  verifyIdentity,
  verifyBvn,
  verifyNin,
  verifyCac,
  verifyAddress,
};
