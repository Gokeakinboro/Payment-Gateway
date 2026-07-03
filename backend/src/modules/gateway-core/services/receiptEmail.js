'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Customer payment receipt. Emailed to the payer on every SUCCESSFUL transaction
//  (we always capture customerEmail). Best-effort: self-loads the final txn state
//  by reference, never throws, and never blocks the payment response — call it
//  fire-and-forget right after a transaction flips to SUCCESS.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../../../utils/db');
const { sendEmail, getEmailContent } = require('../../../services/emailService');
const { logger } = require('../../../utils/logger');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function money(kobo, ccy) {
  const sym = ccy === 'USD' ? '$' : '₦';
  return sym + (Number(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const CHANNEL_LABEL = { CARD: 'Card', BANK_TRANSFER: 'Bank Transfer', USSD: 'USSD', DIRECT_DEBIT: 'Direct Debit' };

// Send the receipt for a SUCCESS transaction identified by reference.
async function sendCustomerReceipt(reference) {
  try {
    const txn = await prisma.transaction.findUnique({
      where: { reference },
      include: { merchant: { select: { businessName: true } } },
    });
    if (!txn || txn.status !== 'SUCCESS' || !txn.customerEmail) return;

    const ccy          = txn.currency || 'NGN';
    // What the customer actually paid: the gross stored at mint (payer-funded
    // collections) if present, else the transaction amount.
    const paidKobo     = (txn.metadata && txn.metadata.payin && txn.metadata.payin.charge != null)
      ? txn.metadata.payin.charge : txn.amount;
    const amount       = money(paidKobo, ccy);
    const merchantName = (txn.merchant && txn.merchant.businessName) || 'the merchant';
    const description  = (txn.metadata && txn.metadata.description) || 'Payment';
    const channel      = CHANNEL_LABEL[txn.channel] || txn.channel || 'Payment';
    const dateStr      = new Date(txn.paidAt || Date.now()).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });

    const content = await getEmailContent('payment_receipt',
      { merchant_name: merchantName, amount, reference: txn.reference, date: dateStr, description, channel },
      `Payment receipt — ${amount} to ${merchantName}`,
      `<h2 style="margin:0 0 8px">Payment successful</h2>` +
      `<p>Your payment of <strong>${esc(amount)}</strong> to <strong>${esc(merchantName)}</strong> was successful.</p>` +
      `<table cellpadding="6" style="font-size:14px;border-collapse:collapse">` +
        `<tr><td style="color:#666">Amount</td><td><strong>${esc(amount)}</strong></td></tr>` +
        `<tr><td style="color:#666">Paid to</td><td>${esc(merchantName)}</td></tr>` +
        `<tr><td style="color:#666">Description</td><td>${esc(description)}</td></tr>` +
        `<tr><td style="color:#666">Method</td><td>${esc(channel)}</td></tr>` +
        `<tr><td style="color:#666">Reference</td><td>${esc(txn.reference)}</td></tr>` +
        `<tr><td style="color:#666">Date</td><td>${esc(dateStr)}</td></tr>` +
      `</table>` +
      `<p style="color:#999;font-size:12px;margin-top:16px">This receipt was sent by Paylode on behalf of ${esc(merchantName)}. ` +
      `If you didn't make this payment, please contact ${esc(merchantName)}.</p>`);

    const subject = (txn.isSandbox ? '[Test] ' : '') + content.subject;
    await sendEmail({ to: txn.customerEmail, subject, html: content.html });
  } catch (e) {
    try { logger.error({ err: e, reference }, 'customer receipt email failed'); } catch (_) {}
  }
}

module.exports = { sendCustomerReceipt };
