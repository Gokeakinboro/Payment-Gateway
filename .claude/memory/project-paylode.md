---
name: project-paylode
description: "Paylode payment gateway — Playwright E2E 53/53 passing, compliance bug fixed, nginx separated from biz9ja — last updated 2026-06-06"
metadata:
  type: project
  originSessionId: 0bf4c9c9-5726-47c5-b775-971b0e461a03
---

# Paylode Payment Gateway

**Live server:** 176.57.188.45 (SSH as root, key-based; pw Olatomide@1234@)
**GitHub repo:** github.com/Gokeakinboro/Payment-Gateway
**Domain:** paylodeservices.com
**Backend pm2 app:** `paylode-core` (cluster ×2, port 3001; nginx router on :3000)

## Server layout
- `/var/www/paylode/` — nginx web root (static frontend files) — on 45 (LIVE) + 176 (fallback)
- `/opt/paylode-api/backend/` — Node.js API
- All API routes prefixed `/api/v1/`

## ⚠️ DEPLOY TOPOLOGY
- **Live web origin for paylodeservices.com is 45.141.122.223, NOT 176.** Cloudflare routes to 45; nginx on 45 proxies `/api/`→`http://176.57.188.45:3000` (the backend).
- **Backend** → deploy to **176** via scp + `pm2 reload paylode-core`.
- **Frontend** → scp to **45** `/var/www/paylode/` (the LIVE host) AND 176 (fallback). GH Action auto-deploys 8 frontend files to 45 on push to main.
- **Cache-bust:** bump `api-wiring.js?v=NN` + `app.js?v=NN` in `dashboard.html`. Cloudflare caches static assets.

## Interswitch card integration
- **Merchant Code:** MX45743 | **Client ID:** IKIAAFDE62A40082E8A2A6990043B6E6B872D815CF98
- Service: `src/services/interswitchService.js`
- Sandbox: `https://sandbox.interswitchng.com` (when `NODE_ENV !== 'production'`)
- Production: `https://webpay.interswitchng.com`
- Response codes: `00` = SUCCESS, `T0`/`paymentType=OTP` = OTP required

## Cloudinary
- Cloud: `dqjbhylmw`, Key: `971794652763866`; Route: `/api/v1/uploads/document`

## Fee Configuration
- Products: CARD_LOCAL (1.5%), CARD_INTL (3.5%), VIRTUAL_ACCOUNT (1% cap ₦1500), PAYOUT (₦20 flat other / ₦10 on-us), USSD (1.5%)
- Fee engine: `computeProductFee()` in helpers.js; `feeEngine.js` for txn+payin fees
- VAT 7.5%. Merchant overrides via `merchant_rate_configs`.

## YouVerify (updated 2026-06-09)
- **API key:** `BcHJhDag.VfkKv2cFNuw0vXfsG0Qjl13UMTLCj7634hbU`
- **Webhook signing secret:** `me86zEH1wkJtWa8SVuj9yHOWqNoMfAOmRN05`
- Webhook URL: single URL on Paylode; fan-out to biz9ja wired

## International (USD) cards — currency partition
- Partitions by `Transaction.currency`. `channel=CARD` + `currency=USD` → product `CARD_INTL`.
- `Settlement.currency` column added; groups by (merchant,currency) → separate NGN + USD batches.

## SDK repositories (published)
- Node.js: `npm install paylode-node` | Python: `pip install paylode-python` | PHP: `composer require paylode/paylode-php`

## Onboarding lifecycle
- SUBMIT (inactive account for sandbox) → review → **approved** → merchant clicks **Activate** (accept terms + confirm settlement) → **ACTIVE**.
- `POST /merchants/me/activate` (requires KYC_APPROVED + `accept_terms:true` + settlement on file).
- **Go-Live gate:** `merchant.liveEnabled` required for LIVE keys (PR #90, 2026-07-07).

## Active pm2 apps on 176
paylode-core (×2 cluster, :3001), paylode-invoicing (:3101), paylode-wallet (:3102), paylode-assistant (:3103), paylode-invoicing-worker, paylode-webhook-worker. nginx router on :3000 path-routes to each.

## Checkout page
- File: `/var/www/paylode/checkout.html`
- URL: `https://paylodeservices.com/checkout.html?ref=TXN-xxx`
- **UX flow:** Card · Bank Transfer (PalmPay VA) · Pay with PalmPay Wallet
- API URL uses `window.location.origin + '/api/v1'`

## Developer Sandbox
- Sandbox page: https://paylodeservices.com/sandbox
- Sandbox merchant: sandbox@paylodeservices.com / SandboxTest2026! / merchantCode=SANDBOX001
- sk_test: sk_test_b816ad4a088a9fe9245387ff0b05cd3b18e507ae342425f5

## Webhook retry worker
- PM2: `paylode-webhook-worker`. Queue: BullMQ `webhook-deliveries` on Redis `127.0.0.1:6379`. 3 attempts, exponential backoff 10s→20s→40s.

## Key Operational Notes
- `prisma generate` must be run on 176 AFTER schema changes — Prisma client does NOT redeploy via deploy.py (only schema.prisma copies). Failure mode: model fields undefined at runtime → silent 500 errors.
- Always `node -c <file>` before `pm2 reload paylode-core`.
- `sed -i 's/\r$//' <file>` on scp'd files to strip Windows CRLF before node -c or reload.
- Migrations run AS APP USER via DATABASE_URL: `psql "$DATABASE_URL" -f migration.sql`.
- After PR merge, GH Action redeploys 8 frontend files to 45 → clobbers manual scp; keep `?v=` in repo.
