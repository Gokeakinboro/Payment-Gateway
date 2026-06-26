-- Applied to production 2026-06-13. Table for public KYC/KYB onboarding applications.
CREATE TABLE IF NOT EXISTS onboarding_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text UNIQUE NOT NULL,
  form_type       text NOT NULL,
  applicant_type  text,
  status          text NOT NULL DEFAULT 'pending',
  business_name   text,
  contact_email   text,
  contact_phone   text,
  reg_number      text,
  tin             text,
  data            jsonb NOT NULL DEFAULT '{}',
  principals      jsonb NOT NULL DEFAULT '[]',
  documents       jsonb NOT NULL DEFAULT '[]',
  pep_flag        boolean NOT NULL DEFAULT false,
  sanctions_hit   boolean NOT NULL DEFAULT false,
  risk_level      text NOT NULL DEFAULT 'medium',
  screening_notes jsonb,
  signature       text,
  referred_by     text,
  reviewed_by     uuid,
  review_notes    text,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_submissions_status_idx    ON onboarding_submissions(status);
CREATE INDEX IF NOT EXISTS onboarding_submissions_form_type_idx ON onboarding_submissions(form_type);
