-- Applied 2026-06-14. #5: hold a merchant's settlement-account change as PENDING
-- until admin/SA approval (do not overwrite the live settlement fields on submit).
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pending_settlement_bank          TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pending_settlement_account       TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pending_settlement_account_name  TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pending_settlement_at            TIMESTAMP;
