-- NIBSS Consent Hub — token storage
-- Stores retrievalTokens delivered by NIBSS after customer BVN consent.
-- The KYC flow reads by session_id, passes token to FAS, then marks used_at.

CREATE TABLE IF NOT EXISTS nibss_consent_tokens (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id      TEXT        NOT NULL UNIQUE,
  retrieval_token TEXT        NOT NULL,
  consent_status  TEXT        NOT NULL DEFAULT 'Unknown',
  bvn_masked      TEXT,
  used_at         TIMESTAMPTZ,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nibss_consent_tokens_session_id ON nibss_consent_tokens (session_id);
CREATE INDEX IF NOT EXISTS idx_nibss_consent_tokens_received_at ON nibss_consent_tokens (received_at DESC);
