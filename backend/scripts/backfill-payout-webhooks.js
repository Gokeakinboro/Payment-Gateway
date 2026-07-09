'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  ONE-OFF backfill — re-emit `payout.success` for payout items that settled
//  successfully BEFORE the payout-webhook feature existed (deployed 2026-07-09),
//  so merchants (e.g. Bucksnostar) get the notification they never received.
//
//  • Per ITEM/leg (webhooks are per beneficiary), same payload as the live path.
//  • IDEMPOTENT: skips any (reference, account_number) that already has a
//    `payout.success` delivery recorded → safe to re-run.
//  • Only ENQUEUES (via the normal webhook queue); the webhook worker delivers,
//    HMAC-signed, with the usual 3-attempt retry. Skips merchants with no webhook URL.
//
//  Run ON 176 (needs prod DB + Redis):
//    node scripts/backfill-payout-webhooks.js --dry-run          # preview first
//    node scripts/backfill-payout-webhooks.js --days=7           # then for real
//    node scripts/backfill-payout-webhooks.js --merchant=<uuid>  # scope to one merchant
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { prisma } = require('../src/utils/db');
const { dispatchWebhook, webhookQueue } = require('../src/services/webhookService');

const arg = (name, def) => {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : def;
};
const DRY      = process.argv.includes('--dry-run');
const DAYS     = Number(arg('days', 7));
const LIMIT    = Number(arg('limit', 2000));
const MERCHANT = arg('merchant', null);

// Same payload shape as payoutSettle.firePayoutWebhook — keep in lock-step.
function payoutPayload(leg) {
  return {
    reference:      leg.batch_ref,
    status:         'SUCCESS',
    amount:         Number(leg.amount),
    account_number: leg.account_number,
    account_name:   leg.account_name || null,
    bank_code:      leg.bank_code,
    bank_name:      leg.bank_name || null,
    narration:      leg.narration || null,
    provider_ref:   leg.rail_order_no || null,
    session_id:     leg.rail_session_id || null,
  };
}

async function main() {
  console.log(`[backfill] payout.success — window=${DAYS}d limit=${LIMIT}${MERCHANT ? ` merchant=${MERCHANT}` : ''}${DRY ? ' (DRY-RUN)' : ''}`);

  // Successfully-settled payout legs in the window.
  const legs = await prisma.$queryRaw`
    SELECT rd.merchant_id, rd.amount, rd.rail_order_no, rd.rail_session_id,
           pi.account_number, pi.account_name, pi.bank_code, pi.bank_name, pi.narration,
           pb.batch_ref
    FROM rail_disbursements rd
    JOIN payout_items pi ON rd.payout_item_id = pi.id
    JOIN payout_batches pb ON rd.batch_id = pb.id
    WHERE rd.status = 'success'
      AND rd.settled_at >= NOW() - make_interval(days => ${DAYS})
    ORDER BY rd.settled_at ASC
    LIMIT ${LIMIT}`;

  // Already-emitted (reference|account_number) → skip so re-runs never duplicate.
  const sent = new Set(
    (await prisma.$queryRaw`
      SELECT DISTINCT payload->>'reference' AS reference, payload->>'account_number' AS account_number
      FROM webhook_deliveries WHERE event = 'payout.success'`)
      .map(r => `${r.reference}|${r.account_number}`)
  );

  let emitted = 0, skippedSent = 0, skippedMerchant = 0;
  for (const leg of legs) {
    if (MERCHANT && leg.merchant_id !== MERCHANT) { skippedMerchant++; continue; }
    if (sent.has(`${leg.batch_ref}|${leg.account_number}`)) { skippedSent++; continue; }
    console.log(`  ${DRY ? 'would emit' : 'emit'} payout.success  ${leg.batch_ref}  ₦${(Number(leg.amount) / 100).toLocaleString('en-NG')}  → ${leg.account_number}`);
    if (!DRY) await dispatchWebhook(leg.merchant_id, 'payout.success', payoutPayload(leg));  // no-ops if merchant has no webhook URL
    emitted++;
  }

  console.log(`[backfill] done — candidates=${legs.length} ${DRY ? 'would-emit' : 'emitted'}=${emitted} skipped(already-sent)=${skippedSent}${MERCHANT ? ` skipped(other-merchant)=${skippedMerchant}` : ''}`);
}

main()
  .catch(e => { console.error('[backfill] FAILED:', e); process.exitCode = 1; })
  .finally(async () => {
    await webhookQueue.close().catch(() => {});   // flush enqueued jobs, then release Redis
    await prisma.$disconnect().catch(() => {});
    process.exit(process.exitCode || 0);
  });
