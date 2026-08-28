'use strict';
// Create DrinksArena pipeline test batch — same accounts as previous run,
// amounts ₦20.01–₦20.10 per account (kobo 2001–2010), 10 items per account.
// Scheduled for 10:00 WAT = 09:00 UTC on 2026-08-29.
// Pulls account list from DA's payout history to avoid hardcoding PII.
// Run in /opt/paylode-api/backend: node scripts/create-da-batch2.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const DA_ID            = '2f6ff892-eefe-4542-b4df-1381e8156e5e';
const SCHEDULED_AT     = new Date('2026-08-29T09:00:00.000Z'); // 10:00 WAT
const EXCLUDED_ACCOUNT = '8055057055'; // permanently excluded per merchant instruction
const AMOUNTS          = [2001n, 2002n, 2003n, 2004n, 2005n, 2006n, 2007n, 2008n, 2009n, 2010n]; // kobo

async function main() {
  const p = new PrismaClient();
  try {
    // Pull unique accounts from DA payout history.
    const accounts = await p.$queryRaw`
      SELECT DISTINCT account_number, bank_code, bank_name, account_name
      FROM payout_items
      WHERE merchant_id = ${DA_ID}::uuid
        AND account_number != ${EXCLUDED_ACCOUNT}
      ORDER BY bank_code, account_number`;

    if (!accounts.length) { console.log('No payout history found — seed beneficiaries first.'); return; }

    const rail = await p.paymentRail.findFirst({ where: { name: { contains: 'Parallex', mode: 'insensitive' } } });
    if (!rail) throw new Error('Parallex rail not found');

    const rateRow = await p.platformRateConfig.findFirst({ where: { channel: { in: ['PAYOUT', 'ALL'] } }, orderBy: { channel: 'desc' } });
    const feeRate = rateRow ? Number(rateRow.rate) : 0.01;
    const VAT = 0.075;

    const items = [];
    for (const acc of accounts) {
      for (let i = 0; i < 10; i++) {
        items.push({ account_number: acc.account_number, account_name: acc.account_name, bank_code: acc.bank_code, bank_name: acc.bank_name, amount: AMOUNTS[i] });
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
    console.log(`  Accounts: ${accounts.length}, Items: ${items.length}`);
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
        VALUES (${DA_ID}::uuid, ${batchRef}, ${'Pipeline test 2 — ' + accounts.length + ' accounts × 10 items (₦20.01–₦20.10), NE pipelined'}, ${totalAmount}, ${totalFee}, ${totalVat}, ${feeRate}::decimal, ${items.length}, 'needs_routing', ${rail.id}::uuid, ${SCHEDULED_AT}, ${DA_ID}::uuid, NOW(), NOW())
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
        VALUES (${DA_ID}::uuid, ${rail.id}::uuid, 'DEBIT', ${totalAmount}, ${pooled},     ${afterBenef}, ${batchRef}, ${'Payout via Parallex Bank: pipeline test 2'}, ${DA_ID}::uuid, NOW()),
               (${DA_ID}::uuid, ${rail.id}::uuid, 'FEE',   ${totalFee},   ${afterBenef}, ${afterFee},   ${batchRef}, ${'Paylode payout service fee'},                ${DA_ID}::uuid, NOW()),
               (${DA_ID}::uuid, ${rail.id}::uuid, 'VAT',   ${totalVat},   ${afterFee},   ${afterAll},   ${batchRef}, ${'VAT on payout fee (7.5%)'},                   ${DA_ID}::uuid, NOW())`;

      const bankRows = await tx.$queryRaw`SELECT bank_code, bank_name FROM nigerian_banks`;
      const bankMap  = Object.fromEntries(bankRows.map(b => [b.bank_code, b.bank_name]));
      for (const it of itemsWithFees) {
        await tx.$executeRaw`
          INSERT INTO payout_items (batch_id, merchant_id, account_number, account_name, bank_code, bank_name, amount, item_fee, item_vat, narration, status, rail_id, scheduled_at, created_at)
          VALUES (${batchId}::uuid, ${DA_ID}::uuid, ${it.account_number}, ${it.account_name}, ${it.bank_code}, ${bankMap[it.bank_code]||it.bank_name}, ${it.amount}, ${it.fee}, ${it.vat}, ${'Paylode payout'}, 'queued', ${rail.id}::uuid, ${SCHEDULED_AT}, NOW())`;
      }

      console.log(`  Batch ID: ${batchId}`);
      console.log(`  Ref:      ${batchRef}`);
      console.log(`  ${items.length} items inserted — auto-dispatches at 10:00 WAT tomorrow\n`);
    }, { timeout: 60000 });
  } finally { await p.$disconnect(); }
}
main().catch(e => { console.error(e.message); process.exit(1); });
