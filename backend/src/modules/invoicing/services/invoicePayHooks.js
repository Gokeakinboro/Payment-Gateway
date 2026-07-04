'use strict';
/**
 * Invoicing hooks so another domain can record a payment against an Invoice&Collect
 * invoice WITHOUT touching inv_* tables directly. Used by the wallet's
 * pay-invoice-from-wallet flow (wallet/services/walletInvoice.js), which passes its
 * own $transaction `tx` so the invoice write stays atomic with the wallet debit.
 * Keeps inv_* ownership inside invoicing (see docs/DATA-OWNERSHIP.md, P2).
 */

// Lock the invoice row FOR UPDATE and return it (caller validates + decides amount).
async function lockInvoiceForUpdate(tx, { invoiceId, merchantId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text, department_id::text AS department_id, invoice_number,
            total_amount::text AS total_amount, amount_paid::text AS amount_paid, status, allow_part_payment
       FROM inv_invoices WHERE id = $1::uuid AND merchant_id = $2::uuid FOR UPDATE`, invoiceId, merchantId);
  return rows[0] || null;
}

// Record a payment on the invoice + roll up its status. Atomic within caller's tx.
async function applyInvoicePayment(tx, { invoiceId, amount, reference, channel }) {
  await tx.$executeRawUnsafe(
    `INSERT INTO inv_invoice_payments (invoice_id, amount_paid, payment_reference, channel)
     VALUES ($1::uuid, $2, $3, $4)`, invoiceId, amount, reference, channel);
  await tx.$executeRawUnsafe(
    `UPDATE inv_invoices i SET amount_paid = sub.paid,
        status = CASE WHEN sub.paid >= i.total_amount THEN 'paid' ELSE 'part_paid' END,
        paid_at = CASE WHEN sub.paid >= i.total_amount THEN now() ELSE i.paid_at END, updated_at = now()
      FROM (SELECT COALESCE(SUM(amount_paid),0) AS paid FROM inv_invoice_payments WHERE invoice_id = $1::uuid) sub
     WHERE i.id = $1::uuid`, invoiceId);
}

module.exports = { lockInvoiceForUpdate, applyInvoicePayment };
