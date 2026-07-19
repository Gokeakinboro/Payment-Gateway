-- Fix Parallex VA rail cost: 0.6% (PalmPay clone) → ₦8 flat.
-- Parallex charges ₦8 per successful VA API call, debited from our payout
-- float (2001096025). It still reduces our per-transaction margin so it must
-- live here as a flat rail cost, not zero. net_revenue = 1% fee − ₦8.
UPDATE rail_costs
   SET rate = 0, flat_fee = 800, cap = 0, min_charge = 0, updated_at = NOW()
 WHERE rail_id = (SELECT id FROM payment_rails WHERE name ILIKE 'parallex%' LIMIT 1)
   AND service_type = 'VIRTUAL_ACCOUNT'
   AND effective_to IS NULL;

-- VA merchant min_charge → ₦12 (1200 kobo) so small collections aren't a loss.
-- Without this, a ₦500 collection earns ₦5 but costs ₦8 → -₦3 margin.
UPDATE platform_rate_configs
   SET min_charge = 1200, updated_at = NOW()
 WHERE channel = 'VIRTUAL_ACCOUNT';
