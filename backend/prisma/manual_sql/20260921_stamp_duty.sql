-- Stamp duty per-rail config and per-payout-item accrual/collection tracking.
-- stamp_duty_active = false (Parallex now): accrue but do NOT debit merchant wallet.
-- stamp_duty_active = true  (any rail that deducts): collect from merchant wallet.
-- stamp_duty_kobo on payout_items is ALWAYS written for eligible txns (amount >= threshold)
-- regardless of whether the rail charges — gives full retroactive reconciliation trail.
-- Applied: 2026-09-21

ALTER TABLE payment_rails
  ADD COLUMN IF NOT EXISTS stamp_duty_active         bool    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stamp_duty_kobo           int     NOT NULL DEFAULT 5000,          -- ₦50 in kobo
  ADD COLUMN IF NOT EXISTS stamp_duty_threshold_kobo bigint  NOT NULL DEFAULT 1000000;        -- ₦10,000 in kobo

ALTER TABLE payout_items
  ADD COLUMN IF NOT EXISTS stamp_duty_kobo     bigint  NOT NULL DEFAULT 0,   -- accrued amount (always set if eligible)
  ADD COLUMN IF NOT EXISTS stamp_duty_deducted bool    NOT NULL DEFAULT false; -- true = actually taken from merchant wallet

ALTER TABLE payout_batches
  ADD COLUMN IF NOT EXISTS total_stamp_duty    bigint  NOT NULL DEFAULT 0;   -- sum of deducted stamp duty for this batch

CREATE INDEX IF NOT EXISTS payout_items_stamp_duty_idx
  ON payout_items(stamp_duty_deducted, stamp_duty_kobo)
  WHERE stamp_duty_kobo > 0;
