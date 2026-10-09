'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Hydrogen ISO 20022 Funds Transfer service — account-number-based interbank
//  transfer switch (spec: "TECHNICAL SPECIFICATION DOCUMENT FOR FUNDS
//  TRANSFER", Hydrogen, 2025-10-28).
//
//  Outbound path: pacs.008 PGP-encrypted (binary→hex) inside xenc → Hydrogen
//  Name enquiry:  acmt.023 PGP-encrypted (binary→hex) inside xenc → Hydrogen
//  Status query:  pacs.028 PGP-encrypted (binary→hex) inside xenc → Hydrogen
//  Balance:       JSON payload, same PGP binary→hex wrapping, application/xml.
//
//  Encryption scheme confirmed by Hydrogen support:
//    1. Build the plaintext ISO20022 XML content element (e.g. <IdVrfctnReq>,
//       <FIToFICstmrCdtTrf>, <FIToFIPmtStsReq>).
//    2. PGP-encrypt the inner XML with Hydrogen's RSA-2048 public key, producing
//       raw binary output (NOT ASCII-armored). Convert the binary directly to
//       uppercase hex. Do NOT base64/armor the output first.
//    3. Wrap as <xenc:EncryptedData><xenc:CipherData><xenc:CipherValue>
//       {UPPERCASE HEX}</xenc:CipherValue></xenc:CipherData></xenc:EncryptedData>
//       inside the content element.
//    Inbound responses reverse this: Hydrogen encrypts responses with our public
//    key; CipherValue contains hex-encoded binary PGP; decryptContentElement
//    handles both hex and armored formats.
//
//  Required env vars (HYDROGEN_*) — none set yet; isConfigured() is false
//  until they are, so this module is fully inert (not wired into
//  payoutRailAdapter.js either) until explicitly enabled:
//    ENABLED                 — 'true' to activate; otherwise all calls are no-ops
//    BASE_URL                — default sandbox internet URL below
//    INSTITUTION_CODE        — our 6-digit member/institution code (NOT yet
//                              assigned by Hydrogen — doc samples use
//                              placeholder 999999/111444 throughout)
//    INSTITUTION_NAME        — "PAYLODE SERVICES LIMITED"
//    HYDROGEN_PUBLIC_KEY_PATH  — path to Hydrogen's PGP public key (armored),
//                              used to encrypt what we send them
//    OUR_PRIVATE_KEY_PATH    — path to our own PGP private key (armored),
//                              used to decrypt what they send back
//    OUR_PRIVATE_KEY_PASSPHRASE — passphrase for the above, if any
//    DEBIT_ACCOUNT           — our Hydrogen float account number
//    DEBIT_ACCOUNT_BVN       — BVN for our float account
//    DEBIT_ACCOUNT_TIER      — account tier (default 3, see Account Tier table)
//    DEBIT_ACCOUNT_DESIGNATION — account designation (default 1 = Corporate)
//    CHANNEL_CODE            — ChannelCode (default 7 = Third-Party Payment Platform)
//    TXN_LOCATION            — "lat,lon" for TransactionLocation (spec sample
//                              uses decimal lat,lon — differs from NIBSS's
//                              geohash-like format)
//
//  None of Hydrogen's key exchange, institution code assignment, or sandbox
//  test-account details are confirmed yet — see TODOs inline. This file is
//  safe to merge as-is: isConfigured() is false, and it is deliberately NOT
//  required by payoutRailAdapter.js, so it cannot be dispatched to on the
//  live money path or surfaced on the SA dashboard until someone wires it in
//  after go-live is explicitly approved.
//
//  NOTE: the spec's own "Sample Encryption Message" section (5) shows every
//  response — including pacs.002 and pacs.028 responses — wrapped in a
//  Document using the pacs.008.001.12 namespace. That looks like a
//  copy-paste artifact in the doc (the earlier plaintext samples in section 4
//  correctly use pacs.002.001.12 / pacs.028.001.06). We build outbound
//  messages with the correct per-message namespace and tolerate either
//  namespace when parsing inbound responses.
//
//  Rail adapter contract:
//    isConfigured()      → bool
//    getBalance()        → BigInt kobo
//    sendPayout(item)    → { ok, code, reason, orderStatus, providerRef, raw }
//    queryPayoutResult() → { ok, code, reason, orderStatus, raw }
//    nameEnquiry()       → { ok, accountName, sessionId, kycLevel, reason, raw }
// ─────────────────────────────────────────────────────────────────────────────

const crypto  = require('crypto');
const fs      = require('fs');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');
const openpgp = require('openpgp');

// ── Config ───────────────────────────────────────────────────────────────────
const ENABLED           = process.env.HYDROGEN_ENABLED === 'true';
const BASE_URL           = (process.env.HYDROGEN_BASE_URL || 'https://sandbox-bankai-service.hydrogenpay.com').replace(/\/$/, '');
const INSTITUTION_CODE   = process.env.HYDROGEN_INSTITUTION_CODE || ''; // TODO: awaiting assignment from Hydrogen
const INSTITUTION_NAME   = process.env.HYDROGEN_INSTITUTION_NAME || 'PAYLODE SERVICES LIMITED';
const HYDROGEN_PUBLIC_KEY_PATH = process.env.HYDROGEN_PUBLIC_KEY_PATH || '';
const OUR_PRIVATE_KEY_PATH     = process.env.HYDROGEN_OUR_PRIVATE_KEY_PATH || '';
const OUR_PRIVATE_KEY_PASSPHRASE = process.env.HYDROGEN_OUR_PRIVATE_KEY_PASSPHRASE || '';
const DEBIT_ACCOUNT      = process.env.HYDROGEN_DEBIT_ACCOUNT     || '';
const DEBIT_ACCOUNT_BVN  = process.env.HYDROGEN_DEBIT_ACCOUNT_BVN || '';
const DEBIT_ACCOUNT_TIER = parseInt(process.env.HYDROGEN_DEBIT_ACCOUNT_TIER || '3', 10);
const DEBIT_ACCOUNT_DESIGNATION = parseInt(process.env.HYDROGEN_DEBIT_ACCOUNT_DESIGNATION || '1', 10);
const CHANNEL_CODE       = parseInt(process.env.HYDROGEN_CHANNEL_CODE || '7', 10);
const TXN_LOCATION       = process.env.HYDROGEN_TXN_LOCATION || '6.5244,3.3792'; // TODO: confirm required precision/format with Hydrogen

function isConfigured() {
  return !!(ENABLED && INSTITUTION_CODE && HYDROGEN_PUBLIC_KEY_PATH && OUR_PRIVATE_KEY_PATH &&
            DEBIT_ACCOUNT && DEBIT_ACCOUNT_BVN);
}

// ── Lazy-loaded PGP keys ─────────────────────────────────────────────────────
let _hydrogenPublicKey = null;
let _ourPrivateKey     = null;

async function loadHydrogenPublicKey() {
  if (_hydrogenPublicKey) return _hydrogenPublicKey;
  if (!HYDROGEN_PUBLIC_KEY_PATH) throw new Error('HYDROGEN_PUBLIC_KEY_PATH not set');
  const armored = fs.readFileSync(HYDROGEN_PUBLIC_KEY_PATH, 'utf8');
  _hydrogenPublicKey = await openpgp.readKey({ armoredKey: armored });
  return _hydrogenPublicKey;
}

async function loadOurPrivateKey() {
  if (_ourPrivateKey) return _ourPrivateKey;
  if (!OUR_PRIVATE_KEY_PATH) throw new Error('HYDROGEN_OUR_PRIVATE_KEY_PATH not set');
  const armored = fs.readFileSync(OUR_PRIVATE_KEY_PATH, 'utf8');
  let key = await openpgp.readPrivateKey({ armoredKey: armored });
  if (OUR_PRIVATE_KEY_PASSPHRASE) {
    key = await openpgp.decryptKey({ privateKey: key, passphrase: OUR_PRIVATE_KEY_PASSPHRASE });
  }
  _ourPrivateKey = key;
  return _ourPrivateKey;
}

// ── ID generation — same convention as NIBSS NPS (Hydrogen field spec §6) ────
// MsgId:     {InstitutionCode(6)}{yyyyMMddHHmmss(14)}{15 random digits} = 35
// EndToEndId:{InstitutionCode(6)}{29 random digits} = 35
// InstrId:   {SrcCode(6)}{DstCode(6)}{yyyyMMddHHmmss(14)}{9 random} = 35
function randomDigits(n) {
  const buf = crypto.randomBytes(n);
  return Array.from(buf).map(b => String(b % 10)).join('').slice(0, n).padEnd(n, '0');
}

function nowUTC() {
  const d = new Date();
  return {
    yyyyMMddHHmmss: d.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14),
    iso:  d.toISOString(),
    date: d.toISOString().slice(0, 10),
  };
}

// Confirmed format from Hydrogen sample: {inst(6)}{yyMMddHHmmss(12)}{random(12)} = 30 chars
// (2-digit year, NOT 4-digit; 12 random digits, NOT 15)
function makeMsgId() {
  const t = nowUTC();
  const yyMMddHHmmss = t.yyyyMMddHHmmss.slice(2); // drop century "20" → 12 chars
  return INSTITUTION_CODE + yyMMddHHmmss + randomDigits(12);
}
function makeEndToEndId() {
  const t = nowUTC();
  const yyMMddHHmmss = t.yyyyMMddHHmmss.slice(2);
  return INSTITUTION_CODE + yyMMddHHmmss + randomDigits(12);
}
function makeInstrId(destCode) {
  const t = nowUTC();
  const yyMMddHHmmss = t.yyyyMMddHHmmss.slice(2);
  return INSTITUTION_CODE + String(destCode).padEnd(6, '0').slice(0, 6) + yyMMddHHmmss + randomDigits(6);
}

// ── Naira ↔ kobo ─────────────────────────────────────────────────────────────
const nairaStr = (kobo) => (Number(kobo) / 100).toFixed(2);

// ── XML utilities ────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractElement(xml, tag) {
  const open  = `<${tag}`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open);
  if (start < 0) return null;
  const end = xml.indexOf(close, start);
  if (end < 0) return null;
  return xml.slice(start, end + close.length);
}

function replaceElement(xml, tag, replacement) {
  const open  = `<${tag}`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open);
  const end   = xml.indexOf(close, start);
  if (start < 0 || end < 0) return xml;
  return xml.slice(0, start) + replacement + xml.slice(end + close.length);
}

// ── PGP encrypt/decrypt ───────────────────────────────────────────────────────
// Hydrogen confirmed: encrypt to binary, convert directly to uppercase hex.
// Do NOT use ASCII-armored output.
async function pgpEncryptToHex(plaintext) {
  const publicKey = await loadHydrogenPublicKey();
  const message   = await openpgp.createMessage({ text: plaintext });
  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: publicKey,
    format: 'binary',
    config: { allowMissingKeyFlags: true, aeadProtect: false },
  });
  return Buffer.from(encrypted).toString('hex').toUpperCase();
}

async function pgpDecryptArmored(armoredStr) {
  const privateKey = await loadOurPrivateKey();
  const message    = await openpgp.readMessage({ armoredMessage: armoredStr });
  const { data }   = await openpgp.decrypt({ message, decryptionKeys: privateKey, format: 'binary' });
  return Buffer.from(data).toString('utf8');
}

async function pgpDecryptFromHex(hexStr) {
  const privateKey = await loadOurPrivateKey();
  const buf        = Buffer.from(String(hexStr).trim(), 'hex');
  const message    = await openpgp.readMessage({ binaryMessage: buf });
  const { data }   = await openpgp.decrypt({ message, decryptionKeys: privateKey, format: 'binary' });
  return Buffer.from(data).toString('utf8');
}

// Encrypt the INNER content of contentTag, keeping the outer element tags.
// Encrypt a COMPLETE ISO 20022 document containing the content element, place
// the xenc:EncryptedData wrapper INSIDE the content element (outer tags kept).
// Hydrogen validates the decrypted payload as a full ISO 20022 document, so we
// must pass it a complete <?xml...><Document xmlns="...">...</Document>.
async function encryptContentElement(xmlStr, contentTag) {
  const openTag  = `<${contentTag}`;
  const closeTag = `</${contentTag}>`;
  const elemStart = xmlStr.indexOf(openTag);
  if (elemStart < 0) throw new Error(`encryptContentElement: <${contentTag}> not found`);
  const openEnd    = xmlStr.indexOf('>', elemStart) + 1;
  const closeStart = xmlStr.indexOf(closeTag, openEnd);
  if (closeStart < 0) throw new Error(`encryptContentElement: </${contentTag}> not found`);

  const innerContent = xmlStr.slice(openEnd, closeStart);

  // Extract the ISO 20022 namespace from the Document element to build a
  // self-contained valid document for the encrypted payload.
  const nsMatch = xmlStr.match(/xmlns:ns2="([^"]+)"/);
  const ns = nsMatch ? nsMatch[1] : '';
  const plainDocument = ns
    ? `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="${ns}"><${contentTag}>${innerContent}</${contentTag}></Document>`
    : `<${contentTag}>${innerContent}</${contentTag}>`;

  const hex = await pgpEncryptToHex(plainDocument);
  const encryptedData = [
    '<xenc:EncryptedData Type="http://www.w3.org/2001/04/xmlenc#Content"',
    ' xmlns:xenc="http://www.w3.org/2001/04/xmlenc#">',
    '<xenc:CipherData><xenc:CipherValue>',
    hex,
    '</xenc:CipherValue></xenc:CipherData>',
    '</xenc:EncryptedData>',
  ].join('');
  // Keep outer <contentTag> wrapper; xenc goes inside it
  return xmlStr.slice(0, openEnd) + encryptedData + xmlStr.slice(closeStart);
}

// Reverse — decrypt the <xenc:EncryptedData> envelope back into plaintext XML.
// CipherValue may be ASCII-armored PGP (-----BEGIN PGP MESSAGE-----) or
// hex-encoded binary PGP depending on Hydrogen's response format.
// Plaintext error strings (e.g. "MissingEncryptedData") are detected and surfaced.
async function decryptContentElement(xmlStr) {
  const encDataOpen  = '<xenc:EncryptedData';
  const encDataClose = '</xenc:EncryptedData>';
  const start = xmlStr.indexOf(encDataOpen);
  const end   = xmlStr.indexOf(encDataClose, start);
  if (start < 0 || end < 0) throw new Error('decryptContentElement: no EncryptedData found');

  const encDataStr  = xmlStr.slice(start, end + encDataClose.length);
  const cipherMatch = encDataStr.match(/<xenc:CipherValue>([\s\S]+?)<\/xenc:CipherValue>/);
  if (!cipherMatch) throw new Error('decryptContentElement: CipherValue not found');

  const cipherValue = cipherMatch[1].trim();

  let plaintextXml;
  if (cipherValue.startsWith('-----BEGIN PGP')) {
    plaintextXml = await pgpDecryptArmored(cipherValue);
  } else if (/^[0-9A-Fa-f]+$/.test(cipherValue.replace(/\s+/g, ''))) {
    plaintextXml = await pgpDecryptFromHex(cipherValue.replace(/\s+/g, ''));
  } else {
    throw new Error(`Hydrogen error: ${cipherValue}`);
  }

  return xmlStr.slice(0, start) + plaintextXml + xmlStr.slice(end + encDataClose.length);
}

// ── Namespace per message type + content tag map ─────────────────────────────
const NS = {
  'acmt.023': 'urn:iso:std:iso:20022:tech:xsd:acmt.023.001.04',
  'acmt.024': 'urn:iso:std:iso:20022:tech:xsd:acmt.024.001.04',
  'pacs.008': 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.12',
  'pacs.002': 'urn:iso:std:iso:20022:tech:xsd:pacs.002.001.12',
  'pacs.028': 'urn:iso:std:iso:20022:tech:xsd:pacs.028.001.06',
};
const CONTENT_TAG = {
  'acmt.023': 'IdVrfctnReq',
  'acmt.024': 'IdVrfctnRpt',
  'pacs.008': 'FIToFICstmrCdtTrf',
  'pacs.002': 'FIToFIPmtStsRpt',
  'pacs.028': 'FIToFIPmtStsReq',
};

async function prepareOutbound(xmlStr, msgType) {
  const tag = CONTENT_TAG[msgType];
  if (!tag) throw new Error(`prepareOutbound: unknown msgType ${msgType}`);
  return encryptContentElement(xmlStr, tag);
}

// ── HTTP (plain https/http — sandbox is reachable over internet; production
//    is VPN-only per spec §3, so this may need to switch to curl-based
//    routing like nibssNpsService.js once Hydrogen's VPN details are set up) ─
function post(urlPath, body, contentType, maxTimeMs = 60000) {
  return new Promise((resolve) => {
    const url = new URL(BASE_URL + urlPath);
    const lib = url.protocol === 'https:' ? https : http;
    const data = Buffer.from(body, 'utf8');
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type':   contentType,
        'Content-Length': data.length,
        'Accept':         contentType,
      },
      timeout: maxTimeMs,
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.write(data);
    req.end();
  });
}

// Parse a pacs.002 response (decrypting first if needed) → { grpStatus, txStatus, rejectCode, msgId }
async function parsePacs002(xmlStr) {
  const decrypted = xmlStr.includes('<xenc:EncryptedData') ? await decryptContentElement(xmlStr) : xmlStr;
  const grpStatus = (decrypted.match(/<GrpSts>(\w+)<\/GrpSts>/) || [])[1] || '';
  const stsId     = (decrypted.match(/<StsId>(\w+)<\/StsId>/)   || [])[1] || '';
  const rjctCode  = (decrypted.match(/<Rsn>\s*<Prtry>([^<]+)<\/Prtry>/) || [])[1]
                  || (decrypted.match(/<Rsn>\s*<Cd>([^<]+)<\/Cd>/)      || [])[1] || '';
  const msgId     = (decrypted.match(/<MsgId>([^<]+)<\/MsgId>/) || [])[1] || '';
  return { grpStatus, txStatus: stsId, rejectCode: rjctCode, msgId };
}

// ── acmt.023 builder — Name Enquiry request ──────────────────────────────────
function buildAcmt023(opts) {
  const { msgId, destMemberId, beneficiaryAccount } = opts;
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><ns2:Document xmlns:ns2="${NS['acmt.023']}"><IdVrfctnReq><Assgnmt><MsgId>${esc(msgId)}</MsgId><CreDtTm>${nowUTC().iso}</CreDtTm><Cretr><Pty><Nm>${esc(INSTITUTION_NAME)}</Nm></Pty></Cretr><Assgnr><Pty><Nm>${esc(INSTITUTION_NAME)}</Nm></Pty><Agt><FinInstnId><BICFI>${esc(INSTITUTION_CODE)}</BICFI><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></Agt></Assgnr><Assgne><Agt><FinInstnId><BICFI>${esc(destMemberId)}</BICFI><ClrSysMmbId><MmbId>${esc(destMemberId)}</MmbId></ClrSysMmbId></FinInstnId></Agt></Assgne></Assgnmt><Vrfctn><Id>${esc(msgId)}</Id><PtyAndAcctId><Acct><Id><IBAN>${esc(beneficiaryAccount)}</IBAN></Id></Acct></PtyAndAcctId></Vrfctn></IdVrfctnReq></ns2:Document>`;
}

// ── pacs.008 builder — Fund Transfer request ────────────────────────────────
function buildPacs008(opts) {
  const {
    msgId, instrId, endToEndId, txId,
    destMemberId, amountNaira, settlementDate,
    debtorName, debtorAccount, creditorName, creditorAccount, narration,
    neEnquiryMsgId,
    creditorIdType, creditorIdValue, creditorTier, creditorDesignation,
  } = opts;

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><ns2:Document xmlns:ns2="${NS['pacs.008']}"><FIToFICstmrCdtTrf><GrpHdr><MsgId>${esc(msgId)}</MsgId><CreDtTm>${nowUTC().iso}</CreDtTm><BtchBookg>false</BtchBookg><NbOfTxs>1</NbOfTxs><SttlmInf><SttlmMtd>CLRG</SttlmMtd></SttlmInf><InstgAgt><FinInstnId><BICFI>${esc(INSTITUTION_CODE)}</BICFI><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></InstgAgt><InstdAgt><FinInstnId><BICFI>${esc(destMemberId)}</BICFI><ClrSysMmbId><MmbId>${esc(destMemberId)}</MmbId></ClrSysMmbId></FinInstnId></InstdAgt></GrpHdr><CdtTrfTxInf><PmtId><InstrId>${esc(instrId)}</InstrId><EndToEndId>${esc(endToEndId)}</EndToEndId><TxId>${esc(txId)}</TxId></PmtId><PmtTpInf><ClrChanl>RTNS</ClrChanl><SvcLvl><Prtry>0100</Prtry></SvcLvl><LclInstrm><Prtry>CTAA</Prtry></LclInstrm><CtgyPurp><Prtry>001</Prtry></CtgyPurp></PmtTpInf><IntrBkSttlmAmt Ccy="NGN">${esc(amountNaira)}</IntrBkSttlmAmt><IntrBkSttlmDt>${esc(settlementDate)}</IntrBkSttlmDt><ChrgBr>SLEV</ChrgBr><InstgAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></InstgAgt><InstdAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(destMemberId)}</MmbId></ClrSysMmbId></FinInstnId></InstdAgt><Dbtr><Nm>${esc(debtorName)}</Nm></Dbtr><DbtrAcct><Id><Othr><Id>${esc(debtorAccount)}</Id></Othr></Id><Nm>${esc(debtorName)}</Nm></DbtrAcct><DbtrAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></DbtrAgt><CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(destMemberId)}</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt><Cdtr><Nm>${esc(creditorName)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${esc(creditorAccount)}</IBAN></Id><Nm>${esc(creditorName)}</Nm></CdtrAcct>${narration ? `<RmtInf><Ustrd>${esc(String(narration).slice(0, 140))}</Ustrd></RmtInf>` : ''}<SplmtryData><PlcAndNm>AdditionalVerificationDetails</PlcAndNm><Envlp><CustomData><DebtorInfo><AccountDesignation>${DEBIT_ACCOUNT_DESIGNATION}</AccountDesignation><IdType>BVN</IdType><IdValue>${esc(DEBIT_ACCOUNT_BVN)}</IdValue><AccountTier>${DEBIT_ACCOUNT_TIER}</AccountTier></DebtorInfo><CreditorInfo><AccountDesignation>${creditorDesignation || 1}</AccountDesignation><IdType>${esc(creditorIdType || 'BVN')}</IdType><IdValue>${esc(creditorIdValue || '')}</IdValue><AccountTier>${creditorTier != null ? creditorTier : 3}</AccountTier></CreditorInfo><TransactionInfo><TransactionLocation>${esc(TXN_LOCATION)}</TransactionLocation><NameEnquiryMsgId>${esc(neEnquiryMsgId || '')}</NameEnquiryMsgId><ChannelCode>${CHANNEL_CODE}</ChannelCode></TransactionInfo></CustomData></Envlp></SplmtryData></CdtTrfTxInf></FIToFICstmrCdtTrf></ns2:Document>`;
}

// ── pacs.028 builder — Transaction Status Query request ──────────────────────
function buildPacs028(opts) {
  const { msgId, destMemberId, origMsgId, origTxId, origCreDtTm, origSettlementDate } = opts;
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><ns2:Document xmlns:ns2="${NS['pacs.028']}"><FIToFIPmtStsReq><GrpHdr><MsgId>${esc(msgId)}</MsgId><CreDtTm>${nowUTC().iso}</CreDtTm><InstgAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></InstgAgt></GrpHdr><OrgnlGrpInf><OrgnlMsgId>${esc(origMsgId)}</OrgnlMsgId><OrgnlMsgNmId>pacs.008.001.12</OrgnlMsgNmId><OrgnlCreDtTm>${esc(origCreDtTm)}</OrgnlCreDtTm></OrgnlGrpInf><TxInf><StsReqId>${esc(msgId)}</StsReqId><OrgnlTxId>${esc(origTxId)}</OrgnlTxId><InstgAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></InstgAgt><InstdAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(destMemberId)}</MmbId></ClrSysMmbId></FinInstnId></InstdAgt><OrgnlTxRef><IntrBkSttlmDt>${esc(origSettlementDate)}</IntrBkSttlmDt></OrgnlTxRef></TxInf></FIToFIPmtStsReq></ns2:Document>`;
}

// ── nameEnquiry ───────────────────────────────────────────────────────────────
async function nameEnquiry(bankMemberId, accountNumber) {
  if (!isConfigured()) return { ok: false, reason: 'Hydrogen not configured', raw: null };

  const msgId = makeMsgId();
  try {
    const xml     = buildAcmt023({ msgId, destMemberId: bankMemberId, beneficiaryAccount: accountNumber });
    const payload = await prepareOutbound(xml, 'acmt.023');
    const { status, body } = await post('/eft/v1/acmt023', payload, 'application/xml; charset=UTF-8');

    if (status === 200 && body) {
      const decrypted = body.includes('<xenc:EncryptedData') ? await decryptContentElement(body) : body;
      const vrfctn  = (decrypted.match(/<Vrfctn>(true|false)<\/Vrfctn>/i) || [])[1] || '';
      // Name is in UpdtdPtyAndAcctId/Pty/Nm — the verified/resolved name (not Assgne/Pty/Nm)
      const name    = (decrypted.match(/<UpdtdPtyAndAcctId>[\s\S]*?<Nm>([^<]+)<\/Nm>/) || [])[1]
                   || (decrypted.match(/<Nm>([^<]+)<\/Nm>/) || [])[1] || '';
      // Use Hydrogen's own response MsgId (from <Assgnmt><MsgId>) as session ID for pacs.008
      const hydrogenMsgId = (decrypted.match(/<Assgnmt>\s*<MsgId>([^<]+)<\/MsgId>/) || [])[1] || msgId;
      const rjctCd  = (decrypted.match(/<Rsn>\s*<Cd>([^<]+)<\/Cd>/) || [])[1] || '';
      if (/true/i.test(vrfctn) && name) {
        return { ok: true, accountName: name, sessionId: hydrogenMsgId, kycLevel: '', reason: '', raw: body };
      }
      return { ok: false, accountName: '', sessionId: hydrogenMsgId, kycLevel: '', reason: rjctCd || 'Not verified', raw: body };
    }

    return { ok: false, reason: `HTTP ${status}`, sessionId: msgId, raw: body };
  } catch (e) {
    return { ok: false, reason: e.message, sessionId: msgId, raw: null };
  }
}

// ── sendPayout ────────────────────────────────────────────────────────────────
// item = { orderId, amount(kobo), bank_code, account_number, account_name, narration,
//          neSessionId?, neAccountName?, hydrogenCreditorIdType?, hydrogenCreditorIdValue?,
//          hydrogenCreditorTier?, hydrogenCreditorDesignation? }
async function sendPayout(item) {
  if (!isConfigured()) throw new Error('Hydrogen not configured');

  const destMemberId = String(item.bank_code || '').trim();
  if (!destMemberId) throw new Error('sendPayout: bank_code (Hydrogen member ID) required');

  const amountNaira = nairaStr(item.amount);
  const { date: settlementDate, iso: creDtTm } = nowUTC();

  let neSessionId   = item.neSessionId   || null;
  let neAccountName = item.neAccountName || item.account_name || '';

  if (!neSessionId) {
    const ne = await nameEnquiry(destMemberId, item.account_number);
    if (!ne.ok) throw new Error(`Hydrogen NE failed for ${destMemberId}/${item.account_number}: ${ne.reason}`);
    neSessionId   = ne.sessionId;
    neAccountName = ne.accountName || neAccountName;
  }

  const msgId      = makeMsgId();
  const endToEndId = makeEndToEndId();
  const instrId    = makeInstrId(destMemberId);

  const xml = buildPacs008({
    msgId, instrId, endToEndId, txId: msgId,
    destMemberId, amountNaira, settlementDate,
    debtorName:      INSTITUTION_NAME,
    debtorAccount:   DEBIT_ACCOUNT,
    creditorName:    neAccountName || item.account_name || '',
    creditorAccount: item.account_number,
    narration:       item.narration || '',
    neEnquiryMsgId:  neSessionId || '',
    creditorIdType:        item.hydrogenCreditorIdType        || 'BVN',
    creditorIdValue:       item.hydrogenCreditorIdValue       || '',
    creditorTier:          item.hydrogenCreditorTier,
    creditorDesignation:   item.hydrogenCreditorDesignation   || 1,
  });

  try {
    const payload = await prepareOutbound(xml, 'pacs.008');
    const { status, body } = await post('/eft/v1/pacs008', payload, 'application/xml; charset=UTF-8', 90000);

    if (status === 200 && body) {
      const parsed = await parsePacs002(body);
      const ok = parsed.grpStatus === 'ACSC';
      return {
        ok,
        code:        ok ? '00' : (parsed.rejectCode || 'RJCT'),
        reason:      ok ? '' : (parsed.rejectCode || 'Rejected by Hydrogen'),
        orderStatus: ok ? 'SETTLED' : 'FAILED',
        providerRef: msgId,
        raw: body,
        // Stash for the 30s-window TSQ follow-up (see queryPayoutResult)
        _origMsgId: msgId, _origTxId: msgId, _origCreDtTm: creDtTm, _origSettlementDate: settlementDate,
      };
    }

    if (status === 0 || status >= 500) {
      // Network / server error — treat as pending (do NOT reverse)
      return { ok: false, code: 'PENDING', reason: `HTTP ${status}`, orderStatus: 'PENDING', providerRef: msgId, raw: body };
    }

    let reason = `HTTP ${status}`;
    if (body && body.includes('<xenc:EncryptedData')) {
      try {
        const parsed = await parsePacs002(body);
        reason = parsed.rejectCode || reason;
      } catch (_) { /* ignore decrypt fail on 4xx body */ }
    }
    return { ok: false, code: 'RJCT', reason, orderStatus: 'FAILED', providerRef: msgId, raw: body };

  } catch (e) {
    // Treat unexpected errors as PENDING — never auto-reverse
    return { ok: false, code: 'PENDING', reason: e.message, orderStatus: 'PENDING', providerRef: msgId, raw: null };
  }
}

// ── queryPayoutResult ─────────────────────────────────────────────────────────
// item = { providerRef: original pacs.008 MsgId, orderId, bank_code,
//          _origCreDtTm?, _origSettlementDate? }
// NOTE: spec requires TSQ to be sent within 30s of the Fund Transfer — caller
// should invoke this promptly; PEN09 may be re-queried up to twice within a
// 5-minute window (see module-level PERMANENT_FAILURE_CODES below).
async function queryPayoutResult(item) {
  if (!isConfigured()) return { ok: false, reason: 'Hydrogen not configured', raw: null };

  const origMsgId = item.providerRef || item.orderId;
  if (!origMsgId) return { ok: false, reason: 'providerRef required', raw: null };

  const msgId = makeMsgId();
  try {
    const xml = buildPacs028({
      msgId,
      destMemberId:       item.bank_code || '',
      origMsgId,
      origTxId:           origMsgId,
      origCreDtTm:        item._origCreDtTm || nowUTC().iso,
      origSettlementDate: item._origSettlementDate || nowUTC().date,
    });
    const payload = await prepareOutbound(xml, 'pacs.028');
    const { status, body } = await post('/eft/v1/pacs028', payload, 'application/xml; charset=UTF-8', 60000);

    if (status === 200 && body) {
      const parsed = await parsePacs002(body);
      const ok = parsed.grpStatus === 'ACSC';
      const isPending = parsed.txStatus === 'PEN09' || parsed.grpStatus === 'PEN09';
      return {
        ok,
        code:        ok ? '00' : (parsed.rejectCode || parsed.grpStatus || ''),
        reason:      ok ? '' : (parsed.rejectCode || ''),
        orderStatus: ok ? 'SETTLED' : (isPending ? 'PENDING' : (parsed.grpStatus === 'RJCT' ? 'FAILED' : 'PENDING')),
        raw: body,
      };
    }
    return { ok: false, code: '', reason: `HTTP ${status}`, orderStatus: 'PENDING', raw: body };
  } catch (e) {
    return { ok: false, reason: e.message, orderStatus: 'PENDING', raw: null };
  }
}

// Permanent failure codes (spec §11) — never re-query these; PEN09 is the only
// re-queryable pending code (max 2 retries within a 5-minute window).
const PERMANENT_FAILURE_CODES = new Set([
  'AC03', 'BE20', 'NPS01', 'NPS05', 'NPS12', 'NPS20', 'NPS21', 'NPS22', 'NPS26',
  'NPS31', 'NPS32', 'NPS33', 'NPS34', 'NPS35', 'NPS36', 'NPS37', 'NPS38', 'NPS42',
  'NPS43', 'RC10', 'AC02', 'AC09', 'AM12', 'AM21', 'BE08', 'DT01', 'DU03', 'FF08',
  'NOAS', 'NPS02', 'NPS03', 'NPS06', 'NPS18', 'NPS19', 'NPS23', 'NPS24', 'NPS25',
  'NPS30', 'NPS39', 'NPS40', 'NPS41', 'RC09', 'WMC18', 'UAU70', 'UAB69', 'SV63',
  'TNP58', 'FMT30', 'SF34', 'EWF65', 'TNP57', 'NSF51', 'SMF96', 'RF01', 'RJCT',
]);

// ── getBalance — Institution Balance endpoint ────────────────────────────────
// Confirmed by Hydrogen: same PGP+xenc wrapping as XML endpoints, application/xml.
// Response may be xenc-wrapped JSON or plain JSON; both are handled.
async function getBalance() {
  if (!isConfigured()) return BigInt(0);
  try {
    const payload = JSON.stringify({ ChannelCode: String(CHANNEL_CODE), SourceInstitutionCode: INSTITUTION_CODE });
    const hex = await pgpEncryptToHex(payload);
    const encryptedBody = [
      '<xenc:EncryptedData Type="http://www.w3.org/2001/04/xmlenc#Content"',
      ' xmlns:xenc="http://www.w3.org/2001/04/xmlenc#">',
      '<xenc:CipherData><xenc:CipherValue>',
      hex,
      '</xenc:CipherValue></xenc:CipherData>',
      '</xenc:EncryptedData>',
    ].join('');
    const { status, body } = await post('/eft/v1/inst/balance', encryptedBody, 'application/xml; charset=UTF-8');
    if (status === 200 && body) {
      const decryptedBody = body.includes('<xenc:EncryptedData')
        ? await decryptContentElement(body)
        : body;
      const jsonMatch = decryptedBody.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.ResponseCode === '00' && parsed.Amount) {
          return BigInt(Math.round(parseFloat(parsed.Amount) * 100));
        }
      }
    }
    return BigInt(0);
  } catch (_) {
    return BigInt(0);
  }
}

module.exports = {
  isConfigured,
  getBalance,
  sendPayout,
  queryPayoutResult,
  nameEnquiry,
  PERMANENT_FAILURE_CODES,
  // Exposed for inbound response/webhook handling, if Hydrogen provides one
  // (their spec, as given, documents no inbound/inflow webhook — only
  // sender-initiated Name Enquiry, Fund Transfer, and Status Query flows)
  decryptContentElement,
  parsePacs002,
};
