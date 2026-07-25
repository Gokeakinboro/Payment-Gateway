-- Paylode-issued gateway credentials for MPGS-mirrored endpoints.
-- Merchants authenticate to Paylode's gateway using:
--   Basic merchant.{mpgs_mid}:{gateway_api_password}
-- (same format as real MPGS — only the host changes)
-- mpgs_mid gets a UNIQUE constraint so it can be used as a lookup key.

ALTER TABLE merchant_mpgs_configs
  ADD COLUMN IF NOT EXISTS gateway_api_password_hash   TEXT,
  ADD COLUMN IF NOT EXISTS gateway_api_password_prefix VARCHAR(16);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_mpgs_configs_mpgs_mid_key
  ON merchant_mpgs_configs(mpgs_mid);
