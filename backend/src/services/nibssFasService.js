'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
// ─────────────────────────────────────────────────────────────────────────────
//  NIBSS Financial Authentication Service (FAS) — BVN + NIN identity validation.
//
//  All validation calls go to a single URL pattern:
//    POST /switch10/{subclass}/{retry}/{institutionCode}
//  The type of validation is determined by the request body (type: "bvn"|"nin"|...).
//
//  Subscription class 1 covers BVN + NIN (what Paylode needs).
//  Sandbox provides 10 free calls; after that calls are billed per validation.
//
//  BVN Core Validation requires a retrievalToken from NIBSS Consent Hub.
//  NIN Core Validation uses a ShareCode from the NIMC NINAUTH app.
//  Boolean variants return match flags only (no retrievalToken required).
//
//  Required env vars (NIBSS_FAS_*):
//    AUTH_URL          — defaults to sandbox token endpoint
//    BASE_URL          — defaults to sandbox FAS endpoint
//    CLIENT_ID         — OAuth2 client_id (FAS-specific, separate from EasyPay)
//    CLIENT_SECRET     — OAuth2 client_secret
//    INSTITUTION_CODE  — Paylode's 6-digit NIBSS institution code
//    SUBCLASS          — Subscription class (default: 1 = BVN + NIN)
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_URL        = (process.env.NIBSS_FAS_AUTH_URL   || 'https://apitest.nibss-plc.com.ng/v2/reset').replace(/\/$/, '');
const BASE_URL        = (process.env.NIBSS_FAS_BASE_URL   || 'https://apitest.nibss-plc.com.ng/cvs/v2').replace(/\/$/, '');
const CLIENT_ID       = process.env.NIBSS_FAS_CLIENT_ID      || '';
const CLIENT_SECRET   = process.env.NIBSS_FAS_CLIENT_SECRET  || '';
const INSTITUTION_CODE = process.env.NIBSS_FAS_INSTITUTION_CODE || process.env.NIBSS_EASYPAY_INSTITUTION_CODE || '';
const SUBCLASS        = process.env.NIBSS_FAS_SUBCLASS || '1';

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && INSTITUTION_CODE);
}

// ── Low-level HTTP (curl, VPN-safe) ──────────────────────────────────────────
async function httpsRequest(method, urlStr, headers, bodyStr, maxTime = 60) {
  const args = ['-s', '-w', '\n__STATUS__%{http_code}', '-X', method];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push('-H', 'Connection: close');
  if (bodyStr) args.push('-d', bodyStr);
  args.push('--connect-timeout', '10', '--max-time', String(maxTime), urlStr);

  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const { stdout } = await execFileAsync('curl', args, {
        timeout: (maxTime + 5) * 1000,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      const sep    = stdout.lastIndexOf('\n__STATUS__');
      const body   = sep >= 0 ? stdout.slice(0, sep) : stdout;
      const status = sep >= 0 ? parseInt(stdout.slice(sep + 11), 10) : 200;
      try   { return { status, json: JSON.parse(body) }; }
      catch { return { status, json: { responseCode: 'PARSE', message: `Non-JSON HTTP ${status}: ${body.slice(0, 300)}` } }; }
    } catch (e) {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
      return { status: 0, json: { responseCode: 'FETCH_FAILED', message: e.message } };
    }
  }
}

// ── Token cache ───────────────────────────────────────────────────────────────
let _token = null, _tokenExp = 0, _loginInflight = null;

async function doLogin() {
  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope:         `${CLIENT_ID}/.default`,
  });
  const { status, json: r } = await httpsRequest('POST', AUTH_URL, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept':       'application/json',
  }, params.toString(), 30);

  if (!r.access_token) {
    throw new Error(`NIBSS FAS auth failed: ${r.error || r.message || JSON.stringify(r)} (HTTP ${status})`);
  }
  _token    = r.access_token;
  _tokenExp = Date.now() + ((r.expires_in || 3600) - 120) * 1000;
  return _token;
}

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  if (!_loginInflight) _loginInflight = doLogin().finally(() => { _loginInflight = null; });
  return _loginInflight;
}

// ── FAS call ──────────────────────────────────────────────────────────────────
// retry: '1' for first attempt, '2' for retry
async function fasCall(body, retry = '1') {
  if (!isConfigured()) throw new Error('NIBSS FAS not configured — set NIBSS_FAS_* env vars');

  const url = `${BASE_URL}/switch10/${SUBCLASS}/${retry}/${INSTITUTION_CODE}`;

  const doReq = async (tok) => {
    return httpsRequest('POST', url, {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      Authorization:  `Bearer ${tok}`,
    }, JSON.stringify(body), 60);
  };

  let { status, json } = await doReq(await getToken());

  if (status === 401) {
    _token = null;
    ({ json } = await doReq(await getToken()));
  }

  return json;
}

// ── Normalise FAS response → kycOrchestrator-compatible shape ─────────────────
// Mirrors the shape that youverifyService returns: { success, requestId, raw }
function normalise(r, subjectId) {
  const code    = String(r?.responseCode ?? r?.code ?? '');
  const success = code === '00';
  const d       = r?.data || r || {};

  // Extract names from whatever field NIBSS returns them in
  const firstName  = d.firstName  || d.first_name  || '';
  const middleName = d.middleName || d.middle_name || '';
  const lastName   = d.lastName   || d.last_name   || d.surname || '';

  return {
    success,
    requestId:   r?.requestId || r?.id || subjectId || null,
    message:     r?.responseMessage || r?.message || (success ? 'Verification successful' : `FAS code ${code}`),
    raw:         r,
  };
}

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * BVN Core Validation — full KYC data return.
 * Requires retrievalToken from NIBSS Consent Hub (consent must be captured first).
 *
 * @param {string} bvn
 * @param {string} retrievalToken - from Consent Hub callback
 * @param {object} [fields] - optional: { firstName, lastName, dateOfBirth }
 */
async function verifyBvn(bvn, retrievalToken, fields = {}) {
  if (!retrievalToken) throw new Error('verifyBvn: retrievalToken is required (obtain via Consent Hub first)');
  const r = await fasCall({
    type:           'bvn',
    bvn:            String(bvn).trim(),
    retrievalToken: String(retrievalToken).trim(),
    ...(fields.firstName  ? { firstName:   fields.firstName  } : {}),
    ...(fields.lastName   ? { lastName:    fields.lastName   } : {}),
    ...(fields.dateOfBirth ? { dateOfBirth: fields.dateOfBirth } : {}),
  });
  return normalise(r, bvn);
}

/**
 * NIN Core Validation via ShareCode (customer generates 6-digit code in NIMC NINAUTH app).
 *
 * @param {string} nin
 * @param {string} shareCode - 6-digit code from NINAUTH app
 * @param {object} [fields] - optional: { firstName, lastName }
 */
async function verifyNinShareCode(nin, shareCode, fields = {}) {
  if (!shareCode) throw new Error('verifyNinShareCode: shareCode is required');
  const r = await fasCall({
    type:      'nin',
    nin:       String(nin).trim(),
    shareCode: String(shareCode).trim(),
    ...(fields.firstName ? { firstName: fields.firstName } : {}),
    ...(fields.lastName  ? { lastName:  fields.lastName  } : {}),
  });
  return normalise(r, nin);
}

/**
 * NIN Core Validation via live capture (agent-captured selfie, base64).
 *
 * @param {string} nin
 * @param {string} customerPhoto - base64-encoded JPEG selfie
 * @param {object} [fields] - optional: { firstName, lastName }
 */
async function verifyNinInPerson(nin, customerPhoto, fields = {}) {
  if (!customerPhoto) throw new Error('verifyNinInPerson: customerPhoto is required');
  const r = await fasCall({
    type:          'nin',
    nin:           String(nin).trim(),
    customerPhoto: customerPhoto,
    ...(fields.firstName ? { firstName: fields.firstName } : {}),
    ...(fields.lastName  ? { lastName:  fields.lastName  } : {}),
  });
  return normalise(r, nin);
}

/**
 * Boolean BVN Validation — returns match flags only (no retrievalToken needed).
 * Lower cost; use for re-validation or low-risk checks.
 *
 * @param {string} bvn
 * @param {object} fields - { firstName, lastName, dateOfBirth, phoneNumber }
 * @returns {{ success, matches: {firstName,lastName,dateOfBirth,phoneNumber}, raw }}
 */
async function booleanBvn(bvn, fields = {}) {
  const r = await fasCall({
    type:        'bvnBoolean',
    bvn:         String(bvn).trim(),
    ...(fields.firstName   ? { firstName:   fields.firstName   } : {}),
    ...(fields.lastName    ? { lastName:    fields.lastName    } : {}),
    ...(fields.dateOfBirth ? { dateOfBirth: fields.dateOfBirth } : {}),
    ...(fields.phoneNumber ? { phoneNumber: fields.phoneNumber } : {}),
  });
  const code = String(r?.responseCode ?? '');
  return {
    success:  code === '00',
    matches: {
      firstName:   r?.firstNameMatch,
      lastName:    r?.lastNameMatch,
      dateOfBirth: r?.dateOfBirthMatch,
      phoneNumber: r?.phoneNumberMatch,
    },
    message: r?.responseMessage || (code === '00' ? 'Boolean validation successful' : `FAS code ${code}`),
    raw: r,
  };
}

/**
 * Boolean NIN Validation — match flags only.
 *
 * @param {string} nin
 * @param {object} fields - { firstName, lastName, dateOfBirth }
 */
async function booleanNin(nin, fields = {}) {
  const r = await fasCall({
    type:        'ninBoolean',
    nin:         String(nin).trim(),
    ...(fields.firstName   ? { firstName:   fields.firstName   } : {}),
    ...(fields.lastName    ? { lastName:    fields.lastName    } : {}),
    ...(fields.dateOfBirth ? { dateOfBirth: fields.dateOfBirth } : {}),
  });
  const code = String(r?.responseCode ?? '');
  return {
    success: code === '00',
    matches: {
      firstName:   r?.firstNameMatch,
      lastName:    r?.lastNameMatch,
      dateOfBirth: r?.dateOfBirthMatch,
    },
    message: r?.responseMessage || (code === '00' ? 'Boolean validation successful' : `FAS code ${code}`),
    raw: r,
  };
}

module.exports = {
  isConfigured,
  verifyBvn,
  verifyNinShareCode,
  verifyNinInPerson,
  booleanBvn,
  booleanNin,
};
