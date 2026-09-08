# ANNEX I — Business Continuity and Disaster Recovery
### Paylode Services Limited · Alpha Morgan Bank AMB-ISO-VRQ-019 · CONFIDENTIAL

**Answers:** Domain 12 (12.1–12.7)
**Status:** resilience within the primary site is [VERIFIED]; cross-site DR is
[GAP]. Both are stated plainly below.

---

## I.1 Resilience that exists today (verified)

| Layer | Control | Source |
|---|---|---|
| Process redundancy | `paylode-core` runs as a **pm2 cluster (×2 workers)**; pm2 restarts any crashed process automatically | `docs/DEPLOYMENT.md`, `ecosystem.config.js` |
| Service isolation | Four independent pm2 services (core, invoicing, wallet, assistant) plus two workers; an invoicing failure cannot take down the payout path | `nginx/paylode-176-router.conf` |
| Graceful degradation | Modules are mounted behind a guard — a module that fails to load is reported `failed` at `/health/modules` while the rest of the platform serves normally; the platform returns `degraded`, not dead | `backend/src/appFactory.js`, `modules/registry.js` |
| Fallback deployment mode | The monolith entry (`src/server.js`) runs the entire platform in one process from the same code, and is retained as the tested fallback if the split topology misbehaves | `backend/src/server.js` |
| Static-content failover | Cloudflare holds **176 as a failover origin** for the static frontend; the GitHub Action refreshes it on every push even if the primary deploy step fails, so the fallback never goes stale | `.github/workflows/deploy.yml` |
| Deploy rollback | Every deploy writes the previous version of each overwritten file to `/root/deploy-backup-<timestamp>/` on the target host | `docs/DEPLOYMENT.md` |
| Health probes | `/health` (database connectivity + module summary) and `/health/modules` (per-module status), returning `healthy` / `degraded` / `unhealthy` | `backend/src/appFactory.js` |
| Self-healing money paths | Payout auto-dispatch recovery every 30 seconds; stuck-payout monitor every 5 minutes; payout watchdog re-queries and auto-resolves items processing >15 minutes | `modules/gateway-core/jobs.js`, `cron/*` |
| Rail redundancy | Multiple live payment rails with per-merchant split routing and automatic exclusion of a rail that is not `LIVE`/`payout_enabled` — **a single rail outage does not stop disbursement** | `routes/payouts.js: resolveRouteRail` |

The rail-failover property is worth stating prominently: if Alpha Morgan Bank's
channel is unavailable, Paylode routes to an alternative rail rather than queuing
indefinitely, and vice versa — which also means Paylode does not become a
single-rail dependency risk to the Bank.

---

## I.2 What does not exist — state it, do not dress it up

| Missing control | Consequence |
|---|---|
| **No warm or standby site** | Loss of host 176 takes the API and the database offline. Static pages stay up via the Cloudflare failover origin, which is cosmetic, not functional. |
| **No PostgreSQL replication** | No standby copy of the transactional record outside the primary host. |
| **No documented, automated, tested backup** | No `pg_dump` schedule, no off-site copy and no restore test is evidenced anywhere in the repository or deployment documentation. **This is the single most serious operational gap in this pack.** |
| **No BCP or DRP document** | Nothing to attach at 12.1 and 12.2 until the drafts in `policy/POL-08` are approved. |
| **No BCP/DR test** | Nothing to attach at 12.4. |

**GAP-06** (DR site and replication) and **GAP-25** (backup and restore testing).
GAP-25 should be closed **this week, before the questionnaire is returned** — it is
a few hours of work, it removes an existential risk to Paylode itself, and 12.7 is
a HIGH-priority item the Bank will not waive.

---

## I.3 Domain 12 responses

| # | Question | Answer | Detail |
|---|---|---|---|
| 12.1 | Board-approved BCP covering Bank-connected services, named owner | **Partial** | `policy/POL-08` is drafted and covers the Bank-connected services; it needs director approval, a signature and a named owner (recommend the CTO). |
| 12.2 | DRP with RTO/RPO for settlement systems | **Partial** | Drafted in POL-08 §4. **Honest current capability vs. committed target — see I.4.** |
| 12.3 | Distance and connectivity between primary and DR sites | **Partial** | No DR site exists today. Target architecture and the diagram are in `ANNEX-B` §B.6; the target places the DR host in a **different Contabo region from the primary**, with PostgreSQL streaming replication over an encrypted tunnel. |
| 12.4 | BCP/DR tested in the last 12 months | **No** | GAP-26. Once GAP-25 and GAP-06 are delivered, run a documented failover test and attach the report. |
| 12.5 | Contracted uptime SLA and penalties | **To be set commercially** — see I.5 |
| 12.6 | Demand forecasting and resource scaling | **Partial** | Verified mechanisms: per-rail TPS limits and daily value caps prevent overload of partners; a **daily rail pre-funding cron** forecasts float requirements from actual destination-bank demand over a rolling history window and pre-funds each rail accordingly (`cron/railFundingCron.js`); rail float is polled continuously with low-balance alerting; payout dispatch is chunked and concurrency-bounded. **Not present:** documented capacity planning against CPU/memory/connection headroom, and load testing. GAP-27. |
| 12.7 | Backups encrypted, off-site, restore-tested | **No** | GAP-25. Do not answer "Yes" — an unverified backup claim is the one a bank auditor tests first, and a failed restore during onboarding is unrecoverable reputationally. |

---

## I.4 RTO and RPO — current reality and committed target

Give the Bank both columns. A vendor who states an honest current position with a
funded improvement plan reads as competent; one who states a target as though it
were current reads as either careless or dishonest.

| Scenario | Capability **today** | Committed target after GAP-06 + GAP-25 |
|---|---|---|
| Single pm2 process crash | **Seconds** — pm2 auto-restart, cluster peer serves | Unchanged |
| One product service fails (invoicing/wallet/assistant) | **No impact on payments** — money core is a separate process | Unchanged |
| One payment rail unavailable | **Immediate** — automatic re-route to another live rail | Unchanged |
| Application host (176) failure | **RTO: undefined. RPO: undefined — potential total data loss.** No standby, no verified backup. | **RTO ≤ 4 hours, RPO ≤ 15 minutes** via streaming replica + promoted standby |
| Web host (45) failure | Minutes — Cloudflare fails over to the 176 origin for static content; API unaffected as it lives on 176 | Unchanged |
| Data corruption / ransomware | **Not recoverable today** | **RPO ≤ 24 hours** from encrypted off-site nightly backups with quarterly restore tests |

Target dates for GAP-06 and GAP-25 belong in `GAP-REGISTER.md` and should be
real dates Paylode will meet.

---

## I.5 Uptime SLA (12.5) — recommendation

The repository cannot set a commercial SLA. Recommended position, defensible on
the current architecture once GAP-06 and GAP-25 are delivered:

| Term | Proposed |
|---|---|
| Monthly uptime commitment (Bank-facing collection and payout APIs) | **99.5%** — approximately 3h 39m of allowed downtime per month |
| Measurement | Successful `/health` probes at 1-minute intervals from an independent monitor, excluding scheduled maintenance |
| Scheduled maintenance | Notified 5 business days in advance; performed 00:00–04:00 WAT; capped at 4 hours per month |
| Service credits | 10% of the monthly fee below 99.5%; 25% below 99.0%; 50% below 98.0% |
| Reporting | Monthly availability report to the Bank |

Do **not** offer 99.9% on a single-host architecture with no standby. 99.9% is
43 minutes per month — one unplanned reboot breaches it. Commit to 99.5% now and
raise it after the DR work lands; a raised SLA is a good conversation to have
later, a breached one is not.
