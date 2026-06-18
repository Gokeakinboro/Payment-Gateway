'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  PalmPay integration client (scaffold — built ahead of receiving keys).
//
//  Products: PAYOUT (rail), PAY-IN virtual accounts, and "Pay with PalmPay"
//  checkout channel. This module = the shared client (auth + signing + request)
//  plus the PAYOUT adapter that fits our rail contract (sendPayout / getBalance,
//  see services/railHealth.js). Virtual-account + checkout methods are stubbed
//  with their documented endpoints to fill in next.
//
//  Auth (per PalmPay docs):
//   - Headers: Authorization: 'Bearer <appId>', Signature: <rsa-sig>, CountryCode
//   - Body always carries: requestTime (ms), version, nonceStr (32 chars)
//   - Sign: RSA-SHA1 over the UPPERCASE MD5 of the ASCII-sorted, '&'-joined
//     `key=value` of non-empty body params (excluding `sign`). Amounts in kobo.
//     respCode '00000000' = success. Callbacks must reply the literal "success".
//
//  Configure via env once test keys arrive (NOTHING here calls out until set):
//   PALMPAY_BASE_URL      (default sandbox: https://open-gw-sandbox.palmpay-inc.com)
//   PALMPAY_APP_ID        merchant App ID  (goes in Authorization: Bearer)
//   PALMPAY_MERCHANT_ID   merchant number  (queryBalance etc.)
//   PALMPAY_PRIVATE_KEY   merchant RSA private key (PEM or bare base64)
//   PALMPAY_PUBLIC_KEY    PalmPay's public key (PEM/base64) — verifies callbacks
//   PALMPAY_COUNTRY       default 'NG'
//   PALMPAY_VERSION       default 'V2.0' (confirm per endpoint; docs also show V1.1)
//   PALMPAY_NOTIFY_URL    our webhook base for payout/payment notifications
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const BASE_URL    = (process.env.PALMPAY_BASE_URL || 'https://open-gw-sandbox.palmpay-inc.com').replace(/\/$/, '');
const APP_ID      = process.env.PALMPAY_APP_ID || '';
const MERCHANT_ID = process.env.PALMPAY_MERCHANT_ID || '';
const COUNTRY     = process.env.PALMPAY_COUNTRY || 'NG';
const VERSION     = process.env.PALMPAY_VERSION || 'V2.0';
const PRIVATE_KEY = process.env.PALMPAY_PRIVATE_KEY || '';
const PUBLIC_KEY  = process.env.PALMPAY_PUBLIC_KEY || '';

function isConfigured() { return !!(APP_ID && PRIVATE_KEY); }

// Wrap a bare base64 key into PEM if it isn't already.
function toPem(key, label) {
  if (!key) return key;
  if (key.includes('-----BEGIN')) return key;
  const body = key.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
function nonce() { return crypto.randomBytes(16).toString('hex'); } // 32 hex chars

// Canonical string-to-sign: non-empty params, ASCII-sorted, key=value& joined.
function buildSignString(params) {
  return Object.keys(params)
    .filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map(k => `${k}=${typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]}`)
    .join('&');
}
function signParams(params) {
  const digest = crypto.createHash('md5').update(buildSignString(params), 'utf8').digest('hex').toUpperCase();
  const s = crypto.createSign('RSA-SHA1'); s.update(digest, 'utf8');
  return s.sign(toPem(PRIVATE_KEY, 'PRIVATE KEY'), 'base64');
}
function verifyParams(params, signature) {
  if (!PUBLIC_KEY || !signature) return false;
  const digest = crypto.createHash('md5').update(buildSignString(params), 'utf8').digest('hex').toUpperCase();
  const v = crypto.createVerify('RSA-SHA1'); v.update(digest, 'utf8');
  try { return v.verify(toPem(PUBLIC_KEY, 'PUBLIC KEY'), signature, 'base64'); } catch (e) { return false; }
}
// Verify an inbound PalmPay callback body (which carries its own `sign`).
// Per docs the callback `sign` must be URL-decoded before verifying.
function verifyCallback(body) {
  const b = body || {}; const { sign, ...rest } = b;
  let s = sign; try { s = decodeURIComponent(sign); } catch (e) { /* not encoded */ }
  return verifyParams(rest, s);
}

// Signed POST to a PalmPay endpoint. Returns the parsed JSON envelope.
async function call(path, body = {}) {
  if (!isConfigured()) throw new Error('PalmPay not configured — set PALMPAY_APP_ID and PALMPAY_PRIVATE_KEY');
  const payload = Object.assign({ requestTime: Date.now(), version: VERSION, nonceStr: nonce() }, body);
  const signature = signParams(payload);
  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: {
      Accept: 'application/json', 'Content-Type': 'application/json',
      Authorization: 'Bearer ' + APP_ID, Signature: signature, CountryCode: COUNTRY,
    },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({ respCode: 'PARSE_ERROR', respMsg: 'Non-JSON response (HTTP ' + res.status + ')' }));
}

// ── PAYOUT (rail) ────────────────────────────────────────────────────────────
// POST /api/v2/merchant/manage/account/queryBalance → data.availableBalance (kobo)
async function getBalance() {
  const r = await call('/api/v2/merchant/manage/account/queryBalance', { merchantId: MERCHANT_ID });
  if (r.respCode !== '00000000') throw new Error(r.respMsg || 'PalmPay balance query failed');
  return BigInt(r.data.availableBalance); // kobo
}
// POST /api/v2/merchant/payment/payout
async function initiatePayout({ orderId, amountKobo, bankCode, accountNumber, accountName, narration, notifyUrl }) {
  const r = await call('/api/v2/merchant/payment/payout', {
    orderId,
    payeeBankCode: bankCode,
    payeeBankAccNo: accountNumber,
    payeeName: accountName || undefined,
    currency: 'NGN',
    amount: Number(amountKobo),
    notifyUrl: notifyUrl || process.env.PALMPAY_NOTIFY_URL,
    remark: narration || 'Payout',
    title: 'Payout',
    description: narration || 'Merchant payout',
  });
  const reason = r.respMsg || (r.data && r.data.errorMsg) || '';
  return {
    ok: r.respCode === '00000000',
    code: r.respCode,
    reason,
    isLowBalance: /insufficient|balance/i.test(reason),
    providerRef: r.data && r.data.orderNo,
    orderStatus: r.data && r.data.orderStatus,
    raw: r,
  };
}
// rail-adapter contract (railHealth.recordRailResult expects { ok, reason, isLowBalance }).
async function sendPayout(item) {
  return initiatePayout({
    orderId: item.orderId, amountKobo: item.amount, bankCode: item.bank_code,
    accountNumber: item.account_number, accountName: item.account_name, narration: item.narration,
  });
}
// POST /api/v2/merchant/payment/queryStatus  (query-merchant-payout-result) — confirm path on first test
async function queryPayoutResult(orderId) {
  return call('/api/v2/merchant/payment/queryStatus', { orderId });
}
// POST /api/v2/general/merchant/queryBankList → [{ bankCode, bankName, bankUrl }]
async function queryBankList() {
  const r = await call('/api/v2/general/merchant/queryBankList', { businessType: '0' });
  if (r.respCode !== '00000000') throw new Error(r.respMsg || 'PalmPay bank list failed');
  return r.data || [];
}
// POST /api/v2/payment/merchant/payout/queryBankAccount → { status, accountName, errorMessage }
async function nameEnquiry(bankCode, accountNumber) {
  const r = await call('/api/v2/payment/merchant/payout/queryBankAccount', { bankCode, bankAccNo: accountNumber });
  const d = r.data || {};
  // PalmPay returns the field as `Status` (capital S); accept either case.
  const status = String(d.Status || d.status || '').toLowerCase();
  return {
    ok: r.respCode === '00000000' && status === 'success' && !!d.accountName,
    accountName: d.accountName || null,
    reason: d.errorMessage || r.respMsg,
  };
}

// ── PAY-IN: Virtual Accounts (value-added-services/virtual-account/*) ──────────
// POST /api/v2/virtual/account/label/create
//   identityType: 'personal' (BVN) | 'personal_nin' (NIN) | 'company' (CAC, RC/BN…)
async function createVirtualAccount({ virtualAccountName, identityType, licenseNumber, customerName, email, accountReference }) {
  const r = await call('/api/v2/virtual/account/label/create', {
    virtualAccountName, identityType, licenseNumber, customerName,
    email: email || undefined, accountReference: accountReference || undefined,
  });
  if (r.respCode !== '00000000') throw new Error((r.data && r.data.errorMsg) || r.respMsg || 'VA create failed');
  return r.data; // { virtualAccountNo, virtualAccountName, status, ... }
}
async function queryVirtualAccount(virtualAccountNo) {
  return call('/api/v2/virtual/account/label/queryOne', { virtualAccountNo });
}

// ── PAY-IN: Pay with PalmPay (checkout channel) ───────────────────────────────
// POST /api/v2/payment/merchant/createorder  (productType 'pay_wallet'; amount kobo, min 10000)
//   → { orderNo, orderStatus, checkoutUrl (H5 redirect), payToken, ... }
async function createPayWithPalmPayOrder({ orderId, amountKobo, callbackUrl, notifyUrl, title, description, customerEmail }) {
  const r = await call('/api/v2/payment/merchant/createorder', {
    orderId, amount: Number(amountKobo), currency: 'NGN', productType: 'pay_wallet',
    notifyUrl: notifyUrl || process.env.PALMPAY_NOTIFY_URL,
    callBackUrl: callbackUrl,
    title: title || 'Payment', description: description || 'Pay with PalmPay',
    customerInfo: customerEmail ? { email: customerEmail } : undefined,
  });
  return {
    ok: r.respCode === '00000000', code: r.respCode, reason: r.respMsg,
    orderNo: r.data && r.data.orderNo, checkoutUrl: r.data && r.data.checkoutUrl,
    payToken: r.data && r.data.payToken, orderStatus: r.data && r.data.orderStatus, raw: r,
  };
}
// POST /api/v2/payment/merchant/queryStatus (query-order-result) — confirm on first test
async function queryPayInResult(orderId) {
  return call('/api/v2/payment/merchant/queryStatus', { orderId });
}

module.exports = {
  isConfigured, call, buildSignString, signParams, verifyParams, verifyCallback,
  // payouts (rail)
  getBalance, initiatePayout, sendPayout, queryPayoutResult, queryBankList, nameEnquiry,
  // pay-in: virtual accounts
  createVirtualAccount, queryVirtualAccount,
  // pay-in: Pay with PalmPay (checkout)
  createPayWithPalmPayOrder, queryPayInResult,
  BASE_URL,
};
