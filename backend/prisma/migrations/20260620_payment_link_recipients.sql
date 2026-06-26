-- Payment links can now be addressed to specific recipients (single or bulk).
-- Each recipient gets a UNIQUE one-time link; rows created together share a batch_id.
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS recipient_email text;
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS batch_id uuid;
CREATE INDEX IF NOT EXISTS payment_links_batch_id_idx ON payment_links(batch_id);
