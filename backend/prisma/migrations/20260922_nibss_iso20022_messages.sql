-- NIBSS inbound ISO 20022 message log
-- Run: psql paylode_db < 20260922_nibss_iso20022_messages.sql

CREATE TABLE IF NOT EXISTS nibss_iso20022_messages (
  id          BIGSERIAL PRIMARY KEY,
  msg_type    VARCHAR(20)  NOT NULL,
  raw_payload TEXT         NOT NULL,
  source_ip   VARCHAR(45),
  processed   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nibss_msgs_type    ON nibss_iso20022_messages (msg_type);
CREATE INDEX IF NOT EXISTS idx_nibss_msgs_created ON nibss_iso20022_messages (created_at DESC);
