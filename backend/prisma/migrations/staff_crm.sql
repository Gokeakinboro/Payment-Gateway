-- Staff CRM migration
-- Run on paylode_db: psql -U paylode_user -d paylode_db -f staff_crm.sql

-- Add STAFF role to enum
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'STAFF';

-- Add account officer + pipeline tracking to merchants
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS account_officer_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pipeline_stage VARCHAR(20) NOT NULL DEFAULT 'prospect';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS first_engagement_at TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS off_ramp_at TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS off_ramp_reason TEXT;

-- Staff engagement log
CREATE TABLE IF NOT EXISTS staff_engagements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  staff_id       UUID NOT NULL REFERENCES users(id),
  type           VARCHAR(20) NOT NULL CHECK (type IN ('call','visit','email','whatsapp','demo','other')),
  notes          TEXT,
  engaged_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reassignment audit trail
CREATE TABLE IF NOT EXISTS staff_reassignments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  from_staff_id  UUID REFERENCES users(id),
  to_staff_id    UUID REFERENCES users(id),
  reassigned_by  UUID NOT NULL REFERENCES users(id),
  reason         TEXT,
  reassigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_merchants_account_officer ON merchants(account_officer_id);
CREATE INDEX IF NOT EXISTS idx_staff_engagements_merchant ON staff_engagements(merchant_id);
CREATE INDEX IF NOT EXISTS idx_staff_engagements_staff ON staff_engagements(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_engagements_date ON staff_engagements(engaged_at);
CREATE INDEX IF NOT EXISTS idx_staff_reassignments_merchant ON staff_reassignments(merchant_id);
