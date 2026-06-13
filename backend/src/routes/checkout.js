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
const { computeFeesForTxn, channelToServiceType } = require('../services/feeEngine');
const isw = require('../services/interswitchService');

const CHECKOUT_URL = process.env.APP_URL
  ? process.env.APP_URL.replace(/\/$/, '') + '/checkout.html'
  : 'https://paylodeservices.com/checkout.html';

// ── GET /api/v1/checkout/:reference ─────────────────────────────────────────
router.get('/:reference', async (req, res, next) => {
  try {
    const txn = await prisma.transaction.findUnique({
      where: { reference: req.params.reference },
      include: {
        merchant: {
          select: { businessName:true, merchantCode:true, kycTier:true,
                    processingRate:true, webhookUrl:true, webhookSecret:true }
        },
      },
    });
    if (!txn) return notFound(res, 'Transaction');
    if (txn.status !== 'PENDING') {
      return ok(res, { status: txn.status, reference: txn.reference, already_processed: true });
    }

    ok(res, {
      reference:     txn.reference,
      amount:        Number(txn.amount),
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
router.get('/:reference/virtual-account', async (req, res, next) => {
  try {
    const txn = await prisma.transaction.findUnique({ where: { reference: req.params.reference } });
    if (!txn) return notFound(res, 'Transaction');

    const acctSeed = parseInt(txn.reference.replace(/\D/g,'').slice(0,8) || '80200000');
    ok(res, {
      account_number: '802' + (acctSeed % 10000000).toString().padStart(7,'0'),
      account_name:   'PAYLODE/' + txn.merchantId.slice(0,8).toUpperCase(),
      bank_name:      process.env.VIRTUAL_ACCOUNT_BANK_NAME || 'Wema Bank (ALAT)',
      bank_code:      process.env.VIRTUAL_ACCOUNT_BANK_CODE || '035',
      amount:         Number(txn.amount),
      reference:      txn.reference,
      expires_at:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
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
          aggShare: fees.aggShare, paylodeMargin: fees.paylodeMargin,
        },
      });
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
          aggShare: fees.aggShare, paylodeMargin: fees.paylodeMargin,
          metadata: { ...txn.metadata, fee_paid_by: fees.feePaidBy,
                      merchant_settlement: Number(fees.merchantSettlement) },
        },
      });
      return ok(res, {
        status: 'SUCCESS', reference: txn.reference,
        principal: Number(txn.amount), charge_amount: Number(fees.chargeAmount),
        merchant_settlement: Number(fees.merchantSettlement),
        fee: Number(fees.feePlusVat), fee_paid_by: fees.feePaidBy,
      }, 'Payment confirmed');
    }

    return ok(res, { status: 'PENDING', reference: txn.reference }, 'Payment not yet confirmed');
  } catch (e) { next(e); }
});

module.exports = router;
