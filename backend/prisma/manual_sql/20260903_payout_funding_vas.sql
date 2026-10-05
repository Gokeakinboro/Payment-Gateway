-- Tracks timed Parallex VAs generated for merchant payout pre-funding.
-- When the Parallex inflow webhook fires, we match here and auto-credit
-- the merchant's payout wallet for the appropriate rail.

CREATE TABLE IF NOT EXISTS payout_funding_vas (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      UUID        NOT NULL REFERENCES merchants(id),
  rail_id          UUID        NOT NULL REFERENCES payment_rails(id),
  reference_id     TEXT        NOT NULL UNIQUE,
  va_account_number TEXT,
  amount_kobo      BIGINT      NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'PENDING',   -- PENDING | COMPLETED | EXPIRED
  expires_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  paid_kobo        BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_funding_vas_merchant ON payout_funding_vas(merchant_id);
CREATE INDEX IF NOT EXISTS idx_payout_funding_vas_va_account ON payout_funding_vas(va_account_number);
CREATE INDEX IF NOT EXISTS idx_payout_funding_vas_status ON payout_funding_vas(status);
