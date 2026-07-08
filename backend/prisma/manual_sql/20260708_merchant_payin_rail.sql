-- Per-merchant PAY-IN (collection) rail override.
-- NULL = use the global cheapest LIVE rail (unchanged behaviour for every existing
-- merchant). Set only for controlled routing (e.g. a single test merchant → a new
-- rail while it's still in sandbox). See feeEngine.resolvePayinRail.
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS payin_rail_id uuid REFERENCES payment_rails(id);
