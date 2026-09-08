# POL-06 — Third-Party and Sub-processor Risk Management
> **[DRAFT POLICY — NOT YET APPROVED]**
> Prepared for Paylode Services Limited in support of Alpha Morgan Bank
> assessment AMB-ISO-VRQ-019. This document has **no force and is not evidence**
> until it is reviewed, amended to reflect Paylode's actual practice, versioned,
> dated and signed by a director. Do not attach it to the questionnaire in draft.

| | |
|---|---|
| **Document ID** | PSL-POL-06 |
| **Version** | 0.1 (draft) |
| **Owner** | Compliance Officer |
| **Approver** | Board of Directors, Paylode Services Limited |
| **Approved on** | ______ |
| **Next review** | Annually, or on material change |
| **Classification** | Internal |

---

## 1. Scope

Every third party that stores, processes or transmits Paylode data, or on whose
availability Paylode's service depends — payment rails, hosting, KYC providers,
communications providers, storage and development tooling.

## 2. Inherent risk rating

| Rating | Criteria | Assessment cadence |
|---|---|---|
| **High** | Handles Bank data or customer PII, or moves money, or its outage stops the service | Annually + **quarterly** monitoring |
| **Medium** | Handles internal data, or its outage degrades a non-critical function | Annually |
| **Low** | No access to Paylode data | On onboarding, then on material change |

## 3. Shared responsibility

Paylode documents, for each infrastructure provider, which controls belong to the
provider (physical security, hypervisor, network fabric) and which belong to
Paylode (operating system hardening, patching, application security, access
control, encryption, backup, monitoring). **Paylode does not assume a provider
control exists because the provider is large.**

## 4. Onboarding due diligence

Before a third party gains access to Paylode data:

1. Security questionnaire proportionate to the inherent risk rating.
2. **Certificates obtained from the provider's trust portal or auditor** —
   ISO 27001, SOC 2 Type II, PCI DSS AOC as applicable — never accepted as an
   unevidenced vendor assertion.
3. Data Processing Agreement executed, incorporating the flow-down clause
   (Appendix B).
4. Data residency established and recorded.
5. Breach-notification obligations agreed, with a deadline no longer than
   Paylode's own obligation to its counterparties.
6. Exit plan: how data is returned or destroyed and how the service is replaced.

## 5. Ongoing monitoring

Annually for every third party handling Bank data (quarterly for High):
certificate currency, breach history and disclosures, financial stability,
material change of control, service performance against SLA. Findings are recorded
in the register and material concerns are escalated to the Board.

## 6. Change notification

**Paylode gives Alpha Morgan Bank not less than 30 days' written notice before any
new sub-processor gains access to Bank data**, and the Bank may object. Emergency
substitution — where a provider fails without notice — is notified immediately with
the reason and the controls applied to the replacement.

## 7. Concentration and exit risk

Paylode maintains **more than one live payment rail** with automatic routing
failover, so a single rail failure does not stop disbursement. Single points of
dependency (hosting, DNS/CDN) are recorded as concentration risks in the risk
register with a documented migration path.

## 8. Appendix A — Sub-processor register

Pre-populated from Annex G §G.1. Complete the assessment columns.

| # | Provider | Role | Data | Location | Risk | Certs held | DPA | Last assessed | Next |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Contabo | Hosting | All | ⬜ confirm | **High** | ⬜ | ⬜ | ⬜ | ⬜ |
| 2 | Cloudflare | CDN/TLS/DDoS/DNS | In transit | Global | **High** | ISO 27001, SOC 2, PCI DSS L1 | ⬜ | ⬜ | ⬜ |
| 3 | PalmPay | Rail | Txn data | Nigeria | **High** | ⬜ | ⬜ | ⬜ | ⬜ |
| 4 | Parallex Bank | Rail | Txn data | Nigeria | **High** | ⬜ | ⬜ | ⬜ | ⬜ |
| 5 | Interswitch | Card switch | Card auth | Nigeria | **High** | PCI DSS L1 ⬜ | ⬜ | ⬜ | ⬜ |
| 6 | YouVerify | KYC | Identity | Nigeria | **High** | ⬜ | ⬜ | ⬜ | ⬜ |
| 7 | Cloudinary | Doc storage | KYC images | Offshore | **High** | ISO 27001, SOC 2 | ⬜ | ⬜ | ⬜ |
| 8 | Sendchamp | SMS/WhatsApp | Phone, text | Nigeria | Medium | ⬜ | ⬜ | ⬜ | ⬜ |
| 9 | SMTP provider | Email | Email, text | ⬜ | Medium | ⬜ | ⬜ | ⬜ | ⬜ |
| 10 | Anthropic | Support assistant | Support text | Offshore | Medium | SOC 2 | ⬜ | ⬜ | ⬜ |
| 11 | GitHub | Source + CI | Source code | Offshore | Medium | ISO 27001, SOC 2 | ⬜ | ⬜ | ⬜ |
| 12 | Let's Encrypt | TLS certificates | None | Global | Low | Public CA | N/A | ⬜ | ⬜ |

## 9. Appendix B — Flow-down clause (sample for item 15.4)

> **Security and confidentiality flow-down.** The Sub-processor shall: (a) process
> Paylode Data, including data Paylode processes on behalf of a financial
> institution client ("Client Data"), only on Paylode's documented instructions;
> (b) implement and maintain technical and organisational measures no less
> protective than those Paylode owes its Clients, including encryption of Client
> Data in transit and at rest, least-privilege access control, multi-factor
> authentication for privileged access, and audit logging of access to Client
> Data; (c) ensure that every person authorised to process Client Data is bound by
> a duty of confidentiality that survives termination; (d) **notify Paylode in
> writing within twenty-four (24) hours** of becoming aware of any actual or
> suspected breach affecting Client Data, with the information Paylode requires to
> meet its own notification obligations; (e) not engage a further sub-processor
> for Client Data without Paylode's prior written consent, and impose these same
> obligations on any such sub-processor; (f) not transfer Client Data outside the
> Federal Republic of Nigeria without Paylode's prior written consent and a lawful
> transfer mechanism under the NDPA 2023; (g) permit Paylode, and any Client whose
> data is processed, to audit compliance with this clause on reasonable notice, or
> provide an equivalent independent audit report; and (h) on termination, return
> or securely destroy all Client Data in accordance with NIST SP 800-88 and
> certify such destruction in writing within thirty (30) days.

*Legal counsel should settle the final wording against the governing agreement.*

---

**Approval**

| | Name | Title | Signature | Date |
|---|---|---|---|---|
| Prepared by | | | | |
| Approved by | | Director | | |
