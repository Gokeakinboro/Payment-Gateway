-- Tiered payout pricing: on-us (PalmPay) beneficiaries are charged less than
-- other-bank beneficiaries. The standard PAYOUT channel stays the other-bank
-- price (₦20 flat); this seeds PAYOUT_ONUS as the on-us price (₦10 flat).
-- Both are FLAT-fee, no rate/cap/min. Values are editable afterwards via the
-- Merchant Pricing UI (platform default) or a per-merchant PAYOUT_ONUS override.
--
-- Idempotent: skips if PAYOUT_ONUS already exists. flat_fee is in kobo (1000 = ₦10).
INSERT INTO platform_rate_configs
  (channel, product_group, fee_model, rate, flat_fee, cap, min_charge, vat_rate, label, description, is_active, is_custom, created_at, updated_at)
VALUES
  ('PAYOUT_ONUS', 'PAYOUT', 'FLAT', 0, 1000, 0, 0, 0.075,
   'Payout (on-us / PalmPay)', 'Flat fee for payouts to a PalmPay account (on-us). Other-bank payouts use the standard PAYOUT fee.',
   true, false, NOW(), NOW())
ON CONFLICT (channel) DO NOTHING;
