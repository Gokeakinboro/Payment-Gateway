-- Bank reconciliation: statement lines uploaded (CSV/XLS) for a merchant, matched
-- against that merchant's settlements (batch-aware: 1 bank credit ↔ 1 settlement net).
-- Raw-SQL table (team convention for new tables), accessed via $queryRawUnsafe.
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id           uuid NOT NULL REFERENCES merchants(id),
  upload_batch          uuid NOT NULL,
  txn_date              date,
  credit_kobo           bigint NOT NULL DEFAULT 0,
  debit_kobo            bigint NOT NULL DEFAULT 0,
  narration             text,
  balance_kobo          bigint,
  match_status          text NOT NULL DEFAULT 'unmatched',  -- matched | partial | unmatched | ignored
  matched_settlement_id uuid REFERENCES settlements(id),
  match_note            text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_lines_merchant   ON bank_statement_lines(merchant_id);
CREATE INDEX IF NOT EXISTS idx_bank_lines_status     ON bank_statement_lines(match_status);
CREATE INDEX IF NOT EXISTS idx_bank_lines_batch      ON bank_statement_lines(upload_batch);
CREATE INDEX IF NOT EXISTS idx_bank_lines_settlement ON bank_statement_lines(matched_settlement_id);
