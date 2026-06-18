-- Rejection checklist for onboarding submissions.
-- Which required documents / information items the reviewer flagged as missing or
-- unacceptable when rejecting an application. Surfaced to the merchant (My Application)
-- so they know exactly what to fix before resubmitting.
--
-- RUN AS THE APP USER (paylode) so the table stays paylode-owned:
--   PGPASSWORD=PaylodeSecure2025 psql -h 127.0.0.1 -U paylode -d paylode_db -f this.sql
ALTER TABLE onboarding_submissions
  ADD COLUMN IF NOT EXISTS missing_items jsonb;
