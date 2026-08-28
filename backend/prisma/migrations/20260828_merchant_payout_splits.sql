-- Merchant payout split routing:
-- When rows exist in this table for a merchant, items are distributed
-- across rails proportionally (pct columns must sum to 100).
-- Falls through to merchants.payout_rail_id → is_default_payout when no splits.

CREATE TABLE merchant_payout_splits (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  rail_id     UUID        NOT NULL REFERENCES payment_rails(id) ON DELETE CASCADE,
  pct         INTEGER     NOT NULL CHECK (pct > 0 AND pct <= 100),
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (merchant_id, rail_id)
);
CREATE INDEX ON merchant_payout_splits (merchant_id) WHERE is_active = true;

-- Flip global default payout rail from PalmPay → Parallex Bank.
UPDATE payment_rails SET is_default_payout = false WHERE is_default_payout = true;
UPDATE payment_rails SET is_default_payout = true
  WHERE payout_enabled = true AND status = 'LIVE' AND name ILIKE '%parallex%';
