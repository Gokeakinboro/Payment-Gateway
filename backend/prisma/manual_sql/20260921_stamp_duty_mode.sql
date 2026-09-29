-- Distinguish collection modes on payment_rails.
-- stamp_duty_active   = true → collect ₦50 from merchant wallet on eligible payouts
-- stamp_duty_passthrough = true → bank already charges per-txn (no holding wallet needed)
-- stamp_duty_passthrough = false → bank will bill retroactively → park in holding wallet
--
-- Effective states:
--   active=false                          → accrual only, no collection
--   active=true, passthrough=false        → collect + park in stamp_duty_wallets (retroactive billing)
--   active=true, passthrough=true         → collect + no wallet (bank charges per-txn, direct pass-through)

ALTER TABLE payment_rails
  ADD COLUMN IF NOT EXISTS stamp_duty_passthrough bool NOT NULL DEFAULT false;
