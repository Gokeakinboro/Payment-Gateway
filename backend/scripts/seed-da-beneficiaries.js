'use strict';
// Seed DrinksArena's beneficiary address book + run NE for each account.
// Run in /opt/paylode-api/backend: node scripts/seed-da-beneficiaries.js
// Requires merchant_beneficiaries table (apply migration first).
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const svc = require('./src/modules/gateway-core/services/parallexTransferService');

const DA_ID = '2f6ff892-eefe-4542-b4df-1381e8156e5e';

// 22 accounts (Dayo Onasanya OPay 8055057055 permanently excluded)
const ACCOUNTS = [
  { name: 'Sulaimon Olagoke Akinboro', bank_code: '328', bank_name: 'OPay',          account: '7030000266' },
  { name: 'Akinboro May Onikepo',      bank_code: '328', bank_name: 'OPay',          account: '8096383806' },
  { name: 'Akinboro May Onikepo',      bank_code: '044', bank_name: 'Access Bank',   account: '0727733492' },
  { name: 'Akinboro May Onikepo',      bank_code: '058', bank_name: 'GTBank',        account: '0014052036' },
  { name: 'Akinboro May Onikepo',      bank_code: '033', bank_name: 'UBA',           account: '2121296841' },
  { name: 'Akinboro May Onikepo',      bank_code: '214', bank_name: 'FCMB',          account: '2822947012' },
  { name: 'Akinboro May Onikepo',      bank_code: '011', bank_name: 'First Bank',    account: '3139714121' },
  { name: 'Akinboro May Onikepo',      bank_code: '335', bank_name: 'Fairmoney',     account: '8564990879' },
  { name: 'Drinks Arena',              bank_code: '232', bank_name: 'Sterling Bank', account: '0146306252' },
  { name: 'Drinks Arena',              bank_code: '330', bank_name: 'Moniepoint',    account: '5391648698' },
  { name: 'Drinks Arena',              bank_code: '044', bank_name: 'Access Bank',   account: '0789730181' },
  { name: 'Drinks Arena',              bank_code: '011', bank_name: 'First Bank',    account: '2042302061' },
  { name: 'Drinks Arena',              bank_code: '035', bank_name: 'Wema Bank',     account: '0127583064' },
  { name: 'Drinks Arena',              bank_code: '057', bank_name: 'Zenith Bank',   account: '1016102375' },
  { name: 'Mobolaji Olamide Akinboro', bank_code: '057', bank_name: 'Zenith Bank',   account: '4297650010' },
  { name: 'Mobolaji Olamide Akinboro', bank_code: '035', bank_name: 'Wema Bank',     account: '0445847158' },
  { name: 'Mobolaji Olamide Akinboro', bank_code: '328', bank_name: 'OPay',          account: '8166527299' },
  { name: 'Akinboro Samuel Olatomide', bank_code: '328', bank_name: 'OPay',          account: '9024129891' },
  { name: 'Akinboro Samuel Olatomide', bank_code: '044', bank_name: 'Access Bank',   account: '0027912725' },
  { name: 'Paylode Services Ltd',      bank_code: '011', bank_name: 'First Bank',    account: '2042812850' },
  { name: 'Paylode Services Ltd',      bank_code: '070', bank_name: 'Fidelity Bank', account: '4011192900' },
  { name: 'Paylode Services Ltd',      bank_code: '221', bank_name: 'Stanbic IBTC',  account: '0022054754' },
];

async function main() {
  const p = new PrismaClient();
  try {
    console.log(`\nSeeding ${ACCOUNTS.length} accounts into DrinksArena's address book...\n`);
    for (const acc of ACCOUNTS) {
      await p.merchantBeneficiary.upsert({
        where: { merchantId_bankCode_accountNumber: { merchantId: DA_ID, bankCode: acc.bank_code, accountNumber: acc.account } },
        create: { merchantId: DA_ID, accountNumber: acc.account, bankCode: acc.bank_code, bankName: acc.bank_name, alias: acc.name, neStatus: 'pending' },
        update: { isActive: true, alias: acc.name, neStatus: 'pending', neCheckedAt: null, neFailureReason: null },
      });
    }
    console.log(`All ${ACCOUNTS.length} upserted.\n\nRunning NE (sequential to be safe)...\n`);

    let neOk = 0, neFail = 0;
    for (const acc of ACCOUNTS) {
      process.stdout.write(`  ${acc.bank_name.padEnd(14)} ${acc.account}  `);
      const ne = await svc.nameEnquiry(acc.bank_code, acc.account).catch(() => ({ ok: false, reason: 'threw' }));
      await p.merchantBeneficiary.update({
        where: { merchantId_bankCode_accountNumber: { merchantId: DA_ID, bankCode: acc.bank_code, accountNumber: acc.account } },
        data: {
          neStatus:        ne.ok && ne.sessionId ? 'verified' : 'failed',
          accountName:     ne.ok && ne.accountName ? ne.accountName : undefined,
          neCheckedAt:     new Date(),
          neFailureReason: ne.ok ? null : (ne.reason || 'Unknown'),
        },
      });
      if (ne.ok && ne.sessionId) { neOk++;   console.log(`✓  ${ne.accountName}`); }
      else                        { neFail++; console.log(`✗  ${ne.reason || 'failed'}`); }
    }

    console.log(`\nDone. Verified: ${neOk}, Failed: ${neFail}\n`);
    const summary = await p.merchantBeneficiary.groupBy({
      by: ['neStatus'], where: { merchantId: DA_ID, isActive: true }, _count: { id: true },
    });
    summary.forEach(s => console.log(`  ${s.neStatus}: ${s._count.id}`));
  } finally { await p.$disconnect(); }
}
main().catch(e => { console.error(e.message); process.exit(1); });
