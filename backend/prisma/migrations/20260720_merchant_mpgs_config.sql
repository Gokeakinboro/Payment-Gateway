-- Per-merchant MPGS (Mastercard Payment Gateway Services) credentials.
-- Parallex issues each merchant a MID + API password; SA enters them here
-- so Paylode can forward card transactions to MPGS on the merchant's behalf.
-- One row per merchant (UNIQUE on merchant_id).

CREATE TABLE IF NOT EXISTS merchant_mpgs_configs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  mpgs_mid        VARCHAR(100) NOT NULL,          -- Merchant ID issued by Parallex/MPGS
  mpgs_api_password TEXT      NOT NULL,            -- API password for Basic Auth
  mpgs_base_url   VARCHAR(500) NOT NULL,           -- e.g. https://parallex.gateway.mastercard.com/api/rest/version/77
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  notes           TEXT,
  created_by      UUID        REFERENCES users(id),
  created_at      TIMESTAMP   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP   NOT NULL DEFAULT now(),
  CONSTRAINT merchant_mpgs_configs_merchant_id_key UNIQUE (merchant_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_mpgs_configs_merchant_id ON merchant_mpgs_configs(merchant_id);
