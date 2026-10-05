-- Payout recall window: per-merchant opt-in.
-- When payout_recall_window_minutes > 0, new batches enter 'pending_review'
-- for that many minutes before auto-dispatch; NE is pre-fetched during the window.

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS payout_recall_window_minutes INT NOT NULL DEFAULT 0;

ALTER TABLE payout_items
  ADD COLUMN IF NOT EXISTS ne_session_id   TEXT,
  ADD COLUMN IF NOT EXISTS ne_account_name TEXT,
  ADD COLUMN IF NOT EXISTS ne_fetched_at   TIMESTAMPTZ;
