-- Mastercard Rules & compliance (2026-06-15).
-- compliance_exceptions: every screening finding (merchant onboarding OR transaction)
-- that requires disposition. Mirrors kyc_documents so the SA defer/clear workflow and
-- the hourly expiry sweep reuse the same idioms.
CREATE TABLE IF NOT EXISTS compliance_exceptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    text NOT NULL,                       -- merchant | aggregator | transaction
  entity_id      uuid NOT NULL,
  rule_code      text NOT NULL,                       -- MC_PROHIBITED_MCC | MC_BRAM | MC_SANCTIONS | ...
  severity       text NOT NULL,                       -- BLOCKING | REVIEW | MONITOR
  status         text NOT NULL DEFAULT 'open',        -- open | deferred | cleared | blocked
  description    text,
  rule_ref       text,
  deferrable     boolean NOT NULL DEFAULT true,
  deferred_until timestamptz,
  deferred_by    uuid,
  reason         text,                                -- SA disposition note
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, rule_code)
);
CREATE INDEX IF NOT EXISTS compliance_exceptions_entity_idx ON compliance_exceptions(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS compliance_exceptions_status_idx ON compliance_exceptions(status);
CREATE INDEX IF NOT EXISTS compliance_exceptions_overdue_idx ON compliance_exceptions(status, deferred_until);

-- Merchant compliance columns: structured MCC, card-acceptance scope (drives the
-- local-vs-international compliance matrix), rolled-up compliance status, MATCH flag.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS mcc text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS card_acceptance_scope text NOT NULL DEFAULT 'local';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS compliance_status text NOT NULL DEFAULT 'clear'; -- clear|review|blocked
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS match_listed boolean NOT NULL DEFAULT false;
