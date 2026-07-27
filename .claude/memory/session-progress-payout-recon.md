---
name: session-progress-payout-recon
description: "Paylode session record (2026-06-20) — COMPLETE. Payout reconciliation sequence (VAT-card-netting, webhook recon, rail-failure, queryPayoutResult, stuck-sent poller) + checkout fine-tuning (card rail un-hardcode, VA name/title, optional email modal). All deployed; server==repo; smoke+drift clean. Commit manifest at top."
metadata: 
  node_type: memory
  type: project
  originSessionId: af42272b-46fa-4a50-9f39-fc833ed70fc6
---

# Paylode session — 2026-06-20 — ✅ COMPLETE & SAVED

## COMMIT MANIFEST (all pushed to origin/main; deployed; server==repo verified, smoke+drift clean)
- `b36db8a` — destination-tiered payouts: PRICE ₦20 other/₦10 on-us (PAYOUT_ONUS), COST ₦12/₦5 (payout_flat_cost_onus); routing per-item by dest bank (on-us=PalmPay 100033).
- `b2dd2ad` — ₦11.07 checkout fix: no fabricated amounts; result screen shows real settled amount.
- `17de0ff` — card-path VAT netting explicit (feeEngine vatOnRail/netVat).
- `ae3135e` — PalmPay payout webhook = authoritative settle + refund on failure (guarded in-flight only).
- `ae9bc12` — rail-failure handling wired (recordRailResult in disburse + low-balance alert in float poll).
- `4aaa875` + `cf68431` — queryPayoutResult: env-configurable + CORRECT path `/api/v2/merchant/payment/queryPayStatus` (live-verified, orderStatus 2).
- `de7da36` — stuck-'sent' poller + shared `services/payoutSettle.js` (webhook delegates; reconcile every 3 min worker 0).
- `da862ac` — card rail UN-HARDCODED (`services/cardRouter.js`); VA order title = merchant name.
- `82c7f86` — payment-link email OPTIONAL (fillable/skippable, prefill ?email=).
- `b3df3ab` — VA account name "Paylode Services Limited (Collected on behalf of <Merchant>)".
- `eaeedda` — payment-link email modal shows instantly (no payment-fields flash) + explicit Skip button.
NEW backend files (NOT in deploy.py MANIFEST — deployed via paramiko; minor TODO add them): `payoutSettle.js`, `cardRouter.js`.

## OPEN (carried forward)
- 🟡 KIV [[kiv-accounting-software-integration]] — pick provider + OAuth creds.
- Per-merchant rail: not needed (user); add rail col to merchant_rate_configs only if ever wanted.
- Optional: email prompt on `?ref`/API checkouts when txn has no email (offered, not requested).
- Minor: add payoutSettle.js + cardRouter.js to deploy.py MANIFEST.

# Session checkpoint — 2026-06-20 (4-item sequence, user-ordered) — ✅ COMPLETE

## LATER 2026-06-20 adds (commits `de7da36`, `da862ac`, deployed 176, health 200, 6/6):
- **Stuck-'sent' POLLER + shared settle** (`de7da36`) — see #4 detail below; `services/payoutSettle.js` is the shared settle source; webhook delegates; `reconcileSentPayouts` every 3 min on worker 0.
- **Card rail UN-HARDCODED** (`da862ac`) — NEW `services/cardRouter.js` `resolveCardProcessor(prisma, product)` picks the card processor from the CARD product's `default_rail_id` (Merchant Pricing), defaults to Interswitch; checkout.js charge+OTP use the resolved adapter + real processor name; configured rail w/ no adapter → NO_CARD_PROCESSOR (clean). Adapter contract = initializePurchase/submitOtp/verifyTransaction. Add MPGS = adapter + register in cardRouter ADAPTERS + set CARD default rail.
- **VA order title = merchant.businessName** (`da862ac`) — dynamic VA mint (checkout.js) now titles the PalmPay order with the merchant's name (was 'Payment'), sliced to 80.
- **Per-merchant rail: NOT building** (user 2026-06-20 "we need not per-merchant rail especially for payouts") — payouts stay SA-routed; merchant_rate_configs has fees only, no rail field.
- **Payment-link email now OPTIONAL** (`82c7f86`, deployed 45+176, health 200) — checkout overlay email is fillable + skippable; prefilled from `?email=` URL param; backend paymentLinks.js public mint accepts blank email. Checkout shows the real txn email or '—'.
- **VA account name = "Collected on behalf of <Merchant>"** (`b3df3ab`, deployed 176, live-verified) — `displayAccountName()` in checkout.js strips PalmPay's "(Pay NGN X)" tag and appends " (Collected on behalf of <merchant.businessName>)". Verified: "Paylode Services Limited (Collected on behalf of Drinks Arena)".
- **Payment-link email modal: instant + explicit Skip** (`eaeedda`, deployed 45+176, live-verified) — overlay is now appended IMMEDIATELY (loading state) before the fetch; added explicit "Skip — continue without email" button.

**END-OF-DAY STATE:** all 4 items done+deployed. Smoke test PASSED (176 health 200, pm2 6/6, webhook-worker up, redis PONG, db ok, canaries 401/404, 45 public 200, no boot errors). DRIFT SCAN: server==repo==origin/main EVERYWHERE. Tiered payout data verified live (PRICE ₦20/₦10, COST ₦12/₦5).

User asked, in order: (1) VAT netting on card path → (2) PalmPay payout webhook reconciliation → (3) rail failure handling → (4) fix queryPayoutResult.

## ✅ #1 VAT netting on card path — DONE + DEPLOYED (commit `17de0ff`, pushed)
Found it was already netting end-to-end (report nets output−input); made it explicit. `feeEngine.computeFeesForTxn` now returns `vatOnRail` + `netVat` (=vatOnFee−vatOnRail); 5 checkout.js card sites + GET fees response use `fees.vatOnRail`.

## ✅ #2 PalmPay payout webhook reconciliation — DONE + DEPLOYED (commit `ae3135e`, pushed)
Disburse (payouts.js) no longer marks success on mere accept; maps `orderStatus` (2=settled / 1·0·absent=in-flight→leg `sent`+item `processing` / else=refund). handlePayout (palmpay-webhook.js) is now authoritative settle: on FAILURE of an in-flight leg it REFUNDS float+wallet, guarded `status IN ('pending','sent')` (idempotent, no double-refund/overturn). Shared `rollupBatch()`.

## ✅ #3 rail failure handling — DONE + DEPLOYED (commit `ae9bc12`, pushed)
railHealth.js foundation (recordRailResult / checkRailBalanceAndAlert) existed but was never called. Wired: disburse loop (payouts.js) calls `recordRailResult` per leg; float poller (railFloat.js syncAllFloats, 10-min) calls `checkRailBalanceAndAlert` with the just-synced balance. In-mem state per pm2 worker (acceptable, debounced).

## ✅ #4 fix queryPayoutResult — DONE + DEPLOYED + LIVE-VERIFIED (commits `4aaa875`, `cf68431`)
Path confirmed: **POST `/api/v2/merchant/payment/queryPayStatus`** (was `queryStatus`→OPEN_GW_000022). **LIVE-TESTED on 176 against a real settled payout order → code 00000000, ok:true, orderStatus:2.** **✅ POLLER WIRED 2026-06-20 (commit `de7da36`, deployed).** NEW `services/payoutSettle.js` = single source of truth. `reconcileSentPayouts({olderThanMs:120000})` polls legs stuck `status='sent'` past 2-min grace → queryPayoutResult → applyPayoutResult(source:'poller'). Scheduled every 3 min on pm2 worker 0.

## Deploy facts
176=DB+API (`/opt/paylode-api/backend`), 45=live web. SSH root/`Olatomide@1234@`. DB app user via DATABASE_URL in .env. Migrations run as app user. Frontend → BOTH 45+176.
