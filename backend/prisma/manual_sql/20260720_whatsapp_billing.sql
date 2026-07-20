-- WhatsApp per-message log for billing + margin tracking
CREATE TABLE IF NOT EXISTS whatsapp_message_log (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id          UUID        NOT NULL REFERENCES merchants(id),
  event_type           VARCHAR(64) NOT NULL,               -- invoice | payment_received | payout
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_free_tier         BOOLEAN     NOT NULL DEFAULT FALSE, -- TRUE = borne by Paylode
  merchant_charge_kobo BIGINT      NOT NULL DEFAULT 0,     -- what merchant owes us
  meta_cost_kobo       BIGINT      NOT NULL DEFAULT 0,     -- what we owe Meta
  meta_message_id      VARCHAR(128),                       -- Meta wamid for reconciliation
  succeeded            BOOLEAN     NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_wa_log_merchant ON whatsapp_message_log(merchant_id);
CREATE INDEX IF NOT EXISTS idx_wa_log_sent_at  ON whatsapp_message_log(sent_at);
CREATE INDEX IF NOT EXISTS idx_wa_log_merch_day ON whatsapp_message_log(merchant_id, sent_at);

-- Platform-wide key-value settings (e.g. Meta cost per WA message)
CREATE TABLE IF NOT EXISTS platform_settings (
  key        VARCHAR(128) PRIMARY KEY,
  value      JSONB        NOT NULL DEFAULT '{}',
  updated_by UUID         REFERENCES users(id),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
INSERT INTO platform_settings (key, value)
VALUES ('whatsapp', '{"meta_cost_per_message_kobo": 0}')
ON CONFLICT (key) DO NOTHING;
