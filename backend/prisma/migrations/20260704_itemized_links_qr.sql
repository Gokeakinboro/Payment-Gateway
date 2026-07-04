-- Itemized QR codes (P2) + payment links (P3): line items + optional service charge.
-- Idempotent. Same money model as invoices: amount = items_subtotal + service_charge
-- (face, excl VAT); VAT is computed on the item subtotal only (service is VAT-exempt),
-- so the pay flow derives vat_base = amount - service_charge_amount.

-- Merchant's label for the charge — bars/drinks levy a "Sales charge" (not VAT);
-- other businesses "Service charge". Display-only; defaults to 'Service charge'.
ALTER TABLE inv_departments ADD COLUMN IF NOT EXISTS service_charge_label text NOT NULL DEFAULT 'Service charge';

-- QR codes (invoicing domain; already has department_id + charge_vat).
ALTER TABLE inv_qr_codes ADD COLUMN IF NOT EXISTS line_items            jsonb;
ALTER TABLE inv_qr_codes ADD COLUMN IF NOT EXISTS apply_service_charge  boolean NOT NULL DEFAULT false;
ALTER TABLE inv_qr_codes ADD COLUMN IF NOT EXISTS service_charge_amount bigint  NOT NULL DEFAULT 0;

-- Payment links (CORE table). department_id is a SOFT reference (no FK to the invoicing
-- inv_departments) so core stays decoupled — invoicing computes + creates the link via a
-- core hook (see src/routes/paymentLinks.js createPaymentLink). charge_vat optional per link.
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS line_items            jsonb;
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS department_id         uuid;
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS charge_vat            boolean NOT NULL DEFAULT false;
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS apply_service_charge  boolean NOT NULL DEFAULT false;
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS service_charge_amount bigint  NOT NULL DEFAULT 0;
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS vat_amount            bigint  NOT NULL DEFAULT 0;
