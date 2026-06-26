-- Migration: YouVerify automated KYC check columns on kyc_submissions

ALTER TABLE kyc_submissions
  ADD COLUMN IF NOT EXISTS bvn_check_status  TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS nin_check_status  TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS cac_check_status  TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS yv_bvn_ref        TEXT,
  ADD COLUMN IF NOT EXISTS yv_nin_ref        TEXT,
  ADD COLUMN IF NOT EXISTS yv_cac_ref        TEXT,
  ADD COLUMN IF NOT EXISTS bvn_data          JSONB,
  ADD COLUMN IF NOT EXISTS nin_data          JSONB,
  ADD COLUMN IF NOT EXISTS cac_data          JSONB;

-- bvn_check_status / nin_check_status / cac_check_status values:
--   pending | running | verified | failed | not_required
