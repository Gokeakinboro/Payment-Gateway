-- Editable screening/AML service-provider catalog (2026-06-17). RUN AS APP USER
-- (paylode) so the app can access it. Seeds the current static list.
CREATE TABLE IF NOT EXISTS service_providers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  type       TEXT,
  services   TEXT,
  cost       TEXT,
  status     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO service_providers (name, type, services, cost, status)
SELECT * FROM (VALUES
  ('YouVerify','KYC / Identity','BVN, NIN, CAC, Address','TBD per check','being replaced (too expensive)'),
  ('Dojah','KYC / Identity','BVN, NIN, CAC','TBD per check','planned replacement'),
  ('Interswitch','KYC','BVN, NIN, CAC, TIN, Address','TBD per check','KIV (run-check)'),
  ('Sanctions / PEP','AML screening','OFAC/UN/EU sanctions, PEP','TBD','placeholder list in use')
) AS v(name,type,services,cost,status)
WHERE NOT EXISTS (SELECT 1 FROM service_providers);
