# POL-01 — Information Security Policy
> **[DRAFT POLICY — NOT YET APPROVED]**
> Prepared for Paylode Services Limited in support of Alpha Morgan Bank
> assessment AMB-ISO-VRQ-019. This document has **no force and is not evidence**
> until it is reviewed, amended to reflect Paylode's actual practice, versioned,
> dated and signed by a director. Do not attach it to the questionnaire in draft.

| | |
|---|---|
| **Document ID** | PSL-POL-01 |
| **Version** | 0.1 (draft) |
| **Owner** | Chief Technology Officer |
| **Approver** | Board of Directors, Paylode Services Limited |
| **Approved on** | ______ |
| **Next review** | Annually, or on material change |
| **Classification** | Internal |

---

## 1. Purpose and scope

Paylode Services Limited is a CBN-licensed Payment Solution Service Provider. This
policy establishes how Paylode protects the confidentiality, integrity and
availability of the information it holds — its own, its merchants', its
merchants' customers', and that of the banks and partners it integrates with.

It applies to every director, employee, contractor and third party with access to
Paylode systems or data, and to all Paylode systems: the production hosts, the
source repository, the deployment pipeline, corporate accounts and every
sub-processor listed in the third-party register (POL-06 Appendix A).

## 2. Framework alignment

Paylode aligns to **NIST CSF 2.0** as its primary framework, with reference to
**ISO/IEC 27001:2022** (targeted for certification) and the **CBN Risk-Based
Cybersecurity Framework for Other Financial Institutions**.

| CSF 2.0 function | Paylode instrument |
|---|---|
| **Govern** | This policy; the risk register; POL-06 third-party risk |
| **Identify** | Asset and data inventory (Annex D); sub-processor register (POL-06 App. A); risk register |
| **Protect** | POL-02 access control; POL-07 key management; POL-05 change management; encryption standards (Annex E) |
| **Detect** | Audit logging; AML surveillance; payout watchdogs; log aggregation |
| **Respond** | POL-04 incident response |
| **Recover** | POL-08 business continuity and disaster recovery |

## 3. Security principles

1. **Least privilege** — access is granted by role and by explicit permission, and
   is removed when the need ends.
2. **Defence in depth** — no single control is relied upon for a security outcome.
3. **Secure by default** — new merchants start in sandbox; live money movement
   requires an explicit administrative action.
4. **Everything that moves money is audited** — actor, before state, after state,
   timestamp and source IP.
5. **Fail safe** — an ambiguous payment outcome is never resolved by re-sending
   funds; it is resolved by re-query.
6. **No secrets in source** — credentials live in environment configuration or an
   approved secrets store, never in the repository.
7. **Honest disclosure** — control gaps are recorded and remediated, not concealed.

## 4. Roles and responsibilities

| Role | Accountability |
|---|---|
| Board of Directors | Approves this policy; reviews cyber risk at least quarterly; accepts or rejects residual risk |
| **Accountable security officer (CISO or CTO)** | Owns the security programme, the risk register and this policy; reports to the Board quarterly |
| Engineering | Secure development (POL-05); patching; deployment gates |
| Compliance | AML/CFT surveillance; KYC; NDPA obligations; regulatory reporting |
| All personnel | Complete training; report suspected incidents immediately; protect credentials |

**Appendix A — RACI (item 1.7).**

| Activity | Board | Security officer | Engineering | Compliance |
|---|---|---|---|---|
| Policy approval | **A** | R | C | C |
| Risk register maintenance | I | **A/R** | C | C |
| Vulnerability remediation | I | **A** | **R** | I |
| Incident response | I | **A** | R | C |
| Access recertification | I | **A** | R | C |
| Third-party assessment | I | **A** | C | **R** |
| Regulatory reporting | I | C | I | **A/R** |
| Business continuity testing | I | **A** | **R** | I |

## 5. Risk management

A risk register is maintained covering cybersecurity, data protection,
operational and third-party risk. Each entry carries an owner, inherent rating,
controls, residual rating and a review date. It is reviewed **quarterly** by the
security officer and presented to the Board. The gap register prepared for the
Alpha Morgan Bank assessment forms the initial content.

## 6. Acceptable use

Paylode systems are for authorised business purposes. Credentials are personal and
are never shared. Multi-factor authentication is mandatory where offered. Company
data is not stored on unmanaged personal devices or unapproved cloud services.
Devices with access to production or customer data must have full-disk encryption
and automatic screen lock enabled.

## 7. Control review cycle

| Control | Cadence |
|---|---|
| This policy and all supporting policies | Annually, or on material change |
| Firewall and Cloudflare rule sets | Semi-annually, with a signed change log |
| Access recertification | Quarterly (POL-02 §5) |
| Cloud and host configuration review | Annually |
| Third-party assessments | Annually; quarterly for high-risk sub-processors |
| Business continuity test | Annually |
| Penetration test | Annually, and after any significant architectural change |

## 8. Security testing

Paylode commissions an independent VAPT by a CREST-certified or CBN-recognised
firm **at least annually** and after significant architectural change. Critical
findings are remediated within **7 days**, High within **30 days**, Medium within
**90 days**, or carry a documented, time-bound, approved exception.

## 9. Exceptions and risk acceptance

Any deviation from this policy requires a written exception recording the control,
the reason, the compensating controls, the residual risk, an expiry date and the
approver. Exceptions are reviewed at each Board cycle. **No exception may be
granted for: storage of card PAN/CVV/PIN in plaintext; disabling audit logging on
money-movement paths; or committing credentials to source control.**

## 10. Physical and workspace security

Clean desk and automatic screen lock are required. Paper containing customer or
Bank data is shredded. Production systems are hosted with third-party providers;
their physical security attestations are held in the POL-06 register.

## 11. Compliance and sanctions

Breach of this policy may result in disciplinary action up to termination and,
where the law requires, referral to the relevant authority.

---

**Approval**

| | Name | Title | Signature | Date |
|---|---|---|---|---|
| Prepared by | | | | |
| Approved by | | Director | | |
