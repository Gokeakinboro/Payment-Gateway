-- Merchant payout routing (PR1 — config only, no disbursement change).
-- Two-tier route: a GLOBAL default rail for all merchants, plus an optional
-- per-merchant override. SA sets the per-merchant route each time a merchant
-- funds; null override falls back to the global default. SA may pick ANY live rail.

-- Global default route = a flag on payment_rails (exactly one rail true).
ALTER TABLE payment_rails ADD COLUMN IF NOT EXISTS is_default_payout BOOLEAN NOT NULL DEFAULT false;

-- Per-merchant route override (null = use the global default).
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS payout_rail_id UUID NULL REFERENCES payment_rails(id);

-- Only one rail may be the default at a time.
CREATE UNIQUE INDEX IF NOT EXISTS payment_rails_one_default
  ON payment_rails (is_default_payout) WHERE is_default_payout = true;

-- Seed the current default = PalmPay (the only live payout rail today), if present
-- and nothing is flagged yet.
UPDATE payment_rails
   SET is_default_payout = true
 WHERE name ILIKE 'palmpay'
   AND NOT EXISTS (SELECT 1 FROM payment_rails WHERE is_default_payout = true);
