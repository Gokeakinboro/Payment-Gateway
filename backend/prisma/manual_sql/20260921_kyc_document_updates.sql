-- Merchant KYC document update requests — immutable audit trail.
-- Each row = one merchant-submitted update (pending/approved/rejected).
-- Approved rows write the new file to kyc_documents; previous_file_path snapshots the old one.
-- Old rows are NEVER deleted — full history always visible to admin.
-- Applied: 2026-09-21

CREATE TABLE IF NOT EXISTS kyc_document_updates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id         uuid NOT NULL,
  kyc_document_id     uuid,                              -- null = new doc type not yet in kyc_documents
  doc_key             text NOT NULL,
  doc_label           text NOT NULL,
  file_path           text,                              -- path to uploaded file
  merchant_notes      text,
  status              text NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  admin_notes         text,
  reviewed_by         uuid,
  previous_file_path  text,                              -- snapshot of old file before approval
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kyc_doc_updates_merchant_idx ON kyc_document_updates(merchant_id);
CREATE INDEX IF NOT EXISTS kyc_doc_updates_status_idx   ON kyc_document_updates(status);
CREATE INDEX IF NOT EXISTS kyc_doc_updates_doc_idx      ON kyc_document_updates(kyc_document_id);
