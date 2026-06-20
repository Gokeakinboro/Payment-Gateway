-- Treasury-transfer obligations created when SA rebalances a merchant's pre-funded
-- payout balance between rails. The per-rail wallet move is applied immediately; this
-- table tracks the matching PHYSICAL inter-bank transfer ops must execute.
CREATE TABLE IF NOT EXISTS rail_rebalances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   uuid   NOT NULL,
  from_rail_id  uuid   NOT NULL,
  to_rail_id    uuid   NOT NULL,
  amount        bigint NOT NULL,
  status        text   NOT NULL DEFAULT 'pending',   -- pending | settled | cancelled
  reference     text,
  note          text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rail_rebalances_merchant_idx ON rail_rebalances(merchant_id);
CREATE INDEX IF NOT EXISTS rail_rebalances_status_idx   ON rail_rebalances(status);
