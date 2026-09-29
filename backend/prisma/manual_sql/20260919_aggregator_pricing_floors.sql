-- Per-aggregator pricing floors, overriding global platform_rate_configs.
-- NULL = inherit platform default. SA sets these; aggregator sees effective value.

ALTER TABLE aggregators
  ADD COLUMN IF NOT EXISTS payout_floor_kobo BIGINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS va_cap_kobo        BIGINT DEFAULT NULL;

COMMENT ON COLUMN aggregators.payout_floor_kobo IS
  'Payout flat fee (kobo) Paylode charges THIS aggregator. NULL = use platform PAYOUT flat_fee.';
COMMENT ON COLUMN aggregators.va_cap_kobo IS
  'Max VA collection fee (kobo) for THIS aggregator''s merchants. NULL = use platform VIRTUAL_ACCOUNT cap.';
