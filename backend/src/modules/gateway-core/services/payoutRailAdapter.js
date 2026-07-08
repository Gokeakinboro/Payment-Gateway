'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Single place that maps a payout RAIL NAME → its adapter module, so the three
//  money-path sites (payouts.js dispatch, payoutSettle reconcile, railFloat sync)
//  can never disagree on which rail speaks to which client. Each adapter honours
//  the same contract: isConfigured() · getBalance() · sendPayout(item) ·
//  queryPayoutResult({orderId}) · nameEnquiry() · getBanks().
//  Returns the adapter ONLY when it's configured (env set), else null — an
//  unconfigured/unknown rail behaves exactly as before (no adapter → not sent).
// ─────────────────────────────────────────────────────────────────────────────
const palmpay = require('./palmpayService');
const parallexTransfer = require('./parallexTransferService');

function payoutAdapterForName(name) {
  const n = (name || '').toLowerCase();
  if (/palmpay/.test(n)  && palmpay.isConfigured())          return palmpay;
  if (/parallex/.test(n) && parallexTransfer.isConfigured()) return parallexTransfer;
  return null;
}

module.exports = { payoutAdapterForName };
