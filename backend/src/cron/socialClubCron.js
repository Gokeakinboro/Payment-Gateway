'use strict';
/**
 * socialClubCron.js — Auto-generates Social Club plan invoices and sends reminders.
 *
 * Runs as a standalone pm2 process.  Two ways to drive it:
 *   • pm2 with cron_restart: '0 * * * *'  →  pm2 restarts the process every hour;
 *     the script runs once then exits (setInterval keeps it alive for direct node runs).
 *   • Direct: node src/cron/socialClubCron.js  →  runs once, then every 60 min.
 *
 * pm2 ecosystem snippet:
 *   {
 *     name: 'social-club-cron',
 *     script: 'src/cron/socialClubCron.js',
 *     cwd: '/opt/paylode-api/backend',
 *     cron_restart: '0 * * * *',
 *     autorestart: false,
 *   }
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const crypto = require('crypto');
const { prisma } = require('../utils/db');

// ── Logger ────────────────────────────────────────────────────────────────────

const log = (msg) => console.log('[socialClub-cron]', new Date().toISOString(), msg);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Advance next_run_at by one billing cycle.
 * Returns a Date for the next run, or null for one_time plans (no more runs).
 */
function advanceNextRunAt(frequency, current) {
  const d = new Date(current);
  switch (frequency) {
    case 'weekly':    d.setDate(d.getDate() + 7);          return d;
    case 'monthly':   d.setMonth(d.getMonth() + 1);        return d;
    case 'quarterly': d.setMonth(d.getMonth() + 3);        return d;
    case 'annually':  d.setFullYear(d.getFullYear() + 1);  return d;
    case 'one_time':  return null;
    default:          return null;
  }
}

/** 'INV-' + 8 uppercase hex chars */
function genInvoiceNumber() {
  return 'INV-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/** 32 hex chars */
function genAccessToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Step 1: Auto-invoice generation ──────────────────────────────────────────

async function generatePlanInvoices() {
  log('── invoice-generation pass starting ──');

  const plans = await prisma.$queryRawUnsafe(`
    SELECT id, merchant_id, name, amount, frequency, grace_period_days, next_run_at
    FROM   mw_plans
    WHERE  status      = 'active'
      AND  next_run_at IS NOT NULL
      AND  next_run_at <= NOW()
  `);

  log(`Found ${plans.length} plan(s) due for invoicing`);

  for (const plan of plans) {
    try {
      // ── Collect active members ──────────────────────────────────────────────
      const members = await prisma.$queryRawUnsafe(`
        SELECT pm.member_id, m.name, m.email
        FROM   mw_plan_members pm
        JOIN   mw_members      m  ON m.id = pm.member_id
        WHERE  pm.plan_id            = $1::uuid
          AND  pm.enrollment_status  = 'active'
      `, plan.id);

      let generated = 0;
      let skipped   = 0;

      for (const member of members) {
        // Skip if an open invoice already exists for this plan + member
        const existing = await prisma.$queryRawUnsafe(`
          SELECT id
          FROM   inv_invoices
          WHERE  plan_id   = $1::uuid
            AND  member_id = $2::uuid
            AND  status    IN ('pending', 'sent', 'partial')
          LIMIT  1
        `, plan.id, member.member_id);

        if (existing.length > 0) {
          skipped++;
          continue;
        }

        const invoiceId     = crypto.randomUUID();
        const invoiceNumber = genInvoiceNumber();
        const accessToken   = genAccessToken();
        const graceDays     = Number(plan.grace_period_days) || 0;
        const dueAt         = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000);
        // amount is bigint in Postgres; Prisma returns it as BigInt in JS
        const amount        = BigInt(plan.amount);

        await prisma.$queryRawUnsafe(`
          INSERT INTO inv_invoices
            (id, merchant_id, invoice_number, plan_id, member_id,
             recipient_name, recipient_email,
             currency, subtotal, total_amount,
             status, due_at, access_token, created_at)
          VALUES
            ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
             $6, $7,
             'NGN', $8, $8,
             'pending', $9, $10, NOW())
        `,
          invoiceId,
          plan.merchant_id,
          invoiceNumber,
          plan.id,
          member.member_id,
          member.name  || '',
          member.email || '',
          amount,
          dueAt,
          accessToken
        );

        generated++;
        log(`  [plan ${plan.id}] Invoice ${invoiceNumber} created for member ${member.member_id}`);
      }

      // ── Advance next_run_at ─────────────────────────────────────────────────
      const nextRun = advanceNextRunAt(plan.frequency, plan.next_run_at);

      if (nextRun === null) {
        await prisma.$queryRawUnsafe(`
          UPDATE mw_plans SET next_run_at = NULL WHERE id = $1::uuid
        `, plan.id);
      } else {
        await prisma.$queryRawUnsafe(`
          UPDATE mw_plans SET next_run_at = $1 WHERE id = $2::uuid
        `, nextRun, plan.id);
      }

      log(
        `Plan "${plan.name}" (${plan.id}): ` +
        `generated=${generated} skipped=${skipped} ` +
        `next_run_at=${nextRun ? nextRun.toISOString() : 'NULL (one_time exhausted)'}`
      );
    } catch (err) {
      log(`ERROR processing plan ${plan.id}: ${err.message}`);
      console.error(err);
    }
  }

  log('── invoice-generation pass done ──');
}

// ── Step 2: Email reminder stub ───────────────────────────────────────────────

async function sendEmailReminders(overdueInvoices) {
  for (const inv of overdueInvoices) {
    if (!inv.email) continue;

    // Log stub — replace with nodemailer / transactional-email call when ready
    log(`REMINDER: would send to ${inv.email} for invoice ${inv.invoice_number}`);
    // TODO: nodemailer integration
    //   await mailer.sendMail({
    //     to:      inv.email,
    //     subject: `Payment reminder — ${inv.invoice_number}`,
    //     html:    buildReminderHtml(inv),
    //   });
  }
}

// ── Step 3: WhatsApp reminder stub ────────────────────────────────────────────

async function sendWhatsAppReminders(overdueInvoices) {
  for (const inv of overdueInvoices) {
    if (!inv.phone) continue;

    // Blocked on Meta template approval — log only
    log(`WA_REMINDER: would notify ${inv.phone} for invoice ${inv.invoice_number}`);
    // TODO: Meta Cloud API call once template approved
    //   await metaCloudApi.sendTemplate({
    //     to:       inv.phone,
    //     template: 'payment_reminder',
    //     params:   [inv.invoice_number, formatAmount(inv.total_amount)],
    //   });
  }
}

// ── Step 2+3 orchestrator ─────────────────────────────────────────────────────

async function sendReminders() {
  log('── reminder pass starting ──');

  // Overdue plan invoices where the plan is configured for on-due / overdue reminders
  // (reminder_days contains 0 = "on due date", i.e. also catch overdue).
  const overdueInvoices = await prisma.$queryRawUnsafe(`
    SELECT
      i.id,
      i.invoice_number,
      i.member_id,
      i.plan_id,
      i.total_amount,
      m.email,
      m.phone,
      p.reminder_days
    FROM  inv_invoices i
    JOIN  mw_members   m ON m.id = i.member_id
    JOIN  mw_plans     p ON p.id = i.plan_id
    WHERE i.plan_id IS NOT NULL
      AND i.due_at  <= NOW()
      AND i.status   IN ('pending', 'sent', 'partial')
      AND 0          = ANY(p.reminder_days)
  `);

  log(`Found ${overdueInvoices.length} overdue plan invoice(s) with reminder_days containing 0`);

  if (overdueInvoices.length === 0) {
    log('── reminder pass done (nothing to do) ──');
    return;
  }

  await sendEmailReminders(overdueInvoices);
  await sendWhatsAppReminders(overdueInvoices);

  log('── reminder pass done ──');
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function run() {
  log('=== Social Club cron tick START ===');

  try {
    await generatePlanInvoices();
  } catch (err) {
    log(`FATAL in generatePlanInvoices: ${err.message}`);
    console.error(err);
  }

  try {
    await sendReminders();
  } catch (err) {
    log(`FATAL in sendReminders: ${err.message}`);
    console.error(err);
  }

  log('=== Social Club cron tick END ===');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Run immediately on start (pm2 cron_restart handles the schedule in production;
// setInterval keeps it ticking when run directly via `node src/cron/socialClubCron.js`).
run().catch((err) => {
  log(`Unhandled error in initial run: ${err.message}`);
  console.error(err);
});

const ONE_HOUR_MS = 60 * 60 * 1000;
setInterval(() => {
  run().catch((err) => {
    log(`Unhandled error in scheduled run: ${err.message}`);
    console.error(err);
  });
}, ONE_HOUR_MS);
