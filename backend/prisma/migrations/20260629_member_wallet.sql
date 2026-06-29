-- Member Wallet — closed-loop, merchant-owned, white-label stored value.
-- One merchant ledger (member wallets) + departmental subsidiary ledgers.
-- Amounts in kobo (bigint). Idempotent. Reuses inv_departments / inv_department_users.

-- Per-merchant config + white-label branding + the on/off toggle.
CREATE TABLE IF NOT EXISTS merchant_wallet_config (
  merchant_id         uuid PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT false,   -- SA-controlled switch (only SA flips true)
  requested           boolean NOT NULL DEFAULT false,   -- merchant expressed interest (onboarding tick)
  requested_at        timestamptz,
  approved_by         uuid,                             -- SA who approved
  approved_at         timestamptz,
  brand_name          text,
  brand_logo_url      text,
  brand_color         text,
  sender_email        text,
  sender_whatsapp     text,
  max_balance         bigint  NOT NULL DEFAULT 300000000,   -- ₦3,000,000 ceiling per wallet (kobo)
  low_balance_default bigint  NOT NULL DEFAULT 0,
  notify_email        boolean NOT NULL DEFAULT true,
  notify_whatsapp     boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Members (walled-garden, very-low-tier KYC: name/email/phone). Future external
-- payers will be kyc_tier='full'.
CREATE TABLE IF NOT EXISTS wallet_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id     uuid UNIQUE REFERENCES users(id),   -- login account (temp-pw onboarding); null = no login yet
  name        text NOT NULL,
  email       text,
  phone       text,
  kyc_tier    text NOT NULL DEFAULT 'low',     -- low (member) | full (external, future)
  status      text NOT NULL DEFAULT 'active',  -- active | suspended
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX        IF NOT EXISTS idx_wallet_members_merchant ON wallet_members(merchant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_members_phone ON wallet_members(merchant_id, lower(phone)) WHERE phone IS NOT NULL AND phone <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_members_email ON wallet_members(merchant_id, lower(email)) WHERE email IS NOT NULL AND email <> '';

-- One wallet per member.
CREATE TABLE IF NOT EXISTS wallets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id           uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  member_id             uuid NOT NULL UNIQUE REFERENCES wallet_members(id) ON DELETE CASCADE,
  balance               bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),  -- kobo; NEVER negative
  currency              text   NOT NULL DEFAULT 'NGN',
  status                text   NOT NULL DEFAULT 'active', -- active | frozen
  low_balance_threshold bigint NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallets_merchant ON wallets(merchant_id);

-- Append-only member ledger. Every balance change is one row (with balance_after).
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  wallet_id      uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  member_id      uuid NOT NULL REFERENCES wallet_members(id) ON DELETE CASCADE,
  department_id  uuid REFERENCES inv_departments(id),
  direction      text   NOT NULL,   -- credit | debit
  amount         bigint NOT NULL,   -- kobo, positive
  balance_after  bigint NOT NULL,
  type           text   NOT NULL,   -- fund|spend|transfer_out|transfer_in|load|debit|refund|withdrawal|reversal
  reference      text   NOT NULL,
  transaction_id uuid,              -- funding gateway txn (idempotency)
  counterparty   text,
  note           text,
  created_by     uuid,              -- acting user (member/admin/maker) or null=system
  approved_by    uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_ledger_reference ON wallet_ledger(reference);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_ledger_txn ON wallet_ledger(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_wallet_ledger_wallet ON wallet_ledger(wallet_id, created_at DESC);
CREATE INDEX        IF NOT EXISTS idx_wallet_ledger_merchant ON wallet_ledger(merchant_id, created_at DESC);

-- Departmental subsidiary ledger — credited when a member spends into a department.
CREATE TABLE IF NOT EXISTS wallet_department_ledger (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  department_id    uuid NOT NULL REFERENCES inv_departments(id) ON DELETE CASCADE,
  direction        text   NOT NULL,   -- credit (spend in) | debit (payout/adjustment)
  amount           bigint NOT NULL,
  balance_after    bigint NOT NULL,
  type             text   NOT NULL,   -- spend | transfer | payout | adjustment
  member_id        uuid REFERENCES wallet_members(id),
  wallet_ledger_id uuid REFERENCES wallet_ledger(id),
  reference        text   NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_dept_ledger_reference ON wallet_department_ledger(reference);
CREATE INDEX        IF NOT EXISTS idx_wallet_dept_ledger_dept ON wallet_department_ledger(department_id, created_at DESC);
CREATE INDEX        IF NOT EXISTS idx_wallet_dept_ledger_merchant ON wallet_department_ledger(merchant_id, created_at DESC);

-- Maker-checker for admin loads/debits/refunds. Maker = dept sub-user, checker = any admin.
CREATE TABLE IF NOT EXISTS wallet_load_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  wallet_id   uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES wallet_members(id) ON DELETE CASCADE,
  direction   text   NOT NULL,   -- credit (load) | debit
  type        text   NOT NULL,   -- load | debit | refund | withdrawal
  amount      bigint NOT NULL,
  reason      text,
  status      text   NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  maker_id    uuid,              -- dept sub-user who initiated
  checker_id  uuid,              -- admin who decided
  ledger_id   uuid,              -- wallet_ledger row created on approval
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_wallet_load_req_merchant ON wallet_load_requests(merchant_id, status, created_at DESC);
