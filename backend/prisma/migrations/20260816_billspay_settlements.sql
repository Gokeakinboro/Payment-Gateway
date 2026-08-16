-- Billspay dept-level settlement records — tracks sweeps of accumulated
-- department balances to the merchant's settlement bank account.
CREATE TABLE IF NOT EXISTS mw_dept_settlements (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     uuid        NOT NULL REFERENCES merchants(id),
  period_from     date        NOT NULL,
  period_to       date        NOT NULL,
  gross_kobo      bigint      NOT NULL,
  member_count    integer     NOT NULL DEFAULT 0,
  txn_count       integer     NOT NULL DEFAULT 0,
  status          text        NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','processing','settled','failed')),
  payout_ref      text,
  failure_reason  text,
  created_by      uuid        REFERENCES users(id),
  settled_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mw_dept_settlements_merchant
  ON mw_dept_settlements(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mw_dept_settlements_status
  ON mw_dept_settlements(status) WHERE status IN ('queued','processing');
