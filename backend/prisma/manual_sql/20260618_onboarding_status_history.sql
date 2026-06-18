-- Onboarding lifecycle timeline: one entry per stage transition so we can track
-- the full onboarding cycle (submitted → under_review → rejected/resubmitted loop
-- → approved → activated) with timestamps + who did it.
--
-- RUN AS THE APP USER (paylode):
--   PGPASSWORD=PaylodeSecure2025 psql -h 127.0.0.1 -U paylode -d paylode_db -f this.sql
ALTER TABLE onboarding_submissions
  ADD COLUMN IF NOT EXISTS status_history jsonb;

-- Backfill: seed a 'submitted' entry for existing rows that have none, using their
-- submitted_at, so historical applications still render a timeline.
UPDATE onboarding_submissions
SET status_history = jsonb_build_array(
      jsonb_build_object('status','submitted','at', to_char(submitted_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'by','applicant','note',NULL))
WHERE status_history IS NULL;
