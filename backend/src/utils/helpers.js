'use strict';
const crypto = require('crypto');

// ── API Response helpers ───────────────────────────────────────────────────
const ok = (res, data, message = 'Success', statusCode = 200) =>
  res.status(statusCode).json({ status: true, message, data });

const created = (res, data, message = 'Created') =>
  ok(res, data, message, 201);

const fail = (res, message, errorCode = 'ERROR', statusCode = 400) =>
  res.status(statusCode).json({ status: false, message, error_code: errorCode });

const notFound = (res, what = 'Resource') =>
  fail(res, `${what} not found`, 'NOT_FOUND', 404);

const unauthorized = (res, msg = 'Unauthorized') =>
  fail(res, msg, 'UNAUTHORIZED', 401);

const forbidden = (res, msg = 'Forbidden') =>
  fail(res, msg, 'FORBIDDEN', 403);

// ── Transaction reference generator ───────────────────────────────────────
function generateRef(prefix = 'TXN') {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

// ── Revenue netting formula ─────────────────────────────────────────────
/**
 * Compute all fee fields for a transaction.
 * All amounts in kobo (BigInt).
 *
 * @param {BigInt} amount          Transaction amount in kobo
 * @param {number} merchantRate    e.g. 0.0120 for 1.2%
 * @param {number} railRate        e.g. 0.0150 for 1.5%
 * @param {number} aggSplitPct     e.g. 0.30 for 30%
 */
function computeFees(amount, merchantRate, railRate, aggSplitPct) {
  const amtBig      = BigInt(amount);
  // Use integer arithmetic — multiply by 1,000,000 then divide to preserve 4dp
  const merchantFee = amtBig * BigInt(Math.round(merchantRate * 1_000_000)) / 1_000_000n;
  const railCost    = amtBig * BigInt(Math.round(railRate    * 1_000_000)) / 1_000_000n;
  const netRevenue  = merchantFee - railCost;
  const aggShare    = netRevenue > 0n
    ? netRevenue * BigInt(Math.round(aggSplitPct * 1_000_000)) / 1_000_000n
    : 0n;
  const paylodeMargin = netRevenue - aggShare;
  return { merchantFee, railCost, netRevenue, aggShare, paylodeMargin };
}

// ── Kobo ↔ Naira ──────────────────────────────────────────────────────────
const koboToNaira = kobo => Number(kobo) / 100;
const nairaToKobo = naira => BigInt(Math.round(naira * 100));

// ── Encrypt / Decrypt settlement account numbers ──────────────────────────
const ALGO = 'aes-256-gcm';
const KEY  = Buffer.from(process.env.ENCRYPTION_KEY || '0'.repeat(64), 'hex');

function encrypt(text) {
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(cipher) {
  const [ivHex, tagHex, encHex] = cipher.split(':');
  const iv  = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const d   = crypto.createDecipheriv(ALGO, KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ── API key hashing ────────────────────────────────────────────────────────
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

// ── Webhook signature ─────────────────────────────────────────────────────
function signWebhook(payload, secret) {
  return crypto.createHmac('sha512', secret)
    .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    .digest('hex');
}

function verifyWebhookSig(rawBody, signature, secret) {
  const expected = signWebhook(rawBody, secret);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

module.exports = {
  ok, created, fail, notFound, unauthorized, forbidden,
  generateRef, computeFees, koboToNaira, nairaToKobo,
  encrypt, decrypt, hashApiKey, generateApiKey,
  signWebhook, verifyWebhookSig,
};
