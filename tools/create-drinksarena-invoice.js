'use strict';
/**
 * One-shot script: enables international cards for DrinksArena,
 * then creates and sends a $1 USD test invoice to akinboroo@gmail.com
 * (CC gokeakinboro@gmail.com) with WhatsApp to both numbers.
 *
 * Run on server 176: node tools/create-drinksarena-invoice.js
 */

const path = require('path');
const BACKEND_ROOT = path.join(__dirname, '..');
process.chdir(BACKEND_ROOT);
require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

const { PrismaClient } = require('@prisma/client');
const { sendInvoice } = require(path.join(BACKEND_ROOT, 'src/modules/invoicing/services/invoiceSend'));
const { nextInvoiceNumber } = require(path.join(BACKEND_ROOT, 'src/modules/invoicing/services/invoiceNumber'));
const crypto = require('crypto');

const prisma = new PrismaClient();

const CC_EMAIL = 'gokeakinboro@gmail.com';
const RECIPIENT_EMAIL = 'akinboroo@gmail.com';
const DUE_IN_HOURS = 48; // 48-hour window

function randToken(len) {
  return crypto.randomBytes(Math.ceil(len * 3 / 4)).toString('base64url').slice(0, len);
}

async function main() {
  // 1. Find DrinksArena merchant
  const merchants = await prisma.merchant.findMany({
    where: { businessName: { contains: 'drink', mode: 'insensitive' } },
    select: { id: true, businessName: true, merchantCode: true, cardAcceptanceScope: true, isActive: true },
  });

  if (!merchants.length) {
    console.error('No DrinksArena merchant found. Searching all merchants...');
    const all = await prisma.merchant.findMany({ select: { id: true, businessName: true }, take: 20, orderBy: { createdAt: 'desc' } });
    console.log('Recent merchants:', all.map(m => `${m.businessName} (${m.id})`).join('\n'));
    process.exit(1);
  }

  // Pick the ACTIVE one — there are two "Drinks Arena" records; only one is live
  const da = merchants.find(m => m.isActive) || merchants.find(m => /drink.*arena/i.test(m.businessName)) || merchants[0];
  console.log(`Found merchant: ${da.businessName} (${da.id}) isActive=${da.isActive}`);
  console.log(`Current card scope: ${da.cardAcceptanceScope}`);

  // 2. Enable international cards
  if (da.cardAcceptanceScope !== 'international') {
    await prisma.merchant.update({
      where: { id: da.id },
      data: { cardAcceptanceScope: 'international' },
    });
    console.log('✅ International card acceptance enabled for DrinksArena');
  } else {
    console.log('ℹ️  International cards already enabled');
  }

  // 3. Look up akinboroo@gmail.com in DrinksArena's contacts for phone
  const contacts = await prisma.$queryRawUnsafe(
    `SELECT id::text, name, email, phone FROM inv_contacts
      WHERE merchant_id = $1::uuid AND LOWER(email) = $2
      LIMIT 1`,
    da.id, RECIPIENT_EMAIL.toLowerCase()
  );

  let recipientName = 'Akin';
  let recipientPhone = null;
  let contactId = null;

  if (contacts.length) {
    const c = contacts[0];
    recipientName = c.name || recipientName;
    recipientPhone = c.phone || null;
    contactId = c.id;
    console.log(`Found contact: ${recipientName} <${c.email}> phone=${c.phone || '(none)'}`);
  } else {
    console.log(`Contact not found by email. Searching all contacts for ${da.businessName}...`);
    const all = await prisma.$queryRawUnsafe(
      `SELECT id::text, name, email, phone FROM inv_contacts WHERE merchant_id = $1::uuid LIMIT 20`,
      da.id
    );
    console.log('Contacts:', all.map(c => `${c.name} <${c.email}> ${c.phone || ''}`).join('\n'));
    console.log('No matching contact found. Proceeding without phone/contact.');
  }

  // 4. Look up SA/admin phone for the CC WhatsApp (gokeakinboro@gmail.com)
  // User model has no phone column — look up via the merchant record linked to that email.
  const saUserRows = await prisma.$queryRawUnsafe(
    `SELECT m.business_phone FROM merchants m
       JOIN users u ON u.id = m.user_id
      WHERE LOWER(u.email) = $1 LIMIT 1`,
    CC_EMAIL.toLowerCase()
  );
  const ccPhone = '+2348099918000'; // logo propagation test — always send to this number
  console.log(`SA phone for WA CC: ${ccPhone}`);

  // 5. Get merchant code for invoice numbering
  const mcode = await prisma.$queryRawUnsafe(
    `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, da.id
  );
  const merchantCode = mcode[0]?.merchant_code || 'DA';

  // Cancel any prior test invoices for this recipient in any DrinksArena account
  await prisma.$executeRawUnsafe(
    `UPDATE inv_invoices SET status='cancelled', updated_at=now()
      WHERE merchant_id IN (
        SELECT id FROM merchants WHERE LOWER(business_name) LIKE '%drink%'
      )
      AND LOWER(recipient_email)=$1
      AND status IN ('draft','sent','viewed')
      AND currency='USD'
      AND amount=100`,
    RECIPIENT_EMAIL.toLowerCase()
  );
  console.log('Cancelled any prior open $1 USD test invoices for this recipient.');

  // 6. Create the invoice
  const number = await nextInvoiceNumber(da.id, merchantCode);
  const token = randToken(18);
  const dueAt = new Date(Date.now() + DUE_IN_HOURS * 60 * 60 * 1000);

  // $1 USD = 100 cents (system stores in smallest unit)
  const amount = 100n;
  const lineItems = JSON.stringify([{ name: 'Test Invoice', unit_amount: 100, quantity: 1, amount: 100 }]);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO inv_invoices
      (invoice_number, merchant_id, contact_id, recipient_name, recipient_email, recipient_phone,
       description, amount, charge_vat, vat_amount, total_amount, currency, allow_part_payment,
       status, due_at, access_token, line_items, apply_service_charge, service_charge_amount)
     VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)
     RETURNING id::text`,
    number, da.id, contactId, recipientName, RECIPIENT_EMAIL, recipientPhone,
    'Test Invoice — $1 USD', amount, false, 0n, amount, 'USD', false,
    'draft', dueAt, token, lineItems, false, 0n
  );

  const invoiceId = rows[0].id;
  console.log(`\n✅ Invoice created: ${number} (id: ${invoiceId})`);
  console.log(`   Recipient: ${recipientName} <${RECIPIENT_EMAIL}>`);
  console.log(`   Amount: $1.00 USD`);
  console.log(`   Due: ${dueAt.toISOString()}`);

  // 7. Send the invoice (email CC + WhatsApp CC)
  console.log('\nSending invoice...');
  const result = await sendInvoice(invoiceId, {
    cc: CC_EMAIL,
    ccPhone: ccPhone || null,
  });

  if (result.sent) {
    console.log(`✅ Email sent to ${result.email} (CC: ${CC_EMAIL})`);
    if (recipientPhone) console.log(`✅ WhatsApp sent to ${recipientPhone}`);
    if (ccPhone)        console.log(`✅ WhatsApp CC sent to ${ccPhone}`);
  } else {
    console.log(`⚠️  Email not sent: ${result.error}`);
  }

  console.log('\nDone.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
