-- MPGS / Parallex Bank Merchant Onboarding Portal
-- Separate self-service portal for sub-merchants / aggregators to submit
-- documents and forms for MPGS onboarding via Paylode as Payment Facilitator.

CREATE TYPE "MpgsPortalStatus" AS ENUM (
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED',
  'APPROVED', 'REJECTED', 'SENT_TO_BANK'
);

CREATE TYPE "MpgsDocStatus" AS ENUM (
  'PENDING', 'ACCEPTED', 'REJECTED', 'REUPLOAD_REQUESTED'
);

CREATE TABLE IF NOT EXISTS mpgs_applicants (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT        NOT NULL UNIQUE,
  password_hash        TEXT        NOT NULL,
  first_name           TEXT        NOT NULL,
  last_name            TEXT        NOT NULL,
  company_name         TEXT,
  is_email_verified    BOOLEAN     NOT NULL DEFAULT FALSE,
  email_verify_token   TEXT,
  email_verify_expiry  TIMESTAMPTZ,
  password_reset_token TEXT,
  password_reset_expiry TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mpgs_applications (
  id               UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     UUID              NOT NULL UNIQUE REFERENCES mpgs_applicants(id),
  status           "MpgsPortalStatus" NOT NULL DEFAULT 'DRAFT',
  questionnaire    JSONB,
  application_form JSONB,
  quest_draft      JSONB,
  form_draft       JSONB,
  submitted_at     TIMESTAMPTZ,
  sent_to_bank_at  TIMESTAMPTZ,
  sent_to_bank_by  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mpgs_documents (
  id             UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID           NOT NULL REFERENCES mpgs_applications(id),
  doc_key        TEXT           NOT NULL,
  doc_label      TEXT           NOT NULL,
  filename       TEXT           NOT NULL,
  filepath       TEXT           NOT NULL,
  mimetype       TEXT           NOT NULL,
  filesize       INTEGER        NOT NULL,
  status         "MpgsDocStatus" NOT NULL DEFAULT 'PENDING',
  uploaded_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, doc_key)
);

CREATE TABLE IF NOT EXISTS mpgs_comments (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID        NOT NULL REFERENCES mpgs_applications(id),
  author_name    TEXT        NOT NULL,
  content        TEXT        NOT NULL,
  is_internal    BOOLEAN     NOT NULL DEFAULT FALSE,
  sent_by_email  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS mpgs_applications_status_idx  ON mpgs_applications(status);
CREATE INDEX IF NOT EXISTS mpgs_applications_updated_idx ON mpgs_applications(updated_at DESC);
CREATE INDEX IF NOT EXISTS mpgs_documents_app_idx        ON mpgs_documents(application_id);
CREATE INDEX IF NOT EXISTS mpgs_comments_app_idx         ON mpgs_comments(application_id);
