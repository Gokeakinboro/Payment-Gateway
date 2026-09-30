-- Tracks which merchants were auto-switched away from a failed rail and to what.
-- original_payout_rail_id = NULL means the merchant was using the system default rail.
-- Partial unique index ensures only one active assignment per merchant per failed rail.

CREATE TABLE IF NOT EXISTS rail_failover_assignments (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id             uuid        NOT NULL,
  failed_rail_id          uuid        NOT NULL,
  failover_rail_id        uuid        NOT NULL,
  original_payout_rail_id uuid,                   -- NULL = was using default rail
  switched_at             timestamptz NOT NULL DEFAULT now(),
  reverted_at             timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS rail_failover_active_idx
  ON rail_failover_assignments(merchant_id, failed_rail_id)
  WHERE reverted_at IS NULL;

CREATE INDEX IF NOT EXISTS rail_failover_failed_rail_idx
  ON rail_failover_assignments(failed_rail_id)
  WHERE reverted_at IS NULL;
