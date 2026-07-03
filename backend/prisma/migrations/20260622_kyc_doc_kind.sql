-- KYC requirements: classify each as info / document / both.
-- A requirement may be satisfied by a typed value, an uploaded document, or both;
-- `kind` drives the UI and what "complete" means. Verify/defer stays manual.
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'document';

-- Information-only items (typed value, no document): BVN/NIN/RC + the check rows.
UPDATE kyc_documents SET kind = 'info'
 WHERE doc_key IN ('bvn','nin','rc_number')
    OR doc_key LIKE 'check_%';

-- Items that take a value AND a document.
UPDATE kyc_documents SET kind = 'both'
 WHERE doc_key IN ('tin_cert','directors_id','shareholders_id','id_document');

-- Everything else keeps the 'document' default (cert_incorp, memart, status_report,
-- board_resolution, proof_address, and any custom upload-only requirement).
