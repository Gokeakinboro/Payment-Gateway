'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  NIBSS NPS (National Payment Stack) service — ISO 20022 payouts
//
//  Outbound path: pacs.008 signed+encrypted → NIBSS NPS via VPN tunnel
//  Name enquiry:  acmt.023 signed+encrypted → NIBSS NPS via VPN tunnel
//  Status query:  pacs.028 signed+encrypted → NIBSS NPS
//
//  Sign-then-encrypt per NIBSS spec:
//    1. XMLDSig enveloped, Inclusive C14N 1.0 (REC-xml-c14n-20010315), RSA-SHA256
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
let _paylodePubKeyInfo = null;  // { n: base64, e: base64 }

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

// Load RSA modulus+exponent from our public key for inline KeyInfo in signatures.
// Allows NIBSS to verify without requiring our key to be pre-registered.
function loadPaylodePubKeyInfo() {
  if (_paylodePubKeyInfo !== null) return _paylodePubKeyInfo;
  try {
    const pubKeyPath = PRIVATE_KEY_PATH.replace(/\.key$/, '_public.pem');
    if (!pubKeyPath || !fs.existsSync(pubKeyPath)) { _paylodePubKeyInfo = false; return false; }
    const pem    = fs.readFileSync(pubKeyPath, 'utf8');
    const keyObj = crypto.createPublicKey(pem);
    const jwk    = keyObj.export({ format: 'jwk' });
    // JWK uses base64url; XMLDSig RSAKeyValue uses plain base64
    const b64url2b64 = (s) => (s + '===').slice(0, s.length + (4 - s.length % 4) % 4)
                                         .replace(/-/g, '+').replace(/_/g, '/');
    _paylodePubKeyInfo = { n: b64url2b64(jwk.n), e: b64url2b64(jwk.e) };
  } catch (err) {
    _paylodePubKeyInfo = false;
  }
  return _paylodePubKeyInfo;
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
    iso:     d.toISOString().replace('Z', '+01:00'),
    isoNoMs: d.toISOString().slice(0, 19),   // YYYY-MM-DDTHH:MM:SS (NIBSS acmt format)
    date:    d.toISOString().slice(0, 10) + 'Z',
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
// Inclusive C14N 1.0 (REC-xml-c14n-20010315) as required by NIBSS NPS spec.
// Two Reference transforms: enveloped-signature + C14N 1.0 (matches NIBSS sample).
// RSAKeyValue is embedded in ds:KeyInfo so NIBSS can verify without pre-registration.
const C14N_1_0 = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

function signXml(xmlStr) {
  const pubKeyInfo = loadPaylodePubKeyInfo();
  const sig = new SignedXml({ privateKey: loadPrivateKey() });
  // xml-crypto v6: getKeyInfoContent must be set on the instance, not in constructor options
  if (pubKeyInfo) {
    sig.getKeyInfoContent = function(key, prefix) {
      const p = prefix ? `${prefix}:` : '';
      return `<${p}KeyValue><${p}RSAKeyValue>` +
             `<${p}Modulus>${pubKeyInfo.n}</${p}Modulus>` +
             `<${p}Exponent>${pubKeyInfo.e}</${p}Exponent>` +
             `</${p}RSAKeyValue></${p}KeyValue>`;
    };
  }
  sig.addReference({
    uri:            '',
    isEmptyUri:     true,
    xpath:          '/*',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      C14N_1_0,
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.canonicalizationAlgorithm = C14N_1_0;
  sig.signatureAlgorithm        = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  sig.computeSignature(xmlStr, { prefix: 'ds' });
  return sig.getSignedXml();
}

// ── XML Encryption — Encrypt content element (Type="#Content") ───────────────
// Encrypts only the CHILDREN of <contentTag>, keeping the parent tag intact.
// Structure: <contentTag><xenc:EncryptedData Type="#Content">...</xenc:EncryptedData></contentTag>
// AES-256-GCM content; RSA-OAEP-MGF1P (SHA-1 for OAEP) key wrap
//
// xmlenc11 AES-GCM CipherValue layout: base64(IV[12] || Ciphertext || Tag[16])
function encryptContentElement(xmlStr, contentTag) {
  const openTagStart = xmlStr.indexOf(`<${contentTag}`);
  if (openTagStart < 0) throw new Error(`encryptContentElement: <${contentTag}> not found`);

  // End of the opening tag (e.g. after '>')
  const openTagEnd = xmlStr.indexOf('>', openTagStart) + 1;

  const closeTag      = `</${contentTag}>`;
  const closeTagStart = xmlStr.indexOf(closeTag, openTagStart);
  if (closeTagStart < 0) throw new Error(`encryptContentElement: </${contentTag}> not found`);

  // Encrypt only the children (content between open and close tags)
  const childrenXml = xmlStr.slice(openTagEnd, closeTagStart);

  const aesKey = crypto.randomBytes(32);
  const iv     = crypto.randomBytes(12);

  const cipher   = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ct1      = cipher.update(Buffer.from(childrenXml, 'utf8'));
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

  // Keep the parent tag; replace only its children with EncryptedData
  const openTagStr = xmlStr.slice(openTagStart, openTagEnd);
  return (
    xmlStr.slice(0, openTagStart) +
    openTagStr +
    encryptedData +
    closeTag +
    xmlStr.slice(closeTagStart + closeTag.length)
  );
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
  // Accept both default-namespace <Signature> and prefixed <ds:Signature>
  const sigStart = xmlStr.search(/<(?:ds:)?Signature[\s>]/);
  const sigEnd   = xmlStr.search(/<\/(?:ds:)?Signature>/);
  if (sigStart < 0 || sigEnd < 0) return false;
  const closeTag = xmlStr.slice(sigEnd).match(/^<\/(?:ds:)?Signature>/)[0];
  const sigXml = xmlStr.slice(sigStart, sigEnd + closeTag.length);
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
  'acmt.024': 'IdVrfctnRpt',
  'pain.001': 'CstmrCdtTrfInitn',
  'pain.008': 'CstmrDrctDbtInitn',
};

// NIBSS FTA format requires this declaration on all outbound messages.
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>';

function prepareOutbound(xmlStr, msgType) {
  const tag = CONTENT_TAG[msgType];
  if (!tag) throw new Error(`prepareOutbound: unknown msgType ${msgType}`);
  // Sign first (over plaintext), then encrypt the content element.
  // NIBSS switch decrypts first, then verifies signature against restored plaintext.
  // Prepend XML declaration to final output — required by NIBSS FTA format.
  const signed    = signXml(xmlStr);
  const encrypted = encryptContentElement(signed, tag);
  return XML_DECL + encrypted;
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

  return `<ns2:Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.12"><FIToFICstmrCdtTrf><GrpHdr><MsgId>${esc(msgId)}</MsgId><CreDtTm>${nowWAT().iso}</CreDtTm><BtchBookg>false</BtchBookg><NbOfTxs>1</NbOfTxs><SttlmInf><SttlmMtd>CLRG</SttlmMtd></SttlmInf><InstgAgt><FinInstnId><BICFI>${esc(INSTITUTION_CODE)}</BICFI><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></InstgAgt><InstdAgt><FinInstnId><BICFI>${esc(destMemberId)}</BICFI><ClrSysMmbId><MmbId>${esc(destMemberId)}</MmbId></ClrSysMmbId></FinInstnId></InstdAgt></GrpHdr><CdtTrfTxInf><PmtId><InstrId>${esc(instrId)}</InstrId><EndToEndId>${esc(endToEndId)}</EndToEndId><TxId>${esc(txId)}</TxId></PmtId><PmtTpInf><ClrChanl>RTNS</ClrChanl><SvcLvl><Prtry>0100</Prtry></SvcLvl><LclInstrm><Prtry>CTAA</Prtry></LclInstrm><CtgyPurp><Prtry>001</Prtry></CtgyPurp></PmtTpInf><IntrBkSttlmAmt Ccy="NGN">${esc(amountNaira)}</IntrBkSttlmAmt><IntrBkSttlmDt>${esc(settlementDate)}</IntrBkSttlmDt><ChrgBr>SLEV</ChrgBr><InstgAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></InstgAgt><InstdAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(destMemberId)}</MmbId></ClrSysMmbId></FinInstnId></InstdAgt><Dbtr><Nm>${esc(debtorName)}</Nm></Dbtr><DbtrAcct><Id><IBAN>${esc(debtorAccount)}</IBAN></Id><Nm>${esc(debtorName)}</Nm></DbtrAcct><DbtrAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(debtorAgentId)}</MmbId></ClrSysMmbId></FinInstnId></DbtrAgt><Cdtr><Nm>${esc(creditorName)}</Nm></Cdtr><CdtrAcct><Id><IBAN>${esc(creditorAccount)}</IBAN></Id><Nm>${esc(creditorName)}</Nm></CdtrAcct><CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(creditorAgentId)}</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>${narration ? `<RmtInf><Ustrd>${esc(String(narration).slice(0, 100))}</Ustrd></RmtInf>` : ''}<SplmtryData><PlcAndNm>AdditionalVerificationDetails</PlcAndNm><Envlp><CustomData><DebtorInfo><AccountDesignation>1</AccountDesignation><IdType>BVN</IdType><IdValue>${esc(DEBIT_ACCOUNT_BVN)}</IdValue><AccountTier>${DEBIT_ACCOUNT_TIER}</AccountTier></DebtorInfo><CreditorInfo><AccountDesignation>${creditorDesignation || 1}</AccountDesignation><IdType>${esc(creditorIdType || 'BVN')}</IdType><IdValue>${esc(creditorIdValue || '')}</IdValue><AccountTier>${creditorTier || 3}</AccountTier></CreditorInfo><TransactionInfo><TransactionLocation>${esc(txLocation || '01080652440N020900337921E')}</TransactionLocation><NameEnquiryMsgId>${esc(neEnquiryMsgId || '')}</NameEnquiryMsgId><ChannelCode>${CHANNEL_CODE}</ChannelCode><RiskRating>R000000000000000000B9</RiskRating></TransactionInfo></CustomData></Envlp></SplmtryData></CdtTrfTxInf></FIToFICstmrCdtTrf></ns2:Document>`;
}

// ── acmt.023 builder ──────────────────────────────────────────────────────────
// FTA format: 4-space indentation, CreDtTm with no ms/tz (matches NIBSS sample)
function buildAcmt023(opts) {
  const { msgId, destMemberId, beneficiaryAccount } = opts;
  const creDtTm = nowWAT().isoNoMs;
  return `<ns2:Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:acmt.023.001.04">
    <IdVrfctnReq>
        <Assgnmt>
            <MsgId>${esc(msgId)}</MsgId>
            <CreDtTm>${creDtTm}</CreDtTm>
            <Cretr>
                <Pty>
                    <Nm>${esc(INSTITUTION_NAME)}</Nm>
                </Pty>
            </Cretr>
            <Assgnr>
                <Pty>
                    <Nm>${esc(INSTITUTION_NAME)}</Nm>
                </Pty>
                <Agt>
                    <FinInstnId>
                        <BICFI>${esc(INSTITUTION_CODE)}</BICFI>
                        <ClrSysMmbId>
                            <MmbId>${esc(INSTITUTION_CODE)}</MmbId>
                        </ClrSysMmbId>
                    </FinInstnId>
                </Agt>
            </Assgnr>
            <Assgne>
                <Agt>
                    <FinInstnId>
                        <BICFI>${esc(destMemberId)}</BICFI>
                        <ClrSysMmbId>
                            <MmbId>${esc(destMemberId)}</MmbId>
                        </ClrSysMmbId>
                    </FinInstnId>
                </Agt>
            </Assgne>
        </Assgnmt>
        <Vrfctn>
            <Id>${esc(msgId)}</Id>
            <PtyAndAcctId>
                <Pty>
                    <Nm></Nm>
                </Pty>
                <Acct>
                    <Id>
                        <IBAN>${esc(beneficiaryAccount)}</IBAN>
                    </Id>
                </Acct>
            </PtyAndAcctId>
        </Vrfctn>
    </IdVrfctnReq>
</ns2:Document>`;
}

// ── pacs.028 builder ──────────────────────────────────────────────────────────
function buildPacs028(opts) {
  const { msgId, origMsgId, origTxId } = opts;
  return `<ns2:Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:pacs.028.001.06"><FIToFIPmtStsReq><GrpHdr><MsgId>${esc(msgId)}</MsgId><CreDtTm>${nowWAT().iso}</CreDtTm><InstgAgt><FinInstnId><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></InstgAgt></GrpHdr><OrgnlGrpInf><OrgnlMsgId>${esc(origMsgId)}</OrgnlMsgId><OrgnlMsgNmId>pacs.008.001.12</OrgnlMsgNmId></OrgnlGrpInf><TxInf><StsReqId>${esc(msgId)}</StsReqId><OrgnlTxId>${esc(origTxId)}</OrgnlTxId></TxInf></FIToFIPmtStsReq></ns2:Document>`;
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
    const { status, body } = await npsPost('/nps/acmt', payload);

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
    // HTTP 400 + empty body = NIBSS async ACK (they return 400 for all async responses)
    if (status === 202 || (status === 400 && !body)) {
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

// ── acmt.024 builder — NE response (we respond to NIBSS's acmt.023) ──────────
// status: 'ACCP' (found) | 'RJCT' (not found); rejectCode e.g. 'AC01', 'AC03'
function buildAcmt024(opts) {
  const { msgId, origMsgId, requesterMemberId, accountNumber, accountName, status, rejectCode } = opts;
  const accepted = status !== 'RJCT';
  const now = nowWAT().iso;
  return '<Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:acmt.024.001.04">' +
    '<IdVrfctnRpt>' +
    '<Assgnmt>' +
    '<MsgId>' + esc(msgId) + '</MsgId>' +
    '<CreDtTm>' + now + '</CreDtTm>' +
    '<Cretr><Pty><Nm>' + esc(INSTITUTION_NAME) + '</Nm></Pty></Cretr>' +
    '<Assgnr><Pty><Nm>' + esc(INSTITUTION_NAME) + '</Nm></Pty>' +
    '<Agt><FinInstnId><BICFI>' + esc(INSTITUTION_CODE) + '</BICFI>' +
    '<ClrSysMmbId><MmbId>' + esc(INSTITUTION_CODE) + '</MmbId></ClrSysMmbId>' +
    '</FinInstnId></Agt></Assgnr>' +
    '<Assgne><Agt><FinInstnId><BICFI>' + esc(requesterMemberId) + '</BICFI>' +
    '<ClrSysMmbId><MmbId>' + esc(requesterMemberId) + '</MmbId></ClrSysMmbId>' +
    '</FinInstnId></Agt></Assgne>' +
    '</Assgnmt>' +
    '<OrgnlId>' + esc(origMsgId) + '</OrgnlId>' +
    (accepted
      ? '<Vrfctn><Id>' + esc(origMsgId) + '</Id>' +
        '<PtyAndAcctId><Pty><Nm>' + esc(accountName || '') + '</Nm></Pty>' +
        '<Acct><Id><IBAN>' + esc(accountNumber || '') + '</IBAN></Id></Acct>' +
        '</PtyAndAcctId></Vrfctn>'
      : '<Rpt><Rsn><Cd>' + esc(rejectCode || 'AC01') + '</Cd></Rsn></Rpt>') +
    '</IdVrfctnRpt></Document>';
}

// ── pacs.002 builder — payment status report (we ACK NIBSS's inbound pacs.008) ─
// grpStatus: 'ACCP' (received/processing) | 'ACSC' (settled) | 'RJCT' (rejected)
function buildPacs002(opts) {
  const { msgId, origMsgId, origTxId, grpStatus, rejectCode } = opts;
  return '<Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.14">' +
    '<FIToFIPmtStsRpt>' +
    '<GrpHdr>' +
    '<MsgId>' + esc(msgId) + '</MsgId>' +
    '<CreDtTm>' + nowWAT().iso + '</CreDtTm>' +
    '<InstgAgt><FinInstnId><ClrSysMmbId><MmbId>' + esc(INSTITUTION_CODE) + '</MmbId></ClrSysMmbId></FinInstnId></InstgAgt>' +
    '</GrpHdr>' +
    '<OrgnlGrpInfAndSts>' +
    '<OrgnlMsgId>' + esc(origMsgId) + '</OrgnlMsgId>' +
    '<OrgnlMsgNmId>pacs.008.001.12</OrgnlMsgNmId>' +
    '<GrpSts>' + esc(grpStatus) + '</GrpSts>' +
    (grpStatus === 'RJCT' ? '<StsRsnInf><Rsn><Cd>' + esc(rejectCode || 'MS03') + '</Cd></Rsn></StsRsnInf>' : '') +
    '</OrgnlGrpInfAndSts>' +
    (origTxId
      ? '<TxInfAndSts><OrgnlTxId>' + esc(origTxId) + '</OrgnlTxId>' +
        '<TxSts>' + esc(grpStatus) + '</TxSts></TxInfAndSts>'
      : '') +
    '</FIToFIPmtStsRpt></Document>';
}

// ── parseAcmt023 — extract fields from NIBSS's inbound NE request ─────────────
function parseAcmt023(xmlStr) {
  const msgId          = (xmlStr.match(/<MsgId>([^<]+)<\/MsgId>/)   || [])[1] || '';
  const requesterMid   = (xmlStr.match(/<BICFI>([^<]+)<\/BICFI>/)   || [])[1] || '';
  const accountNumber  = (xmlStr.match(/<IBAN>([^<]+)<\/IBAN>/)     || [])[1] || '';
  return { msgId, requesterMemberId: requesterMid, accountNumber };
}

// ── parsePacs008Inbound — extract fields from NIBSS's inbound credit transfer ──
function parsePacs008Inbound(xmlStr) {
  const msgId        = (xmlStr.match(/<MsgId>([^<]+)<\/MsgId>/)                                                                       || [])[1] || '';
  const txId         = (xmlStr.match(/<TxId>([^<]+)<\/TxId>/)                                                                         || [])[1] || msgId;
  const amountStr    = (xmlStr.match(/<IntrBkSttlmAmt[^>]*>([^<]+)</)                                                                 || [])[1] || '0';
  const currency     = (xmlStr.match(/<IntrBkSttlmAmt[^>]*Ccy="([^"]+)"/)                                                             || [])[1] || 'NGN';
  const creditorAcct = (xmlStr.match(/<CdtrAcct>[\s\S]*?<IBAN>([^<]+)<\/IBAN>[\s\S]*?<\/CdtrAcct>/)                                   || [])[1] || '';
  const creditorNm   = (xmlStr.match(/<Cdtr>[\s\S]*?<Nm>([^<]+)<\/Nm>[\s\S]*?<\/Cdtr>/)                                               || [])[1] || '';
  const debtorNm     = (xmlStr.match(/<Dbtr>[\s\S]*?<Nm>([^<]+)<\/Nm>[\s\S]*?<\/Dbtr>/)                                               || [])[1] || '';
  const senderMid    = (xmlStr.match(/<InstgAgt>[\s\S]*?<MmbId>([^<]+)<\/MmbId>[\s\S]*?<\/InstgAgt>/)                                 || [])[1] || '';
  const narration    = (xmlStr.match(/<Ustrd>([^<]+)<\/Ustrd>/)                                                                       || [])[1] || '';
  return {
    msgId, txId,
    amountKobo: Math.round(parseFloat(amountStr) * 100),
    currency, creditorAccount: creditorAcct, creditorName: creditorNm,
    debtorName: debtorNm, senderMemberId: senderMid, narration,
  };
}

// ── sendAcmt024 — send NE response to NIBSS ───────────────────────────────────
async function sendAcmt024(opts) {
  if (!isConfigured()) return { ok: false, reason: 'NPS not configured' };
  const msgId = makeMsgId();
  try {
    const xml     = buildAcmt024({ msgId, ...opts });
    const payload = prepareOutbound(xml, 'acmt.024');
    const { status } = await npsPost('/nps/acmt', payload);
    return { ok: status === 200 || status === 202, status, msgId };
  } catch (e) {
    return { ok: false, reason: e.message, msgId };
  }
}

// ── sendPacs002 — send payment status report to NIBSS ─────────────────────────
async function sendPacs002(opts) {
  if (!isConfigured()) return { ok: false, reason: 'NPS not configured' };
  const msgId = makeMsgId();
  try {
    const xml     = buildPacs002({ msgId, ...opts });
    const payload = prepareOutbound(xml, 'pacs.002');
    const { status } = await npsPost('/nps/pacs', payload);
    return { ok: status === 200 || status === 202, status, msgId };
  } catch (e) {
    return { ok: false, reason: e.message, msgId };
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
  // Builders (outbound)
  buildAcmt023,
  buildPacs002,
  buildAcmt024,
  // Senders (outbound — triggered by inbound events)
  sendPacs002,
  sendAcmt024,
  // Parsers (inbound)
  parseAcmt023,
  parsePacs008Inbound,
  // Exposed for inbound webhook handler
  decryptContentElement,
  verifySignature,
  parsePacs002,
  // Exposed for testing
  prepareOutbound,
};
