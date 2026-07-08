'use strict';
// Rail float = OUR balance held with a payout rail (e.g. PalmPay). Internal only —
// never shown to merchants. Polled from each rail's balance API and stored on
// payment_rails.float_balance; the SA routing panel + payout guard read it.
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');
const { payoutAdapterForName } = require('./payoutRailAdapter');
const { checkRailBalanceAndAlert } = require('./railHealth');

// Map a rail to an adapter that reports OUR balance with it, or null if the rail
// has no balance API yet / isn't configured. Rails are registered centrally in
// payoutRailAdapter.js (PalmPay, Parallex, …).
function adapterFor(rail) {
  const adapter = payoutAdapterForName(rail && rail.name);
  return adapter ? adapter.getBalance : null;
}

// Pull the live balance for one rail and persist it. Returns BigInt kobo, or
// null if the rail exposes no balance API.
async function syncRailFloat(rail) {
  const getBalance = adapterFor(rail);
  if (!getBalance) return null;
  const kobo = await getBalance();                     // throws on API error
  await prisma.paymentRail.update({
    where: { id: rail.id },
    data: { floatBalance: kobo, floatSyncedAt: new Date() },
  });
  return kobo;
}

// Best-effort sync of every payout-enabled rail with a balance API.
async function syncAllFloats() {
  const rails = await prisma.paymentRail.findMany({ where: { payoutEnabled: true } });
  for (const rail of rails) {
    try {
      const k = await syncRailFloat(rail);
      if (k !== null) {
        logger.info({ rail: rail.name, floatKobo: k.toString() }, 'rail float synced');
        // Proactive low-balance watch: alert SA (debounced) when our balance with
        // the rail is low — reuse the just-synced value, no extra API call.
        await checkRailBalanceAndAlert(rail, async () => k);
      }
    } catch (e) {
      logger.error({ err: e, rail: rail.name }, 'rail float sync failed');
    }
  }
}

module.exports = { syncRailFloat, syncAllFloats, adapterFor };
