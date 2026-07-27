---
name: project-palmpay-integration
description: "PalmPay integration for Paylode gateway — payouts (rail), pay-in virtual accounts, and Pay-with-PalmPay checkout channel. Started 2026-06-15 ahead of test keys."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5042ea10-d387-4f4d-ace7-9c60ba872118
---

# PalmPay Integration (Paylode gateway)

Started 2026-06-15, ahead of receiving test/live keys. Three products: **payouts** (a payout RAIL), **pay-in virtual accounts**, **Pay with PalmPay** (a SEPARATE checkout channel on checkout.html).

## Auth / signing (verified working in code)
- Base URLs: sandbox `https://open-gw-sandbox.palmpay-inc.com`, prod `https://open-gw-prod.palmpay-inc.com`.
- Headers: `Authorization: Bearer <AppId>`, `Signature: <rsa-sig>`, `CountryCode: NG`, JSON.
- Sign = RSA-SHA1 over the UPPERCASE MD5 hex of the ASCII-sorted, '&'-joined `key=value` of non-empty body params (excl `sign`). Amounts in kobo. respCode `00000000` = success.
- **KEY IN USE = 1024-bit.** PalmPay's own key is 1024-bit. Files: `C:\Users\Goke\Desktop\Paylode\Palmpay_gateway\paylode-keys\`.

## KEYS EXCHANGED (2026-06-16)
- **AppId `L260616170365989166681`**, **MerchantId `1260611155085210`**. These are LIVE creds.
- Our 1024-bit keypair generated + SHA1withRSA round-trip verified. Public sent to PalmPay; private = env `PALMPAY_PRIVATE_KEY` (PKCS8).
- Whitelist IP: **176.57.188.45**.
- **✅ INTEGRATION PROVEN WORKING 2026-06-16 (prod).** After user saved our public key: `queryBankList` → `respCode 00000000, success, 816 banks`. Auth + RSA signing + IP whitelist ALL confirmed end-to-end.

## ✅✅ LIVE PAYOUT WORKS — REAL MONEY MOVED 2026-06-18
PalmPay ACTIVATED our account → permission block lifted. Live test ₦200 to OPay `100004`/`7030000266`: `initiatePayout` → **respCode 00000000 success**, float 5000→4788 kobo (−₦212 = ₦200 beneficiary + ₦12 rail fee).
- **BUG FIXED:** `nameEnquiry` checked `d.status` but PalmPay returns **`d.Status`** (capital S). Now accepts either case + gates on respCode 00000000.
- **✅✅ FULL END-TO-END MERCHANT PAYOUT PROVEN 2026-06-18** — DrinksArena funded via SA top-up, ran merchant batch → PalmPay disbursed → rail_disbursements ledger written → batch completed.

## PAYOUT PRICING = FLAT ₦20 (set 2026-06-18, user: "payouts are a flat fee, not a %")
platform_rate_configs PAYOUT: fee_model=FLAT, flat_fee=2000. **Rail cost is FLAT — ₦5 PalmPay-on-us / ₦12 other-bank** (our COST from float, NOT charged to merchant). Merchant debited = beneficiary + **flat ₦20** + VAT(7.5% on ₦20=₦1.50). **Tiered payout (on-us vs other): ₦10 on-us / ₦20 other price via PAYOUT_ONUS** (deployed commit b36db8a).

## ✅ SELF-SERVE PAYOUT FLOW WIRED + LIVE 2026-06-18
POST /admin/batches/:id/route now ACTUALLY disburses via palmpayService.sendPayout. PalmPay rail status=LIVE, payout_enabled=true, payout_flat_cost=1200 (₦12). E2E verified through the REAL endpoints.

## Pay-in VA — LIVE + VERIFIED
- **Dynamic one-time VA minted** via `createBankTransferOrder` (productType:"bank_transfer"). Correct gross amount (₦101.07 for ₦100 face).
- **Pay-with-PalmPay WALLET = LIVE**: `checkout.js POST /:ref/charge/palmpay` → `createPayWithPalmPayOrder` → returns real `checkout_url`. Sandbox short-circuits to immediate finalize.
- VA webhook handlers WIRED (palmpay-webhook.js): `/va-cashin` → finalizePayinSuccess; `/payin` finalizes wallet checkout.
- Auto-poll every 5s (`startTransferPolling`) so it self-confirms within seconds of the webhook.

## Pay-in fee model: PAYER-FUNDED
Customer pays FACE + our fee + VAT (the "gross"); merchant gets FULL face. `feeEngine.resolvePayinRateConfig` + `computeFeesForPayin` from DB. Worked ₦1000: customer pays **₦1010.75**, merchant gets **₦1000**, our fee+VAT ₦10.75, PalmPay cost+VAT ₦6.51, Paylode margin ₦3.94.

## REMAINING
- PalmPay payout WEBHOOK (`/api/v1/webhooks/palmpay/payout`) reconciliation — confirm it matches legs by rail_order_id.
- ✅ RESOLVED 2026-06-20 — `queryPayoutResult` path corrected to `/api/v2/merchant/payment/queryPayStatus`.
- Rail Performance report over rail_disbursements (KIV).

## RECONCILIATION SOURCE
PalmPay has NO CSV/API transaction dump — data is only on PalmPay merchant DASHBOARD. Our `rail_disbursements` ledger is self-sufficient; the emailed PalmPay report = EXTERNAL cross-check.

## SENDER / DISPLAY-NAME CUSTOMISATION
- **PAYOUTS = NO** — no senderName field exists in PalmPay API.
- **VIRTUAL ACCOUNTS = YES**: `createVirtualAccount` has **`virtualAccountName`** → merchant's name CAN show on a collection VA. Decision: **PER-MERCHANT LABELED VAs** with merchant business name. NOT YET BUILT for static VAs.

## Built so far
- `backend/src/services/palmpayService.js` — shared client: isConfigured, call(path,body) signed POST, buildSignString/signParams/verifyParams/verifyCallback (RSA-SHA1+MD5), getBalance(), initiatePayout(), sendPayout(item), queryPayoutResult(), createBankTransferOrder(), createPayWithPalmPayOrder().
- `palmpay-webhook.js` (POST `/api/v1/webhooks/palmpay`): payout/va-cashin/payin handlers.
- PaymentRail seeded: PalmPay, status=LIVE, payout_enabled=true.
