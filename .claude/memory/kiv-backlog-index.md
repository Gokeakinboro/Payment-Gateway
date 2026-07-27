---
name: kiv-backlog-index
description: RESUME HERE — consolidated index of all OPEN + recently-done KIV items (refreshed 2026-07-07)
metadata: 
  node_type: memory
  type: project
  originSessionId: 610c646d-1fbf-4f5b-bc7b-05e1192617b6
---

# 🟡 Open KIV backlog — RESUME HERE (refreshed 2026-07-07)

Single place to pick up. Each links to its detail memory. Supersedes stale [[outstanding-tasks]] (2026-06-13). Address him as **Goke** ([[feedback-address-by-name]]).

## 🔴 OPEN — blocked on Goke / external
- **Parallex payout NIP + balance (2026-07-12/13 session)** — [[project-parallex-integration]]. NameEnquiry returns `X91` for ALL banks (OPay + GTBank both fail) — NIP connectivity broken on Transfer APIM subscription. Transfer debit account `2001096025` shows ₦0 available via API despite ₦500k ledger. **Action: Goke to raise with Parallex:** (1) fix NIP X91; (2) why ₦0 available vs ₦500k ledger; (3) confirm VA settlement account ≠ payout debit account `2001096025`. Also: set `PARALLEX_VA_WEBHOOK_SECRET` once Parallex provides it (currently scaffold mode). VA pay-in FULLY LIVE for Drinks Arena ✅.
- **Parallex rail + routing/pricing** — [[project-parallex-integration]], [[project-rail-routing-matrix]]. **4 OPEN PRs off main, NONE merged:** **#100** Parallex Transfer PAYOUT rail (adapter+`payoutRailAdapter` map, dormant); **#101** per-channel routing matrix (CARDS/VA/PAYOUT); **#102** Parallex rail costs + merchant pricing seeds; **#103** pay-in cost calc honours rail flat/min. **PR #108 merged 2026-07-12** (sandbox bypass + Transfer service + migration). Merge #100–103 once payout NIP is unblocked.
- **Invoice&Collect – WhatsApp** — [[kiv-invoice-collect-paymentlinks]]. Meta Cloud API built, dormant; blocked on Goke's access token + approved templates + Phone Number ID.
- **Accounting integration** (QuickBooks/Xero/Zoho/Sage) — [[kiv-accounting-software-integration]]. Blocked on provider + OAuth creds.
- **Member Wallet (Paymula) WhatsApp receipts** — [[kiv-club-member-wallet-system]]. Blocked on Meta token+template. Native apps KIV.

## 🟡 OPEN — ready to build (my side)
- **Verify funding→route→release e2e** on a sandbox merchant (open since the payout-routing overhaul).
- **Auto-settlement Phase B** — bank-rec Phase 2 (open-banking Mono/Okra + auto-fire on receipt + accounting export) — [[kiv-bank-reconciliation-module]]. MVP live (PR #71).
- **No-code social selling** — link-in-bio storefront + channel-connect wizard + pay-button — [[kiv-nocode-social-selling]]. Goke: do before further re-architecture.
- **Paymula follow-ups** — encrypt NIN/BVN, per-club PIN, authed join-another-club, nav rename, register test, theme color — [[kiv-paymula-followups]].
- **Portal Assistant KB gaps** — ✅ FILLED 2026-07-13 (all ⟨CONFIRM⟩ resolved); deploy KB file to 176 + `pm2 reload paylode-assistant` — [[kiv-portal-assistant-kb-gaps]].
- **Icon swap — button/inline pass** (optional) — nav DONE (PR #91); api-wiring.js button emoji (HTML entities) not converted — [[kiv-frontend-icon-swap]].

## 🔵 In progress / monitoring
- **176 backend git — LEFT AS-IS by decision (2026-07-08).** Cosmetic only; verified live `backend/` == origin/main (0 genuine content diffs; HEAD just stale + orphan commits). Goke chose to leave it — running gateway is fine and doesn't use this `.git`. Nothing changed on prod. Detail + the (earlier, wrong) "mis-rooted" note correction → [[kiv-server-repo-reconciliation]].

## ⛔ Parked / ops
- **DrinksArena maintenance gate** — remove nginx Basic Auth on 45 when product updates done — [[drinksarena-maintenance-gate-active]].
- **Server-access tracker** — done; only optional `root@` allow-rule retirement left — [[kiv-server-access-tracker]].

## ✅ DONE — 2026-07-13 session
- **Icon swap — button/inline pass** — `⚙`/`✉`/`✎` in api-wiring.js buttons → Lucide `settings`/`mail`/`pencil`; added `lucide.createIcons()` to `showModal()` + navigate(). api-wiring.js v121, app.js v109.
- **PR #54 (db-boundary-txn-hooks)** — already merged (commit 46a07c2) + deployed (gatewayTxn.js confirmed in codebase; walk-based deploy.py means it shipped with subsequent backend deploys). Modularity 100% closed.
- **Guidde videos KIV** — removed from backlog. File deleted.
- **Bucksnostar monitor** — removed from active monitoring; watch script stays on 176 but no open action items.
- **Payout routing e2e code trace** — flow verified correct in code: `resolveRouteRail()` → pooled balance check → atomic wallet debit → `dispatchBatch()` async; null adapter refunds gracefully; only PalmPay wired until Parallex payout PRs #100-103 merge. Live API test still needs SA credentials.

## ✅ DONE + LIVE — 2026-07-12/13 session
- **PR #108 merged + deployed** — Parallex sandbox bypass (checkout.js) + `parallexTransferService.js` + migration. PM2 app on 176 is `paylode-core` (ids 15+19), not `paylode-api`.
- **Drinks Arena → Parallex VA LIVE** — `payin_rail_id` set in DB; webhook URL registered with Parallex; full e2e test passed (VA minted, inflow webhook, txn SUCCESS, fees correct).
- **Global SSH/DB permission saved to memory** — Goke authorized SSH to 176/45 + psql SELECT/UPDATE without per-session prompting (home memory `feedback-server-db-permissions.md`).

## ✅ DONE + LIVE — 2026-07-07 session
- **Go-Live gate** (PR #90) — activation ≠ live processing; live keys need `merchant.liveEnabled` (SA "Go Live" button, Processing-Mode badge). Bucksnostar deliberately kept live. → [[project-golive-gate]].
- **Webhook signing-secret Reveal/Rotate** (PR #88) — step-up gated, audited → [[kiv-webhook-secret-portal-view]].
- **Payout cancel/reverse endpoint** (PR #92) — `POST /payouts/admin/batches/:id/cancel` (needs_routing → reverse to wallet, REVERSAL ledger, never hits rail) + Cancel button → [[kiv-payout-cancel-reverse-endpoint]].
- **Lucide icon swap** (PR #91) — nav glyphs+emoji → one Lucide line-icon family (app.js v108, Lucide CDN) → [[kiv-frontend-icon-swap]].
- **PR3 dead-code cleanup** (PR #87) — removed dead payout allocators from payouts.js.
- **Parallex VA adapter** committed dormant (PR #89).
- **Invoicing deploy gap** — CLOSED (invoicing.html/invoice.html/qr.html already in deploy.py FRONTEND + GH Action; live-verified 200 on 45).
- **Invoicing P5 item pickers** — DONE (QR builder `qSearchCat` in invoicing.html + payment-link builder `plSearchCat` in api-wiring.js; both ≤6-item dept-catalogue tickbox pickers, backend `/invoicing/links` + `/qr`).
- **LASUCOM silo created** — cloned all DigitalMarketingLimited LASUCOM repos to `Desktop/lasucom`, ns `C--Users-Goke-Desktop-lasucom` (Laravel/PHP HR+recruitment + medical Library systems). Detail in the LASUCOM silo's `project-lasucom-overview`.

## Earlier context (still live)
- Payout routing overhaul (PRs #80–#86) → [[project-merchant-routing]]. Rail-agnostic pooled balance, 3-tier routing, per-merchant drill-downs.
- Modularity split LIVE (PRs #48–#53); server↔repo reconciled → [[kiv-product-suite-modularity]], [[kiv-server-repo-reconciliation]].
- Auto-settlement Phase A (PRs #63–#69) + bank-rec MVP (#71) + itemized invoicing/links/QR (#55–#58) + SA Connections (#70) all LIVE early July → [[kiv-auto-settlement]], [[kiv-invoice-collect-paymentlinks]].
- Deploy flow + topology → [[project-paylode-dev-deploy]] (backend file-by-file ssh to 176 `paylode-core`; frontend push→GH Action to 45; cache-bust in dashboard.html).
