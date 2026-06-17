-- Single merchant balance + rail float (2026-06-17)
-- Collapse per-rail merchant wallets into ONE balance per merchant, and add
-- OUR float (balance held with each rail) to payment_rails.

-- One wallet row per merchant (rails are internal; funding is not per rail).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merchant_wallets_merchant_id_key') THEN
    ALTER TABLE merchant_wallets ADD CONSTRAINT merchant_wallets_merchant_id_key UNIQUE (merchant_id);
  END IF;
END $$;

-- OUR balance held with each rail (kobo) + last-synced timestamp. Internal only.
ALTER TABLE payment_rails ADD COLUMN IF NOT EXISTS float_balance   BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payment_rails ADD COLUMN IF NOT EXISTS float_synced_at TIMESTAMPTZ;
