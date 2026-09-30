'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Alpha Morgan Bank — Virtual Account Service (VAS) client.
//
//  Collections-only rail: creates/manages virtual accounts for inflow
//  collection. No payout/transfer endpoint is documented — this is NOT a
//  payout rail adapter (contrast parallexTransferService / wemaTransferService).
//
//  API: Bearer JWT (~1hr TTL per `expiresIn`), obtained via AppId/AppKey login.
//
//  Required env vars (ALPHAMORGAN_VA_*):
//    BASE_URL           — {{baseURL}} from the spec (TODO: confirm from Alpha Morgan)
//    APP_ID              — login credential
//    APP_KEY             — login credential
//    MERCHANT_ID         — AMB-side merchantId returned by registerMerchant(),
//                          once obtained, cache it here (TODO: run registerMerchant
//                          once during onboarding, then set this env var)
//    COLLECTION_ACCOUNT_NO — our settlement account number on Alpha Morgan's books
//    CALLBACK_URL        — our inbound URL for VA inflow notifications (TODO:
//                          confirm exact payload shape — not in the spec doc)
//
//  Spec doc only shows 5 endpoints: Login, RegisterMerchant, CreateAccount,
//  GetAccountDetail, CreateBulkAccounts. No webhook payload sample was
//  provided — the webhook route (alphamorgan-webhook.js) is a best-guess
//  scaffold pending a real payload sample from Alpha Morgan.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const url    = require('url');

const BASE_URL              = (process.env.ALPHAMORGAN_VA_BASE_URL             || '').replace(/\/$/, '');
const APP_ID                = process.env.ALPHAMORGAN_VA_APP_ID                || '';
const APP_KEY                = process.env.ALPHAMORGAN_VA_APP_KEY               || '';
const MERCHANT_ID           = process.env.ALPHAMORGAN_VA_MERCHANT_ID           || '';
const COLLECTION_ACCOUNT_NO = process.env.ALPHAMORGAN_VA_COLLECTION_ACCOUNT_NO  || '';
const CALLBACK_URL          = process.env.ALPHAMORGAN_VA_CALLBACK_URL          || '';

function isConfigured() {
  return !!(BASE_URL && APP_ID && APP_KEY);
}

function isMerchantRegistered() {
  return !!MERCHANT_ID;
}

function newRequestId(prefix) {
  return `${prefix || 'req'}_${crypto.randomBytes(8).toString('hex')}`;
}

// ── Token cache (per `expiresIn`, refresh 5 min early) ───────────────────────
let _token       = null;
let _tokenExp    = 0;
let _loginFlight = null;

async function doLogin() {
  const r = await request('POST', '/api/VAS//ClientAccount/Login', null, {
    AppId:  APP_ID,
    AppKey: APP_KEY,
  });
  if (!r.token) throw new Error(`Alpha Morgan auth failed: ${r.responseMessage || r.message || JSON.stringify(r)}`);
  _token    = r.token;
  const ttlMs = (Number(r.expiresIn) || 3599) * 1000;
  _tokenExp = Date.now() + ttlMs - 5 * 60_000;
  return _token;
}

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  if (!_loginFlight) {
    _loginFlight = doLogin().finally(() => { _loginFlight = null; });
  }
  return _loginFlight;
}

// ── Raw HTTP request ─────────────────────────────────────────────────────────
function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(`${BASE_URL}${path}`);
    const isHttps = parsed.protocol === 'https:';
    const agent   = isHttps ? https : http;
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.path,
      method,
      headers,
      timeout: 30_000,
    };
    const req = agent.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({ _raw: data, _status: res.statusCode }); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Alpha Morgan request timed out')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Authenticated call ───────────────────────────────────────────────────────
async function call(method, path, body) {
  if (!isConfigured()) throw new Error('Alpha Morgan VA not configured — set ALPHAMORGAN_VA_* env vars');
  const token = await getToken();
  return request(method, path, token, body);
}

// ── 2. Register Merchant ─────────────────────────────────────────────────────
// Run once during onboarding; the returned merchantId is then cached in
// ALPHAMORGAN_VA_MERCHANT_ID for all subsequent CreateAccount/GetAccountDetail calls.
async function registerMerchant({ merchantId, collectionAccountNo, alias, name, description, email, phone, callbackUrl } = {}) {
  const requestId = newRequestId('reg');
  const r = await call('POST', '/api/VAS/RegisterMerchant', {
    requestId,
    merchantId:           merchantId || undefined, // TODO: confirm whether this is our-assigned ID or omitted on first call
    collectionAccountNo:  collectionAccountNo || COLLECTION_ACCOUNT_NO,
    alias,
    name,
    description,
    email,
    phone,
    callbackUrl: callbackUrl || CALLBACK_URL,
  });
  return {
    ok:         r.responseCode === '00',
    merchantId: r.merchantId || null,
    reason:     r.responseMessage || '',
    requestId:  r.requestId || requestId,
    raw: r,
  };
}

// ── 3. Create Virtual Account ────────────────────────────────────────────────
// accountType: 1 = Permanent, 2 = Timebound
async function createAccount({ customerReference, accountName, accountType = 1, merchantId } = {}) {
  const requestId = newRequestId('va');
  const r = await call('POST', '/api/VAS/CreateAccount', {
    requestId,
    merchantId: merchantId || MERCHANT_ID,
    accountType,
    customerDetail: { customerReference, accountName },
  });
  const detail = r.accountDetails || {};
  return {
    ok:                r.responseCode === '00',
    accountNo:          detail.accountNo || null,
    accountName:        detail.accountName || null,
    customerReference:  detail.customerReference || null,
    reason:             r.responseMessage || '',
    requestId:          r.requestId || requestId,
    raw: r,
  };
}

// ── 4. Get Virtual Account Detail ────────────────────────────────────────────
async function getAccountDetail({ accountNo, merchantId } = {}) {
  const requestId = newRequestId('ae');
  const r = await call('POST', '/api/VAS/GetAccountDetail', {
    requestId,
    accountNo,
    merchantId: merchantId || MERCHANT_ID,
  });
  return {
    ok:     r.responseCode === '00',
    detail: r.accountDetail || null,
    reason: r.responseMessage || '',
    requestId: r.requestId || requestId,
    raw: r,
  };
}

// ── 5. Create Bulk Virtual Accounts ──────────────────────────────────────────
// customerDetails: [{ customerReference, accountName }, ...]
async function createBulkAccounts({ customerDetails, merchantId } = {}) {
  const requestId = newRequestId('bulk');
  const r = await call('POST', '/api/VAS/CreateBulkAccounts', {
    requestId,
    merchantId: merchantId || MERCHANT_ID,
    customerDetails,
  });
  return {
    ok:             r.responseCode === '00',
    accountDetails: r.accountDetails || [],
    reason:         r.responseMessage || '',
    requestId:      r.requestId || requestId,
    raw: r,
  };
}

module.exports = {
  isConfigured,
  isMerchantRegistered,
  registerMerchant,
  createAccount,
  getAccountDetail,
  createBulkAccounts,
};
