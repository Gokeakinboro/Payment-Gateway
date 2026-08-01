---
name: session-2026-07-20-mpgs-gateway-build
description: ✅ Session 2026-07-20 — Parallex MPGS card gateway built (NOT deployed)
metadata: 
  node_type: memory
  type: project
  originSessionId: 313bc510-85d5-4ee3-b9c7-d132bad21078
---

Full MPGS card-payment middleware built in one session. Code on working tree, not committed or deployed.

## What was built

**Trigger:** Parallex Bank onboarding PDF — Paylode must submit merchant docs → Parallex issues MID → Paylode issues merchant "connection parameters" → Paylode acts as crawler/transformer between merchant and MPGS.

**Key architectural decision mid-session:** URLs must mimic MPGS exactly so merchants use standard Mastercard MPGS SDK/documentation. Only the host URL changes. This replaced the initial `POST /api/v1/mpgs/charge` design with a proper MPGS-mirrored gateway.

**Confirmed by Goke this session:**
- ✅ 3DS handled by MPGS (not Paylode)
- ✅ Each merchant gets their own MID + API password from Parallex
- ✅ Clean silo — new `/api/rest` prefix, not mixed into `/api/v1/checkout`
- ⏳ Rail cost % — Goke will advise
- ⏳ MPGS base URL from Parallex — pending

## Files changed (all on working tree, not committed)

**New:**
- `prisma/migrations/20260720_merchant_mpgs_config.sql`
- `prisma/migrations/20260720_mpgs_gateway_auth.sql`
- `services/parallexMpgsService.js`
- `routes/mpgs-gateway.js` (MPGS-mirrored, mounted at `/api/rest`)
- `test/mpgs-gateway-smoke.js`
- `docs/mpgs-merchant-integration.md`

**Modified:**
- `prisma/schema.prisma` — `MerchantMpgsConfig` model + `mpgsConfig` relation on `Merchant`
- `routes/mpgs.js` — rewritten: SA admin only, gateway password generation/rotation, no `/charge`
- `modules/registry.js` — two new entries: `mpgs` + `mpgs-gateway`

## Two-password model (important)
Parallex issues: `mpgs_api_password` (real MPGS credential, stored in DB, never shown to merchant).
Paylode generates: `gateway_api_password` (shown ONCE at setup, hashed in DB — what merchant uses).
SA runs `POST /api/v1/mpgs/admin/:merchantId/rotate-password` if merchant credential is compromised.

## MPGS docs situation
`https://ap-gateway.mastercard.com/...` is a JS SPA. WebFetch only returns shell HTML. Cannot be read automatically. Must be shared as PDF or copy-paste. Standard MPGS REST API is well-known — built against that.

## Next session: what to do
1. Create PR branch + commit all changes
2. Wait for Parallex MPGS base URL before deploying
3. Wait for rail cost % from Goke → add to `railCost` on transactions
4. Build post-3DS callback endpoint once Parallex confirms webhook shape
5. Run migrations on 176 + prisma generate + deploy
6. Run smoke test: `node test/mpgs-gateway-smoke.js`

See full detail at [[kiv-parallex-mpgs-card-rail]].
