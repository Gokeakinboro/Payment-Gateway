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
const { computeFees }        = require('../utils/helpers');

// ── GET /api/v1/checkout/:reference — fetch transaction details for checkout page
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

// ── GET /api/v1/checkout/:reference/virtual-account — for bank transfer
router.get('/:reference/virtual-account', async (req, res, next) => {
  try {
    const txn = await prisma.transaction.findUnique({ where: { reference: req.params.reference } });
    if (!txn) return notFound(res, 'Transaction');

    // In production: call your bank's virtual account API (e.g. Wema ALAT, Providus)
    // For now: return a deterministic virtual account based on the reference
    // This gets replaced when you connect a real bank
    const acctSeed = parseInt(txn.reference.replace(/\D/g,'').slice(0,8) || '80200000');
    ok(res, {
      account_number: '802' + (acctSeed % 10000000).toString().padStart(7,'0'),
      account_name:   'PAYLODE/' + txn.merchantId.slice(0,8).toUpperCase(),
      bank_name:      'Wema Bank (ALAT)',
      bank_code:      '035',
      amount:         Number(txn.amount),
      reference:      txn.reference,
      expires_at:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/checkout/:reference/charge/card — process card payment
router.post('/:reference/charge/card', async (req, res, next) => {
  try {
    const txn = await prisma.transaction.findUnique({
      where: { reference: req.params.reference },
      include: { merchant: { include: { aggregator: true } } },
    });
    if (!txn)                   return notFound(res, 'Transaction');
    if (txn.status !== 'PENDING') return fail(res, 'Transaction already processed', 'ALREADY_PROCESSED');

    const { card_number, card_expiry, card_cvv, card_pin, card_name } = req.body;

    // Validate card fields
    if (!card_number || card_number.replace(/\D/g,'').length < 16)
      return fail(res, 'Invalid card number', 'INVALID_CARD');
    if (!card_cvv || card_cvv.length < 3)
      return fail(res, 'Invalid CVV', 'INVALID_CVV');
    if (!card_pin || card_pin.length < 4)
      return fail(res, 'PIN required for Nigerian cards', 'PIN_REQUIRED');

    const cleanCard = card_number.replace(/\D/g,'');

    // ── SANDBOX MODE ──────────────────────────────────────────────────────────
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

      // Sandbox success
      const merchant = txn.merchant;
      const aggSplit = merchant.aggregator ? Number(merchant.aggregator.revenueSplitPct) : 0;
      const fees     = computeFees(Number(txn.amount), Number(merchant.processingRate||0.015), 0, aggSplit);

      await prisma.transaction.update({
        where: { id:txn.id },
        data: {
          status: 'SUCCESS', paidAt: new Date(),
          netRevenue:    fees.netRevenue,
          aggShare:      fees.aggShare,
          paylodeMargin: fees.paylodeMargin,
        },
      });

      if (merchant.webhookUrl) {
        dispatchWebhook(merchant.id, 'payment.success', {
          reference:  txn.reference, amount: Number(txn.amount),
          status:     'SUCCESS', channel: 'CARD', sandbox: true,
        }).catch(()=>{});
      }

      return ok(res, {
        reference: txn.reference, status: 'SUCCESS',
        amount: Number(txn.amount), channel: 'CARD', sandbox: true,
      }, 'Payment successful');
    }

    // ── LIVE MODE ─────────────────────────────────────────────────────────────
    // TODO: Replace this block with your chosen processor (Interswitch, Paystack, etc.)
    // when the rail connection is activated post-CBN approval.
    //
    // Example (Interswitch QuickTeller):
    //   const resp = await fetch('https://api.interswitchgroup.com/api/v3/purchases', {
    //     method: 'POST',
    //     headers: { 'Authorization': 'Bearer ' + INTERSWITCH_TOKEN, 'Content-Type': 'application/json' },
    //     body: JSON.stringify({
    //       customerId: txn.customerEmail,
    //       amount:     Number(txn.amount),
    //       pan:        card_number,
    //       pin:        card_pin,
    //       expiry:     card_expiry,
    //       cvv:        card_cvv,
    //       terminalId: TERMINAL_ID,
    //     }),
    //   });

    return fail(res,
      'Live card processing not yet active. Rails are pending CBN go-live approval.',
      'RAILS_PENDING', 503
    );

  } catch (e) { next(e); }
});

// ── POST /api/v1/checkout/:reference/confirm — manual confirm (transfer/USSD)
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

    // In production: this is called by the bank's webhook, not the customer
    // Here it's the polling endpoint checkout.html uses for transfer/USSD
    if (txn.isSandbox) {
      const merchant = txn.merchant;
      const aggSplit = merchant.aggregator ? Number(merchant.aggregator.revenueSplitPct) : 0;
      const fees     = computeFees(Number(txn.amount), Number(merchant.processingRate||0.015), 0, aggSplit);

      await prisma.transaction.update({
        where: { id:txn.id },
        data: {
          status:'SUCCESS', paidAt:new Date(),
          netRevenue:fees.netRevenue, aggShare:fees.aggShare, paylodeMargin:fees.paylodeMargin,
        },
      });
      return ok(res, { status:'SUCCESS', reference:txn.reference }, 'Payment confirmed');
    }

    // Live: check with bank API whether transfer/USSD payment came in
    // Not implemented until bank integration — return pending
    return ok(res, { status:'PENDING', reference:txn.reference }, 'Payment not yet confirmed');

  } catch (e) { next(e); }
});

module.exports = router;
