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
async function verifyBvn(bvn, firstName, lastName, dob) {
  const res = await request('POST', '/id/bvn/verify', {
    id:               bvn,
    isSubjectConsent: true,
    ...(firstName && { firstname: firstName }),
    ...(lastName  && { lastname:  lastName  }),
    ...(dob       && { dob }),
  });
  return normalise(res, 'bvn');
}

/**
 * Verify NIN against YouVerify.
 */
async function verifyNin(nin, firstName, lastName) {
  const res = await request('POST', '/id/nin/verify', {
    id:               nin,
    isSubjectConsent: true,
    ...(firstName && { firstname: firstName }),
    ...(lastName  && { lastname:  lastName  }),
  });
  return normalise(res, 'nin');
}

/**
 * Verify CAC RC number against YouVerify.
 * businessType: 'limited_liability' | 'business_name' | 'incorporated_trustee'
 */
async function verifyCac(rcNumber, businessName, businessType = 'limited_liability') {
  const res = await request('POST', '/business/cac/verify', {
    id:           rcNumber,
    isSubjectConsent: true,
    ...(businessName && { businessName }),
    businessType,
  });
  return normalise(res, 'cac');
}

function normalise(res, type) {
  const body = res.data;
  return {
    success:   body?.success === true,
    requestId: body?.data?.requestId || body?.requestId || null,
    status:    body?.data?.status || (body?.success ? 'found' : 'not_found'),
    message:   body?.message || '',
    raw:       body,
    type,
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

module.exports = { verifyBvn, verifyNin, verifyCac, verifyWebhookSignature };
