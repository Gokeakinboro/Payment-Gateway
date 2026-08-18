'use strict';
require('dotenv').config({ path: '/opt/paylode-api/backend/.env' });
const nodemailer = require('/opt/paylode-api/backend/node_modules/nodemailer');
const { PrismaClient } = require('/opt/paylode-api/backend/node_modules/@prisma/client');
const crypto = require('crypto');
const p = new PrismaClient();

const DA_ID   = '7548c579-a281-49cf-9ea5-b5ec87fe3f28';
const TO      = 'gokeakinboro@gmail.com';

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: parseInt(process.env.SMTP_PORT) === 465,
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

(async () => {
  const ref = 'TXN-DA-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  await p.transaction.create({
    data: {
      merchantId:    DA_ID,
      reference:     ref,
      amount:        BigInt(50000),
      currency:      'NGN',
      channel:       'CARD',
      status:        'PENDING',
      customerEmail: TO,
      isSandbox:     false,
      metadata:      { description: 'Drinks Arena card test' },
    },
  });
  await p.$disconnect();

  const url = 'https://paylodeservices.com/checkout.html?ref=' + ref +
    '&merchant=Drinks%20Arena&amount=50000&desc=Card%20Test&email=' + encodeURIComponent(TO);

  console.log('Ref:', ref);
  console.log('URL:', url);

  await transporter.sendMail({
    from:    '"Drinks Arena via Paylode" <' + (process.env.EMAIL_FROM || 'product@paylodeservices.com') + '>',
    to:      TO,
    subject: 'Drinks Arena — Pay ₦500.00 (fresh link)',
    html: '<div style="font-family:Arial,sans-serif;max-width:560px">' +
      '<div style="background:#1a2744;padding:20px 28px;border-radius:10px 10px 0 0">' +
      '<p style="color:#fff;font-size:16px;font-weight:bold;margin:0">Drinks Arena</p></div>' +
      '<div style="padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">' +
      '<p style="font-size:14px;color:#475569">Payment request:</p>' +
      '<div style="font-size:32px;font-weight:700;color:#1a2744;margin:12px 0">₦500.00</div>' +
      '<p style="font-size:13px;color:#64748b">Ref: ' + ref + '</p>' +
      '<a href="' + url + '" style="display:inline-block;background:#1a2744;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;margin-top:16px">Pay Now</a>' +
      '<p style="font-size:11px;color:#94a3b8;margin-top:20px">Powered by Paylode · CBN Licensed PSSP</p>' +
      '</div></div>',
  });

  console.log('Email sent to', TO);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
