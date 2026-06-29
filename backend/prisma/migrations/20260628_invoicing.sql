-- ─────────────────────────────────────────────────────────────────────────────
-- Invoice & Collect module — schema (raw SQL, same pattern as payment_links).
-- All money columns are kobo (bigint). Tenant key is merchant_id everywhere, so
-- the module is consumed identically by the Paylode dashboard (JWT) and by other
-- platforms (e.g. the golf platform) over API key. Create as the APP user (paylode)
-- so the running API can read/write — NOT as postgres.
-- Idempotent: safe to re-run (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

-- Departments (e.g. Bar, Restaurant) — a merchant business unit / product line.
CREATE TABLE IF NOT EXISTS inv_departments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, name)
);
CREATE INDEX IF NOT EXISTS inv_departments_merchant_idx ON inv_departments(merchant_id);

-- Departmental users — links an existing Paylode user to one department; that user
-- sees only their department's collections. Onboarded with a temporary password
-- (users.must_change_password = true), then sets their own on first login.
CREATE TABLE IF NOT EXISTS inv_department_users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  department_id     uuid NOT NULL REFERENCES inv_departments(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name              text,
  email             text,
  phone             text,
  onboarding_status text NOT NULL DEFAULT 'invited',  -- invited | active
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_department_users_dept_idx ON inv_department_users(department_id);
CREATE INDEX IF NOT EXISTS inv_department_users_merchant_idx ON inv_department_users(merchant_id);

-- Address book / contacts.
CREATE TABLE IF NOT EXISTS inv_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name          text,
  email         text,
  phone         text,
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags          text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_contacts_merchant_idx ON inv_contacts(merchant_id);
CREATE INDEX IF NOT EXISTS inv_contacts_email_idx    ON inv_contacts(merchant_id, lower(email));

-- Named, reusable recipient lists + membership join.
CREATE TABLE IF NOT EXISTS inv_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_lists_merchant_idx ON inv_lists(merchant_id);

CREATE TABLE IF NOT EXISTS inv_list_members (
  list_id    uuid NOT NULL REFERENCES inv_lists(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES inv_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

-- Merchant invoice format / branding (one default per merchant).
CREATE TABLE IF NOT EXISTS inv_formats (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id                 uuid NOT NULL UNIQUE REFERENCES merchants(id) ON DELETE CASCADE,
  logo_url                    text,
  address                     text,
  business_email              text,
  business_phone              text,
  layout                      text NOT NULL DEFAULT 'classic',  -- classic | modern | minimal | receipt
  allow_part_payment_default  boolean NOT NULL DEFAULT false,
  charge_vat_default          boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Reusable product/service catalogue for invoice line items.
CREATE TABLE IF NOT EXISTS inv_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  default_amount bigint,            -- kobo
  description    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_products_merchant_idx ON inv_products(merchant_id);

-- Recurring invoice series (schema only in Phase 1; automation is Phase 2).
CREATE TABLE IF NOT EXISTS inv_series (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id         uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  frequency           text NOT NULL,           -- weekly | monthly | annually | custom
  interval_custom_days integer,
  status              text NOT NULL DEFAULT 'active',  -- active | paused | cancelled
  next_run_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Per-merchant sequential counter for human invoice numbers.
CREATE TABLE IF NOT EXISTS inv_invoice_counters (
  merchant_id uuid PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  last_seq    bigint NOT NULL DEFAULT 0
);

-- A single sent (or scheduled) invoice instance.
CREATE TABLE IF NOT EXISTS inv_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number       text NOT NULL UNIQUE,
  merchant_id          uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  department_id        uuid REFERENCES inv_departments(id) ON DELETE SET NULL,
  series_id            uuid REFERENCES inv_series(id) ON DELETE SET NULL,
  contact_id           uuid REFERENCES inv_contacts(id) ON DELETE SET NULL,
  recipient_name       text,
  recipient_email      text,
  recipient_phone      text,
  description          text,
  amount               bigint NOT NULL,                 -- face amount (excl VAT), kobo
  charge_vat           boolean NOT NULL DEFAULT false,
  vat_amount           bigint NOT NULL DEFAULT 0,
  total_amount         bigint NOT NULL,                 -- amount + vat_amount
  currency             char(3) NOT NULL DEFAULT 'NGN',
  allow_part_payment   boolean NOT NULL DEFAULT false,
  amount_paid          bigint NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'draft',   -- draft|scheduled|sent|viewed|part_paid|paid|cancelled
  is_overdue           boolean NOT NULL DEFAULT false,
  scheduled_at         timestamptz,
  due_at               timestamptz,
  reminder_interval_days integer,
  reminder_count       integer NOT NULL DEFAULT 0,
  reminders_sent       integer NOT NULL DEFAULT 0,
  last_reminder_at     timestamptz,
  access_token         text NOT NULL UNIQUE,
  sent_at              timestamptz,
  viewed_at            timestamptz,
  paid_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_invoices_merchant_idx ON inv_invoices(merchant_id);
CREATE INDEX IF NOT EXISTS inv_invoices_status_idx   ON inv_invoices(status);
CREATE INDEX IF NOT EXISTS inv_invoices_dept_idx     ON inv_invoices(department_id);
CREATE INDEX IF NOT EXISTS inv_invoices_token_idx    ON inv_invoices(access_token);
CREATE INDEX IF NOT EXISTS inv_invoices_recipient_idx ON inv_invoices(merchant_id, lower(recipient_email));

-- Payment events against an invoice (supports part payment).
CREATE TABLE IF NOT EXISTS inv_invoice_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES inv_invoices(id) ON DELETE CASCADE,
  amount_paid       bigint NOT NULL,
  vat_amount        bigint NOT NULL DEFAULT 0,
  transaction_id    uuid,
  payment_reference text,
  channel           text,
  paid_at           timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_invoice_payments_invoice_idx ON inv_invoice_payments(invoice_id);
-- One ledger row per gateway transaction (idempotent finalize).
CREATE UNIQUE INDEX IF NOT EXISTS inv_invoice_payments_txn_uidx
  ON inv_invoice_payments(transaction_id) WHERE transaction_id IS NOT NULL;

-- QR codes (Fixed or Open amount), optionally scoped to a department.
CREATE TABLE IF NOT EXISTS inv_qr_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  department_id uuid REFERENCES inv_departments(id) ON DELETE SET NULL,
  qr_reference  text NOT NULL UNIQUE,
  access_token  text NOT NULL UNIQUE,
  label         text,
  type          text NOT NULL DEFAULT 'fixed',   -- fixed | open
  amount        bigint,                          -- kobo; NULL for open-amount
  charge_vat    boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_qr_codes_merchant_idx ON inv_qr_codes(merchant_id);
CREATE INDEX IF NOT EXISTS inv_qr_codes_dept_idx     ON inv_qr_codes(department_id);

-- Payment events collected via a QR code.
CREATE TABLE IF NOT EXISTS inv_qr_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qr_code_id        uuid NOT NULL REFERENCES inv_qr_codes(id) ON DELETE CASCADE,
  amount_paid       bigint NOT NULL,
  vat_amount        bigint NOT NULL DEFAULT 0,
  buyer_note        text,
  transaction_id    uuid,
  payment_reference text,
  paid_at           timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_qr_payments_qr_idx ON inv_qr_payments(qr_code_id);
CREATE UNIQUE INDEX IF NOT EXISTS inv_qr_payments_txn_uidx
  ON inv_qr_payments(transaction_id) WHERE transaction_id IS NOT NULL;
