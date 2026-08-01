'use strict';
/**
 * Paylode MPGS Gateway — merchant-facing card processing API.
 *
 * URL structure mirrors the Mastercard Payment Gateway Services REST API exactly,
 * so merchants integrate using standard MPGS documentation, SDKs, and libraries —
 * only the base host changes from Parallex's MPGS instance to Paylode's gateway.
 *
 * Merchant connection parameters issued by Paylode:
 *   Gateway URL : https://api.paylodeservices.com/api/rest/version/77
 *   Merchant ID : {mpgs_mid}  (same MID Parallex issued)
 *   API Password: {paylode-issued password}   ← different from the real MPGS password
 *
 * Authentication (identical to MPGS):
 *   Authorization: Basic base64(merchant.{merchantId}:{apiPassword})
 *
 * Endpoints (MPGS-mirrored):
 *   PUT  /api/rest/version/:v/merchant/:mid/order/:orderId/transaction/:txnId
 *        apiOperation: PAY | AUTHORIZE   → charge or hold a card
 *        apiOperation: CAPTURE           → capture a prior authorization
 *        apiOperation: REFUND | VOID     → reverse a transaction  (stubbed — wired later)
 *   GET  /api/rest/version/:v/merchant/:mid/order/:orderId
 *        → retrieve order status (requery)
 *
 * 3DS: MPGS handles 3DS2 internally. Frictionless = SUCCESS in one call.
 *      Challenge = PENDING_AUTHENTICATION + authentication.redirectUrl returned to merchant.
 *      After challenge, MPGS redirects customer to authentication.redirectResponseUrl
 *      (which must be included in the original PAY request); Paylode's callback is wired
 *      in a sibling endpoint (POST /api/rest/3ds/callback — separate file, TBD).
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const { prisma }  = require('../../../utils/db');
const { screenTransaction } = require('../../../services/complianceService');
const { dispatchWebhook }   = require('../../../services/webhookService');
const mpgsSvc = require('../services/parallexMpgsService');
const { sendCustomerReceipt } = require('../services/receiptEmail');
const { computeFeesForTxn, getMerchantRateConfig } = require('../services/feeEngine');
const appUrlBase = () => process.env.APP_URL || 'https://api.paylodeservices.com';
const { logger } = require('../../../utils/logger');

// ── MPGS-format response helpers ─────────────────────────────────────────────

function mpgsError(res, status, cause, explanation) {
  return res.status(status).json({ result: 'ERROR', error: { cause, explanation } });
}

function mpgsDeclined(res, gatewayCode, acquirerCode) {
  return res.status(400).json({
    result: 'FAILURE',
    response: { gatewayCode: gatewayCode || 'DECLINED', acquirerCode: acquirerCode || '' },
  });
}

// ── Basic Auth parser ─────────────────────────────────────────────────────────
// MPGS standard: Authorization: Basic base64(merchant.{merchantId}:{apiPassword})
function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon   = decoded.indexOf(':');
    if (colon < 0) return null;
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  } catch { return null; }
}

// ── Gateway auth middleware ────────────────────────────────────────────────────
// Supports two sources:
//   1. Regular Paylode merchants  — merchant_mpgs_configs table
//   2. Partner merchants          — partner_merchants table
// Both use the same Basic Auth format: merchant.{mid}:{paylode-issued password}
async function requireGatewayAuth(req, res, next) {
  const creds = parseBasicAuth(req.headers.authorization);
  if (!creds) return mpgsError(res, 401, 'INVALID_CREDENTIALS', 'Authorization header missing or not Basic');

  const { username, password } = creds;
  if (!username.startsWith('merchant.'))
    return mpgsError(res, 401, 'INVALID_CREDENTIALS', 'Username must be in the format merchant.{merchantId}');

  const mid = username.slice('merchant.'.length);
  if (!mid) return mpgsError(res, 401, 'INVALID_CREDENTIALS', 'Merchant ID missing from username');

  if (req.params.mid && req.params.mid !== mid)
    return mpgsError(res, 401, 'INVALID_CREDENTIALS', 'Merchant ID in Authorization does not match URL');

  const hash = crypto.createHash('sha256').update(password).digest('hex');

  // 1. Check regular Paylode merchant
  const config = await prisma.merchantMpgsConfig.findUnique({
    where: { mpgsMid: mid }, include: { merchant: true },
  });
  if (config && config.isActive) {
    if (!config.gatewayApiPasswordHash)
      return mpgsError(res, 401, 'INVALID_CREDENTIALS', 'Gateway credentials not yet provisioned');
    if (hash !== config.gatewayApiPasswordHash)
      return mpgsError(res, 401, 'INVALID_CREDENTIALS', 'Invalid API password');
    req.mpgsConfig = config;
    req.merchant   = config.merchant;
    req.isSandbox  = !config.merchant.liveEnabled;
    req.isPartner  = false;
    return next();
  }

  // 2. Check partner merchant
  const pm = await prisma.partnerMerchant.findUnique({
    where: { mpgsMid: mid }, include: { partner: true },
  });
  if (!pm || pm.status !== 'active')
    return mpgsError(res, 401, 'INVALID_CREDENTIALS', 'Merchant ID not found or not active');
  if (!pm.gatewayApiPasswordHash)
    return mpgsError(res, 401, 'INVALID_CREDENTIALS', 'Gateway credentials not yet provisioned');
  if (hash !== pm.gatewayApiPasswordHash)
    return mpgsError(res, 401, 'INVALID_CREDENTIALS', 'Invalid API password');
  if (pm.partner.status !== 'active')
    return mpgsError(res, 401, 'INVALID_CREDENTIALS', 'Partner account is not active');

  // Expose a compatible config shape so downstream handlers work unchanged
  req.mpgsConfig = {
    mpgsMid:        pm.mpgsMid,
    mpgsApiPassword: pm.mpgsApiPassword,
    mpgsBaseUrl:    pm.mpgsBaseUrl || 'https://na-gateway.mastercard.com/api/rest/version/77',
  };
  req.merchant   = null;        // no Paylode merchant record for partner merchants
  req.partnerMerchant = pm;
  req.isSandbox  = false;       // partner merchants are always live
  req.isPartner  = true;
  next();
}

// ── Card type mask (return scheme + masked number, never store PAN) ────────────
function maskedCard(number) {
  const pan = String(number).replace(/\s/g, '');
  return {
    scheme:  mpgsSvc.cardTypeFromNumber(pan),
    number:  pan.slice(0, 6) + 'x'.repeat(Math.max(0, pan.length - 10)) + pan.slice(-4),
    bin:     pan.slice(0, 6),
    last4:   pan.slice(-4),
  };
}

// ── Amount helpers ─────────────────────────────────────────────────────────────
// MPGS amounts are naira strings with 2 dp ("5000.00"). Our DB stores kobo (BigInt).
const nairaToKobo = (v) => BigInt(Math.round(parseFloat(v) * 100));
const koboToNaira = (k) => (Number(k) / 100).toFixed(2);

// ── Fee computation ────────────────────────────────────────────────────────────
function computeFee(amountKobo, processingRate) {
  const rate = Number(processingRate || 0);
  const fee  = BigInt(Math.round(Number(amountKobo) * rate));
  const vat  = BigInt(Math.round(Number(fee) * 0.075));
  return { fee, vat };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/rest/version/:v/merchant/:mid/order/:orderId/transaction/:txnId
//  apiOperation: PAY | AUTHORIZE
// ─────────────────────────────────────────────────────────────────────────────
router.put('/version/:v/merchant/:mid/order/:orderId/transaction/:txnId',
  requireGatewayAuth,
  async (req, res, next) => {
    try {
      const { apiOperation, order, sourceOfFunds, transaction: txnMeta, customer, authentication, device } = req.body;
      const { orderId, txnId } = req.params;
      const config   = req.mpgsConfig;
      const merchant = req.merchant;
      const sandbox  = req.isSandbox;

      if (!['PAY', 'AUTHORIZE'].includes(apiOperation))
        return mpgsError(res, 400, 'INVALID_REQUEST', `apiOperation '${apiOperation}' not supported on this endpoint`);

      // ── Extract and validate card ──────────────────────────────────────────
      const cardData = sourceOfFunds?.provided?.card;
      if (!cardData || !cardData.number)
        return mpgsError(res, 400, 'INVALID_REQUEST', 'sourceOfFunds.provided.card.number is required');
      if (!cardData.expiry?.month || !cardData.expiry?.year)
        return mpgsError(res, 400, 'INVALID_REQUEST', 'sourceOfFunds.provided.card.expiry.month and .year are required');
      if (!cardData.securityCode)
        return mpgsError(res, 400, 'INVALID_REQUEST', 'sourceOfFunds.provided.card.securityCode is required');
      if (!order?.amount || !order?.currency)
        return mpgsError(res, 400, 'INVALID_REQUEST', 'order.amount and order.currency are required');

      // ── Compliance pre-screen ──────────────────────────────────────────────
      const customerName = customer && [customer.firstName, customer.lastName].filter(Boolean).join(' ');
      // Partner merchants have no Paylode merchant record — screen against a minimal object.
      const screenTarget = req.isPartner
        ? { complianceStatus: 'clear', matchListed: false, isActive: true }
        : merchant;
      const screen = screenTransaction(screenTarget, {
        customerName:  customerName || undefined,
        customerEmail: customer?.email || undefined,
      });
      if (screen.decision === 'REJECT') {
        const logCtx = req.isPartner
          ? { partnerMerchantId: req.partnerMerchant.id, mid: config.mpgsMid }
          : { merchantId: merchant.id };
        logger.warn({ ...logCtx, reason: screen.reasonCode }, 'MPGS gateway charge blocked');
        return res.status(403).json({
          result: 'ERROR',
          error:  { cause: 'TRANSACTION_DECLINED', explanation: screen.message, code: screen.reasonCode },
        });
      }

      // ── Convert amounts ────────────────────────────────────────────────────
      const amountKobo = nairaToKobo(order.amount);
      const processingRate = req.isPartner ? null : merchant?.processingRate;
      const { fee: merchantFeeKobo, vat: vatKobo } = computeFee(amountKobo, processingRate);
      const cardMeta = maskedCard(cardData.number);

      // ── Create transaction (PENDING) ───────────────────────────────────────
      const paylodeRef = `PX-${orderId}-${txnId}`;
      const txnData = {
        reference:     paylodeRef,
        customerEmail: customer?.email || '',
        amount:        amountKobo,
        currency:      order.currency,
        status:        'PENDING',
        channel:       'CARD',
        merchantFee:   merchantFeeKobo,
        vatOutput:     vatKobo,
        isSandbox:     sandbox,
        metadata: {
          card:                cardMeta,
          // Store full card + customer for use in payAfterChallenge (3DS2 callback)
          cardFull: {
            number:       cardData.number,
            expiry_month: cardData.expiry.month,
            expiry_year:  cardData.expiry.year,
            cvv:          cardData.securityCode,
            name:         cardData.nameOnCard || null,
          },
          customer: customer ? {
            email:      customer.email      || null,
            phone:      customer.phone      || null,
            first_name: customer.firstName  || null,
            last_name:  customer.lastName   || null,
          } : null,
          mpgsOrderId:         orderId,
          mpgsTxnId:           txnId,
          apiOperation,
          description:         order.description || null,
          customerRef:         txnMeta?.reference || null,
          // merchant's return URL — we redirect cardholder here after 3DS challenge completes
          merchantRedirectUrl: authentication?.redirectResponseUrl || null,
          ...(req.isPartner ? {
            partner_id:          req.partnerMerchant.partnerId,
            partner_merchant_id: req.partnerMerchant.id,
            partner_mid:         config.mpgsMid,
          } : {}),
        },
      };
      // Partner merchants have no Paylode merchantId FK — store identity in metadata only
      if (!req.isPartner) txnData.merchantId = merchant.id;
      const txn = await prisma.transaction.create({ data: txnData });

      // ── Inspect mode: return the transformed MPGS payload without calling upstream
      // Triggered by ?inspect=true — NEVER enabled in production (sandbox only)
      if (req.query.inspect === 'true' && sandbox) {
        return res.status(200).json({
          _inspect: true,
          _note: 'This is the payload Paylode would forward to MPGS. No charge was made.',
          mpgs_endpoint: {
            method: 'PUT',
            url:    `${config.mpgsBaseUrl}/merchant/${config.mpgsMid}/order/${mpgsSvc.mpgsOrderId(paylodeRef)}/transaction/1`,
            auth:   `Basic base64(merchant.${config.mpgsMid}:{mpgsApiPassword})`,
          },
          mpgs_request_body: mpgsSvc.toMpgsPayload({
            amount: amountKobo, currency: order.currency,
            reference: paylodeRef, description: order.description || null,
            apiOperation,
            card: {
              number: cardData.number, expiry_month: cardData.expiry.month,
              expiry_year: cardData.expiry.year, cvv: cardData.securityCode,
              name: cardData.nameOnCard || null,
            },
            customer: customer ? {
              email: customer.email, phone: customer.phone,
              first_name: customer.firstName, last_name: customer.lastName,
              ip_address: customer.ipAddress || req.ip,
            } : null,
          }),
          paylode_reference: paylodeRef,
          amount_kobo: Number(amountKobo),
          card_meta:   cardMeta,
          compliance:  { decision: screen.decision },
        });
      }

      // ── Build payload for real MPGS ────────────────────────────────────────
      // NOTE: authentication.redirectResponseUrl is intentionally omitted here.
      // Parallex's MPGS instance rejects it as an unsupported parameter (HTTP 400).
      // When Parallex enables 3DS Hosted Page, re-add:
      //   authentication: { redirectResponseUrl: `${APP_URL}/api/rest/3ds/callback?ref=${paylodeRef}` }
      const appUrl = process.env.APP_URL || 'https://api.paylodeservices.com';
      const our3dsCallbackUrl = `${appUrl}/api/rest/3ds/callback?ref=${encodeURIComponent(paylodeRef)}`;

      const mpgsPayload = {
        amount:       amountKobo,
        currency:     order.currency,
        reference:    paylodeRef,
        description:  order.description || null,
        apiOperation,
        // Browser data from merchant's checkout page (for 3DS2 AUTHENTICATE_PAYER)
        browserData: device?.browserDetails ? {
          browser:             device.browser || 'MOZILLA',
          challengeWindowSize: device.browserDetails['3DSecureChallengeWindowSize'] || '500_X_600',
          acceptHeaders:       device.browserDetails.acceptHeaders,
          colorDepth:          device.browserDetails.colorDepth,
          javaEnabled:         device.browserDetails.javaEnabled,
          language:            device.browserDetails.language,
          screenHeight:        device.browserDetails.screenHeight,
          screenWidth:         device.browserDetails.screenWidth,
          timeZone:            device.browserDetails.timeZone,
          ipAddress:           device.ipAddress || customer?.ipAddress || req.ip,
        } : null,
        card: {
          number:       cardData.number,
          expiry_month: cardData.expiry.month,
          expiry_year:  cardData.expiry.year,
          cvv:          cardData.securityCode,
          name:         cardData.nameOnCard || null,
        },
        customer: customer ? {
          email:       customer.email,
          phone:       customer.phone,
          first_name:  customer.firstName,
          last_name:   customer.lastName,
          ip_address:  customer.ipAddress || req.ip,
        } : null,
      };

      // ── Call MPGS (or sandbox mock) ────────────────────────────────────────
      let mpgsResult;
      try {
        mpgsResult = await mpgsSvc.charge(config, mpgsPayload, sandbox);
      } catch (err) {
        logger.error({ err: err.message, ref: paylodeRef }, 'MPGS gateway upstream error');
        await prisma.transaction.update({ where: { id: txn.id }, data: { status: 'FAILED', failureReason: 'MPGS connection error' } });
        return mpgsError(res, 502, 'SYSTEM_ERROR', 'Card processing temporarily unavailable — please retry');
      }

      // ── Handle 3DS challenge ───────────────────────────────────────────────
      if (mpgsResult.pending3ds) {
        const challengeHtml = mpgsResult.authRedirectHtml || null;
        await prisma.transaction.update({
          where: { id: txn.id },
          data: {
            status: 'PENDING',
            metadata: {
              ...(txn.metadata || {}),
              authRedirectHtml:         challengeHtml,
              threeDSServerTransactionId: mpgsResult.threeDSServerTransactionId || null,
            },
          },
        });
        const challengeUrl = challengeHtml
          ? `${appUrl}/api/rest/3ds/challenge?ref=${encodeURIComponent(paylodeRef)}`
          : null;
        return res.status(202).json({
          result: 'PENDING_AUTHENTICATION',
          authentication: {
            redirectUrl:  mpgsResult.authRedirectUrl || null,
            redirectHtml: challengeHtml,
            challengeUrl,
            version:      mpgsResult.auth3dsVersion || '3DS2',
          },
          order: { id: orderId, amount: parseFloat(order.amount), currency: order.currency },
          transaction: { id: txnId },
          'paylode.reference': paylodeRef,
        });
      }

      // ── Update transaction ─────────────────────────────────────────────────
      const finalStatus = mpgsResult.ok ? 'SUCCESS' : 'FAILED';
      await prisma.transaction.update({
        where: { id: txn.id },
        data: {
          status:        finalStatus,
          failureReason: mpgsResult.ok ? null : mpgsResult.declineReason,
          paidAt:        mpgsResult.ok ? new Date() : null,
          netRevenue:    mpgsResult.ok ? (amountKobo - merchantFeeKobo) : BigInt(0),
          metadata: {
            card:        cardMeta,
            mpgsOrderId: orderId,
            mpgsTxnId:   txnId,
            apiOperation,
            customerRef: txnMeta?.reference || null,
            mpgs: {
              gatewayCode:       mpgsResult.gatewayCode,
              acquirerCode:      mpgsResult.acquirerCode,
              authorizationCode: mpgsResult.authorizationCode,
            },
          },
        },
      });

      // ── Webhook (non-blocking) — skip for partner merchants (no Paylode webhook config)
      if (!req.isPartner) {
        dispatchWebhook(merchant.id, mpgsResult.ok ? 'card.charge.success' : 'card.charge.failed', {
          reference:           paylodeRef,
          mpgs_order_id:       orderId,
          mpgs_transaction_id: txnId,
          status:              finalStatus,
          amount:              Number(amountKobo),
          currency:            order.currency,
          card:                cardMeta,
          authorization_code:  mpgsResult.authorizationCode,
          gateway_code:        mpgsResult.gatewayCode,
        });
      }

      // ── Return MPGS-format response ────────────────────────────────────────
      if (!mpgsResult.ok) {
        return res.status(400).json({
          result: 'FAILURE',
          response: {
            gatewayCode:   mpgsResult.gatewayCode  || 'DECLINED',
            acquirerCode:  mpgsResult.acquirerCode  || '',
            acquirerMessage: mpgsResult.declineReason || '',
          },
          order:       { id: orderId, amount: parseFloat(order.amount), currency: order.currency },
          transaction: { id: txnId },
        });
      }

      return res.status(200).json({
        result: 'SUCCESS',
        response: {
          gatewayCode:  mpgsResult.gatewayCode  || 'APPROVED',
          acquirerCode: mpgsResult.acquirerCode  || '00',
        },
        order: {
          id:           orderId,
          amount:       parseFloat(order.amount),
          currency:     order.currency,
          creationTime: txn.createdAt.toISOString(),
        },
        transaction: {
          id:                txnId,
          type:              apiOperation === 'AUTHORIZE' ? 'AUTHORIZATION' : 'PAYMENT',
          authorizationCode: mpgsResult.authorizationCode,
          reference:         txnMeta?.reference || null,
        },
        sourceOfFunds: {
          type: 'CARD',
          provided: {
            card: {
              scheme: cardMeta.scheme,
              number: cardMeta.number,   // masked — never the PAN
              expiry: { month: cardData.expiry.month, year: cardData.expiry.year },
            },
          },
        },
        // Paylode internal reference — useful for support/reconciliation
        'paylode.reference': paylodeRef,
      });

    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/rest/version/:v/merchant/:mid/order/:orderId
//  Retrieve order status — mirrors MPGS Retrieve Order
// ─────────────────────────────────────────────────────────────────────────────
router.get('/version/:v/merchant/:mid/order/:orderId',
  requireGatewayAuth,
  async (req, res, next) => {
    try {
      const { orderId } = req.params;
      const paylodeRef  = `PX-${orderId}-`;  // prefix match

      const txnWhere = req.isPartner
        ? { reference: { startsWith: paylodeRef } }
        : { reference: { startsWith: paylodeRef }, merchantId: req.merchant.id };
      const txn = await prisma.transaction.findFirst({
        where: txnWhere,
        orderBy: { createdAt: 'desc' },
      });

      if (!txn) return mpgsError(res, 404, 'INVALID_REQUEST', `Order '${orderId}' not found`);

      const meta = txn.metadata || {};
      return res.status(200).json({
        result: txn.status === 'SUCCESS' ? 'SUCCESS' : txn.status === 'FAILED' ? 'FAILURE' : 'PENDING',
        order: {
          id:           orderId,
          amount:       koboToNaira(txn.amount),
          currency:     txn.currency,
          status:       txn.status,
          creationTime: txn.createdAt.toISOString(),
        },
        transaction: {
          id:                meta.mpgsTxnId || '1',
          authorizationCode: meta.mpgs?.authorizationCode || null,
          type:              meta.apiOperation === 'AUTHORIZE' ? 'AUTHORIZATION' : 'PAYMENT',
        },
        sourceOfFunds: meta.card ? {
          type: 'CARD',
          provided: {
            card: { scheme: meta.card.type, number: `${meta.card.bin}xxxxxx${meta.card.last4}` },
          },
        } : undefined,
        'paylode.reference': txn.reference,
      });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/rest/3ds/challenge?ref={paylodeRef}
//
//  Serves the 3DS challenge HTML stored in the transaction metadata.
//  The merchant (or test tool) directs the cardholder's browser here;
//  the HTML auto-submits to the ACS to start the 3DS challenge.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/3ds/challenge', async (req, res, next) => {
  const paylodeRef = req.query.ref;
  if (!paylodeRef) return res.status(400).send('<h1>Missing ref parameter</h1>');
  try {
    const txn = await prisma.transaction.findFirst({
      where:   { reference: paylodeRef },
      orderBy: { createdAt: 'desc' },
    });
    if (!txn) return res.status(404).send('<h1>Transaction not found</h1>');

    // Transaction already completed — show result page instead of re-submitting the CReq
    // (re-submission causes the ACS to return 400 Bad Request since CReqs are single-use)
    if (txn.status === 'SUCCESS') {
      return res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Successful</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f7fa}.card{background:#fff;border-radius:16px;padding:40px 32px;text-align:center;max-width:340px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{width:64px;height:64px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}</style></head><body><div class="card"><div class="icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><div style="font-size:18px;font-weight:700;color:#1a2744;margin-bottom:8px">Payment Successful</div><p style="font-size:14px;color:#64748b;line-height:1.5">Your payment has been verified and processed. You may close this page.</p></div></body></html>`);
    }
    if (txn.status === 'FAILED') {
      return res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Failed</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f7fa}.card{background:#fff;border-radius:16px;padding:40px 32px;text-align:center;max-width:340px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{width:64px;height:64px;border-radius:50%;background:#fee2e2;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}</style></head><body><div class="card"><div class="icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div><div style="font-size:18px;font-weight:700;color:#1a2744;margin-bottom:8px">Payment Not Completed</div><p style="font-size:14px;color:#64748b;line-height:1.5">This payment could not be completed. Please close this page and try again.</p></div></body></html>`);
    }

    const meta = txn.metadata || {};

    if (!meta.authRedirectHtml) {
      return res.status(404).send('<h1>3DS challenge not found or already completed</h1>');
    }
    // Cardinal Commerce sets X-Frame-Options: SAMEORIGIN, so the iframe approach is blocked.
    // Instead, extract the creq + action from the fragment and do a full-page POST so the
    // browser navigates directly to Cardinal's challenge page.
    const challengeFrag = meta.authRedirectHtml;
    const creqMatch     = challengeFrag.match(/name="creq"\s+value="([^"]+)"/);
    const actionMatch   = challengeFrag.match(/action="([^"]+)"/);
    const creqValue     = creqMatch  ? creqMatch[1]                           : null;
    const actionUrl     = actionMatch ? actionMatch[1].replace(/&amp;/g, '&') : null;

    if (!creqValue || !actionUrl) {
      // Fallback: serve the raw fragment (best-effort)
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authenticating...</title></head><body>${challengeFrag}</body></html>`);
    }

    // Override the default restrictive CSP: we need inline scripts + form POST to ACS domains.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action *; frame-ancestors 'none'");
    // Full-page POST — browser navigates to Cardinal/ACS, completes challenge, then ACS
    // redirects the browser back to our redirectResponseUrl (the callback endpoint).
    const actionHtml = actionUrl.replace(/&/g, '&amp;');
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authenticating your payment...</title>
  <style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;font-family:sans-serif;flex-direction:column;}p{color:#555;font-size:15px;margin-top:16px;}</style>
</head>
<body>
  <p>Redirecting to your bank for authentication...</p>
  <form id="f" method="POST" action="${actionHtml}">
    <input type="hidden" name="creq" value="${creqValue}" />
  </form>
  <script>document.getElementById('f').submit();</script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/rest/3ds/step2?ref={paylodeRef}
//
//  Called by the challenge page JavaScript after the 3DS Method iframe has run.
//  Executes AUTHENTICATE_PAYER (with method now completed), stores the resulting
//  challenge HTML, and returns the challenge URL for the browser to redirect to.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/3ds/step2', async (req, res, next) => {
  const paylodeRef = req.query.ref;
  if (!paylodeRef) return res.status(400).json({ error: 'Missing ref' });
  try {
    const txn = await prisma.transaction.findFirst({
      where:   { reference: paylodeRef, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!txn) return res.status(404).json({ error: 'Transaction not found or already processed' });

    const meta = txn.metadata || {};
    if (!meta.cardFull) return res.status(400).json({ error: 'Card data missing from session' });

    // Load MPGS config for this transaction
    let mpgsConfig;
    if (meta.partner_merchant_id) {
      const pm = await prisma.partnerMerchant.findUnique({ where: { id: meta.partner_merchant_id } });
      if (pm) mpgsConfig = { mpgsMid: pm.mpgsMid, mpgsApiPassword: pm.mpgsApiPassword, mpgsBaseUrl: pm.mpgsBaseUrl || 'https://na-gateway.mastercard.com/api/rest/version/77' };
    } else if (txn.merchantId) {
      const cfg = await prisma.merchantMpgsConfig.findUnique({ where: { merchantId: txn.merchantId } });
      if (cfg) mpgsConfig = { mpgsMid: cfg.mpgsMid, mpgsApiPassword: cfg.mpgsApiPassword, mpgsBaseUrl: cfg.mpgsBaseUrl };
    }
    if (!mpgsConfig) return res.status(500).json({ error: 'MPGS config not found' });

    const cf = meta.cardFull;
    const authResult = await mpgsSvc.authenticatePayer(mpgsConfig, {
      reference:    paylodeRef,
      amount:       txn.amount,
      currency:     txn.currency,
      description:  meta.description || null,
      apiOperation: meta.apiOperation || 'PAY',
      card: {
        number:       cf.number,
        expiry_month: cf.expiry_month,
        expiry_year:  cf.expiry_year,
        cvv:          cf.cvv,
        name:         cf.name || null,
      },
      customer: meta.customer || null,
    });

    const appUrl = process.env.APP_URL || 'https://api.paylodeservices.com';

    if (authResult.pending3ds) {
      const challengeHtml = authResult.authRedirectHtml || null;
      // Store challenge HTML so the challenge page can serve it
      await prisma.transaction.update({
        where: { id: txn.id },
        data: { metadata: { ...meta, authRedirectHtml: challengeHtml } },
      });
      const challengeUrl = `${appUrl}/api/rest/3ds/challenge?ref=${encodeURIComponent(paylodeRef)}`;
      return res.json({ result: 'PENDING', challengeUrl });
    }

    // Frictionless outcome — complete the payment now
    if (authResult.ok) {
      const amountKobo = BigInt(txn.amount);
      const feeKobo    = BigInt(txn.merchantFee || 0);
      await prisma.transaction.update({
        where: { id: txn.id },
        data: {
          status:        'SUCCESS',
          paidAt:        new Date(),
          netRevenue:    amountKobo - feeKobo,
          failureReason: null,
          metadata: { ...meta, mpgs: { gatewayCode: authResult.gatewayCode, authorizationCode: authResult.authorizationCode } },
        },
      });
      return res.json({ result: 'SUCCESS', reference: paylodeRef });
    }

    // Frictionless failure
    await prisma.transaction.update({
      where: { id: txn.id },
      data: { status: 'FAILED', failureReason: authResult.declineReason || authResult.gatewayCode || 'DECLINED' },
    });
    return res.json({ result: 'FAILED', reference: paylodeRef });

  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/rest/3ds/callback?ref={paylodeRef}   (also handles GET for testing)
//
//  MPGS redirects the cardholder's browser here (via POST) after a 3DS
//  challenge completes.  We complete the PAY, update the transaction, fire
//  the merchant webhook, then redirect the cardholder to their return URL.
// ─────────────────────────────────────────────────────────────────────────────
router.all('/3ds/callback', async (req, res, next) => {
  const paylodeRef = req.query.ref;
  if (!paylodeRef) return res.status(400).send('Missing ref parameter');

  let txn;
  try {
    txn = await prisma.transaction.findFirst({
      where:   { reference: paylodeRef, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
  } catch (err) { return next(err); }

  if (!txn) {
    logger.warn({ ref: paylodeRef }, '3DS callback: transaction not found or already processed');
    return res.status(200).send('Payment already processed');
  }

  const meta = txn.metadata || {};
  const merchantRedirectUrl = meta.merchantRedirectUrl || null;

  const redirectMerchant = (status) => {
    if (!merchantRedirectUrl) {
      const ok = status === 'SUCCESS';
      return res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? 'Payment Successful' : 'Payment Failed'}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f7fa}.card{background:#fff;border-radius:16px;padding:40px 32px;text-align:center;max-width:340px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;background:${ok ? '#dcfce7' : '#fee2e2'}}.icon svg{stroke:${ok ? '#16a34a' : '#dc2626'}}.title{font-size:18px;font-weight:700;color:#1a2744;margin-bottom:8px}.ref{font-size:11px;color:#94a3b8;margin-top:16px;word-break:break-all}</style></head><body><div class="card"><div class="icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${ok ? '<polyline points="20 6 9 17 4 12"/>' : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'}</svg></div><div class="title">${ok ? 'Payment Successful' : 'Payment Not Completed'}</div><p style="font-size:14px;color:#64748b;line-height:1.5">${ok ? 'Your payment has been verified and processed.' : 'The payment could not be completed. Please try again or use a different card.'}</p><div class="ref">Ref: ${paylodeRef}</div></div></body></html>`);
    }
    const sep = merchantRedirectUrl.includes('?') ? '&' : '?';
    return res.redirect(`${merchantRedirectUrl}${sep}result=${status}&reference=${encodeURIComponent(paylodeRef)}`);
  };

  // ── Load the MPGS config for this transaction ──────────────────────────────
  let mpgsConfig;
  try {
    if (meta.partner_merchant_id) {
      const pm = await prisma.partnerMerchant.findUnique({ where: { id: meta.partner_merchant_id } });
      if (pm) mpgsConfig = { mpgsMid: pm.mpgsMid, mpgsApiPassword: pm.mpgsApiPassword,
                              mpgsBaseUrl: pm.mpgsBaseUrl || 'https://na-gateway.mastercard.com/api/rest/version/77' };
    } else if (txn.merchantId) {
      const cfg = await prisma.merchantMpgsConfig.findUnique({ where: { merchantId: txn.merchantId } });
      if (cfg) mpgsConfig = { mpgsMid: cfg.mpgsMid, mpgsApiPassword: cfg.mpgsApiPassword, mpgsBaseUrl: cfg.mpgsBaseUrl };
    }
  } catch (err) { return next(err); }

  if (!mpgsConfig) {
    logger.error({ ref: paylodeRef }, '3DS callback: MPGS config not found');
    await prisma.transaction.update({ where: { id: txn.id }, data: { status: 'FAILED', failureReason: 'Config not found post-3DS' } });
    return redirectMerchant('FAILED');
  }

  // ── Complete payment via PAY (txnId=2; authentication.transactionId links to 3DS session) ──
  let payResult;
  try {
    payResult = await mpgsSvc.payAfterChallenge(mpgsConfig, {
      reference:                  paylodeRef,
      amount:                     txn.amount,
      currency:                   txn.currency,
      description:                meta.description  || null,
      apiOperation:               meta.apiOperation || 'PAY',
      card:                       meta.cardFull     || null,
      threeDSServerTransactionId: meta.threeDSServerTransactionId || null,
    });
  } catch (err) {
    logger.error({ err: err.message, ref: paylodeRef }, '3DS callback: PAY after challenge failed');
    await prisma.transaction.update({ where: { id: txn.id }, data: { status: 'FAILED', failureReason: 'PAY error post-3DS challenge' } });
    return redirectMerchant('FAILED');
  }

  const finalStatus  = payResult.ok ? 'SUCCESS' : 'FAILED';
  const authCode     = payResult.authorizationCode || null;
  const gatewayCode  = payResult.gatewayCode || null;
  const acquirerCode = payResult.acquirerCode || null;

  try {
    let feeData = {};
    if (finalStatus === 'SUCCESS' && txn.merchantId) {
      try {
        const cardProduct = txn.currency === 'USD' ? 'CARD_INTL' : 'CARD_LOCAL';
        const rateOverride = await getMerchantRateConfig(prisma, txn.merchantId, cardProduct);
        let platRate = null;
        if (!rateOverride) {
          platRate = await prisma.platformRateConfig.findFirst({
            where: { channel: { in: [cardProduct, 'ALL'] } },
            orderBy: { channel: 'desc' },
          });
        }
        const rc = rateOverride || (platRate ? { rate: Number(platRate.rate), flatFee: Number(platRate.flatFee || 0), cap: Number(platRate.cap || 0) } : null);
        const merchant = await prisma.merchant.findUnique({ where: { id: txn.merchantId }, include: { aggregator: true } });
        const fees = computeFeesForTxn(BigInt(txn.amount), merchant,
          rc ? { merchantRate: rc.rate, flatFee: rc.flatFee, merchantCap: rc.cap } : null, cardProduct);
        feeData = {
          amount:        fees.chargeAmount,
          merchantFee:   fees.feePlusVat,
          railCost:      fees.railPlusVat,
          vatOutput:     fees.vatOnFee,
          vatInput:      fees.vatOnRail,
          aggShare:      fees.aggShare,
          paylodeMargin: fees.paylodeMargin,
          netRevenue:    fees.netPool,
        };
      } catch (_) { /* fee computation optional — don't block settlement */ }
    }

    await prisma.transaction.update({
      where: { id: txn.id },
      data: {
        status:        finalStatus,
        paidAt:        finalStatus === 'SUCCESS' ? new Date() : null,
        failureReason: finalStatus === 'FAILED'  ? (gatewayCode || 'DECLINED') : null,
        ...feeData,
        metadata: {
          ...meta,
          mpgs: { gatewayCode, acquirerCode, authorizationCode: authCode },
        },
      },
    });
  } catch (err) { return next(err); }

  // ── Webhook (regular merchants only) ──────────────────────────────────────
  if (txn.merchantId) {
    dispatchWebhook(txn.merchantId, finalStatus === 'SUCCESS' ? 'card.charge.success' : 'card.charge.failed', {
      reference:           paylodeRef,
      mpgs_order_id:       meta.mpgsOrderId  || null,
      mpgs_transaction_id: meta.mpgsTxnId    || null,
      status:              finalStatus,
      amount:              Number(txn.amount),
      currency:            txn.currency,
      card:                meta.card          || null,
      authorization_code:  authCode,
      gateway_code:        gatewayCode,
    });
  }

  logger.info({ ref: paylodeRef, status: finalStatus }, '3DS callback processed');
  if (finalStatus === 'SUCCESS') sendCustomerReceipt(paylodeRef).catch(() => {});
  return redirectMerchant(finalStatus);
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/rest/3ds/method-notify
//
//  MPGS 3DS server POSTs here after the browser's 3DS Method iframe completes.
//  We just acknowledge — the important side-effect is that MPGS has already
//  marked methodCompleted=true on their side, which the ACS sees when we
//  subsequently call AUTHENTICATE_PAYER.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/3ds/method-notify', (req, res) => res.sendStatus(200));

module.exports = router;
