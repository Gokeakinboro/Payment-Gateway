'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Parallex MPGS (Mastercard Payment Gateway Services) — card payment client.
//  Standard MPGS REST API. Each merchant has their own MID + API password issued
//  by Parallex; credentials live in merchant_mpgs_configs (per-merchant row).
//
//  Auth: HTTP Basic Auth — username = merchant.{MID}, password = apiPassword.
//  Money: MPGS uses naira with 2 decimal places; our system = kobo (BigInt).
//
//  3DS: pending Parallex confirmation on who handles the challenge flow (Parallex
//  or Paylode). This file handles the direct PAY operation only. 3DS wiring will
//  be added as a separate layer once that is confirmed.
//
//  Env (optional global defaults; per-merchant config in DB takes precedence):
//    MPGS_VERSION   — MPGS REST API version integer, default 77
// ─────────────────────────────────────────────────────────────────────────────

const MPGS_VERSION = process.env.MPGS_VERSION || '77';

// ── Kobo ↔ naira ─────────────────────────────────────────────────────────────
const nairaFromKobo = (kobo) => (Number(kobo) / 100).toFixed(2);

// ── Auth ─────────────────────────────────────────────────────────────────────
function basicAuth(mid, apiPassword) {
  const creds = Buffer.from(`merchant.${mid}:${apiPassword}`, 'utf8').toString('base64');
  return `Basic ${creds}`;
}

// ── MPGS ID sanitisation ─────────────────────────────────────────────────────
// MPGS orderId/transactionId: alphanumeric + hyphens, max 40 chars.
function mpgsOrderId(reference) {
  return String(reference).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
}

// ── Card-type detection from BIN ─────────────────────────────────────────────
function cardTypeFromNumber(pan) {
  const n = String(pan).replace(/\s/g, '');
  if (/^4/.test(n)) return 'VISA';
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return 'MASTERCARD';
  if (/^6/.test(n)) return 'VERVE';
  return 'UNKNOWN';
}

// ── Payload transformer: Paylode format → MPGS REST body ─────────────────────
function toMpgsPayload({ amount, currency = 'NGN', description, card, customer, reference }) {
  const body = {
    apiOperation: 'PAY',
    order: {
      amount: nairaFromKobo(amount),
      currency,
      description: description || 'Paylode payment',
    },
    sourceOfFunds: {
      type: 'CARD',
      provided: {
        card: {
          number: String(card.number).replace(/\s/g, ''),
          expiry: {
            month: String(card.expiry_month).padStart(2, '0'),
            year:  String(card.expiry_year).slice(-2),
          },
          securityCode: String(card.cvv),
          ...(card.name ? { nameOnCard: card.name } : {}),
        },
      },
    },
    transaction: { reference },
  };

  if (customer) {
    body.customer = {};
    if (customer.email)      body.customer.email     = customer.email;
    if (customer.phone)      body.customer.phone     = customer.phone;
    if (customer.first_name) body.customer.firstName = customer.first_name;
    if (customer.last_name)  body.customer.lastName  = customer.last_name;
    if (customer.ip_address) body.customer.ipAddress = customer.ip_address;
  }

  return body;
}

// ── Response normaliser: MPGS response → standard result shape ────────────────
// MPGS result values: SUCCESS | FAILURE | PENDING | UNKNOWN
// PENDING occurs when 3DS challenge is required — MPGS returns a redirectUrl.
// Frictionless 3DS2 completes silently and returns SUCCESS directly.
function fromMpgsResponse(r) {
  const result       = (r && r.result) || 'UNKNOWN';
  const ok           = result === 'SUCCESS';
  const pending3ds   = result === 'PENDING' && !!(r?.authentication?.redirectUrl);
  const gatewayCode  = r?.response?.gatewayCode    || null;  // APPROVED | DECLINED | PENDING_AUTHENTICATION
  const acquirerCode = r?.response?.acquirerCode   || null;
  const authCode     = r?.transaction?.authorizationCode || null;
  const declineCode  = r?.response?.acquirerMessage || r?.response?.gatewayRecommendation || null;
  return {
    ok,
    pending3ds,
    result,
    gatewayCode,
    acquirerCode,
    authorizationCode: authCode,
    declineReason:     (ok || pending3ds) ? null : (declineCode || gatewayCode || 'DECLINED'),
    // 3DS challenge redirect — merchant must send customer here; MPGS hosts the challenge page
    authRedirectUrl:   r?.authentication?.redirectUrl || null,
    auth3dsVersion:    r?.authentication?.version     || null,
    mpgsOrderId:       r?.order?.id       || null,
    mpgsTransactionId: r?.transaction?.id || null,
    raw: r,
  };
}

// ── Sandbox mock response (no real MPGS call) ─────────────────────────────────
// Test card 4111111111111111 → VISA success; 4000000000000002 → decline.
const DECLINE_PANS = new Set(['4000000000000002', '5105105105105100']);
function buildSandboxResponse(cardNumber) {
  const pan = String(cardNumber).replace(/\s/g, '');
  if (DECLINE_PANS.has(pan)) {
    return { ok: false, result: 'FAILURE', gatewayCode: 'DECLINED', acquirerCode: '05',
             authorizationCode: null, declineReason: 'Do not honour', mpgsOrderId: null,
             mpgsTransactionId: null, raw: { result: 'FAILURE', response: { gatewayCode: 'DECLINED' } } };
  }
  return { ok: true, result: 'SUCCESS', gatewayCode: 'APPROVED', acquirerCode: '00',
           authorizationCode: 'SANDBOX', declineReason: null,
           mpgsOrderId: `SANDBOX-${Date.now()}`, mpgsTransactionId: '1',
           raw: { result: 'SUCCESS', response: { gatewayCode: 'APPROVED', acquirerCode: '00' } } };
}

/**
 * Charge a card through MPGS.
 * @param {object} config   { mpgsMid, mpgsApiPassword, mpgsBaseUrl } from merchant_mpgs_configs
 * @param {object} payload  { amount(kobo), currency, reference, description, card, customer }
 * @param {boolean} sandbox  if true, return a mock response without calling MPGS
 */
async function charge(config, payload, sandbox = false) {
  if (sandbox) return buildSandboxResponse(payload.card.number);

  const { mpgsMid, mpgsApiPassword, mpgsBaseUrl } = config;
  const baseUrl = mpgsBaseUrl.replace(/\/$/, '');
  const orderId = mpgsOrderId(payload.reference);
  const url = `${baseUrl}/merchant/${mpgsMid}/order/${orderId}/transaction/1`;

  const body = toMpgsPayload(payload);
  const res = await fetch(url, {
    method:  'PUT',
    headers: {
      Authorization:  basicAuth(mpgsMid, mpgsApiPassword),
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({
    result: 'FAILURE',
    error:  { cause: 'NON_JSON_RESPONSE', explanation: `HTTP ${res.status}` },
  }));

  return fromMpgsResponse(json);
}

/**
 * Retrieve an MPGS order — used for requery / reconciliation.
 */
async function getOrder(config, reference) {
  const { mpgsMid, mpgsApiPassword, mpgsBaseUrl } = config;
  const baseUrl = mpgsBaseUrl.replace(/\/$/, '');
  const url = `${baseUrl}/merchant/${mpgsMid}/order/${mpgsOrderId(reference)}`;
  const res = await fetch(url, {
    method:  'GET',
    headers: { Authorization: basicAuth(mpgsMid, mpgsApiPassword), Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({ result: 'UNKNOWN' }));
  return { ok: json.result === 'SUCCESS', raw: json };
}

module.exports = {
  charge, getOrder,
  toMpgsPayload, fromMpgsResponse, buildSandboxResponse,
  cardTypeFromNumber, nairaFromKobo, mpgsOrderId, MPGS_VERSION,
};
