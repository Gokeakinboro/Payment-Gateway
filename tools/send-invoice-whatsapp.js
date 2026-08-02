'use strict';
// Sends WhatsApp for the already-created invoice (by ID or invoice_number).
// Run: node tools/send-invoice-whatsapp.js <invoice_id>
const path = require('path');
const BACKEND_ROOT = path.join(__dirname, '..');
process.chdir(BACKEND_ROOT);
require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

const { PrismaClient } = require('@prisma/client');
const whatsapp = require(path.join(BACKEND_ROOT, 'src/services/whatsappService'));
const prisma = new PrismaClient();

const INVOICE_ID = process.argv[2] || '1c7aa451-4864-4316-8cc9-d9f59fba132c';
const CHECKOUT_BASE = process.env.CHECKOUT_BASE || 'https://paylodeservices.com';
const PHONES_TO_NOTIFY = [
  '+447940784656',  // akinboroo (from DrinksArena address book)
  // user's admin phone will be added below if found
];
const CC_EMAIL = 'gokeakinboro@gmail.com';

async function main() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT i.id::text, i.invoice_number, i.total_amount::text, i.currency, i.access_token,
            i.merchant_id::text, m.business_name, i.recipient_name
       FROM inv_invoices i
       JOIN merchants m ON m.id = i.merchant_id
      WHERE i.id = $1::uuid`, INVOICE_ID
  );
  if (!rows.length) { console.error('Invoice not found:', INVOICE_ID); process.exit(1); }
  const inv = rows[0];
  const payUrl = `${CHECKOUT_BASE}/invoice.html?t=${inv.access_token}`;

  console.log(`Invoice: ${inv.invoice_number} — ${inv.currency} ${Number(inv.total_amount)/100}`);
  console.log(`Pay URL: ${payUrl}`);

  // Find admin's phone from merchants table (gokeakinboro@gmail.com's merchant)
  const adminRows = await prisma.$queryRawUnsafe(
    `SELECT m.business_phone FROM merchants m JOIN users u ON u.id = m.user_id WHERE LOWER(u.email) = $1 LIMIT 1`,
    CC_EMAIL.toLowerCase()
  );
  const adminPhone = adminRows[0]?.business_phone;
  if (adminPhone) { PHONES_TO_NOTIFY.push(adminPhone); console.log(`Admin phone found: ${adminPhone}`); }

  const waParams = {
    recipientName: inv.recipient_name || 'Akin',
    businessName: inv.business_name,
    invoiceNumber: inv.invoice_number,
    amount: BigInt(inv.total_amount),
    currency: inv.currency,
    payUrl,
    merchantId: inv.merchant_id,
  };

  for (const phone of PHONES_TO_NOTIFY) {
    console.log(`\nSending WhatsApp to ${phone}...`);
    const r = await whatsapp.notifyInvoice({ phone, ...waParams });
    console.log('Result:', JSON.stringify(r));
  }

  console.log('\nDone.');
}

main()
  .catch(e => { console.error(e.message || e); process.exit(1); })
  .finally(() => prisma.$disconnect());
