'use strict';
// Create DrinksArena's pipeline test batch — 22 accounts × 10 items = 220 items.
// Amounts: ₦20.01–₦20.10 per account (kobo: 2001–2010).
// Scheduled for 10:00 WAT = 09:00 UTC on 2026-08-29.
// Run in /opt/paylode-api/backend: node scripts/create-da-batch2.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const DA_ID  = '2f6ff892-eefe-4542-b4df-1381e8156e5e';
const SCHEDULED_AT = new Date('2026-08-29T09:00:00.000Z'); // 10:00 WAT
const AMOUNTS = [2001n, 2002n, 2003n, 2004n, 2005n, 2006n, 2007n, 2008n, 2009n, 2010n]; // kobo

// All 22 accounts — pipeline handles NE at dispatch; failed NE legs refund automatically.
// Dayo Onasanya (OPay 8055057055) permanently excluded.
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
    const rail = await p.paymentRail.findFirst({ where: { name: { contains: 'Parallex', mode: 'insensitive' } } });
    if (!rail) throw new Error('Parallex rail not found');

    const rateRow = await p.platformRateConfig.findFirst({ where: { channel: { in: ['PAYOUT', 'ALL'] } }, orderBy: { channel: 'desc' } });
    const feeRate = rateRow ? Number(rateRow.rate) : 0.01;
    const VAT = 0.075;

    const items = [];
    for (const acc of ACCOUNTS) {
      for (let i = 0; i < 10; i++) {
        items.push({ account_number: acc.account, account_name: acc.name, bank_code: acc.bank_code, bank_name: acc.bank_name, amount: AMOUNTS[i] });
      }
    }

    const totalAmount = items.reduce((s, it) => s + it.amount, 0n);
    let totalFee = 0n, totalVat = 0n;
    const itemsWithFees = items.map(it => {
      const fee = BigInt(Math.round(Number(it.amount) * feeRate));
      const vat = BigInt(Math.round(Number(fee) * VAT));
      totalFee += fee; totalVat += vat;
      return { ...it, fee, vat };
    });
    const totalDeduction = totalAmount + totalFee + totalVat;

    console.log(`\n=== Pipeline Test Batch 2 ===`);
    console.log(`  Accounts: ${ACCOUNTS.length}, Items: ${items.length}`);
    console.log(`  Total: ₦${Number(totalAmount)/100} + fee ₦${Number(totalFee)/100} + VAT ₦${Number(totalVat)/100} = ₦${Number(totalDeduction)/100}`);
    console.log(`  Scheduled: ${SCHEDULED_AT.toISOString()} (10:00 WAT)\n`);

    await p.$transaction(async (tx) => {
      const walletRows = await tx.$queryRaw`SELECT id, balance FROM merchant_wallets WHERE merchant_id = ${DA_ID}::uuid AND balance > 0 ORDER BY balance DESC FOR UPDATE`;
      const pooled = walletRows.reduce((s, r) => s + BigInt(r.balance), 0n);
      console.log(`  Wallet balance: ₦${Number(pooled)/100}`);
      if (pooled < totalDeduction) throw new Error(`Insufficient balance: have ₦${Number(pooled)/100}, need ₦${Number(totalDeduction)/100}`);

      const batchRef = `DA-PIPE-TEST2-${Date.now()}`;
      const batchRows = await tx.$queryRaw`
        INSERT INTO payout_batches (merchant_id, batch_ref, description, total_amount, total_fee, total_vat, fee_rate, total_items, status, rail_id, scheduled_at, created_by, created_at, updated_at)
        VALUES (${DA_ID}::uuid, ${batchRef}, ${'Pipeline test 2 — 22 accounts × 10 items (₦20.01–₦20.10), NE pipelined'}, ${totalAmount}, ${totalFee}, ${totalVat}, ${feeRate}::decimal, ${items.length}, 'needs_routing', ${rail.id}::uuid, ${SCHEDULED_AT}, ${DA_ID}::uuid, NOW(), NOW())
        RETURNING id`;
      const batchId = batchRows[0].id;

      let rem = totalDeduction;
      for (const w of walletRows) {
        if (rem <= 0n) break;
        const take = BigInt(w.balance) < rem ? BigInt(w.balance) : rem;
        await tx.$executeRaw`UPDATE merchant_wallets SET balance = balance - ${take}, last_used_at = NOW(), updated_at = NOW() WHERE id = ${w.id}::uuid`;
        rem -= take;
      }

      const afterBenef = pooled - totalAmount;
      const afterFee   = afterBenef - totalFee;
      const afterAll   = afterFee - totalVat;
      await tx.$executeRaw`
        INSERT INTO wallet_ledger (merchant_id, rail_id, entry_type, amount, balance_before, balance_after, reference, description, created_by, created_at)
        VALUES (${DA_ID}::uuid, ${rail.id}::uuid, 'DEBIT', ${totalAmount}, ${pooled},      ${afterBenef}, ${batchRef}, ${'Payout via Parallex Bank: pipeline test 2'}, ${DA_ID}::uuid, NOW()),
               (${DA_ID}::uuid, ${rail.id}::uuid, 'FEE',   ${totalFee},   ${afterBenef},  ${afterFee},   ${batchRef}, ${'Paylode payout service fee'},                ${DA_ID}::uuid, NOW()),
               (${DA_ID}::uuid, ${rail.id}::uuid, 'VAT',   ${totalVat},   ${afterFee},    ${afterAll},   ${batchRef}, ${'VAT on payout fee (7.5%)'},                   ${DA_ID}::uuid, NOW())`;

      const bankRows = await tx.$queryRaw`SELECT bank_code, bank_name FROM nigerian_banks`;
      const bankMap  = Object.fromEntries(bankRows.map(b => [b.bank_code, b.bank_name]));
      for (const it of itemsWithFees) {
        await tx.$executeRaw`
          INSERT INTO payout_items (batch_id, merchant_id, account_number, account_name, bank_code, bank_name, amount, item_fee, item_vat, narration, status, rail_id, scheduled_at, created_at)
          VALUES (${batchId}::uuid, ${DA_ID}::uuid, ${it.account_number}, ${it.account_name}, ${it.bank_code}, ${bankMap[it.bank_code]||it.bank_name}, ${it.amount}, ${it.fee}, ${it.vat}, ${'Paylode payout'}, 'queued', ${rail.id}::uuid, ${SCHEDULED_AT}, NOW())`;
      }

      console.log(`  Batch ID: ${batchId}`);
      console.log(`  Ref:      ${batchRef}`);
      console.log(`  Status:   needs_routing — auto-dispatch at 10:00 WAT (${SCHEDULED_AT.toISOString()})\n`);
    }, { timeout: 60000 });
  } finally { await p.$disconnect(); }
}
main().catch(e => { console.error(e.message); process.exit(1); });
