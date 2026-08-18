'use strict';
require('dotenv').config({ path: '/opt/paylode-api/backend/.env' });
const https      = require('https');
const nodemailer = require('/opt/paylode-api/backend/node_modules/nodemailer');

// Drinks Arena merchant — use their test API key to create a payment link / invoice
// We'll create it directly via internal API call and email the checkout URL

const DA_MERCHANT_ID = '7548c579-a281-49cf-9ea5-b5ec87fe3f28';
const BASE_URL       = 'https://api.paylodeservices.com';
const TO_EMAIL       = 'gokeakinboro@gmail.com';

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: parseInt(process.env.SMTP_PORT) === 465,
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

function apiPost(path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(path, BASE_URL);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: { _raw: d } }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  // Get the live API key for Drinks Arena from DB
  const { PrismaClient } = require('/opt/paylode-api/backend/node_modules/@prisma/client');
  const prisma = new PrismaClient();

  // Find a live (non-sandbox) API key for Drinks Arena
  const apiKeyRecord = await prisma.apiKey.findFirst({
    where: { merchantId: DA_MERCHANT_ID, isSandbox: false, keyPrefix: 'sk_live' },
    select: { id: true, keyPrefix: true },
  });

  await prisma.$disconnect();

  if (!apiKeyRecord) {
    console.error('No live API key found for Drinks Arena');
    process.exit(1);
  }

  console.log('Found Drinks Arena API key prefix:', apiKeyRecord.keyPrefix);

  // We can't recover the plaintext API key from the hash.
  // Instead, create the transaction directly in DB and generate the checkout URL.
  const prisma2 = new PrismaClient();
  const crypto = require('crypto');

  const ref = 'TXN-DA-INV-' + Date.now();
  const txn = await prisma2.transaction.create({
    data: {
      merchantId:    DA_MERCHANT_ID,
      reference:     ref,
      amount:        BigInt(50000), // NGN 500.00 in kobo
      currency:      'NGN',
      channel:       'CARD',
      status:        'PENDING',
      customerEmail: TO_EMAIL,
      isSandbox:     false,
      metadata: {
        description: 'Drinks Arena — Card Payment Test',
        created_via: 'gen-da-invoice script',
      },
    },
  });

  await prisma2.$disconnect();

  const checkoutUrl = 'https://paylodeservices.com/checkout.html?ref=' + ref +
    '&merchant=Drinks%20Arena&amount=50000&desc=Card%20Payment%20Test&email=' + encodeURIComponent(TO_EMAIL);

  console.log('Created transaction:', ref);
  console.log('Checkout URL:', checkoutUrl);

  // Email it
  await transporter.sendMail({
    from:    '"Drinks Arena via Paylode" <' + (process.env.EMAIL_FROM || 'product@paylodeservices.com') + '>',
    to:      TO_EMAIL,
    subject: 'Drinks Arena — Pay ₦500.00',
    html: [
      '<div style="font-family:Arial,sans-serif;max-width:560px;color:#1e293b">',
      '<div style="background:#1a2744;padding:20px 28px;border-radius:10px 10px 0 0">',
      '<p style="color:#fff;font-size:16px;font-weight:bold;margin:0">Drinks Arena</p>',
      '<p style="color:rgba(255,255,255,.6);font-size:12px;margin:4px 0 0">Payment Request — ₦500.00</p>',
      '</div>',
      '<div style="padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">',
      '<p style="font-size:14px;color:#475569">You have a payment request for:</p>',
      '<div style="font-size:32px;font-weight:700;color:#1a2744;margin:12px 0">₦500.00</div>',
      '<p style="font-size:13px;color:#64748b">Card Payment Test · Ref: ' + ref + '</p>',
      '<a href="' + checkoutUrl + '" style="display:inline-block;background:#1a2744;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;margin-top:16px">Pay Now</a>',
      '<p style="font-size:11px;color:#94a3b8;margin-top:20px">Powered by Paylode · CBN Licensed PSSP</p>',
      '</div></div>',
    ].join(''),
  });

  console.log('Invoice email sent to', TO_EMAIL);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
