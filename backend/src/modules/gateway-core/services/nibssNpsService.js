'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  NIBSS National Payment Stack (NPS) client — scaffold, built ahead of keys.
//
//  NPS is NIBSS's ISO 20022 replacement for NIP (NIP spoke SOAP; NPS speaks
//  ISO 20022). One rail carries three of our products:
//    • PAYOUT            — pacs.008 credit transfer, pacs.002 status, camt.056 recall
//    • VIRTUAL ACCOUNTS  — NUBAN provisioning + camt.054 credit notifications
//    • IDENTITY (KYC)    — BVN / RC / TIN  → see services/nibssKycService.js
//
//  ⚠️  ENDPOINT PATHS AND FIELD NAMES BELOW ARE UNCONFIRMED. The NPS portal
//  (https://nps-documentation.nibss-plc.com.ng) is IP-allowlisted — it is not
//  reachable until our IP Form is processed, so the wire contract here is built
//  from the ISO 20022 message definitions NPS is specified against. EVERY path is
//  env-overridable (NIBSS_NPS_*_PATH) so the first sandbox run can correct any of
//  them WITHOUT a code change. Response parsing is deliberately tolerant: it
//  accepts both the nested ISO shape and a flattened REST shape.
//
//  Nothing here calls out until NIBSS_NPS_CLIENT_ID + NIBSS_NPS_PRIVATE_KEY are
//  set — isConfigured() gates the rail adapter, exactly as PalmPay/Parallex do.
//
//  Auth (per the NPS brief: "digital signatures and multi-factor authentication"):
//    1. OAuth2 client-credentials → Bearer token (cached until 60s before expiry)
//    2. A DETACHED RSA-SHA256 signature over the canonical request body, sent in
//       the `Signature` header, plus `X-Request-Id` / `X-Institution-Code`.
//  Inbound callbacks carry NIBSS's own signature, verified with their public key.
//
//  AMOUNTS: ISO 20022 carries decimal currency units (NGN with 2dp). Internally
//  Paylode is KOBO everywhere — convert at this boundary ONLY.
//
//  Rail adapter contract (services/payoutRailAdapter.js):
//    isConfigured()      → bool
//    getBalance()        → BigInt kobo
//    sendPayout(item)    → { ok, code, reason, isLowBalance, orderStatus, providerRef, raw }
//    queryPayoutResult() → { ok, code, reason, orderStatus, sessionId, raw }
//    nameEnquiry()       → { ok, accountName, sessionId, bvn, kycLevel, reason, raw }
//    getBanks()          → [{ name, code }]
//
//  Config (env):
//    NIBSS_NPS_BASE_URL          default sandbox gateway
//    NIBSS_NPS_AUTH_URL          OAuth2 token endpoint (defaults to BASE_URL)
//    NIBSS_NPS_CLIENT_ID         OAuth2 client id
//    NIBSS_NPS_CLIENT_SECRET     OAuth2 client secret
//    NIBSS_NPS_PRIVATE_KEY       our RSA private key (PEM or bare base64) — signs requests
//    NIBSS_NPS_PUBLIC_KEY        NIBSS's public key — verifies inbound callbacks
//    NIBSS_NPS_INSTITUTION_CODE  our 6-digit NIP/NPS institution code (via sponsor bank)
//    NIBSS_NPS_DEBIT_ACCOUNT     our payout float NUBAN held at the sponsor bank
//    NIBSS_NPS_DEBIT_NAME        name on that float account (Dbtr.Nm)
//    NIBSS_NPS_CHANNEL_CODE      NPS channel code, default '1' (internet banking)
//    NIBSS_NPS_NOTIFY_URL        our webhook base for NPS callbacks
//    NIBSS_NPS_TIMEOUT_MS        per-call timeout, default 30000
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const BASE_URL   = (process.env.NIBSS_NPS_BASE_URL || 'https://nps-sandbox.nibss-plc.com.ng').replace(/\/$/, '');
const AUTH_URL   = (process.env.NIBSS_NPS_AUTH_URL || BASE_URL).replace(/\/$/, '');
const CLIENT_ID  = process.env.NIBSS_NPS_CLIENT_ID     || '';
const CLIENT_SEC = process.env.NIBSS_NPS_CLIENT_SECRET || '';
const PRIVATE_KEY = process.env.NIBSS_NPS_PRIVATE_KEY || '';
const PUBLIC_KEY  = process.env.NIBSS_NPS_PUBLIC_KEY  || '';
const INSTITUTION = process.env.NIBSS_NPS_INSTITUTION_CODE || '';
const DEBIT_ACCT  = process.env.NIBSS_NPS_DEBIT_ACCOUNT || '';
const DEBIT_NAME  = process.env.NIBSS_NPS_DEBIT_NAME || 'Paylode Services';
const CHANNEL     = process.env.NIBSS_NPS_CHANNEL_CODE || '1';
const TIMEOUT_MS  = Number(process.env.NIBSS_NPS_TIMEOUT_MS || 30000);

// Every path env-overridable — see the ⚠️ note above.
const PATHS = {
  token:      process.env.NIBSS_NPS_TOKEN_PATH       || '/oauth2/token',
  nameEnq:    process.env.NIBSS_NPS_NAME_ENQUIRY_PATH || '/nps/api/v1/acmt023',  // IdentificationVerificationRequest
  transfer:   process.env.NIBSS_NPS_TRANSFER_PATH    || '/nps/api/v1/pacs008',   // FIToFICustomerCreditTransfer
  status:     process.env.NIBSS_NPS_STATUS_PATH      || '/nps/api/v1/pacs028',   // FIToFIPaymentStatusRequest
  recall:     process.env.NIBSS_NPS_RECALL_PATH      || '/nps/api/v1/camt056',   // PaymentCancellationRequest
  balance:    process.env.NIBSS_NPS_BALANCE_PATH     || '/nps/api/v1/camt052',   // BankToCustomerAccountReport
  banks:      process.env.NIBSS_NPS_BANKS_PATH       || '/nps/api/v1/institutions',
  vaCreate:   process.env.NIBSS_NPS_VA_CREATE_PATH   || '/nps/api/v1/virtual-accounts',
  vaQuery:    process.env.NIBSS_NPS_VA_QUERY_PATH    || '/nps/api/v1/virtual-accounts/query',
};

function isConfigured() { return !!(CLIENT_ID && PRIVATE_KEY); }

// ── crypto helpers ───────────────────────────────────────────────────────────
function toPem(key, label) {
  if (!key) return key;
  if (key.includes('-----BEGIN')) return key;
  const body = key.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// Canonical form signed by BOTH sides: the exact JSON bytes on the wire. Using the
// serialised body (not a re-sorted projection) keeps us byte-identical with what
// NIBSS receives, so a field we don't model can never silently break the signature.
function signBody(json) {
  const s = crypto.createSign('RSA-SHA256');
  s.update(json, 'utf8');
  return s.sign(toPem(PRIVATE_KEY, 'PRIVATE KEY'), 'base64');
}
function verifyBody(json, signature) {
  if (!PUBLIC_KEY || !signature) return false;
  const v = crypto.createVerify('RSA-SHA256');
  v.update(json, 'utf8');
  try { return v.verify(toPem(PUBLIC_KEY, 'PUBLIC KEY'), signature, 'base64'); }
  catch (e) { return false; }
}
// Verify an inbound NPS callback. Express gives us the parsed body, so re-serialise
// it; when the raw bytes were preserved (rawBody, see the webhook route) prefer them
// — re-serialisation can reorder keys and break an otherwise valid signature.
function verifyCallback(body, signature, rawBody) {
  const json = rawBody != null ? String(rawBody) : JSON.stringify(body || {});
  return verifyBody(json, signature);
}

// ── ISO 20022 identifiers ────────────────────────────────────────────────────
// MsgId/InstrId must be unique per message and <=35 chars (ISO 20022 Max35Text).
function msgId(prefix) {
  return `${prefix}${Date.now()}${crypto.randomBytes(4).toString('hex')}`.slice(0, 35);
}
function isoDateTime(d) { return (d || new Date()).toISOString().replace(/\.(\d{3})Z$/, '.$1Z'); }
// Kobo (internal) ↔ decimal NGN string (ISO 20022 ActiveCurrencyAndAmount).
function nairaFromKobo(kobo) { return (Number(kobo) / 100).toFixed(2); }
function koboFromNaira(naira) { return BigInt(Math.round(Number(naira || 0) * 100)); }

// ── OAuth2 token (cached until 60s before expiry) ────────────────────────────
let _token = null;
async function getAccessToken() {
  if (_token && Date.now() < _token.expiresAt) return _token.value;
  if (!isConfigured()) throw new Error('NIBSS NPS not configured — set NIBSS_NPS_CLIENT_ID and NIBSS_NPS_PRIVATE_KEY');
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SEC}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(AUTH_URL + PATHS.token, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Basic ' + basic,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  const tok = data.access_token;
  if (!tok) throw new Error('NPS token request failed (HTTP ' + res.status + '): ' + JSON.stringify(data).slice(0, 300));
  _token = { value: tok, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 - 60000 };
  return tok;
}
function resetToken() { _token = null; }   // test seam + 401 retry

// ── signed request ───────────────────────────────────────────────────────────
// Returns the parsed JSON envelope. Never throws on a non-2xx — callers classify
// from the returned body so a rail error is recorded, not swallowed as a crash.
async function call(path, body = {}, { method = 'POST', retryOn401 = true } = {}) {
  const token = await getAccessToken();
  const json = JSON.stringify(body);
  const requestId = msgId('REQ');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        Signature: signBody(json),
        'X-Request-Id': requestId,
        'X-Institution-Code': INSTITUTION,
        'X-Channel-Code': CHANNEL,
      },
      body: method === 'GET' ? undefined : json,
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  // An expired token looks like a hard failure; refresh once and replay.
  if (res.status === 401 && retryOn401) {
    resetToken();
    return call(path, body, { method, retryOn401: false });
  }
  const parsed = await res.json().catch(() => null);
  if (parsed == null) return { httpStatus: res.status, _parseError: true, reason: 'Non-JSON response (HTTP ' + res.status + ')' };
  parsed.httpStatus = res.status;
  return parsed;
}

// ── response helpers (tolerant of nested ISO vs flattened REST) ──────────────
function firstOf(v) { return Array.isArray(v) ? v[0] : v; }
function dig(obj, ...paths) {
  for (const p of paths) {
    let cur = obj, okPath = true;
    for (const seg of p.split('.')) {
      cur = firstOf(cur);
      if (cur == null || typeof cur !== 'object' || !(seg in cur)) { okPath = false; break; }
      cur = cur[seg];
    }
    const val = firstOf(cur);
    if (okPath && val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
}
// ISO 20022 amounts appear as either { Ccy, value } or a bare number/string.
function amountOf(v) {
  const a = firstOf(v);
  if (a == null) return undefined;
  if (typeof a === 'object') return a.value !== undefined ? a.value : a.Amt !== undefined ? a.Amt : undefined;
  return a;
}

// ── payout status mapping ────────────────────────────────────────────────────
// ISO 20022 pacs.002 TxSts → the numeric orderStatus the money core already
// understands (payoutSettle.legStatusFor: '2' success · '1'/'0' still in flight ·
// anything else failed). Unknown codes deliberately map to IN-FLIGHT, never
// failed — refunding a transfer that may have settled at NIBSS is the one
// unrecoverable mistake here; the stuck-'sent' poller will resolve it.
const TX_STS_SUCCESS = new Set(['ACSC', 'ACCC']);                       // settled / credited
const TX_STS_FAILED  = new Set(['RJCT', 'CANC', 'RVSD', 'EXPI']);       // rejected / cancelled / reversed
const TX_STS_PENDING = new Set(['ACTC', 'ACSP', 'ACWC', 'ACCP', 'PDNG', 'RCVD', 'PART']);

function orderStatusFor(txSts) {
  const s = String(txSts || '').toUpperCase();
  if (TX_STS_SUCCESS.has(s)) return '2';
  if (TX_STS_FAILED.has(s))  return '3';   // any non-0/1/2 ⇒ 'failed' downstream
  if (TX_STS_PENDING.has(s)) return '1';
  return '1';                              // unknown ⇒ in flight, let the poller decide
}

// Pull TxSts out of a pacs.002 (nested) or a flat { status } response.
function txStatusOf(r) {
  return dig(r,
    'FIToFIPmtStsRpt.TxInfAndSts.TxSts', 'TxInfAndSts.TxSts', 'Document.FIToFIPmtStsRpt.TxInfAndSts.TxSts',
    'data.TxSts', 'data.status', 'TxSts', 'status', 'transactionStatus');
}
// Rejection reason: StsRsnInf.Rsn.Cd + AddtlInf, or a flat message.
function reasonOf(r) {
  const cd = dig(r, 'FIToFIPmtStsRpt.TxInfAndSts.StsRsnInf.Rsn.Cd', 'TxInfAndSts.StsRsnInf.Rsn.Cd', 'data.reasonCode', 'reasonCode');
  const txt = dig(r, 'FIToFIPmtStsRpt.TxInfAndSts.StsRsnInf.AddtlInf', 'TxInfAndSts.StsRsnInf.AddtlInf',
    'data.message', 'message', 'responseMessage', 'error.message', 'reason');
  return [cd, txt].filter(Boolean).join(' — ') || '';
}
// NPS end-to-end reference — our NIP "session ID" equivalent, used for recon + recall.
function sessionIdOf(r) {
  return dig(r,
    'FIToFIPmtStsRpt.TxInfAndSts.OrgnlEndToEndId', 'TxInfAndSts.OrgnlEndToEndId',
    'CdtTrfTxInf.PmtId.EndToEndId', 'data.endToEndId', 'data.sessionId', 'endToEndId', 'sessionId') || null;
}
// NIBSS's own handle on the message (TxId / MsgId) — our providerRef.
function providerRefOf(r) {
  return dig(r,
    'FIToFIPmtStsRpt.TxInfAndSts.OrgnlTxId', 'TxInfAndSts.OrgnlTxId',
    'FIToFIPmtStsRpt.GrpHdr.MsgId', 'GrpHdr.MsgId', 'data.transactionId', 'data.reference', 'transactionId') || null;
}
// NPS is up but refused the message itself (admi.002 MessageReject / HTTP error).
function callFailed(r) {
  return !!(r && (r._parseError || (r.httpStatus && r.httpStatus >= 400)));
}

// ── ISO 20022 message builders (exported for unit tests) ─────────────────────
function groupHeader(prefix, { nbOfTxs = '1', totalAmt } = {}) {
  const hdr = {
    MsgId: msgId(prefix),
    CreDtTm: isoDateTime(),
    NbOfTxs: String(nbOfTxs),
    SttlmInf: { SttlmMtd: 'CLRG' },
    InstgAgt: { FinInstnId: { ClrSysMmbId: { MmbId: INSTITUTION } } },
  };
  if (totalAmt !== undefined) hdr.TtlIntrBkSttlmAmt = { Ccy: 'NGN', value: totalAmt };
  return hdr;
}

// acmt.023 IdentificationVerificationRequest — name enquiry before we move money.
function buildNameEnquiry(bankCode, accountNumber) {
  return {
    Assgnmt: { MsgId: msgId('NE'), CreDtTm: isoDateTime(),
      Assgnr: { Agt: { FinInstnId: { ClrSysMmbId: { MmbId: INSTITUTION } } } },
      Assgne: { Agt: { FinInstnId: { ClrSysMmbId: { MmbId: bankCode } } } } },
    Vrfctn: [{
      Id: msgId('V'),
      PtyAndAcctId: {
        Acct: { Id: { Othr: { Id: accountNumber } } },
        Agt:  { FinInstnId: { ClrSysMmbId: { MmbId: bankCode } } },
      },
    }],
  };
}

// pacs.008 FIToFICustomerCreditTransfer — the payout itself.
// endToEndId is OUR rail_order_id: it is what pacs.002 echoes back and what the
// stuck-'sent' poller queries on, so it must stay stable for the leg's lifetime.
function buildCreditTransfer({ orderId, amountKobo, bankCode, accountNumber, accountName, narration, bvn, kycLevel }) {
  const amount = nairaFromKobo(amountKobo);
  return {
    GrpHdr: groupHeader('PO', { totalAmt: amount }),
    CdtTrfTxInf: [{
      PmtId: { InstrId: String(orderId).slice(0, 35), EndToEndId: String(orderId).slice(0, 35), TxId: String(orderId).slice(0, 35) },
      PmtTpInf: { LclInstrm: { Prtry: 'NPS' }, CtgyPurp: { Cd: 'CASH' } },
      IntrBkSttlmAmt: { Ccy: 'NGN', value: amount },
      IntrBkSttlmDt: new Date().toISOString().slice(0, 10),
      ChrgBr: 'SLEV',
      Dbtr:     { Nm: DEBIT_NAME },
      DbtrAcct: { Id: { Othr: { Id: DEBIT_ACCT } }, Ccy: 'NGN' },
      DbtrAgt:  { FinInstnId: { ClrSysMmbId: { MmbId: INSTITUTION } } },
      CdtrAgt:  { FinInstnId: { ClrSysMmbId: { MmbId: bankCode } } },
      Cdtr:     Object.assign({ Nm: accountName || '' },
                  bvn ? { Id: { PrvtId: { Othr: [{ Id: bvn, SchmeNm: { Prtry: 'BVN' } }] } } } : {}),
      CdtrAcct: Object.assign({ Id: { Othr: { Id: accountNumber } } }, kycLevel ? { Tp: { Prtry: String(kycLevel) } } : {}),
      RmtInf:   { Ustrd: [String(narration || 'Payout').slice(0, 140)] },
    }],
  };
}

// pacs.028 FIToFIPaymentStatusRequest — "what happened to this transfer?"
function buildStatusRequest(orderId) {
  return {
    GrpHdr: groupHeader('ST'),
    TxInf: [{
      OrgnlInstrId: String(orderId).slice(0, 35),
      OrgnlEndToEndId: String(orderId).slice(0, 35),
      OrgnlTxId: String(orderId).slice(0, 35),
    }],
  };
}

// camt.056 FIToFIPaymentCancellationRequest — recall a sent transfer.
function buildRecall({ orderId, amountKobo, reasonCode = 'DUPL', additionalInfo }) {
  return {
    Assgnmt: { Id: msgId('RC'), CreDtTm: isoDateTime(),
      Assgnr: { Agt: { FinInstnId: { ClrSysMmbId: { MmbId: INSTITUTION } } } } },
    Undrlyg: [{
      TxInf: [{
        OrgnlEndToEndId: String(orderId).slice(0, 35),
        OrgnlTxId: String(orderId).slice(0, 35),
        OrgnlIntrBkSttlmAmt: { Ccy: 'NGN', value: nairaFromKobo(amountKobo) },
        CxlRsnInf: [{ Rsn: { Cd: reasonCode }, AddtlInf: additionalInfo ? [String(additionalInfo).slice(0, 105)] : undefined }],
      }],
    }],
  };
}

// ── PAYOUT (rail adapter) ────────────────────────────────────────────────────

// acmt.023 → acmt.024 IdentificationVerificationReport.
// Returns the beneficiary's BVN + KYC level when NPS supplies them: pacs.008
// carries both, and a tier-1 account silently caps what it may receive, so the
// dispatcher passes them straight through (see nePrefetch in payouts.js).
async function nameEnquiry(bankCode, accountNumber) {
  const r = await call(PATHS.nameEnq, buildNameEnquiry(bankCode, accountNumber));
  if (callFailed(r)) return { ok: false, accountName: null, reason: reasonOf(r) || r.reason || 'NPS name enquiry failed', raw: r };
  const verified = dig(r, 'Rpt.Vrfctn', 'IdVrfctnRpt.Rpt.Vrfctn', 'data.verified', 'verified');
  const accountName = dig(r,
    'Rpt.UpdtdPtyAndAcctId.Pty.Nm', 'IdVrfctnRpt.Rpt.UpdtdPtyAndAcctId.Pty.Nm',
    'Rpt.OrgnlPtyAndAcctId.Pty.Nm', 'data.accountName', 'accountName') || null;
  return {
    ok: verified !== false && !!accountName,
    accountName,
    sessionId: sessionIdOf(r),
    bvn: dig(r, 'Rpt.UpdtdPtyAndAcctId.Pty.Id.PrvtId.Othr.Id', 'data.bvn', 'bvn') || null,
    kycLevel: dig(r, 'Rpt.UpdtdPtyAndAcctId.Acct.Tp.Prtry', 'data.kycLevel', 'kycLevel') || null,
    reason: accountName ? '' : (reasonOf(r) || 'Account not found'),
    raw: r,
  };
}

// pacs.008. `item` is the shape payouts.js dispatch passes every rail.
async function sendPayout(item) {
  const r = await call(PATHS.transfer, buildCreditTransfer({
    orderId: item.orderId,
    amountKobo: item.amount,
    bankCode: item.bank_code,
    accountNumber: item.account_number,
    accountName: item.account_name,
    narration: item.narration,
    bvn: item.bvn,            // from the name-enquiry prefetch, when available
    kycLevel: item.kycLevel,
  }));
  const reason = reasonOf(r) || (callFailed(r) ? (r.reason || 'NPS transfer failed') : '');
  // A transport/HTTP failure is NOT a rejection — the message may still have been
  // accepted. Report it as not-ok (the leg stays in flight) without a failed status.
  const orderStatus = callFailed(r) ? null : orderStatusFor(txStatusOf(r));
  return {
    ok: !callFailed(r) && orderStatus !== '3',
    code: dig(r, 'FIToFIPmtStsRpt.TxInfAndSts.StsRsnInf.Rsn.Cd', 'data.reasonCode', 'reasonCode') || String(txStatusOf(r) || ''),
    reason,
    // Lets railHealth flag a float top-up instead of blaming the rail.
    isLowBalance: /insufficient|AM04|balance|funds/i.test(reason),
    orderStatus,
    providerRef: providerRefOf(r),
    sessionId: sessionIdOf(r),
    raw: r,
  };
}

// pacs.028 → pacs.002. The backstop for legs stuck 'sent' when the callback never
// lands (services/payoutSettle.reconcileSentPayouts).
async function queryPayoutResult({ orderId } = {}) {
  const r = await call(PATHS.status, buildStatusRequest(orderId));
  if (callFailed(r)) return { ok: false, code: null, reason: reasonOf(r) || r.reason || 'NPS status query failed', raw: r };
  return {
    ok: true,                                  // the QUERY succeeded; orderStatus carries the verdict
    code: String(txStatusOf(r) || ''),
    reason: reasonOf(r),
    orderStatus: orderStatusFor(txStatusOf(r)),
    sessionId: sessionIdOf(r),
    raw: r,
  };
}

// camt.056 — recall a transfer already on the rail. NPS answers asynchronously
// (camt.029 Resolution Of Investigation → our webhook), so a true here means
// "recall accepted for investigation", never "money returned".
async function recallPayout({ orderId, amountKobo, reasonCode, additionalInfo } = {}) {
  const r = await call(PATHS.recall, buildRecall({ orderId, amountKobo, reasonCode, additionalInfo }));
  return { ok: !callFailed(r), reason: reasonOf(r), providerRef: providerRefOf(r), raw: r };
}

// camt.052 BankToCustomerAccountReport → OUR float held at the sponsor bank, kobo.
// Prefers the interim available balance (ITAV/CLAV) over the booked one.
async function getBalance() {
  const r = await call(PATHS.balance, {
    GrpHdr: groupHeader('BAL'),
    Acct: { Id: { Othr: { Id: DEBIT_ACCT } }, Ccy: 'NGN' },
  });
  if (callFailed(r)) throw new Error(reasonOf(r) || r.reason || 'NPS balance query failed');
  const balances = dig(r, 'Rpt.Bal', 'BkToCstmrAcctRpt.Rpt.Bal', 'data.balances', 'balances');
  const list = Array.isArray(balances) ? balances : balances ? [balances] : [];
  const pick = list.find(b => ['ITAV', 'CLAV'].includes(String(dig(b, 'Tp.CdOrPrtry.Cd') || '').toUpperCase())) || list[0];
  const naira = amountOf(pick && pick.Amt) !== undefined
    ? amountOf(pick.Amt)
    : dig(r, 'data.availableBalance', 'availableBalance', 'data.balance');
  if (naira === undefined) throw new Error('NPS balance query returned no balance');
  return koboFromNaira(naira);
}

// The NPS institution directory (our bank list / NIP-code source of truth).
async function getBanks() {
  const r = await call(PATHS.banks, {}, { method: 'GET' });
  if (callFailed(r)) throw new Error(reasonOf(r) || r.reason || 'NPS institution list failed');
  const list = dig(r, 'data.institutions', 'institutions', 'data') || r;
  return (Array.isArray(list) ? list : []).map(b => ({
    name: b.institutionName || b.name || b.Nm,
    code: b.institutionCode || b.code || b.MmbId,
  })).filter(b => b.name && b.code);
}

// ── PAY-IN: virtual accounts ─────────────────────────────────────────────────
// NPS provisions a NUBAN against a verified identity (BVN/NIN for individuals,
// RC for companies) and pushes camt.054 BankToCustomerDebitCreditNotification on
// every credit → our /va-credit webhook.
async function createVirtualAccount({ accountName, identityType, identityNumber, customerName, email, phone, reference, expiresAt, amountKobo }) {
  const r = await call(PATHS.vaCreate, {
    GrpHdr: groupHeader('VA'),
    accountName, identityType, identityNumber,
    customerName: customerName || accountName,
    email: email || undefined,
    phoneNumber: phone || undefined,
    reference: reference || undefined,
    currency: 'NGN',
    // Set BOTH for a one-time, exact-amount account (checkout); omit for a
    // permanent merchant/customer VA.
    expectedAmount: amountKobo !== undefined ? nairaFromKobo(amountKobo) : undefined,
    expiryDate: expiresAt || undefined,
  });
  if (callFailed(r)) throw new Error(reasonOf(r) || r.reason || 'NPS virtual-account create failed');
  return {
    accountNumber: dig(r, 'data.accountNumber', 'accountNumber', 'data.nuban', 'nuban'),
    accountName:   dig(r, 'data.accountName', 'accountName'),
    bankName:      dig(r, 'data.bankName', 'bankName'),
    bankCode:      dig(r, 'data.bankCode', 'bankCode'),
    reference:     dig(r, 'data.reference', 'reference'),
    raw: r,
  };
}
async function queryVirtualAccount(accountNumber) {
  return call(PATHS.vaQuery, { GrpHdr: groupHeader('VAQ'), accountNumber });
}

module.exports = {
  isConfigured, call, getAccessToken, resetToken, BASE_URL, PATHS,
  // signing / callbacks
  signBody, verifyBody, verifyCallback, toPem,
  // payouts (rail adapter contract)
  getBalance, sendPayout, queryPayoutResult, recallPayout, nameEnquiry, getBanks,
  // pay-in
  createVirtualAccount, queryVirtualAccount,
  // ISO 20022 builders + parsing (unit-testable without a network)
  buildNameEnquiry, buildCreditTransfer, buildStatusRequest, buildRecall, groupHeader,
  orderStatusFor, txStatusOf, reasonOf, sessionIdOf, providerRefOf, callFailed, dig, amountOf,
  msgId, isoDateTime, nairaFromKobo, koboFromNaira,
};
