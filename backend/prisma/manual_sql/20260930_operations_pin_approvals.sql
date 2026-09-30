-- OPERATIONS role (maker) + SUPER_ADMIN/ADMIN approval (checker) for wallet
-- credits and merchant-to-merchant wallet moves, refund recommendations, and a
-- 6-digit PIN gate on merchant-dashboard-initiated payouts.
--
-- Maker-checker: OPERATIONS can only INITIATE a wallet_action_requests row
-- (status='pending'). Nothing moves until SUPER_ADMIN or ADMIN approves it —
-- see backend/src/modules/gateway-core/routes/walletActions.js.

-- ── New role ────────────────────────────────────────────────────────────────
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'OPERATIONS';

-- ── Merchant payout PIN (dashboard-submitted payouts only, not API/SDK) ──────
-- No separate email-token reset flow: a merchant who forgets their PIN resets
-- it via the same password (+2FA, if enabled) step-up used to set/change it
-- (see backend/src/services/reauth.js) — they're already logged into the
-- dashboard, so a second out-of-band token would add friction, not security.
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS payout_pin_hash            TEXT,
  ADD COLUMN IF NOT EXISTS payout_pin_set_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_pin_failed_attempts  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_pin_locked_until      TIMESTAMPTZ;

-- ── Refund recommendation (OPERATIONS "maker" step on an existing failed item) ──
-- Reuses the existing refund_status column (see 20260831_payout_refund_review.sql)
-- — recommending just flips it to 'pending_review', which both existing SA
-- refund-review UIs already watch. These two columns record WHO recommended it,
-- separately from refund_reviewed_by (who approved/rejected it).
ALTER TABLE payout_items
  ADD COLUMN IF NOT EXISTS refund_recommended_by  TEXT,
  ADD COLUMN IF NOT EXISTS refund_recommended_at  TIMESTAMPTZ;

-- ── Wallet action requests: OPERATIONS-initiated CREDIT / MOVE, pending SA/SSA
-- approval before any money actually moves ──────────────────────────────────
-- type='CREDIT': merchant_id gets amount credited on rail_id (mirrors POST
--   /payouts/wallet/fund's credit direction).
-- type='MOVE':   merchant_id (source) debited, dest_merchant_id (destination)
--   credited, both on rail_id — a genuine merchant-to-merchant wallet move,
--   which did not previously exist (rebalance is rail-to-rail on ONE merchant).
CREATE TABLE IF NOT EXISTS wallet_action_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              TEXT NOT NULL CHECK (type IN ('CREDIT', 'MOVE')),
  merchant_id       UUID NOT NULL REFERENCES merchants(id),
  dest_merchant_id  UUID REFERENCES merchants(id),
  rail_id           UUID REFERENCES payment_rails(id),
  amount            BIGINT NOT NULL CHECK (amount > 0),
  reference         TEXT,
  note              TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by      UUID NOT NULL REFERENCES users(id),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by        UUID REFERENCES users(id),
  decided_at        TIMESTAMPTZ,
  decision_note     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_action_requests_status ON wallet_action_requests (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wallet_action_requests_merchant ON wallet_action_requests (merchant_id);
CREATE INDEX IF NOT EXISTS idx_wallet_action_requests_requested_by ON wallet_action_requests (requested_by);
