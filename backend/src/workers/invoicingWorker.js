'use strict';
/**
 * Invoice & Collect — background worker (standalone pm2 process, like webhookWorker).
 * Periodic DB sweeps (cron-style poll — simpler and idempotent for these tasks):
 *   1. Scheduled sends   — invoices whose scheduled_at has arrived.
 *   2. Overdue reminders — past due_at, up to the merchant-set count/interval.
 *   3. Payment reconcile — record card payments finalized inside checkout.js.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { prisma } = require('../utils/db');
const { logger } = require('../utils/logger');
const { sendInvoice } = require('../modules/invoicing/services/invoiceSend');
const { reconcileInvoicingPayments } = require('../modules/invoicing/services/invoicingPay');
const { reconcileWalletFunding } = require('../modules/wallet/services/walletFund');

const TICK_MS = Number(process.env.INVOICING_TICK_MS || 60 * 1000);

async function processScheduledSends() {
  const due = await prisma.$queryRawUnsafe(
    `SELECT id::text FROM inv_invoices
      WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= now() LIMIT 200`);
  for (const r of due) {
    try {
      const rr = await sendInvoice(r.id);
      if (!rr.sent) logger.warn({ reason: rr.error, id: r.id }, 'scheduled invoice not sent');
    } catch (e) { logger.warn({ err: e.message, id: r.id }, 'scheduled invoice send failed'); }
  }
  return due.length;
}

async function processOverdueReminders() {
  // Flag overdue + send the next reminder when interval has elapsed and the
  // merchant-set reminder count is not exhausted.
  await prisma.$executeRawUnsafe(
    `UPDATE inv_invoices SET is_overdue = true, updated_at = now()
      WHERE due_at IS NOT NULL AND due_at < now()
        AND status IN ('sent','viewed','part_paid') AND is_overdue = false`);
  const due = await prisma.$queryRawUnsafe(
    `SELECT id::text FROM inv_invoices
      WHERE due_at IS NOT NULL AND due_at < now()
        AND status IN ('sent','viewed','part_paid')
        AND reminder_interval_days IS NOT NULL AND reminder_count > 0
        AND reminders_sent < reminder_count
        AND (last_reminder_at IS NULL OR last_reminder_at < now() - (reminder_interval_days || ' days')::interval)
      LIMIT 200`);
  for (const r of due) {
    try {
      const rr = await sendInvoice(r.id, { isReminder: true });
      if (!rr.sent) logger.warn({ reason: rr.error, id: r.id }, 'reminder not sent');
    } catch (e) { logger.warn({ err: e.message, id: r.id }, 'reminder send failed'); }
  }
  return due.length;
}

async function tick() {
  try {
    const sent = await processScheduledSends();
    const reminded = await processOverdueReminders();
    const rec = await reconcileInvoicingPayments();
    const wal = await reconcileWalletFunding();
    if (sent || reminded || rec.recorded || wal.credited)
      logger.info({ sent, reminded, recorded: rec.recorded, walletCredited: wal.credited }, 'invoicing tick');
  } catch (e) {
    logger.error({ err: e.message }, 'invoicing worker tick failed');
  }
}

logger.info({ tickMs: TICK_MS }, 'Paylode invoicing worker started');
setTimeout(tick, 8000);
setInterval(tick, TICK_MS);

async function shutdown() { logger.info('Invoicing worker shutting down...'); await prisma.$disconnect(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
