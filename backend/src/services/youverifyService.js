'use strict';
const https  = require('https');
const crypto = require('crypto');

const BASE_URL    = process.env.YOUVERIFY_BASE_URL || 'https://api.sandbox.youverify.co/v2';
const API_KEY     = process.env.YOUVERIFY_API_KEY;
const WEBHOOK_KEY = process.env.YOUVERIFY_WEBHOOK_SECRET;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url     = new URL(BASE_URL + path);
    const options = {
      hostname: url.hostname,
      port:     443,
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':  'application/json',
        'token':         API_KEY,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data: { success: false, message: data } });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Verify BVN against YouVerify.
 * Returns { success, requestId, status, data }
 */
// NOTE: YouVerify's ID endpoints REJECT firstname/lastname in the request
// ("ValidationError: firstname is not allowed"). The lookup is by ID only; the
// endpoint RETURNS the registered name/DOB, which the caller matches locally.
async function verifyBvn(bvn /*, firstName, lastName, dob — matched on our side */) {
  const res = await request('POST', '/api/identity/ng/bvn', { id: bvn, isSubjectConsent: true });
  return normalise(res, 'bvn');
}

/**
 * Verify NIN against YouVerify (ID-only; name matched on our side).
 */
async function verifyNin(nin) {
  const res = await request('POST', '/api/identity/ng/nin', { id: nin, isSubjectConsent: true });
  return normalise(res, 'nin');
}

/**
 * Verify CAC registration number against YouVerify.
 * registrationNumber must include prefix: RC (Ltd), BN (business name), IT (incorporated trustee),
 * LP (limited partnership), LLP (limited liability partnership). No space between prefix and number.
 * e.g. RC1234567, BN1234567
 */
async function verifyCac(rcNumber, businessName) {
  // Ensure RC prefix — add if not already prefixed
  const prefixes = ['RC', 'BN', 'IT', 'LP', 'LLP'];
  const clean = String(rcNumber || '').trim().toUpperCase();
  const prefixed = prefixes.some((p) => clean.startsWith(p)) ? clean : `RC${clean}`;
  const res = await request('POST', '/api/verifications/ng/company/basic', {
    registrationNumber: prefixed, isConsent: true,
  });
  return normalise(res, 'cac');
}

/**
 * PEP + Sanctions screening by name.
 * Covers both PEP and sanctions in a single call — type: 'individual' or 'business'.
 */
async function screenAml(fullName, type = 'individual') {
  const res = await request('POST', '/api/verifications/advanced/name/aml-checks', {
    query: fullName, isSubjectConsent: true, type,
  });
  return normalise(res, 'aml');
}

/**
 * Adverse media intelligence screening by name.
 */
async function screenAdverseMedia(fullName, type = 'individual') {
  const res = await request('POST', '/api/identity/adverse-media', {
    query: fullName, isSubjectConsent: true, type,
  });
  return normalise(res, 'adverse_media');
}

/**
 * Facial liveness + biometric verification.
 * Accepts a base64-encoded JPEG/PNG selfie image.
 * Endpoint confirmed on YouVerify activation — set YOUVERIFY_LIVENESS_PATH if different.
 */
async function verifyLiveness(base64Image) {
  const path = process.env.YOUVERIFY_LIVENESS_PATH || '/api/v2/faces/liveliness';
  const res = await request('POST', path, { image: base64Image, isSubjectConsent: true });
  return normalise(res, 'liveness');
}

function normalise(res, type) {
  const body = res.data;
  const d    = body?.data || {};
  return {
    success:            body?.success === true,
    requestId:          d.requestId || body?.requestId || null,
    status:             d.status || (body?.success ? 'found' : 'not_found'),
    message:            body?.message || '',
    raw:                body,
    type,
    // Embedded screening fields returned alongside BVN/NIN identity checks.
    watchListed:        d.watchListed || null,          // 'YES' | 'NO' | null
    amlReport:          d.amlReport   || null,           // object or null
    adverseMediaReport: d.adverseMediaReport || null,   // object or null
    entityId:           d.entityId    || null,
    // Returned subject details for name-match on our side.
    firstName:          d.firstName   || null,
    middleName:         d.middleName  || null,
    lastName:           d.lastName    || null,
    dateOfBirth:        d.dateOfBirth || null,
    mobile:             d.mobile      || null,
    address:            d.address     || null,
  };
}

/**
 * Verify an incoming YouVerify webhook signature.
 * YouVerify signs with HMAC-SHA512 using the webhook secret.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WEBHOOK_KEY || !signatureHeader) return false;
  const expected = crypto
    .createHmac('sha512', WEBHOOK_KEY)
    .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signatureHeader, 'hex')
  );
}

module.exports = { verifyBvn, verifyNin, verifyCac, screenAml, screenAdverseMedia, verifyLiveness, verifyWebhookSignature };
