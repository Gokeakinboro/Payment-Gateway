-- Payment links: optional customer phone captured at creation, for upcoming
-- WhatsApp/SMS delivery of the link + receipt (alongside email). Idempotent.
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS customer_phone text;
