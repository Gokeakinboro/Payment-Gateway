-- ─────────────────────────────────────────────────────────────────────────────
-- Parallex Bank — rail COST TO US, per channel (from Rail Cost.xlsx, 2026-07-08).
-- Cost only affects OUR margin, never the customer price. Parallex-SPECIFIC — does
-- not touch any other rail or any routing decision. Idempotent (rail_costs is
-- versioned by effective_from; payout cost lives on payment_rails columns).
--
--   VA (VIRTUAL_ACCOUNT): ₦8 flat per successful API call   → flat_fee 800
--   CARD (CARD_LOCAL):    0.75% capped at ₦2000             → rate 0.00750, cap 200000
--                         (available now; cards go live LATER — VA + payouts first)
--   PAYOUT:               ₦3 on-us (Parallex acct) / ₦8 other banks
--                         → payout_flat_cost_onus 300 / payout_flat_cost 800
--
-- NOTE: the pay-in cost calc (feeEngine.resolvePayinRateConfig) currently consumes
-- only rail rate + cap, NOT rail flat_fee/min_charge — so the ₦8 flat VA cost is
-- stored correctly here but won't yet show in margin until that calc is extended.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) VA + CARD rail costs. Expire any currently-active Parallex row for these
--    service types (except one already dated today), then upsert the new active row.
UPDATE rail_costs SET effective_to = CURRENT_DATE
WHERE rail_id = (SELECT id FROM payment_rails WHERE name ILIKE 'parallex%' ORDER BY created_at LIMIT 1)
  AND service_type IN ('VIRTUAL_ACCOUNT', 'CARD_LOCAL')
  AND effective_to IS NULL
  AND effective_from < CURRENT_DATE;

INSERT INTO rail_costs
  (rail_id, channel, service_type, rate, flat_fee, cap, min_charge, vat_rate, effective_from, effective_to)
SELECT pr.id, v.channel::"Channel", v.service_type, v.rate, v.flat_fee, v.cap, v.min_charge, 0.075, CURRENT_DATE, NULL
FROM payment_rails pr
CROSS JOIN (VALUES
    ('BANK_TRANSFER', 'VIRTUAL_ACCOUNT', 0.0::numeric,     800::bigint, 0::bigint,      0::bigint),
    ('CARD',          'CARD_LOCAL',      0.00750::numeric, 0::bigint,   200000::bigint, 0::bigint)
  ) AS v(channel, service_type, rate, flat_fee, cap, min_charge)
WHERE pr.name ILIKE 'parallex%'
ON CONFLICT (rail_id, service_type, effective_from) DO UPDATE
  SET rate = EXCLUDED.rate, flat_fee = EXCLUDED.flat_fee, cap = EXCLUDED.cap,
      min_charge = EXCLUDED.min_charge, vat_rate = EXCLUDED.vat_rate, effective_to = NULL;

-- 2) Payout rail cost (destination-tiered) lives on payment_rails.
UPDATE payment_rails
SET payout_flat_cost      = 800,   -- ₦8 to other banks
    payout_flat_cost_onus = 300,   -- ₦3 to a Parallex account (on-us)
    updated_at            = NOW()
WHERE name ILIKE 'parallex%';
