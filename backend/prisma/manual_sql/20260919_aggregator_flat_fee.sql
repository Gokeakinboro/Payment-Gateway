-- Add flat_fee (payout per-item charge) to aggregator_rate_configs.
-- flat_fee (kobo): what the aggregator charges their merchant per payout.
-- Must be >= Paylode's platform PAYOUT flat_fee. Aggregator earns the spread.
-- Default 0 = use Paylode's platform rate (no aggregator markup).

ALTER TABLE aggregator_rate_configs
  ADD COLUMN IF NOT EXISTS flat_fee bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN aggregator_rate_configs.flat_fee
  IS 'Aggregator-set payout flat fee (kobo) charged to merchant. 0 = use platform default.';
