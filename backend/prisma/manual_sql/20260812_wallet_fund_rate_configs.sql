-- Closed wallet (Billspay) merchant pricing — Sheet 1, Rail Cost.xlsx (2026-08-12)
-- Separate product codes so wallet-fund transactions get distinct rates from
-- standard merchant VA/card rates. resolvePayinRateConfig passes pricingProduct
-- = 'WALLET_FUND_CARD' or 'WALLET_FUND_VA' when txn.metadata.source = 'wallet_fund'.
--
-- Rates (excl. VAT, which is always added at 7.5%):
--   WALLET_FUND_CARD  2.00%  min ₦50 (no cap)
--   WALLET_FUND_VA    2.50%  min ₦50 (no cap)

INSERT INTO platform_rate_configs
  (id, channel, product_group, fee_model, rate, flat_fee, cap, min_charge, vat_rate,
   txn_channel, label, description, is_active, is_custom, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'WALLET_FUND_CARD', 'CUSTOM', 'PCT', 0.02000, 0, 0, 5000, 0.0750,
   'CARD', 'Wallet Funding — Card', 'Fee on wallet top-up via card (Billspay merchants)',
   true, false, now(), now()),
  (gen_random_uuid(), 'WALLET_FUND_VA', 'CUSTOM', 'PCT', 0.02500, 0, 0, 5000, 0.0750,
   'BANK_TRANSFER', 'Wallet Funding — Transfer', 'Fee on wallet top-up via bank transfer/VA (Billspay merchants)',
   true, false, now(), now())
ON CONFLICT (channel) DO UPDATE SET
  rate       = EXCLUDED.rate,
  min_charge = EXCLUDED.min_charge,
  updated_at = now();
