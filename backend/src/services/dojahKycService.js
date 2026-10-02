'use strict';
/**
 * Dojah KYC / Identity Verification client.
 *
 * A SELECTABLE alternative to youverifyService / interswitchKycService — NOT
 * wired into kycOrchestrator.js yet (that's a separate decision: which
 * provider fires on onboarding submit). Returns the SAME normalise() shape
 * as the other two so it drops straight into the per-requirement PASS/FAIL
 * framework (documents.js / matchAgainstForm) whenever it's selected.
 *
 * Auth: two plain headers on every request — NO OAuth, no Bearer prefix.
 *   Authorization: <secret key>   (raw — prefixing "Bearer" causes 401)
 *   AppId:         <App ID from Developers > Configuration>
 *
 * Base URL: sandbox.dojah.io (test keys) / api.dojah.io (live keys).
 *
 * Config (env):
 *   DOJAH_APP_ID       — App ID (dashboard: Developers > Configuration)
 *   DOJAH_PUBLIC_KEY   — public key (frontend widgets only, not used here)
 *   DOJAH_SECRET_KEY   — private/secret key — sent in Authorization header
 *   DOJAH_BASE_URL     — override base URL (default sandbox)
 *   DOJAH_ENV          — 'sandbox' | 'live' (default 'sandbox'; picks base URL
 *                        when DOJAH_BASE_URL is not set)
 */
const https = require('https');
let logger = { info() {}, error() {}, warn() {} };
try { logger = require('../utils/logger').logger || logger; } catch (e) {}

const APP_ID     = process.env.DOJAH_APP_ID || '';
const SECRET_KEY = process.env.DOJAH_SECRET_KEY || '';
const ENV        = process.env.DOJAH_ENV || 'sandbox';
const BASE_URL   = process.env.DOJAH_BASE_URL || (ENV === 'live' ? 'https://api.dojah.io' : 'https://sandbox.dojah.io');

function isConfigured() {
  return !!(APP_ID && SECRET_KEY);
}

function httpRequest(method, fullUrl, body) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      const e = new Error('Dojah KYC not configured (DOJAH_APP_ID / DOJAH_SECRET_KEY)');
      e.code = 'DOJAH_NO_CREDENTIALS';
      return reject(e);
    }
    const url     = new URL(fullUrl);
    const payload = body == null ? null : JSON.stringify(body);
    const opts = {
      hostname: url.hostname,
      port:     443,
      path:     url.pathname + url.search,
      method,
      family:   4, // force IPv4 — Dojah's IP whitelist is v4-only; DNS round-robin
                   // intermittently returns an unwhitelisted AAAA record otherwise
      headers: Object.assign(
        {
          Accept:          'application/json',
          Authorization:   SECRET_KEY, // raw — NOT "Bearer <key>"
          AppId:           APP_ID,
        },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      ),
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

function qs(params) {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  const str = s.toString();
  return str ? `?${str}` : '';
}

// ── Identity: BVN / NIN ──────────────────────────────────────────────────────
async function verifyBvn(bvn) {
  const res = await httpRequest('GET', `${BASE_URL}/api/v1/kyc/bvn/full${qs({ bvn })}`);
  return normalise(res, 'bvn');
}

async function verifyNin(nin) {
  const res = await httpRequest('GET', `${BASE_URL}/api/v1/kyc/nin${qs({ nin })}`);
  return normalise(res, 'nin');
}

// ── Business (CAC) ────────────────────────────────────────────────────────────
// companyType: BUSINESS_NAME | COMPANY | INCORPORATED_TRUSTEES |
//              LIMITED_PARTNERSHIP | LIMITED_LIABILITY_PARTNERSHIP
async function verifyCac(rcNumber, companyType = 'COMPANY') {
  const res = await httpRequest('GET', `${BASE_URL}/api/v1/kyc/cac/basic${qs({ rc_number: rcNumber, company_type: companyType })}`);
  return normalise(res, 'cac');
}

// ── Address (async — submit then poll) ───────────────────────────────────────
async function submitAddress({ firstName, lastName, middleName, mobile, street, lga, state, dob, gender, landmark }) {
  const res = await httpRequest('POST', `${BASE_URL}/api/v1/kyc/address`, {
    first_name: firstName, last_name: lastName, middle_name: middleName,
    mobile, street, lga, state, dob, gender, landmark,
  });
  return normalise(res, 'address');
}

async function getAddressResult(referenceId) {
  const res = await httpRequest('GET', `${BASE_URL}/api/v1/kyc/address${qs({ reference_id: referenceId })}`);
  return normalise(res, 'address');
}

// ── AML / watchlist / PEP / sanctions screening ──────────────────────────────
// schema: 'individual' | 'organization'. screeningOptions defaults to running
// all three checks (PEP, sanctions, adverse media) since that's the normal
// compliance requirement — pass explicit false to skip one.
async function screenAml({
  schema = 'individual',
  names,
  dateOfBirth,
  nationality,
  gender,
  pepCheck = true,
  sanction = true,
  adverseMediaCheck = true,
  matchThreshold,
  uniqueReference,
} = {}) {
  const body = {
    schema,
    properties: {
      names,
      date_of_birth: dateOfBirth,
      nationality,
      gender,
    },
    screening_options: {
      pep_check: pepCheck,
      sanction,
      adverse_media_check: adverseMediaCheck,
      ...(matchThreshold != null ? { match_threshold: matchThreshold } : {}),
    },
    ...(uniqueReference ? { unique_reference: uniqueReference } : {}),
  };
  const res = await httpRequest('POST', `${BASE_URL}/api/v1/aml/v2/screening`, body);
  return normaliseAml(res);
}

function normaliseAml(res) {
  const b = res.data || {};
  const e = b.entity || {};
  const ok = res.status >= 200 && res.status < 300 && !!b.entity;
  return {
    success:    ok,
    requestId:  e.entity_id || null,
    matchStatus: e.match_status || null, // e.g. "Confirmed Match" | "No Match"
    riskLevel:  e.risk_level || null,    // e.g. "Low" | "Medium" | "High"
    totalResults: e.total_results || 0,
    // Dojah returns `results` as a single object when there's one hit, an
    // array when there are several — normalise to always be an array.
    results:    Array.isArray(e.results) ? e.results : (e.results ? [e.results] : []),
    message:    b.error || b.message || (res.status >= 400 ? `HTTP ${res.status}` : ''),
    raw:        b,
    type:       'aml',
  };
}

/**
 * Map a Dojah response to the common verification shape used by the KYC
 * framework (same shape as interswitchKycService.normalise / youverifyService).
 * Success = HTTP 2xx with an `entity` payload (Dojah has no responseCode field —
 * a non-2xx status or missing `entity` means the lookup failed/no-match).
 */
function normalise(res, type) {
  const b  = res.data || {};
  const e  = b.entity || {};
  const ok = res.status >= 200 && res.status < 300 && !!b.entity;
  return {
    success:   ok,
    requestId: e.reference_id || null,
    status:    ok ? (e.status || 'VERIFIED') : (e.status || 'NOT_VERIFIED'),
    message:   b.error || b.message || (res.status >= 400 ? `HTTP ${res.status}` : ''),
    data: {
      firstName:      e.first_name,
      lastName:       e.last_name,
      middleName:     e.middle_name,
      birthDate:      e.date_of_birth || e.dob,
      gender:         e.gender,
      phone:          e.phone_number1 || e.phone_number || e.mobile,
      identityNumber: e.bvn || e.nin,
      companyName:    e.company_name,
      rcNumber:       e.rc_number,
    },
    raw:  b,
    type,
  };
}

module.exports = {
  isConfigured,
  verifyBvn,
  verifyNin,
  verifyCac,
  submitAddress,
  getAddressResult,
  screenAml,
};
