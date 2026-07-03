'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Card processor routing — picks WHICH processor charges a card from the CARD
//  product's configured default rail (platform_rate_configs.default_rail_id, set by
//  SA in Merchant Pricing), instead of hardcoding one. Removes the Interswitch
//  hardcoding while keeping it as the current adapter.
//
//  Card-adapter contract (every processor implements these):
//    initializePurchase({ reference, amount, customerEmail, pan, expiry, cvv, pin, redirectUrl })
//    submitOtp({ reference, otp })
//    verifyTransaction(reference)
//
//  To add a processor (e.g. MPGS): implement the contract, register it in ADAPTERS
//  under a key that appears in the rail's name, then set that rail as the CARD
//  product's Default Rail. No charge-path code change needed.
// ─────────────────────────────────────────────────────────────────────────────
const interswitch = require('./interswitchService');

// rail-name substring (lowercased) → adapter module
const ADAPTERS = { interswitch /*, mpgs: require('./mpgsService') */ };
const DEFAULT  = { name: 'interswitch', adapter: interswitch, railName: null };

function _match(name) {
  return Object.keys(ADAPTERS).find(k => String(name || '').toLowerCase().includes(k));
}

// Resolve the processor for a CARD product from its configured default rail.
// No rail configured → Interswitch (backward compatible). A rail with no card
// adapter yet (e.g. MPGS not built) → { adapter: null, unsupported: true }.
async function resolveCardProcessor(prisma, product = 'CARD_LOCAL') {
  let railName = null;
  try {
    const rows = await prisma.$queryRaw`
      SELECT pr.name
      FROM platform_rate_configs prc JOIN payment_rails pr ON prc.default_rail_id = pr.id
      WHERE prc.channel = ${product} AND prc.default_rail_id IS NOT NULL AND pr.status = 'LIVE'
      LIMIT 1`;
    railName = rows[0] && rows[0].name;
  } catch (e) { /* fall through to default */ }
  if (!railName) return DEFAULT;
  const key = _match(railName);
  if (key) return { name: key, adapter: ADAPTERS[key], railName };
  return { name: String(railName).toLowerCase(), adapter: null, railName, unsupported: true };
}

// Resolve by a processor name (used on the OTP step to stay on the same processor).
function processorByName(name) {
  const key = _match(name);
  return key ? { name: key, adapter: ADAPTERS[key] } : DEFAULT;
}

module.exports = { resolveCardProcessor, processorByName };
