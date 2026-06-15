-- Applied 2026-06-15. Payout per-rail wallets (#payout twist).
-- Greenfield: merchant_wallets is empty + all rails CONFIG_ONLY, so no balance
-- migration is needed; we just add columns + swap the uniqueness key.

-- Mark which rails Paylode can send payouts through (internal only).
ALTER TABLE payment_rails    ADD COLUMN IF NOT EXISTS payout_enabled BOOLEAN NOT NULL DEFAULT false;

-- Per-rail balance: a merchant holds one wallet row per payout rail.
ALTER TABLE merchant_wallets ADD COLUMN IF NOT EXISTS rail_id      UUID REFERENCES payment_rails(id);
ALTER TABLE merchant_wallets ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP;
ALTER TABLE wallet_ledger    ADD COLUMN IF NOT EXISTS rail_id      UUID REFERENCES payment_rails(id);

-- Swap uniqueness: one-balance-per-merchant -> one-per-(merchant, rail).
ALTER TABLE merchant_wallets DROP CONSTRAINT IF EXISTS merchant_wallets_merchant_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS merchant_wallets_merchant_id_rail_id_key
  ON merchant_wallets (merchant_id, rail_id);
