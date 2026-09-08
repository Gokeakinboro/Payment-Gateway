# POL-02 — Access Control and Joiners / Movers / Leavers
> **[DRAFT POLICY — NOT YET APPROVED]**
> Prepared for Paylode Services Limited in support of Alpha Morgan Bank
> assessment AMB-ISO-VRQ-019. This document has **no force and is not evidence**
> until it is reviewed, amended to reflect Paylode's actual practice, versioned,
> dated and signed by a director. Do not attach it to the questionnaire in draft.

| | |
|---|---|
| **Document ID** | PSL-POL-02 |
| **Version** | 0.1 (draft) |
| **Owner** | Chief Technology Officer |
| **Approver** | Board of Directors, Paylode Services Limited |
| **Approved on** | ______ |
| **Next review** | Annually, or on material change |
| **Classification** | Internal |

---

## 1. Principles

Access is granted on **least privilege** and **need to know**, by named individual
account only. Shared and generic accounts are prohibited on all production
systems. Every access grant has an owner, a business justification and a review
date.

## 2. Role model (as implemented)

| Role | Scope |
|---|---|
| `SUPER_ADMIN` | Full platform administration: wallet funding, rail configuration, routing, caps, go-live |
| `ADMIN` | Merchant administration and operations, without financial configuration |
| `COMPLIANCE_OFFICER` | KYC review, AML flag disposition, compliance exceptions, watchlist |
| `AGGREGATOR` | Scoped to their own merchant portfolio |
| `MERCHANT` | Scoped to their own account only |

Roles are enforced server-side on every request and are **re-read from the
database each time** — a token cannot carry a stale or elevated role. Granular
view/edit permissions apply additively on top of roles. Multi-tenancy isolation is
enforced by scoping every query to the authenticated merchant.

## 3. Authentication standards

| Control | Standard |
|---|---|
| Password minimum | 12 characters, complexity enforced, checked against known-breached lists |
| Storage | bcrypt |
| MFA | **TOTP mandatory for `SUPER_ADMIN`, `ADMIN` and `COMPLIANCE_OFFICER`**; strongly recommended for all merchant users |
| Login throttling | 10 attempts per 15 minutes per source |
| **Account lockout** | **5 consecutive failed attempts → 30-minute lockout**; administrative unlock available with identity verification |
| Session expiry | 8 hours for merchant users; **1 hour for administrative users**; re-authentication required after expiry |
| Temporary credentials | A user flagged `mustChangePassword` can reach only profile and password-change endpoints |
| Step-up authentication | Password **and** a fresh TOTP code required to reveal or rotate a webhook signing secret |

## 4. Joiners, movers, leavers

**Joiner** — access is requested by the hiring manager, approved by the security
officer, granted by role, and recorded. Background screening (§8) completes before
production access is granted. Security training completes within 5 working days.

**Mover** — the new role's access is granted and **the previous role's access is
removed in the same action**. Accumulated privilege is a finding at recertification.

**Leaver — deprovisioning SLA: all access revoked within 24 hours of departure,
and immediately on involuntary termination.** The checklist:

| # | Action | Timing |
|---|---|---|
| 1 | Disable the platform account (`isActive = false` — takes effect on the next request) | Immediate |
| 2 | Remove SSH authorised keys from both production hosts | Immediate |
| 3 | Revoke GitHub organisation membership and any deploy credentials | Immediate |
| 4 | Revoke Google Workspace and all SaaS access | Within 4 hours |
| 5 | **Rotate any shared or infrastructure credential the leaver could have known** | Within 24 hours |
| 6 | Recover company devices; confirm disk encryption and wipe | Within 5 days |
| 7 | Record completion in the leaver register | Within 24 hours |

## 5. Access recertification

**Quarterly** for every account with access to Bank-connected systems. The
security officer produces the account list with role and permissions; each owning
manager confirms or revokes; results are recorded and retained for two years.
Dormant accounts (no `lastUsedAt` activity for 90 days) are disabled by default.

## 6. Privileged and break-glass access

Production host access is by SSH key only — password authentication is disabled.
The administrator set is small, named and reviewed quarterly.

**Break-glass:** where an incident requires access beyond the normal grant, the
responder may self-authorise, and must within **1 hour** notify the security
officer, record the action, the systems touched and the justification, and
initiate rotation of any credential used. All break-glass use is reviewed at the
next Board cycle. Every privileged application action is captured in `audit_logs`
with actor, before state, after state and source IP.

## 7. Devices and remote access

Company-issued devices are required for production access. Where a personal device
is used, it must have full-disk encryption, automatic screen lock, a current
operating system and endpoint protection, and the user must accept remote wipe of
company data. Production data is not copied to local storage except as required
for a specific, recorded task.

## 8. Personnel screening

Before production or Bank-data access: identity verification, employment
references, and — for roles with financial system access — a criminal record check
and, where lawfully available, a credit check. Screening is repeated every three
years for privileged roles. Records are held by the security officer.

## 9. Segregation of duties

| Duty | Separated from |
|---|---|
| Merchant payout initiation | Payout approval above the agreed threshold |
| Wallet funding and rail rebalancing | Merchant-facing operations |
| KYC submission | KYC approval |
| Code authorship | Production deployment approval above the agreed threshold |
| Settlement account change request | Settlement account change approval |

Where headcount prevents full separation, the compensating controls are mandatory
peer review, the deployment gates in POL-05, and full audit logging — and the
limitation is disclosed rather than concealed.

---

**Approval**

| | Name | Title | Signature | Date |
|---|---|---|---|---|
| Prepared by | | | | |
| Approved by | | Director | | |
