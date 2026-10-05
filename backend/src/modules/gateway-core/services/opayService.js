'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  OPay integration client — v2.9 Payout API + Checkout API.
//
//  Products:
//   1. COLLECTIONS   — bank transfer pay-in (dynamic one-time VA per txn)
//   2. PAY-WITH-OPAY — wallet QR checkout
//   3. PAYOUTS       — bank disbursements via Payout API (separate auth from checkout)
//
//  Auth (TWO schemes — checkout vs payout):
//   Checkout create:  Authorization: Bearer {OPAY_PUBLIC_KEY}
//   Checkout query/refund: Authorization: Bearer {HMAC-SHA512 of sorted JSON, hex, using OPAY_SECRET_KEY}
//   Payout API (ALL payout endpoints): Authorization: Bearer {RSA-SHA256 of raw JSON body, base64, using OPAY_PAYOUT_PRIVATE_KEY}
//
//  Success code: "00000". Payout callbacks must respond with plain text "SUCCESS".
//  Checkout callbacks: respond HTTP 200 (body optional).
//
//  Payout uses CBN 3-digit bank codes directly (NOT NIP 6-digit codes).
//  Amounts are in kobo (cent unit). 100 kobo = ₦1.
//
//  Env vars (set on server 176):
//   OPAY_BASE_URL            default: https://liveapi.opaycheckout.com
//   OPAY_MERCHANT_ID         Merchant ID from OPay dashboard
//   OPAY_PUBLIC_KEY          OPAYPUB... from dashboard (checkout create auth)
//   OPAY_SECRET_KEY          OPAYPRV... from dashboard (HMAC-SHA512 signing)
//   OPAY_PAYOUT_PRIVATE_KEY  RSA-2048 PKCS8 private key PEM (payout signing)
//   OPAY_NOTIFY_URL          Webhook base URL; /payout /cashin /payin appended
//   OPAY_COUNTRY             default: NG
//
//  IP whitelist (do both on OPay dashboard → Account Details → IP WhiteListing):
//   Add server 176 IP: 176.57.188.45
//   OPay's outbound IP (allow inbound on 176 firewall): 159.138.170.59
//
//  Pre-charge: merchant must transfer funds to OPay finance team first.
//  OPay credits the CASH_ACCOUNT. Payouts deduct from it (amount + MDR fee).
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const BASE_URL        = (process.env.OPAY_BASE_URL || 'https://liveapi.opaycheckout.com').replace(/\/$/, '');
const MERCHANT_ID     = process.env.OPAY_MERCHANT_ID || '';
const PUBLIC_KEY      = process.env.OPAY_PUBLIC_KEY  || '';
const SECRET_KEY      = process.env.OPAY_SECRET_KEY  || '';
const PAYOUT_PRIV_KEY = process.env.OPAY_PAYOUT_PRIVATE_KEY || '';
const NOTIFY_URL_BASE = (process.env.OPAY_NOTIFY_URL || '').replace(/\/$/, '');
const COUNTRY         = process.env.OPAY_COUNTRY || 'NG';

function isConfigured()       { return !!(MERCHANT_ID && PUBLIC_KEY && SECRET_KEY); }
function isPayoutConfigured() { return !!(MERCHANT_ID && PAYOUT_PRIV_KEY); }

// ── Signing helpers ───────────────────────────────────────────────────────────

// Serialize with keys sorted alphabetically — required for checkout HMAC signing.
function sortedJson(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
  return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + sortedJson(obj[k])).join(',') + '}';
}

// CHECKOUT: HMAC-SHA512 over alphabetically-sorted JSON → hex.
// Goes in Authorization: Bearer {result} for checkout query/refund endpoints.
function hmacSign(body) {
  return crypto.createHmac('sha512', SECRET_KEY).update(sortedJson(body), 'utf8').digest('hex');
}

// PAYOUT: RSA-SHA256 over the RAW JSON body string → base64.
// OPay verifies using the merchant RSA public key submitted to their dashboard.
// The body is NOT sorted — signed as-is (per OPay Java sample: body.getBytes("UTF-8")).
function rsaSign(body) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(JSON.stringify(body), 'utf8');
  return signer.sign(PAYOUT_PRIV_KEY, 'base64');
}

// CHECKOUT CALLBACKS: Verify inbound OPay callback signature.
// Signature is in body's `sha512` field (NOT a header). Algorithm: HMAC-SHA3-512.
// Signed string format: {Amount:"...",Currency:"...",Reference:"...",Refunded:t/f,Status:"...",Timestamp:"...",Token:"...",TransactionID:"..."}
function verifyWebhook(callbackBody) {
  if (!SECRET_KEY) return true; // scaffold mode
  try {
    const sig = callbackBody.sha512;
    if (!sig) return false;
    const p = callbackBody.payload || callbackBody;
    const str = `{Amount:"${p.Amount || p.amount || ''}",Currency:"${p.Currency || p.currency || ''}",` +
      `Reference:"${p.Reference || p.reference || ''}",Refunded:${p.Refunded || p.refunded ? 't' : 'f'},` +
      `Status:"${p.Status || p.status || ''}",Timestamp:"${p.Timestamp || p.timestamp || ''}",` +
      `Token:"${p.Token || p.token || ''}",TransactionID:"${p.TransactionID || p.transactionId || ''}"}`;
    const expected = crypto.createHmac('sha3-512', SECRET_KEY).update(str, 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch (_) { return false; }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function _post(url, body, authBearer) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + authBearer,
        MerchantId:    MERCHANT_ID,
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  return res.json().catch(() => ({ code: 'PARSE_ERROR', message: 'Non-JSON (HTTP ' + res.status + ')' }));
}

// Checkout create — uses public key as Bearer.
function callCreate(path, body) {
  if (!isConfigured()) throw new Error('OPay not configured — set OPAY_MERCHANT_ID, OPAY_PUBLIC_KEY, OPAY_SECRET_KEY');
  return _post(BASE_URL + path, body, PUBLIC_KEY);
}

// Checkout query/refund — uses HMAC-SHA512 as Bearer.
function callSigned(path, body) {
  if (!isConfigured()) throw new Error('OPay not configured — set OPAY_MERCHANT_ID, OPAY_PUBLIC_KEY, OPAY_SECRET_KEY');
  return _post(BASE_URL + path, body, hmacSign(body));
}

// Payout API — uses RSA-SHA256 as Bearer. All payout endpoints use this.
function callPayoutApi(path, body) {
  if (!isPayoutConfigured()) throw new Error('OPay payout not configured — set OPAY_MERCHANT_ID and OPAY_PAYOUT_PRIVATE_KEY');
  return _post(BASE_URL + path, body, rsaSign(body));
}

// ── COLLECTIONS: Bank Transfer pay-in ────────────────────────────────────────
// Creates a one-time VA tied to this order. Customer transfers the exact amount to
// data.nextAction.transferAccountNumber; OPay fires callback to our /cashin.
async function createBankTransferOrder({ orderId, amountKobo, notifyUrl, callbackUrl, description, expireMinutes }) {
  const body = {
    reference:   orderId,
    country:     COUNTRY,
    payMethod:   'BankTransfer',
    amount: { total: Number(amountKobo), currency: 'NGN' },
    product: { name: description || 'Payment', description: description || 'Bank transfer payment' },
    callbackUrl: callbackUrl || undefined,
    notifyUrl:   notifyUrl   || (NOTIFY_URL_BASE + '/cashin') || undefined,
    expireAt:    expireMinutes || 30,
  };
  const r = await callCreate('/api/v1/international/payment/create', body);
  const d = (r.data && r.data.nextAction) || {};
  return {
    ok:               r.code === '00000',
    code:             r.code,
    reason:           r.message || '',
    orderNo:          r.data && r.data.orderNo,
    virtualAccountNo: d.transferAccountNumber || null,
    bankName:         d.transferBankName       || null,
    expiresAt:        d.expiredTimestamp        || null,
    orderStatus:      r.data && r.data.status,
    raw: r,
  };
}

// ── PAY-WITH-OPAY: wallet QR checkout ────────────────────────────────────────
async function createWalletQROrder({ orderId, amountKobo, notifyUrl, callbackUrl, description }) {
  const body = {
    reference: orderId,
    country:   COUNTRY,
    payMethod: 'OpayWalletNgQR',
    amount: { total: Number(amountKobo), currency: 'NGN' },
    product: { name: description || 'Payment', description: description || 'Pay with OPay' },
    callbackUrl: callbackUrl || undefined,
    notifyUrl:   notifyUrl   || (NOTIFY_URL_BASE + '/payin') || undefined,
  };
  const r = await callCreate('/api/v1/international/payment/create', body);
  const d = (r.data && r.data.nextAction) || {};
  return {
    ok:          r.code === '00000',
    code:        r.code,
    reason:      r.message || '',
    orderNo:     r.data && r.data.orderNo,
    qrCode:      d.qrCode || null,
    orderStatus: r.data && r.data.status,
    raw: r,
  };
}

// ── Query checkout payment status ─────────────────────────────────────────────
async function queryPaymentStatus({ orderId, orderNo }) {
  const body = {};
  if (orderId) body.reference = orderId;
  if (orderNo) body.orderNo   = orderNo;
  return callSigned('/api/v1/international/payment/query', body);
}

// ── Refund a collection ───────────────────────────────────────────────────────
async function refundPayment({ refundId, originalOrderId, amountKobo, reason }) {
  const r = await callSigned('/api/v1/international/payment/refund', {
    reference:     refundId,
    originOrderNo: originalOrderId,
    amount: { total: Number(amountKobo), currency: 'NGN' },
    notifyUrl: NOTIFY_URL_BASE ? NOTIFY_URL_BASE + '/refund' : undefined,
    reason:    reason || 'Refund',
  });
  return {
    ok:      r.code === '00000',
    code:    r.code,
    reason:  r.message || '',
    orderNo: r.data && r.data.orderNo,
    raw: r,
  };
}

// ── PAYOUT rail ───────────────────────────────────────────────────────────────
// All payout API endpoints use RSA-SHA256 auth (callPayoutApi).
// Bank codes: OPay payout uses CBN 3-digit codes directly — no NIP conversion needed.
// Order status enum: INITIAL, PENDING, CHECKING, SUCCESS, FAIL, CLOSE, RETURN

// POST /api/v1/international/payout/balance
// Balance unit assumed kobo (same as payout amount unit). Verify on first live test.
async function getBalance() {
  const r = await callPayoutApi('/api/v1/international/payout/balance', {
    country:  COUNTRY,
    currency: 'NGN',
    type:     'CASH_ACCOUNT',
  });
  if (r.code !== '00000') throw new Error(r.message || 'OPay balance query failed');
  const total = r.data && r.data.balance && r.data.balance.total;
  return BigInt(total != null ? total : 0);
}

// POST /api/v1/international/payout/createSingleOrder
async function initiatePayout({ orderId, amountKobo, bankCode, accountNumber, accountName, narration }) {
  const body = {
    payoutType:      'BankTransfer',
    notifyUrl:       NOTIFY_URL_BASE ? NOTIFY_URL_BASE + '/payout' : undefined,
    merchantOrderNo: orderId,
    country:         COUNTRY,
    amount:          Number(amountKobo),
    currency:        'NGN',
    language:        'en_US',
    remark:          narration || undefined,
    metaData: {
      accountBankCode: String(bankCode || ''),  // CBN 3-digit code used directly
      accountName:     accountName  || undefined,
      accountNo:       accountNumber,
    },
  };
  const r = await callPayoutApi('/api/v1/international/payout/createSingleOrder', body);
  const reason = r.message || (r.data && r.data.errorMsg) || '';
  return {
    ok:           r.code === '00000',
    code:         r.code,
    reason,
    isLowBalance: r.code === '5006' || /insufficient|balance|low/i.test(reason),
    providerRef:  r.data && r.data.orderNo,
    orderStatus:  r.data && r.data.orderStatus,
    raw: r,
  };
}

// Rail-adapter contract wrapper.
async function sendPayout(item) {
  return initiatePayout({
    orderId:       item.orderId,
    amountKobo:    item.amount,
    bankCode:      item.bank_code,   // CBN code — no conversion needed
    accountNumber: item.account_number,
    accountName:   item.account_name,
    narration:     item.narration,
  });
}

// POST /api/v1/international/payout/queryorder
async function queryPayoutResult({ orderId, orderNo } = {}) {
  const body = { country: COUNTRY };
  if (orderId) body.reference = orderId;
  if (orderNo) body.orderNo   = orderNo;
  const r = await callPayoutApi('/api/v1/international/payout/queryorder', body);
  return {
    ok:          r.code === '00000',
    code:        r.code,
    reason:      r.message || (r.data && r.data.errorMsg) || '',
    orderStatus: r.data && r.data.orderStatus,  // SUCCESS, FAIL, PENDING, etc.
    raw: r,
  };
}

// POST /api/v1/international/payout/bank-account-validate
async function nameEnquiry(bankCode, accountNumber) {
  const r = await callPayoutApi('/api/v1/international/payout/bank-account-validate', {
    accountBankCode: String(bankCode || ''),
    accountNo:       accountNumber,
  });
  const d = r.data || {};
  return {
    ok:          r.code === '00000' && !!d.accountName,
    accountName: d.accountName || null,
    reason:      r.message || '',
  };
}

// POST /api/v1/international/banks — returns [{bankCode, bankName}]
async function getBanks() {
  const r = await callPayoutApi('/api/v1/international/banks', { countryCode: COUNTRY });
  return {
    ok:    r.code === '00000',
    banks: Array.isArray(r.data) ? r.data : [],
    raw:   r,
  };
}

module.exports = {
  isConfigured, isPayoutConfigured, verifyWebhook,
  // collections
  createBankTransferOrder, queryPaymentStatus, refundPayment,
  // pay with OPay
  createWalletQROrder,
  // payout rail (all RSA-signed)
  getBalance, initiatePayout, sendPayout, queryPayoutResult, nameEnquiry, getBanks,
  BASE_URL,
};
