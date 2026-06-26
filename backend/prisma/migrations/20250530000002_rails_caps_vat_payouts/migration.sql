-- Migration: Rail service types, fee caps, VAT, merchant wallet, payouts
-- Run: npx prisma migrate deploy

-- 1. Add service_type, fee_cap, vat_rate to rail_costs
ALTER TABLE rail_costs
  ADD COLUMN IF NOT EXISTS service_type   VARCHAR(20) NOT NULL DEFAULT 'BANK_TRANSFER',
  ADD COLUMN IF NOT EXISTS fee_cap        BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_rate       NUMERIC(5,4) NOT NULL DEFAULT 0.0750,
  ADD COLUMN IF NOT EXISTS merchant_cap   BIGINT NOT NULL DEFAULT 0;

-- 2. Add designated_rail and fallback to merchants
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS designated_rail_id UUID REFERENCES payment_rails(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS allow_fallback     BOOLEAN NOT NULL DEFAULT true;

-- 3. Merchant wallets
CREATE TABLE IF NOT EXISTS merchant_wallets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL UNIQUE REFERENCES merchants(id) ON DELETE RESTRICT,
  balance         BIGINT NOT NULL DEFAULT 0,
  last_funded_at  TIMESTAMPTZ,
  funded_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT no_negative_balance CHECK (balance >= 0)
);

-- 4. Wallet ledger (immutable)
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id              BIGSERIAL PRIMARY KEY,
  merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  entry_type      VARCHAR(20) NOT NULL,
  amount          BIGINT NOT NULL,
  balance_before  BIGINT NOT NULL,
  balance_after   BIGINT NOT NULL,
  reference       VARCHAR(80) NOT NULL,
  description     TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wallet_ledger_merchant_idx ON wallet_ledger(merchant_id);
CREATE INDEX IF NOT EXISTS wallet_ledger_created_idx  ON wallet_ledger(created_at);

-- 5. Payout batches
CREATE TABLE IF NOT EXISTS payout_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  batch_ref       VARCHAR(60) NOT NULL UNIQUE,
  description     TEXT,
  total_amount    BIGINT NOT NULL DEFAULT 0,
  total_items     INT NOT NULL DEFAULT 0,
  processed_items INT NOT NULL DEFAULT 0,
  failed_items    INT NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  rail_id         UUID REFERENCES payment_rails(id) ON DELETE SET NULL,
  scheduled_at    TIMESTAMPTZ,
  processed_at    TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payout_batches_merchant_idx ON payout_batches(merchant_id);
CREATE INDEX IF NOT EXISTS payout_batches_status_idx   ON payout_batches(status);

-- 6. Payout items
CREATE TABLE IF NOT EXISTS payout_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES payout_batches(id) ON DELETE RESTRICT,
  merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  account_number  VARCHAR(10) NOT NULL,
  account_name    VARCHAR(255),
  bank_code       VARCHAR(10) NOT NULL,
  bank_name       VARCHAR(100),
  amount          BIGINT NOT NULL,
  narration       VARCHAR(255),
  status          VARCHAR(20) NOT NULL DEFAULT 'queued',
  rail_reference  VARCHAR(100),
  failure_reason  TEXT,
  scheduled_at    TIMESTAMPTZ,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payout_items_batch_idx    ON payout_items(batch_id);
CREATE INDEX IF NOT EXISTS payout_items_merchant_idx ON payout_items(merchant_id);
CREATE INDEX IF NOT EXISTS payout_items_status_idx   ON payout_items(status);

-- 7. Nigerian banks reference table
CREATE TABLE IF NOT EXISTS nigerian_banks (
  id          SERIAL PRIMARY KEY,
  bank_code   VARCHAR(10) NOT NULL UNIQUE,
  bank_name   VARCHAR(150) NOT NULL,
  bank_type   VARCHAR(30) NOT NULL DEFAULT 'commercial',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ng_banks_code_idx ON nigerian_banks(bank_code);

-- Seed Nigerian banks
INSERT INTO nigerian_banks (bank_code, bank_name, bank_type) VALUES
('044','Access Bank','commercial'),
('023','Citibank Nigeria','commercial'),
('050','Ecobank Nigeria','commercial'),
('070','Fidelity Bank','commercial'),
('011','First Bank of Nigeria','commercial'),
('214','First City Monument Bank','commercial'),
('058','Guaranty Trust Bank','commercial'),
('030','Heritage Bank','commercial'),
('301','Jaiz Bank','commercial'),
('082','Keystone Bank','commercial'),
('057','Zenith Bank','commercial'),
('221','Stanbic IBTC Bank','commercial'),
('068','Standard Chartered Bank','commercial'),
('232','Sterling Bank','commercial'),
('032','Union Bank of Nigeria','commercial'),
('033','United Bank for Africa','commercial'),
('215','Unity Bank','commercial'),
('035','Wema Bank','commercial'),
('101','Providus Bank','commercial'),
('565','Carbon','commercial'),
('090177','Kuda MFB','microfinance'),
('090403','Moniepoint MFB','microfinance'),
('090267','Palmpay','mmo'),
('090405','Opay','mmo'),
('120001','9mobile Payment Service Bank','psb'),
('120002','Airtel Mobile Banking','psb'),
('120003','MTN Mobile Money','psb'),
('120004','Paga','mmo')
ON CONFLICT (bank_code) DO NOTHING;
