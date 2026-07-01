-- Paymula: allow one login (users row) to belong to MULTIPLE clubs.
-- Drops the per-user UNIQUE so a member can have several mw_members rows (one per
-- club), each with its own mw_wallets balance. Active club chosen via X-Member-Id.
ALTER TABLE mw_members DROP CONSTRAINT IF EXISTS mw_members_user_id_key;
