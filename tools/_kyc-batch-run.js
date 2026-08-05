'use strict';
/**
 * Batch KYC run — fires kycOrchestrator on every merchant with an onboarding submission.
 * Run: node tools/_kyc-batch-run.js
 * Targets: all merchants (active + inactive) with a submission on file.
 * Skips submissions that already have KYC reports (to avoid re-running unnecessarily).
 * Pass --force to re-run even if reports exist.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const { runOnboardingChecks } = require('../backend/src/services/kycOrchestrator');

const FORCE = process.argv.includes('--force');
const DELAY_MS = 2000; // 2s between merchants to avoid rate-limiting

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Load all onboarding submissions (latest per merchant) that are not draft.
  const subs = await p.$queryRawUnsafe(`
    SELECT DISTINCT ON (merchant_id) reference, merchant_id::text, business_name, status, submitted_at
    FROM onboarding_submissions
    WHERE merchant_id IS NOT NULL AND status NOT IN ('draft')
    ORDER BY merchant_id, submitted_at DESC
  `);

  console.log(`Found ${subs.length} merchants with submissions`);

  let ran = 0, skipped = 0, failed = 0;

  for (const sub of subs) {
    if (!FORCE) {
      // Skip if already has KYC reports for this submission
      const existing = await p.kycVerificationReport.count({ where: { submissionRef: sub.reference } });
      if (existing > 0) {
        console.log(`  SKIP  ${sub.reference} (${sub.business_name}) — ${existing} reports already exist`);
        skipped++;
        continue;
      }
    }

    console.log(`  RUN   ${sub.reference} (${sub.business_name}) status=${sub.status}`);
    try {
      await runOnboardingChecks(sub.reference);
      console.log(`  DONE  ${sub.reference}`);
      ran++;
    } catch (e) {
      console.error(`  FAIL  ${sub.reference}: ${e.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\nBatch complete — ran: ${ran}, skipped: ${skipped}, failed: ${failed}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); }).finally(() => p.$disconnect());
