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

  // Settlement firing — run DUE scheduled settlements + reconcile fired settlements
  // stuck PROCESSING (the dedicated settlement dispatch has no rail_disbursement leg,
  // so the payout webhook can't finalize them; we poll the rail instead). Worker 0 only.
  try {
    const { processScheduledSettlements, reconcileFiredSettlements } = require('./services/settlementFire');
    const SET_MS = Number(process.env.SETTLEMENT_FIRE_MS || 60 * 1000); // 1 min
    const run = () => {
      processScheduledSettlements().catch(e => logger.error({ err: e }, 'scheduled settlement firing failed'));
      reconcileFiredSettlements().catch(e => logger.error({ err: e }, 'settlement fire reconciliation failed'));
    };
    setTimeout(run, 35000);           // once shortly after boot
    setInterval(run, SET_MS);         // then on a schedule
    logger.info(`  Settlement firing/reconcile every ${Math.round(SET_MS / 1000)}s (worker 0)`);
  } catch (e) {
    logger.error({ err: e }, '  ✗ settlement firing job failed to start (continuing)');
  }

  // Daily settlement GENERATION for the prior day, at 00:01 (server-local time), so
  // settlements populate without a manual "Run Batch". Idempotent (skips days already
  // settled) → the boot catch-up + the 00:01 fire can't duplicate. Worker 0 only.
  // NOTE: server TZ = Europe/Berlin; "prior day" is the server-local calendar day.
  try {
    const { generateSettlements } = require('./services/settlementProcess');
    const runGen = (tag) => generateSettlements({ sandbox: false })
      .then(r => logger.info({ date: r.date, created: r.processed, skipped: r.skipped, tag }, 'daily settlement generation'))
      .catch(e => logger.error({ err: e }, 'daily settlement generation failed'));

    // Self-correcting daily schedule at 00:01 local (recursive setTimeout, no drift).
    const scheduleNext = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(0, 1, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1); // past 00:01 today → tomorrow
      setTimeout(() => { runGen('daily-0001'); scheduleNext(); }, next - now);
      logger.info(`  Daily settlement generation @ 00:01 local — next ${next.toISOString()} (worker 0)`);
    };
    setTimeout(() => runGen('boot-catchup'), 45000); // catch up the prior day shortly after boot
    scheduleNext();
  } catch (e) {
    logger.error({ err: e }, '  ✗ daily settlement generation failed to start (continuing)');
  }
}

module.exports = { startCoreJobs };
