# POL-03 — Data Protection, Retention and Disposal
> **[DRAFT POLICY — NOT YET APPROVED]**
> Prepared for Paylode Services Limited in support of Alpha Morgan Bank
> assessment AMB-ISO-VRQ-019. This document has **no force and is not evidence**
> until it is reviewed, amended to reflect Paylode's actual practice, versioned,
> dated and signed by a director. Do not attach it to the questionnaire in draft.

| | |
|---|---|
| **Document ID** | PSL-POL-03 |
| **Version** | 0.1 (draft) |
| **Owner** | Data Protection Officer |
| **Approver** | Board of Directors, Paylode Services Limited |
| **Approved on** | ______ |
| **Next review** | Annually, or on material change |
| **Classification** | Internal |

---

## 1. Purpose

This policy governs Paylode's handling of personal data under the **Nigeria Data
Protection Act 2023 (NDPA)** and NDPC guidance, and of data processed on behalf of
banks and merchants under contract.

## 2. Roles

Paylode acts as a **data controller** for its own merchants' and staff data, and as
a **data processor** for data it handles on the instruction of a bank or merchant —
including all Bank data under the Alpha Morgan Bank engagement. Where Paylode is a
processor, it acts only on documented instruction and does not determine the
purposes of processing.

The **Data Protection Officer** is accountable for this policy, for the NDPC
relationship, and for the annual Data Protection Compliance Audit.

## 3. Lawful basis

| Processing | Basis |
|---|---|
| Payment execution | Performance of a contract |
| KYC, AML/CFT screening and record-keeping | Legal obligation (CBN, NDPA) |
| Fraud prevention and platform security | Legitimate interest |
| Marketing communications | Consent, freely given and withdrawable |

## 4. Classification and minimisation

Data is classified per Annex D §D.1 (Restricted / Confidential / Internal /
Public). Paylode collects the minimum necessary: KYC evidence is **tiered** to the
merchant's transaction ceiling; card PAN, CVV and PIN are **never stored**; Bank
data is limited to the fields listed in Annex D §D.2.

## 5. Security of processing

Restricted data is encrypted at rest at the application layer (AES-256-GCM) or
stored as a one-way hash. All data in transit is protected by TLS 1.2 or above.
Access is role-based, least-privilege and audited. Detailed controls are in
Annexes B, C, D and E.

## 6. Data subject rights

Paylode fulfils access, rectification, erasure, restriction, portability and
objection requests **within 30 days** of a verified request, extendable once by 30
days with notice. Requests reach `dpo@paylodeservices.com` or the published
self-service deletion pages.

Where Paylode is a **processor**, requests received directly are forwarded to the
controller within **3 business days** and are actioned only on the controller's
instruction. Every request and its outcome is recorded in the DSR log.

**Statutory carve-out:** erasure does not extend to records Paylode is required to
retain under CBN AML/CFT rules (§7). The requester and the controller are told
this explicitly, with the retention basis and the date the record becomes
erasable.

## 7. Retention and disposal

Retention periods are set out in **Annex D §D.4** — 10 years for transaction, KYC
and AML records under CBN AML/CFT rules; 7 years for audit logs; 12 months minimum
for application logs; 90 days rolling for backups.

**Disposal method — NIST SP 800-88 Rev. 1:**

| Medium | Method |
|---|---|
| Encrypted volumes and cloud storage | **Cryptographic erase** — destruction of the key renders the data unrecoverable |
| Database records | Hard delete, with the deletion recorded in the audit log |
| Backups | Expire on the rolling cycle; no selective restoration of expired data |
| Physical media at end of life | `Purge` per SP 800-88; destruction certificate retained |
| Paper | Cross-cut shredding |

**On contract termination** (Section F of the questionnaire): Bank data is
exported in an agreed machine-readable format if requested, deleted from primary
systems within **30 days** of the termination notice, purged from backups within
**90 days** as the rolling cycle completes, and sub-processors are instructed
within **5 business days** with confirmations collected. A **certificate of
destruction** is issued to the Bank, subject to the AML retention carve-out above.

## 8. Cross-border transfer

Personal data of Nigerian data subjects is processed within Nigeria wherever
possible. Where a sub-processor operates outside Nigeria, transfer proceeds only
on a lawful NDPA mechanism — adequacy, standard contractual clauses, or another
permitted basis — recorded in the POL-06 register.

**Current position, stated honestly:** production infrastructure is hosted with a
provider that has no Nigerian region, and KYC document images are stored with a
non-Nigerian provider. Migration to Nigerian-resident infrastructure is a tracked
remediation (GAP-08); SCCs are the interim mechanism.

## 9. Breach notification

A personal data breach is reported to the **NDPC within 72 hours** of becoming
aware, and to affected data subjects without undue delay where the risk to their
rights is high. Where Bank data is affected, the Bank is notified **within 24
hours** of confirmation — see POL-04 and Annex H §H.4.

## 10. Privacy by design

New features handling personal data undergo a Data Protection Impact Assessment
before release where the processing is high risk. Test environments do not use
production personal data.

## 11. Non-production data

**Production personal data must not be copied into development, test or staging
environments.** Sandbox environments are seeded with synthetic data only. This
prohibition admits no exception.

---

**Approval**

| | Name | Title | Signature | Date |
|---|---|---|---|---|
| Prepared by | | | | |
| Approved by | | Director | | |
