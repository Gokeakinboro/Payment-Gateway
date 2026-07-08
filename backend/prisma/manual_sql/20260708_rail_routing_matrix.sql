-- ─────────────────────────────────────────────────────────────────────────────
-- Rail routing matrix — per-CHANNEL routing (CARDS / VA / PAYOUT).
-- Replaces three ad-hoc mechanisms with one consistent two-tier model:
--   • rail_channel_defaults — the SA-chosen GLOBAL default rail per channel
--   • merchant_rail_routes  — the per-merchant per-channel override
--
-- Superseded mechanisms (columns kept, no longer authoritative for routing):
--   CARDS  ← platform_rate_configs.default_rail_id (CARD_LOCAL)
--   VA     ← cheapest-LIVE VIRTUAL_ACCOUNT rail (auto)
--   PAYOUT ← payment_rails.is_default_payout  + merchants.payout_rail_id
--   VA ovr ← merchants.payin_rail_id
--
-- POLICY: SA MUST set a default per channel — there is NO silent cheapest-rail
-- fallback. Routing is a traffic-TYPE decision, not just cost: sending the wrong
-- traffic to a rail can get us disconnected. Seeded below from the CURRENT live
-- state so behaviour is unchanged on deploy; thereafter it's SA-managed.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rail_channel_defaults (
  channel    text PRIMARY KEY CHECK (channel IN ('CARDS','VA','PAYOUT')),
  rail_id    uuid NOT NULL REFERENCES payment_rails(id),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchant_rail_routes (
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('CARDS','VA','PAYOUT')),
  rail_id     uuid NOT NULL REFERENCES payment_rails(id),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, channel)
);
CREATE INDEX IF NOT EXISTS merchant_rail_routes_rail_idx ON merchant_rail_routes(rail_id);

-- ── Seed channel defaults from current behaviour (idempotent) ────────────────
-- CARDS: the CARD_LOCAL product's configured default rail, else Interswitch.
INSERT INTO rail_channel_defaults (channel, rail_id)
SELECT 'CARDS', COALESCE(
  (SELECT prc.default_rail_id
     FROM platform_rate_configs prc
     JOIN payment_rails pr ON pr.id = prc.default_rail_id
    WHERE prc.channel = 'CARD_LOCAL' AND prc.default_rail_id IS NOT NULL
    LIMIT 1),
  (SELECT id FROM payment_rails WHERE name ILIKE 'interswitch' LIMIT 1))
WHERE COALESCE(
  (SELECT prc.default_rail_id FROM platform_rate_configs prc
    WHERE prc.channel = 'CARD_LOCAL' AND prc.default_rail_id IS NOT NULL LIMIT 1),
  (SELECT id FROM payment_rails WHERE name ILIKE 'interswitch' LIMIT 1)) IS NOT NULL
ON CONFLICT (channel) DO NOTHING;

-- VA: the current cheapest LIVE rail with an active VIRTUAL_ACCOUNT cost (today PalmPay).
INSERT INTO rail_channel_defaults (channel, rail_id)
SELECT 'VA', pr.id
  FROM rail_costs rc
  JOIN payment_rails pr ON pr.id = rc.rail_id
 WHERE rc.service_type = 'VIRTUAL_ACCOUNT' AND rc.effective_to IS NULL AND pr.status = 'LIVE'
 ORDER BY rc.rate ASC
 LIMIT 1
ON CONFLICT (channel) DO NOTHING;

-- PAYOUT: the rail currently flagged is_default_payout.
INSERT INTO rail_channel_defaults (channel, rail_id)
SELECT 'PAYOUT', id FROM payment_rails WHERE is_default_payout = true LIMIT 1
ON CONFLICT (channel) DO NOTHING;

-- ── Migrate existing per-merchant overrides into the matrix (idempotent) ─────
INSERT INTO merchant_rail_routes (merchant_id, channel, rail_id)
SELECT id, 'VA', payin_rail_id FROM merchants WHERE payin_rail_id IS NOT NULL
ON CONFLICT (merchant_id, channel) DO NOTHING;

INSERT INTO merchant_rail_routes (merchant_id, channel, rail_id)
SELECT id, 'PAYOUT', payout_rail_id FROM merchants WHERE payout_rail_id IS NOT NULL
ON CONFLICT (merchant_id, channel) DO NOTHING;
