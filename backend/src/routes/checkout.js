'use strict';
/**
 * Paylode — Checkout API Routes
 * These endpoints are called by checkout.html (the customer-facing payment page)
 * They are PUBLIC endpoints — authenticated by transaction reference only
 */
const router = require('express').Router();
const crypto = require('crypto');
const { prisma }  = require('../utils/db');
const { ok, fail, notFound } = require('../utils/helpers');
const { dispatchWebhook }    = require('../services/webhookService');
const { computeFeesForTxn, channelToServiceType, computeFeesForPayin, resolvePayinRail, resolvePayinRateConfig } = require('../services/feeEngine');
const isw = require('../services/interswitchService');
const compliance = require('../services/complianceService');
const palmpay = require('../services/palmpayService');
const { finalizePayinSuccess } = require('../services/payinFinalize');
const { sendCustomerReceipt } = require('../services/receiptEmail');

const CHECKOUT_URL = process.env.APP_URL
  ? process.env.APP_URL.replace(/\/$/, '') + '/checkout.html'
  : 'https://paylodeservices.com/checkout.html';

// Breakdown stored on a pay-in txn (metadata.payin) so the finalizer records EXACTLY
// what the customer was charged — matches whatever the VA / wallet order was minted
// for, even if a rate is edited afterwards.
function payinMetaFrom(fees) {
  return {
    principal:     Number(fees.principal),
    charge:        Number(fees.chargeAmount),
    feeRaw:        Number(fees.feeRaw),
    fee:           Number(fees.feePlusVat),
    vatOnFee:      Number(fees.vatOnFee),
    vatOnRail:     Number(fees.vatOnRail),
    netVat:        Number(fees.netVat),
    railRaw:       Number(fees.railRaw),
    railPlusVat:   Number(fees.railPlusVat),
    netPool:       Number(fees.netPool),
    aggShare:      Number(fees.aggShare),
    paylodeMargin: Number(fees.paylodeMargin),
  };
}

// ── GET /api/v1/checkout/:reference ─────────────────────────────────────────
router.get('/:reference', async (req, res, next) => {
  try {
    const txn = await prisma.transaction.findUnique({
      where: { reference: req.params.reference },
      include: {
        merchant: {
          select: { id:true, businessName:true, merchantCode:true, kycTier:true,
                    processingRate:true, webhookUrl:true, webhookSecret:true,
                    aggregator: { select: { revenueSplitPct: true } } }
        },
      },
    });
    if (!txn) return notFound(res, 'Transaction');
    if (txn.status !== 'PENDING') {
      // Include the settled amount so a re-opened success/failed receipt shows the
      // real figure (txn.amount is the gross the customer paid after finalize).
      return ok(res, {
        status: txn.status, reference: txn.reference, already_processed: true,
        amount: Number(txn.amount), amount_to_pay: Number(txn.amount),
        currency: txn.currency, merchant_name: txn.merchant.businessName,
        description: txn.metadata?.description || 'Payment',
      });
    }

    // The headline amount = what the customer actually pays for a collection = face +
    // our fee + VAT (the gross). Config-driven; shown so the order summary and the
    // transfer/wallet panels all display the SAME number. (Card not live yet.)
    let amountToPay = Number(txn.amount);
    if (!txn.isSandbox && palmpay.isConfigured()) {
      try {
        const rail = await resolvePayinRail(prisma);
        const cfg  = await resolvePayinRateConfig(prisma, txn.merchant, rail && rail.id);
        amountToPay = Number(computeFeesForPayin(BigInt(txn.amount), cfg).chargeAmount);
      } catch (e) { /* fall back to face amount */ }
    }

    ok(res, {
      reference:     txn.reference,
      amount:        Number(txn.amount),
      amount_to_pay: amountToPay,
      currency:      txn.currency,
      status:        txn.status,
      channel:       txn.channel,
      customer_email:txn.customerEmail,
      merchant_name: txn.merchant.businessName,
      description:   txn.metadata?.description || 'Payment',
      callback_url:  txn.callbackUrl,
      is_sandbox:    txn.isSandbox,
      metadata:      txn.metadata,
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/checkout/:reference/virtual-account ─────────────────────────
// Mints (or returns the cached) one-time PalmPay virtual account for a bank-transfer
// pay-in. The customer transfers to it; PalmPay fires the /payin webhook (keyed by
// orderId = reference) when funds land, which finalizes the txn. Sandbox / un-
// configured PalmPay falls back to the deterministic stub VA (no real money path).
router.get('/:reference/virtual-account', async (req, res, next) => {
  try {
    const txn = await prisma.transaction.findUnique({
      where: { reference: req.params.reference },
      include: { merchant: { include: { aggregator: true } } },
    });
    if (!txn) return notFound(res, 'Transaction');

    // Reuse the live PalmPay order while it's still valid (real order life ~30 min),
    // but REFRESH the customer-facing 15-min countdown on each view — so re-opening
    // the transfer screen never hands back a near-expired window. The amount shown is
    // the GROSS the customer pays (face + fee + VAT), stored at mint as metadata.payin.
    const cachedVa   = txn.metadata?.palmpay_va_no;
    const orderExpAt = txn.metadata?.palmpay_va_order_expires_at;
    if (cachedVa && orderExpAt && new Date(orderExpAt) > new Date()) {
      const displayExp = new Date(Math.min(Date.now() + 15 * 60 * 1000, new Date(orderExpAt).getTime())).toISOString();
      return ok(res, {
        account_number: cachedVa,
        account_name:   txn.metadata.palmpay_va_name || 'PalmPay',
        bank_name:      txn.metadata.palmpay_va_bank || 'PalmPay',
        amount:         Number(txn.metadata?.payin?.charge ?? txn.amount),
        reference:      txn.reference,
        expires_at:     displayExp,
      });
    }

    // ── SANDBOX / not-yet-configured: deterministic stub VA (no PalmPay call) ──
    if (txn.isSandbox || !palmpay.isConfigured()) {
      const acctSeed = parseInt(txn.reference.replace(/\D/g,'').slice(0,8) || '80200000');
      return ok(res, {
        account_number: '802' + (acctSeed % 10000000).toString().padStart(7,'0'),
        account_name:   'PAYLODE/' + txn.merchantId.slice(0,8).toUpperCase(),
        bank_name:      process.env.VIRTUAL_ACCOUNT_BANK_NAME || 'Wema Bank (ALAT)',
        bank_code:      process.env.VIRTUAL_ACCOUNT_BANK_CODE || '035',
        amount:         Number(txn.amount),
        reference:      txn.reference,
        expires_at:     new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        sandbox:        true,
      });
    }

    // ── LIVE: mint a one-time PalmPay VA tied to this order (real money) ──
    if (txn.status !== 'PENDING')      return fail(res, 'Transaction already processed', 'ALREADY_PROCESSED');
    if (BigInt(txn.amount) < 10000n)   return fail(res, 'Minimum bank-transfer amount is ₦100', 'AMOUNT_TOO_LOW');

    // Pay-in pricing (PAYER-FUNDED, config-driven). Pick the collecting rail (cheapest
    // LIVE rail with a collection cost), cost against it, and stamp it on the txn.
    // Customer pays the GROSS = face + our fee + VAT; the VA is minted for that gross.
    const rail   = await resolvePayinRail(prisma);
    const payCfg = await resolvePayinRateConfig(prisma, txn.merchant, rail && rail.id);
    const fees   = computeFeesForPayin(BigInt(txn.amount), payCfg);
    const chargeKobo = Number(fees.chargeAmount);

    // PalmPay's minimum order validity is 30 min; we surface a SHORTER 15-min
    // window to the customer (a slightly-late transfer still settles via webhook).
    const ORDER_TTL_MS   = 30 * 60 * 1000;   // real PalmPay order life (expireSeconds 1800)
    const DISPLAY_TTL_MS = 15 * 60 * 1000;   // customer-facing countdown
    let order;
    try {
      order = await palmpay.createBankTransferOrder({
        orderId:       txn.reference,
        amountKobo:    chargeKobo,           // customer transfers the gross
        callbackUrl:   CHECKOUT_URL + '?ref=' + encodeURIComponent(txn.reference),
        title:         'Payment',
        description:   txn.metadata?.description || 'Pay with bank transfer',
        customerMobile: txn.metadata?.customer_phone || undefined,
        expireSeconds: 1800,
      });
    } catch (e) {
      return fail(res, 'Could not generate a bank-transfer account. Please try again.', 'PALMPAY_ERROR', 502);
    }
    if (!order.ok || !order.virtualAccountNo) {
      return fail(res, order.reason || 'Bank transfer is temporarily unavailable', 'PALMPAY_DECLINED');
    }

    const expiresAt      = new Date(Date.now() + DISPLAY_TTL_MS).toISOString();
    const orderExpiresAt = new Date(Date.now() + ORDER_TTL_MS).toISOString();
    await prisma.transaction.update({
      where: { id: txn.id },
      data: {
        channel: 'BANK_TRANSFER',
        railId:  rail && rail.id ? rail.id : undefined,
        metadata: { ...txn.metadata,
          method:                       'palmpay_bank_transfer',
          palmpay_order_no:             order.orderNo,
          palmpay_va_no:                order.virtualAccountNo,
          palmpay_va_bank:              order.bankName,
          palmpay_va_name:              order.accountName,
          palmpay_va_order_expires_at:  orderExpiresAt,
          payin: payinMetaFrom(fees) },
      },
    });

    return ok(res, {
      account_number: order.virtualAccountNo,
      account_name:   order.accountName || 'PalmPay',
      bank_name:      order.bankName || 'PalmPay',
      amount:         chargeKobo,
      reference:      txn.reference,
      expires_at:     expiresAt,
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/checkout/:reference/charge/card ─────────────────────────────
router.post('/:reference/charge/card', async (req, res, next) => {
  try {
    const txn = await prisma.transaction.findUnique({
      where: { reference: req.params.reference },
      include: { merchant: { include: { aggregator: true } } },
    });
    if (!txn)                    return notFound(res, 'Transaction');
    if (txn.status !== 'PENDING') return fail(res, 'Transaction already processed', 'ALREADY_PROCESSED');

    const { card_number, card_expiry, card_cvv, card_pin, card_name } = req.body;

    if (!card_number || card_number.replace(/\D/g,'').length < 16)
      return fail(res, 'Invalid card number', 'INVALID_CARD');
    if (!card_cvv || card_cvv.length < 3)
      return fail(res, 'Invalid CVV', 'INVALID_CVV');
    if (!card_pin || card_pin.length < 4)
      return fail(res, 'PIN required for Nigerian cards', 'PIN_REQUIRED');

    const cleanCard = card_number.replace(/\D/g,'');

    // ── SANDBOX MODE ────────────────────────────────────────────────────────────
    if (txn.isSandbox) {
      const testOutcomes = {
        '4084080000000409': { success:false, reason:'Insufficient funds' },
        '4000000000000002': { success:false, reason:'Card declined by issuer' },
        '4187427415564246': { success:false, reason:'Transaction timed out' },
      };
      const outcome = testOutcomes[cleanCard] || { success: true };

      if (!outcome.success) {
        await prisma.transaction.update({
          where: { id:txn.id },
          data:  { status:'FAILED', failureReason: outcome.reason },
        });
        return fail(res, outcome.reason, 'CARD_DECLINED');
      }

      const merchant = txn.merchant;
      const fees = computeFeesForTxn(BigInt(txn.amount), merchant, null, 'CARD');

      await prisma.transaction.update({
        where: { id: txn.id },
        data: {
          status:         'SUCCESS',
          paidAt:         new Date(),
          amount:         fees.chargeAmount,
          netRevenue:     fees.netPool,
          merchantFee:    fees.feePlusVat,
          railCost:       fees.railPlusVat,
          vatOutput:      fees.vatOnFee,
          vatInput:       fees.vatOnRail,
          aggShare:       fees.aggShare,
          paylodeMargin:  fees.paylodeMargin,
          metadata: { ...txn.metadata, fee_paid_by: fees.feePaidBy,
                      merchant_settlement: Number(fees.merchantSettlement),
                      rail_cost: Number(fees.railPlusVat) },
        },
      });

      if (merchant.webhookUrl) {
        dispatchWebhook(merchant.id, 'payment.success', {
          reference: txn.reference, status: 'SUCCESS', channel: 'CARD', sandbox: true,
          principal: Number(txn.amount), charge_amount: Number(fees.chargeAmount),
          merchant_settlement: Number(fees.merchantSettlement), fee: Number(fees.feePlusVat),
        }).catch(() => {});
      }

      sendCustomerReceipt(txn.reference);
      return ok(res, {
        reference:           txn.reference,
        status:              'SUCCESS',
        principal:           Number(txn.amount),
        charge_amount:       Number(fees.chargeAmount),
        merchant_settlement: Number(fees.merchantSettlement),
        fee:                 Number(fees.feePlusVat),
        fee_paid_by:         fees.feePaidBy,
        channel:             'CARD',
        sandbox:             true,
      }, 'Payment successful');
    }

    // ── COMPLIANCE GATE (Mastercard Rules) ──────────────────────────────────────
    // Synchronous, in-memory hard-prohibition screen BEFORE any money moves. Blocks
    // a compliance-blocked / MATCH-listed merchant, a prohibited MCC, or a sanctioned
    // customer. Risk heuristics are monitored elsewhere (amlService), not blocked here.
    {
      const gate = compliance.screenTransaction(txn.merchant, {
        customerName: card_name, customerEmail: txn.customerEmail, cardCountry: null,
      });
      if (gate.decision === 'REJECT') {
        await prisma.transaction.update({
          where: { id: txn.id }, data: { status: 'FAILED', failureReason: 'Compliance: ' + gate.message },
        });
        compliance.persistExceptions('transaction', txn.id, [{
          code: gate.reasonCode, severity: 'BLOCKING', deferrable: false,
          description: gate.message, ruleRef: 'Mastercard Rules — pre-authorization compliance gate',
        }]).catch(() => {});
        return fail(res, gate.message, gate.reasonCode, 403);
      }
    }

    // ── LIVE MODE — Interswitch ─────────────────────────────────────────────────
    const redirectUrl = CHECKOUT_URL + '?ref=' + txn.reference + '&status=callback';

    let iswResp;
    try {
      iswResp = await isw.initializePurchase({
        reference:     txn.reference,
        amount:        Number(txn.amount),
        customerEmail: txn.customerEmail,
        pan:           cleanCard,
        expiry:        card_expiry,
        cvv:           card_cvv,
        pin:           card_pin,
        redirectUrl,
      });
    } catch (iswErr) {
      await prisma.transaction.update({
        where: { id: txn.id },
        data:  { status: 'FAILED', failureReason: 'Interswitch connection error: ' + iswErr.message },
      });
      return fail(res, 'Payment processor unavailable. Please try again.', 'PROCESSOR_ERROR', 502);
    }

    const code = iswResp.responseCode || iswResp.errors?.[0]?.code;

    // ── OTP / 3DS challenge required ────────────────────────────────────────────
    if (iswResp.paymentType === 'OTP' || code === 'T0') {
      return ok(res, {
        status:       'OTP_REQUIRED',
        reference:    txn.reference,
        message:      iswResp.responseDescription || 'Enter the OTP sent to your phone',
        otp_hint:     iswResp.responseDescription,
      }, 'OTP required');
    }

    // ── Successful payment ───────────────────────────────────────────────────────
    if (code === '00') {
      const merchant = txn.merchant;
      const fees = computeFeesForTxn(BigInt(txn.amount), merchant, null, 'CARD');

      await prisma.transaction.update({
        where: { id: txn.id },
        data: {
          status:         'SUCCESS',
          paidAt:         new Date(),
          netRevenue:     fees.netPool,
          merchantFee:    fees.feePlusVat,
          railCost:       fees.railPlusVat,
          vatOutput:      fees.vatOnFee,
          vatInput:       fees.vatOnRail,
          aggShare:       fees.aggShare,
          paylodeMargin:  fees.paylodeMargin,
          metadata: {
            ...txn.metadata,
            isw_purchased_code: iswResp.purchasedCode,
            isw_response_code:  code,
            fee_paid_by:        fees.feePaidBy,
            merchant_settlement:Number(fees.merchantSettlement),
          },
        },
      });

      if (merchant.webhookUrl) {
        dispatchWebhook(merchant.id, 'payment.success', {
          reference:           txn.reference,
          status:              'SUCCESS',
          channel:             'CARD',
          principal:           Number(txn.amount),
          charge_amount:       Number(fees.chargeAmount),
          merchant_settlement: Number(fees.merchantSettlement),
          fee:                 Number(fees.feePlusVat),
          processor:           'interswitch',
          purchased_code:      iswResp.purchasedCode,
        }).catch(() => {});
      }

      sendCustomerReceipt(txn.reference);
      return ok(res, {
        reference:           txn.reference,
        status:              'SUCCESS',
        principal:           Number(txn.amount),
        charge_amount:       Number(fees.chargeAmount),
        merchant_settlement: Number(fees.merchantSettlement),
        fee:                 Number(fees.feePlusVat),
        fee_paid_by:         fees.feePaidBy,
        channel:             'CARD',
        processor:           'interswitch',
      }, 'Payment successful');
    }

    // ── Failed payment ───────────────────────────────────────────────────────────
    const failureReason = iswResp.responseDescription || 'Payment declined by issuer';
    await prisma.transaction.update({
      where: { id: txn.id },
      data:  { status: 'FAILED', failureReason },
    });
    return fail(res, failureReason, 'CARD_DECLINED');

  } catch (e) { next(e); }
});

// ── POST /api/v1/checkout/:reference/charge/card/otp ─────────────────────────
router.post('/:reference/charge/card/otp', async (req, res, next) => {
  try {
    const txn = await prisma.transaction.findUnique({
      where: { reference: req.params.reference },
      include: { merchant: { include: { aggregator: true } } },
    });
    if (!txn)                    return notFound(res, 'Transaction');
    if (txn.status !== 'PENDING') return fail(res, 'Transaction already processed', 'ALREADY_PROCESSED');

    const { otp } = req.body;
    if (!otp || otp.length < 4) return fail(res, 'Valid OTP required', 'INVALID_OTP');

    if (txn.isSandbox) {
      // Sandbox OTP: accept any 6-digit code, reject '000000'
      if (otp === '000000') return fail(res, 'Invalid OTP', 'INVALID_OTP');
      const merchant = txn.merchant;
      const fees = computeFeesForTxn(BigInt(txn.amount), merchant, null, 'CARD');
      await prisma.transaction.update({
        where: { id: txn.id },
        data: {
          status: 'SUCCESS', paidAt: new Date(),
          netRevenue: fees.netPool, merchantFee: fees.feePlusVat,
          railCost: fees.railPlusVat, vatOutput: fees.vatOnFee, vatInput: fees.vatOnRail,
          aggShare: fees.aggShare, paylodeMargin: fees.paylodeMargin,
        },
      });
      sendCustomerReceipt(txn.reference);
      return ok(res, { reference: txn.reference, status: 'SUCCESS', sandbox: true }, 'OTP verified, payment successful');
    }

    let iswResp;
    try {
      iswResp = await isw.submitOtp({ reference: txn.reference, otp });
    } catch (iswErr) {
      return fail(res, 'OTP verification failed. Please try again.', 'OTP_ERROR', 502);
    }

    const code = iswResp.responseCode;

    if (code === '00') {
      const merchant = txn.merchant;
      const fees = computeFeesForTxn(BigInt(txn.amount), merchant, null, 'CARD');
      await prisma.transaction.update({
        where: { id: txn.id },
        data: {
          status: 'SUCCESS', paidAt: new Date(),
          netRevenue: fees.netPool, merchantFee: fees.feePlusVat,
          railCost: fees.railPlusVat, vatOutput: fees.vatOnFee, vatInput: fees.vatOnRail,
          aggShare: fees.aggShare, paylodeMargin: fees.paylodeMargin,
          metadata: {
            ...txn.metadata, isw_response_code: code,
            merchant_settlement: Number(fees.merchantSettlement),
          },
        },
      });

      if (txn.merchant.webhookUrl) {
        dispatchWebhook(txn.merchant.id, 'payment.success', {
          reference: txn.reference, status: 'SUCCESS', channel: 'CARD',
          principal: Number(txn.amount), processor: 'interswitch',
        }).catch(() => {});
      }

      sendCustomerReceipt(txn.reference);
      return ok(res, {
        reference: txn.reference, status: 'SUCCESS',
        principal: Number(txn.amount), channel: 'CARD', processor: 'interswitch',
      }, 'OTP verified, payment successful');
    }

    const failureReason = iswResp.responseDescription || 'OTP verification failed';
    await prisma.transaction.update({
      where: { id: txn.id },
      data:  { status: 'FAILED', failureReason },
    });
    return fail(res, failureReason, 'OTP_FAILED');

  } catch (e) { next(e); }
});

// ── POST /api/v1/checkout/:reference/confirm ─────────────────────────────────
router.post('/:reference/confirm', async (req, res, next) => {
  try {
    const txn = await prisma.transaction.findUnique({
      where: { reference: req.params.reference },
      include: { merchant: { include: { aggregator:true } } },
    });
    if (!txn) return notFound(res, 'Transaction');
    if (txn.status !== 'PENDING') {
      return ok(res, { status: txn.status, already_processed: txn.status === 'SUCCESS' });
    }

    if (txn.isSandbox) {
      const merchant = txn.merchant;
      const channel  = txn.channel || 'BANK_TRANSFER';
      const fees     = computeFeesForTxn(BigInt(txn.amount), merchant, null, channel);

      await prisma.transaction.update({
        where: { id: txn.id },
        data: {
          status: 'SUCCESS', paidAt: new Date(),
          netRevenue: fees.netPool, merchantFee: fees.feePlusVat,
          railCost: fees.railPlusVat, vatOutput: fees.vatOnFee, vatInput: fees.vatOnRail,
          aggShare: fees.aggShare, paylodeMargin: fees.paylodeMargin,
          metadata: { ...txn.metadata, fee_paid_by: fees.feePaidBy,
                      merchant_settlement: Number(fees.merchantSettlement) },
        },
      });
      sendCustomerReceipt(txn.reference);
      return ok(res, {
        status: 'SUCCESS', reference: txn.reference,
        principal: Number(txn.amount), charge_amount: Number(fees.chargeAmount),
        merchant_settlement: Number(fees.merchantSettlement),
        fee: Number(fees.feePlusVat), fee_paid_by: fees.feePaidBy,
      }, 'Payment confirmed');
    }

    // LIVE PalmPay bank transfer — actively poll PalmPay rather than waiting only
    // on the webhook. finalizePayinSuccess is status-guarded/idempotent, so a poll
    // here + the webhook can't double-credit.
    if (txn.metadata?.method === 'palmpay_bank_transfer' && palmpay.isConfigured()) {
      try {
        const q = await palmpay.queryBankTransferOrder({
          orderId: txn.reference, orderNo: txn.metadata.palmpay_order_no,
        });
        // orderStatus '2' = paid (confirm against PalmPay's data dictionary on first live test)
        if (q.respCode === '00000000' && String(q.data?.orderStatus) === '2') {
          await finalizePayinSuccess({
            reference: txn.reference, channel: 'BANK_TRANSFER', processor: 'palmpay_bank_transfer',
            extraMeta: { method: 'palmpay_bank_transfer',
              palmpay_order_no: txn.metadata.palmpay_order_no, palmpay_va_no: txn.metadata.palmpay_va_no },
          });
          return ok(res, { status: 'SUCCESS', reference: txn.reference }, 'Payment confirmed');
        }
      } catch (e) { /* fall through to PENDING — webhook will finalize */ }
    }

    return ok(res, { status: 'PENDING', reference: txn.reference }, 'Payment not yet confirmed');
  } catch (e) { next(e); }
});

// ── POST /api/v1/checkout/:reference/charge/palmpay ───────────────────────────
// Pay with PalmPay wallet. Creates a PalmPay order and returns its checkout/redirect
// URL; PalmPay redirects the payer back here and fires the /payin webhook, which
// finalizes the transaction. (Sandbox short-circuits — no real PalmPay call.)
router.post('/:reference/charge/palmpay', async (req, res, next) => {
  try {
    const txn = await prisma.transaction.findUnique({
      where: { reference: req.params.reference },
      include: { merchant: { include: { aggregator: true } } },
    });
    if (!txn)                     return notFound(res, 'Transaction');
    if (txn.status !== 'PENDING') return fail(res, 'Transaction already processed', 'ALREADY_PROCESSED');

    // Sandbox: finalize immediately (mirrors the card sandbox path) — no PalmPay call.
    if (txn.isSandbox) {
      const r = await finalizePayinSuccess({
        reference: txn.reference, channel: 'BANK_TRANSFER', processor: 'palmpay_wallet',
        extraMeta: { method: 'palmpay_wallet', sandbox: true },
      });
      return ok(res, {
        reference: txn.reference, status: 'SUCCESS', channel: 'BANK_TRANSFER',
        method: 'palmpay_wallet', sandbox: true, finalized: !!r.finalized,
      }, 'Payment successful (sandbox)');
    }

    if (!palmpay.isConfigured()) return fail(res, 'PalmPay is not available', 'PALMPAY_UNAVAILABLE', 503);

    // PAYER-FUNDED (same as bank transfer): the customer's wallet is charged the GROSS
    // (face + our fee + VAT); the merchant settles the full face. Config-driven rail.
    const rail   = await resolvePayinRail(prisma);
    const payCfg = await resolvePayinRateConfig(prisma, txn.merchant, rail && rail.id);
    const fees   = computeFeesForPayin(BigInt(txn.amount), payCfg);

    const callbackUrl = CHECKOUT_URL + '?ref=' + txn.reference + '&status=callback';
    let order;
    try {
      order = await palmpay.createPayWithPalmPayOrder({
        orderId:       txn.reference,
        amountKobo:    Number(fees.chargeAmount),   // wallet charged the gross
        callbackUrl,
        title:         txn.merchant.businessName || 'Payment',
        description:   txn.metadata?.description || 'Payment',
        customerEmail: txn.customerEmail,
      });
    } catch (e) {
      return fail(res, 'PalmPay is temporarily unavailable. Please try again.', 'PALMPAY_ERROR', 502);
    }
    if (!order.ok || !order.checkoutUrl) {
      return fail(res, order.reason || 'Could not start PalmPay payment', 'PALMPAY_DECLINED');
    }
    await prisma.transaction.update({
      where: { id: txn.id },
      data: { channel: 'BANK_TRANSFER', railId: rail && rail.id ? rail.id : undefined, metadata: { ...txn.metadata, method: 'palmpay_wallet', palmpay_order_no: order.orderNo, payin: payinMetaFrom(fees) } },
    });
    return ok(res, {
      reference:    txn.reference,
      status:       'REDIRECT',
      method:       'palmpay_wallet',
      checkout_url: order.checkoutUrl,
      order_no:     order.orderNo,
    }, 'Redirect to PalmPay to complete payment');
  } catch (e) { next(e); }
});

module.exports = router;
