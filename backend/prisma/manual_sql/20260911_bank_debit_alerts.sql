-- Bank debit alert emails parsed from Parallex (alerts@parallexbank.com).
-- Each row = one "Transaction Alert" email for account 1000362849.
-- Reconciled against rail_disbursements to detect any debit not originating from Paylode.

CREATE TABLE IF NOT EXISTS bank_debit_alerts (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source                  TEXT        NOT NULL DEFAULT 'parallex',
  imap_message_id         TEXT        UNIQUE NOT NULL,    -- IMAP UID — dedup key
  amount_kobo             BIGINT      NOT NULL,           -- always positive (debit amount)
  description             TEXT,                           -- raw Description field from email
  beneficiary_name        TEXT,                           -- extracted from description
  tx_reference            TEXT,                           -- Parallex Transaction Reference field
  alert_at                TIMESTAMPTZ,                    -- parsed "Date and Time" field
  available_balance_naira NUMERIC(18,2),
  current_balance_naira   NUMERIC(18,2),
  -- reconciliation
  matched_rd_id           UUID,                           -- rail_disbursements.id when matched
  match_status            TEXT        NOT NULL DEFAULT 'UNMATCHED', -- MATCHED | UNMATCHED | IGNORED
  match_note              TEXT,
  raw_text                TEXT,                           -- full plain-text body for audit
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bda_alert_at      ON bank_debit_alerts(alert_at);
CREATE INDEX IF NOT EXISTS idx_bda_match_status  ON bank_debit_alerts(match_status);
CREATE INDEX IF NOT EXISTS idx_bda_source        ON bank_debit_alerts(source);
