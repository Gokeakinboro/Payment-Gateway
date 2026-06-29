-- Payment links: optional merchant-charged 7.5% VAT (added on top of the amount
-- the customer pays, mirroring Invoice & Collect's charge_vat). Idempotent.
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS charge_vat boolean NOT NULL DEFAULT false;
