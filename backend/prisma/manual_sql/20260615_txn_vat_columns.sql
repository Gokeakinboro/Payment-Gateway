-- Applied 2026-06-15. VAT components on transactions for the monthly VAT report.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS vat_output BIGINT NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS vat_input  BIGINT NOT NULL DEFAULT 0;
