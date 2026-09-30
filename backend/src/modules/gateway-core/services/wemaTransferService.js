'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Wema Bank Merchant Payout Service v2 — outbound payout rail client.
//
//  API: Bearer JWT (24hr TTL) + VendorID header on every request.
//  Payloads: AES/CBC/PKCS5Padding — encrypt before sending, decrypt on receipt.
//
//  Required env vars (WEMA_PAYOUT_*):
//    BASE_URL        — https://... (TODO: confirm prod URL from Wema)
//    VENDOR_ID       — assigned by Wema during onboarding
//    CLIENT_ID       — auth credential
//    CLIENT_SECRET   — auth credential  (TODO: confirm exact auth field names)
//    AES_KEY         — hex-encoded AES key (32 bytes → 64 hex chars for AES-256)
//    AES_IV          — hex-encoded AES IV  (16 bytes → 32 hex chars)
//    DEBIT_ACCOUNT   — designated source account number
//    CALLBACK_URL    — our inbound callback URL for payout results
//
//  Rail adapter contract (matches parallexTransferService):
//    isConfigured()       → bool
//    getBalance()         → BigInt kobo
//    nameEnquiry()        → { ok, accountName, sessionId, reason, raw }
//    sendPayout(item)     → { ok, code, reason, orderStatus, providerRef, raw }
//    queryPayoutResult()  → { ok, code, reason, orderStatus, sessionId, raw }
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const url    = require('url');

const BASE_URL      = (process.env.WEMA_PAYOUT_BASE_URL      || '').replace(/\/$/, '');
const VENDOR_ID     = process.env.WEMA_PAYOUT_VENDOR_ID      || '';
const CLIENT_ID     = process.env.WEMA_PAYOUT_CLIENT_ID      || '';
const CLIENT_SECRET = process.env.WEMA_PAYOUT_CLIENT_SECRET  || '';
const AES_KEY_HEX   = process.env.WEMA_PAYOUT_AES_KEY        || '';
const AES_IV_HEX    = process.env.WEMA_PAYOUT_AES_IV         || '';
const DEBIT_ACCOUNT = process.env.WEMA_PAYOUT_DEBIT_ACCOUNT  || '';
const CALLBACK_URL  = process.env.WEMA_PAYOUT_CALLBACK_URL   || '';

// ── AES-CBC encrypt / decrypt ────────────────────────────────────────────────
function aesKey() {
  if (!AES_KEY_HEX || !AES_IV_HEX) throw new Error('WEMA_PAYOUT_AES_KEY / AES_IV not set');
  return {
    key: Buffer.from(AES_KEY_HEX, 'hex'),
    iv:  Buffer.from(AES_IV_HEX,  'hex'),
  };
}

function encrypt(plaintext) {
  const { key, iv } = aesKey();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return cipher.update(plaintext, 'utf8', 'base64') + cipher.final('base64');
}

function decrypt(ciphertext) {
  const { key, iv } = aesKey();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(ciphertext, 'base64', 'utf8') + decipher.final('utf8');
}

function isConfigured() {
  return !!(BASE_URL && VENDOR_ID && CLIENT_ID && CLIENT_SECRET && AES_KEY_HEX && AES_IV_HEX && DEBIT_ACCOUNT);
}

// ── Token cache (24hr TTL) ───────────────────────────────────────────────────
let _token        = null;
let _refreshToken = null;
let _tokenExp     = 0;
let _loginFlight  = null;

async function doLogin() {
  // TODO: confirm exact auth endpoint path and request field names from Wema
  const r = await request('POST', '/api/auth/login', null, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    vendorId: VENDOR_ID,
  });
  if (!r.token) throw new Error(`Wema auth failed: ${r.responseDescription || r.message || JSON.stringify(r)}`);
  _token        = r.token;
  _refreshToken = r.refreshToken || null;
  _tokenExp     = Date.now() + 23 * 3600_000; // refresh 1h before 24h expiry
  return _token;
}

async function doRefresh() {
  if (!_refreshToken) return doLogin();
  // TODO: confirm exact refresh endpoint path and field name
  const r = await request('POST', '/api/auth/refreshToken', null, { refreshToken: _refreshToken });
  if (!r.token) return doLogin(); // fallback to full login
  _token        = r.token;
  _refreshToken = r.refreshToken || _refreshToken;
  _tokenExp     = Date.now() + 23 * 3600_000;
  return _token;
}

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  if (!_loginFlight) {
    _loginFlight = (_token ? doRefresh() : doLogin()).finally(() => { _loginFlight = null; });
  }
  return _loginFlight;
}

// ── Raw HTTP request (no auth, no encryption) — used only for login ──────────
function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(`${BASE_URL}${path}`);
    const isHttps = parsed.protocol === 'https:';
    const agent   = isHttps ? https : http;
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'VendorID':      VENDOR_ID,
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Wema request timed out')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Authenticated + encrypted call ──────────────────────────────────────────
async function call(method, path, { body, query } = {}) {
  if (!isConfigured()) throw new Error('Wema payout not configured — set WEMA_PAYOUT_* env vars');
  const token = await getToken();

  let fullPath = path;
  if (query) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))
    ).toString();
    fullPath = `${path}?${qs}`;
  }

  // Encrypt request body
  const encryptedBody = body ? { data: encrypt(JSON.stringify(body)) } : undefined;

  const raw = await request(method, fullPath, token, encryptedBody);

  // Decrypt response — some error responses are unencrypted plain JSON
  if (raw && typeof raw.data === 'string') {
    try {
      return JSON.parse(decrypt(raw.data));
    } catch (_) {
      return raw; // unencrypted validation error — return as-is
    }
  }
  return raw;
}

// ── Balance ──────────────────────────────────────────────────────────────────
// TODO: confirm exact endpoint path and response field from Wema
async function getBalance() {
  const r = await call('GET', '/api/accountBalance', { query: { accountNumber: DEBIT_ACCOUNT } });
  const naira = r.balance || r.availableBalance || r.Balance || 0;
  return BigInt(Math.round(Number(naira) * 100));
}

// ── Name Enquiry ─────────────────────────────────────────────────────────────
// TODO: confirm exact endpoint path and response fields from Wema
async function nameEnquiry(bankCode, accountNumber) {
  const r = await call('GET', '/api/nameEnquiry', { query: { bankCode, accountNumber } });
  const ok = r.responseCode === '00' && !!r.accountName;
  return {
    ok,
    accountName:  r.accountName  || null,
    sessionId:    r.sessionId    || r.requestId || null,
    reason:       r.responseDescription || r.message || '',
    raw: r,
  };
}

// ── Naira / kobo ─────────────────────────────────────────────────────────────
const koboToNaira = (kobo) => String(Number(kobo) / 100);

// Wema: payment reference max 20 chars; narration max 25 chars, no special chars.
const toRef     = (orderId) => String(orderId).replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
const toNarr    = (text)    => String(text  || 'Payout').replace(/[@#%&*]/g, '').slice(0, 25);

// ── Payout ───────────────────────────────────────────────────────────────────
// item = { orderId, amount(kobo), bank_code, account_number, account_name,
//          narration, neSessionId, neAccountName }
async function sendPayout(item) {
  let neSessionId   = item.neSessionId   || null;
  let neAccountName = item.neAccountName || item.account_name || null;

  if (!neSessionId) {
    const ne = await nameEnquiry(item.bank_code, item.account_number);
    if (!ne.ok || !ne.sessionId) {
      await new Promise(r => setTimeout(r, 3000));
      const ne2 = await nameEnquiry(item.bank_code, item.account_number);
      if (!ne2.ok || !ne2.sessionId) {
        throw new Error(`Wema NE failed for ${item.bank_code}/${item.account_number}`);
      }
      neSessionId   = ne2.sessionId;
      neAccountName = ne2.accountName || neAccountName;
    } else {
      neSessionId   = ne.sessionId;
      neAccountName = ne.accountName || neAccountName;
    }
  }

  // TODO: confirm exact request field names from Wema payload sample
  const payload = {
    transactionReference:   toRef(item.orderId),
    sourceAccountNumber:    DEBIT_ACCOUNT,
    destinationBankCode:    String(item.bank_code),
    destinationAccountNumber: item.account_number,
    destinationAccountName: neAccountName || '',
    amount:                 koboToNaira(item.amount),
    narration:              toNarr(item.narration),
    nameEnquirySessionID:   neSessionId,
    ...(CALLBACK_URL ? { callBackUrl: CALLBACK_URL } : {}),
  };

  const r = await call('POST', '/api/initiateTransfer', { body: payload }); // TODO: confirm path

  return toRailResult(r, item.orderId);
}

// ── TSQ ───────────────────────────────────────────────────────────────────────
async function queryPayoutResult({ orderId, sessionId } = {}) {
  const ref = sessionId || toRef(orderId);
  const encRef = encrypt(ref);
  // GET {baseUrl}/api/outwardTSQ?TranRef_SessionID=<encrypted>
  const r = await call('GET', '/api/outwardTSQ', { query: { TranRef_SessionID: encRef } });
  return toTSQResult(r);
}

// ── Response mappers ─────────────────────────────────────────────────────────
// TODO: confirm exact field names and status values from Wema response samples
function toRailResult(r, orderId) {
  const code   = String(r.responseCode || r.ResponseCode || '');
  const reason = r.responseDescription || r.description || r.message || `code ${code}`;
  const sessId = r.sessionId || r.Sessionid || null;
  if (code === '00') {
    return { ok: true, code, reason, orderStatus: '2', providerRef: sessId || toRef(orderId), raw: r };
  }
  // Undetermined — treat as in-flight so watchdog can requery
  if (!code || code === '09' || code === '25') {
    return { ok: true, code, reason, orderStatus: '1', providerRef: sessId || null, raw: r };
  }
  return { ok: false, code, reason, orderStatus: null, providerRef: null, raw: r };
}

function toTSQResult(r) {
  const status = String(r.status || r.Status || '').toUpperCase();
  const sessId = r.sessionId || r.Sessionid || null;
  if (status === 'SUCCESSFUL') {
    return { ok: true, code: '00', reason: 'Successful', orderStatus: '2', sessionId: sessId, raw: r };
  }
  if (status === 'FAILED') {
    return { ok: true, code: 'FAILED', reason: r.description || 'Failed', orderStatus: '3', sessionId: sessId, raw: r };
  }
  // Undetermined
  return { ok: true, code: 'UNDETERMINED', reason: 'Undetermined', orderStatus: '1', sessionId: sessId, raw: r };
}

module.exports = {
  isConfigured,
  encrypt,
  decrypt,
  getBalance,
  nameEnquiry,
  sendPayout,
  queryPayoutResult,
  koboToNaira,
};
