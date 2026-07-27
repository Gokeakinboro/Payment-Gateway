---
name: project-parallex-integration
description: "🟢 Parallex VA LIVE for ONE test merchant (Demo/Test → Parallex) via per-merchant pay-in override; adapter+webhook deployed on 176; still scaffold webhook mode + no prod routing decision"
metadata: 
  node_type: memory
  type: project
  originSessionId: b3c41ab9-af9b-40a2-89db-9ff4775b47ce
---

**🟢 2026-07-12/13 SESSION — PARALLEX VA LIVE FOR DRINKS ARENA; PAYOUT BLOCKED ON NIP + BALANCE.**
- **PR #108 merged to main** (`fix/parallex-sandbox-bypass-and-transfer-service`): checkout.js sandbox bypass, `20260708_merchant_payin_rail.sql` migration, `parallexTransferService.js` Transfer adapter (dormant until env).
- **Drinks Arena** assigned Parallex Bank as `payin_rail_id` via direct DB UPDATE.
- **Webhook registered** with Parallex (`AddWebHookURL` → code 00, empty `webHookSecret` — scaffold mode).
- **VA e2e PASSED:** init txn `DA-TEST-1783842315` (₦5,000) → VA `6015200505` "Drinks Arena Payment" at Parallex Bank → simulated inflow webhook → txn `SUCCESS`, settlement ₦5,000 to Drinks Arena. ✅
- **Payout test BLOCKED:** NameEnquiry returns `X91 Failed` for ALL banks — NIP connectivity not working on Transfer subscription. Transfer balance `2001096025` = **₦0 via API** despite ₦500,000 ledger in bank portal. **Raise BOTH with Parallex:** (1) why NIP X91? (2) why ₦0 available vs ₦500k ledger? (3) confirm if VA settlement account ≠ payout debit account.

**🟢 2026-07-08 (later still) — PARALLEX TRANSFER *PAYOUT RAIL* BUILT IN REPO (code only, dormant).**
New adapter `services/parallexTransferService.js` implementing the payout rail contract (isConfigured/getBalance→BigInt kobo/sendPayout/queryPayoutResult/nameEnquiry/getBanks). Transfer-flavored (plaintext pw, `/thirdpartytransfer` prefix, `responseMessage`). Wired via new central `services/payoutRailAdapter.js` into all 3 money-path sites. **NOT committed/PR'd in main, NOT deployed, NO DB seeding.** GO-LIVE STEPS: (1) set env on 176; (2) seed Parallex payout rail_costs; (3) point a TEST merchant's payout_rail_id at Parallex; (4) smoke.

**🔌 VPN REQUIRED (Goke 2026-07-08):** Parallex wants us to connect over a VPN for prod/direct; sandbox works over public APIM gateway.

**🟢 2026-07-08 — PER-MERCHANT PAY-IN ROUTING BUILT + Demo/Test merchant routed to Parallex (PR #99).** Added `Merchant.payinRailId` (nullable FK → payment_rails). `feeEngine.resolvePayinRail` honours the override. **PROVEN on 176:** real checkout minted a live Parallex VA **acct 6015931844**.

**✅ WIRED + DEPLOYED 2026-07-08 (PRs #97, #98).** Parallex VA rail wired into Paylode + env set on 176. **`parallex-webhook.js`** (POST `/api/v1/webhooks/parallex/inflow`) → verifies shared `secret` then `finalizePayinSuccess`. Webhook runs in SCAFFOLD mode (accept+warn) until `PARALLEX_VA_WEBHOOK_SECRET` is set. Env on 176 `.env`: PARALLEX_VA_{BASE_URL,USERNAME=PaylodeVirtualA,PASSWORD=Password@1234,SUBKEY=f4511687…,MERCHANT_ID=PB_015}.

**🎉 PARALLEX VA FULLY WORKING 2026-07-08 — Login + VA mint proven.**
- Gateway `https://parallex-apim.azure-api.net/VirtualAccount/v1/VirtualAccount/`
- Header `Ocp-Apim-Subscription-Key: f4511687fc484f55b634d64a294e750e`
- `POST /Login {username:"PaylodeVirtualA", password:"UGFzc3dvcmRAMTIzNA=="}` (base64 of `Password@1234`) → code 00 "Login Successfully"
- Header `MerchantId: PB_015` on business calls. Debit/settlement account `2001096025`.
- **✅ CLEAN VA ADAPTER NOW IN REPO — PR #89 merged 2026-07-07** (`backend/src/modules/gateway-core/services/parallexService.js`, DORMANT/`isConfigured()`-gated).

**🟢 2026-07-08 (later) — PARALLEX *TRANSFER* SERVICE (payouts) LOGIN PROVEN.**
- **⚠️ CRITICAL: the working username is `PayloadeVirtualAcc` (note the typo — Paylo-A-de, extra "a")**. Transfer password = PLAINTEXT (NOT base64 — VA is base64, Transfer is NOT). Response uses `responseMessage` (not responseDescription).
- Transfer endpoint: `https://parallex-apim.azure-api.net/thirdpartytransfer`
- Header `Ocp-Apim-Subscription-Key: 7b3390db0fcd49a09b61c6f42297989a` (Transfer subkey — DIFFERENT from VA subkey).
- **getBanks parser FIXED** (PR #100 branch): Transfer wraps list under `r.banks` (was reading `r.data`→0).

**Source of truth:** Azure APIM dev portal https://parallex-apim.developer.azure-api.net (creds gokeakinboro@paylodeservices.com / Olatomide@1234@). Full scrape + reference saved at `backend/docs/parallex-api.md`. Two published APIs: **Third Party Transfer Service** (payouts) and **Virtual Account Service** (collections).

**Auth = TWO layers:** (1) APIM `Ocp-Apim-Subscription-Key` — ONE key per product; (2) app JWT via POST `<svc>/Login` → bearer token (cached/refreshed). Transfer Login pw = PLAINTEXT, VA Login pw = BASE64. **Money is NAIRA strings** at Parallex vs our KOBO — converted at the boundary.

**Open PRs (NOT merged/deployed):**
- **#100** Parallex Transfer PAYOUT rail (adapter+payoutRailAdapter map, dormant)
- **#101** per-channel routing matrix (CARDS/VA/PAYOUT)
- **#102** Parallex rail costs + merchant pricing seeds
- **#103** pay-in cost calc honours rail flat/min

**TODO-CONFIRM with Parallex:** exact INFLOW webhook body fields + signature header/scheme + ACK; responseCodes meaning pending-vs-fail; Parallex's own institution code for intra/inter routing (default 999015). **Set `PARALLEX_VA_WEBHOOK_SECRET`** once Parallex provides it.
