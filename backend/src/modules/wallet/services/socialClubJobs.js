'use strict';
// Social Club background jobs — run from jobs.js (worker 0 only).
//   runInvoiceCron()       — auto-generate invoices for plans where next_run_at <= now
//   runReminderScheduler() — fire WhatsApp+email reminders for unpaid club invoices

const crypto = require('crypto');
const { prisma } = require('../_shared');
const { nextInvoiceNumber } = require('../../invoicing/services/invoiceNumber');

// ── Advance a date by one billing period ─────────────────────────────────────
function advanceDate(d, frequency) {
  const dt = new Date(d);
  switch (frequency) {
    case 'weekly':    dt.setDate(dt.getDate() + 7);          break;
    case 'monthly':   dt.setMonth(dt.getMonth() + 1);         break;
    case 'quarterly': dt.setMonth(dt.getMonth() + 3);         break;
    case 'annually':  dt.setFullYear(dt.getFullYear() + 1);   break;
    default:          return null; // one_time — no next run
  }
  return dt;
}

// ── Invoice generation cron ───────────────────────────────────────────────────
// For each active plan with next_run_at <= now:
//   1. Generate invoices for enrolled active members (idempotent — skips open invoices)
//   2. Advance next_run_at to the next period (null for one_time)
async function runInvoiceCron() {
  const duePlans = await prisma.$queryRawUnsafe(`
    SELECT p.id::text, p.name, p.merchant_id::text, p.amount::text AS amount,
           p.charge_vat, p.vat_rate::text AS vat_rate, p.sub_items, p.frequency,
           p.next_run_at, m.merchant_code, m.business_name
      FROM club_subscription_plans p
      JOIN merchants m ON m.id = p.merchant_id
     WHERE p.status = 'active'
       AND p.next_run_at IS NOT NULL
       AND p.next_run_at <= NOW()
  `);

  let totalGenerated = 0;
  for (const plan of duePlans) {
    try {
      const mid = plan.merchant_id;
      const planId = plan.id;
      const amount = BigInt(plan.amount);
      const vatRateFrac = plan.charge_vat ? parseFloat(plan.vat_rate || '7.5') / 100 : 0;
      const vatAmount = vatRateFrac > 0
        ? amount * BigInt(Math.round(vatRateFrac * 1_000_000)) / 1_000_000n : 0n;
      const totalAmount = amount + vatAmount;
      const dueAt = plan.next_run_at;
      const subItemsJson = JSON.stringify(plan.sub_items || []);

      const members = await prisma.$queryRawUnsafe(`
        SELECT cpm.member_id::text AS member_id, m.name, m.email, m.phone
          FROM club_plan_members cpm JOIN mw_members m ON m.id = cpm.member_id
         WHERE cpm.plan_id=$1::uuid AND cpm.merchant_id=$2::uuid
           AND cpm.status='active' AND m.status='active'
      `, planId, mid);
      if (!members.length) {
        await prisma.$executeRawUnsafe(
          `UPDATE club_subscription_plans SET next_run_at=$1, updated_at=now() WHERE id=$2::uuid`,
          advanceDate(plan.next_run_at, plan.frequency), planId);
        continue;
      }

      const existing = await prisma.$queryRawUnsafe(`
        SELECT club_member_id::text AS member_id FROM inv_invoices
         WHERE club_plan_id=$1::uuid AND status IN ('unpaid','sent','part_paid') AND deleted_at IS NULL
      `, planId);
      const already = new Set(existing.map(r => r.member_id));

      let generated = 0;
      for (const m of members) {
        if (already.has(m.member_id)) continue;
        const invNumber = await nextInvoiceNumber(mid, plan.merchant_code);
        const token = crypto.randomBytes(20).toString('hex');
        await prisma.$executeRawUnsafe(`
          INSERT INTO inv_invoices
            (merchant_id,invoice_number,recipient_name,recipient_email,recipient_phone,
             description,amount,charge_vat,vat_amount,total_amount,amount_paid,currency,
             status,access_token,due_at,line_items,club_plan_id,club_member_id)
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,'NGN','unpaid',$11,$12,$13::jsonb,$14::uuid,$15::uuid)
        `, mid, invNumber, m.name, m.email, m.phone || null,
           plan.name, amount, plan.charge_vat, vatAmount, totalAmount,
           token, dueAt, subItemsJson, planId, m.member_id);
        generated++;
      }

      const nextRun = advanceDate(plan.next_run_at, plan.frequency);
      await prisma.$executeRawUnsafe(
        `UPDATE club_subscription_plans SET next_run_at=$1, updated_at=now() WHERE id=$2::uuid`,
        nextRun, planId);

      totalGenerated += generated;
    } catch (e) {
      console.error('social club invoice cron failed for plan', plan.id, e.message);
    }
  }
  return { plans: duePlans.length, generated: totalGenerated };
}

// ── Reminder scheduler ────────────────────────────────────────────────────────
// For each unpaid club invoice with a due_at:
//   - Compute days until/since due date (negative = overdue)
//   - If that integer matches a reminder_days entry not yet sent → fire + record
async function runReminderScheduler() {
  const invoices = await prisma.$queryRawUnsafe(`
    SELECT i.id::text AS invoice_id, i.invoice_number,
           i.recipient_name, i.recipient_email, i.recipient_phone,
           i.due_at, i.total_amount::text AS total_amount,
           p.name AS plan_name, p.reminder_days,
           m.business_name AS merchant_name
      FROM inv_invoices i
      JOIN club_subscription_plans p ON p.id = i.club_plan_id
      JOIN merchants m ON m.id = i.merchant_id
     WHERE i.status IN ('unpaid','sent','part_paid')
       AND i.deleted_at IS NULL
       AND i.due_at IS NOT NULL
       AND i.club_plan_id IS NOT NULL
  `);

  let fired = 0;
  const nowMs = Date.now();

  for (const inv of invoices) {
    try {
      const daysUntilDue = Math.round((new Date(inv.due_at).getTime() - nowMs) / 86400000);
      const reminderDays = Array.isArray(inv.reminder_days) ? inv.reminder_days.map(Number) : [];
      if (!reminderDays.includes(daysUntilDue)) continue;

      // Insert reminder record — unique constraint prevents double-fire
      try {
        await prisma.$executeRawUnsafe(`
          INSERT INTO club_invoice_reminders (invoice_id, reminder_day)
          VALUES ($1::uuid, $2)
        `, inv.invoice_id, daysUntilDue);
      } catch (e) {
        if (e.code === '23505') continue; // already sent this day
        throw e;
      }

      const amountNaira = (Number(inv.total_amount) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
      const dueLabel = daysUntilDue === 0 ? 'today'
        : daysUntilDue > 0 ? `in ${daysUntilDue} day(s)`
        : `${Math.abs(daysUntilDue)} day(s) overdue`;
      const message = `Dear ${inv.recipient_name}, your ${inv.plan_name} subscription ` +
        `(₦${amountNaira}) from ${inv.merchant_name} is due ${dueLabel}. Ref: ${inv.invoice_number}.`;

      if (inv.recipient_phone) {
        try {
          const wa = require('../../../services/whatsappService');
          await wa.sendTextMessage(inv.recipient_phone, message);
        } catch (_) {}
      }
      if (inv.recipient_email) {
        try {
          const mail = require('../../../services/emailService');
          await mail.send({
            to: inv.recipient_email,
            subject: `Subscription due ${dueLabel} — ${inv.merchant_name}`,
            text: message,
          });
        } catch (_) {}
      }

      fired++;
    } catch (e) {
      console.error('reminder scheduler error for invoice', inv.invoice_id, e.message);
    }
  }
  return { checked: invoices.length, fired };
}

module.exports = { runInvoiceCron, runReminderScheduler };
