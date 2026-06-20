-- Destination-tiered payout RAIL COST (what the rail charges us per transfer).
-- payout_flat_cost stays the OTHER-bank cost; add payout_flat_cost_onus for the
-- cheaper on-us (PalmPay) cost. Both editable via Rail Configuration afterwards.
ALTER TABLE payment_rails
  ADD COLUMN IF NOT EXISTS payout_flat_cost_onus BIGINT NOT NULL DEFAULT 0;

-- Seed PalmPay's agreed costs (kobo): ₦12 other-bank (1200), ₦5 on-us (500).
-- Only touches the PalmPay rail; other rails keep their existing/zero values.
UPDATE payment_rails
SET payout_flat_cost      = 1200,
    payout_flat_cost_onus = 500,
    updated_at            = NOW()
WHERE name = 'PalmPay';
