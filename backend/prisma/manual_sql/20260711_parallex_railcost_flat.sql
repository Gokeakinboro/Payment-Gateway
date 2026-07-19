-- Parallex VA rail cost: ₦8 flat (rail_costs has no updated_at column).
UPDATE rail_costs
   SET rate = 0, flat_fee = 800, cap = 0, min_charge = 0
 WHERE rail_id = (SELECT id FROM payment_rails WHERE name ILIKE 'parallex%' LIMIT 1)
   AND service_type = 'VIRTUAL_ACCOUNT'
   AND effective_to IS NULL;
