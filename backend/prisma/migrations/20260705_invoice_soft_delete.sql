-- Soft-delete for invoices: a merchant may delete an UNPAID invoice; the row is
-- retained (deleted_at set) for audit and filtered out of every merchant/public
-- view. Paid / part-paid invoices are never deletable (money received).
ALTER TABLE inv_invoices ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_inv_invoices_not_deleted
  ON inv_invoices (merchant_id) WHERE deleted_at IS NULL;
