-- Social Club merchant type — subscription billing, member management, access control.
-- Idempotent: safe to re-run.

-- 1. Merchant type (retail = default, social_club = new)
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS merchant_type text NOT NULL DEFAULT 'retail';

-- 2. Subscription plan definitions (richer than inv_series)
CREATE TABLE IF NOT EXISTS club_subscription_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id         uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name                text NOT NULL,
  description         text,
  amount              bigint NOT NULL CHECK (amount > 0),   -- face amount kobo (excl VAT)
  charge_vat          boolean NOT NULL DEFAULT false,
  vat_rate            numeric(5,2) NOT NULL DEFAULT 7.50,   -- e.g. 7.50 for 7.5%
  sub_items           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{name,amount_kobo}], totals must = amount
  frequency           text NOT NULL DEFAULT 'monthly',      -- one_time|weekly|monthly|quarterly|annually
  reminder_days       integer[] NOT NULL DEFAULT '{7,3,1,0}', -- days before due date to fire reminders
  grace_period_days   integer NOT NULL DEFAULT 7,           -- days after due before access is blocked
  next_run_at         timestamptz,                          -- NULL = not yet scheduled / one_time
  status              text NOT NULL DEFAULT 'active',       -- active|paused|archived
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_plans_merchant_idx ON club_subscription_plans(merchant_id);
CREATE INDEX IF NOT EXISTS club_plans_status_idx   ON club_subscription_plans(merchant_id, status);

-- 3. Member enrollment per plan (one member can be on multiple plans)
CREATE TABLE IF NOT EXISTS club_plan_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL REFERENCES club_subscription_plans(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES mw_members(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'active',   -- active|paused
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, member_id)
);
CREATE INDEX IF NOT EXISTS club_plan_members_plan_idx   ON club_plan_members(plan_id);
CREATE INDEX IF NOT EXISTS club_plan_members_member_idx ON club_plan_members(member_id);

-- 4. Link inv_invoices to a plan + member (for report queries)
ALTER TABLE inv_invoices
  ADD COLUMN IF NOT EXISTS club_plan_id   uuid REFERENCES club_subscription_plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS club_member_id uuid REFERENCES mw_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS club_invoices_plan_idx   ON inv_invoices(club_plan_id)   WHERE club_plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS club_invoices_member_idx ON inv_invoices(club_member_id) WHERE club_member_id IS NOT NULL;

-- 5. Admin mark-as-paid (method + who + notes) on invoice payments
ALTER TABLE inv_invoice_payments
  ADD COLUMN IF NOT EXISTS manual_payment_method text,   -- CARD|BANK_TRANSFER|CASH; NULL = gateway payment
  ADD COLUMN IF NOT EXISTS marked_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes                 text;

-- 6. Login PIN for Billspay social club members (separate from transaction PIN pin_hash)
ALTER TABLE mw_members
  ADD COLUMN IF NOT EXISTS login_pin_hash         text,
  ADD COLUMN IF NOT EXISTS login_pin_set          boolean NOT NULL DEFAULT false,   -- false = default PIN, must change
  ADD COLUMN IF NOT EXISTS login_pin_failed       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS login_pin_locked_until timestamptz;
