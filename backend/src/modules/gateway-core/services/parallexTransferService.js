'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
// ─────────────────────────────────────────────────────────────────────────────
//  Parallex Bank — Third Party Transfer (TPT) payout client.
//
//  API base: https://tptintegration.parallexbank.com/ThirdPartyTransferAPI
//  Auth: Ocp-Apim-Subscription-Key header + Bearer JWT (/Login, 30-min TTL).
//  All amounts at the Parallex boundary are NAIRA strings; internally we use KOBO.
//
//  Required env vars (PARALLEX_TRANSFER_*):
//    BASE_URL        — defaults to production TPT endpoint
//    USERNAME        — /Login username
//    PASSWORD        — /Login password (plain text, NOT base64)
//    SUBKEY          — APIM subscription key for the Transfer product
//    DEBIT_ACCOUNT   — our payout float account number (e.g. 1000362849)
//    BANK_CODE       — Parallex's own institution code, default 999015
//    LOCATION        — transactionLocation string, default 'Lagos'
//
//  Rail adapter contract (payoutRailAdapter.js):
//    isConfigured()      → bool
//    getBalance()        → BigInt kobo
//    sendPayout(item)    → { ok, code, reason, orderStatus, providerRef, raw }
//    queryPayoutResult() → { ok, code, reason, orderStatus, raw }
//    nameEnquiry()       → { ok, accountName, sessionId, kycLevel, reason, raw }
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL      = (process.env.PARALLEX_TRANSFER_BASE_URL || 'https://tptintegration.parallexbank.com/ThirdPartyTransferAPI').replace(/\/$/, '');
const USERNAME      = process.env.PARALLEX_TRANSFER_USERNAME  || '';
const PASSWORD      = process.env.PARALLEX_TRANSFER_PASSWORD  || '';
const SUBKEY        = process.env.PARALLEX_TRANSFER_SUBKEY    || '';
const DEBIT_ACCOUNT = process.env.PARALLEX_TRANSFER_DEBIT_ACCOUNT || '';
const BANK_CODE     = process.env.PARALLEX_TRANSFER_BANK_CODE || '999015';
const LOCATION      = process.env.PARALLEX_TRANSFER_LOCATION  || 'Lagos';
const SUBKEY_HEADER = process.env.PARALLEX_TRANSFER_SUBKEY_HEADER || 'Ocp-Apim-Subscription-Key';

// Response-code classification.
// '00' = success. Treat any unknown code as in-flight (safer than refunding a
// transfer that may have settled on Parallex's side).
const FAIL_CODES    = new Set(['05', '06', '12', '16', '51', '57', '94', '95', '96', '97']);
const PENDING_CODES = new Set(['09', '25', '26', '99']);

// CBN 3-digit codes → 6-digit NIP institution codes.
const INSTITUTION_CODE_MAP = {
  '328': '100004',  // OPay
  '305': '100004',  // OPay (alt CBN code)
  '999991': '100003', // PalmPay
  '090267': '100002', // Kuda Bank
  '50515': '110005',  // Moniepoint (alt CBN code)
  '330':   '110005',  // Moniepoint MFB (CBN code in our bank table)
  '044': '000014',  // Access Bank
  '058': '000013',  // GTBank
  '057': '000015',  // Zenith Bank
  '011': '000016',  // First Bank
  '033': '000004',  // UBA
  '035': '000017',  // Wema Bank
  '232': '000001',  // Sterling Bank
  '214': '000003',  // FCMB (First City Monument Bank)
  '070': '000007',  // Fidelity Bank
  '221': '000012',  // Stanbic IBTC Bank
  '335': '100007',  // Fairmoney MFB
};
const toNipCode = (code) => INSTITUTION_CODE_MAP[String(code)] || String(code);

// ── Naira ↔ kobo ────────────────────────────────────────────────────────────
const nairaFromKobo = (kobo) => (Number(kobo) / 100).toString();
const koboFromNaira = (naira) => BigInt(Math.round(Number(naira) * 100));

// ── Read responseCode from either flat or nested Parallex envelope ───────────
const codeOf = (r) => String((r && (r.responseCode ?? r.ResponseCode ?? r.statusCode)) ?? '');
const msgOf  = (r) => (r && (r.responseMessage || r.responseDescription || r.ResponseDescription || r.message)) || '';

function isConfigured() {
  return !!(USERNAME && PASSWORD && SUBKEY && DEBIT_ACCOUNT);
}

// ── Base headers (every request including /Login) ────────────────────────────
// Connection: close — forces a fresh TCP connection per request. Required because
// the VPN tunnel can desync keep-alive connections causing node fetch to hang.
function baseHeaders() {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Connection': 'close',
  };
  if (SUBKEY) h[SUBKEY_HEADER] = SUBKEY;
  return h;
}

// ── JWT token cache with in-flight de-dupe ───────────────────────────────────
let _token = null, _tokenExp = 0, _loginInflight = null;

async function doLogin() {
  const loginBody = JSON.stringify({ userName: USERNAME, password: PASSWORD });
  const { status, json: r } = await httpsRequest('POST', `${BASE_URL}/api/ThirdPartyTransfer/Login`, baseHeaders(), loginBody, 30);
  if (codeOf(r) !== '00' || !r.token) {
    throw new Error(`Parallex TPT login failed: ${msgOf(r) || codeOf(r)} (HTTP ${status})`);
  }
  _token = r.token;
  const exp = Date.parse(String(r.expiration || '').replace(' ', 'T'));
  _tokenExp = Number.isFinite(exp) ? exp - 120_000 : Date.now() + 28 * 60_000;
  return _token;
}

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  if (!_loginInflight) _loginInflight = doLogin().finally(() => { _loginInflight = null; });
  return _loginInflight;
}

// ── Authenticated HTTP call ──────────────────────────────────────────────────
// Retries once on HTTP 401 (stale token). Timeout 180s — InterbankTransfer can
// be slow. If the server RSTs before our timer fires, fetch throws 'fetch failed'.
// Uses curl directly — proven to work through WireGuard VPN, HTTP/1.1, no pooling.
// maxTime controls --max-time (curl wall-clock cap). --connect-timeout 10 catches
// dead VPN routes in 10 s instead of waiting for the full maxTime.
// On connection failure (HTTP 0) retries up to 2× with backoff — the WG relay
// can transiently drop a connection under concurrent load.
async function httpsRequest(method, urlStr, headers, bodyStr, maxTime = 120) {
  const args = ['-s', '-w', '\n__STATUS__%{http_code}', '-X', method];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push('-H', 'Connection: close');
  if (bodyStr) { args.push('-H', 'Content-Type: application/json', '-d', bodyStr); }
  args.push('--connect-timeout', '10', '--max-time', String(maxTime), urlStr);
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const { stdout } = await execFileAsync('curl', args, { timeout: (maxTime + 5) * 1000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      const sep  = stdout.lastIndexOf('\n__STATUS__');
      const body = sep >= 0 ? stdout.slice(0, sep) : stdout;
      const status = sep >= 0 ? parseInt(stdout.slice(sep + 11), 10) : 200;
      try { return { status, json: JSON.parse(body) }; }
      catch (_) { return { status, json: { responseCode: 'PARSE', responseMessage: `Non-JSON HTTP ${status}` } }; }
    } catch (e) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return { status: 0, json: { responseCode: 'FETCH_FAILED', responseMessage: e.message } };
    }
  }
}

async function call(method, path, { body, query, maxTime = 120 } = {}) {
  if (!isConfigured()) throw new Error('Parallex TPT not configured — set PARALLEX_TRANSFER_* env vars');

  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const url = `${BASE_URL}${path}${qs}`;
  const bodyStr = body ? JSON.stringify(body) : undefined;

  const doRequest = async (tok) => {
    const headers = { ...baseHeaders(), Authorization: `Bearer ${tok}` };
    try {
      return await httpsRequest(method, url, headers, bodyStr, maxTime);
    } catch (err) {
      if (err.name === 'TimeoutError') {
        return { status: 408, json: { responseCode: 'TIMEOUT', responseMessage: `Request timed out after ${maxTime}s` } };
      }
      throw err;
    }
  };

  let { status, json } = await doRequest(await getToken());

  if (status === 401) {
    _token = null;
    ({ json } = await doRequest(await getToken()));
  }

  return json;
}

// ── Balance ──────────────────────────────────────────────────────────────────
async function getBalance() {
  const r = await call('GET', '/api/ThirdPartyTransfer/GetBalance', {
    query: DEBIT_ACCOUNT ? { accountNumber: DEBIT_ACCOUNT } : undefined,
    maxTime: 30,
  });
  if (codeOf(r) !== '00') throw new Error(`Parallex balance failed: ${msgOf(r) || codeOf(r)}`);
  const amt = r.responseDetails?.balAmt?.amountValue;
  return koboFromNaira(amt || 0);
}

// ── Bank list ────────────────────────────────────────────────────────────────
async function getBanks() {
  const r = await call('GET', '/api/ThirdPartyTransfer/GetBanks', { maxTime: 20 });
  const banks = Array.isArray(r) ? r
    : (r?.banks || r?.data?.banks || r?.data || []);
  return { ok: banks.length > 0 || codeOf(r) === '00', banks, raw: r };
}

// Lazy bank-name cache for InterbankTransfer (requires BeneficiaryBankName).
let _bankNames = null;
async function resolveBankName(nipCode) {
  if (!_bankNames) {
    _bankNames = {};
    try {
      const { banks } = await getBanks();
      for (const b of banks) {
        if (b.institutionCode) _bankNames[b.institutionCode] = b.institutionName || '';
      }
    } catch (_) {}
  }
  return _bankNames[String(nipCode)] || '';
}

// ── Name enquiry ─────────────────────────────────────────────────────────────
// Returns requestId as sessionId — required by InterbankTransfer (min 30 chars).
async function nameEnquiry(bankCode, accountNumber) {
  const r = await call('GET', '/api/ThirdPartyTransfer/NameEnquiry', {
    query: { accountNumber, bankCode: toNipCode(bankCode) || BANK_CODE },
    maxTime: 15,
  });
  return {
    ok: codeOf(r) === '00' && !!r.accountName,
    accountName: r.accountName || null,
    sessionId: r.requestId || r.sessionId || null,
    kycLevel: r.kycLevel || null,
    reason: msgOf(r),
    raw: r,
  };
}

// ── Map Parallex response → rail-adapter result ───────────────────────────────
function toRailResult(r) {
  const code = codeOf(r);
  const reason = msgOf(r) || `code ${code}`;
  if (code === '00') return { ok: true, code, reason, orderStatus: '2' };
  if (FAIL_CODES.has(code)) {
    return {
      ok: false, code, reason, orderStatus: null,
      isLowBalance: /insufficient|balance|fund|limit/i.test(reason) || ['05', '51'].includes(code),
    };
  }
  // Pending / unknown → treat as in-flight (reconcile via TransactionQuery)
  return { ok: true, code, reason, orderStatus: '1' };
}

// ── Payout (main rail contract method) ───────────────────────────────────────
// item = { orderId, amount(kobo), bank_code, account_number, account_name, narration }
async function sendPayout(item) {
  const beneficiaryBankCode = String(item.bank_code || '').trim();
  const amountNaira = nairaFromKobo(item.amount);
  const isIntra = !beneficiaryBankCode || beneficiaryBankCode === BANK_CODE;

  let r;

  if (isIntra) {
    // ── Intrabank (Parallex → Parallex) ────────────────────────────────────
    r = await call('POST', '/api/ThirdPartyTransfer/IntrabankTransfer', {
      maxTime: 60,
      body: {
        accountToDebit: DEBIT_ACCOUNT,
        channel: '1',
        intraTransferDetails: [{
          amount: amountNaira,
          beneficiaryAccountName: item.account_name || '',
          beneficiaryAccountNumber: item.account_number,
          transactionReference: item.orderId,
          transactionDate: (() => {
            const d = new Date();
            return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
          })(),
          narration: item.narration || undefined,
        }],
        transactionLocation: LOCATION,
        userName: USERNAME,
      },
    });
  } else {
    // ── Interbank (NIP) ─────────────────────────────────────────────────────
    const nipCode = toNipCode(beneficiaryBankCode);

    // NE sessionId is required by InterbankTransfer. If the caller pre-ran NE
    // (item.neSessionId set), use it directly — avoids an extra VPN round trip
    // per leg and halves dispatch time for pre-verified beneficiary batches.
    let neSessionId  = item.neSessionId  || null;
    let neAccountName = item.neAccountName || null;
    let neKycLevel   = item.neKycLevel   || '';

    if (!neSessionId) {
      let ne = await nameEnquiry(nipCode, item.account_number);
      if (!ne.ok || !ne.sessionId) {
        // one automatic retry after 3s, then abort
        await new Promise(r => setTimeout(r, 3000));
        ne = await nameEnquiry(nipCode, item.account_number);
      }
      if (!ne.ok || !ne.sessionId) {
        return {
          ok: false,
          code: 'NE_FAILED',
          reason: `Name enquiry failed: ${ne.reason || 'no session ID'}`,
          orderStatus: null,
        };
      }
      neSessionId   = ne.sessionId;
      neAccountName = ne.accountName;
      neKycLevel    = ne.kycLevel || '';
    }

    const bankName = await resolveBankName(nipCode);

    // Transfer
    r = await call('POST', '/api/ThirdPartyTransfer/InterbankTransfer', {
      maxTime: 120,
      body: {
        accountToDebit: DEBIT_ACCOUNT,
        channel: '1',
        interTransferDetails: [{
          amount: amountNaira,
          beneficiaryAccountName: item.account_name || neAccountName || '',
          beneficiaryAccountNumber: item.account_number,
          beneficiaryBankCode: nipCode,
          beneficiaryBankName: bankName,
          nameEnquirySessionID: neSessionId,
          transactionReference: item.orderId,
          beneficiaryBVN: null,
          beneficiaryKYC: neKycLevel,
          customerRemark: item.narration || undefined,
        }],
        transactionLocation: LOCATION,
        userName: USERNAME,
      },
    });
  }

  // Interbank response can nest the result under Data
  const inner = r?.Data || r?.data;
  const settle = (inner && codeOf(inner)) ? inner : r;
  const out = toRailResult(settle);
  return {
    ...out,
    providerRef: settle?.transactionReference || item.orderId,
    raw: r,
  };
}

// ── Payout requery (reconciliation backstop) ─────────────────────────────────
async function queryPayoutResult({ orderId, amount, accountNumber, bankCode } = {}) {
  const r = await call('POST', '/api/ThirdPartyTransfer/TransactionQuery', {
    maxTime: 45,
    body: {
      accountToDebit: DEBIT_ACCOUNT,
      userName: USERNAME,
      transactionReference: orderId,
      amount: amount != null ? Number(nairaFromKobo(amount)) : undefined,
      beneficiaryAccountNumber: accountNumber || undefined,
      beneficiaryBankCode: bankCode || undefined,
    },
  });
  const out = toRailResult(r);
  return {
    ok: true,
    code: out.code,
    reason: out.reason,
    orderStatus: out.orderStatus,
    raw: r,
  };
}

module.exports = {
  isConfigured,
  getBalance,
  getBanks,
  nameEnquiry,
  sendPayout,
  queryPayoutResult,
  nairaFromKobo,
  koboFromNaira,
  BASE_URL,
  call,
};
