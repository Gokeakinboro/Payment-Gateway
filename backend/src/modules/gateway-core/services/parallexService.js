'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Parallex Bank — Virtual Account (collections / pay-in) client.
//  Built from "VIRTUAL ACCOUNT DOCUMENTATION v2" (2026-07-07). DORMANT until env
//  is set — nothing here calls out unless isConfigured(). Testing is blocked on
//  (a) the APIM subscription key (issued in the dev portal) and (b) the VA Login
//  account being unlocked + the portal account activated.
//
//  Auth = TWO layers + a merchant header:
//   1. <SUBKEY_HEADER>: <subkey>     APIM product subscription (the doc's "Pass Key";
//                                    respCode 49 if missing). Default header name
//                                    Ocp-Apim-Subscription-Key (env-overridable).
//   2. Authorization: Bearer <token> app JWT from POST /Login (30-min TTL, cached +
//                                    auto-refreshed here). Password is BASE64 on /Login.
//   3. MerchantId: <merchantId>      respCode 93 if missing; may be optional on TEST.
//  Money at Parallex = NAIRA strings; our system = KOBO — converted at the boundary.
//
//  Env (all PARALLEX_VA_*):
//   PARALLEX_VA_BASE_URL       default TEST: http://testapi.parallexbank.com/VirtualAccount/V2/VirtualAccount
//   PARALLEX_VA_USERNAME       /Login username (e.g. PaylodeVA)
//   PARALLEX_VA_PASSWORD       /Login password PLAIN (base64-encoded on the call)
//   PARALLEX_VA_SUBKEY         APIM subscription primary key
//   PARALLEX_VA_SUBKEY_HEADER  default 'Ocp-Apim-Subscription-Key'
//   PARALLEX_VA_MERCHANT_ID    e.g. PB_001 (optional on TEST)
//   PARALLEX_VA_PERMANENT_PATH override for the permanent-account path (v2 doc omits it)
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const BASE_URL      = (process.env.PARALLEX_VA_BASE_URL || 'https://parallex-apim.azure-api.net/VirtualAccount/v1/VirtualAccount').replace(/\/$/, '');
const USERNAME      = process.env.PARALLEX_VA_USERNAME || '';
const PASSWORD      = process.env.PARALLEX_VA_PASSWORD || '';
const SUBKEY        = process.env.PARALLEX_VA_SUBKEY || '';
const SUBKEY_HEADER = process.env.PARALLEX_VA_SUBKEY_HEADER || 'Ocp-Apim-Subscription-Key';
const MERCHANT_ID   = process.env.PARALLEX_VA_MERCHANT_ID || '';

function isConfigured() { return !!(USERNAME && PASSWORD && SUBKEY); }
const b64          = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const nairaFromKobo = (kobo) => (Number(kobo) / 100).toString();   // 590000 -> "5900"
const koboFromNaira = (naira) => BigInt(Math.round(Number(naira) * 100));
const okCode        = (r) => !!r && r.responseCode === '00';

// Base (non-authed) headers shared by every call, incl. /Login.
function baseHeaders() {
  const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (SUBKEY) h[SUBKEY_HEADER] = SUBKEY;
  if (MERCHANT_ID) h['MerchantId'] = MERCHANT_ID;
  return h;
}

// ── token cache (30-min JWT, refreshed 2 min early) ───────────────────────────
let _token = null, _tokenExp = 0;
async function login() {
  const res = await fetch(BASE_URL + '/Login', {
    method: 'POST', headers: baseHeaders(),
    body: JSON.stringify({ username: USERNAME, password: b64(PASSWORD) }),
  });
  const r = await res.json().catch(() => ({ responseCode: 'PARSE', responseDescription: 'Non-JSON (HTTP ' + res.status + ')' }));
  if (r.responseCode !== '00' || !r.data || !r.data.token)
    throw new Error('Parallex login failed: ' + (r.responseDescription || r.responseCode));
  _token = r.data.token;
  const exp = Date.parse(String(r.data.validTo || '').replace(' ', 'T'));   // server time
  _tokenExp = Number.isFinite(exp) ? exp - 120000 : Date.now() + 28 * 60000;
  return _token;
}
async function token() {
  if (_token && Date.now() < _tokenExp) return _token;
  return login();
}

// Authed request. GET carries no body. Retries ONCE on an expired-token signal.
async function call(method, path, body) {
  if (!isConfigured()) throw new Error('Parallex VA not configured — set PARALLEX_VA_USERNAME/PASSWORD/SUBKEY');
  const doFetch = async (tok) => {
    const res = await fetch(BASE_URL + path, {
      method, headers: Object.assign(baseHeaders(), { Authorization: 'Bearer ' + tok }),
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({ responseCode: 'PARSE', responseDescription: 'Non-JSON (HTTP ' + res.status + ')' }));
    return { status: res.status, json };
  };
  let { status, json } = await doFetch(await token());
  if ((status === 401 || json.responseCode === '90' || json.responseCode === '34') && _token) {
    _token = null;                                   // stale token → re-login once
    ({ json } = await doFetch(await token()));
  }
  return json;
}

// ── Temporary (timed) VA — this merchant's account type ───────────────────────
// amountKobo → naira string. Returns the minted account + fee split.
async function createTimedAccount({ firstName, lastName, middleName, amountKobo, referenceId, expiryMinutes, feeBearer }) {
  const r = await call('POST', '/GenerateTimedBasedAccountNumber', {
    firstName, lastName: lastName || undefined, middleName: middleName || undefined,
    amount: nairaFromKobo(amountKobo), referenceId: referenceId || undefined,
    accountExpiryTimeInMinutes: expiryMinutes || undefined, feeBearer: feeBearer || undefined,
  });
  const d = r.data || {};
  return { ok: okCode(r), code: r.responseCode, reason: r.responseDescription,
    accountNumber: d.accountNumber, accountName: d.accountName, expiryDateTime: d.expiryDateTime,
    totalAmount: d.totalAmount, fees: d.fees, settlementAmount: d.settlementAmount, raw: r };
}
async function temporaryRequery({ referenceId, accountNumber }) {
  const r = await call('POST', '/TemporaryVirtualAccountRequery', { referenceId, accountNumber });
  return { ok: okCode(r), code: r.responseCode, reason: r.responseDescription, data: r.data, raw: r };
}

// ── Permanent VA (v2 doc omits the exact path → CONFIRM before use) ────────────
async function createPermanentAccount({ firstName, lastName, middleName, feeBearer }) {
  const path = process.env.PARALLEX_VA_PERMANENT_PATH || '/GeneratePermanentVirtualAccount';
  const r = await call('POST', path, { firstName: firstName || undefined, lastName, middleName: middleName || '', feeBearer: feeBearer || undefined });
  const d = r.data || {};
  return { ok: okCode(r), code: r.responseCode, reason: r.responseDescription, accountNumber: d.accountNumber, accountName: d.accountName, raw: r };
}
async function permanentRequery({ accountNumber, amount, dateOfTransaction }) {
  const r = await call('POST', '/PermanentVirtualAccountRequery', { accountNumber, amount: String(amount), dateOfTransaction });
  return { ok: okCode(r), code: r.responseCode, reason: r.responseDescription, data: r.data, raw: r };
}

// ── Webhook subscription (INFLOW) → returns webHookSecret to store per-merchant ──
async function addWebhook({ callBackURL, webHookType = 'INFLOW' }) {
  const r = await call('POST', '/AddWebHookURL', { callBackURL, webHookType });
  const d = r.data || {};
  return { ok: okCode(r), code: r.responseCode, reason: r.responseDescription, webHookSecret: d.webHookSecret, raw: r };
}
async function getTransactions({ accountNumber, startDate, endDate }) {
  const r = await call('POST', '/GetTransactions', { accountNumber, startDate, endDate });
  return { ok: okCode(r), code: r.responseCode, reason: r.responseDescription, transactions: (r.data && r.data.transactions) || [], raw: r };
}
async function getBanks() {
  const r = await call('GET', '/GetBanks');
  return { ok: okCode(r), banks: (r.data && r.data.banks) || [], raw: r };
}

// ── Inbound INFLOW webhook: constant-time check the shared `secret` ────────────
function verifyInflow(body, expectedSecret) {
  if (!body || !expectedSecret) return false;
  const a = Buffer.from(String(body.secret || '')), b = Buffer.from(String(expectedSecret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  isConfigured, login, call, BASE_URL,
  createTimedAccount, temporaryRequery, createPermanentAccount, permanentRequery,
  addWebhook, getTransactions, getBanks, verifyInflow,
  b64, nairaFromKobo, koboFromNaira,
};
