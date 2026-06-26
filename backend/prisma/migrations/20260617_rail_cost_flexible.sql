-- Flexible rail-cost model (2026-06-17): a cost can be % and/or flat ₦, with an
-- optional max cap and/or min charge. Adds the missing columns the cost form needs.
ALTER TABLE rail_costs ADD COLUMN IF NOT EXISTS service_type TEXT;
ALTER TABLE rail_costs ADD COLUMN IF NOT EXISTS flat_fee     BIGINT NOT NULL DEFAULT 0;   -- flat ₦ per txn (kobo)
ALTER TABLE rail_costs ADD COLUMN IF NOT EXISTS cap          BIGINT NOT NULL DEFAULT 0;   -- max cap on the fee (kobo); 0 = none
ALTER TABLE rail_costs ADD COLUMN IF NOT EXISTS min_charge   BIGINT NOT NULL DEFAULT 0;   -- min charge (kobo); 0 = none
ALTER TABLE rail_costs ADD COLUMN IF NOT EXISTS vat_rate     NUMERIC(6,5) NOT NULL DEFAULT 0.075;

-- Active cost is unique per (rail, service_type, period) — not per channel
-- (VISA + MASTERCARD both map to channel CARD and must coexist).
ALTER TABLE rail_costs DROP CONSTRAINT IF EXISTS rail_costs_rail_id_channel_effective_from_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rail_costs_rail_service_period_key') THEN
    ALTER TABLE rail_costs ADD CONSTRAINT rail_costs_rail_service_period_key UNIQUE (rail_id, service_type, effective_from);
  END IF;
END $$;
