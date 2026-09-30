-- Stamp duty holding wallets + remittance tracking.
-- stamp_duty_wallets: per-merchant balance of collected-but-not-yet-remitted stamp duty.
--   balance is populated ONLY when a rail has stamp_duty_active=true (SA-controlled).
--   When stamp_duty_active=false, payout_items.stamp_duty_kobo still accrues for audit,
--   but this wallet stays at zero — nothing moves until the merchant agrees.
--
-- stamp_duty_remittances: SA records each time the rail (Parallex) actually debits
--   their account for stamp duty, closing off the liability.

CREATE TABLE IF NOT EXISTS stamp_duty_wallets (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     uuid        NOT NULL UNIQUE,
  balance         bigint      NOT NULL DEFAULT 0,   -- kobo: collected but not remitted
  total_collected bigint      NOT NULL DEFAULT 0,   -- lifetime collections (for audit)
  total_remitted  bigint      NOT NULL DEFAULT 0,   -- lifetime remittances
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stamp_duty_remittances (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid        NOT NULL,
  rail_id     uuid,
  amount      bigint      NOT NULL,
  description text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stamp_duty_remittances_merchant_idx ON stamp_duty_remittances(merchant_id);
