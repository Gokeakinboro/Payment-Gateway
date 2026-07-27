---
name: kiv-invoice-collect-paymentlinks
description: KIV / follow-up backlog from the Invoice & Collect + payment-link VAT/phone sessions (2026-06-29) — open items after Phase 1 shipped live
metadata: 
  node_type: memory
  type: project
  originSessionId: 93990cd9-c533-4020-b39e-242cad0011f6
---

🟡 KIV backlog as of 2026-06-29, after Invoice & Collect Phase 1 + payment-link VAT toggle + phone-capture groundwork all shipped LIVE. See [[session-2026-06-28-invoice-collect-build]] for the build/deploy detail. Ordered roughly by priority.

1. 🟡 **WhatsApp via META CLOUD API — BUILT, DEPLOYED, UNBLOCKED; testing in progress (2026-07-18)**
   - Meta business verification: ✅ APPROVED. Template `paylode_invoice_notification`: ✅ APPROVED.
   - All env vars on 176 set. Pino `this`-binding bug in `whatsappService.js` fixed + deployed.
   - Still getting error 133010 on `2347030000266` (OPay test number). Updated contact to `08099918000` for next test send. **See [[reference-meta-facebook-app-creds]] for full resume steps.**
   - ✅ **Contact edit (PATCH /contacts/:id) UI built + deployed** (invoicing.html?v=20260715a): Edit button + modal on every contact row — name/email/phone/tags editable.
   - Original notes below ↓ (branch `feat/sendchamp-whatsapp`, NOT merged). SWITCHED OFF SendChamp (their WhatsApp onboarding/Activate-Number UI not available on the account — BSP/Meta access not active; SendChamp files removed). Now uses **Meta Graph `/<ver>/<PHONE_NUMBER_ID>/messages`** template sends.
   - DONE: `src/services/whatsappService.js` (config-gated, no-ops until `WHATSAPP_ACCESS_TOKEN`+`WHATSAPP_PHONE_NUMBER_ID`+template set; NG phone normalize; positional body params). Meta webhook `src/routes/whatsappWebhook.js` LIVE at **`https://api.paylodeservices.com/v1/whatsapp/webhook`** (GET verify-challenge ✓, wrong-token 403 ✓, POST ack 200 ✓; optional X-Hub-Signature-256). server.js mount now FROM GIT (in-place edits get reverted on this box — commit them).
   - CHANNELS wired (all best-effort/no-op until configured): invoice notify (invoiceSend.js), receipt on fully-paid (invoicingPay.js), payment-link share on create-with-customer-phone (paymentLinks.js), QR share `POST /api/v1/invoicing/qr/:id/share {phone}` (qr.js).
   - 176 `.env` set: `WHATSAPP_PHONE_NUMBER_ID=61591725320397` (PROVISIONAL — user called it "meta id"; likely the WABA/Business id, **must confirm it's the Phone Number ID**), `WHATSAPP_API_VERSION=v21.0`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN=pl_wa_afc0e859e5692e1ce0cd2e53` (entered in Meta dashboard). BLANK/needed: `WHATSAPP_ACCESS_TOKEN` (critical), `WHATSAPP_APP_SECRET`, the 4 `WHATSAPP_TEMPLATE_*` names (+`_LANG`).
   - NEED FROM USER: (1) **Access Token** (Meta App→WhatsApp→API Setup, temp or permanent system-user); (2) confirm/correct **Phone Number ID**; (3) **App Secret**; (4) approved **template names + language + variable ORDER** for invoice/receipt/payment-link/QR. Then set `.env`, align param arrays in whatsappService to each template's variable order, pm2 reload, live-test to 2349073128016. Sender number = **09073128016 / 2349073128016** (onboard in Meta). Merge branch when wiring confirmed with a real send.

2. ✅ DONE — **Merged `feat/invoice-and-collect` → main** (PR #1, merge commit 6de2fde, user-approved 2026-06-29). origin/main now contains all Invoice & Collect + VAT + phone work.

3. **Payment-link BATCH per-recipient phone** — batch create is email-list only; single-link create now stores `customer_phone`. For WhatsApp-to-many, batch needs email+phone pairs (or an XLS phone column). Backend `/payment-links/batch` + the modal recipients textarea / XLS parser.

4. **Checkout/receipt payer phone** → `transaction.customerPhone` — to WhatsApp RECEIPTS to whoever pays a link/invoice, capture phone at checkout (checkout.html payment-link landing + invoice/QR public pay) and add a `customerPhone` column to the Transaction Prisma model. (Phone-at-creation is done; phone-at-payment is not.)

5. **DrinksArena e2e smoke test** — live endpoint checks PASSED (api host /health 200, /v1/invoicing 401, cert valid). Full SDK e2e (`backend/test/invoicing.e2e.js`) still not run: needs an `sk_test_` key. Plan was to mint a throwaway sandbox key for the DrinksArena merchant (user-authorized tenant) and revoke after — classifier blocked broad merchant enumeration, so do a TARGETED lookup of the one DrinksArena merchant id + insert `api_keys` row (key_hash=sha256(rawkey), key_prefix='sk_test', is_sandbox=true) → run e2e against api.paylodeservices.com → delete the key + its inv_* rows.

6. **Department-scoped CORE transactions** — invoicing departmental users see only their dept's invoices/QR/reports, but the main gateway **Transactions** page (merch_transactions) is NOT department-segmented. User asked for staff who "see transactions relating to their departments"; segmenting core transactions by department is new work.

7. **Server ↔ repo reconciliation** — 176 `/opt/paylode-api` has a local-only commit (c0ce9d1, frontend) + ~16 uncommitted `backend/src` files not in git; 45 frontend is scp-managed (not a git checkout). All invoicing/VAT/phone deploys were done SURGICALLY to preserve this drift. The drift should eventually be committed back into git (mirrors the past `94ee2c4 reconcile repo with production` effort).

8. **Minor polish** — (a) payment-link merchant LIST could show a "VAT" badge (data is in `formatLink.charge_vat`, not rendered). (b) Confirm the `api.paylodeservices.com` LE cert auto-renew fires (certbot webroot, expires 2026-09-26; renewal scheduled, low risk).

9. ✅ **DONE + LIVE 2026-07-05** (KIV #5): (a) **Item-pickers on QR + payment-link builders** — QR builder (invoicing.html tQr, PR #74) + "New Payment Link" modal (api-wiring.js, PR #75) now have the tick-box catalogue picker. QR sends items[] to `/invoicing/qr`; the payment-link modal routes to the existing boundary-clean **`POST /invoicing/links`** (invoicing itemized-link builder → core `createPaymentLink`) when items are picked (else unchanged amount/recipients flow; itemized=single link, recipient-batch guarded). (b) **`invoicing.html`/`invoice.html`/`qr.html` added to the auto-deploy pipeline** (GH Action `deploy.yml` + `tools/deploy.py`, PR #73) — proven: they now auto-deploy on push (no manual scp). api-wiring v107 / app.js invoicing cache-bust v=20260705c.

10. ✅ **BUILT 2026-07-05 → PR #61 (`feat-invoicing-contacts-delete-va-msg`, STAGED for money sign-off, NOT deployed).** All four items:
    - (i) **checkout VA "Unavailable"** — CONFIRMED root cause = **amount < ₦100** (`AMOUNT_TOO_LOW`), NOT a rail bug (user re-tested with a higher amount). Real defect was `checkout.html:1053` showing a blanket "Unavailable" for every backend reason → now surfaces the actual `data.message` in a new `#va-note` element.
    - (ii) **sent-notification "didn't apply"** — code was already live (md5-verified) but `invoicing.html` is served STALE (no cache-bust + not in the frontend auto-deploy set). Fix: `app.js` EXTERNAL_PAGES → `invoicing.html?v=20260705`; also added a prominent self-dismissing `showBanner()` on create/send/cancel/delete (old inline `setMsg` was easy to miss).
    - (iii) **recipient from address book** — contact search/browse box in the create form (`searchInvContacts`/`pickInvContact`) fills email/name/phone via existing `GET /contacts`.
    - (iv) **delete old invoices** — decision: **soft-delete, UNPAID only**. `DELETE /invoices/:id` sets `deleted_at` (paid/part-paid protected); list+detail+public-token queries exclude deleted. Migration `20260705_invoice_soft_delete.sql`. Delete button on unpaid rows only.
    - ✅ **DEPLOYED + LIVE 2026-07-05** (PR #61 merged, merge `83a378f`). 176: migration applied (`deleted_at` col + partial index), `invoices.js`+`public.js` pushed (LF via `git show|ssh cat`, `.bak.20260705`), `paylode-invoicing` reloaded (online, 401 on route). Frontend: `app.js`+`checkout.html` auto-deployed to 45 by GH Action; **`invoicing.html` manually pushed to BOTH 45 AND 176** (⚠️ 176 ALSO serves `/var/www/paylode` via nginx `sites-available/paylode` — its invoicing.html was stale; now both == main `b3bb06d5`). Live-verified via domain: `invoicing.html?v=20260705` carries new code, `checkout.html` has `#va-note`, API 401. **Cloudflare purge NOT needed** — the `?v=20260705` query busts cache. (Still reinforces KIV item 9b — add invoicing.html to the auto-deploy pipeline so this isn't manual/2-host each time.)
