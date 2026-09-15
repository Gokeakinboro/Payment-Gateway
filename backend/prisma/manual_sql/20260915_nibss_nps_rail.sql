-- Register the NIBSS NPS rail so SA can see it and route to it once certified.
--
-- SAFE TO APPLY BEFORE INTEGRATION IS FINISHED:
--   status = 'CONFIG_ONLY'   → railRouting.resolveRail only returns LIVE rails,
--                              so this rail cannot receive traffic yet.
--   payout_enabled = false   → excluded from railFloat.syncAllFloats (no balance
--                              polling against an endpoint we can't reach yet).
--   is_default_payout = false→ the global default payout route is UNCHANGED.
--
-- Nothing here alters existing rails, routing or pricing. Idempotent: re-running
-- is a no-op, and it will NOT overwrite the row once SA flips it to TESTING/LIVE.
--
-- Costs are deliberately NOT seeded into rail_costs — NIBSS has not advised
-- pricing yet. Seed them (and flip status) only after commercials are agreed;
-- see project-nibss-nps-integration in .claude/memory.
--
-- Apply on 176:  psql "$DATABASE_URL" -f 20260915_nibss_nps_rail.sql

INSERT INTO payment_rails (name, status, payout_enabled, is_default_payout, sponsor_bank, notes)
VALUES (
  'NIBSS NPS',
  'CONFIG_ONLY',
  false,
  false,
  'NIBSS (direct, via sponsor bank)',
  'ISO 20022 National Payment Stack — successor to NIP. Payouts (pacs.008), virtual accounts (camt.054) and identity (BVN/RC/TIN). Integration in progress: awaiting IP allowlisting, sandbox credentials and pricing. Adapter: modules/gateway-core/services/nibssNpsService.js.'
)
ON CONFLICT (name) DO NOTHING;
