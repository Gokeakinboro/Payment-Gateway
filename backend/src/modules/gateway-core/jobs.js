'use strict';
/**
 * gateway-core background jobs. These belong to the money core, so they run in
 * the monolith (server.js) and, after the P3 split, ONLY in the core service —
 * never in the product services.
 *
 * Each job is started inside its own try/catch so a failure to load/schedule one
 * can't crash boot (same guarantee the module registry gives the routes). Polling
 * jobs run on ONE pm2 worker only (instance 0) to avoid N× polling.
 */

function startCoreJobs({ logger }) {
  // KYC deferral-expiry sweep self-schedules on require (advisory-locked, so it's
  // safe on every worker/instance). Guarded so a failure can't crash boot.
  try {
    require('../../services/deferralExpiryService');
  } catch (e) {
    logger.error({ err: e }, '✗ deferralExpiryService failed to load (continuing)');
  }

  if ((process.env.NODE_APP_INSTANCE || '0') !== '0') return;

  // Rail-float poll — refresh OUR balance on each payout rail (PalmPay etc.).
  try {
    const { syncAllFloats } = require('./services/railFloat');
    const POLL_MS = Number(process.env.RAIL_FLOAT_POLL_MS || 10 * 60 * 1000); // 10 min
    const run = () => syncAllFloats().catch(e => logger.error({ err: e }, 'rail float poll failed'));
    setTimeout(run, 15000);          // once shortly after boot
    setInterval(run, POLL_MS);       // then on a schedule
    logger.info(`  Rail-float poll every ${Math.round(POLL_MS / 60000)} min (worker 0)`);
  } catch (e) {
    logger.error({ err: e }, '  ✗ rail-float poll failed to start (continuing)');
  }

  // Stuck-'sent' payout reconciliation — backstop for payout legs whose rail
  // webhook never landed. Queries the rail's payout-result API and settles/refunds
  // via the same shared logic as the webhook. Worker 0 only.
  try {
    const { reconcileSentPayouts } = require('./services/payoutSettle');
    const RECON_MS = Number(process.env.PAYOUT_RECON_MS || 3 * 60 * 1000); // 3 min
    const recon = () => reconcileSentPayouts().catch(e => logger.error({ err: e }, 'payout reconciliation failed'));
    setTimeout(recon, 25000);        // once shortly after boot
    setInterval(recon, RECON_MS);    // then on a schedule
    logger.info(`  Stuck-sent payout reconciliation every ${Math.round(RECON_MS / 60000)} min (worker 0)`);
  } catch (e) {
    logger.error({ err: e }, '  ✗ payout reconciliation failed to start (continuing)');
  }
}

module.exports = { startCoreJobs };
