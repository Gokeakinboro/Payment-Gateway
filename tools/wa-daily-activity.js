'use strict';
/**
 * WhatsApp daily activity pinger — builds messaging volume for OBA eligibility.
 * Run with slot number 1–5 via cron (5×/day for 3 weeks).
 *
 * Usage: node tools/wa-daily-activity.js <slot>   (slot = 1..5)
 * Cron entries (server time = UTC+1 WAT):
 *   0 7 * * * cd /opt/paylode-api/backend && node tools/wa-daily-activity.js 1
 *   0 9 * * * cd /opt/paylode-api/backend && node tools/wa-daily-activity.js 2
 *   0 11 * * * cd /opt/paylode-api/backend && node tools/wa-daily-activity.js 3
 *   0 13 * * * cd /opt/paylode-api/backend && node tools/wa-daily-activity.js 4
 *   0 15 * * * cd /opt/paylode-api/backend && node tools/wa-daily-activity.js 5
 *
 * Expires automatically after EXPIRE_DATE.
 */

const path = require('path');
const BACKEND_ROOT = path.join(__dirname, '..');
process.chdir(BACKEND_ROOT);
require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

const EXPIRE_DATE = new Date('2026-09-01T00:00:00+01:00'); // 3 weeks from 10 Aug

const TARGETS = [
  { name: 'Goke', phone: '+2348099918000' },
  { name: 'Goke', phone: '+2347030000266' },
];

const PAY_BASE = 'https://paylodeservices.com/pay';

const whatsapp = require(path.join(BACKEND_ROOT, 'src/services/whatsappService'));

const slot = parseInt(process.argv[2] || '1', 10);
const today = new Date();
const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
const ref = `PLY-${today.toISOString().slice(0, 10).replace(/-/g, '')}-${slot}`;

if (today >= EXPIRE_DATE) {
  console.log('Activity campaign expired. Remove these cron entries.');
  process.exit(0);
}

async function send(target) {
  const { name, phone } = target;
  const url = `${PAY_BASE}/${ref.toLowerCase()}`;
  const biz  = 'Paylode Services';
  const amtKobo = (500 + (dayOfYear % 50) * 100) * slot; // varies daily

  switch (slot) {
    case 1:
      return whatsapp.notifyInvoice({
        phone, recipientName: name, businessName: biz,
        invoiceNumber: ref, amount: amtKobo, currency: 'NGN', payUrl: url,
      });
    case 2:
      return whatsapp.notifyPaymentLink({
        phone, businessName: biz,
        title: `Payment Request ${ref}`,
        amount: amtKobo, currency: 'NGN', payUrl: url,
      });
    case 3:
      return whatsapp.notifyReceipt({
        phone, recipientName: name, businessName: biz,
        invoiceNumber: ref, amount: amtKobo, currency: 'NGN',
      });
    case 4:
      return whatsapp.notifyQr({
        phone, businessName: biz, label: `Scan to pay — ${ref}`, payUrl: url,
      });
    case 5:
      // Checkout receipt: customer_name, amount_paid, business_name
      return whatsapp.sendTemplate(phone,
        process.env.WHATSAPP_TEMPLATE_CHECKOUT_RECEIPT,
        process.env.WHATSAPP_TEMPLATE_CHECKOUT_RECEIPT_LANG || 'en', [
          { name: 'customer_name', value: name },
          { name: 'amount_paid',   value: `NGN ${(amtKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}` },
          { name: 'business_name', value: biz },
        ]);
    default:
      console.error(`Unknown slot: ${slot}`);
      process.exit(1);
  }
}

async function main() {
  console.log(`[wa-daily-activity] ${today.toISOString()} slot=${slot} ref=${ref}`);
  for (const target of TARGETS) {
    try {
      const r = await send(target);
      console.log(`  → ${target.name} (${target.phone}): ${r?.ok ? 'sent ✓' : r?.skipped ? 'skipped' : 'failed'}`);
    } catch (e) {
      console.error(`  → ${target.name}: ERROR ${e.message}`);
    }
  }
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
