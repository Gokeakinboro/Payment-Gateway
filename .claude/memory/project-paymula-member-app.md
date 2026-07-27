---
name: project-paymula-member-app
description: Paymula — member app (rebrand of the closed-loop Member Wallet); open self-registration + member KYC + multi-merchant switching. Decisions locked 2026-07-01.
metadata: 
  node_type: memory
  type: project
  originSessionId: 610c646d-1fbf-4f5b-bc7b-05e1192617b6
---

# Paymula → BILLSPAY (member app) — scope, decisions locked 2026-07-01

> **⚠️ RENAMED 2026-07-03: "Paymula" → "Billspay" (domain billspay.net). DEPLOYED to prod.** Name chosen to **layer bills-payment onto the member wallet later**. All user-facing "Paymula" strings replaced & live; see [[kiv-paymula-followups]] for the rebrand deploy details + remaining (billspay.net DNS, Billspay logo/icons). Read "Paymula" below as "Billspay".

Rebrand + big model expansion of the closed-loop Member Wallet ([[kiv-club-member-wallet-system]]). **First vertical: golf clubs** (one golfer belongs to MANY clubs → the whole model).

## Naming (locked)
- **Brand / store app name = "Paymula"** — checked clear on Play + App Store + web (no collision). PayPay/PromptPay/PayBills/BillsPay/PocketBook/PayLoop/Loop/Zone/AzaPay all taken; "Paylode Credits" rejected by user.
- **In-app balance label = "Paymula balance"** (shown in ₦). MUST NOT use "wallet" or "account" in customer-facing copy (CBN: PSSP can't present a wallet/account). Internal code keys (wallet_token, ME.wallet.balance, t.kind==='wallet', /wallet.html, sw scope) stay as-is — those aren't customer-facing.
- USER TO DO: register **paymula.com/.ng** domain + file **NG trademark** (web search ≠ formal clearance).

## Model change (locked decisions)
1. **Open self-registration** — anyone can install/visit and self-register as a member (in addition to the existing merchant-onboarded path; both converge to one member record).
2. **Member KYC = capture + VERIFY** — NIN, BVN, address etc., verified via **YouVerify/Dojah** at sign-up (like merchant KYC; needs the integration + cost). Store encrypted.
3. **Choose a merchant that OPTED IN** — merchant toggles "allow public members"; member then **auto-joins** (no per-join approval). Only opted-in merchants are listed/joinable.
4. **Many-to-many member ↔ merchant**, **SEPARATE closed-loop balance per merchant** (a golfer has N club balances). **In-app merchant SWITCHER** changes the active membership → balance/activity shown.

## Data-model implications (to design)
- Global **member identity** (login = email/phone + password) ↔ **memberships** table (member_id, merchant_id, balance, status, joined_at). Refactor from today's per-merchant `mw_members` (member currently scoped to one merchant).
- Merchant flag `allow_public_members` (opt-in) + public merchant directory endpoint (opted-in only).
- Member KYC fields + verification status; YouVerify/Dojah member verification (mirror merchant KYC).
- Every money move stays scoped to the ACTIVE membership's merchant balance (closed-loop).

## Install / PWA (in progress)
- Platform-aware **install button + prompt** on the member page (`wallet.html`): Android `beforeinstallprompt` native prompt; iOS Safari → "Add to Home Screen" sheet; hide if already installed; iOS-non-Safari → "open in Safari". manifest renamed to **Paymula**. Branch `feat/wallet-install-prompt`.

## Phasing / status
- **P0 ✅ DONE+DEPLOYED (PR #30):** Paymula rebrand (member title/brand/manifest) + platform-aware install button/prompt on wallet.html.
- **Copy sweep ✅ DONE+DEPLOYED:** de-"wallet"ed customer copy on wallet.html / wallet-admin.html / wallet-sa.html → Paymula. (Internal keys untouched.) STILL TODO: `app.js` merchant nav item "Member Wallet" — NOT changed because app.js is ahead on prod via #28/#29; rebrand it on a reconciled branch to avoid reverting live features.
- **P1 partial ✅:** merchant **opt-in flag** shipped — migration `mw_config.allow_public_members` (applied on 176), getConfig returns it, config.js PUT saves it, wallet-admin Settings "Public sign-up" toggle. Verified via GET /wallet/config. **P1 REMAINING (big, NOT started — needs careful design on live money system):** member identity + many-to-many memberships (per-merchant balance) refactor from per-merchant mw_members.
- **P2 ✅ DONE+LIVE (PRs #31/#32/#33):** public club directory `GET /wallet/public/clubs?q=` + member self-registration `POST /wallet/public/register` (validates → club must be opted-in+enabled → one-login-per-email → **verify NIN+BVN via YouVerify** → create user+mw_members(kyc captured/verified)+mw_wallets; rate-limited). migration `20260701_mw_member_kyc` (mw_members.nin/bvn/address/kyc_verified/kyc_verified_at). Frontend: registration screen in wallet.html ("Create an account" → club search → KYC form). Guard tests passed (400/CLUB_NOT_OPEN/EMAIL_EXISTS). **Happy path (real NIN/BVN → creates acct + YouVerify cost) NOT yet run — test with a real identity via the UI.** ⚠️ **Follow-up: encrypt NIN/BVN at rest** (stored raw for now).
- **P1-remaining (todo, moderate — NOT a rebuild):** enable multi-club per login: **drop UNIQUE on mw_members.user_id**; make `memberAuth` (_shared.js) active-membership-aware via an `X-Member-Id` header (default to single/most-recent when absent → backward compatible); add `GET /wallet/me/memberships`. Touches LIVE member money-auth → test before deploy.
- **P3 (todo):** in-app club switcher (sets active X-Member-Id) in wallet.html.

✅ **Branch drift RECONCILED 2026-07-01:** PRs #26→#31 all merged; main == prod; 0 open PRs. Golfer∈many-clubs finding: member identity is already the global users login + per-member mw_wallets balance, so multi-club = the P1-remaining bullet above (moderate), not a full refactor.

Deploy topology unchanged: backend 176 (`/opt/paylode-api`), frontend scp to 45+176 `/var/www/paylode/`.
