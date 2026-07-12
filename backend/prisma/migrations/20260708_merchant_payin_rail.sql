-- Per-merchant pay-in rail override (null = fall back to global cheapest-LIVE).
-- CONFIG_ONLY status is allowed for pay-in overrides so a test rail can be used
-- on a single merchant without affecting any other merchant's live collections.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS payin_rail_id UUID NULL REFERENCES payment_rails(id);
