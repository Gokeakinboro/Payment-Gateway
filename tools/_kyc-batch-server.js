'use strict';
// Run on server 176 from /opt/paylode-api/backend/
// node _kyc-batch-server.js
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const { runOnboardingChecks } = require('./src/services/kycOrchestrator');

const FORCE   = process.argv.includes('--force');
const DELAY_MS = 2500;
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const subs = await p.$queryRawUnsafe(`
    SELECT DISTINCT ON (merchant_id)
      reference, merchant_id::text, business_name, status, submitted_at
    FROM onboarding_submissions
    WHERE merchant_id IS NOT NULL
      AND status NOT IN ('draft')
    ORDER BY merchant_id, submitted_at DESC
  `);

  console.log(`\nFound ${subs.length} merchant submissions to check\n`);

  let ran = 0, skipped = 0, failed = 0;

  for (const sub of subs) {
    if (!FORCE) {
      const existing = await p.kycVerificationReport.count({ where: { submissionRef: sub.reference } });
      if (existing > 0) {
        console.log(`  SKIP   ${sub.reference} — ${sub.business_name} (${existing} reports exist)`);
        skipped++;
        continue;
      }
    }

    console.log(`  RUN    ${sub.reference} — ${sub.business_name} [${sub.status}]`);
    try {
      await runOnboardingChecks(sub.reference);
      console.log(`  DONE   ${sub.reference}`);
      ran++;
    } catch (e) {
      console.error(`  FAIL   ${sub.reference}: ${e.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Batch complete — ran: ${ran}  skipped: ${skipped}  failed: ${failed}`);
  console.log(`Check kyc_verification_reports table and your inbox for reports.`);
}

main()
  .catch((e) => { console.error('Fatal:', e.message); process.exit(1); })
  .finally(() => p.$disconnect());
