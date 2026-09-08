# POL-08 — Business Continuity and Disaster Recovery
> **[DRAFT POLICY — NOT YET APPROVED]**
> Prepared for Paylode Services Limited in support of Alpha Morgan Bank
> assessment AMB-ISO-VRQ-019. This document has **no force and is not evidence**
> until it is reviewed, amended to reflect Paylode's actual practice, versioned,
> dated and signed by a director. Do not attach it to the questionnaire in draft.

| | |
|---|---|
| **Document ID** | PSL-POL-08 |
| **Version** | 0.1 (draft) |
| **Owner** | Chief Technology Officer |
| **Approver** | Board of Directors, Paylode Services Limited |
| **Approved on** | ______ |
| **Next review** | Annually, or on material change |
| **Classification** | Internal |

---

## 1. Scope and objective

To maintain, or restore within agreed time limits, the services Paylode provides
to merchants and to its bank partners — with priority on money-movement integrity.
**No continuity action may create a risk of double-payment or lost funds.** A
delayed payment is recoverable; a duplicated one may not be.

## 2. Business impact analysis

| Service | Criticality | Max tolerable outage | Impact |
|---|---|---|---|
| Payout dispatch | **Critical** | 4 hours | Merchants cannot disburse; beneficiaries unpaid |
| Collection webhook ingestion | **Critical** | 1 hour | Credits unrecorded; **reconciliation risk grows with the outage** |
| Settlement processing | **Critical** | 24 hours | Merchants unfunded; cycle slips |
| Hosted checkout | High | 4 hours | Merchants cannot collect card payments |
| Merchant dashboard | Medium | 24 hours | No self-service; operations can act on merchants' behalf |
| Invoicing / wallet / assistant | Medium | 24 hours | Product features degraded; **payments unaffected** — these run as separate processes |
| Marketing site | Low | 72 hours | Reputational only |

Collection webhook ingestion carries the shortest tolerance because a missed
notification is not merely a delay — it is an unrecorded credit that must later be
reconciled against the Bank's records.

## 3. Continuity capability today

| Capability | Status |
|---|---|
| Process-level redundancy (pm2 cluster, auto-restart) | **In place** |
| Service isolation — a product failure cannot stop payments | **In place** |
| Graceful module degradation with health reporting | **In place** |
| Multi-rail failover for payouts | **In place** |
| Deploy rollback from timestamped backups | **In place** |
| Self-healing payout reconciliation (30s / 5min / 15min watchdogs) | **In place** |
| Static-content failover origin | **In place** |
| **Automated encrypted off-site database backup** | **NOT IN PLACE — GAP-25, highest priority** |
| **Database replication / standby host** | **NOT IN PLACE — GAP-06** |
| **Tested failover** | **NOT IN PLACE — GAP-26** |

## 4. Recovery objectives

| Scenario | Current | Target after GAP-06 and GAP-25 |
|---|---|---|
| Process crash | Seconds (automatic) | Unchanged |
| Product service failure | No payment impact | Unchanged |
| Rail unavailable | Immediate re-route | Unchanged |
| **Application host loss** | **Undefined — no standby, no verified backup** | **RTO ≤ 4 hours · RPO ≤ 15 minutes** |
| Web host loss | Minutes (Cloudflare failover origin) | Unchanged |
| Data corruption / ransomware | **Not recoverable** | **RPO ≤ 24 hours** from off-site backup |
| Region or provider loss | Not recoverable | RTO ≤ 24 hours |

The current column must be stated to counterparties as it is. A recovery objective
that no mechanism can deliver is not a commitment; it is a misstatement.

## 5. Backup standard

| Property | Requirement |
|---|---|
| Scope | Full PostgreSQL dump; application configuration; nginx and pm2 configuration; encryption key custody records |
| Frequency | **Nightly full**, plus continuous WAL archiving once replication is in place |
| Encryption | Encrypted at rest with a key held separately from the backup store |
| Location | **Off-site**, on infrastructure independent of both production hosts |
| Retention | 30 daily, 12 weekly, 12 monthly |
| Access | Restricted to the CTO and one nominated deputy; access logged |
| Immutability | Write-once or object-lock storage where available, so ransomware cannot reach the backups |
| **Restore testing** | **Quarterly**, to an isolated environment, with row counts and ledger integrity verified and the result recorded |

An untested backup is not a backup. The quarterly restore test is the control the
Bank is actually asking for at item 12.7 — not the existence of a dump file.

## 6. Disaster recovery procedure

1. **Declare** — the CTO or a director declares a disaster and notifies the
   response team and affected bank partners.
2. **Assess** — determine scope and whether data integrity is affected.
3. **Recover** — promote the standby, or rebuild from infrastructure code and
   restore the most recent verified backup.
4. **Reconcile before resuming money movement** — this step is mandatory and is
   never skipped for speed. Reconcile every in-flight payout and collection
   against the rail's and the Bank's records. **Re-query, never re-send.**
5. **Resume** — restore service, monitor at heightened sensitivity.
6. **Notify** — inform merchants and bank partners of restoration and of any
   transaction requiring their action.
7. **Review** — post-incident review within 10 business days (POL-04 Appendix C).

## 7. Testing

| Test | Cadence |
|---|---|
| Backup restore verification | **Quarterly** |
| Failover to standby | **Annually**, once the standby exists |
| Full DR simulation with the response team | **Annually** |
| Rail failover verification | Semi-annually (exercisable in production by disabling a rail) |

Every test produces a written report: scope, participants, timings against RTO and
RPO, what failed, and dated remedial actions.

## 8. Capacity and demand management

Paylode forecasts payout float requirements daily from actual destination-bank
demand over a rolling history window and pre-funds each rail accordingly.
Per-rail TPS limits and daily value caps prevent partner overload. Rail float is
polled continuously with low-balance alerting.

**To be added (GAP-27):** documented headroom thresholds for CPU, memory, disk and
database connections with alerting; load testing of the collection and payout
paths at the projected peak from Annex F §16.10; and a scaling runbook covering
vertical resize and horizontal worker addition ahead of known peaks such as
month-end salary runs.

## 9. Crisis communication

| Audience | Channel | Owner | Timing |
|---|---|---|---|
| Bank partners | Direct to the named contact | CTO | **Within 1 hour of declaration** |
| Merchants | Email + dashboard banner | Operations | Within 2 hours |
| Staff | Internal channel | CTO | Immediately |
| CBN | Per licence conditions | Compliance | Per the applicable circular |
| Public | Status page | Communications | As material |

---

**Approval**

| | Name | Title | Signature | Date |
|---|---|---|---|---|
| Prepared by | | | | |
| Approved by | | Director | | |
