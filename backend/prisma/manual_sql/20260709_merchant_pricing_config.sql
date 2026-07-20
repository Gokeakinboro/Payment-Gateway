-- ─────────────────────────────────────────────────────────────────────────────
-- Merchant cost config — "Paylode Merchant Config" from Rail Cost.xlsx (what we
-- CHARGE MERCHANTS). Platform-wide (NOT rail-specific): a merchant pays the same
-- regardless of which rail carries the traffic — rail choice affects OUR margin.
--
--   CARD_LOCAL:      1.5% capped at ₦2000                → rate 0.01500, cap 200000
--   VIRTUAL_ACCOUNT: 1%   capped at ₦1500, min ₦12       → rate 0.01000, cap 150000, min 1200
--   PAYOUT:          ₦20 flat (other banks)              → flat 2000
--   PAYOUT_ONUS:     ₦10 flat (on-us / same-rail acct)   → flat 1000
--
-- IDEMPOTENT / NON-DESTRUCTIVE: ON CONFLICT (channel) DO NOTHING — this ESTABLISHES
-- the price only if the channel isn't configured yet; it will NOT overwrite an
-- existing live price. (PAYOUT/PAYOUT_ONUS were seeded 2026-06-20 and are kept.)
-- ⚠️ If you want existing rows FORCED to these sheet values, that's a deliberate
-- change to live merchant pricing — say so and I'll switch these to DO UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO platform_rate_configs
  (channel, product_group, fee_model, rate, flat_fee, cap, min_charge, vat_rate, label, description, is_active, is_custom, created_at, updated_at)
VALUES
  ('CARD_LOCAL',      'CARDS',           'PCT',  0.01500, 0,    200000, 0,    0.075,
   'Card (local)',            'Local card payments — 1.5% capped at ₦2,000.',             true, false, NOW(), NOW()),
  ('VIRTUAL_ACCOUNT', 'VIRTUAL_ACCOUNT', 'PCT',  0.01000, 0,    150000, 1200, 0.075,
   'Virtual Account',         'Bank-transfer / virtual-account collections — 1% capped at ₦1,500, min ₦12.', true, false, NOW(), NOW()),
  ('PAYOUT',          'PAYOUT',          'FLAT', 0,       2000, 0,      0,    0.075,
   'Payout (other banks)',    'Flat fee for payouts to other banks.',                     true, false, NOW(), NOW()),
  ('PAYOUT_ONUS',     'PAYOUT',          'FLAT', 0,       1000, 0,      0,    0.075,
   'Payout (on-us)',          'Flat fee for payouts to a same-rail account (on-us).',     true, false, NOW(), NOW())
ON CONFLICT (channel) DO NOTHING;
