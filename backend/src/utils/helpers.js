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
 * Compute all fee fields for a transaction (legacy — simple % only).
 * All amounts in kobo (BigInt).
 */
function computeFees(amount, merchantRate, railRate, aggSplitPct) {
  return computeFeesWithConfig(amount, { rate: merchantRate }, railRate, aggSplitPct);
}

/**
 * Compute fee for a single product using its rate config.
 * Supports four fee models: PCT, FLAT, PCT_PLUS_FLAT, GREATER_OF.
 * Applies min/max clamping and returns fee + VAT separately.
 *
 * @param {BigInt|number} amount     Transaction amount in kobo
 * @param {object}        rateConfig { rate, flat_fee|flatFee, cap, min_charge|minCharge,
 *                                     fee_model|feeModel, vat_rate|vatRate }
 * @returns {{ fee: BigInt, vat: BigInt, total: BigInt }}
 */
function computeProductFee(amount, rateConfig) {
  const amt       = BigInt(amount);
  const rate      = Number(rateConfig.rate      || 0);
  const flatFee   = BigInt(rateConfig.flat_fee  || rateConfig.flatFee   || 0);
  const capFee    = BigInt(rateConfig.cap       || 0);
  const minCharge = BigInt(rateConfig.min_charge|| rateConfig.minCharge || 0);
  const feeModel  = rateConfig.fee_model        || rateConfig.feeModel  || 'PCT';
  const vatRate   = Number(rateConfig.vat_rate  || rateConfig.vatRate   || 0.075);

  const pctFee  = amt * BigInt(Math.round(rate * 1_000_000)) / 1_000_000n;

  let fee;
  switch (feeModel) {
    case 'FLAT':           fee = flatFee; break;
    case 'PCT_PLUS_FLAT':  fee = pctFee + flatFee; break;
    case 'GREATER_OF':     fee = pctFee > flatFee ? pctFee : flatFee; break;
    case 'PCT':
    default:               fee = pctFee + flatFee; break; // flatFee is additive even in PCT mode
  }

  if (minCharge > 0n && fee < minCharge) fee = minCharge;
  if (capFee    > 0n && fee > capFee)    fee = capFee;

  const vat   = fee * BigInt(Math.round(vatRate * 1_000_000)) / 1_000_000n;
  return { fee, vat, total: fee + vat };
}

/**
 * Compute all fee fields for a transaction (legacy — simple % only).
 * All amounts in kobo (BigInt).
 */
function computeFees(amount, merchantRate, railRate, aggSplitPct) {
  return computeFeesWithConfig(amount, { rate: merchantRate }, railRate, aggSplitPct);
}

/**
 * Compute fees using a full rate config.
 * @param {BigInt|number} amount     Transaction amount in kobo
 * @param {object}        rateConfig { rate, flat_fee, cap, min_charge, fee_model, vat_rate }
 * @param {number}        railRate   e.g. 0.0150 for 1.5%
 * @param {number}        aggSplitPct e.g. 0.30 for 30%
 */
function computeFeesWithConfig(amount, rateConfig, railRate, aggSplitPct) {
  const amtBig          = BigInt(amount);
  const { fee: merchantFee } = computeProductFee(amount, rateConfig);

  const railCost      = amtBig * BigInt(Math.round((railRate || 0) * 1_000_000)) / 1_000_000n;
  const netRevenue    = merchantFee - railCost;
  const aggShare      = netRevenue > 0n
    ? netRevenue * BigInt(Math.round((aggSplitPct || 0) * 1_000_000)) / 1_000_000n
    : 0n;
  const paylodeMargin = netRevenue - aggShare;
  return { merchantFee, railCost, netRevenue, aggShare, paylodeMargin };
}

// ── Card scheme detection (from BIN / first digits) ─────────────────────────
// Returns VISA | MASTERCARD | AMEX | DINERS | null
function detectCardScheme(binOrNumber) {
  if (!binOrNumber) return null;
  const n = String(binOrNumber).replace(/\D/g, '');
  if (!n) return null;
  if (/^4/.test(n)) return 'VISA';
  if (/^3[47]/.test(n)) return 'AMEX';
  if (/^3(?:0[0-5]|[68])/.test(n)) return 'DINERS';           // 300-305, 36, 38
  if (/^5[1-5]/.test(n)) return 'MASTERCARD';
  if (/^2(?:2[2-9]|[3-6]\d|7[01]|720)/.test(n)) return 'MASTERCARD'; // 2221-2720
  return null;
}

const VALID_CARD_SCHEMES = ['VISA', 'MASTERCARD', 'AMEX', 'DINERS'];

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
  generateRef, computeFees, computeFeesWithConfig, computeProductFee,
  detectCardScheme, VALID_CARD_SCHEMES,
  koboToNaira, nairaToKobo,
  encrypt, decrypt, hashApiKey, generateApiKey,
  signWebhook, verifyWebhookSig,
};
