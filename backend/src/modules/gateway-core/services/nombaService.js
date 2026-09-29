'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Nomba MFB — Payout + Virtual Account client.
//
//  ⚠️  STUBBED — set NOMBA_ENABLED=true to activate (after sandbox sign-off
//  and payment_rails row flipped to LIVE by SA).
//
//  Auth:    POST /v1/auth/token/issue (client_credentials OAuth2)
//  Payout:  POST /v2/transfers/bank
//  VA:      POST /v1/accounts/virtual
//
//  Required env vars (NOMBA_*):
//    CLIENT_ID      — from Nomba dashboard
//    CLIENT_SECRET  — private key (base64) from Nomba dashboard
//    ACCOUNT_ID     — parent business account UUID
//    BASE_URL       — sandbox: https://sandbox.nomba.com
//                     prod:    https://api.nomba.com
//    SENDER_NAME    — shown on beneficiary statement
//    CALLBACK_URL   — webhook for transfer status updates (optional)
//
//  Rail adapter contract (payoutRailAdapter.js):
//    isConfigured()      → bool
//    getBalance()        → BigInt kobo
//    sendPayout(item)    → { ok, code, reason, orderStatus, providerRef, raw }
//    queryPayoutResult() → { ok, code, reason, orderStatus, raw }
//    nameEnquiry()       → { ok, accountName, sessionId, reason, raw }
//    getBanks()          → { ok, banks, raw }
// ─────────────────────────────────────────────────────────────────────────────

const ENABLED = process.env.NOMBA_ENABLED === 'true';

// ── STUB — returns safe no-ops while NOMBA_ENABLED != true ───────────────────
if (!ENABLED) {
  module.exports = {
    isConfigured:       () => false,
    getBalance:         async () => { throw new Error('Nomba stub — not enabled'); },
    getBanks:           async () => { throw new Error('Nomba stub — not enabled'); },
    nameEnquiry:        async () => { throw new Error('Nomba stub — not enabled'); },
    sendPayout:         async () => { throw new Error('Nomba stub — not enabled'); },
    queryPayoutResult:  async () => { throw new Error('Nomba stub — not enabled'); },
    createVirtualAccount: async () => { throw new Error('Nomba stub — not enabled'); },
    fetchVirtualAccount:  async () => { throw new Error('Nomba stub — not enabled'); },
  };
  return;
}

// ── Live implementation (only reached when NOMBA_ENABLED=true) ────────────────

const BASE_URL      = (process.env.NOMBA_BASE_URL      || 'https://sandbox.nomba.com').replace(/\/$/, '');
const CLIENT_ID     = process.env.NOMBA_CLIENT_ID      || '';
const CLIENT_SECRET = process.env.NOMBA_CLIENT_SECRET  || '';
const ACCOUNT_ID    = process.env.NOMBA_ACCOUNT_ID     || '';
const SENDER_NAME   = process.env.NOMBA_SENDER_NAME    || 'Paylode Services';
const CALLBACK_URL  = process.env.NOMBA_CALLBACK_URL   || '';

// ── Naira ↔ kobo ──────────────────────────────────────────────────────────────
const nairaFromKobo = (kobo) => Number(kobo) / 100;
const koboFromNaira = (naira) => BigInt(Math.round(Number(naira) * 100));

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && ACCOUNT_ID);
}

// ── Token cache with in-flight de-dupe ────────────────────────────────────────
let _token = null, _tokenExp = 0, _loginInflight = null;

async function doLogin() {
  const res = await fetch(`${BASE_URL}/v1/auth/token/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', accountId: ACCOUNT_ID },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    signal: AbortSignal.timeout(30_000),
  });
  const r = await res.json().catch(() => ({}));
  if (!r?.data?.access_token) throw new Error(`Nomba auth failed: ${r?.description || JSON.stringify(r)}`);
  _token = r.data.access_token;
  const exp = Date.parse(String(r.data.expiresAt || ''));
  _tokenExp = Number.isFinite(exp) ? exp - 120_000 : Date.now() + 28 * 60_000;
  return _token;
}

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  if (!_loginInflight) _loginInflight = doLogin().finally(() => { _loginInflight = null; });
  return _loginInflight;
}

// ── Authenticated HTTP call ────────────────────────────────────────────────────
async function call(method, path, { body, query, timeoutMs = 60_000 } = {}) {
  if (!isConfigured()) throw new Error('Nomba not configured — set NOMBA_CLIENT_ID, NOMBA_CLIENT_SECRET, NOMBA_ACCOUNT_ID');

  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const url = `${BASE_URL}${path}${qs}`;

  const doRequest = async (tok) => {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', accountId: ACCOUNT_ID, Authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { return { status: res.status, json: await res.json() }; }
    catch (_) { return { status: res.status, json: { code: 'PARSE', description: `Non-JSON HTTP ${res.status}` } }; }
  };

  let { status, json } = await doRequest(await getToken());

  if (status === 401) {
    _token = null;
    ({ json } = await doRequest(await getToken()));
  }

  return json;
}

// ── Status mapping ─────────────────────────────────────────────────────────────
// SUCCESS         → settled (orderStatus 2)
// PENDING_BILLING → in-flight (orderStatus 1)
// NEW             → in-flight (being queued)
// REFUND/FAILED   → definitive fail
const FAIL_STATUSES    = new Set(['REFUND', 'FAILED', 'DECLINED']);
const PENDING_STATUSES = new Set(['PENDING_BILLING', 'NEW', 'PROCESSING']);

function toRailResult(txn) {
  const status = String(txn?.status || '').toUpperCase();
  const reason = txn?.gatewayMessage || txn?.description || status;
  if (status === 'SUCCESS')            return { ok: true,  code: '00',   reason, orderStatus: '2' };
  if (FAIL_STATUSES.has(status))       return { ok: false, code: status, reason, orderStatus: null };
  if (PENDING_STATUSES.has(status))    return { ok: true,  code: status, reason, orderStatus: '1' };
  return { ok: true, code: status || 'UNKNOWN', reason, orderStatus: '1' };
}

// ── Balance ───────────────────────────────────────────────────────────────────
async function getBalance() {
  const r = await call('GET', '/v1/accounts/balance', { timeoutMs: 20_000 });
  if (!r?.data) throw new Error(`Nomba balance failed: ${r?.description || JSON.stringify(r)}`);
  return koboFromNaira(r.data.amount || 0);
}

// ── Bank list ──────────────────────────────────────────────────────────────────
async function getBanks() {
  const r = await call('GET', '/v1/transfers/bank', { timeoutMs: 20_000 });
  const banks = Array.isArray(r?.data) ? r.data : (Array.isArray(r) ? r : []);
  return { ok: banks.length > 0 || r?.code === '00', banks, raw: r };
}

// ── Name enquiry ───────────────────────────────────────────────────────────────
async function nameEnquiry(bankCode, accountNumber) {
  const r = await call('POST', '/v1/transfers/bank/lookup', {
    body: { accountNumber: String(accountNumber), bankCode: String(bankCode) },
    timeoutMs: 15_000,
  });
  return {
    ok: !!(r?.data?.accountName),
    accountName: r?.data?.accountName || null,
    // Nomba runs NE internally before firing the NIP transfer and embeds its own
    // sessionId in the transfer response meta. Unlike Parallex, callers never
    // need to supply a sessionId — passing null here is intentional and correct.
    sessionId: null,
    reason: r?.description || '',
    raw: r,
  };
}

// ── Payout ────────────────────────────────────────────────────────────────────
// item = { orderId, amount(kobo), bank_code, account_number, account_name, narration }
async function sendPayout(item) {
  const body = {
    amount: nairaFromKobo(item.amount),
    accountNumber: String(item.account_number),
    accountName: item.account_name || '',
    bankCode: String(item.bank_code || ''),
    merchantTxRef: item.orderId,
    senderName: SENDER_NAME,
  };
  if (item.narration) body.narration = item.narration;
  if (CALLBACK_URL)   body.callbackUrl = CALLBACK_URL;

  const r = await call('POST', '/v2/transfers/bank', { body, timeoutMs: 90_000 });
  const txn = r?.data || r;
  const out = toRailResult(txn);
  return {
    ...out,
    providerRef: txn?.id || txn?.meta?.rrn || item.orderId,
    raw: r,
  };
}

// ── Payout requery ─────────────────────────────────────────────────────────────
async function queryPayoutResult({ orderId } = {}) {
  const r = await call('POST', `/v1/transactions/accounts/${ACCOUNT_ID}`, {
    body: { merchantTxRef: orderId },
    timeoutMs: 30_000,
  });
  const list = r?.data?.transactions || (Array.isArray(r?.data) ? r.data : []);
  const txn  = Array.isArray(list) ? list[0] : list;
  if (!txn) {
    return { ok: true, code: 'NOT_FOUND', reason: 'No transaction found for this reference', orderStatus: null, raw: r };
  }
  const out = toRailResult(txn);
  return { ...out, raw: r };
}

// ── Virtual Account ────────────────────────────────────────────────────────────
// opts = { accountRef, accountName, currency?, bvn?, nin?, expectedAmount?, expiryDate? }
async function createVirtualAccount(opts) {
  const body = { accountRef: opts.accountRef, accountName: opts.accountName, currency: opts.currency || 'NGN' };
  if (opts.bvn)            body.bvn = opts.bvn;
  if (opts.nin)            body.nin = opts.nin;
  if (opts.expectedAmount) body.expectedAmount = opts.expectedAmount;
  if (opts.expiryDate)     body.expiryDate = opts.expiryDate;
  const r = await call('POST', '/v1/accounts/virtual', { body, timeoutMs: 30_000 });
  if (!r?.data) throw new Error(`Nomba VA create failed: ${r?.description || JSON.stringify(r)}`);
  return r.data;
}

async function fetchVirtualAccount(virtualAcctNumber) {
  return call('GET', `/v1/accounts/virtual/${virtualAcctNumber}`, { timeoutMs: 15_000 });
}

module.exports = {
  isConfigured,
  getBalance,
  getBanks,
  nameEnquiry,
  sendPayout,
  queryPayoutResult,
  createVirtualAccount,
  fetchVirtualAccount,
  nairaFromKobo,
  koboFromNaira,
  BASE_URL,
  call,
};
