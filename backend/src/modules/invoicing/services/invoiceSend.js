'use strict';
// Builds + sends the invoice email and flips status to 'sent'. Shared by the
// create-invoice route (immediate send) and the worker (scheduled sends + reminders).
const { prisma, CHECKOUT_BASE, escapeHtml, koboToNairaStr } = require('../_shared');
const { sendEmail } = require('../../../services/emailService');
const whatsapp = require('../../../services/whatsappService');

const invoiceUrl = (token) => `${CHECKOUT_BASE}/invoice.html?t=${token}`;

// Normalise stored line_items (jsonb) into a render-friendly array. Supports both
// the new itemized shape [{name, unit_amount, quantity, amount}] and the legacy
// [{description, amount}] shape (quantity defaults to 1).
function parseLineItems(inv) {
  let items = inv.line_items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = null; } }
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const qty  = Number(it.quantity || it.qty || 1) || 1;
    const unit = it.unit_amount != null ? Number(it.unit_amount)
               : (it.amount != null ? Math.round(Number(it.amount) / qty) : 0);
    const amt  = it.amount != null ? Number(it.amount) : unit * qty;
    return { name: String(it.name || it.description || 'Item'), qty, unit, amt };
  }).filter((it) => it.name || it.amt);
}

function invoiceEmailHtml({ bizName, inv, payUrl, isReminder }) {
  const cur = inv.currency === 'USD' ? '$' : '₦';
  const money = (k) => `${cur}${koboToNairaStr(k)}`;
  const lead = isReminder
    ? `This is a reminder that the invoice below is still outstanding.`
    : `<strong>${escapeHtml(bizName)}</strong> has sent you an invoice.`;

  const items = parseLineItems(inv);
  // Itemized rows: Description | Qty × Unit | Amount. Falls back to a single
  // "Amount" line for invoices with no stored line items (legacy/simple).
  const itemRows = items.length
    ? items.map((it) => `<tr>
        <td style="padding:6px 0;vertical-align:top">${escapeHtml(it.name)}
          <div style="font-size:12px;color:#888">${it.qty} × ${money(it.unit)}</div></td>
        <td style="text-align:right;vertical-align:top;padding:6px 0;white-space:nowrap">${money(it.amt)}</td></tr>`).join('')
    : `<tr><td style="padding:6px 0">Amount</td><td style="text-align:right">${money(inv.amount)}</td></tr>`;

  const svc = Number(inv.service_charge_amount || 0);
  const svcLine = svc > 0
    ? `<tr><td style="padding:2px 0;color:#555">${escapeHtml(inv.service_charge_label || 'Service charge')}</td><td style="text-align:right;color:#555">${money(svc)}</td></tr>` : '';
  const subtotalLine = items.length
    ? `<tr><td style="padding:2px 0;color:#555">Subtotal</td><td style="text-align:right;color:#555">${money(Number(inv.amount) - svc)}</td></tr>` : '';
  const vatLine = Number(inv.vat_amount) > 0
    ? `<tr><td style="padding:2px 0;color:#555">VAT</td><td style="text-align:right;color:#555">${money(inv.vat_amount)}</td></tr>` : '';

  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;color:#1a1a1a">
    <p>${lead}</p>
    <p style="margin:14px 0;font-size:15px"><strong>Invoice ${escapeHtml(inv.invoice_number)}</strong>${inv.description ? `<br>${escapeHtml(inv.description)}` : ''}</p>
    <table style="width:100%;font-size:14px;border-collapse:collapse;margin:10px 0">
      <tr><td colspan="2" style="border-bottom:1px solid #eee;font-size:12px;color:#999;text-transform:uppercase;letter-spacing:.04em;padding-bottom:4px">Items</td></tr>
      ${itemRows}
      <tr><td colspan="2" style="border-top:1px solid #eee;padding-top:4px"></td></tr>
      ${subtotalLine}
      ${svcLine}
      ${vatLine}
      <tr><td style="padding:6px 0;font-weight:700;border-top:1px solid #eee">Total due</td><td style="text-align:right;font-weight:700;border-top:1px solid #eee">${money(inv.total_amount)}</td></tr>
    </table>
    ${inv.due_at ? `<p style="font-size:13px;color:#666">Due by ${escapeHtml(new Date(inv.due_at).toDateString())}</p>` : ''}
    <p><a href="${payUrl}" style="background:#16a34a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">View & pay invoice</a></p>
    <p style="font-size:12px;color:#666;margin-top:12px">Or open: ${escapeHtml(payUrl)}</p>
    <p style="font-size:11px;color:#999;margin-top:18px">Powered by Paylode</p></div>`;
}

// Send (or re-send as a reminder) one invoice. Returns an outcome object so callers
// can show an accurate on-screen notification:
//   { found, sent, recipient, email, error }
//   - found     : the invoice exists
//   - recipient : it has an email address to send to
//   - sent      : an email actually went out (delivery accepted by the mail service)
//   - email     : the recipient address (for the "Sent to X" message)
//   - error     : human-readable failure reason when sent=false (null otherwise)
// The invoice is only flipped to 'sent' when the email genuinely goes out — a failed
// or recipient-less send never falsely reports "sent".
async function sendInvoice(invoiceId, { isReminder = false } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT i.*, m.business_name, m.notification_settings, d.service_charge_label
       FROM inv_invoices i
       JOIN merchants m ON m.id = i.merchant_id
       LEFT JOIN inv_departments d ON d.id = i.department_id
      WHERE i.id = $1::uuid`, invoiceId);
  if (!rows.length) return { found: false, sent: false, recipient: false, email: null, error: 'Invoice not found' };
  const inv = rows[0];
  const payUrl = invoiceUrl(inv.access_token);
  const bizName = inv.business_name || 'A merchant';

  if (!inv.recipient_email) {
    return { found: true, sent: false, recipient: false, email: null,
      error: 'No email address on this invoice — share the payment link or QR instead.' };
  }

  let sendError = null;
  try {
    await sendEmail({
      to: inv.recipient_email,
      subject: `${isReminder ? 'Reminder: ' : ''}Invoice ${inv.invoice_number} from ${bizName}`.slice(0, 160),
      html: invoiceEmailHtml({ bizName, inv, payUrl, isReminder }),
      text: `${bizName} — Invoice ${inv.invoice_number}. Total due ${inv.currency} ${koboToNairaStr(inv.total_amount)}. Pay: ${payUrl}`,
    });
  } catch (e) {
    sendError = (e && e.message) ? e.message : 'Email delivery failed';
  }

  // WhatsApp notification — only if merchant has opted in (whatsapp_invoice toggle ON).
  const notifSettings = inv.notification_settings || {};
  if (inv.recipient_phone && notifSettings.whatsapp_invoice) {
    whatsapp.notifyInvoice({
      phone: inv.recipient_phone, recipientName: inv.recipient_name, businessName: bizName,
      invoiceNumber: inv.invoice_number, amount: inv.total_amount, currency: inv.currency, payUrl,
    }).catch(() => {});
  }

  if (sendError) {
    return { found: true, sent: false, recipient: true, email: inv.recipient_email, error: sendError };
  }

  // Email went out — record it. Only now flip status / bump the reminder counter.
  if (isReminder) {
    await prisma.$executeRawUnsafe(
      `UPDATE inv_invoices SET reminders_sent = reminders_sent + 1, last_reminder_at = now(), updated_at = now() WHERE id = $1::uuid`, invoiceId);
  } else {
    await prisma.$executeRawUnsafe(
      `UPDATE inv_invoices SET status = CASE WHEN status IN ('draft','scheduled') THEN 'sent' ELSE status END,
              sent_at = COALESCE(sent_at, now()), updated_at = now() WHERE id = $1::uuid`, invoiceId);
  }
  return { found: true, sent: true, recipient: true, email: inv.recipient_email, error: null };
}

module.exports = { sendInvoice, invoiceUrl };
