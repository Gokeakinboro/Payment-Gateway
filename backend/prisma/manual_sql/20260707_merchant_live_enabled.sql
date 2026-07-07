-- Go-Live gate (2026-07-07): activation (is_active) grants portal + SANDBOX access
-- only. Live processing — live keys for BOTH collections and payouts — additionally
-- requires live_enabled, which an SA/Admin flips via the "Go Live" button. So being
-- activated no longer means a merchant can move real money.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS live_enabled boolean NOT NULL DEFAULT false;

-- Backfill: every CURRENTLY-active merchant stays live (zero disruption to anyone
-- already processing, including Bucksnostar). Only NEW activations from here on start
-- in sandbox and must be explicitly taken live.
UPDATE merchants SET live_enabled = true WHERE is_active = true;
