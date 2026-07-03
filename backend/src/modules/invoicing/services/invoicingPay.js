'use strict';
/**
 * Records invoice / QR payments once the underlying gateway transaction succeeds.
 *
 * A transaction minted by this module is tagged in metadata:
 *   { source:'invoice', invoice_id }  or  { source:'qr', qr_id, buyer_note? }
 *
 * recordForTransaction() is idempotent (unique index on transaction_id) and is
 * called from two places:
 *   1. finalizePayinSuccess (bank transfer / VA) — instant.
 *   2. reconcileInvoicingPayments() — a worker sweep that catches card payments
 *      (whose success is written inside checkout.js) without touching that file.
 */
const { prisma } = require('../../../utils/db');
const { dispatchWebhook } = require('../../../services/webhookService');
const whatsapp = require('../../../services/whatsappService');

// Apply one SUCCESS transaction to its invoice or QR code. Safe to call repeatedly.
async function recordForTransaction(txn) {
  if (!txn || txn.status !== 'SUCCESS') return { skipped: true };
  const meta = txn.metadata || {};
  const source = meta.source;
  if (source !== 'invoice' && source !== 'qr') return { skipped: true };

  const amount = BigInt(txn.amount);

  if (source === 'invoice' && meta.invoice_id) {
    // Insert the payment ledger row once (unique on transaction_id).
    const ins = await prisma.$executeRawUnsafe(
      `INSERT INTO inv_invoice_payments (invoice_id, amount_paid, vat_amount, transaction_id, payment_reference, channel)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6)
       ON CONFLICT (transaction_id) WHERE transaction_id IS NOT NULL DO NOTHING`,
      meta.invoice_id, amount, BigInt(meta.invoice_vat || 0), txn.id, txn.reference, txn.channel || null
    );
    if (!ins) return { duplicate: true };

    // Roll up paid total → set status paid / part_paid.
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE inv_invoices i SET
          amount_paid = sub.paid,
          status = CASE WHEN sub.paid >= i.total_amount THEN 'paid' ELSE 'part_paid' END,
          paid_at = CASE WHEN sub.paid >= i.total_amount THEN now() ELSE i.paid_at END,
          updated_at = now()
        FROM (SELECT COALESCE(SUM(amount_paid),0) AS paid FROM inv_invoice_payments WHERE invoice_id = $1::uuid) sub
       WHERE i.id = $1::uuid
       RETURNING i.merchant_id::text AS merchant_id, i.invoice_number, i.status, i.recipient_email,
                 i.recipient_phone, i.recipient_name, i.currency,
                 i.total_amount::text AS total_amount, sub.paid::text AS paid`,
      meta.invoice_id
    );
    const inv = rows[0];
    if (inv) notifyMerchant(inv.merchant_id, 'invoice.paid', {
      invoice_number: inv.invoice_number, status: inv.status,
      amount_paid: Number(inv.paid), total: Number(inv.total_amount), reference: txn.reference,
    });
    // WhatsApp receipt to the payer once fully paid (best-effort; no-ops until configured).
    if (inv && inv.status === 'paid' && inv.recipient_phone) {
      prisma.merchant.findUnique({ where: { id: inv.merchant_id }, select: { businessName: true } })
        .then((m) => whatsapp.notifyReceipt({
          phone: inv.recipient_phone, recipientName: inv.recipient_name,
          businessName: (m && m.businessName) || 'Paylode', invoiceNumber: inv.invoice_number,
          amount: inv.total_amount, currency: inv.currency,
        }).catch(() => {}))
        .catch(() => {});
    }
    return { recorded: true, invoice: inv };
  }

  if (source === 'qr' && meta.qr_id) {
    const ins = await prisma.$executeRawUnsafe(
      `INSERT INTO inv_qr_payments (qr_code_id, amount_paid, vat_amount, buyer_note, transaction_id, payment_reference)
         VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)
       ON CONFLICT (transaction_id) WHERE transaction_id IS NOT NULL DO NOTHING`,
      meta.qr_id, amount, BigInt(meta.invoice_vat || 0), meta.buyer_note || null, txn.id, txn.reference
    );
    if (!ins) return { duplicate: true };
    const rows = await prisma.$queryRawUnsafe(
      `SELECT merchant_id::text AS merchant_id, label FROM inv_qr_codes WHERE id = $1::uuid`, meta.qr_id);
    const qr = rows[0];
    if (qr) notifyMerchant(qr.merchant_id, 'qr.paid', {
      qr_label: qr.label, amount_paid: Number(amount), reference: txn.reference,
    });
    return { recorded: true };
  }
  return { skipped: true };
}

function notifyMerchant(merchantId, event, data) {
  prisma.merchant.findUnique({ where: { id: merchantId }, select: { webhookUrl: true } })
    .then((m) => { if (m && m.webhookUrl) dispatchWebhook(merchantId, event, data).catch(() => {}); })
    .catch(() => {});
}

// Worker sweep: catch SUCCESS invoicing transactions not yet recorded (e.g. card
// payments finalized inside checkout.js). Runs every minute from the worker.
async function reconcileInvoicingPayments() {
  const txns = await prisma.transaction.findMany({
    where: {
      status: 'SUCCESS',
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      OR: [
        { metadata: { path: ['source'], equals: 'invoice' } },
        { metadata: { path: ['source'], equals: 'qr' } },
      ],
    },
    select: { id: true, reference: true, amount: true, status: true, channel: true, metadata: true },
    take: 500,
  });
  let recorded = 0;
  for (const t of txns) {
    try { const r = await recordForTransaction(t); if (r.recorded) recorded++; } catch { /* keep going */ }
  }
  return { scanned: txns.length, recorded };
}

module.exports = { recordForTransaction, reconcileInvoicingPayments };
