-- Migration: merchant rate configs, aggregator rate overrides, sub-merchant outlets

-- 1. Sub-merchant outlets: self-referential FK on merchants
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS parent_merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_outlet          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outlet_name        TEXT;

CREATE INDEX IF NOT EXISTS merchants_parent_merchant_idx ON merchants(parent_merchant_id);

-- 2. Merchant rate configs (per-merchant per-channel overrides)
CREATE TABLE IF NOT EXISTS merchant_rate_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  channel       VARCHAR(20) NOT NULL,   -- CARD | BANK_TRANSFER | USSD | DIRECT_DEBIT | ALL
  rate          DECIMAL(6,5) NOT NULL,  -- e.g. 0.01500 = 1.5%
  flat_fee      BIGINT NOT NULL DEFAULT 0,   -- kobo (added on top of percentage fee)
  cap           BIGINT NOT NULL DEFAULT 0,   -- kobo, 0 = no cap
  notes         TEXT,
  set_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT merchant_rate_configs_unique UNIQUE (merchant_id, channel)
);
CREATE INDEX IF NOT EXISTS merchant_rate_configs_merchant_idx ON merchant_rate_configs(merchant_id);

-- 3. Aggregator rate configs (per-aggregator, optionally per-merchant split override)
--    merchant_id NULL = default override for all this aggregator's merchants
CREATE TABLE IF NOT EXISTS aggregator_rate_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregator_id   UUID NOT NULL REFERENCES aggregators(id) ON DELETE CASCADE,
  merchant_id     UUID REFERENCES merchants(id) ON DELETE CASCADE,
  split_pct       DECIMAL(5,4) NOT NULL,  -- e.g. 0.3000 = 30%
  notes           TEXT,
  set_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT aggregator_rate_configs_unique UNIQUE (aggregator_id, merchant_id)
);
CREATE INDEX IF NOT EXISTS aggregator_rate_configs_agg_idx ON aggregator_rate_configs(aggregator_id);
