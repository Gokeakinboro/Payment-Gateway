---
name: project-payout-wallet-per-rail
description: "Paylode per-rail payout wallet rebuild + collections/payouts separation (2026-06-20). DEPLOYED to prod (176+45) 2026-06-20."
metadata: 
  node_type: memory
  type: project
  originSessionId: bdb94e91-c54a-43e0-9f0e-2652b8622a2d
---

# Per-rail payout wallets + collections/payouts separation (2026-06-20)

## Architecture DECISIONS (user, durable)
- **Payouts are pre-funded PER RAIL.** A merchant deposits into the rail/bank we tell
  them to fund (= Paylode's own rail bank account); SA confirms receipt, then credits
  the merchant's gateway balance for THAT rail. A payout draws only from the rail(s)
  funded, and never past that rail's remaining **daily send-out cap**. SA can
  **rebalance** a merchant's funds between rails (logical move + a tracked physical
  treasury-transfer obligation ops settles).
- **Payouts use ONLY the merchant's pre-funded money — never Paylode capital.** No
  fronting liquidity. The per-rail wallet balance is the authoritative cap.
- **Collections and payouts MUST NEVER mix** (structural, not policy). Collections are
  **pass-through**: Paylode **cannot hold funds** — every collected naira is remitted to
  the merchant's own bank via settlement. There is NO held collection balance. The ONLY
  bridge between the two is the merchant's external bank (collections out → merchant
  re-deposits into our rail account to fund payouts).
- **"Collection wallet" = a REPORTING construct only** (unified typed transaction feed +
  a pending-settlement figure), not a money store. Decided **pass-through** (not a held
  wallet w/ on-demand withdrawal) because we can't hold customer funds.
- **Settlements to be AUTOMATED** (today SA-triggered `/settlements/process`; cron it) —
  future follow-up.
- Merchants ALWAYS see a single payout balance in their dashboard (sum across rails);
  rails + our float are internal/SA-only.

## ✅ DEPLOYED + COMMITTED 2026-06-20 — commit `2325f6e` on main, PUSHED (server==repo==origin/main).
- Also deployed same day: **audit null-actor fix** — `AuditLog.actorId` now nullable
  (migration `20260620_audit_nullable_actor.sql`, `ALTER COLUMN actor_id DROP NOT NULL`,
  schema actor `User?`); fixes system-initiated audits (e.g. RAIL_INCIDENT) silently
  failing. prisma client regenerated v5.22.0. (In the same commit 2325f6e.)
- RAIL low-balance threshold (`railHealth.js` `LOW_BALANCE_KOBO`, default ₦5m, env
  `RAIL_LOW_BALANCE_KOBO` on 176). History 2026-06-20: set ₦100k → then **SILENCED for a
  week: RAIL_LOW_BALANCE_KOBO=0** (alert never fires since balance ≥ 0). **AUTO-RESTORE
  scheduled** via a PERSISTENT systemd timer ON 176 (not the cloud /schedule — a remote
  agent has no SSH creds/repo access, and we won't store the root password in the cloud):
  units `/etc/systemd/system/paylode-rail-restore.{service,timer}` + script
  `/usr/local/bin/paylode-rail-restore.sh` → OnCalendar `2026-06-27 10:00 CEST` (=08:00 UTC
  =09:00 Lagos), Persistent=true (survives reboot); sets RAIL_LOW_BALANCE_KOBO=10000000 +
  `pm2 restart all --update-env`. Verify: `systemctl list-timers paylode-rail-restore.timer`.
  Server TZ = Europe/Berlin. Env-only, NOT in repo; .env backups /root/envbackup-*.
- 176 backend+migrations as app user, 45+176 frontend v81.
- Verified: merchant_wallets has ONLY composite `(merchant_id, rail_id)` unique; the 1
  existing balance (DrinksArena ₦3,575.28) backfilled to PalmPay rail; rail_rebalances
  created; new rebalance routes 401; /health 200; pm2 6/6; prisma client v5.22.0.
- Deploy script: `deploy_per_rail_wallets.py`. Backups on each host `/root/deploy-backup-20260620-162328`.
- **MIGRATION GOTCHAS (live DB drift) hit + fixed in the .sql:** (1) live DB already had
  the composite unique as a bare INDEX + the OLD single-col unique ALSO as an INDEX (not
  constraints) → guard on `pg_class` not `pg_constraint`, and `DROP INDEX IF EXISTS` +
  `DROP CONSTRAINT IF EXISTS` for the single-col. (2) FK `wallet_ledger_merchant_id_fkey`
  pointed at `merchant_wallets(merchant_id)` (wrong + blocks per-rail) → re-pointed to
  `merchants(id)` (0 orphans) before dropping the single-col unique.
- **KNOWN PRE-EXISTING (not from this work):** `logAudit(actorId=null,…)` for SYSTEM audits
  (e.g. RAIL_INCIDENT low-balance) fails — AuditLog.actor is a required relation; caught,
  non-fatal, but system audit rows aren't written. Fix = make AuditLog.actorId nullable +
  optional relation (small migration). PalmPay float was LOW (₦4,364) at deploy → consider top-up.

## Working copy `C:\Users\Goke\paylode-fix`. Files changed:
Backend (→176 `/opt/paylode-api/backend`):
- `prisma/schema.prisma` — MerchantWallet `@@unique([merchantId, railId])`; new
  `RailRebalance` model; WalletLedger entryType +REBALANCE.
- `prisma/migrations/20260620_per_rail_wallets.sql` (NEW) — drop old single-balance
  unique (dynamic name lookup), backfill existing balances onto PalmPay rail, add
  composite unique. Idempotent.
- `prisma/migrations/20260620_rail_rebalances.sql` (NEW) — treasury-transfer obligations.
- `src/routes/payouts.js` — helpers `railBalancesForMerchant`/`remainingDailyCap`/
  `allocateItemsAcrossRails`; rail-tagged `/wallet/fund` (rail_id or allocations[]);
  per-rail batch-creation debit + items tagged rail_id; routing derives groups from
  item rail_id (no SA allocations); NEW `/admin/wallet/rebalance` (+ `/rebalances`,
  `/:id/settle`); `/admin/wallets` aggregates per-merchant total + per-rail breakdown;
  per-rail failure refund; ledger-query JOIN fix (was multiplying rows per rail).
- `src/services/payoutSettle.js` — webhook/poller failure refund → correct (merchant,rail) row.
- `src/routes/palmpay-webhook.js` — static per-merchant VA cash-in is now a COLLECTION
  (records a SUCCESS transaction, config-driven merchant-funded fee, settles to
  merchant bank, dispatches webhook); REMOVED the old payout-wallet top-up (was the
  collections↔payouts mixing). customerEmail placeholder `palmpay-va@collections.local`;
  railCost left 0 (refine when static VAs go live — they're not provisioned yet).
Frontend (→45+176 web roots):
- `api-wiring.js` (v81) — funding modal rail selector; Rebalance action; Pending
  Transfers view; routing = one-click confirm; wallets table per-rail breakdown; FIX
  merchant balance card `fmtNaira(w.balance)` (was `*100` → 100× inflated).
- `dashboard.html` — `api-wiring.js?v=81`.

Validation: `node --check` clean on all edited JS. `prisma validate` couldn't run
locally (project pins Prisma v5 but it's not in node_modules; npx pulled incompatible
v7) → schema validate + `prisma generate` happen on 176 at deploy.

## FOLLOW-UPS (not built)
- "Collection wallet" reporting view = pending-settlement total + unified typed txn feed
  (collections / settlements-out / payouts / funding-in / fees / rebalance).
- Settlement automation (cron `/settlements/process`).
- Static-VA collection: add rail cost from `rail_costs`, real fee model, when static
  per-merchant VAs are actually provisioned.

See [[project-palmpay-integration]], [[project-paylode]], [[feedback-paylode-money-signoff]].
