-- Itemized invoicing (Phase 1): per-department item catalog, department service
-- charge, and optional per-document service charge on invoices. Idempotent.

-- Catalog items belong to a department (NULL department_id = merchant-wide, pickable
-- by any department). Editable → track updated_at.
ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES inv_departments(id) ON DELETE CASCADE;
ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS inv_products_department_idx ON inv_products(department_id);

-- Merchant-fixed service charge, per department. mode = 'total_line' (one line on the
-- invoice total) | 'per_item' (baked into each item's shown cost). VAT-EXEMPT: VAT is
-- computed on the item subtotal only, never on the service charge.
ALTER TABLE inv_departments ADD COLUMN IF NOT EXISTS service_charge_pct  numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE inv_departments ADD COLUMN IF NOT EXISTS service_charge_mode text NOT NULL DEFAULT 'total_line';

-- Invoice: service charge is OPTIONAL per document (toggle at create). service_charge_amount
-- is the computed kobo value; it is included in `amount` (excl VAT) but NOT in the VAT base.
-- (charge_vat already exists and is likewise optional per document.)
-- line_items jsonb (already present) now carries the itemized shape:
--   [{ product_id?, name, unit_amount, quantity, amount }]  (amount = unit_amount*quantity, base/pre-service)
ALTER TABLE inv_invoices ADD COLUMN IF NOT EXISTS apply_service_charge  boolean NOT NULL DEFAULT false;
ALTER TABLE inv_invoices ADD COLUMN IF NOT EXISTS service_charge_amount bigint  NOT NULL DEFAULT 0;
