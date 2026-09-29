-- 2026-09-17: Add client_ref to payout_items for merchant idempotency key lookups.
-- Merchants can pass their own order reference per item; unique per merchant.
ALTER TABLE payout_items
  ADD COLUMN IF NOT EXISTS client_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS payout_items_merchant_client_ref_uq
  ON payout_items (merchant_id, client_ref)
  WHERE client_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS payout_items_client_ref_idx
  ON payout_items (client_ref)
  WHERE client_ref IS NOT NULL;
