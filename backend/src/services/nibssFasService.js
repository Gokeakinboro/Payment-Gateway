'use strict';
/**
 * NIBSS FAS — Financial Authentication Service (identity verification).
 *
 * FAS is a SEPARATE NIBSS PRODUCT from the National Payment Stack (NPS): its own
 * commercial agreement, its own technical documentation, and its own credentials.
 * It is therefore a fully self-contained client — own env prefix (NIBSS_FAS_*),
 * own OAuth token cache, own signing — and imports nothing from nibssNpsService.
 * This mirrors how the Parallex products are structured (parallexService for VA vs
 * parallexTransferService for payouts: separate config, separate transport, no
 * cross-imports), which is the architecture we already run in production.
 *
 * Because credentials MAY turn out to be shared across the two NIBSS products,
 * every FAS setting falls back to its NPS equivalent when unset — so a single
 * credential set works without code changes, and separate ones work by setting
 * the NIBSS_FAS_* vars.
 *
 * Returns the SAME normalise() shape as interswitchKycService / youverifyService,
 * so it plugs into the per-requirement PASS/FAIL framework (documents.js
 * matchAgainstForm, kycOrchestrator runCheck) with no framework change.
 *
 * ⚠️  NOT WIRED INTO THE LIVE KYC PATH. documents.js / kyc.js / kycOrchestrator
 * still import youverifyService. Switching providers is a commercial decision
 * (per-check pricing vs YouVerify/Dojah — see config/serviceProviders.js) AND is
 * gated on the FAS agreement being executed.
 *
 * ⚠️  Endpoint paths are UNCONFIRMED — the FAS documentation
 * (devportal.nibss-plc.com.ng/api-docs/...) is IP-allowlisted and not reachable
 * until our IP Form clears. Every path is env-overridable (NIBSS_FAS_*_PATH) so
 * the first sandbox run can correct them without a code change, and response
 * parsing is tolerant of both nested and flattened shapes.
 *
 * SCOPE: FAS is confirmed by NIBSS to cover **BVN and NIN**. Whether RC and TIN
 * sit under FAS or under NPS's own KYC surface is NOT yet confirmed — verifyRc /
 * verifyTin are provided against FAS and must be re-pointed if NIBSS says
 * otherwise. FAS does NOT cover facial liveness, PEP, sanctions or adverse media;
 * those stay with the incumbent provider regardless.
 *
 * Config (env; each falls back to its NIBSS_NPS_* equivalent):
 *   NIBSS_FAS_BASE_URL / NIBSS_FAS_AUTH_URL
 *   NIBSS_FAS_CLIENT_ID / NIBSS_FAS_CLIENT_SECRET
 *   NIBSS_FAS_PRIVATE_KEY      our RSA key — signs requests
 *   NIBSS_FAS_ORGANISATION_CODE / NIBSS_FAS_INSTITUTION_CODE
 *   NIBSS_FAS_TIMEOUT_MS       default 30000
 */
const crypto = require('crypto');

const BASE_URL    = (process.env.NIBSS_FAS_BASE_URL || process.env.NIBSS_NPS_BASE_URL || 'https://apitest.nibss-plc.com.ng').replace(/\/$/, '');
const AUTH_URL    = (process.env.NIBSS_FAS_AUTH_URL || BASE_URL).replace(/\/$/, '');
const CLIENT_ID   = process.env.NIBSS_FAS_CLIENT_ID     || process.env.NIBSS_NPS_CLIENT_ID     || '';
const CLIENT_SEC  = process.env.NIBSS_FAS_CLIENT_SECRET || process.env.NIBSS_NPS_CLIENT_SECRET || '';
const PRIVATE_KEY = process.env.NIBSS_FAS_PRIVATE_KEY   || process.env.NIBSS_NPS_PRIVATE_KEY   || '';
const ORG_CODE    = process.env.NIBSS_FAS_ORGANISATION_CODE || process.env.NIBSS_FAS_INSTITUTION_CODE || process.env.NIBSS_NPS_INSTITUTION_CODE || '';
const TIMEOUT_MS  = Number(process.env.NIBSS_FAS_TIMEOUT_MS || 30000);

const PATHS = {
  token: process.env.NIBSS_FAS_TOKEN_PATH || '/oauth2/token',
  bvn:   process.env.NIBSS_FAS_BVN_PATH   || '/fas/api/v1/verify/bvn',
  nin:   process.env.NIBSS_FAS_NIN_PATH   || '/fas/api/v1/verify/nin',
  rc:    process.env.NIBSS_FAS_RC_PATH    || '/fas/api/v1/verify/rc',
  tin:   process.env.NIBSS_FAS_TIN_PATH   || '/fas/api/v1/verify/tin',
};

function isConfigured() { return !!(CLIENT_ID && PRIVATE_KEY); }

// ── crypto ───────────────────────────────────────────────────────────────────
function toPem(key, label) {
  if (!key) return key;
  if (key.includes('-----BEGIN')) return key;
  const body = key.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
// Detached RSA-SHA256 over the exact request bytes, same scheme as the NPS rail.
function signBody(json) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(json, 'utf8');
  return s.sign(toPem(PRIVATE_KEY, 'PRIVATE KEY'), 'base64');
}

// ── OAuth2 token (cached until 60s before expiry) ────────────────────────────
let _token = null;
async function getAccessToken() {
  if (_token && Date.now() < _token.expiresAt) return _token.value;
  if (!isConfigured()) throw new Error('NIBSS FAS not configured — set NIBSS_FAS_CLIENT_ID and NIBSS_FAS_PRIVATE_KEY');
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SEC}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(AUTH_URL + PATHS.token, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Basic ' + basic,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=fas',
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error('FAS token request failed (HTTP ' + res.status + '): ' + JSON.stringify(data).slice(0, 300));
  _token = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 - 60000 };
  return data.access_token;
}
function resetToken() { _token = null; }   // test seam + 401 retry

// Signed POST. Never throws on a non-2xx — callers classify from the body so an
// outage is reported as such rather than surfacing as a verification FAILURE.
async function call(path, body = {}, { retryOn401 = true } = {}) {
  const token = await getAccessToken();
  const json = JSON.stringify(body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        Signature: signBody(json),
        'X-Request-Id': crypto.randomBytes(16).toString('hex'),
        'X-Organisation-Code': ORG_CODE,
      },
      body: json,
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (res.status === 401 && retryOn401) { resetToken(); return call(path, body, { retryOn401: false }); }
  const parsed = await res.json().catch(() => null);
  if (parsed == null) return { httpStatus: res.status, _parseError: true, message: 'Non-JSON response (HTTP ' + res.status + ')' };
  parsed.httpStatus = res.status;
  return parsed;
}

function callFailed(r) { return !!(r && (r._parseError || (r.httpStatus && r.httpStatus >= 400))); }

// Tolerant field reader — accepts nested or flattened response shapes.
function firstOf(v) { return Array.isArray(v) ? v[0] : v; }
function dig(obj, ...paths) {
  for (const p of paths) {
    let cur = obj, okPath = true;
    for (const seg of p.split('.')) {
      cur = firstOf(cur);
      if (cur == null || typeof cur !== 'object' || !(seg in cur)) { okPath = false; break; }
      cur = cur[seg];
    }
    const val = firstOf(cur);
    if (okPath && val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
}

/**
 * Map a FAS response to the common verification shape.
 * A transport failure is reported as success:false WITH the reason surfaced —
 * never as a silent FAIL, so the framework can tell a genuine identity mismatch
 * apart from a NIBSS outage.
 */
function normalise(res, type) {
  const r = res || {};
  const failed = callFailed(r);
  const verified = dig(r, 'data.verified', 'verified', 'isVerified');
  const status = dig(r, 'data.status', 'status', 'verificationStatus');
  const code = dig(r, 'data.responseCode', 'responseCode', 'code');
  const ok = !failed && (verified === true || String(code) === '00' || /verified|success|match/i.test(String(status || '')));
  return {
    success: ok,
    requestId: dig(r, 'data.reference', 'reference', 'data.requestId', 'requestId', 'transactionId') || null,
    status: status || (ok ? 'VERIFIED' : 'NOT_VERIFIED'),
    message: dig(r, 'data.message', 'message', 'responseMessage', 'error.message') ||
      (failed ? 'NIBSS FAS request failed' : ''),
    data: {
      firstName:      dig(r, 'data.firstName', 'firstName', 'data.firstname'),
      lastName:       dig(r, 'data.lastName', 'lastName', 'data.surname'),
      middleName:     dig(r, 'data.middleName', 'middleName'),
      birthDate:      dig(r, 'data.dateOfBirth', 'dateOfBirth', 'data.birthDate'),
      gender:         dig(r, 'data.gender', 'gender'),
      phone:          dig(r, 'data.phoneNumber', 'phoneNumber', 'data.phone'),
      identityNumber: dig(r, 'data.bvn', 'bvn', 'data.nin', 'nin', 'data.identityNumber', 'identityNumber'),
      companyName:    dig(r, 'data.companyName', 'companyName', 'data.businessName'),
      rcNumber:       dig(r, 'data.rcNumber', 'rcNumber', 'data.registrationNumber'),
      tin:            dig(r, 'data.tin', 'tin', 'data.taxIdentificationNumber'),
      address:        dig(r, 'data.address', 'address', 'data.residentialAddress'),
      watchlisted:    dig(r, 'data.watchListed', 'watchListed', 'data.watchlisted'),
    },
    raw: r,
    type,
  };
}

// Optional name/DOB are sent so FAS can match server-side; the framework still
// runs its OWN match on the returned fields and flags exceptions.
function identityBody(idField, idValue, fields) {
  return {
    [idField]: String(idValue || '').trim(),
    ...(fields.firstName && { firstName: fields.firstName }),
    ...(fields.lastName  && { lastName:  fields.lastName  }),
    ...(fields.birthDate && { dateOfBirth: fields.birthDate }),   // yyyy-MM-dd
    ...(fields.phone     && { phoneNumber: fields.phone     }),
  };
}

// ── confirmed FAS validations ────────────────────────────────────────────────
async function verifyBvn(bvn, fields = {}) {
  return normalise(await call(PATHS.bvn, identityBody('bvn', bvn, fields)), 'bvn');
}
async function verifyNin(nin, fields = {}) {
  return normalise(await call(PATHS.nin, identityBody('nin', nin, fields)), 'nin');
}

// ── NOT yet confirmed as FAS (may sit under NPS) — re-point if NIBSS says so ──
async function verifyRc(rcNumber, businessName, businessType) {
  return normalise(await call(PATHS.rc, {
    rcNumber: String(rcNumber || '').trim(),
    ...(businessName && { businessName }),
    ...(businessType && { businessType }),
  }), 'cac');
}
async function verifyTin(tin, businessName) {
  return normalise(await call(PATHS.tin, {
    tin: String(tin || '').trim(),
    ...(businessName && { businessName }),
  }), 'tin');
}

module.exports = {
  isConfigured, call, getAccessToken, resetToken, normalise, dig, callFailed,
  signBody, toPem, BASE_URL, PATHS,
  // verifyCac alias keeps the existing KYC call sites rename-free on a provider swap
  verifyBvn, verifyNin, verifyRc, verifyCac: verifyRc, verifyTin,
};
