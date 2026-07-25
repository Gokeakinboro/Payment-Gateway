-- Partners: organisations that route their merchants through Paylode's MPGS
-- gateway. Each partner has their own API key, KYC policy, and status.
-- Partner merchants are onboarded BY the partner but processed BY Paylode.

CREATE TABLE IF NOT EXISTS partners (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) NOT NULL,
  slug            VARCHAR(100) NOT NULL UNIQUE,       -- url-safe handle e.g. 'payonus'
  contact_email   VARCHAR(200),
  contact_phone   VARCHAR(50),
  kyc_requirement VARCHAR(20) NOT NULL DEFAULT 'none', -- none | basic | full
  api_key         VARCHAR(120) UNIQUE,                 -- partner uses this to authenticate
  api_key_hash    VARCHAR(200),                        -- sha256 of api_key (stored; key shown once)
  api_key_prefix  VARCHAR(16),
  status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active | suspended | pending
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_merchants (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                  UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,

  -- Business identity (submitted by partner)
  business_name               VARCHAR(200) NOT NULL,
  mcc                         VARCHAR(10),             -- Merchant Category Code
  country                     VARCHAR(10) NOT NULL DEFAULT 'NG',
  state                       VARCHAR(100),
  contact_name                VARCHAR(200),
  contact_email               VARCHAR(200),
  contact_phone               VARCHAR(50),
  registration_number         VARCHAR(100),            -- RC number / business reg
  website                     VARCHAR(500),

  -- KYC (may be required depending on partner.kyc_requirement)
  kyc_status                  VARCHAR(30) NOT NULL DEFAULT 'not_required',
                              -- not_required | pending | approved | rejected
  kyc_notes                   TEXT,
  kyc_reviewed_by             UUID REFERENCES users(id),
  kyc_reviewed_at             TIMESTAMP,
  kyc_documents               JSONB NOT NULL DEFAULT '[]', -- [{type, name, url}]

  -- MPGS credentials (set by SA once Parallex issues MID)
  mpgs_mid                    VARCHAR(100) UNIQUE,
  mpgs_api_password           TEXT,                    -- Parallex-issued API password
  mpgs_base_url               VARCHAR(500),            -- default na-gateway.mastercard.com

  -- Paylode-issued gateway credentials (merchant.{mpgs_mid}:{gateway_api_password})
  gateway_api_password_hash   TEXT,
  gateway_api_password_prefix VARCHAR(20),

  -- Lifecycle
  status                      VARCHAR(30) NOT NULL DEFAULT 'pending_mid',
                              -- pending_mid | pending_kyc | active | suspended | rejected
  activated_at                TIMESTAMP,
  metadata                    JSONB NOT NULL DEFAULT '{}',
  created_at                  TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_merchants_partner_id  ON partner_merchants(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_merchants_mpgs_mid    ON partner_merchants(mpgs_mid);
CREATE INDEX IF NOT EXISTS idx_partner_merchants_status      ON partner_merchants(status);
CREATE INDEX IF NOT EXISTS idx_partners_slug                 ON partners(slug);
