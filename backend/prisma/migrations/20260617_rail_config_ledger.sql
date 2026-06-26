-- Payout rail config + item-level rail assignment + rail allocation ledger (2026-06-17)
-- Foundation for cost/cap-aware routing and daily reconciliation.

-- ── Per-rail payout config (internal only) ───────────────────────────────────
ALTER TABLE payment_rails ADD COLUMN IF NOT EXISTS payout_flat_cost BIGINT NOT NULL DEFAULT 0;  -- OUR cost per transfer (kobo)
ALTER TABLE payment_rails ADD COLUMN IF NOT EXISTS daily_value_cap  BIGINT;                      -- max kobo/day through rail; NULL = no cap
ALTER TABLE payment_rails ADD COLUMN IF NOT EXISTS tps_limit        INTEGER;                     -- max sends/sec; NULL = none
ALTER TABLE payment_rails ADD COLUMN IF NOT EXISTS sponsor_bank     TEXT;                         -- settlement bank / switch

-- ── Item-level rail assignment (one beneficiary transfer = one rail) ─────────
ALTER TABLE payout_items ADD COLUMN IF NOT EXISTS rail_id UUID REFERENCES payment_rails(id);

-- ── Rail allocation ledger — one row per disbursement leg (recon source) ─────
CREATE TABLE IF NOT EXISTS rail_disbursements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_item_id  UUID NOT NULL REFERENCES payout_items(id),
  batch_id        UUID NOT NULL,
  merchant_id     UUID NOT NULL,
  rail_id         UUID NOT NULL REFERENCES payment_rails(id),
  amount          BIGINT NOT NULL,                 -- beneficiary transfer amount (kobo)
  rail_cost       BIGINT NOT NULL DEFAULT 0,       -- our configured flat cost at routing time
  status          TEXT   NOT NULL DEFAULT 'pending', -- pending|sent|success|failed|reversed
  attempt         INTEGER NOT NULL DEFAULT 1,
  rail_order_id   TEXT,        -- orderId we sent to the rail
  rail_order_no   TEXT,        -- rail's order number
  rail_session_id TEXT,        -- NIBSS session id (bank reference)
  rail_fee        BIGINT,      -- fee the rail charged us (from per-txn query)
  rail_vat        BIGINT,
  error_code      TEXT,
  error_msg       TEXT,
  sent_at         TIMESTAMPTZ,
  settled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rail_disbursements_rail_created_idx ON rail_disbursements (rail_id, created_at);
CREATE INDEX IF NOT EXISTS rail_disbursements_batch_idx        ON rail_disbursements (batch_id);
CREATE INDEX IF NOT EXISTS rail_disbursements_order_idx        ON rail_disbursements (rail_order_id);
