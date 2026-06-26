-- Paylode Services Limited — Initial Database Migration
-- PostgreSQL Schema — 12 tables

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enums
CREATE TYPE "KycStatus" AS ENUM ('PENDING_KYC','KYC_IN_REVIEW','KYC_APPROVED','KYC_REJECTED','ACTIVE','SUSPENDED');
CREATE TYPE "TxnStatus" AS ENUM ('PENDING','SUCCESS','FAILED','REVERSED');
CREATE TYPE "Channel" AS ENUM ('CARD','BANK_TRANSFER','USSD','DIRECT_DEBIT');
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING','PROCESSING','COMPLETED','FAILED');
CREATE TYPE "AmlRiskLevel" AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');
CREATE TYPE "AmlFlagStatus" AS ENUM ('OPEN','INVESTIGATING','CLOSED','REPORTED_TO_CBN');
CREATE TYPE "RailStatus" AS ENUM ('CONFIG_ONLY','TESTING','LIVE');
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN','COMPLIANCE_OFFICER','AGGREGATOR','MERCHANT');
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING','PAID','FAILED');

CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "aggregators" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "company_name" TEXT NOT NULL,
    "rc_number" TEXT,
    "revenue_split_pct" DECIMAL(5,4) NOT NULL,
    "settlement_bank" TEXT,
    "settlement_account" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aggregators_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "aggregators_user_id_key" ON "aggregators"("user_id");

CREATE TABLE "merchants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "merchant_code" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "business_type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "rc_number" TEXT,
    "state" TEXT NOT NULL,
    "address" TEXT,
    "business_email" TEXT NOT NULL,
    "business_phone" TEXT NOT NULL,
    "website" TEXT,
    "expected_monthly_vol" TEXT,
    "aggregator_id" UUID,
    "kyc_status" "KycStatus" NOT NULL DEFAULT 'PENDING_KYC',
    "kyc_tier" INTEGER,
    "processing_rate" DECIMAL(5,4),
    "settlement_bank" TEXT,
    "settlement_account" TEXT,
    "settlement_cycle" TEXT NOT NULL DEFAULT 't1',
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "webhook_url" TEXT,
    "webhook_secret" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "merchants_user_id_key" ON "merchants"("user_id");
CREATE UNIQUE INDEX "merchants_merchant_code_key" ON "merchants"("merchant_code");
CREATE INDEX "merchants_kyc_status_idx" ON "merchants"("kyc_status");
CREATE INDEX "merchants_is_active_idx" ON "merchants"("is_active");
CREATE INDEX "merchants_aggregator_id_idx" ON "merchants"("aggregator_id");

CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID,
    "user_id" UUID,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Default',
    "is_sandbox" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE INDEX "api_keys_key_hash_idx" ON "api_keys"("key_hash");

CREATE TABLE "payment_rails" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "status" "RailStatus" NOT NULL DEFAULT 'CONFIG_ONLY',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_rails_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_rails_name_key" ON "payment_rails"("name");

CREATE TABLE "rail_costs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rail_id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "rate" DECIMAL(6,5) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rail_costs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "rail_costs_rail_id_channel_effective_from_key" ON "rail_costs"("rail_id","channel","effective_from");

CREATE TABLE "transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "merchant_id" UUID NOT NULL,
    "customer_email" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "status" "TxnStatus" NOT NULL DEFAULT 'PENDING',
    "channel" "Channel" NOT NULL,
    "rail_id" UUID,
    "merchant_fee" BIGINT NOT NULL DEFAULT 0,
    "rail_cost" BIGINT NOT NULL DEFAULT 0,
    "net_revenue" BIGINT NOT NULL DEFAULT 0,
    "agg_share" BIGINT NOT NULL DEFAULT 0,
    "paylode_margin" BIGINT NOT NULL DEFAULT 0,
    "auth_url" TEXT,
    "access_code" TEXT,
    "callback_url" TEXT,
    "metadata" JSONB,
    "failure_reason" TEXT,
    "paid_at" TIMESTAMPTZ,
    "is_sandbox" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "transactions_reference_key" ON "transactions"("reference");
CREATE INDEX "transactions_merchant_id_idx" ON "transactions"("merchant_id");
CREATE INDEX "transactions_status_idx" ON "transactions"("status");
CREATE INDEX "transactions_created_at_idx" ON "transactions"("created_at");
CREATE INDEX "transactions_is_sandbox_idx" ON "transactions"("is_sandbox");

CREATE TABLE "settlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "gross_amount" BIGINT NOT NULL,
    "fees_deducted" BIGINT NOT NULL,
    "net_settled" BIGINT NOT NULL,
    "txn_count" INTEGER NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "settlement_ref" TEXT,
    "settled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "settlements_settlement_ref_key" ON "settlements"("settlement_ref");
CREATE INDEX "settlements_merchant_id_idx" ON "settlements"("merchant_id");
CREATE INDEX "settlements_status_idx" ON "settlements"("status");

CREATE TABLE "agg_payouts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregator_id" UUID NOT NULL,
    "period_month" DATE NOT NULL,
    "total_merchant_fees" BIGINT NOT NULL,
    "rail_deduction" BIGINT NOT NULL,
    "net_pool" BIGINT NOT NULL,
    "agg_share_amount" BIGINT NOT NULL,
    "txn_count" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "paid_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agg_payouts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agg_payouts_aggregator_id_period_month_key" ON "agg_payouts"("aggregator_id","period_month");

CREATE TABLE "kyc_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "tier_applied" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "reviewed_by" UUID,
    "rejection_code" TEXT,
    "review_notes" TEXT,
    "documents" JSONB NOT NULL DEFAULT '[]',
    "bvn_verified" BOOLEAN NOT NULL DEFAULT false,
    "nin_verified" BOOLEAN NOT NULL DEFAULT false,
    "cac_verified" BOOLEAN NOT NULL DEFAULT false,
    "pep_clear" BOOLEAN NOT NULL DEFAULT false,
    "aml_score" TEXT,
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "kyc_submissions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "kyc_submissions_merchant_id_idx" ON "kyc_submissions"("merchant_id");
CREATE INDEX "kyc_submissions_status_idx" ON "kyc_submissions"("status");

CREATE TABLE "aml_flags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "transaction_id" UUID,
    "flag_type" TEXT NOT NULL,
    "risk_level" "AmlRiskLevel" NOT NULL,
    "status" "AmlFlagStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aml_flags_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "aml_flags_merchant_id_idx" ON "aml_flags"("merchant_id");
CREATE INDEX "aml_flags_status_idx" ON "aml_flags"("status");

CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "notes" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_log_actor_id_idx" ON "audit_log"("actor_id");
CREATE INDEX "audit_log_entity_idx" ON "audit_log"("entity_type","entity_id");
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "url" TEXT NOT NULL,
    "response_code" INTEGER,
    "response_ms" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_deliveries_merchant_id_idx" ON "webhook_deliveries"("merchant_id");

-- Foreign Keys
ALTER TABLE "aggregators" ADD CONSTRAINT "aggregators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_aggregator_id_fkey" FOREIGN KEY ("aggregator_id") REFERENCES "aggregators"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rail_costs" ADD CONSTRAINT "rail_costs_rail_id_fkey" FOREIGN KEY ("rail_id") REFERENCES "payment_rails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_rail_id_fkey" FOREIGN KEY ("rail_id") REFERENCES "payment_rails"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agg_payouts" ADD CONSTRAINT "agg_payouts_aggregator_id_fkey" FOREIGN KEY ("aggregator_id") REFERENCES "aggregators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "aml_flags" ADD CONSTRAINT "aml_flags_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "aml_flags" ADD CONSTRAINT "aml_flags_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
