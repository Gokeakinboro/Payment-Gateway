---
name: session-2026-07-19-whatsapp-live
description: WhatsApp integration finally live + PalmPay timeout fix + Parallex VA disabled + merchant notification settings feature built
metadata: 
  node_type: memory
  type: project
  originSessionId: b548b802-f5ed-49cf-ba49-4dab4f2f21c1
---

## Session 2026-07-19 — WhatsApp LIVE + Notification Settings

### 1. WhatsApp Integration — NOW LIVE ✅

**Root cause of all previous failures:** Old Meta app (1711008260116566) had a WABA restricted due to a 2016 Facebook account restriction. Phone number registration was blocked at the Meta level, causing all sends to fail with 133010.

**Resolution:** Deleted old page, created fresh Meta app `paylode_messaging` (App ID: 1559437289020632). Full creds in [[reference-meta-facebook-app-creds]].

**Code fix required (named variable templates):** Meta's template uses named variables (`{{customer_name}}` etc.) instead of positional (`{{1}}`). The WhatsApp Cloud API requires `parameter_name` in each parameter object for named-variable templates. Fixed in `whatsappService.js:86-88`:
```js
return { type: 'text', parameter_name: v.name, text: String(v.value == null ? '' : v.value) };
```
`notifyInvoice()` now passes `{name, value}` objects instead of plain strings.

**Template:** `paylode_invoice_notification` — APPROVED on new WABA.
Variables (in order): `customer_name`, `business_name`, `invoice_number`, `amount_due`, `pay_url`.
Body ends with "Thank you." (variables cannot be at start/end of template body).

**Permanent token:** System User token generated (never expires). Deployed to 176 .env.

**Verified:** Message delivered to 08099918000 — `"msg":"WhatsApp sent"` in pm2 logs.

---

### 2. PalmPay Timeout Fix ✅

**Problem:** `palmpayService.js` `fetch()` call had no timeout. When PalmPay API stalled, the browser (30s timeout) dropped the connection before Express responded → checkout showed "loading..." forever.

**Fix:** Added 15-second `AbortController` timeout to the `fetch()` call in `palmpayService.js`. If PalmPay stalls, user gets a proper "Could not generate a bank-transfer account. Please try again." error.

**Deployed:** scp to 176 + pm2 reload paylode-core.

---

### 3. Parallex VA Disabled (not live yet) ✅

**Problem:** Merchants with `payinRailId` = Parallex were hitting the Parallex VA path because `PARALLEX_VA_USERNAME/PASSWORD/SUBKEY` were set in .env → `isConfigured()` returned true.

**Fix:** Commented out those 3 env vars in `/opt/paylode-api/backend/.env`. All merchants now fall through to PalmPay for VA pay-in.

**Important:** DB routing (payinRailId) is preserved. When Parallex VA goes live, just uncomment those 3 lines + reload. Existing transactions with cached Parallex VAs still show Parallex (normal — cached in txn.metadata).

---

### 4. Merchant Notification Settings — BUILT & DEPLOYED ✅

**Why:** WhatsApp notifications cost money; merchants must opt in per-event.

**DB:** `ALTER TABLE merchants ADD COLUMN notification_settings JSONB NOT NULL DEFAULT '{}';` — run on paylode_db 2026-07-19. Schema: `prisma/schema.prisma` Merchant model updated.

**Migration file:** `backend/prisma/manual_sql/20260719_merchant_notification_settings.sql`

**Backend routes** (`merchants.js`):
- `GET /api/v1/merchants/me/notification-settings` — merchant reads own
- `PATCH /api/v1/merchants/me/notification-settings` — merchant toggles
- `GET /api/v1/merchants/:id/notification-settings` — SA reads any
- `PATCH /api/v1/merchants/:id/notification-settings` — SA sets any

Supported keys: `whatsapp_invoice`, `whatsapp_payment_received`, `whatsapp_payout`

**Guard in `invoiceSend.js`:** Only fires WhatsApp if `inv.notification_settings.whatsapp_invoice === true`. Query now pulls `m.notification_settings` from merchants join.

**Frontend (`app.js`):**
- Added `Operations > Notifications` to merchant nav
- `renderMerchNotifications()` — table with SMS (inactive "—") + WhatsApp toggle per event
- Toggles save immediately via PATCH
- All merchants default to OFF

**⚠️ OPEN:** SA panel in merchant management view (SA merchant detail page) to see/toggle any merchant's notification settings — not yet built. SA can use the API directly for now.

**⚠️ OPEN:** `whatsapp_payout` and `whatsapp_payment_received` guards not yet wired in payout/receipt code — only invoice guard is live. Build when those WhatsApp templates are approved.

---

### What's NOT yet committed to git

All changes deployed via scp only:
- `backend/src/services/whatsappService.js` (parameter_name fix + notifyInvoice named params)
- `backend/src/modules/gateway-core/services/palmpayService.js` (15s timeout)
- `backend/src/modules/gateway-core/routes/merchants.js` (notification settings routes)
- `backend/src/modules/invoicing/services/invoiceSend.js` (WhatsApp guard)
- `app.js` (Notifications nav + page)
- `backend/prisma/schema.prisma` (notificationSettings field)
- `backend/prisma/manual_sql/20260719_merchant_notification_settings.sql` (new)

**Next session should open with a PR to commit all of the above.**
