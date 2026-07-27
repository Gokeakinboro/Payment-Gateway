---
name: project-rail-routing-matrix
description: Per-channel rail routing matrix (CARDS/VA/PAYOUT) — SA-chosen defaults + per-merchant per-channel overrides. PR #101 (branch, not merged/deployed). Supersedes the 3 ad-hoc routing mechanisms.
metadata:
  type: project
---

**🟢 2026-07-08 — PER-CHANNEL RAIL ROUTING MATRIX BUILT (PR #101, branch `feat/rail-routing-matrix`, NOT merged/deployed).** Goke's requirement: default routing is **SA-chosen (not auto-lowest)** and **overridable per merchant, BY CHANNEL** (CARDS / VA / PAYOUT). Unified the 3 inconsistent mechanisms → one matrix.

**Policy (Goke, important):** SA **MUST** set the default per channel — **NO silent cheapest-rail fallback**. Routing is a **traffic-TYPE decision, not just cost** — sending the wrong traffic to a rail can get us **disconnected**. Migration seeds defaults from current live state so nothing breaks on deploy; thereafter SA-managed. resolveRail returns null when unset → caller REJECTS (cards fall back to the incumbent Interswitch adapter only).

**Model (was → now):**
- CARDS: `platform_rate_configs.default_rail_id` (no per-merchant ovr) → matrix default + **new** per-merchant ovr.
- VA: auto cheapest-LIVE → SA default + `merchants.payin_rail_id` ovr (kept, write-through).
- PAYOUT: `payment_rails.is_default_payout` + `merchants.payout_rail_id` → matrix.

**Backend:**
- Migration `backend/prisma/manual_sql/20260708_rail_routing_matrix.sql`: new tables **`rail_channel_defaults`**(channel PK→rail) + **`merchant_rail_routes`**(merchant,channel→rail); idempotent seed (CARDS←CARD_LOCAL default/Interswitch, VA←cheapest-LIVE VIRTUAL_ACCOUNT rail, PAYOUT←is_default_payout); migrate existing payin/payout overrides into rows. **Apply via psql on 176.**
- **`services/railRouting.js`** — the single resolver: `resolveRail(prisma, channel, merchant)` (override LIVE|CONFIG_ONLY → default LIVE), `getMatrix`/`getMerchantRoutes`/`setChannelDefault`/`setMerchantRoute`. **Setters write THROUGH to legacy columns** (is_default_payout / payin_rail_id / payout_rail_id / platform_rate_configs.default_rail_id) so old readers stay in sync; matrix is authoritative.
- Repointed readers: `cardRouter.resolveCardProcessor(prisma, product, merchant)` (CARDS; threaded `txn.merchant` at checkout charge+OTP), `feeEngine.resolvePayinRail` (VA, returns null if unset — no cheapest), `payouts.resolveRouteRail` (PAYOUT). `payinFinalize` passes merchant.
- Payout SA writers (funding route-set, `/admin/merchant-routing` PUT, `/admin/default-rail` PUT) now call railRouting setters (single source).
- New API **`routes/rail-routing.js`** @ `/api/v1/routing/*` (GET /matrix, PUT /defaults/:channel, GET /merchants, GET /merchant/:id, PUT /merchant/:id/:channel), guarded-mount `MODULE_ROUTING_ENABLED` in registry.
- Prisma models `RailChannelDefault`+`MerchantRailRoute` added (raw-SQL accessed → client regen NOT strictly required; schema kept in sync).

**Frontend:** new SA **Rail Routing Matrix** page (nav `sa_rail_routing`, icon route): channel-defaults card + per-merchant per-channel override table. `app.js`→v109, `api-wiring.js`→v119, dashboard.html cache-bust bumped. (Old "Merchant Funding & Routing" page kept — payout funding + payout route, now write-through consistent.)

**Verified:** node -c clean, prisma validate ok, all modules require-load (no circular dep). **NOT deployed.** Deploy = apply SQL on 176 + pm2 reload + frontend GH Action.

**📄 Rail Cost sheet (`C:/Users/Goke/Desktop/Rail Cost.xlsx`, reviewed 2026-07-08) — cost TO US per channel:** PalmPay: Card **not available**, VA 0.6% cap ₦600, Payout ₦5 on-us / ₦12 other. Parallex: **Card 0.75% cap ₦2000**, VA ₦8/successful call, Payout ₦3 on-us / ₦8 other. Merchant price (Paylode config): Card 1.5% cap ₦2000, VA 1% cap ₦1500 min ₦12, Payout ₦10 on-us / ₦20 other. **KEY: Parallex is the CARD rail (PalmPay can't do cards).** These cost rows still need seeding into `rail_costs` per channel before Parallex carries live card/VA/payout.

**🟢 2026-07-09 — COSTS + MERCHANT PRICING SEEDED (PR #102, `chore/parallex-costs-merchant-pricing`, NOT deployed).** Two manual_sql seeds (apply on 176 after money sign-off; config only, no routing/status change): (1) `20260709_parallex_rail_costs.sql` — Parallex cost TO US: VA ₦8 flat (flat_fee 800), CARD 0.75% cap ₦2000 (rate 0.00750/cap 200000; cards go live LATER), payout ₦3 on-us/₦8 other → payment_rails.payout_flat_cost_onus 300/payout_flat_cost 800. Versioned upsert (expires prior active Parallex row). (2) `20260709_merchant_pricing_config.sql` — platform_rate_configs CARD_LOCAL 1.5%/cap2000, VIRTUAL_ACCOUNT 1%/cap1500/min1200, PAYOUT ₦20/PAYOUT_ONUS ₦10 — **ON CONFLICT DO NOTHING** (establish-if-absent, never overwrites live pricing; ask before forcing to sheet values). **Going live w/ VA+payouts on Parallex (Goke 2026-07-09), cards later.**
**✅ FIXED 2026-07-09 (PR #103, `fix/payin-cost-rail-flat-min`).** `computeFeesForPayin`+`computeFeesForTxn` now do `raw=rate×amt+flat → cap(ceiling) → min(floor)` on BOTH merchant fee and rail cost; `resolvePayinRateConfig` returns `merchantMinCharge/railFlatFee/railMinCharge`. Closes the ₦8-flat-VA-cost + ₦12-VA-min holes (verified: ₦5k→fee₦50/rail₦8/margin₦42; ₦500→fee floored ₦12). New cfg fields default 0 → back-compat. Cards get same handling, ready when the card rate-config builder supplies the fields. **Per-merchant RAIL COST was explicitly DROPPED (Goke 2026-07-09): rail cost kicks in from ROUTING, not per-merchant.** (merchant PRICING keeps default `platform_rate_configs` + per-merchant `merchant_rate_configs`.) Latent-only: `formatRailResult` reads `rail.fee_cap` vs actual col `cap` (routeTransaction path, unused by payin).

Links [[project-merchant-routing]], [[project-parallex-integration]], [[project-payout-auto-dispatch]].
