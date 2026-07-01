-- Invoicing: optional multiple line items per invoice.
-- [{ "description": "...", "amount": <kobo> }, ...]; invoice amount = sum of item amounts.
ALTER TABLE inv_invoices ADD COLUMN IF NOT EXISTS line_items jsonb;
