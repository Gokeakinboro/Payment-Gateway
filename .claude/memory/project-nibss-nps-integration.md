---
name: project-nibss-nps-integration
description: "NIBSS National Payment Stack (NPS) — ISO 20022 rail for payouts, virtual accounts and identity (BVN/RC/TIN). Scaffold built 2026-09-15 ahead of IP allowlisting + sandbox keys."
metadata:
  node_type: memory
  type: project
---

# NIBSS NPS Integration (Paylode gateway)

Started **2026-09-15** off NIBSS's invitation email, ahead of credentials. NPS is
NIBSS's **ISO 20022** replacement for NIP (NIP spoke SOAP). One rail carries three
of our products: **payouts**, **virtual accounts**, **identity/KYC (BVN/RC/TIN)**.

Built to the same pattern as the PalmPay/Parallex scaffolds: full client + adapter
+ callbacks wired and **dormant**, gated on `isConfigured()`, so nothing calls out
and no existing rail changes behaviour until env is set.

## 🔴 BLOCKED ON NIBSS (do these first — none are code)
1. **Send team email addresses** to NIBSS for the support Teams group.
2. **Complete + return the IP Form** (attached to their email) for network
   permission. Whitelist **176.57.188.45** (server 176 — where the backend runs
   and where every outbound NPS call will originate). This is the same IP
   whitelisted for PalmPay.
3. **Sandbox credentials**: client id/secret, our **institution code** (6-digit,
   via sponsor bank), and the **float/debit NUBAN** payouts are funded from.
4. **Key exchange**: send our RSA public key, receive NIBSS's public key for
   callback verification.
5. **Pricing** — NIBSS has not advised cost per payout / VA / KYC check. Nothing
   is seeded into `rail_costs` until this lands (see money-sign-off rule).
6. **Certification**: NPS requires passing sandbox testing + schema validation +
   sample scenarios before go-live.

## ⚠️ The wire contract is UNCONFIRMED — and that is deliberate
The NPS docs portal (`https://nps-documentation.nibss-plc.com.ng`) is
**IP-allowlisted** and unreachable until the IP Form clears — it could not be read
while building this. So endpoint paths and field names are built from the **ISO
20022 message definitions NPS is specified against**, and:
- **every path is env-overridable** (`NIBSS_NPS_*_PATH`, `NIBSS_NPS_KYC_*_PATH`)
  → the first sandbox run corrects any of them **without a code change**;
- **response parsing is tolerant** — `dig()` accepts both the nested ISO shape
  (`FIToFIPmtStsRpt.TxInfAndSts.TxSts`) and a flattened REST shape
  (`data.status`), and handles single-object *or* array `TxInfAndSts`.

**FIRST JOB once the portal opens: read the docs and correct the paths/shapes.**

## What was built (branch `claude/nibss-payouts-identity-integration-42orj3`)
- **`backend/src/modules/gateway-core/services/nibssNpsService.js`** — the client.
  OAuth2 client-credentials (token cached, 401 → refresh + replay once), detached
  **RSA-SHA256** request signing over the exact JSON bytes, ISO 20022 builders:
  `pacs.008` transfer · `pacs.028` status request · `camt.056` recall ·
  `acmt.023` name enquiry · `camt.052` balance. Implements the **full rail adapter
  contract** (`isConfigured/getBalance/sendPayout/queryPayoutResult/nameEnquiry/getBanks`)
  so it plugs into all three money-path sites with no other change. Plus VA
  create/query.
- **`backend/src/services/nibssKycService.js`** — BVN/RC/TIN, returning the **same
  `normalise()` shape** as interswitchKycService/youverifyService, so swapping
  providers is a one-line require change at the call sites.
- **`backend/src/modules/gateway-core/routes/nibss-webhook.js`** — `/api/v1/webhooks/nibss`
  `/payout` (pacs.002) · `/va-credit` (camt.054) · `/recall` (camt.029), plus a
  base dispatcher/catch-all that routes on message type (NPS may give one
  institution-level notify URL) so no callback ever 404s.
- **`backend/src/appFactory.js`** — path-scoped `express.json({verify})` for
  `/api/v1/webhooks/nibss` that stashes `req.rawBody`.
- **`payoutRailAdapter.js`** — NPS registered (matches `nibss` or `nps`).
- **`backend/prisma/manual_sql/20260915_nibss_nps_rail.sql`** — registers the rail
  `CONFIG_ONLY`, `payout_enabled=false`, `is_default_payout=false`, `ON CONFLICT
  DO NOTHING`. Safe to apply now; changes no routing and no pricing.
- **`backend/test/nibss-nps.unit.test.js`** — 41 tests, no DB/network.
  `node test/nibss-nps.unit.test.js`.

## Gotchas already handled (don't re-introduce)
- **rawBody MUST be captured in `appFactory.js`, not in the router.** The global
  `express.json()` at appFactory.js:76 runs first and sets `req._body`, so a
  second parser inside the router **silently no-ops** and `rawBody` stays null →
  signature verification would fail on every callback. A test asserts this
  (`verifyCallback` without raw bytes fails, with them passes).
- **Amounts.** ISO 20022 carries **decimal NGN** (`"50000.00"`); Paylode is **kobo**
  everywhere internally. Convert at the client boundary ONLY.
- **Unknown `TxSts` maps to IN-FLIGHT ('1'), never failed.** Refunding a transfer
  that may have settled at NIBSS is the one unrecoverable mistake; the stuck-'sent'
  poller resolves it. Map: `ACSC/ACCC`→'2' success · `RJCT/CANC/RVSD/EXPI`→'3'
  failed · everything else →'1'.
- **A transport/HTTP failure is not a rejection** — `sendPayout` returns
  `orderStatus: null` so the leg stays in flight rather than being refunded.
- `EndToEndId` = our `rail_order_id`, and is what `pacs.002` echoes back — it must
  stay stable for the leg's lifetime or recon breaks.

## Deliberately NOT done (each needs its own decision/sign-off)
- **KYC is NOT wired into the live path.** `documents.js` / `kyc.js` /
  `kycOrchestrator` still import `youverifyService`. Switching is commercial
  (per-check price vs YouVerify/Dojah) — do it once NPS KYC pricing is agreed.
  NPS does **not** cover NIN, liveness, PEP, sanctions or adverse media; those
  stay with the incumbent even after a BVN/RC/TIN switch.
- **Static per-merchant VA collections are not credited** for NPS. That path
  deducts a merchant-funded fee and books a collection, and the fee math currently
  lives **inline in palmpay-webhook.js**. Lifting it into a shared service is a
  money-path refactor deserving its own change; until then an unmatched NPS credit
  is logged loudly for manual handling rather than half-credited. Dynamic checkout
  VAs **are** handled (shared `finalizePayinSuccess`).
- **`pacs.004` return/reversal leg is not wired** — so a VA amount-mismatch is
  flagged for manual treasury action instead of auto-reversed.
- **No rail costs seeded, rail left CONFIG_ONLY** — awaiting NIBSS pricing +
  money sign-off.

## Env (nothing calls out until the first two are set)
`NIBSS_NPS_CLIENT_ID` · `NIBSS_NPS_PRIVATE_KEY` · `NIBSS_NPS_CLIENT_SECRET` ·
`NIBSS_NPS_PUBLIC_KEY` · `NIBSS_NPS_BASE_URL` · `NIBSS_NPS_AUTH_URL` ·
`NIBSS_NPS_INSTITUTION_CODE` · `NIBSS_NPS_DEBIT_ACCOUNT` · `NIBSS_NPS_DEBIT_NAME` ·
`NIBSS_NPS_CHANNEL_CODE` · `NIBSS_NPS_NOTIFY_URL` · `NIBSS_NPS_TIMEOUT_MS` ·
`MODULE_NIBSS_WEBHOOK_ENABLED=off` to skip the mount.

## Reference
- Docs (IP-allowlisted): https://nps-documentation.nibss-plc.com.ng/docs/national-payment-stack-nps/
- NPS industry session deck (March 2026) linked in NIBSS's invitation email.

Links [[project-palmpay-integration]], [[project-parallex-integration]],
[[project-rail-routing-matrix]], [[project-payout-wallet-per-rail]],
[[feedback-paylode-money-signoff]].
