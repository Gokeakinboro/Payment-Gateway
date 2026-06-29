'use strict';
// Builds + sends the invoice email and flips status to 'sent'. Shared by the
// create-invoice route (immediate send) and the worker (scheduled sends + reminders).
const { prisma, CHECKOUT_BASE, escapeHtml, koboToNairaStr } = require('../_shared');
const { sendEmail } = require('../../../services/emailService');
const sendchamp = require('../../../services/sendchampService');

const invoiceUrl = (token) => `${CHECKOUT_BASE}/invoice.html?t=${token}`;

function invoiceEmailHtml({ bizName, inv, payUrl, isReminder }) {
  const cur = inv.currency === 'USD' ? '$' : '₦';
  const lead = isReminder
    ? `This is a reminder that the invoice below is still outstanding.`
    : `<strong>${escapeHtml(bizName)}</strong> has sent you an invoice.`;
  const vatLine = Number(inv.vat_amount) > 0
    ? `<tr><td style="padding:2px 0">VAT</td><td style="text-align:right">${cur}${koboToNairaStr(inv.vat_amount)}</td></tr>` : '';
  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;color:#1a1a1a">
    <p>${lead}</p>
    <p style="margin:14px 0;font-size:15px"><strong>Invoice ${escapeHtml(inv.invoice_number)}</strong>${inv.description ? `<br>${escapeHtml(inv.description)}` : ''}</p>
    <table style="width:100%;font-size:14px;border-top:1px solid #eee;border-bottom:1px solid #eee;margin:10px 0;padding:8px 0">
      <tr><td style="padding:2px 0">Amount</td><td style="text-align:right">${cur}${koboToNairaStr(inv.amount)}</td></tr>
      ${vatLine}
      <tr><td style="padding:6px 0;font-weight:700">Total due</td><td style="text-align:right;font-weight:700">${cur}${koboToNairaStr(inv.total_amount)}</td></tr>
    </table>
    ${inv.due_at ? `<p style="font-size:13px;color:#666">Due by ${escapeHtml(new Date(inv.due_at).toDateString())}</p>` : ''}
    <p><a href="${payUrl}" style="background:#16a34a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">View & pay invoice</a></p>
    <p style="font-size:12px;color:#666;margin-top:12px">Or open: ${escapeHtml(payUrl)}</p>
    <p style="font-size:11px;color:#999;margin-top:18px">Powered by Paylode</p></div>`;
}

// Send (or re-send as a reminder) one invoice. Returns true if an email went out.
async function sendInvoice(invoiceId, { isReminder = false } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT i.*, m.business_name FROM inv_invoices i JOIN merchants m ON m.id = i.merchant_id
      WHERE i.id = $1::uuid`, invoiceId);
  if (!rows.length) return false;
  const inv = rows[0];
  const payUrl = invoiceUrl(inv.access_token);
  const bizName = inv.business_name || 'A merchant';

  if (inv.recipient_email) {
    await sendEmail({
      to: inv.recipient_email,
      subject: `${isReminder ? 'Reminder: ' : ''}Invoice ${inv.invoice_number} from ${bizName}`.slice(0, 160),
      html: invoiceEmailHtml({ bizName, inv, payUrl, isReminder }),
      text: `${bizName} — Invoice ${inv.invoice_number}. Total due ${inv.currency} ${koboToNairaStr(inv.total_amount)}. Pay: ${payUrl}`,
    });
  }

  // WhatsApp notification (best-effort; no-ops until a SendChamp sender + template
  // are configured). Additive to email — uses the recipient phone we now capture.
  if (inv.recipient_phone) {
    sendchamp.notifyInvoice({
      phone: inv.recipient_phone, recipientName: inv.recipient_name, businessName: bizName,
      invoiceNumber: inv.invoice_number, amount: inv.total_amount, currency: inv.currency, payUrl,
    }).catch(() => {});
  }

  if (isReminder) {
    await prisma.$executeRawUnsafe(
      `UPDATE inv_invoices SET reminders_sent = reminders_sent + 1, last_reminder_at = now(), updated_at = now() WHERE id = $1::uuid`, invoiceId);
  } else {
    await prisma.$executeRawUnsafe(
      `UPDATE inv_invoices SET status = CASE WHEN status IN ('draft','scheduled') THEN 'sent' ELSE status END,
              sent_at = COALESCE(sent_at, now()), updated_at = now() WHERE id = $1::uuid`, invoiceId);
  }
  return !!inv.recipient_email;
}

module.exports = { sendInvoice, invoiceUrl };
