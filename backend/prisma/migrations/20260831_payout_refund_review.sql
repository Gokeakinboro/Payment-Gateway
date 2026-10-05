-- SA-gated refunds: transfer failures no longer auto-refund merchants.
-- SA reviews each failed item and approves or rejects the refund.
-- NULL  = not applicable (item succeeded, or batch-cancel refund which is still immediate)
-- 'pending_review' = transfer failed, refund awaiting SA approval
-- 'approved'       = SA approved and refund executed
-- 'rejected'       = SA rejected (rare: transfer may have gone through despite failure signal)

ALTER TABLE payout_items
  ADD COLUMN IF NOT EXISTS refund_status      TEXT,
  ADD COLUMN IF NOT EXISTS refund_amount      BIGINT,
  ADD COLUMN IF NOT EXISTS refund_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_reviewed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_payout_items_refund_status
  ON payout_items (refund_status) WHERE refund_status IS NOT NULL;
