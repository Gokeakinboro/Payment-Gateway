-- Paymula P1: merchant opt-in for public member self-registration.
-- When true, the club/merchant is discoverable in the Paymula app and the public
-- can join it as members (members complete KYC). Default off = invite-only.
ALTER TABLE mw_config ADD COLUMN IF NOT EXISTS allow_public_members boolean NOT NULL DEFAULT false;
