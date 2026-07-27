---
name: project-golive-gate
description: Go-Live gate — activation != live processing; live keys need merchant.liveEnabled (SA/Admin flips it). LIVE 2026-07-07 PR #90
metadata:
  node_type: memory
  type: project
---

**LIVE 2026-07-07 (PR #90).** Fixed a real hole surfaced by Bucksnostar testing: **activating a merchant used to turn on live keys**, so an approved-but-still-testing merchant could move real money. Now **activation (is_active) grants portal + SANDBOX only**; live processing requires a separate `merchant.live_enabled` flag.

**Auth model (middleware/auth.js requireApiKey):** a LIVE key (`sk_live_`) works only if `merchant.isActive` **AND** `merchant.liveEnabled`. Sandbox keys (`sk_test_`) always work. This gates **both collections AND payouts** — the old prepaid-payout carve-out (`allowInactiveLivePayout`) was dropped (that flag is still set in payouts.js but no longer read → dead, harmless).

**Flipping live:** `POST /api/v1/merchants/:id/go-live` (SA/Admin, audited `MERCHANT_GO_LIVE`/`MERCHANT_SET_SANDBOX`), body `{enabled?:bool}`. UI = **Go Live / Switch to Sandbox** button + **Processing Mode** Live/Sandbox badge on the merchant detail (viewMerchant, api-wiring `v116`). Suspend/close clear `live_enabled` (so reactivation needs an explicit re-Go-Live).

**Schema/deploy:** `Merchant.liveEnabled Boolean @default(false) @map("live_enabled")`; migration `20260707_merchant_live_enabled.sql` backfilled `live_enabled = is_active` so all THEN-active merchants (Drinks Arena, Bucksnostar, Demo) stayed live. **Deploy required `npx prisma generate` on 176** (else the client reads `liveEnabled` undefined → gate blocks everyone) — sequence was migration → schema+generate → code → `pm2 reload` all paylode services+workers. Bucksnostar deliberately LEFT ON LIVE. Links [[project-paylode]], [[kiv-backlog-index]], [[feedback-paylode-money-signoff]].
