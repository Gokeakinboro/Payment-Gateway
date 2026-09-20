-- Add OPay as a payment rail.
-- Run on server 176 after deploying the opayService + opay-webhook.
-- The name 'OPay' matches the /opay/i regex in payoutRailAdapter.payoutAdapterForName().

INSERT INTO payment_rails (
  id,
  name,
  description,
  payout_enabled,
  payin_enabled,
  status,
  created_at,
  updated_at
)
VALUES (
  gen_random_uuid(),
  'OPay',
  'OPay Digital Services — payouts, bank-transfer collections, Pay-with-OPay wallet QR',
  true,
  true,
  'LIVE',
  now(),
  now()
)
ON CONFLICT (name) DO NOTHING;
