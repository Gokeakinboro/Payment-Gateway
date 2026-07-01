-- Paymula P2: member self-registration KYC capture.
-- Stores the member's verified identity (NIN/BVN) + address on their membership.
-- NOTE: raw NIN/BVN stored for now; encrypt-at-rest is a hardening follow-up.
ALTER TABLE mw_members ADD COLUMN IF NOT EXISTS nin             text;
ALTER TABLE mw_members ADD COLUMN IF NOT EXISTS bvn             text;
ALTER TABLE mw_members ADD COLUMN IF NOT EXISTS address         text;
ALTER TABLE mw_members ADD COLUMN IF NOT EXISTS kyc_verified    boolean NOT NULL DEFAULT false;
ALTER TABLE mw_members ADD COLUMN IF NOT EXISTS kyc_verified_at timestamptz;
