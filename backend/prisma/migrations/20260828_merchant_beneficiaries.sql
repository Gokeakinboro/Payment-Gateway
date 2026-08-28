-- Merchant beneficiary address book.
-- Accounts are NE-verified at upload time so dispatch can skip inline NE.

CREATE TABLE merchant_beneficiaries (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id        UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  account_number     VARCHAR(10) NOT NULL,
  bank_code          VARCHAR(20) NOT NULL,
  bank_name          VARCHAR(200),
  account_name       VARCHAR(300),      -- NE-resolved canonical name
  alias              VARCHAR(300),      -- merchant-supplied label/name
  ne_status          VARCHAR(20)  NOT NULL DEFAULT 'pending', -- pending/verified/failed
  ne_checked_at      TIMESTAMPTZ,
  ne_failure_reason  VARCHAR(500),
  is_active          BOOLEAN     NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (merchant_id, bank_code, account_number)
);
CREATE INDEX ON merchant_beneficiaries (merchant_id) WHERE is_active = true;
CREATE INDEX ON merchant_beneficiaries (merchant_id, ne_status) WHERE is_active = true;
