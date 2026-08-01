-- Merchant metadata JSON column.
-- Stores MPGS onboarding extras captured at merchant onboarding:
--   years_of_operation, customer_service_phone, customer_service_email, annual_card_turnover
-- Run: psql $DATABASE_URL < backend/prisma/migrations/20260801_merchant_metadata.sql
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
