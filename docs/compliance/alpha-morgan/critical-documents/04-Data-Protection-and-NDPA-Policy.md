# Data Protection and NDPA Compliance Policy

**Paylode Services Limited** · CBN-licensed Payment Solution Service Provider
Prepared for: **Alpha Morgan Bank — Information Security Division**
Assessment reference: **AMB-ISO-VRQ-019** · Classification: **CONFIDENTIAL**

| | |
|---|---|
| **Document ID** | PSL-EV-04 |
| **Version** | 1.0 |
| **Policy owner** | Data Protection Officer — [                    ] |
| **Approved by** | [                    ], Director |
| **Date of approval** | [                    ] |
| **Review cycle** | Annually, or on material change |
| **Addresses questionnaire items** | 13.1–13.10, Section B (data types and processing), Section F (termination and disposal) |

---

## 1. Purpose and legal basis of this policy

This policy governs Paylode's handling of personal data under the **Nigeria Data
Protection Act 2023 (NDPA)** and guidance issued by the **Nigeria Data Protection
Commission (NDPC)**, and of data processed on behalf of banks and merchants under
contract. It applies to every director, employee, contractor and sub-processor.

## 2. Controller and processor roles

Paylode acts as:

- **Data controller** for its own merchants' data and its staff data — Paylode
  determines the purposes and means of that processing.
- **Data processor** for data handled on the documented instruction of a bank or
  merchant, **including all Alpha Morgan Bank data under this engagement**. In this
  role Paylode acts only on instruction and does not determine the purposes of
  processing.

The **Data Protection Officer** is accountable for this policy, for the NDPC
relationship, for the annual Data Protection Compliance Audit, and for the register
of processing activities.

| Registration | Reference | Date | Expiry |
|---|---|---|---|
| NDPC registration (NDPA 2023) | [                    ] | [              ] | [              ] |
| Data Protection Compliance Audit filing | [                    ] | [              ] | [              ] |
| Licensed Data Protection Compliance Organisation engaged | [                    ] | [              ] | — |

## 3. Lawful basis of processing

| Processing activity | Lawful basis |
|---|---|
| Payment execution and settlement | Performance of a contract |
| KYC, AML/CFT screening and record-keeping | Legal obligation (CBN, NDPA) |
| Fraud prevention and platform security | Legitimate interest |
| Marketing communications | Consent — freely given, and withdrawable |

---

## 4. Data classification

| Class | Definition | Handling rule |
|---|---|---|
| **C4 — Restricted** | Data whose disclosure causes direct financial loss or regulatory breach: BVN, NIN, settlement account numbers, API credentials, webhook secrets, password hashes, second-factor seeds, encryption keys | Encrypted or hashed at rest; never written to logs; never present in non-production; access limited to named roles with audit |
| **C3 — Confidential** | Customer and merchant personal data, transaction records, ledger entries, KYC documents, **Bank data received under this engagement** | Encrypted in transit; role-gated; audit-logged on change; retained per section 7 |
| **C2 — Internal** | Operational configuration, rail costs, platform settings, internal reports | Staff access only |
| **C1 — Public** | Marketing site, published API documentation, SDK packages | No restriction |

## 5. Bank data inventory

The complete set of Alpha Morgan Bank data Paylode will handle. Paylode requests
nothing beyond this list.

| Data type | Class | Direction | Stored | Purpose |
|---|---|---|---|---|
| Virtual account number issued by the Bank | C3 | Bank to Paylode | Yes | Attribute incoming credits to the correct merchant and customer |
| Virtual account name and reference | C3 | Both | Yes | Provisioning and reconciliation |
| Payer name, payer bank, payer account (masked where supplied) | C3 | Bank to Paylode | Yes | Collection record, AML surveillance, dispute handling |
| Transaction amount, currency, timestamp, session identifier, Bank reference | C3 | Both | Yes | Ledger, settlement, reconciliation |
| Beneficiary bank code, account number, resolved account name | C3 | Paylode to Bank | Yes | Payout instruction and its audit record |
| Payout narration and reference | C3 | Paylode to Bank | Yes | Reconciliation |
| Collection account balance and statement lines | C2/C3 | Bank to Paylode | Yes | Float management and daily reconciliation |
| Bank API credentials and certificates | **C4** | Bank to Paylode | Environment configuration only — **never in source control** | Authenticate to the Bank |
| **Cardholder data (PAN, CVV, PIN)** | — | — | **Never stored** | Paylode stores no card data in plaintext; card rails are external |
| **Bank employee records** | — | — | **Not requested, not required** | Not applicable to this engagement |

### 5.1 Processing operations performed on Bank data

Storage; matching (credit to merchant to settlement); enrichment (bank-code
resolution, fee and VAT computation); aggregation (settlement batching);
transmission (to the merchant by signed webhook, and to the merchant's settlement
bank); surveillance (AML rule evaluation); reconciliation; and deletion per
section 7.

**Paylode does not perform profiling, does not resell data, does not conduct
secondary analytics, and does not use Bank data to train any model.**

## 6. Security of processing

| Control | Implementation |
|---|---|
| Field-level encryption | AES-256-GCM with a per-operation initialisation vector and authentication tag, applied to settlement account numbers |
| Credential storage | API keys stored only as a SHA-256 hash — plaintext is never persisted; passwords under bcrypt |
| Transport | TLS 1.2 minimum, TLS 1.3 preferred; HSTS with a one-year max-age including subdomains |
| Integrity | HMAC-SHA512 signatures on webhooks, verified over the raw body with a constant-time comparison |
| Access control | Role-based with granular permissions, re-validated against the database on every request; multi-tenancy enforced by scoping every query to the authenticated merchant |
| Second factor | Time-based one-time passwords; step-up re-authentication required to reveal or rotate a signing secret |
| Audit | Every state-changing action records actor, action, entity, full before and after state, and source IP |
| Data minimisation | KYC evidence is tiered to the merchant's transaction ceiling; card data is never stored |

---

## 7. Retention and disposal

Retention is set by CBN and NDPC obligations that bind a licensed payment service
provider, not by operational convenience.

| Data category | Retention period | Driver |
|---|---|---|
| Transaction, ledger, settlement and payout records | **10 years** from transaction date | CBN AML/CFT record-keeping |
| KYC records and verification reports | **10 years** after the relationship ends | CBN AML/CFT |
| AML flags, compliance exceptions, suspicious activity records | **10 years** | CBN AML/CFT |
| Audit logs | **7 years** | Forensic and regulatory examination |
| Application and API logs | **12 months** minimum | Bank requirement |
| KYC document images | 10 years, then secure deletion | CBN AML/CFT |
| Marketing and support correspondence | 2 years | NDPA minimisation |
| Backups | Rolling 90 days, then overwritten | Operational |

### 7.1 Disposal method — NIST SP 800-88 Rev. 1

| Medium | Method |
|---|---|
| Encrypted volumes and cloud storage | **Cryptographic erase** — destruction of the key renders the data unrecoverable |
| Database records | Hard delete, with the deletion recorded in the audit log |
| Backups | Expire on the rolling cycle; no selective restoration of expired data |
| Physical media at end of life | `Purge` per SP 800-88; destruction certificate retained |
| Paper | Cross-cut shredding |

### 7.2 Customised retention

The Bank may request a retention schedule **at or above** the statutory floors
above. Paylode **cannot** delete AML-relevant records earlier than the CBN retention
period, even on the Bank's instruction, and the Data Processing Agreement should
record that carve-out explicitly. A vendor who promises unconditional early
deletion of AML records is either misunderstanding the obligation or planning to
breach it.

---

## 8. Data subject rights

Paylode fulfils access, rectification, erasure, restriction, portability and
objection requests **within 30 days** of a verified request, extendable once by a
further 30 days with notice to the requester.

Requests are received at `dpo@paylodeservices.com` or through the published
self-service deletion pages on the Paylode website.

**Where Paylode acts as processor**, a request received directly is forwarded to the
controller within **3 business days** and is actioned only on the controller's
instruction. Every request and its outcome is recorded in the data subject request
log.

**Statutory carve-out.** Erasure does not extend to records Paylode must retain
under CBN AML/CFT rules. The requester and the controller are told this explicitly,
with the retention basis and the date on which the record becomes erasable.

---

## 9. Cross-border transfer and data residency

Personal data of Nigerian data subjects is processed within Nigeria wherever
possible. Where a sub-processor operates outside Nigeria, transfer proceeds only on
a lawful mechanism under the NDPA — adequacy, standard contractual clauses, or
another permitted basis — recorded in the sub-processor register.

| Processing location | System | Data | Transfer mechanism |
|---|---|---|---|
| [                    ] | Application and PostgreSQL | All transactional and Bank data | [                    ] |
| [                    ] | KYC document storage | KYC document images | [                    ] |
| Global (anycast edge) | CDN / TLS termination | In transit only; no payload at rest | [                    ] |

## 10. Sub-processors

| # | Sub-processor | Role | Bank data? | Location | Safeguard |
|---|---|---|---|---|---|
| 1 | Hosting provider | Application and database hosting | **Yes — all** | [              ] | [                    ] |
| 2 | CDN / edge provider | TLS, CDN, DDoS, DNS | In transit only | Global | [                    ] |
| 3 | PalmPay | Payment rail | No | Nigeria | [                    ] |
| 4 | Parallex Bank | Payment rail | No | Nigeria | [                    ] |
| 5 | Interswitch | Card switching | No | Nigeria | [                    ] |
| 6 | KYC / identity provider | BVN, NIN, corporate verification | No | Nigeria | [                    ] |
| 7 | Document storage provider | KYC document images | No | [              ] | [                    ] |
| 8 | SMS / messaging provider | Notification delivery | Only where a merchant configures it | Nigeria | [                    ] |
| 9 | Email provider | Transactional email | Only where a merchant configures it | [              ] | [                    ] |
| 10 | Source control and CI provider | Source code; no production data | No | [              ] | [                    ] |

**Adding Alpha Morgan Bank as a rail does not expose Bank data to Paylode's other
payment rails.** Rails 3, 4 and 5 above are alternatives to the Bank, not
downstream recipients of its data.

**Change notification.** Paylode will give the Bank **not less than 30 days' written
notice** before any new sub-processor gains access to Bank data, with a right to
object. Emergency substitution is notified immediately with the reason and the
controls applied to the replacement.

## 11. Data Processing Agreement

Paylode is ready to execute the Bank's Data Processing Agreement. Paylode's standard
position, offered for incorporation:

- process Bank data only on the Bank's documented instructions;
- impose confidentiality obligations on every authorised person, surviving termination;
- maintain the technical and organisational measures in section 6;
- **notify the Bank within 24 hours** of any actual or suspected breach affecting Bank data;
- not engage a further sub-processor for Bank data without prior written consent;
- assist the Bank with data subject requests, impact assessments and regulatory enquiries;
- submit to audit, or provide an equivalent independent report;
- on termination, return or destroy Bank data per section 12 and certify it.

---

## 12. Contract termination and data disposal

| Question | Paylode's position |
|---|---|
| Return or deletion of Bank data at contract end | Bank data is exported in an agreed machine-readable format if requested, then deleted from primary systems within **30 days** of the termination notice. Backups expire within **90 days** as the rolling cycle completes. |
| Secure-erase method and certification standard | **NIST SP 800-88 Rev. 1** — cryptographic erase for encrypted volumes; `Clear` or `Purge` as applicable. A **certificate of destruction** is issued to the Bank. |
| Sub-processor deletion | Sub-processors are instructed within **5 business days** and written confirmations are collected and provided to the Bank. |
| Deletion from backups on a data subject erasure request | Yes — primary systems within 30 days; backups on the rolling 90-day cycle. Subject to the AML retention carve-out in section 7.2. |
| Contractual timeframe following termination notice | **30 days** for primary systems; **90 days** for full backup expiry. |
| Protection if Paylode becomes insolvent | Bank data is held as bailee, is **not a Paylode asset**, and is not available to creditors. The agreement should record a step-in or escrow right, a standing instruction for return or destruction, and immediate notification of any insolvency event. *To be settled by legal counsel.* |

---

## 13. Non-production environments

**Production personal data must not be copied into development, test or staging
environments.** This prohibition admits no exception.

Sandbox environments are seeded with synthetic data. Separation is enforced by
credential — sandbox and live API keys are distinct, every transaction record
carries an environment flag, and live money movement additionally requires an
administrator to enable live mode on the merchant.

**Answer to the Bank's question "Will any Bank data be used in non-production
environments?" — No.**

## 14. Privacy by design

Features handling personal data undergo a Data Protection Impact Assessment before
release where the processing is high risk. New data fields are added only with a
recorded purpose, lawful basis and retention period.

## 15. Breach notification

Governed by **PSL-EV-02 — Incident Response and Business Continuity Policy**,
section 6. In summary: the NDPC within 72 hours of awareness; **Alpha Morgan Bank
within 24 hours of confirmed impact**; affected data subjects without undue delay
where the risk to their rights is high.

---

## Document control

| Field | Value |
|---|---|
| Prepared by | [                                        ] |
| Reviewed by | [                                        ] |
| Approved by | [                                        ] |
| Signature | [                                        ] |
| Date of issue | [                    ] |
| Next review | [                    ] |
