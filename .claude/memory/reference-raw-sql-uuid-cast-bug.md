---
name: reference-raw-sql-uuid-cast-bug
description: Recurring Paylode bug — raw-SQL INSERT/params on uuid columns need ::uuid casts or Postgres 42804 / Prisma P2010
metadata: 
  node_type: memory
  type: reference
  originSessionId: 610c646d-1fbf-4f5b-bc7b-05e1192617b6
---

**Recurring Paylode bug class:** Prisma `$queryRawUnsafe` sends string params as `text`. When a uuid column receives one without an explicit `::uuid` cast, Postgres throws **`42804` "column X is of type uuid but expression is of type text"** → Prisma **`P2010`** → the generic 500 "An internal error occurred." NULLs cast cleanly, so bugs hide until a real id is passed (e.g. a department/contact is selected).

Fix = add `::uuid` to the placeholder (`$2::uuid`). Applies to INSERT VALUES **and** WHERE comparisons.

Sightings (all same root cause):
- member wallet ledger `mw_ledger`/`mw_dept_ledger` INSERTs — every credit/spend failed (2026-06-30, PR#20).
- Invoice & Collect: `qr.js` `inv_qr_codes` INSERT (`department_id`) → QR generation 500; `invoices.js` `inv_invoices` INSERT (`department_id`, `contact_id`) latent — fixed 2026-07-01, PR #27.

**Rule going forward:** any new raw-SQL touching uuid columns → cast EVERY uuid placeholder `::uuid` and test WITH a real id (not just the null/guard path; smoke tests that only hit the 409/validation branch miss this). See [[kiv-invoice-collect-paymentlinks]], [[session-2026-06-30-member-wallet-live]].
