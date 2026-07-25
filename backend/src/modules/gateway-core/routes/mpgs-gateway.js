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
      const { apiOperation, order, sourceOfFunds, transaction: txnMeta, customer, authentication } = req.body;
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
          card:             cardMeta,
          mpgsOrderId:      orderId,
          mpgsTxnId:        txnId,
          apiOperation,
          customerRef:      txnMeta?.reference || null,
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
      const mpgsPayload = {
        amount:      amountKobo,
        currency:    order.currency,
        reference:   paylodeRef,
        description: order.description || null,
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
        await prisma.transaction.update({ where: { id: txn.id }, data: { status: 'PENDING' } });
        return res.status(202).json({
          result: 'PENDING_AUTHENTICATION',
          authentication: {
            redirectUrl: mpgsResult.authRedirectUrl,
            version:     mpgsResult.auth3dsVersion || '3DS2',
          },
          order: { id: orderId, amount: parseFloat(order.amount), currency: order.currency },
          transaction: { id: txnId },
          // Paylode-specific: reference for polling/reconciliation
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

      // ── Webhook (non-blocking) ─────────────────────────────────────────────
      dispatchWebhook(merchant.id, mpgsResult.ok ? 'card.charge.success' : 'card.charge.failed', {
        reference:          paylodeRef,
        mpgs_order_id:      orderId,
        mpgs_transaction_id: txnId,
        status:             finalStatus,
        amount:             Number(amountKobo),
        currency:           order.currency,
        card:               cardMeta,
        authorization_code: mpgsResult.authorizationCode,
        gateway_code:       mpgsResult.gatewayCode,
      });

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

      const txn = await prisma.transaction.findFirst({
        where: { reference: { startsWith: paylodeRef }, merchantId: req.merchant.id },
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

module.exports = router;
