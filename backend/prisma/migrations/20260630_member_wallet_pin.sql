-- Member Wallet — transaction PIN (app-unlock + per-payment authorization).
-- PIN is bcrypt-hashed; lockout after repeated failures. Idempotent.
ALTER TABLE mw_members
  ADD COLUMN IF NOT EXISTS pin_hash         text,
  ADD COLUMN IF NOT EXISTS pin_set_at       timestamptz,
  ADD COLUMN IF NOT EXISTS pin_failed       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until timestamptz;
