'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  NIBSS NPS (National Payment Stack) service — ISO 20022 payouts
//
//  Outbound path: pacs.008 signed+encrypted → NIBSS NPS via VPN tunnel
//  Name enquiry:  acmt.023 signed+encrypted → NIBSS NPS via VPN tunnel
//  Status query:  pacs.028 signed+encrypted → NIBSS NPS
//
//  Sign-then-encrypt per NIBSS spec:
//    1. XMLDSig enveloped, Exclusive C14n, RSA-SHA256 (xml-crypto)
//    2. AES-256-GCM content encryption + RSA-OAEP-MGF1P key wrap (Node crypto)
//
//  Required env vars (NIBSS_NPS_*):
//    INSTITUTION_CODE   — 6-digit CBN sort code assigned at NIBSS onboarding
//    INSTITUTION_NAME   — "PAYLODE SERVICES LIMITED"
//    BASE_URL           — NPS base, default https://nps-test.nibss-plc.com.ng:8022
//    PRIVATE_KEY_PATH   — path to our RSA-2048 private key PEM (for signing)
//    NIBSS_CERT_PATH    — path to NIBSS public cert PEM (for RSA-OAEP key wrap)
//    DEBIT_ACCOUNT      — our NPS float account number
//    DEBIT_ACCOUNT_BVN  — BVN for our float account
//    DEBIT_ACCOUNT_TIER — account tier (default 3)
//    CHANNEL_CODE       — ChannelCode (default 7 = Third-Party)
//    ENABLED            — 'true' to activate; otherwise all calls are no-ops
//
//  Rail adapter contract:
//    isConfigured()      → bool
//    getBalance()        → BigInt kobo  (NPS has no balance API; returns 0)
//    sendPayout(item)    → { ok, code, reason, orderStatus, providerRef, raw }
//    queryPayoutResult() → { ok, code, reason, orderStatus, raw }
//    nameEnquiry()       → { ok, accountName, sessionId, kycLevel, reason, raw }
// ─────────────────────────────────────────────────────────────────────────────

const crypto      = require('crypto');
const fs          = require('fs');
const path        = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { SignedXml } = require('xml-crypto');

// ── Config ───────────────────────────────────────────────────────────────────
const INSTITUTION_CODE = process.env.NIBSS_NPS_INSTITUTION_CODE || '';
const INSTITUTION_NAME = process.env.NIBSS_NPS_INSTITUTION_NAME || 'PAYLODE SERVICES LIMITED';
const BASE_URL         = (process.env.NIBSS_NPS_BASE_URL || 'https://nps-test.nibss-plc.com.ng:8022').replace(/\/$/, '');
const PRIVATE_KEY_PATH = process.env.NIBSS_NPS_PRIVATE_KEY_PATH || '';
const NIBSS_CERT_PATH  = process.env.NIBSS_NPS_NIBSS_CERT_PATH  || '';
const DEBIT_ACCOUNT    = process.env.NIBSS_NPS_DEBIT_ACCOUNT    || '';
const DEBIT_ACCOUNT_BVN  = process.env.NIBSS_NPS_DEBIT_ACCOUNT_BVN  || '';
const DEBIT_ACCOUNT_TIER = parseInt(process.env.NIBSS_NPS_DEBIT_ACCOUNT_TIER || '3', 10);
const CHANNEL_CODE     = parseInt(process.env.NIBSS_NPS_CHANNEL_CODE || '7', 10);
const ENABLED          = process.env.NIBSS_NPS_ENABLED === 'true';

// Lazy-load certs — they may not exist until NIBSS onboarding completes
let _privateKey  = null;
let _nibssCert   = null;

function loadPrivateKey() {
  if (_privateKey) return _privateKey;
  if (!PRIVATE_KEY_PATH) throw new Error('NIBSS_NPS_PRIVATE_KEY_PATH not set');
  _privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  return _privateKey;
}

function loadNibssCert() {
  if (_nibssCert) return _nibssCert;
  if (!NIBSS_CERT_PATH) throw new Error('NIBSS_NPS_NIBSS_CERT_PATH not set');
  _nibssCert = fs.readFileSync(NIBSS_CERT_PATH);
  return _nibssCert;
}

function isConfigured() {
  return !!(ENABLED && INSTITUTION_CODE && PRIVATE_KEY_PATH && NIBSS_CERT_PATH &&
            DEBIT_ACCOUNT && DEBIT_ACCOUNT_BVN);
}

// ── NPS ID generation ────────────────────────────────────────────────────────
// MsgId:     {InstitutionCode(6)}{yyyyMMddHHmmss(14)}{15 random digits} = 35
// EndToEndId:{InstitutionCode(6)}{29 random digits} = 35
// InstrId:   {SrcCode(6)}{DstCode(6)}{yyyyMMddHHmmss(14)}{9 random} = 35

function randomDigits(n) {
  // Use crypto.randomBytes then map to digits
  const buf = crypto.randomBytes(n);
  return Array.from(buf).map(b => String(b % 10)).join('').slice(0, n).padEnd(n, '0');
}

function nowWAT() {
  // WAT = UTC+1
  const d = new Date(Date.now() + 60 * 60 * 1000);
  return {
    yyyyMMddHHmmss: d.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14),
    iso:   d.toISOString().replace('Z', '+01:00'),
    date:  d.toISOString().slice(0, 10) + 'Z',
  };
}

function makeMsgId() {
  const t = nowWAT();
  return INSTITUTION_CODE + t.yyyyMMddHHmmss + randomDigits(15);
}
function makeEndToEndId() {
  return INSTITUTION_CODE + randomDigits(29);
}
function makeInstrId(destCode) {
  const t = nowWAT();
  return INSTITUTION_CODE + String(destCode).padEnd(6, '0').slice(0, 6) + t.yyyyMMddHHmmss + randomDigits(9);
}

// ── Naira ↔ kobo ─────────────────────────────────────────────────────────────
const nairaStr = (kobo) => (Number(kobo) / 100).toFixed(2);

// ── XML Utilities ─────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Extract the first occurrence of <tag...>...</tag> from xml string
function extractElement(xml, tag) {
  const open  = `<${tag}`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open);
  if (start < 0) return null;
  const end = xml.indexOf(close, start);
  if (end < 0) return null;
  return xml.slice(start, end + close.length);
}

// Replace the first <tag>…</tag> block in xml with replacement string
function replaceElement(xml, tag, replacement) {
  const open  = `<${tag}`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open);
  const end   = xml.indexOf(close, start);
  if (start < 0 || end < 0) return xml;
  return xml.slice(0, start) + replacement + xml.slice(end + close.length);
}

// ── XMLDSig — Sign ────────────────────────────────────────────────────────────
// Returns signed XML (Signature appended inside document root, URI="", Exclusive C14n)
function signXml(xmlStr) {
  const sig = new SignedXml({ privateKey: loadPrivateKey() });
  sig.addReference({
    uri:            '',
    isEmptyUri:     true,
    xpath:          '/*',
    transforms:     ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  sig.signatureAlgorithm        = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  sig.computeSignature(xmlStr);
  return sig.getSignedXml();
}

// ── XML Encryption — Encrypt content element ─────────────────────────────────
// Replaces <contentTag>...</contentTag> with <xenc:EncryptedData>
// AES-256-GCM content; RSA-OAEP-MGF1P (SHA-1 for OAEP) key wrap
//
// xmlenc11 AES-GCM CipherValue layout: base64(IV[12] || Ciphertext || Tag[16])
function encryptContentElement(xmlStr, contentTag) {
  const contentXml = extractElement(xmlStr, contentTag);
  if (!contentXml) throw new Error(`encryptContentElement: <${contentTag}> not found`);

  const aesKey = crypto.randomBytes(32);
  const iv     = crypto.randomBytes(12);

  const cipher   = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ct1      = cipher.update(Buffer.from(contentXml, 'utf8'));
  const ct2      = cipher.final();
  const authTag  = cipher.getAuthTag();
  const cipherBuf = Buffer.concat([iv, ct1, ct2, authTag]);

  // Wrap AES key: RSA-OAEP with MGF1+SHA-1 (rsa-oaep-mgf1p)
  const encAesKey = crypto.publicEncrypt(
    { key: loadNibssCert(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    aesKey,
  );

  const encryptedData = [
    '<xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"',
    ' Type="http://www.w3.org/2001/04/xmlenc#Content">',
    '<xenc:EncryptionMethod Algorithm="http://www.w3.org/2009/xmlenc11#aes256-gcm"/>',
    '<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">',
    '<xenc:EncryptedKey>',
    '<xenc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p"/>',
    '<xenc:CipherData><xenc:CipherValue>',
    encAesKey.toString('base64'),
    '</xenc:CipherValue></xenc:CipherData>',
    '</xenc:EncryptedKey>',
    '</ds:KeyInfo>',
    '<xenc:CipherData><xenc:CipherValue>',
    cipherBuf.toString('base64'),
    '</xenc:CipherValue></xenc:CipherData>',
    '</xenc:EncryptedData>',
  ].join('');

  return replaceElement(xmlStr, contentTag, encryptedData);
}

// ── XML Decryption ─────────────────────────────────────────────────────────────
// Reverses encryptContentElement — decrypts <xenc:EncryptedData> using our private key
function decryptContentElement(xmlStr) {
  const privKey = loadPrivateKey();

  const encDataOpen  = '<xenc:EncryptedData';
  const encDataClose = '</xenc:EncryptedData>';
  const start = xmlStr.indexOf(encDataOpen);
  const end   = xmlStr.indexOf(encDataClose, start);
  if (start < 0 || end < 0) throw new Error('decryptContentElement: no EncryptedData found');

  const encDataStr = xmlStr.slice(start, end + encDataClose.length);

  // Extract encrypted AES key
  const keyMatch = encDataStr.match(/<xenc:EncryptedKey>[\s\S]*?<xenc:CipherValue>([\s\S]+?)<\/xenc:CipherValue>[\s\S]*?<\/xenc:EncryptedKey>/);
  if (!keyMatch) throw new Error('decryptContentElement: EncryptedKey not found');
  const encAesKey = Buffer.from(keyMatch[1].trim(), 'base64');

  // Extract cipher data (after EncryptedKey block)
  const afterKey = encDataStr.indexOf('</xenc:EncryptedKey>');
  const cipherMatch = encDataStr.slice(afterKey).match(/<xenc:CipherData><xenc:CipherValue>([\s\S]+?)<\/xenc:CipherValue>/);
  if (!cipherMatch) throw new Error('decryptContentElement: CipherData not found');
  const cipherBuf = Buffer.from(cipherMatch[1].trim(), 'base64');

  // Unwrap AES key
  const aesKey = crypto.privateDecrypt(
    { key: privKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    encAesKey,
  );

  // AES-256-GCM: layout is IV[12] || Ciphertext || Tag[16]
  const iv      = cipherBuf.slice(0, 12);
  const tag     = cipherBuf.slice(cipherBuf.length - 16);
  const ct      = cipherBuf.slice(12, cipherBuf.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  const contentXml = pt.toString('utf8');

  return xmlStr.slice(0, start) + contentXml + xmlStr.slice(end + encDataClose.length);
}

// ── Signature verification ────────────────────────────────────────────────────
// Returns true if the XMLDSig in xmlStr is valid against nibssCert
function verifySignature(xmlStr, nibssCertPem) {
  const sig = new SignedXml({ publicCert: nibssCertPem });
  // Find the Signature element
  const sigStart = xmlStr.indexOf('<Signature ');
  const sigEnd   = xmlStr.indexOf('</Signature>');
  if (sigStart < 0 || sigEnd < 0) return false;
  const sigXml = xmlStr.slice(sigStart, sigEnd + '</Signature>'.length);
  sig.loadSignature(sigXml);
  return sig.checkSignature(xmlStr);
}

// ── Sign → Encrypt pipeline ──────────────────────────────────────────────────
// contentTag: the element name to encrypt (after signing)
const CONTENT_TAG = {
  'pacs.008': 'FIToFICstmrCdtTrf',
  'pacs.002': 'FIToFIPmtStsRpt',
  'pacs.028': 'FIToFIPmtStsReq',
  'acmt.023': 'IdVrfctnReq',
  'pain.001': 'CstmrCdtTrfInitn',
  'pain.008': 'CstmrDrctDbtInitn',
};

function prepareOutbound(xmlStr, msgType) {
  const tag = CONTENT_TAG[msgType];
  if (!tag) throw new Error(`prepareOutbound: unknown msgType ${msgType}`);
  const signed    = signXml(xmlStr);
  const encrypted = encryptContentElement(signed, tag);
  return encrypted;
}

// ── HTTP (curl, follows VPN routing) ─────────────────────────────────────────
async function npsPost(urlPath, xmlBody, maxTime = 60) {
  const url = BASE_URL + urlPath;
  const args = [
    '-s', '-w', '\n__STATUS__%{http_code}',
    '-X', 'POST',
    '-H', 'Content-Type: application/xml; charset=UTF-8',
    '-H', 'Accept: application/xml',
    '--data-raw', xmlBody,
    '--connect-timeout', '15',
    '--max-time', String(maxTime),
    url,
  ];

  try {
    const { stdout } = await execFileAsync('curl', args, {
      timeout: (maxTime + 5) * 1000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    const sep    = stdout.lastIndexOf('\n__STATUS__');
    const body   = sep >= 0 ? stdout.slice(0, sep) : stdout;
    const status = sep >= 0 ? parseInt(stdout.slice(sep + 11), 10) : 200;
    return { status, body };
  } catch (e) {
    return { status: 0, body: '', error: e.message };
  }
}

// Parse pacs.002 response — returns { grpStatus, txStatus, rejectCode, msgId }
function parsePacs002(xmlStr) {
  const decrypted = xmlStr.includes('<xenc:EncryptedData') ? decryptContentElement(xmlStr) : xmlStr;
  const grpStatus = (decrypted.match(/<GrpSts>(\w+)<\/GrpSts>/) || [])[1] || '';
  const txStatus  = (decrypted.match(/<TxSts>(\w+)<\/TxSts>/)   || [])[1] || '';
  const rjctCode  = (decrypted.match(/<Rsn><Cd>(\w+)<\/Cd><\/Rsn>/) || [])[1] || '';
  const msgId     = (decrypted.match(/<MsgId>([^<]+)<\/MsgId>/) || [])[1] || '';
  return { grpStatus, txStatus, rejectCode: rjctCode, msgId };
}

// ── pacs.008 builder ──────────────────────────────────────────────────────────
function buildPacs008(opts) {
  const {
    msgId, instrId, endToEndId, txId,
    destMemberId,
    amountNaira, settlementDate,
    debtorName, debtorAccount, debtorAgentId,
    creditorName, creditorAccount, creditorAgentId,
    narration,
    neEnquiryMsgId,
    creditorIdType, creditorIdValue, creditorTier, creditorDesignation,
    txLocation,
  } = opts;

  return `<Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.12"><FIToFICstmrCdtTrf><GrpHdr><MsgId>${esc(msgId)}</MsgId><CreDtTm>${nowWAT().iso}</CreDtTm><BtchBookg>false</BtchBookg><NbOfTxs>1</NbOfTxs><SttlmInf><SttlmMtd>CLRG</SttlmMtd></SttlmInf><InstgAgt><FinInstnId><BICFI>${esc(INSTITUTION_CODE)}</BICFI><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></InstgAgt><InstdAgt><FinInstnId><BICFI>${esc(destMemberId)}</BICFI><ClrSysMmbId><MmbId>${esc(destMemberId)}</MmbId></ClrSysMmbId></FinInstnId></InstdAgt></GrpHdr><CdtTrfTxInf><PmtId><InstrId>${esc(instrId)}</InstrId><EndToEndId>${esc(endToEndId)}</EndToEndId><TxId>${esc(txId)}</TxId></PmtId><PmtTpInf><ClrChanl>RTNS</ClrChanl><SvcLvl><Prtry>0100</Prtry></SvcLvl><LclInstrm><Prtry>CTAA</Prtry></LclInstrm><CtgyPurp><Prtry>001</Prtry></CtgyPurp></PmtTpInf><IntrBkSttlmAmt Ccy="NGN">${esc(amountNaira)}</IntrBkSttlmAmt><IntrBkSttlmDt>${esc(settlementDate)}</IntrBkSttlmDt><ChrgBr>SLEV</ChrgBr><InstgAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></InstgAgt><InstdAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(destMemberId)}</MmbId></ClrSysMmbId></FinInstnId></InstdAgt><Dbtr><Nm>${esc(debtorName)}</Nm></Dbtr><DbtrAcct><Id><IBAN>${esc(debtorAccount)}</IBAN></Id><Nm>${esc(debtorName)}</Nm></DbtrAcct><DbtrAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(debtorAgentId)}</MmbId></ClrSysMmbId></FinInstnId></DbtrAgt><Cdtr><Nm>${esc(creditorName)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${esc(creditorAccount)}</IBAN></Id><Nm>${esc(creditorName)}</Nm></CdtrAcct><CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(creditorAgentId)}</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>${narration ? `<RmtInf><Ustrd>${esc(String(narration).slice(0, 100))}</Ustrd></RmtInf>` : ''}<SplmtryData><PlcAndNm>AdditionalVerificationDetails</PlcAndNm><Envlp><CustomData><DebtorInfo><AccountDesignation>1</AccountDesignation><IdType>BVN</IdType><IdValue>${esc(DEBIT_ACCOUNT_BVN)}</IdValue><AccountTier>${DEBIT_ACCOUNT_TIER}</AccountTier></DebtorInfo><CreditorInfo><AccountDesignation>${creditorDesignation || 1}</AccountDesignation><IdType>${esc(creditorIdType || 'BVN')}</IdType><IdValue>${esc(creditorIdValue || '')}</IdValue><AccountTier>${creditorTier || 3}</AccountTier></CreditorInfo><TransactionInfo><TransactionLocation>${esc(txLocation || '01080652440N020900337921E')}</TransactionLocation><NameEnquiryMsgId>${esc(neEnquiryMsgId || '')}</NameEnquiryMsgId><ChannelCode>${CHANNEL_CODE}</ChannelCode><RiskRating>R000000000000000000B9</RiskRating></TransactionInfo></CustomData></Envlp></SplmtryData></CdtTrfTxInf></FIToFICstmrCdtTrf></Document>`;
}

// ── acmt.023 builder ──────────────────────────────────────────────────────────
function buildAcmt023(opts) {
  const { msgId, destMemberId, beneficiaryAccount } = opts;
  return `<Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:acmt.023.001.04"><IdVrfctnReq><Assgnmt><MsgId>${esc(msgId)}</MsgId><CreDtTm>${nowWAT().iso}</CreDtTm><Cretr><Pty><Nm>${esc(INSTITUTION_NAME)}</Nm></Pty></Cretr><Assgnr><Pty><Nm>${esc(INSTITUTION_NAME)}</Nm></Pty><Agt><FinInstnId><BICFI>${esc(INSTITUTION_CODE)}</BICFI><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></Agt></Assgnr><Assgne><Agt><FinInstnId><BICFI>${esc(destMemberId)}</BICFI><ClrSysMmbId><MmbId>${esc(destMemberId)}</MmbId></ClrSysMmbId></FinInstnId></Agt></Assgne></Assgnmt><Vrfctn><Id>${esc(msgId)}</Id><PtyAndAcctId><Pty><Nm></Nm></Pty><Acct><Id><IBAN>${esc(beneficiaryAccount)}</IBAN></Id></Acct></PtyAndAcctId></Vrfctn></IdVrfctnReq></Document>`;
}

// ── pacs.028 builder ──────────────────────────────────────────────────────────
function buildPacs028(opts) {
  const { msgId, origMsgId, origTxId } = opts;
  return `<Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:pacs.028.001.06"><FIToFIPmtStsReq><GrpHdr><MsgId>${esc(msgId)}</MsgId><CreDtTm>${nowWAT().iso}</CreDtTm><InstgAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></InstgAgt></GrpHdr><OrgnlGrpInf><OrgnlMsgId>${esc(origMsgId)}</OrgnlMsgId><OrgnlMsgNmId>pacs.008.001.12</OrgnlMsgNmId></OrgnlGrpInf><TxInf><StsReqId>${esc(msgId)}</StsReqId><OrgnlTxId>${esc(origTxId)}</OrgnlTxId></TxInf></FIToFIPmtStsReq></Document>`;
}

// ── nameEnquiry ───────────────────────────────────────────────────────────────
// Sends acmt.023, parses acmt.024 synchronous response (NIBSS may respond async too)
// Returns { ok, accountName, sessionId, kycLevel, reason, raw }
// sessionId here = the MsgId of this acmt.023 (used as NameEnquiryMsgId in pacs.008)
async function nameEnquiry(bankMemberId, accountNumber) {
  if (!isConfigured()) return { ok: false, reason: 'NPS not configured', raw: null };

  const msgId = makeMsgId();
  try {
    const xml     = buildAcmt023({ msgId, destMemberId: bankMemberId, beneficiaryAccount: accountNumber });
    const payload = prepareOutbound(xml, 'acmt.023');
    const { status, body } = await npsPost('/nps/acmt/023', payload);

    if (status === 200 && body) {
      const decrypted = body.includes('<xenc:EncryptedData') ? decryptContentElement(body) : body;
      // acmt.024 response: look for <Nm> (account name) and rejection
      const name    = (decrypted.match(/<Nm>([^<]+)<\/Nm>/) || [])[1] || '';
      const rjctCd  = (decrypted.match(/<Rsn><Cd>(\w+)<\/Cd>/) || [])[1] || '';
      if (name) {
        return { ok: true, accountName: name, sessionId: msgId, kycLevel: '', reason: '', raw: body };
      }
      if (rjctCd) {
        return { ok: false, accountName: '', sessionId: msgId, kycLevel: '', reason: rjctCd, raw: body };
      }
    }

    // HTTP 202 = accepted, response async — caller must re-check
    if (status === 202) {
      return { ok: false, accountName: '', sessionId: msgId, kycLevel: '', reason: 'ASYNC', raw: body };
    }

    return { ok: false, reason: `HTTP ${status}`, sessionId: msgId, raw: body };
  } catch (e) {
    return { ok: false, reason: e.message, sessionId: msgId, raw: null };
  }
}

// ── sendPayout ────────────────────────────────────────────────────────────────
// item = { orderId, amount(kobo), bank_code, account_number, account_name, narration,
//          neSessionId?, neAccountName?, npsCreditorBvn?, npsCreditorTier? }
// Returns { ok, code, reason, orderStatus, providerRef, raw }
async function sendPayout(item) {
  if (!isConfigured()) throw new Error('NIBSS NPS not configured');

  const destMemberId = String(item.bank_code || '').trim();
  if (!destMemberId) throw new Error('sendPayout: bank_code (NPS member ID) required');

  const amountNaira    = nairaStr(item.amount);
  const { date: settlementDate } = nowWAT();

  // Name enquiry first if not pre-fetched
  let neSessionId  = item.neSessionId  || null;
  let neAccountName = item.neAccountName || item.account_name || '';

  if (!neSessionId) {
    const ne = await nameEnquiry(destMemberId, item.account_number);
    if (!ne.ok && ne.reason !== 'ASYNC') {
      throw new Error(`NPS NE failed for ${destMemberId}/${item.account_number}: ${ne.reason}`);
    }
    neSessionId   = ne.sessionId  || null;
    neAccountName = ne.accountName || neAccountName;
  }

  const msgId      = makeMsgId();
  const endToEndId = makeEndToEndId();
  const instrId    = makeInstrId(destMemberId);

  const xml = buildPacs008({
    msgId, instrId, endToEndId, txId: msgId,
    destMemberId,
    amountNaira, settlementDate,
    debtorName:       INSTITUTION_NAME,
    debtorAccount:    DEBIT_ACCOUNT,
    debtorAgentId:    INSTITUTION_CODE,
    creditorName:     neAccountName || item.account_name || '',
    creditorAccount:  item.account_number,
    creditorAgentId:  destMemberId,
    narration:        item.narration || '',
    neEnquiryMsgId:   neSessionId   || '',
    creditorIdType:   item.npsCreditorIdType  || 'BVN',
    creditorIdValue:  item.npsCreditorIdValue || '',
    creditorTier:     item.npsCreditorTier    || 3,
    creditorDesignation: item.npsCreditorDesignation || 1,
    txLocation:       '01080652440N020900337921E',
  });

  try {
    const payload = prepareOutbound(xml, 'pacs.008');
    const { status, body } = await npsPost('/nps/pacs', payload, 90);

    if (status === 200 && body) {
      const parsed = parsePacs002(body);
      const ok = parsed.grpStatus === 'ACSC' || parsed.txStatus === 'ACSC';
      return {
        ok,
        code:         ok ? '00' : (parsed.rejectCode || 'RJCT'),
        reason:       ok ? '' : (parsed.rejectCode || 'Rejected by NPS'),
        orderStatus:  ok ? 'SETTLED' : 'FAILED',
        providerRef:  msgId,
        raw:          body,
      };
    }

    if (status === 0 || status >= 500) {
      // Network / server error — treat as pending (do NOT reverse)
      return { ok: false, code: 'PENDING', reason: `HTTP ${status}`, orderStatus: 'PENDING', providerRef: msgId, raw: body };
    }

    // 4xx — message rejected
    let reason = `HTTP ${status}`;
    if (body && body.includes('<xenc:EncryptedData')) {
      try {
        const dec = decryptContentElement(body);
        reason = (dec.match(/<Rsn><Cd>(\w+)<\/Cd>/) || [])[1] || reason;
      } catch (_) { /* ignore decrypt fail on 400 body */ }
    }
    return { ok: false, code: 'RJCT', reason, orderStatus: 'FAILED', providerRef: msgId, raw: body };

  } catch (e) {
    // Treat unexpected errors as PENDING — never auto-reverse
    return { ok: false, code: 'PENDING', reason: e.message, orderStatus: 'PENDING', providerRef: msgId, raw: null };
  }
}

// ── queryPayoutResult ─────────────────────────────────────────────────────────
// item = { providerRef: original pacs.008 MsgId, orderId }
async function queryPayoutResult(item) {
  if (!isConfigured()) return { ok: false, reason: 'NPS not configured', raw: null };

  const origMsgId = item.providerRef || item.orderId;
  if (!origMsgId) return { ok: false, reason: 'providerRef required', raw: null };

  const msgId = makeMsgId();
  try {
    const xml     = buildPacs028({ msgId, origMsgId, origTxId: origMsgId });
    const payload = prepareOutbound(xml, 'pacs.028');
    const { status, body } = await npsPost('/nps/pacs', payload, 60);

    if (status === 200 && body) {
      const parsed = parsePacs002(body);
      const ok = parsed.grpStatus === 'ACSC' || parsed.txStatus === 'ACSC';
      return {
        ok,
        code:        ok ? '00' : (parsed.rejectCode || parsed.grpStatus || ''),
        reason:      ok ? '' : (parsed.rejectCode || ''),
        orderStatus: ok ? 'SETTLED' : (parsed.grpStatus === 'RJCT' ? 'FAILED' : 'PENDING'),
        raw: body,
      };
    }
    return { ok: false, code: '', reason: `HTTP ${status}`, orderStatus: 'PENDING', raw: body };
  } catch (e) {
    return { ok: false, reason: e.message, orderStatus: 'PENDING', raw: null };
  }
}

// getBalance not supported by NPS — payout rail always pre-funded externally
async function getBalance() {
  return BigInt(0);
}

module.exports = {
  isConfigured,
  getBalance,
  sendPayout,
  queryPayoutResult,
  nameEnquiry,
  // Exposed for inbound webhook handler
  decryptContentElement,
  verifySignature,
  parsePacs002,
};
