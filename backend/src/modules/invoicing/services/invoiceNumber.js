'use strict';
// Merchant-scoped, sequential, zero-padded invoice number, e.g. <MERCHANTCODE>-INV-000482.
// Globally unique because it carries the (unique) merchant code as a prefix.
const { prisma } = require('../../../utils/db');

async function nextInvoiceNumber(merchantId, merchantCode) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO inv_invoice_counters (merchant_id, last_seq)
       VALUES ($1::uuid, 1)
     ON CONFLICT (merchant_id)
       DO UPDATE SET last_seq = inv_invoice_counters.last_seq + 1
     RETURNING last_seq::text AS seq`,
    merchantId
  );
  const seq = parseInt(rows[0].seq, 10);
  const prefix = (merchantCode || 'PYL').toUpperCase();
  return `${prefix}-INV-${String(seq).padStart(6, '0')}`;
}

module.exports = { nextInvoiceNumber };
