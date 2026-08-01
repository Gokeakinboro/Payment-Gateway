---
name: session-2026-06-30-member-wallet-live
description: "Member Wallet LIVE 2026-06-30 — fund+spend money bugs FIXED & verified (₦200 credited, ₦10 spend to BAR, float reconciles); change-pw collapse + installable PWA SW + Edit details all live. IN PROGRESS/QUEUED: PIN+biometric lock, web-push, WhatsApp receipts, manifest MIME (see RESUME section)."
metadata:
  type: project
  originSessionId: 93990cd9-c533-4020-b39e-242cad0011f6
---

# Member Wallet — LIVE session 2026-06-30 (resume word still VAULT-KEEPER)

Member: **gokeakinboro@gmail.com / `paylodewallet2026`** (mustChangePassword=false). Wallet at **paylodeservices.com/wallet.html** (canonical). Merchant id 7548c579-a281-49cf-9ea5-b5ec87fe3f28, wallet id 88817727-9e9b-4f78-b50b-18fdf5c10173, member id b9f162f7-9d24-436c-ac73-a7ca38b3d592.

## 🧭 RESUME (VAULT-KEEPER) — state at end of 2026-06-30 PM session
**ALL DEPLOYED + LIVE this session:** funding+spend money bugs fixed (PR#19+#20) → fund ₦200 + spend ₦10 to BAR verified live, float reconciles; change-password collapse + installable PWA service worker reinstated (PR#21); member **Edit details** name/phone/email via `PATCH /wallet/me/profile` (PR#22). SSH 176/45 = **key-based passwordless**. Repo root on 176 = `/opt/paylode-api` (run `git checkout origin/main -- src/...` from within `backend/`). Frontend deploy = `cat file | ssh root@45 "cat > /var/www/paylode/<f> && chown 1001:1001 ..."`. Backend = git checkout + `pm2 reload paylode-api`.

### ✅ 4-TASK BATCH (2026-06-30 PM) — 3 DONE+LIVE, 1 BLOCKED:
1. **Manifest MIME** ✅ LIVE — nginx on 45 `location = /manifest.webmanifest { default_type application/manifest+json; }`.
2. **PIN + biometric lock** ✅ LIVE & VERIFIED (PR #23). Migration `20260630_member_wallet_pin.sql` run on 176 (mw_members.pin_hash/pin_set_at/pin_failed/pin_locked_until). Backend: `assertPin()` gates spend+scan-pay+invoice-pay (5 fails→15min lock); `POST /wallet/me/pin` (set, password-authed), `POST /wallet/me/pin/verify`; GET /wallet/me returns `pin_set`. Frontend wallet.html: forced PIN setup on first login, lock screen on every app open, PIN/biometric prompt before each payment; biometric=WebAuthn platform authenticator releasing a device-stored PIN.
3. **Web-push notifications** ✅ LIVE (PR #24). `npm i web-push@3.6.7` on 176; VAPID keys in 176 `.env` (WALLET_VAPID_PUBLIC=`BAZDj8eW-5bxUe6f8S7cFN0z4BLrqyQQ41d7EHfhHTzn66v8TasmHQBCuw3M_D2as4L9Ic71t40lNbmZMzzms6A`, PRIVATE set, SUBJECT mailto:support@paylodeservices.com); table `mw_push_subs(member_id,endpoint UNIQUE,p256dh,auth)`. Backend `services/walletPush.js` (sendToMember, prunes 404/410) + `GET /wallet/me/push/key` + `POST/DELETE /wallet/me/push`; walletNotify pushes on fund+spend.
4. **WhatsApp wallet receipts** 🔴 BLOCKED on user's Meta setup. walletNotify ALREADY calls `whatsapp.sendTemplate(phone, WHATSAPP_TEMPLATE_WALLET||'', lang, waParams)`. NOT sending because (a) `WHATSAPP_ACCESS_TOKEN` is EMPTY on 176, (b) no `WHATSAPP_TEMPLATE_WALLET`. USER MUST: get a valid Meta WhatsApp Cloud API token + create/approve a wallet template.

## ✅✅ FUNDING + SPEND NOW WORK END-TO-END — LIVE & VERIFIED 2026-06-30 (loop CLOSED)
The stuck ₦200 funding is CREDITED and the closed loop is proven live. There were **THREE** bugs, all fixed + deployed to 176:
1. **Sweep never registered** (PR #19) — `reconcileWalletFunding` now runs in the `paylode-invoicing-worker` tick (idempotent). Worker logged `walletCredited:1`.
2. **Credited gross not principal** (PR #19) — now credits `metadata.merchant_settlement` (20000), not the gross 20215.
3. **🔑 THE REAL BLOCKER — P2010 uuid bug (PR #20, commit 9bc9947).** `ledger.js` `mw_ledger` + `mw_dept_ledger` INSERTs bound uuid columns with NO `::uuid` cast → Postgres can't coerce text bind→uuid → **P2010 "Raw query failed"** on ANY insert with a non-null uuid value. MASKED because smoke's only path (spend) passed transaction_id=NULL and hit 409 before the INSERT → **no successful credit/spend INSERT had EVER run.** Fix = `::uuid` casts on all uuid value params. LESSON: smoke must exercise a SUCCESSFUL credit AND a successful spend (with funds), not just the 409 guard.
**VERIFIED LIVE on 176:** member `88817727-…` — mw_ledger: `credit 20000 fund` + `debit 1000 spend`; mw_dept_ledger: BAR `credit 1000`; balance **19000** (₦190); `ledger.reconcile` balanced; re-sweep credits 0 (idempotent).

## ✅✅ LOGIN SAGA — TRUE ROOT CAUSE FOUND VIA SCREEN RECORDING + FIXED
After ~30 rounds, the user sent an iPhone screen recording. Extracted frames with **VLC** (no ffmpeg: `vlc -I dummy --avcodec-hw=none --no-spu --no-osd --video-filter=scene --scene-format=png --scene-ratio=20 --vout=dummy <vid>`). Frames showed the **REAL root cause: ALL wallet screens were stacked/visible at once** — `.auth{display:flex}` (defined after, same specificity) overrode `.screen{display:none}`, so after a SUCCESSFUL login the login form never hid → looked like "Sign In does nothing." FIX: `.screen:not(.on){display:none !important}`. Contributing red herrings also fixed: localStorage-blocked → in-memory token fallback (`tokSet/tokDel`); iOS autofilling OLD password → login fields `autocomplete=off autocapitalize=none`; 18s AbortController timeout; stale SW → kill-switch + self-heal. Built a self-reporting `/wallet-diag.html` that proved login 200 + /wallet/me 200 from the user's real phone. **MEMBER NOW SIGNED IN.** CLEANUP: canonical = **wallet.html** (onboarding LOGIN_URL points here); **wallet-app.html now REDIRECTS → wallet.html**; **wallet-diag.html REMOVED**. LESSON: when "login does nothing", check the UI actually switches screens — a CSS hide bug masquerades as an auth failure; and get a screen recording EARLY (VLC frames) instead of guessing.

## ✅ DONE this session (all live + merged)
- **Backend MOUNTED** (`/api/v1/wallet`, was 404 — mount line had reverted; PR #7).
- **Member onboarding works**; member-routing guard (members→wallet, not merchant dashboard).
- **Scan & Pay** shipped (GET/POST /wallet/me/qr/:token, closed-loop, camera scanner).
- **Smoke harness** `backend/test/smoke/wallet-smoke.js` (9/9) + **Playwright** `e2e/personas.spec.js`.

## ✅ UX asks — DONE + LIVE 2026-06-30 (PR #21)
- **Change-password collapse** — 3 password boxes now hidden behind "Change password ›" toggle.
- **Installable PWA service worker REINSTATED** (sw.js) — safe rewrite: NEVER caches HTML or /api/; caches only versioned static icons/manifest; scoped to `/wallet.html`.

## ✅ EDIT DETAILS — DONE + LIVE 2026-06-30 (PR #22)
New endpoint **`PATCH /wallet/me/profile`**: updates name/phone/email; email format-validated + uniqueness-checked; partial updates ok.

## Topology / how-to
176 = backend (`/opt/paylode-api/backend`, git checkout on main, API :3000) + DB `paylode`. 45 = frontend (`/var/www/paylode`, chown 1001:1001, HTML no-store). Deploy backend via `git checkout origin/main -- <path>` + pm2 reload; frontend via `cat file | ssh root@45 "cat > /var/www/paylode/<file>"`.
