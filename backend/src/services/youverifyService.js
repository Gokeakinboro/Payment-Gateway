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
 * businessType drives the prefix applied to bare numeric RC numbers:
 *   Limited Company / LLC / Ltd           → RC
 *   Business Name / Sole Proprietorship /
 *     Partnership                         → BN
 *   Incorporated Trustee / NGO            → IT
 *   Limited Partnership                   → LP
 *   Limited Liability Partnership         → LLP
 * If rcNumber already carries a valid prefix it is used as-is.
 */
async function verifyCac(rcNumber, businessName, businessType) {
  const KNOWN_PREFIXES = ['LLP', 'LP', 'BN', 'IT', 'RC']; // longest-first for startsWith
  const clean = String(rcNumber || '').trim().toUpperCase();

  let prefixed;
  if (KNOWN_PREFIXES.some((p) => clean.startsWith(p))) {
    // RC number already has a recognised prefix — use as-is
    prefixed = clean;
  } else {
    // Derive prefix from businessType
    const type = String(businessType || '').toLowerCase();
    let prefix = 'RC'; // default for limited companies
    if (/sole.prop|business.name|partnership|bn/i.test(type)) prefix = 'BN';
    else if (/trustee|incorporated.trustee|ngo|it\b/i.test(type))  prefix = 'IT';
    else if (/limited.liability.partnership|llp/i.test(type))       prefix = 'LLP';
    else if (/limited.partnership|\blp\b/i.test(type))              prefix = 'LP';
    prefixed = `${prefix}${clean}`;
  }

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

  // AML checks return status 'cleared' | 'not_cleared' and hit arrays.
  // A 'not_cleared' with only low-accuracy fuzzy hits (< 0.70) is treated as PASS —
  // only confirmed high-accuracy hits are genuine flags.
  let amlSuccess = body?.success === true;
  if (type === 'aml' && amlSuccess) {
    const hasHighAccuracyHit = ['sanctions', 'pep', 'crime', 'debarment'].some((cat) =>
      Array.isArray(d[cat]) && d[cat].some((h) => Number(h.accuracy || 0) >= 0.70));
    amlSuccess = !hasHighAccuracyHit; // true = PASS (no confirmed hits)
  }

  return {
    success:            amlSuccess,
    requestId:          d.requestId || d.id || body?.requestId || null,
    status:             d.status || (body?.success ? 'found' : 'not_found'),
    message:            body?.message || '',
    raw:                body,
    type,
    // Embedded screening fields alongside BVN/NIN identity checks.
    watchListed:        d.watchListed || null,
    amlReport:          d.amlReport   || null,
    adverseMediaReport: d.adverseMediaReport || null,
    entityId:           d.entityId    || null,
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
