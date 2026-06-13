-- Applied 2026-06-13. Links an approved onboarding application to the merchant it
-- provisioned. Used as the idempotency anchor so re-approval never duplicates.
ALTER TABLE onboarding_submissions ADD COLUMN IF NOT EXISTS merchant_id uuid;
