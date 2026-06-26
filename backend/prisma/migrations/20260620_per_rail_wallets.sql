-- Per-(merchant, rail) payout wallet balances.
-- Payouts are pre-funded PER RAIL: a merchant deposits into the rail/bank we tell
-- them to fund, and we credit their gateway balance for THAT rail. This replaces
-- the single-balance-per-merchant model with one row per (merchant, rail).
--
-- Safe because the old unique guaranteed exactly one row per merchant, so the
-- null-rail backfill onto the live PalmPay rail can never collide with an existing
-- PalmPay row for the same merchant. Idempotent: re-running is a no-op.
BEGIN;

-- 1. Drop the single-column UNIQUE on merchant_id. On this DB it exists as a UNIQUE
--    INDEX (from an earlier prisma db push), not a constraint — so drop BOTH forms.
--    Leaving it would block per-rail rows. Also drop any dynamically-named single-col
--    unique CONSTRAINT, for parity across environments.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'merchant_wallets'::regclass AND contype = 'u'
     AND array_length(conkey, 1) = 1
     AND conkey[1] = (SELECT attnum FROM pg_attribute
                       WHERE attrelid = 'merchant_wallets'::regclass AND attname = 'merchant_id');
  IF c IS NOT NULL THEN EXECUTE 'ALTER TABLE merchant_wallets DROP CONSTRAINT ' || quote_ident(c); END IF;
END $$;

-- The legacy FK wallet_ledger.merchant_id → merchant_wallets(merchant_id) depends on
-- that unique index AND is semantically wrong (a ledger row references a MERCHANT, not
-- a wallet row — and merchant_id is no longer unique in merchant_wallets). Re-point it
-- to merchants(id) (0 orphans verified) so the single-column unique can be dropped.
ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_merchant_id_fkey;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_merchant_id_fkey
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE merchant_wallets DROP CONSTRAINT IF EXISTS merchant_wallets_merchant_id_key;
DROP INDEX IF EXISTS merchant_wallets_merchant_id_key;

-- 2. Backfill: existing balances were rail-agnostic; assign them to the only LIVE
--    payout rail (PalmPay) so nothing is stranded in a null bucket. If PalmPay is
--    absent (non-prod), rows stay null (legacy) — harmless.
UPDATE merchant_wallets
   SET rail_id = (SELECT id FROM payment_rails WHERE name = 'PalmPay' LIMIT 1),
       updated_at = NOW()
 WHERE rail_id IS NULL
   AND EXISTS (SELECT 1 FROM payment_rails WHERE name = 'PalmPay');

-- 3. Enforce one row per (merchant, rail). NULL rail_ids remain distinct in Postgres,
--    which is fine — new funding always sets rail_id and step 2 cleared the live one.
-- Guard on pg_class (relname) so it skips when the composite already exists in EITHER
-- form — a bare UNIQUE INDEX (this DB) or a constraint-backed one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'merchant_wallets_merchant_id_rail_id_key'
  ) THEN
    ALTER TABLE merchant_wallets
      ADD CONSTRAINT merchant_wallets_merchant_id_rail_id_key UNIQUE (merchant_id, rail_id);
  END IF;
END $$;

COMMIT;
