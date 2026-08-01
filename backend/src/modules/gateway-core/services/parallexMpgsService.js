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
function toMpgsPayload({ amount, currency = 'NGN', description, card, customer, reference,
                         apiOperation = 'PAY', authentication = null }) {
  const body = {
    apiOperation,
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

  // MPGS needs this to redirect the cardholder back after a 3DS challenge
  if (authentication?.redirectResponseUrl) {
    body.authentication = { redirectResponseUrl: authentication.redirectResponseUrl };
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
 * Charge a card through MPGS using the 3DS2 three-step flow:
 *   1. INITIATE_AUTHENTICATION  — enrol check (card + currency)
 *   2. AUTHENTICATE_PAYER       — 3DS2 challenge/frictionless (browser data + card + amount)
 *   3. PAY                      — capture (full card + txnId=2)
 *
 * If step 2 returns PENDING (challenge required), we return { pending3ds:true, authRedirectUrl }
 * and the caller handles the redirect.  The gateway's 3DS callback then calls payAfterChallenge()
 * to complete step 3 once the cardholder returns.
 *
 * @param {object} config    { mpgsMid, mpgsApiPassword, mpgsBaseUrl }
 * @param {object} payload   { amount(kobo), currency, reference, description, card, customer,
 *                             apiOperation?, browserData? }
 * @param {boolean} sandbox  if true, return a mock response without calling MPGS
 */
async function charge(config, payload, sandbox = false) {
  if (sandbox) return buildSandboxResponse(payload.card.number);

  const { mpgsMid, mpgsApiPassword, mpgsBaseUrl } = config;
  const baseUrl = mpgsBaseUrl.replace(/\/$/, '');
  const orderId = mpgsOrderId(payload.reference);
  const auth    = basicAuth(mpgsMid, mpgsApiPassword);
  const headers = { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' };

  async function put(txnId, body) {
    const url = `${baseUrl}/merchant/${mpgsMid}/order/${orderId}/transaction/${txnId}`;
    const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
    return res.json().catch(() => ({ result: 'FAILURE', error: { cause: 'NON_JSON_RESPONSE', explanation: `HTTP ${res.status}` } }));
  }

  const pan  = String(payload.card.number).replace(/\s/g, '');
  const exp  = { month: String(payload.card.expiry_month).padStart(2, '0'), year: String(payload.card.expiry_year).slice(-2) };
  const bd   = payload.browserData || {};
  const appUrl = process.env.APP_URL || 'https://api.paylodeservices.com';

  // ── Step 1: INITIATE_AUTHENTICATION ──────────────────────────────────────────
  const init = await put('1', {
    apiOperation: 'INITIATE_AUTHENTICATION',
    authentication: { channel: 'PAYER_BROWSER', purpose: 'PAYMENT_TRANSACTION' },
    order: { currency: payload.currency },
    sourceOfFunds: { type: 'CARD', provided: { card: { number: pan, expiry: exp } } },
  });

  // If initiation errors, fall back to a direct PAY (Parallex may not have 3DS configured)
  if (init.result === 'ERROR') {
    const direct = await put('1', toMpgsPayload(payload));
    return fromMpgsResponse(direct);
  }

  // ── 3DS Method (browser fingerprinting) ──────────────────────────────────────
  // Some issuers (e.g. UBA) require the 3DS Method iframe to complete before
  // AUTHENTICATE_PAYER or the ACS immediately returns transactionStatus N (timeout).
  // For server-side flows we POST to the methodUrl directly — this sets
  // methodCompleted=true on the MPGS 3DS server so the ACS doesn't reject the auth.
  const m3ds = init.authentication?.['3ds2'] || {};
  if (m3ds.methodSupported === 'SUPPORTED' && m3ds.methodUrl && m3ds['3dsServerTransactionId']) {
    const notifyUrl = `${appUrl}/api/rest/3ds/method-notify`;
    const methodData = Buffer.from(JSON.stringify({
      threeDSServerTransId: m3ds['3dsServerTransactionId'],
      threeDSMethodNotificationURL: notifyUrl,
    })).toString('base64url');
    await fetch(m3ds.methodUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `threeDSMethodData=${encodeURIComponent(methodData)}`,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
  }

  // ── Step 2: AUTHENTICATE_PAYER ───────────────────────────────────────────────
  const callbackUrl = `${appUrl}/api/rest/3ds/callback?ref=${encodeURIComponent(payload.reference)}`;
  const auth2 = await fetch(
    `${baseUrl}/merchant/${mpgsMid}/order/${orderId}/transaction/1`,
    {
      method: 'PUT', headers,
      body: JSON.stringify({
        apiOperation: 'AUTHENTICATE_PAYER',
        authentication: { redirectResponseUrl: callbackUrl },
        device: {
          browser: bd.browser || 'MOZILLA',
          browserDetails: {
            '3DSecureChallengeWindowSize': bd.challengeWindowSize || '500_X_600',
            acceptHeaders:  bd.acceptHeaders  || 'application/json',
            colorDepth:     bd.colorDepth     ?? 24,
            javaEnabled:    bd.javaEnabled    ?? true,
            language:       bd.language       || 'en-NG',
            screenHeight:   bd.screenHeight   ?? 900,
            screenWidth:    bd.screenWidth    ?? 1440,
            timeZone:       bd.timeZone       ?? 0,
          },
          ipAddress: bd.ipAddress || payload.customer?.ip_address || '0.0.0.0',
        },
        order: { currency: payload.currency, amount: nairaFromKobo(payload.amount) },
        sourceOfFunds: { provided: { card: {
          number: pan, expiry: exp, securityCode: String(payload.card.cvv),
        }}},
      }),
    }
  ).then(r => r.json()).catch(() => ({ result: 'FAILURE', error: { cause: 'NON_JSON_RESPONSE' } }));

  const txnStatus        = auth2.authentication?.['3ds2']?.transactionStatus;
  const payerInteraction = auth2.authentication?.payerInteraction;
  const serverTransId    = auth2.authentication?.['3ds2']?.['3dsServerTransactionId'] || null;
  if (auth2.result === 'PENDING' || txnStatus === 'C' || payerInteraction === 'REQUIRED') {
    const redirect = auth2.authentication?.redirect || {};
    return {
      ok: false, pending3ds: true, result: 'PENDING',
      gatewayCode:              'PENDING_AUTHENTICATION',
      threeDSServerTransactionId: serverTransId,
      authRedirectUrl:          redirect?.customizedHtml?.['3ds2']?.acsUrl || null,
      authRedirectHtml:         redirect?.html || auth2.authentication?.redirectHtml || null,
      auth3dsVersion:           auth2.authentication?.version || '3DS2',
      mpgsOrderId:              orderId, mpgsTransactionId: '1',
      raw: auth2,
    };
  }

  // ── Step 3: PAY (frictionless — no challenge needed) ─────────────────────────
  // txnId=2: MPGS uses txnId=1 for AUTHENTICATE_PAYER; PAY must be a different transaction slot.
  // authentication.transactionId links this PAY to the completed 3DS session on MPGS's side.
  const pay = await fetch(
    `${baseUrl}/merchant/${mpgsMid}/order/${orderId}/transaction/2`,
    {
      method: 'PUT', headers,
      body: JSON.stringify({
        apiOperation: payload.apiOperation || 'PAY',
        authentication: { transactionId: '1' },
        order: { amount: nairaFromKobo(payload.amount), currency: payload.currency, description: payload.description || 'Paylode payment' },
        transaction: { reference: payload.reference },
      }),
    }
  ).then(r => r.json()).catch(() => ({ result: 'FAILURE', error: { cause: 'NON_JSON_RESPONSE' } }));

  return fromMpgsResponse(pay);
}

/**
 * Step 2 of the 3DS2 flow — called server-side after the browser has run the
 * 3DS Method (fingerprinting) iframe.  Calls AUTHENTICATE_PAYER and returns:
 *   • pending3ds: true  — challenge required, authRedirectHtml contains challenge page
 *   • ok: true          — frictionless success, PAY should be called immediately
 *   • ok: false         — frictionless failure
 */
async function authenticatePayer(config, payload) {
  const { mpgsMid, mpgsApiPassword, mpgsBaseUrl } = config;
  const baseUrl = mpgsBaseUrl.replace(/\/$/, '');
  const orderId = mpgsOrderId(payload.reference);
  const auth    = basicAuth(mpgsMid, mpgsApiPassword);
  const headers = { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' };
  const appUrl  = process.env.APP_URL || 'https://api.paylodeservices.com';

  const bd          = payload.browserData || {};
  const callbackUrl = `${appUrl}/api/rest/3ds/callback?ref=${encodeURIComponent(payload.reference)}`;

  const pan = String(payload.card.number).replace(/\s/g, '');
  const exp = { month: String(payload.card.expiry_month).padStart(2, '0'), year: String(payload.card.expiry_year).slice(-2) };

  const auth2 = await fetch(
    `${baseUrl}/merchant/${mpgsMid}/order/${orderId}/transaction/1`,
    {
      method: 'PUT', headers,
      body: JSON.stringify({
        apiOperation: 'AUTHENTICATE_PAYER',
        authentication: { redirectResponseUrl: callbackUrl },
        device: {
          browser: bd.browser || 'MOZILLA',
          browserDetails: {
            '3DSecureChallengeWindowSize': bd.challengeWindowSize || '500_X_600',
            acceptHeaders:  bd.acceptHeaders  || 'application/json',
            colorDepth:     bd.colorDepth     ?? 24,
            javaEnabled:    bd.javaEnabled    ?? true,
            language:       bd.language       || 'en-NG',
            screenHeight:   bd.screenHeight   ?? 900,
            screenWidth:    bd.screenWidth    ?? 1440,
            timeZone:       bd.timeZone       ?? 0,
          },
          ipAddress: bd.ipAddress || payload.customer?.ip_address || '0.0.0.0',
        },
        order: { currency: payload.currency, amount: nairaFromKobo(payload.amount) },
        sourceOfFunds: { provided: { card: { number: pan, expiry: exp, securityCode: String(payload.card.cvv) } } },
      }),
    }
  ).then(r => r.json()).catch(() => ({ result: 'FAILURE', error: { cause: 'NON_JSON_RESPONSE' } }));

  const txnStatus        = auth2.authentication?.['3ds2']?.transactionStatus;
  const payerInteraction = auth2.authentication?.payerInteraction;
  if (auth2.result === 'PENDING' || txnStatus === 'C' || payerInteraction === 'REQUIRED') {
    const redirect = auth2.authentication?.redirect || {};
    return {
      ok: false, pending3ds: true, result: 'PENDING',
      gatewayCode:              'PENDING_AUTHENTICATION',
      threeDSServerTransactionId: auth2.authentication?.['3ds2']?.['3dsServerTransactionId'] || null,
      authRedirectUrl:          redirect?.customizedHtml?.['3ds2']?.acsUrl || null,
      authRedirectHtml:         redirect?.html || auth2.authentication?.redirectHtml || null,
      auth3dsVersion:           auth2.authentication?.version || '3DS2',
      mpgsOrderId:              orderId, mpgsTransactionId: '1',
      raw: auth2,
    };
  }

  // Frictionless outcome — check if we need to PAY immediately
  if (auth2.result === 'SUCCESS' || auth2.result === 'FAILURE') {
    return fromMpgsResponse(auth2);
  }

  // Unknown result — treat as error
  return { ok: false, result: auth2.result || 'UNKNOWN', raw: auth2 };
}

/**
 * Complete a PAY after a 3DS challenge — called from the 3DS callback endpoint.
 * Uses txnId=2 (new slot in same order; txnId=1 was consumed by AUTHENTICATE_PAYER).
 * sourceOfFunds must be re-provided — MPGS requires card data on the PAY call.
 */
async function payAfterChallenge(config, { reference, amount, currency, description, apiOperation, card, threeDSServerTransactionId }) {
  const { mpgsMid, mpgsApiPassword, mpgsBaseUrl } = config;
  const baseUrl = mpgsBaseUrl.replace(/\/$/, '');
  const orderId = mpgsOrderId(reference);
  const url     = `${baseUrl}/merchant/${mpgsMid}/order/${orderId}/transaction/2`;

  const body = {
    apiOperation: apiOperation || 'PAY',
    // authentication.transactionId = the MPGS txnId used for AUTHENTICATE_PAYER (always "1").
    // This links the PAY to the completed 3DS session for this order.
    // Do NOT use the 3dsServerTransactionId UUID here — MPGS expects the simple txnId string.
    authentication: { transactionId: '1' },
    order: { amount: nairaFromKobo(amount), currency, description: description || 'Paylode payment' },
    transaction: { reference },
  };

  if (card) {
    body.sourceOfFunds = {
      type: 'CARD',
      provided: { card: {
        number:       String(card.number).replace(/\s/g, ''),
        expiry:       { month: String(card.expiry_month).padStart(2, '0'), year: String(card.expiry_year).slice(-2) },
        securityCode: String(card.cvv),
      }},
    };
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: basicAuth(mpgsMid, mpgsApiPassword), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({ result: 'FAILURE', error: { cause: 'NON_JSON_RESPONSE' } }));
  console.error('[payAfterChallenge] MPGS raw:', JSON.stringify(json));
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

/**
 * Browser-checkout entry point — INITIATE_AUTHENTICATION only.
 * Returns method details so the browser can run the 3DS Method iframe,
 * then call authenticatePayer() via the /mpgs-step2 checkout endpoint.
 *
 * Returns:
 *   { ok:false, error }                                   — MPGS rejected init
 *   { ok:true, needsMethod:true,  methodUrl, methodData } — browser must run iframe
 *   { ok:true, needsMethod:false }                        — skip straight to step2
 */
async function initiateFor3ds(config, { reference, currency, card }) {
  const { mpgsMid, mpgsApiPassword, mpgsBaseUrl } = config;
  const baseUrl = mpgsBaseUrl.replace(/\/$/, '');
  const orderId = mpgsOrderId(reference);
  const auth    = basicAuth(mpgsMid, mpgsApiPassword);
  const headers = { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' };
  const appUrl  = process.env.APP_URL || 'https://api.paylodeservices.com';

  const pan = String(card.number).replace(/\s/g, '');
  const exp = { month: String(card.expiry_month).padStart(2, '0'), year: String(card.expiry_year).slice(-2) };

  const init = await fetch(
    `${baseUrl}/merchant/${mpgsMid}/order/${orderId}/transaction/1`,
    {
      method: 'PUT', headers,
      body: JSON.stringify({
        apiOperation: 'INITIATE_AUTHENTICATION',
        authentication: { channel: 'PAYER_BROWSER', purpose: 'PAYMENT_TRANSACTION' },
        order: { currency },
        sourceOfFunds: { type: 'CARD', provided: { card: { number: pan, expiry: exp } } },
      }),
    }
  ).then(r => r.json()).catch(() => ({ result: 'ERROR', error: { cause: 'NON_JSON_RESPONSE' } }));

  if (init.result === 'ERROR') return { ok: false, error: init.error };

  const m3ds       = init.authentication?.['3ds2'] || {};
  const methodUrl  = m3ds.methodUrl || null;
  const transId    = m3ds['3dsServerTransactionId'] || null;
  const needsMethod = m3ds.methodSupported === 'SUPPORTED' && !!methodUrl && !!transId;

  const methodData = needsMethod
    ? Buffer.from(JSON.stringify({
        threeDSServerTransId: transId,
        threeDSMethodNotificationURL: `${appUrl}/api/rest/3ds/method-notify`,
      })).toString('base64url')
    : null;

  return { ok: true, needsMethod, methodUrl, methodData };
}

module.exports = {
  charge, authenticatePayer, payAfterChallenge, getOrder, initiateFor3ds,
  toMpgsPayload, fromMpgsResponse, buildSandboxResponse,
  cardTypeFromNumber, nairaFromKobo, mpgsOrderId, MPGS_VERSION,
};
