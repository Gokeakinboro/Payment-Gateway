-- YouVerify check history — one row per check run (BVN / NIN / CAC) per merchant.
-- Gives a full audit trail of every automated identity check triggered from the
-- SA/compliance dashboard, including raw response and who triggered it.

CREATE TABLE IF NOT EXISTS kyc_yv_checks (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        UUID,                                                     -- the check_* doc row that was actioned
  merchant_id   UUID         NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  element       VARCHAR(20)  NOT NULL,                                    -- 'bvn' | 'nin' | 'cac'
  id_number     VARCHAR(100),                                             -- the ID number sent to YouVerify
  yv_request_id VARCHAR(255),                                             -- requestId returned by YouVerify
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending',                  -- 'pending' | 'verified' | 'failed' | 'error'
  raw_response  JSONB,
  triggered_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  triggered_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_kyc_yv_checks_merchant   ON kyc_yv_checks(merchant_id);
CREATE INDEX IF NOT EXISTS idx_kyc_yv_checks_time       ON kyc_yv_checks(merchant_id, triggered_at DESC);
