---
name: kiv-webhook-secret-portal-view
description: "#1 FIX (Goke 2026-07-07) — merchants can't view their webhook signing secret anywhere in the portal; add Reveal + Rotate on the Webhooks page"
metadata:
  node_type: memory
  type: project
---

# ⭐ #1 FIX — merchant-facing webhook signing secret (Reveal + Rotate)

## ✅ DONE + LIVE 2026-07-07 (PR #88)
Shipped end-to-end. **Backend** (`routes/webhooks.js` + new `services/reauth.js`): `GET /webhooks/secret` (masked, never raw), `POST /webhooks/secret/reveal` + `/secret/rotate` — both **step-up gated** (bcrypt password + TOTP if 2FA; `reauth.js` is self-contained so `auth.js` untouched), step-up failure returns **403 not 401** (avoids the frontend global auto-logout), both audit-logged (`WEBHOOK_SECRET_REVEALED`/`_ROTATED`). Rotate mints 64-char hex (matches KYC issuance). **Frontend** (`api-wiring.js`): "Signing Secret" panel on merchant Webhooks page — masked + Reveal/Copy/Rotate (Generate when none) via password+2FA modal. Deployed: backend file-by-file ssh to 176 (md5-verified `f2168f3f…`/`5ee3e51b…`, `pm2 reload paylode-core`, health 200); frontend via GH Action to 45 (`api-wiring.js?v=115`, live-verified). Routes smoke-tested 401 (registered). No schema change.

**Original write-up below (for reference):**

**Goke set this as the top-priority fix (2026-07-07).** Surfaced when the Bucksnostar integrator (Thomas Chow / Tomi UK) asked "where can we view the webhook key?" — answer today is **nowhere**.

## The gap (verified in code 2026-07-07)
- Merchant **Webhooks** page (Integration → Webhooks; `loadMerchWebhooks` in `api-wiring.js` ~L3365) only manages the **endpoint URL** (Add/Test/Remove) + lists events. `GET /webhooks/config` returns just `webhook_url` + `events` — **no secret**.
- The webhook signing secret (`merchants.webhookSecret`) is issued **ONCE**, emailed at KYC approval (`backend/src/routes/kyc.js` L280/287 — `webhook_secret` in the credentials bundle). Used only internally to sign outgoing webhooks (`webhookService.js` L19/28). **No reveal, no regenerate endpoint exists** (confirmed by full `backend/src` grep).
- Consequence: if a merchant misses/loses the email (or the secret was set later via psql, like Bucksnostar → Goke had to send it over a secure channel), they have **no way to retrieve it**. `app.js renderMerchWebhooks` is a static "Bolt Nigeria" mock and also shows no secret; the SA "Platform Settings" `whsec_paylode_xk8m2...` (app.js L997) is a hardcoded fake.

## The fix
- **Backend:** `GET /webhooks/secret` (merchant auth) → returns masked by default; **reveal gated by re-auth / 2FA** (don't return the raw secret on a plain page load). `POST /webhooks/secret/rotate` → mint a new `webhookSecret`, invalidate old, `logAudit`, return the new value once. (Mirror the API-key rotate UX already stubbed on the API Keys page.)
- **Frontend:** add a **"Signing Secret" panel** to the merchant Webhooks page — masked value + **Reveal** (re-auth) + **Copy** + **Rotate** (confirm dialog: "existing signatures will break"). Cache-bust `api-wiring.js?v=`.
- Deploy backend via file-by-file ssh to 176 + `pm2 reload paylode-core`; frontend push to main triggers the GH Action (verify 45 live). See [[project-paylode-dev-deploy]].

Do in a focused Paylode session. Interim answer to integrators: secret isn't viewable in-portal; use the one sent securely, store in server env. Links: [[project-paylode-portal-assistant]], [[kiv-backlog-index]], [[project-paylode]].
