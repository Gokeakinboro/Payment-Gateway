'use strict';
// Live bank Name-Enquiry (NE) — confirms a submitted account number is real and
// resolves the true account-holder name directly from the bank/NIP network, via
// whichever payout rail is configured (Parallex TPT first, PalmPay fallback —
// the same providers already used to fire real money in settlementFire.js).
const { resolveBank } = require('../data/nibssBanks');
const parallexTransfer = require('../modules/gateway-core/services/parallexTransferService');
const palmpay = require('../modules/gateway-core/services/palmpayService');
const { logger } = require('../utils/logger');

// Returns one of:
//   { bankResolved:false }                                             — bank name/code not recognized
//   { bankResolved:true, queried:false }                                — no NE-capable rail configured; can't verify right now
//   { bankResolved:true, queried:true, found:false, definitive, errors } — NE ran; found===false
//     `definitive:true`  → at least one rail responded cleanly with "no such account" (safe to block)
//     `definitive:false` → every rail errored/timed out (an outage, not an invalid account — don't block)
//   { bankResolved:true, queried:true, found:true, accountName, provider, bank }
async function verifyBankAccount(bankNameOrCode, accountNumber) {
  const bank = resolveBank(bankNameOrCode);
  if (!bank) return { bankResolved: false };

  const providers = [];
  if (parallexTransfer.isConfigured()) providers.push(['parallex', parallexTransfer]);
  if (palmpay.isConfigured()) providers.push(['palmpay', palmpay]);

  if (!providers.length) {
    logger.warn('verifyBankAccount: no name-enquiry-capable rail configured — skipping live check');
    return { bankResolved: true, queried: false, bank };
  }

  const errors = [];
  let definitive = false;
  for (const [name, svc] of providers) {
    try {
      const r = await svc.nameEnquiry(bank.code, accountNumber);
      if (r && r.ok && r.accountName) {
        return { bankResolved: true, queried: true, found: true, accountName: r.accountName, provider: name, bank };
      }
      // Rail responded (no transport/network error) but found no account — definitive.
      definitive = true;
      errors.push(`${name}: ${(r && r.reason) || 'no account name returned'}`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  return { bankResolved: true, queried: true, found: false, definitive, errors, bank };
}

module.exports = { verifyBankAccount };
