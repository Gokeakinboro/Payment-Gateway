---
name: kiv-club-member-wallet-system
description: "KIV / future feature idea — internal closed-loop club member wallet system for Paylode merchants (fund + spend across departments, member app, alerts via email+WhatsApp). Deferred until CDL work wraps."
metadata: 
  node_type: memory
  type: project
  originSessionId: 93990cd9-c533-4020-b39e-242cad0011f6
---

## ✅ FULLY LIVE — member wallet system (Billspay) deployed + verified end-to-end

All mw_* tables live on 176. Backend MOUNTED at /api/v1/wallet. Money works: fund + spend + scan-pay all verified. PIN + biometric lock LIVE. Web push notifications LIVE. See [[session-2026-06-30-member-wallet-live]] for full detail.

## ⚠️ 2026-06-30 DEPLOY INCIDENT — table-name COLLISION (fixed)
First deploy hit a table-name collision: migration named `wallet_ledger` which is the EXISTING Paylode PAYOUT ledger. **FIX:** renamed ALL member-wallet tables to **mw_*** (mw_wallets, mw_ledger, mw_members, mw_config, mw_dept_ledger, mw_load_requests). LESSON: check existing table names / Prisma @@map before naming new raw-SQL tables.

## ✅ 2026-06-30 WALLET BACKEND MOUNTED + LIVE (the 404→401 fix)
Wallet module was DEPLOYED on 176 + all 6 `mw_*` tables present + payinFinalize wallet_fund hook present — BUT `/api/v1/wallet/config` returned **404** because the `app.use('/api/v1/wallet', …)` mount line had reverted out of server.js. Fixed: landed the whole wallet backend on **main** (PR #7), then on 176 `git fetch` + `git checkout origin/main -- src/server.js src/modules/wallet src/services/payinFinalize.js` + `pm2 reload`.

## ✅ SCAN & PAY SHIPPED + LIVE 2026-06-30 (PR #13)
Backend `GET /wallet/me/qr/:token` (resolve, closed-loop merchant check) + `POST /wallet/me/qr/:token/pay` (fixed=preset amount, open=member-entered, +VAT if QR charges it; reuses ledger.spendToDepartment/debit + never-negative) in me.js. UI in wallet.html: "⛶ Scan & Pay" button → camera scanner (BarcodeDetector API + jsQR CDN fallback + manual-entry) → resolve → confirm sheet → pay → balance refresh.

## ✅ 2026-06-30 PLAYWRIGHT PERSONA SUITE BUILT + GREEN
`e2e/` (PR #12): Playwright suite — logs in as each role via the real UI and asserts the landing page (member→wallet.html, merchant/SA→dashboard). Run: `cd e2e && npm i && npm run install:browsers && npm test`.

## ▶▶ RESUME GUIDE (clue word: **VAULT-KEEPER**)
Say "VAULT-KEEPER" to resume the Member Wallet. Full detail in [[session-2026-06-30-member-wallet-live]].

## Still OPEN (KIV)
- Native store apps (Capacitor): Apple Developer Program $99/yr + Google Play $25 one-time; brand assets; privacy policy URL + support email.
- Web push notifications: working on Android + installed iOS PWA 16.4+.
- WhatsApp wallet receipts: BLOCKED on user's Meta token+template. wiring done, no-ops until configured.
- Paymula follow-ups: encrypt NIN/BVN at rest; per-membership PIN; join-another-club authed flow.

## Backend Phase-1 COMPLETE
Commits on feat/member-wallet: migration `20260629_member_wallet.sql`; `src/modules/wallet/` = _shared (tenantAuth + requireWalletEnabled + getConfig), services/ledger (atomic credit/debit/spendToDepartment, row-locked, ₦3M ceiling), services/walletFund (credit-on-success, idempotent), routes config/members/fund/spend/loads/reports; mounted `/api/v1/wallet`; payinFinalize hook for `source:'wallet_fund'`. Funding = hosted checkout (checkout.html?ref) credited instantly on SUCCESS. Member auth/onboarding: members = `users` (role MERCHANT, gated by wallet_members.user_id) with one-time temp password.

## Positioning / scoping
- **Merchant-owned, NOT Paylode-owned** — the wallet system belongs to the merchant.
- **Merchant-branded (white-label)** — branding (name, logo, colours) is the merchant's.
- **Generic + multi-tenant toggle** — switched on for ANY merchant to use internally.
- CBN: PSSP can't present a wallet/account → use "Paymula balance" not "wallet" in customer-facing copy.

## Requirements (as stated)
- **Members fund their own wallets**; all fundings go to the **club** (the merchant).
- Members can **view their wallet** and **spend it across all departments**.
- **Closed-loop:** wallets can ONLY be used inside the organisation.
- **Low-balance alert.** Instant notifications via email + WhatsApp.
- **Merchant wallet dashboard** — view all stats across wallets/departments.
- **Admin has full rights.** NEVER-NEGATIVE rule: enforced by moveWallet debit check + row lock + **DB `CHECK(balance>=0)`** on wallets.balance.
- ₦3M MAX funding limit per member wallet (hard balance ceiling).
