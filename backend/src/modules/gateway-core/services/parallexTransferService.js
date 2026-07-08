'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Parallex Bank — Third Party Transfer (PAYOUT rail) client.
//  Sibling of parallexService.js (that one = Virtual Account / pay-in). This one
//  fits the PAYOUT rail-adapter contract used by payouts.js / payoutSettle.js /
//  railFloat.js: isConfigured() · getBalance() → BigInt kobo · sendPayout(item) ·
//  queryPayoutResult({orderId}) · nameEnquiry(bankCode, acct) · getBanks().
//  DORMANT until env is set — nothing here calls out unless isConfigured().
//
//  Key differences from the VA service (do NOT copy VA assumptions here):
//   • APIM path prefix is `/thirdpartytransfer` (VA has none).
//   • Login password is PLAINTEXT (VA is base64).
//   • Login response is FLAT: top-level `token` + `expiration` + `responseMessage`
//     (VA nests under data.token / data.validTo / responseDescription).
//   • Its OWN subscription key (Transfer subkey ≠ VA subkey).
//   • Money at Parallex = NAIRA strings; our system = KOBO — converted at the boundary.
//
//  Auth = subkey header + Bearer JWT (30-min TTL, cached + auto-refreshed, with an
//  in-flight de-dupe so a burst of parallel payouts triggers ONE /Login, not N).
//
//  Env (all PARALLEX_TRANSFER_*):
//   PARALLEX_TRANSFER_BASE_URL      default https://parallex-apim.azure-api.net/thirdpartytransfer
//   PARALLEX_TRANSFER_USERNAME      /Login username (⚠ working sandbox value: PayloadeVirtualAcc)
//   PARALLEX_TRANSFER_PASSWORD      /Login password PLAINTEXT (NOT base64)
//   PARALLEX_TRANSFER_SUBKEY        APIM subscription key for the Transfer product
//   PARALLEX_TRANSFER_SUBKEY_HEADER default 'Ocp-Apim-Subscription-Key'
//   PARALLEX_TRANSFER_DEBIT_ACCOUNT our settlement/debit account (accountToDebit), e.g. 2001096025
//   PARALLEX_TRANSFER_BANK_CODE     Parallex's own institution code for intra-vs-inter, default 999015
//   PARALLEX_TRANSFER_LOCATION      transactionLocation string, default 'Lagos'
//   PARALLEX_TRANSFER_PENDING_CODES extra responseCodes to treat as in-flight (comma list)
//   PARALLEX_TRANSFER_FAIL_CODES    extra responseCodes to treat as hard-fail (comma list)
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL      = (process.env.PARALLEX_TRANSFER_BASE_URL || 'https://parallex-apim.azure-api.net/thirdpartytransfer').replace(/\/$/, '');
const USERNAME      = process.env.PARALLEX_TRANSFER_USERNAME || '';
const PASSWORD      = process.env.PARALLEX_TRANSFER_PASSWORD || '';
const SUBKEY        = process.env.PARALLEX_TRANSFER_SUBKEY || '';
const SUBKEY_HEADER = process.env.PARALLEX_TRANSFER_SUBKEY_HEADER || 'Ocp-Apim-Subscription-Key';
const DEBIT_ACCOUNT = process.env.PARALLEX_TRANSFER_DEBIT_ACCOUNT || '';
const BANK_CODE     = process.env.PARALLEX_TRANSFER_BANK_CODE || '999015';   // Parallex's own inst. code
const LOCATION      = process.env.PARALLEX_TRANSFER_LOCATION || 'Lagos';

// responseCode buckets. '00' = success. Codes we KNOW are terminal failures →
// refund immediately. Anything else after an accepted HTTP call is treated as
// IN-FLIGHT (leg → 'sent') and reconciled via TransactionQuery — safest for
// money-out, since a wrongly-assumed failure on a transfer that actually went
// through would double-pay on retry. All env-overridable pending TODO-CONFIRM
// of Parallex's real code list.
const codeSet = (v, d) => new Set(String(v == null ? d : v).split(',').map(s => s.trim()).filter(Boolean));
const PENDING_CODES = codeSet(process.env.PARALLEX_TRANSFER_PENDING_CODES, '09,25,26,91,99');
const FAIL_CODES    = codeSet(process.env.PARALLEX_TRANSFER_FAIL_CODES, '05,06,12,51,57,94,95,96,97');

function isConfigured() { return !!(USERNAME && PASSWORD && SUBKEY); }

const nairaFromKobo = (kobo) => (Number(kobo) / 100).toString();       // 500000 -> "5000"
const koboFromNaira = (naira) => BigInt(Math.round(Number(naira) * 100));
// Parallex envelopes are inconsistent: Intrabank/GetBalance are flat (responseCode),
// Interbank wraps in { ResponseCode, Data:{ responseCode } }. Read whichever exists.
const codeOf = (r) => String((r && (r.responseCode ?? r.ResponseCode)) ?? '');
const msgOf  = (r) => (r && (r.responseMessage || r.responseDescription || r.ResponseDescription)) || '';

// Base (non-authed) headers shared by every call, incl. /Login.
function baseHeaders() {
  const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (SUBKEY) h[SUBKEY_HEADER] = SUBKEY;
  return h;
}

// ── token cache (JWT, refreshed 2 min early) with in-flight de-dupe ────────────
let _token = null, _tokenExp = 0, _loginInFlight = null;
async function doLogin() {
  const res = await fetch(BASE_URL + '/api/ThirdPartyTransfer/Login', {
    method: 'POST', headers: baseHeaders(),
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),   // PLAINTEXT (not base64)
  });
  const r = await res.json().catch(() => ({ responseCode: 'PARSE', responseMessage: 'Non-JSON (HTTP ' + res.status + ')' }));
  if (codeOf(r) !== '00' || !r.token)
    throw new Error('Parallex transfer login failed: ' + (msgOf(r) || codeOf(r)));
  _token = r.token;
  const exp = Date.parse(String(r.expiration || '').replace(' ', 'T'));   // server time
  _tokenExp = Number.isFinite(exp) ? exp - 120000 : Date.now() + 28 * 60000;
  return _token;
}
async function token() {
  if (_token && Date.now() < _tokenExp) return _token;
  // A burst of parallel payouts must not each open its own /Login (Parallex may
  // rate-limit / lock the account) — coalesce onto one in-flight login promise.
  if (!_loginInFlight) _loginInFlight = doLogin().finally(() => { _loginInFlight = null; });
  return _loginInFlight;
}

// Authed request. GET carries no body; params ride the query string. Retries ONCE
// on an expired/invalid-token signal (401 / code 90 / code 34).
async function call(method, path, { body, query } = {}) {
  if (!isConfigured()) throw new Error('Parallex transfer not configured — set PARALLEX_TRANSFER_USERNAME/PASSWORD/SUBKEY');
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const doFetch = async (tok) => {
    const res = await fetch(BASE_URL + path + qs, {
      method, headers: Object.assign(baseHeaders(), { Authorization: 'Bearer ' + tok }),
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({ responseCode: 'PARSE', responseMessage: 'Non-JSON (HTTP ' + res.status + ')' }));
    return { status: res.status, json };
  };
  let { status, json } = await doFetch(await token());
  if ((status === 401 || codeOf(json) === '90' || codeOf(json) === '34') && _token) {
    _token = null;                                   // stale token → re-login once
    ({ json } = await doFetch(await token()));
  }
  return json;
}

// ── Rail balance (float) ──────────────────────────────────────────────────────
// GET /GetBalance → responseDetails.balAmt.amountValue (naira string). The live API
// needs our account on the query string (sandbox returned code 95 without it).
async function getBalance() {
  const query = DEBIT_ACCOUNT ? { accountNumber: DEBIT_ACCOUNT } : undefined;
  const r = await call('GET', '/api/ThirdPartyTransfer/GetBalance', { query });
  if (codeOf(r) !== '00') throw new Error('Parallex transfer balance failed: ' + (msgOf(r) || codeOf(r)));
  const amt = r.responseDetails && r.responseDetails.balAmt && r.responseDetails.balAmt.amountValue;
  return koboFromNaira(amt || 0);                    // BigInt kobo
}

// ── Bank list & name enquiry ──────────────────────────────────────────────────
async function getBanks() {
  const r = await call('GET', '/api/ThirdPartyTransfer/GetBanks');
  const banks = Array.isArray(r) ? r : (r && r.data) || [];
  return { ok: Array.isArray(r) || codeOf(r) === '00', banks, raw: r };
}
// GET /NameEnquiry → { responseCode, accountName, requestId }. requestId doubles as
// the nameEnquirySessionID required by InterbankTransfer (TODO-CONFIRM with Parallex).
async function nameEnquiry(bankCode, accountNumber) {
  const r = await call('GET', '/api/ThirdPartyTransfer/NameEnquiry', {
    query: { accountNumber, bankCode: bankCode || BANK_CODE },
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

// Map a Parallex responseCode → the { ok, orderStatus } shape payouts.js expects
// (it reuses PalmPay's scheme: '2' terminal success, '1'/'0'/'' in-flight, ok:false
// hard-fail → refund). '00' → success; known fail codes → ok:false; else in-flight.
function toRailResult(r) {
  const code = codeOf(r), reason = msgOf(r) || `code ${code}`;
  if (code === '00') return { ok: true, code, reason, orderStatus: '2' };
  if (FAIL_CODES.has(code)) return { ok: false, code, reason, orderStatus: null,
    isLowBalance: /insufficient|balance|fund|limit/i.test(reason) || ['05', '51'].includes(code) };
  // Unknown / explicitly-pending → treat as accepted & in flight (reconcile later).
  return { ok: true, code, reason, orderStatus: '1' };
}

// ── Payout (rail contract) ────────────────────────────────────────────────────
// item = { orderId, amount(kobo), bank_code, account_number, account_name, narration }.
// Intrabank (Parallex→Parallex) when the beneficiary bank IS Parallex; otherwise
// Interbank (needs a NameEnquiry session first).
async function sendPayout(item) {
  const beneficiaryBankCode = String(item.bank_code || '').trim();
  const amountNaira = nairaFromKobo(item.amount);
  const isIntra = !beneficiaryBankCode || beneficiaryBankCode === BANK_CODE;

  let r;
  if (isIntra) {
    r = await call('POST', '/api/ThirdPartyTransfer/IntrabankTransfer', {
      body: {
        accountToDebit: DEBIT_ACCOUNT,
        channel: '1',
        intraTransferDetails: [{
          amount: amountNaira,
          beneficiaryAccountName: item.account_name || '',
          beneficiaryAccountNumber: item.account_number,
          transactionReference: item.orderId,
          narration: item.narration || 'Payout',
        }],
        transactionLocation: LOCATION,
        userName: USERNAME,
      },
    });
  } else {
    // Interbank needs a name-enquiry session for the beneficiary bank.
    const ne = await nameEnquiry(beneficiaryBankCode, item.account_number);
    if (!ne.ok || !ne.sessionId)
      return { ok: false, code: ne.raw && codeOf(ne.raw), reason: 'Name enquiry failed: ' + (ne.reason || 'no session'), orderStatus: null };
    r = await call('POST', '/api/ThirdPartyTransfer/InterbankTransfer', {
      body: {
        accountToDebit: DEBIT_ACCOUNT,
        channel: '0',
        interTransferDetails: [{
          amount: amountNaira,
          beneficiaryAccountName: item.account_name || ne.accountName || '',
          beneficiaryAccountNumber: item.account_number,
          beneficiaryBankCode,
          nameEnquirySessionID: ne.sessionId,
          transactionReference: item.orderId,
          beneficiaryKYC: ne.kycLevel || '0',
          customerRemark: item.narration || 'Payout',
        }],
        transactionLocation: LOCATION,
        userName: USERNAME,
      },
    });
  }

  // Interbank nests the settle result under Data; read from there when present.
  const inner = r && (r.Data || r.data);
  const settle = inner && (inner.responseCode || inner.ResponseCode) ? inner : r;
  const out = toRailResult(settle);
  return {
    ...out,
    providerRef: (settle && settle.transactionReference) || item.orderId,
    raw: r,
  };
}

// ── Payout requery (reconcile backstop) ───────────────────────────────────────
// POST /TransactionQuery → same code scheme. Returns the { ok, orderStatus } that
// payoutSettle.applyPayoutResult maps via legStatusFor (2=success, 1/0=pending).
async function queryPayoutResult({ orderId, amount, accountNumber, bankCode } = {}) {
  const r = await call('POST', '/api/ThirdPartyTransfer/TransactionQuery', {
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
    ok: true,                                        // the QUERY itself succeeded (HTTP/JSON ok)
    code: out.code,
    reason: out.reason,
    orderStatus: out.orderStatus,                    // '2' success · '1' pending · null hard-fail
    sessionId: (r && r.sessionId) || null,
    raw: r,
  };
}

module.exports = {
  isConfigured, call, BASE_URL,
  getBalance, getBanks, nameEnquiry, sendPayout, queryPayoutResult,
  nairaFromKobo, koboFromNaira,
};
