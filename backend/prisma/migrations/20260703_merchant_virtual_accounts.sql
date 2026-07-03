-- Static (reserved) merchant virtual accounts.
-- Read via raw SQL in modules/gateway-core/routes/palmpay-webhook.js (handleVaCashin,
-- static-VA branch): SELECT merchant_id FROM merchant_virtual_accounts
--   WHERE va_number = $1 AND status = 'active'.
-- The table already exists in production; this idempotent migration makes fresh
-- environments (and the repo schema) complete. IF NOT EXISTS = no-op on prod.
-- NOTE: if prod's live DDL differs from below, diff before treating this as canonical.
CREATE TABLE IF NOT EXISTS merchant_virtual_accounts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  va_number   text        NOT NULL,
  status      text        NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_virtual_accounts_va_number_key
  ON merchant_virtual_accounts (va_number);
CREATE INDEX IF NOT EXISTS merchant_virtual_accounts_merchant_id_idx
  ON merchant_virtual_accounts (merchant_id);
