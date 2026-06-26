-- Applied to production 2026-06-13. Per-document KYC/KYB tracking so individual
-- outstanding/deferred documents are tracked explicitly (no more "slip through cracks").
CREATE TABLE IF NOT EXISTS kyc_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    text NOT NULL,                       -- merchant | aggregator
  entity_id      uuid NOT NULL,
  doc_key        text NOT NULL,
  doc_label      text NOT NULL,
  status         text NOT NULL DEFAULT 'outstanding', -- outstanding|submitted|verified|deferred|overdue|waived
  file_path      text,
  deferred_until timestamptz,
  deferred_by    uuid,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, doc_key)
);
CREATE INDEX IF NOT EXISTS kyc_documents_entity_idx ON kyc_documents(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS kyc_documents_status_idx ON kyc_documents(status);
CREATE INDEX IF NOT EXISTS kyc_documents_overdue_idx ON kyc_documents(status, deferred_until);
