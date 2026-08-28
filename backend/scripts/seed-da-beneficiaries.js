'use strict';
// Seed DrinksArena's beneficiary address book from the previous test batch.
// Pulls unique (account_number, bank_code, account_name, bank_name) from the
// existing payout history for DA, excluding the permanently excluded account.
// Run in /opt/paylode-api/backend: node scripts/seed-da-beneficiaries.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const svc = require('./src/modules/gateway-core/services/parallexTransferService');

const DA_ID           = '2f6ff892-eefe-4542-b4df-1381e8156e5e';
const EXCLUDED_ACCOUNT = '8055057055'; // permanently excluded per merchant instruction

async function main() {
  const p = new PrismaClient();
  try {
    // Pull unique accounts from DA payout history (any batch).
    const rows = await p.$queryRaw`
      SELECT DISTINCT account_number, bank_code, bank_name, account_name
      FROM payout_items
      WHERE merchant_id = ${DA_ID}::uuid
        AND account_number != ${EXCLUDED_ACCOUNT}
      ORDER BY bank_code, account_number`;

    if (!rows.length) { console.log('No payout history found for DrinksArena.'); return; }
    console.log(`\nFound ${rows.length} unique accounts in DA payout history.\n`);

    for (const acc of rows) {
      await p.merchantBeneficiary.upsert({
        where: { merchantId_bankCode_accountNumber: { merchantId: DA_ID, bankCode: acc.bank_code, accountNumber: acc.account_number } },
        create: { merchantId: DA_ID, accountNumber: acc.account_number, bankCode: acc.bank_code, bankName: acc.bank_name || null, alias: acc.account_name || null, neStatus: 'pending' },
        update: { isActive: true, neStatus: 'pending', neCheckedAt: null, neFailureReason: null },
      });
    }
    console.log(`Seeded ${rows.length} accounts. Running NE...\n`);

    let neOk = 0, neFail = 0;
    for (const acc of rows) {
      process.stdout.write(`  ${(acc.bank_name||acc.bank_code).padEnd(14)} ${acc.account_number}  `);
      const ne = await svc.nameEnquiry(acc.bank_code, acc.account_number).catch(() => ({ ok: false, reason: 'threw' }));
      await p.merchantBeneficiary.update({
        where: { merchantId_bankCode_accountNumber: { merchantId: DA_ID, bankCode: acc.bank_code, accountNumber: acc.account_number } },
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
  } finally { await p.$disconnect(); }
}
main().catch(e => { console.error(e.message); process.exit(1); });
