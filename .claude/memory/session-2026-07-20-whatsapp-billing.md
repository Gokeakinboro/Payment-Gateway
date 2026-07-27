---
name: session-2026-07-20-whatsapp-billing
description: "Session 2026-07-20 — WhatsApp billing system, portal fixes (timeout, flash, coming-soon), receipt + payout summary templates"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0d6bbe69-b839-491d-bcc5-2a0c51da1e30
---

# Session 2026-07-20 — WhatsApp Billing + Portal Fixes

## What shipped (PRs #110–#122)

### WhatsApp per-message billing (PR #110, #111, #112)
- **Two new DB tables**: `whatsapp_message_log` (per-send billing log) + `platform_settings` (key-value; seeded `whatsapp.meta_cost_per_message_kobo = 0`)
- **Prisma generate** must be run on 176 after schema changes — Prisma client does NOT redeploy via deploy.py (only schema.prisma copies). Failure mode: `prisma.platformSettings` undefined at runtime → silent 500 errors.
- `notification_settings` JSONB on merchants extended with: `whatsapp_price_per_message_kobo`, `whatsapp_free_tier_per_day`
- SA routes: `GET/PATCH /api/v1/platform/settings/:key`, `GET /api/v1/merchants/:id/whatsapp-stats`
- Portal: SA > Operations > **WhatsApp Billing** — searchable merchant table (active merchants only, `?active=true`), inline toggles + pricing inputs, Meta cost card
- **Critical bug**: `helpers.ok()` returns `{ status: true, data: {...} }` NOT `{ ok: true, ...data }` — all WhatsApp code was checking `r.ok` (undefined/always falsy). Fixed to use `r.status` for success checks and `r.data.settings` / `r.data.value` for data reads.

### Portal bug fixes (PR #113, #114, #115, #116)
- **Inactivity timeout**: added `setInterval(checkElapsed, 60000)` backup — `setTimeout` alone throttled/paused on sleep, pages stayed open indefinitely
- **SA dashboard flash on merchant login**: IIFE reads `paylode_user.role` from sessionStorage before first `renderNav()`/`renderPage()` so merchant login no longer flashes the SA dashboard
- **"Coming soon" clobber**: `loadPageData()` default branch was overwriting any page it didn't recognise. Fixed: added no-op cases for `sa_whatsapp`, `merch_notifications`, `merch_webhooks`, `merch_profile`; changed original `default:` to silent `break`
- **Cache-busting**: bump `?v=` in dashboard.html whenever app.js or api-wiring.js changes; Cloudflare/browser caches old files otherwise

### WhatsApp notifications expansion (PR #121, #122)
Four events now (all opt-in per merchant):
| Key | Who | When |
|-----|-----|------|
| `whatsapp_invoice` | Customer | Invoice sent |
| `whatsapp_checkout_receipt` | Customer (payer) | Checkout payment confirmed |
| `whatsapp_payout` | Beneficiary | Payout dispatched |
| `whatsapp_payout_summary` | Merchant | Payout batch completed |

Checkout receipt wired into `payinFinalize.finalizePayinSuccess()` — looks for `txn.metadata.customer_phone`. Payout summary wired into `payoutSettle.applyPayoutResult()` on batch terminal state, sends to `merchant.businessPhone`.

**Templates submitted to Meta:**

Template 1 `paylode_checkout_receipt` (UTILITY, pending approval):
```
Hi {{customer_name}}, your payment to {{business_name}} was successful!

Amount paid: {{amount_paid}} (charges inclusive)
Reference: {{reference}} - keep this for your records
Date: {{date_time}} WAT

This receipt was sent on behalf of {{business_name}} via Paylode.
```

Template 2 `paylode_payout` (UTILITY, pending approval — **NOTE: name is `paylode_payout` not `paylode_payout_summary`**):
```
Paylode alert for {{merchant_name}}: your payout batch has been dispatched.

Total amount sent: {{total_amount}} to beneficiaries
Number of transactions: {{txn_count}} in this batch
Dispatched at: {{dispatch_time}} (WAT)

Thank you for using Paylode.
```

## Env vars to set on 176 once Meta approves templates
```
WHATSAPP_TEMPLATE_CHECKOUT_RECEIPT=paylode_checkout_receipt
WHATSAPP_TEMPLATE_CHECKOUT_RECEIPT_LANG=en
WHATSAPP_TEMPLATE_PAYOUT_SUMMARY=paylode_payout
WHATSAPP_TEMPLATE_PAYOUT_SUMMARY_LANG=en
```
Set in `/opt/paylode-api/backend/.env`, then `pm2 reload paylode-core --update-env`.

**Why:** Paylode is not a bank — user removed "banking" from footer. Template name chosen: `paylode_payout` (not `paylode_payout_summary`).

## Open / carry forward
- Checkout receipt requires `txn.metadata.customer_phone` — currently not captured at checkout for card/standard VA flows. Need to add phone capture to checkout for receipt to fire.
- Meta template approval pending (both templates submitted 2026-07-20)
- WhatsApp billing margin reporting works once sends start flowing through (no data yet)
