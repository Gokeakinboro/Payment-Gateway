---
name: project-parallex-integration
description: "🟢 Parallex VA + Transfer FULLY LIVE via VPN tunnel (2026-08-11); VA MerchantId PB_014; Transfer username Paylode; Bucksnostar Global on Parallex for both VA + payout; interbank payout blocked on pilot NIBSS"
metadata: 
  node_type: memory
  type: project
  originSessionId: b3c41ab9-af9b-40a2-89db-9ff4775b47ce
---

**🟢 2026-08-11 — VA + TRANSFER BOTH LIVE VIA VPN TUNNEL. ALL CREDENTIALS CONFIRMED.**

### VPN / Routing
- IPSec IKEv2 tunnel: DO Droplet `165.22.21.63` → FortiGate `102.220.220.19`
- Phase 2 selector: `10.254.254.1/32 === 192.18.0.40/32` (both VA and Transfer on `.40`)
- DNAT on DO: 176.57.188.45:443 → 192.18.0.40:443. SNAT source = 10.254.254.1
- `/etc/hosts` on 176: `165.22.21.63 tptintegration.parallexbank.com`
- DPD + 6hr force-up cron on DO. Health check cron on 176 → `/var/log/parallex-vpn.log`

### VA (Collections / Pay-in) — LIVE
- **Base URL:** `https://tptintegration.parallexbank.com/VirtualAccountAPI/V2/VirtualAccount`
- **Username:** `Paylode` | **Password:** `PaylodeVA@2026!` (base64-encoded on call)
- **MerchantId header:** `PB_014` | **Subkey:** `89199022492c4abaaa17ed7d2984f524`
- **Settlement account:** `1000362856`
- **Webhook secret:** `0db9fd42d16141799440f52831a8a7f9071904` (registered INFLOW → `https://paylodeservices.com/api/v1/webhooks/parallex/inflow`)
- **Proven 2026-08-11:** Login ✅ · VA created (`6014000001` "Test Paylode") ✅ · ₦100 payment received (requery: SUCCESSFUL) ✅
- **Proven 2026-08-12:** VA `6014000007` "Paylode WebhookTest" ₦103 received (requery SUCCESSFUL, txn ref `100004260812093050168038367264`) ✅ · webhook NOT delivered ❌ (zero nginx + app log hits — Parallex-side failure)
- **referenceId minimum 20 chars** (Parallex validation enforces this; UUIDs = 36 chars, fine)
- **Webhook delivery:** confirmed broken on Parallex's end — two live payment tests, zero webhook deliveries to `https://paylodeservices.com/api/v1/webhooks/parallex/inflow`
- **env on 176:** `PARALLEX_VA_{BASE_URL,USERNAME,PASSWORD,SUBKEY,MERCHANT_ID,SETTLEMENT_ACCOUNT,WEBHOOK_SECRET}` all set; `MODULE_PARALLEX_WEBHOOK_ENABLED=true`

### Transfer (Payouts) — LIVE (intrabank); interbank blocked on pilot NIBSS
- **Base URL:** `https://tptintegration.parallexbank.com/ThirdPartyTransferAPI`
- **Username:** `Paylode` | **Password:** `Paylode@Parallex2026!` (PLAINTEXT — not base64)
- **VA collections / settlement account (debit source for VA→merchant payouts):** `1000362856`
- **Payout debit float account:** `1000362849` (balance ~₦3,896 last checked — top up before batch payouts)
- **Intrabank transfer 2026-08-11:** ✅ ₦100 tested (1000362849 → 1000362856)
- **Intrabank transfer 2026-08-12:** ❌ TIMEOUT — `IntrabankTransfer` POST endpoint hanging (GetBalance still works); Parallex-side regression
- **1000362856 as TPT debit:** ❌ "Invalid Account Number" — not enrolled in TPT product; must raise with Parallex (enroll it, or confirm sweep model: 1000362856 → 1000362849 happens Parallex-side)
- **NIP name enquiry:** ✅ First Bank, GTBank, OPay (with 6-digit institution codes)
- **Interbank transfer:** ❌ pilot NIBSS not live — hangs, times out after 45s
- **Institution code map:** CBN `328`/`305` → OPay `100004`; `058` → GTBank `000013`; etc. (full map in parallexTransferService.js)
- **PalmPay NIP fallback:** used only when Parallex NIP fails, to get accountName; sessionId passed as empty string to Parallex interbank (which is already blocked anyway)
- **Bucksnostar Global** (`f4530c4c-015a-4d18-af38-cd918a0997e3`): MUST use Parallex for both payin + payout — NEVER PalmPay (business rule, no exceptions)

### Code committed
- `parallexService.js` — VA service (Connection: close + 30s timeout + base URL correct)
- `parallexTransferService.js` — Transfer service (Connection: close + 45s timeout + institution code map + PalmPay NIP fallback + code 90 re-login bug fixed) — commit `46f9fab`
- `parallex-webhook.js` — inbound INFLOW webhook (verifies secret, calls finalizePayinSuccess)

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
