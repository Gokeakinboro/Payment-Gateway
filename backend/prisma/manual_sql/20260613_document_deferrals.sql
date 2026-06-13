-- Applied to production 2026-06-13. Backing table for the document-deferral feature
-- (routes/deferrals.js + services/deferralExpiryService.js use raw SQL against this).
CREATE TABLE IF NOT EXISTS document_deferrals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  deferred_by     uuid,
  duration_months integer NOT NULL,
  reason          text,
  deferred_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_deferrals_entity_idx ON document_deferrals(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS document_deferrals_status_idx ON document_deferrals(status);
