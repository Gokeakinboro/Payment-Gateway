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

  // Sent-payout reconciler — polls Parallex/PalmPay for legs stuck in 'sent'
  // (webhook never landed) and closes them. Safe: queries only, never re-dispatches.
  // Reversal only happens on confirmed NO RECORD (code=30) or after 12h hard cutoff.
  // Re-enabled 2026-09-17: requery guard at dispatch prevents false 'sent' legs.
  try {
    const { reconcileSentPayouts } = require('./services/payoutSettle');
    const RECON_MS = Number(process.env.PAYOUT_RECON_MS || 10 * 60 * 1000); // 10 min
    const run = () => reconcileSentPayouts()
      .catch(e => logger.error({ err: e }, 'sent payout reconciliation failed'));
    setTimeout(run, 60 * 1000);      // first run 1 min after boot
    setInterval(run, RECON_MS);
    logger.info(`  Sent-payout reconciler every ${Math.round(RECON_MS / 60000)} min (worker 0)`);
  } catch (e) {
    logger.error({ err: e }, '  ✗ sent-payout reconciler failed to start (continuing)');
  }

  // DISABLED 2026-09-17 — auto-settlement firing disabled pending manual review process.
  // Re-enable only with explicit SA sign-off.
  // try {
  //   const { processScheduledSettlements, reconcileFiredSettlements } = require('./services/settlementFire');
  //   ...
  // }

  // DISABLED 2026-09-17 — auto-dispatch caused duplicate sends during the 2026-09-15
  // incident. Inline dispatch (POST /payouts) still fires on submit; this cron backstop
  // is removed until a safe re-dispatch guard is in place.
  // try {
  //   const { autoDispatchDuePayouts } = require('./routes/payouts');
  //   ...
  // }

  // Stuck payout monitor — every 5 min, finds processing batches with unsent legs
  // (dispatch crashed after setup tx, before any rail transfer) and recovers them:
  // returns float, deletes pending disbursements, resets items + batch for re-dispatch.
  // Sends an alert email when anything is found. Complements the 30s Step-0 recovery
  // inside autoDispatchDuePayouts (which is the primary fix path; this is the safety net).
  try {
    const { recoverStuckPayouts, INTERVAL_S: STUCK_MS } = require('../../cron/stuckPayoutCron');
    const stuckRun = () => recoverStuckPayouts()
      .then(r => { if (r && r.found) logger.warn(r, '[stuck-payout-cron] cycle complete'); })
      .catch(e => logger.error({ err: e }, '[stuck-payout-cron] run error'));
    setTimeout(stuckRun, 2 * 60 * 1000);  // first check 2 min after boot
    setInterval(stuckRun, STUCK_MS);
    logger.info('  Stuck payout monitor every 5 min (worker 0)');
  } catch (e) {
    logger.error({ err: e }, '  ✗ stuck payout monitor failed to start (continuing)');
  }

  // Daily settlement GENERATION for the prior NIGERIAN day, at 00:01 Africa/Lagos, so
  // settlements populate without a manual "Run Batch". The day boundary is Lagos-keyed
  // (see settlementProcess.js). Idempotent (skips days already settled) → the boot
  // catch-up + the 00:01 fire can't duplicate. Worker 0 only.
  try {
    const { generateSettlements } = require('./services/settlementProcess');
    const runGen = (tag) => generateSettlements({ sandbox: false })
      .then(r => logger.info({ date: r.date, created: r.processed, skipped: r.skipped, tag }, 'daily settlement generation'))
      .catch(e => logger.error({ err: e }, 'daily settlement generation failed'));

    // Self-correcting daily schedule at 23:01 UTC = 00:01 Africa/Lagos (UTC+1, no DST).
    const scheduleNext = () => {
      const now = Date.now();
      const t = new Date(now);
      const next = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 23, 1, 0, 0));
      if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
      setTimeout(() => { runGen('daily-0001-WAT'); scheduleNext(); }, next.getTime() - now);
      logger.info(`  Daily settlement generation @ 00:01 Africa/Lagos — next ${next.toISOString()} (worker 0)`);
    };
    setTimeout(() => runGen('boot-catchup'), 45000); // catch up the prior Lagos day shortly after boot
    scheduleNext();
  } catch (e) {
    logger.error({ err: e }, '  ✗ daily settlement generation failed to start (continuing)');
  }

  // Aggregator T+1 margin sweep — daily at 01:00 Africa/Lagos.
  // Sums agg_share from the prior Lagos day, upserts monthly agg_payouts bucket,
  // and emails SA a summary. Does NOT trigger bank transfers. Worker 0 only.
  try {
    require('../../cron/aggPayoutCron');
    logger.info('  Aggregator T+1 margin sweep started (worker 0)');
  } catch (e) {
    logger.error({ err: e }, '  ✗ agg-payout cron failed to start (continuing)');
  }

  // Social Club — invoice generation cron + reminder scheduler. Worker 0 only.
  // Invoice cron: polls every 5 min for plans with next_run_at <= now, generates
  //   invoices for all enrolled active members, advances next_run_at.
  // Reminder scheduler: polls every 15 min, fires WhatsApp+email at reminder_days
  //   intervals before/after due date (idempotent via club_invoice_reminders table).
  try {
    const { runInvoiceCron, runReminderScheduler } = require('../wallet/services/socialClubJobs');
    const INVOICE_MS  = Number(process.env.SOCIAL_CLUB_INVOICE_CRON_MS  || 5  * 60 * 1000);
    const REMINDER_MS = Number(process.env.SOCIAL_CLUB_REMINDER_MS      || 15 * 60 * 1000);
    const runInv = () => runInvoiceCron()
      .then(r => { if (r.plans) logger.info(r, 'social club invoice cron'); })
      .catch(e => logger.error({ err: e }, 'social club invoice cron failed'));
    const runRem = () => runReminderScheduler()
      .then(r => { if (r.fired) logger.info(r, 'social club reminders fired'); })
      .catch(e => logger.error({ err: e }, 'social club reminder scheduler failed'));
    setTimeout(runInv, 60000);
    setInterval(runInv, INVOICE_MS);
    setTimeout(runRem, 90000);
    setInterval(runRem, REMINDER_MS);
    logger.info(`  Social Club invoice cron every ${INVOICE_MS / 60000}min, reminders every ${REMINDER_MS / 60000}min (worker 0)`);
  } catch (e) {
    logger.error({ err: e }, '  ✗ social club jobs failed to start (continuing)');
  }
}

module.exports = { startCoreJobs };

