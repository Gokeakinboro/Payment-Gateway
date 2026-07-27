---
name: project-paylode-mastercard-compliance
description: "Paylode Mastercard Rules compliance — onboarding screening + per-transaction gate + SA deferral DEPLOYED to prod 2026-06-15, merged to main, smoke-tested"
metadata: 
  node_type: memory
  type: project
  originSessionId: f4686f24-142e-4654-9e08-b32af3b80f4e
---

# Paylode — Mastercard Rules & Compliance (DEPLOYED 2026-06-15)

Built + **DEPLOYED to prod (176.57.188.45) and merged to main** (merge commit 104f556) on
2026-06-15; user approved the controlled deploy. Branch was `feature/mastercard-compliance`,
repo github.com/Gokeakinboro/Payment-Gateway.

**Deploy steps done (this session):** (1) applied `manual_sql/20260615_compliance_exceptions.sql`
via `sudo -u postgres psql -d paylode_db -f` (table + merchant cols). (2) `npx prisma generate`.
(3) `PAYLODE_SSH_PASS=... python tools/deploy.py`. (4) `pm2 restart paylode-api --update-env`. Backup `/root/deploy-backup-20260615-120235`.

**Smoke test PASSED:** paylode-api online, 0 unstable restarts; `GET /api/v1/compliance/matrix` → 401
(mounted); module loads under regenerated prisma client + screens correctly (clean→ALLOW, prohibited
MCC→MC_PROHIBITED_MCC, sanctioned→MC_SANCTIONS, intl gambling→BLOCKING/high); both existing merchants
`compliance_status=clear` (no false blocks).

**⚠ LESSON — `deferrable` is a RESERVED PostgreSQL keyword** — first CREATE TABLE failed on it.
Fixed: column renamed `is_deferrable`, aliased back to `deferrable` in all SELECTs; prisma `@map("is_deferrable")`.

**⚠ LESSON (2026-06-15, FIXED live) — table created by `postgres` superuser = app role can't touch it.**
`compliance_exceptions` was OWNED BY postgres → runtime got `ERROR: permission denied for table compliance_exceptions` (Postgres `42501`, Prisma P2010). Fix: `ALTER TABLE compliance_exceptions OWNER TO paylode;`. **RULE for future manual prod SQL: always `ALTER TABLE <t> OWNER TO paylode;` after any `sudo -u postgres` CREATE TABLE.**

## Decisions (user, 2026-06-15)
- Build onboarding screening first, then both layers; every exception flows through an **SA defer-and-proceed module**. Risk/heuristic rules = **monitor-only**; **hard prohibitions always hard-block**.
- Sanctions = local in-memory list + clean `screenName()` API hook (Interswitch API drops in later).
- Structured MCC added → **separate intl-card onboarding** + scope-aware matrix.

## What was built
- **backend/src/config/complianceRules.js** — scope-aware MCC catalogue, BRAM prohibited-keyword scan, REASON_CODES, BLOCKING/REVIEW/MONITOR severities, `evaluate(scope,mcc,description)`.
- **backend/src/data/sanctionsList.js** — normalised OFAC/UN/EU + sanctioned-country index; `match()/isSanctionedCountry()`.
- **backend/src/services/complianceService.js** — `screenMerchant()` (onboarding), `screenTransaction()` (synchronous in-memory hard-prohibition gate), PCI `redactPan()/assertNoPan()`, raw-SQL `persistExceptions/listExceptions/rollupComplianceStatus/hasOpenBlocking`.
- **onboarding.js** — uses screenMerchant, persists exceptions, stores mcc + cardAcceptanceScope, blocks approval/activation on unresolved BLOCKING.
- **compliance.js** route — GET `/compliance/exceptions`, POST `/exceptions/:id/defer|clear|block`, GET `/compliance/matrix`.
- **transactions.js /initialize** + **checkout.js** live card path — gate rejects before the rail with a coded reason.
- **deferralExpiryService** — hourly sweep re-opens expired compliance deferrals + suspends.
- **DB** (`manual_sql/20260615_compliance_exceptions.sql` + schema.prisma): `compliance_exceptions` table + merchant cols `mcc, card_acceptance_scope, compliance_status, match_listed`.
- **Frontend**: app.js Compliance Exceptions page; api-wiring.js loaders + defer/clear/block actions; onboarding.html MCC select + card-acceptance scope chooser.

## KIV / follow-ups
- Real sanctions/KYC feed behind `screenName()` (Interswitch marketplace, pending) — replaces local list.
- BIN→issuer-country lookup for `screenTransaction` cardCountry.
- Real MATCH/TMF network lookup (manual `match_listed` flag now).
- Intl enhanced-DD document UPLOAD capture in onboarding.html.
