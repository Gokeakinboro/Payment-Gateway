-- Applied 2026-06-13. First-time-password enforcement: users created by SA /
-- onboarding get a temp password and must change it before doing anything else.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
