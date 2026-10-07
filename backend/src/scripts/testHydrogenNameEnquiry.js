'use strict';
// One-shot sandbox test — Hydrogen Name Enquiry (acmt.023)
// Run on server 176:
//   node backend/src/scripts/testHydrogenNameEnquiry.js
//
// Does NOT require HYDROGEN_ENABLED or DEBIT_ACCOUNT — invokes the
// encryption/request layer directly so the main env gate is bypassed.
// Delete this file after sandbox testing is done.

const path    = require('path');
const fs      = require('fs');
const openpgp = require('openpgp');
const crypto  = require('crypto');
const https   = require('https');
const { URL } = require('url');

// ── Adjust these if the key paths differ on 176 ──────────────────────────────
const HYDROGEN_PUBLIC_KEY_PATH  = path.resolve(__dirname, '../../keys/hydrogen/hydrogen_public.asc');
const OUR_PRIVATE_KEY_PATH      = path.resolve(__dirname, '../../keys/hydrogen/paylode_private.asc');
const PASSPHRASE_PATH           = path.resolve(__dirname, '../../keys/hydrogen/PASSPHRASE.txt');

const INSTITUTION_CODE  = '991052';
const INSTITUTION_NAME  = 'PAYLODE SERVICES LIMITED';
const BASE_URL          = 'https://sandbox-bankai-service.hydrogenpay.com';

// Test target (Hydrogen sandbox test account)
const DEST_BANK_CODE    = '111444';
const DEST_ACCOUNT      = '1010101010';

// ── Helpers (inlined so this script is self-contained) ───────────────────────
function randomDigits(n) {
  return Array.from(crypto.randomBytes(n)).map(b => String(b % 10)).join('').slice(0, n).padEnd(n, '0');
}
function nowUTC() {
  const d = new Date();
  return { iso: d.toISOString(), yyyyMMddHHmmss: d.toISOString().replace(/[-T:.Z]/g,'').slice(0,14) };
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&apos;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function loadKeys() {
  const hydrogenArmored = fs.readFileSync(HYDROGEN_PUBLIC_KEY_PATH, 'utf8');
  const ourArmored      = fs.readFileSync(OUR_PRIVATE_KEY_PATH,     'utf8');
  const passphrase      = fs.existsSync(PASSPHRASE_PATH) ? fs.readFileSync(PASSPHRASE_PATH, 'utf8').trim() : '';

  const hydrogenPublicKey = await openpgp.readKey({ armoredKey: hydrogenArmored });
  let ourPrivateKey = await openpgp.readPrivateKey({ armoredKey: ourArmored });
  if (passphrase) ourPrivateKey = await openpgp.decryptKey({ privateKey: ourPrivateKey, passphrase });

  return { hydrogenPublicKey, ourPrivateKey };
}

async function pgpEncryptToHex(text, hydrogenPublicKey) {
  const message   = await openpgp.createMessage({ text });
  const encrypted = await openpgp.encrypt({ message, encryptionKeys: hydrogenPublicKey, format: 'binary', config: { allowMissingKeyFlags: true, aeadProtect: false } });
  return Buffer.from(encrypted).toString('hex').toUpperCase();
}

async function pgpDecrypt(cipherValue, ourPrivateKey) {
  if (cipherValue.startsWith('-----BEGIN PGP')) {
    const msg = await openpgp.readMessage({ armoredMessage: cipherValue });
    const { data } = await openpgp.decrypt({ message: msg, decryptionKeys: ourPrivateKey, format: 'binary' });
    return Buffer.from(data).toString('utf8');
  }
  // Hex-encoded binary fallback
  const buf = Buffer.from(cipherValue.replace(/\s+/g,''), 'hex');
  const msg = await openpgp.readMessage({ binaryMessage: buf });
  const { data } = await openpgp.decrypt({ message: msg, decryptionKeys: ourPrivateKey, format: 'binary' });
  return Buffer.from(data).toString('utf8');
}

function buildAcmt023(msgId) {
  const ns = 'urn:iso:std:iso:20022:tech:xsd:acmt.023.001.04';
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><ns2:Document xmlns:ns2="${ns}"><IdVrfctnReq><Assgnmt><MsgId>${esc(msgId)}</MsgId><CreDtTm>${nowUTC().iso}</CreDtTm><Cretr><Pty><Nm>${esc(INSTITUTION_NAME)}</Nm></Pty></Cretr><Assgnr><Pty><Nm>${esc(INSTITUTION_NAME)}</Nm></Pty><Agt><FinInstnId><BICFI>${esc(INSTITUTION_CODE)}</BICFI><ClrSysMmbId><MmbId>${esc(INSTITUTION_CODE)}</MmbId></ClrSysMmbId></FinInstnId></Agt></Assgnr><Assgne><Agt><FinInstnId><BICFI>${esc(DEST_BANK_CODE)}</BICFI><ClrSysMmbId><MmbId>${esc(DEST_BANK_CODE)}</MmbId></ClrSysMmbId></FinInstnId></Agt></Assgne></Assgnmt><Vrfctn><Id>${esc(msgId)}</Id><PtyAndAcctId><Acct><Id><IBAN>${esc(DEST_ACCOUNT)}</IBAN></Id></Acct></PtyAndAcctId></Vrfctn></IdVrfctnReq></ns2:Document>`;
}

async function encryptContentElement(xmlStr, contentTag, hydrogenPublicKey) {
  const openTag  = `<${contentTag}`;
  const closeTag = `</${contentTag}>`;
  const elemStart  = xmlStr.indexOf(openTag);
  const openEnd    = xmlStr.indexOf('>', elemStart) + 1;
  const closeStart = xmlStr.indexOf(closeTag, openEnd);
  const innerContent = xmlStr.slice(openEnd, closeStart);
  const nsMatch = xmlStr.match(/xmlns:ns2="([^"]+)"/);
  const ns = nsMatch ? nsMatch[1] : '';
  const plainDocument = ns
    ? `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="${ns}"><${contentTag}>${innerContent}</${contentTag}></Document>`
    : `<${contentTag}>${innerContent}</${contentTag}>`;
  const hex = await pgpEncryptToHex(plainDocument, hydrogenPublicKey);
  const enc = `<xenc:EncryptedData Type="http://www.w3.org/2001/04/xmlenc#Content" xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"><xenc:CipherData><xenc:CipherValue>${hex}</xenc:CipherValue></xenc:CipherData></xenc:EncryptedData>`;
  return xmlStr.slice(0, openEnd) + enc + xmlStr.slice(closeStart);
}

function post(urlPath, body, contentType) {
  return new Promise((resolve) => {
    const url  = new URL(BASE_URL + urlPath);
    const data = Buffer.from(body, 'utf8');
    const req  = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': data.length, 'Accept': contentType },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error',   e => resolve({ status: 0, body: '', error: e.message }));
    req.write(data);
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Loading PGP keys...');
  const { hydrogenPublicKey, ourPrivateKey } = await loadKeys();
  console.log('Keys loaded.');

  const t      = nowUTC();
  const msgId  = INSTITUTION_CODE + t.yyyyMMddHHmmss.slice(2) + randomDigits(12);
  console.log(`\nMsgId: ${msgId}`);
  console.log(`Dest:  bank=${DEST_BANK_CODE}  account=${DEST_ACCOUNT}\n`);

  const xml     = buildAcmt023(msgId);
  const payload = await encryptContentElement(xml, 'IdVrfctnReq', hydrogenPublicKey);

  console.log('--- REQUEST BODY (first 300 chars) ---');
  console.log(payload.slice(0, 300));
  console.log('...\n');

  const { status, body, error } = await post('/eft/v1/acmt023', payload, 'application/xml; charset=UTF-8');
  console.log(`HTTP status: ${status}`);
  if (error) { console.error('Network error:', error); process.exit(1); }

  console.log('\n--- RAW RESPONSE ---');
  console.log(body);

  // Try to decrypt response
  const cipherMatch = body.match(/<xenc:CipherValue>([\s\S]+?)<\/xenc:CipherValue>/);
  if (cipherMatch) {
    try {
      const decrypted = await pgpDecrypt(cipherMatch[1].trim(), ourPrivateKey);
      console.log('\n--- DECRYPTED RESPONSE ---');
      console.log(decrypted);
      const name = (decrypted.match(/<Nm>([^<]+)<\/Nm>/) || [])[1] || '(not found)';
      const vrfctn = (decrypted.match(/<Vrfctn>(true|false)<\/Vrfctn>/i) || [])[1] || '(not found)';
      console.log(`\n✓ Account name : ${name}`);
      console.log(`✓ Verified     : ${vrfctn}`);
    } catch (e) {
      console.error('\nDecrypt failed:', e.message);
    }
  } else {
    console.log('\n(No xenc:CipherValue in response — may be an error message)');
  }
})();
