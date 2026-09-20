-- Aggregator rate config v2: channel-aware, full fee model (rate+flat_fee+min_charge+max_charge).
-- Previous migration (20260919_aggregator_flat_fee.sql) added flat_fee.
-- This one brings it in line with merchant_rate_configs.

-- Step 1: rename split_pct → rate (table is empty so no data migration needed)
ALTER TABLE aggregator_rate_configs RENAME COLUMN split_pct TO rate;

-- Step 2: add new columns
ALTER TABLE aggregator_rate_configs
  ADD COLUMN IF NOT EXISTS channel    VARCHAR(30) NOT NULL DEFAULT 'VIRTUAL_ACCOUNT',
  ADD COLUMN IF NOT EXISTS min_charge BIGINT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_charge BIGINT      NOT NULL DEFAULT 0;

-- Step 3: drop old unique constraint on (aggregator_id, merchant_id), replace with (agg, merchant, channel)
ALTER TABLE aggregator_rate_configs
  DROP CONSTRAINT IF EXISTS aggregator_rate_configs_aggregator_id_merchant_id_key;

ALTER TABLE aggregator_rate_configs
  ADD CONSTRAINT aggregator_rate_configs_agg_merchant_channel_key
  UNIQUE (aggregator_id, merchant_id, channel);

-- Comments
COMMENT ON COLUMN aggregator_rate_configs.rate       IS 'Aggregator-set rate (%) for this channel. 0 if flat-fee only.';
COMMENT ON COLUMN aggregator_rate_configs.channel    IS 'Channel this config applies to: VIRTUAL_ACCOUNT or PAYOUT';
COMMENT ON COLUMN aggregator_rate_configs.flat_fee   IS 'Per-txn flat fee (kobo) charged to merchant. 0 = none.';
COMMENT ON COLUMN aggregator_rate_configs.min_charge IS 'Minimum fee (kobo). Enforced when rate > 0 and fee < min.';
COMMENT ON COLUMN aggregator_rate_configs.max_charge IS 'Fee cap (kobo). 0 = no cap. SA may restrict this.';
