---
name: session-2026-06-28-invoice-collect-build
description: "IN-PROGRESS build of Paylode \"Invoice & Collect\" module (invoices + QR + departments) — resume guide; backend+frontend written locally, NOT yet deployed/committed"
metadata: 
  node_type: memory
  type: project
  originSessionId: dfd7084a-7c96-44a4-9587-27b6667656ba
---

🟡 IN PROGRESS (2026-06-28) — Building the **Invoice & Collect** module for Paylode (spec resolved in `Desktop/downloads/Invoice-and-Collect-Product-Spec-v1.1.docx`). Approved plan at `C:\Users\Goke\.claude\plans\noble-meandering-abelson.md`.

## Approved decisions (locked)
- **In-repo, API-first module** inside the Payment-Gateway backend (NOT a separate microservice). Extractable later.
- **Tenant = merchant id** (golf & other platforms onboard as merchants/aggregators; consume via API key). No platform layer yet.
- **Build full Phase 1 together** (invoices + QR + departments). Recurring automation, full part-pay re-presentment, accounting API = Phase 2/3 (schema fields laid now).
- **Feature branch + PR, then deploy.**
- **Reusable by other platforms (golf) → modular.** Module consumed via `requireApiKey` (sk_live_/sk_test_) OR JWT — both resolve to a merchant tenant.

## Repo / environment
- **RESUME CLUE WORD: `FALCON-LEDGER`** — if the user says this, load this memory and continue the Invoice & Collect build from REMAINING WORK below.
- Repo of record: `github.com/Gokeakinboro/Payment-Gateway.git`. Local clone: `C:\Users\Goke\Desktop\paylode-gateway` on branch **`feat/invoice-and-collect`**. WIP **committed locally** (commit `9566594`, 22 files, NOT pushed — production untouched).
- LIVE backend: `paylode-api` (pm2 cluster x6) at **176.57.188.45**:5000, dir `/opt/paylode-api/backend`. DB on 176 — read `DATABASE_URL` from `/opt/paylode-api/backend/.env`. Stack: Express + Prisma 5 + Postgres, amounts in **kobo (BigInt)**.
- LIVE frontend (static): `/var/www/paylode` on **45.141.122.223** (served by nginx), checkout at paylodeservices.com. Both servers SSH key-based for root.

## What's BUILT (all local, syntax-checked with `node --check`, all pass)
Backend module `backend/src/modules/invoicing/`:
- `_shared.js` — VAT (7.5% on invoice face), tokens (signRecipient/verifyRecipient), `tenantAuth` middleware.
- `services/invoiceNumber.js` (atomic per-merchant counter), `services/invoiceSend.js` (email + status flip), `services/qrService.js` (qrcode PNG/SVG), `services/invoicingPay.js` (record invoice/QR payment from a SUCCESS txn, idempotent).
- `routes/`: contacts, lists, formats, products, invoices, qr, departments, public, reports. `index.js` aggregates → mounted in `src/server.js` as `app.use('/api/v1/invoicing', require('./modules/invoicing'))`.
- `backend/prisma/migrations/20260628_invoicing.sql` — idempotent DDL for all `inv_*` tables.
- `backend/src/workers/invoicingWorker.js` — standalone poll-loop (60s): scheduled sends, overdue reminders, payment reconcile.
- HOOK: edited `backend/src/services/payinFinalize.js` — after SUCCESS claim, if `txn.metadata.source` in (invoice|qr) calls `invoicingPay.recordForTransaction`.

Frontend (static, repo root):
- `invoice.html` (recipient secure view + pay), `qr.html` (scan landing + open-amount entry), `invoicing.html` — full merchant dashboard page (tabs: Invoices, QR, Contacts, Lists, Format, Departments, Reports).

## PROGRESS — session 2026-06-29 (clue word FALCON-LEDGER)
DONE this session (commit `87fecfe` on feat/invoice-and-collect, PUSHED; **PR #1 open**):
1. ✅ Dashboard nav link added (EXTERNAL_PAGES merch_invoicing).
2. ✅ SDK — `paylode.invoicing.*` in sdk/src/paylode.js + TS defs.
3. ✅ Docs — backend/src/modules/invoicing/README.md + docs/INVOICING.md.
4. ✅ Tests — backend/test/invoicing.unit.test.js (12 pass) + sdk/test (29 pass) + backend/test/invoicing.e2e.js.
5. ✅ npm install validated require-graph — **CAUGHT MISSING DEP**: `qrcode` added `qrcode@^1.5.4`.

## ✅ DEPLOYED 2026-06-29 (live on both servers, verified) — commits 87fecfe + 5d60290 on feat/invoice-and-collect, PR #1
**176 backend**: New files copied via `git checkout origin/feat/invoice-and-collect -- <paths>`; server.js + payinFinalize.js patched SURGICALLY; migration ran as app user → 13 `inv_*` tables created; `pm2 reload paylode-api` + `pm2 start src/workers/invoicingWorker.js --name paylode-invoicing-worker`.
- **BUG FOUND & FIXED LIVE (commit 5d60290)**: `invoicingPay.js` is in `services/` so requires need `../../../` not `../../` (it used `../../utils/db` → MODULE_NOT_FOUND). LESSON: add a require-resolution smoke.
**45 frontend**: scp'd new `invoice.html` `qr.html` `invoicing.html`. 45's app.js patched SURGICALLY, bumped `dashboard.html` `app.js?v=42→43`.
**Verified live**: API /health 200; `paylodeservices.com/api/v1/invoicing/invoices` → 401; 3 new pages serve 200 over HTTPS; app.js?v=43 carries nav link.

## 2026-06-29 (later) — 3 merchant-portal bugs FIXED LIVE on 45
Reported: Invoicing tab "coming soon", inactivity-logout not firing, Chrome can't autofill login. ROOT CAUSES: (1)+(2) STALE CACHE — `dashboard.html` on 45 had been reverted to `app.js?v=42` + `api-wiring.js?v=83` by a main-based redeploy. FIX = bumped both refs to **?v=90**. (3) login.html email/pw inputs wrapped in `<form>` + added name attrs, button type=submit. All verified live.

## 2026-06-29 (later) — payment-link VAT toggle + phone-capture groundwork SHIPPED LIVE
- ✅ **Payment-link "Charge 7.5% VAT" toggle** (commit 19b8d9b): migration `payment_links.charge_vat`; modal checkbox; backend stores it and adds VAT at the public transaction mint. Deployed 176+45.
- ✅ **Phone capture for WhatsApp prep** (commit d603c74): invoice create form gains Recipient phone; payment_links new `customer_phone` column + single-link create stores it. Deployed 176+45.
- 🔗 All work pushed to origin/feat/invoice-and-collect (tip d603c74) and **MERGED to main** (PR #1, merge commit 6de2fde, user-approved).

## 2026-06-29 follow-ups — cert fix + nav bug
- ✅ **526 FIXED**: `api.paylodeservices.com` — 176 had NO `api.` vhost; created `/etc/nginx/sites-available/paylode-api` + issued LE cert. Verified: api host /health 200.
- ✅ **NAV BUG FIXED (commit c26ac08)**: clicking Invoice & Collect showed "coming soon" because `api-wiring.js` overrides `window.navigate`. Fix: added the same `EXTERNAL_PAGES[page]` redirect at the top of api-wiring.js's navigate(). **LESSON: merchant-dashboard nav/page behaviour lives in `api-wiring.js`, NOT just app.js — patch BOTH.**
