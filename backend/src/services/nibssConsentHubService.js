'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
// ─────────────────────────────────────────────────────────────────────────────
//  NIBSS Consent Hub — BVN consent capture (required before FAS BVN Core).
//
//  Flow:
//    1. Call initiateConsent(bvn) → get { sessionId, consentUrl }
//    2. Redirect customer to consentUrl (NIBSS handles OTP auth + approval)
//    3. NIBSS POSTs retrievalToken to Paylode's registered callback URL
//       → handled by routes/nibss-consent-webhook.js
//    4. Pass retrievalToken to nibssFasService.verifyBvn()
//
//  Required env vars (NIBSS_CONSENT_HUB_*):
//    AUTH_URL      — defaults to sandbox token endpoint
//    BASE_URL      — defaults to sandbox consent endpoint
//    CLIENT_ID     — OAuth2 client_id (Consent Hub service, separate from FAS)
//    CLIENT_SECRET — OAuth2 client_secret
//    CALLBACK_URL  — Paylode's HTTPS endpoint that NIBSS POSTs the retrievalToken to
//                    e.g. https://api.paylodeservices.com/api/v1/webhooks/nibss/consent
//
//  NIBSS data controller ID is a fixed value assigned to NIBSS itself.
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_URL       = (process.env.NIBSS_CONSENT_HUB_AUTH_URL  || 'https://apitest.nibss-plc.com.ng/v2/reset').replace(/\/$/, '');
const BASE_URL       = (process.env.NIBSS_CONSENT_HUB_BASE_URL  || 'https://apitest.nibss-plc.com.ng/api').replace(/\/$/, '');
const CLIENT_ID      = process.env.NIBSS_CONSENT_HUB_CLIENT_ID      || '';
const CLIENT_SECRET  = process.env.NIBSS_CONSENT_HUB_CLIENT_SECRET  || '';
const CALLBACK_URL   = process.env.NIBSS_CONSENT_HUB_CALLBACK_URL   || '';

// NIBSS-issued data controller ID — identifies NIBSS as the data controller
const NIBSS_DATA_CONTROLLER_ID = process.env.NIBSS_DATA_CONTROLLER_ID || 'd6378b2e-092f-485a-a1f9-f97b3ca8c3f3';

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && CALLBACK_URL);
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
        maxBuffer: 2 * 1024 * 1024,
      });
      const sep    = stdout.lastIndexOf('\n__STATUS__');
      const body   = sep >= 0 ? stdout.slice(0, sep) : stdout;
      const status = sep >= 0 ? parseInt(stdout.slice(sep + 11), 10) : 200;
      try   { return { status, json: JSON.parse(body) }; }
      catch { return { status, json: { error: `Non-JSON HTTP ${status}`, raw: body.slice(0, 300) } }; }
    } catch (e) {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
      return { status: 0, json: { error: 'FETCH_FAILED', message: e.message } };
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
    throw new Error(`NIBSS Consent Hub auth failed: ${r.error || r.message || JSON.stringify(r)} (HTTP ${status})`);
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

async function apiCall(method, path, { body, maxTime = 60 } = {}) {
  if (!isConfigured()) throw new Error('NIBSS Consent Hub not configured — set NIBSS_CONSENT_HUB_* env vars');

  const url     = `${BASE_URL}${path}`;
  const bodyStr = body ? JSON.stringify(body) : undefined;

  const doReq = async (tok) => {
    const headers = {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      Authorization:  `Bearer ${tok}`,
    };
    return httpsRequest(method, url, headers, bodyStr, maxTime);
  };

  let { status, json } = await doReq(await getToken());

  if (status === 401) {
    _token = null;
    ({ json } = await doReq(await getToken()));
  }

  return json;
}

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * Start a BVN consent session. Redirect the customer to the returned consentUrl.
 * After authentication, NIBSS delivers the retrievalToken to CALLBACK_URL.
 *
 * @param {string} bvn - 11-digit customer BVN
 * @param {object} opts
 * @param {string} [opts.requestType='YYYY'] - data fields: Y=include, N=exclude (YYYY = all)
 * @param {boolean} [opts.dataSubjectPresent=true]
 * @returns {{ ok, sessionId, consentUrl, reason, raw }}
 */
async function initiateConsent(bvn, opts = {}) {
  const today = (() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();

  const r = await apiCall('POST', '/consent/initiate', {
    body: {
      dataControllerId:    NIBSS_DATA_CONTROLLER_ID,
      dataProcessorId:     CLIENT_ID,
      dataOwnerID:         String(bvn).trim(),
      requestType:         opts.requestType || 'YYYY',
      consentType:         'RedirectLink',
      dataSubjectPresent:  opts.dataSubjectPresent !== false,
      authenticationDate:  today,
      ...(CALLBACK_URL ? { callBackUrl: CALLBACK_URL } : {}),
    },
    maxTime: 30,
  });

  const ok = !!(r.sessionId && r.consentUrl);
  return {
    ok,
    sessionId:  r.sessionId  || null,
    consentUrl: r.consentUrl || null,
    reason:     ok ? 'Consent session initiated' : (r.message || r.error || JSON.stringify(r)),
    raw:        r,
  };
}

module.exports = { isConfigured, initiateConsent, getToken };
