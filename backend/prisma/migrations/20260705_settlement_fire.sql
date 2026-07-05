-- SA-fired settlements: track the rail chosen, the schedule, who/when fired, and the
-- outbound payout order/result. Status uses the existing SettlementStatus enum:
--   PENDING → PROCESSING → COMPLETED | FAILED.
-- A row with status='PENDING' AND scheduled_at set = a scheduled fire the worker runs
-- when due. FAILED can be re-fired.
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS rail_id         uuid;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS scheduled_at    timestamptz;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fired_by        uuid;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fired_at        timestamptz;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS payout_order_id text;   -- our orderId sent to the rail
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS payout_ref      text;   -- rail providerRef / orderNo
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS failure_reason  text;
CREATE INDEX IF NOT EXISTS idx_settlements_scheduled  ON settlements (scheduled_at) WHERE status = 'PENDING' AND scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_settlements_processing ON settlements (fired_at)     WHERE status = 'PROCESSING';
