# POL-05 — Change Management and Secure Development
> **[DRAFT POLICY — NOT YET APPROVED]**
> Prepared for Paylode Services Limited in support of Alpha Morgan Bank
> assessment AMB-ISO-VRQ-019. This document has **no force and is not evidence**
> until it is reviewed, amended to reflect Paylode's actual practice, versioned,
> dated and signed by a director. Do not attach it to the questionnaire in draft.

| | |
|---|---|
| **Document ID** | PSL-POL-05 |
| **Version** | 0.1 (draft) |
| **Owner** | Chief Technology Officer |
| **Approver** | Board of Directors, Paylode Services Limited |
| **Approved on** | ______ |
| **Next review** | Annually, or on material change |
| **Classification** | Internal |

---

## 1. Scope

Every change to production: application code, database schema, infrastructure
configuration, third-party integrations and platform settings.

## 2. Change classification

| Class | Examples | Approval |
|---|---|---|
| **Standard** | Content updates, configuration within agreed parameters | Peer review on the pull request |
| **Normal** | Feature work, refactors, dependency upgrades, schema migrations | Peer review + deployment gates (§4) |
| **Significant** | Changes to money movement, authentication, encryption, rail routing, limits or caps | Peer review + **security officer approval** + a documented rollback plan |
| **Emergency** | Production incident fix | Deploy first; retrospective review and record **within 24 hours** |

## 3. Secure development — OWASP alignment

| OWASP Top 10 (2021) | Paylode control |
|---|---|
| A01 Broken access control | Server-side role **and** permission checks on every request, re-read from the database; every query scoped by merchant |
| A02 Cryptographic failures | AES-256-GCM field encryption; bcrypt; SHA-256 key hashing; TLS 1.2+ with HSTS (Annex E) |
| A03 Injection | Prisma ORM with parameterised queries; raw SQL only with positional parameters; `express-validator` on inputs |
| A04 Insecure design | Prepaid payout model; recall window; fail-safe on ambiguous outcomes; sandbox/live separation with an explicit go-live gate |
| A05 Security misconfiguration | `helmet` with CSP and HSTS; CORS allow-list; body-size limits; no stack traces to clients |
| A06 Vulnerable components | Lock-pinned dependencies; Dependabot and `npm audit` in the deploy gate |
| A07 Identification and authentication failures | TOTP MFA; login throttling; account lockout; immediate revocation; forced temporary-password change |
| A08 Software and data integrity failures | PR-only merges; git-clean deploy gate; md5 verification per file; signed webhooks |
| A09 Logging and monitoring failures | `audit_logs` with before/after state and IP; structured application logging; webhook delivery log |
| A10 SSRF | Outbound calls restricted to configured partner endpoints; no user-supplied URL fetching on money paths |

## 4. The deployment pipeline

Every production change passes, in order:

1. **Branch and pull request** — direct push to `main` is blocked.
2. **Peer review** — mandatory; the author cannot approve their own change.
3. **Automated checks** — unit tests, end-to-end tests, architecture verification
   (`npm run verify:arch`), SAST and dependency audit.
4. **Syntax gate** — every file parsed; any parse error aborts the deploy.
5. **Git-clean gate** — the deploy refuses to ship uncommitted files, so
   production always corresponds to a reviewable commit.
6. **Backup** — every remote file about to be overwritten is copied to a
   timestamped directory on the target host.
7. **Integrity verification** — `md5(local) == md5(remote)` per file.
8. **Reload and health check** — `pm2 reload`, then `/health` must return 200.
9. **Rollback on failure** — restore from the timestamped backup.

## 5. Segregation of duties

The author of a change is not its sole approver. For **Significant** changes the
security officer approves separately from the reviewer. Where headcount prevents
full separation of author and deployer, the compensating controls are mandatory
peer review, the git-clean gate, immutable deploy backups, and `audit_logs` on
every production configuration change — and the limitation is disclosed to
counterparties rather than concealed.

## 6. Patch management

| Severity | SLA from vendor release or advisory |
|---|---|
| Critical | **72 hours** |
| High | **7 days** |
| Medium | **30 days** |
| Low | Next scheduled maintenance |

Dependency advisories are raised automatically (Dependabot); operating system
patching on both hosts is performed on a monthly cycle with out-of-band patching
for Critical advisories. Patch compliance is reported at each Board cycle.

## 7. Database changes

Schema changes ship as versioned Prisma migrations, reviewed like code, applied
with a rollback plan, and — for any change touching money tables — tested against a
restored backup before production application.

## 8. Emergency changes

An emergency change may bypass §4 steps 1–3 but never steps 4–9. It is recorded
within 24 hours with the incident reference, what was changed, who approved it and
the follow-up work to bring the change into normal process.

---

**Approval**

| | Name | Title | Signature | Date |
|---|---|---|---|---|
| Prepared by | | | | |
| Approved by | | Director | | |
