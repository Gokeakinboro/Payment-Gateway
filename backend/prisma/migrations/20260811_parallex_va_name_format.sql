-- Per-merchant Parallex VA name format.
-- NULL / 'with_paylode' → "<businessName>/Paylode" (default branding)
-- 'name_only'           → just the merchant's business name
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS parallex_va_name_format TEXT;
