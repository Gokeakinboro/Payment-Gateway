-- Payment Links — merchant-generated shareable checkout links.
-- A link mints a PENDING transaction when a customer opens it and enters their
-- email (and amount, if the link is open-amount). The customer then pays via the
-- normal hosted checkout flow (checkout.html?ref=<reference>).
--
-- NOTE: create as the APP user (paylode) so the running API can read/write it —
-- a sudo -u postgres create would leave it postgres-owned and inaccessible.
CREATE TABLE IF NOT EXISTS payment_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  slug         text NOT NULL UNIQUE,
  title        text NOT NULL,
  description  text,
  amount       bigint,                         -- kobo; NULL = customer enters the amount
  currency     char(3) NOT NULL DEFAULT 'NGN',
  is_reusable  boolean NOT NULL DEFAULT true,   -- false = one-off, auto-disabled after first success
  status       text NOT NULL DEFAULT 'active',  -- active | disabled
  expires_at   timestamptz,
  paid_count   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_links_merchant_id_idx ON payment_links(merchant_id);
CREATE INDEX IF NOT EXISTS payment_links_slug_idx        ON payment_links(slug);
