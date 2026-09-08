# CBN Risk-Based Cybersecurity Framework — Gap Assessment

**Paylode Services Limited** · CBN-licensed Payment Solution Service Provider
Prepared for: **Alpha Morgan Bank — Information Security Division**
Assessment reference: **AMB-ISO-VRQ-019** · Classification: **CONFIDENTIAL**

| | |
|---|---|
| **Document ID** | PSL-EV-06 |
| **Version** | 1.0 |
| **Framework** | CBN Risk-Based Cybersecurity Framework and Guidelines (Payment Service Providers) |
| **Assessment date** | [                    ] |
| **Assessed by** | [                    ] |
| **Approved by** | [                    ], Director |
| **Addresses questionnaire items** | Section C (CBN framework compliance), 1.1–1.7, 10.1–10.7 |

---

## 1. Purpose and method

This is a **self-assessment** of Paylode's cybersecurity posture against the seven
parts of the CBN Risk-Based Cybersecurity Framework applicable to payment service
providers. It is prepared to support Alpha Morgan Bank's vendor due diligence and
to drive Paylode's own remediation planning.

> **Note on referencing.** The part numbering below follows the framework's
> structure as Paylode understands it. Clause-level references should be confirmed
> against the current circular before this document is relied upon externally, and
> the assessment should be validated by an independent assessor before it is
> presented as an assurance opinion rather than a self-assessment.

### 1.1 Rating scale

| Rating | Meaning |
|---|---|
| **Implemented** | The control operates, is evidenced, and is repeatable |
| **Partial** | The control operates in substance but is undocumented, informal, or incomplete in scope |
| **Planned** | The control is designed and scheduled but is not yet operating |
| **Not implemented** | The control does not operate |
| **Not applicable** | The control addresses a capability Paylode does not have; justification recorded |

---

## 2. Assessment summary

| Part | Domain | Implemented | Partial | Planned / Not implemented | N/A |
|---|---|---|---|---|---|
| 1 | Cybersecurity Governance and Oversight | [    ] | [    ] | [    ] | [    ] |
| 2 | Cybersecurity Risk Management System | [    ] | [    ] | [    ] | [    ] |
| 3 | Cyber Resilience Assessment | [    ] | [    ] | [    ] | [    ] |
| 4 | Cybersecurity Operational Resilience | [    ] | [    ] | [    ] | [    ] |
| 5 | Cyber Threat Intelligence | [    ] | [    ] | [    ] | [    ] |
| 6 | Metrics, Monitoring and Reporting | [    ] | [    ] | [    ] | [    ] |
| 7 | Compliance with Statutory and Regulatory Requirements | [    ] | [    ] | [    ] | [    ] |

*Complete after working through sections 3–9.*

---

## 3. Part 1 — Cybersecurity Governance and Oversight

| # | Framework requirement | Rating | Evidence / basis | Remediation | Owner | Target |
|---|---|---|---|---|---|---|
| 1.1 | Board-approved cybersecurity policy, reviewed at least annually | [              ] | Information Security Policy | [              ] | [        ] | [        ] |
| 1.2 | Board and senior management oversight of cyber risk | [              ] | Quarterly cyber risk item on the board agenda; minutes | [              ] | [        ] | [        ] |
| 1.3 | Appointment of a Chief Information Security Officer or equivalent | [              ] | Named accountable officer; job description | [              ] | [        ] | [        ] |
| 1.4 | Defined cybersecurity roles and responsibilities | [              ] | RACI matrix in the Information Security Policy | [              ] | [        ] | [        ] |
| 1.5 | Cybersecurity strategy aligned to a recognised framework | [              ] | Mapping to NIST CSF 2.0 and this framework | [              ] | [        ] | [        ] |
| 1.6 | Adequate budget and resourcing for cybersecurity | [              ] | Approved security budget line | [              ] | [        ] | [        ] |
| 1.7 | Independent assurance over the cybersecurity programme | [              ] | Internal audit or independent review | [              ] | [        ] | [        ] |

---

## 4. Part 2 — Cybersecurity Risk Management System

| # | Framework requirement | Rating | Evidence / basis | Remediation | Owner | Target |
|---|---|---|---|---|---|---|
| 2.1 | Documented cyber risk management methodology | [              ] | Risk methodology in the Information Security Policy | [              ] | [        ] | [        ] |
| 2.2 | Maintained risk register covering cyber and data protection risk | [              ] | Risk register, reviewed quarterly | [              ] | [        ] | [        ] |
| 2.3 | Asset inventory and information classification | [              ] | Four-tier classification and data inventory (PSL-EV-04 §4–5) | [              ] | [        ] | [        ] |
| 2.4 | Risk assessment before deploying new systems or services | [              ] | Change classification; impact assessment for high-risk processing | [              ] | [        ] | [        ] |
| 2.5 | Third-party and outsourcing risk management | [              ] | Sub-processor register and assessment cycle (PSL-EV-04 §10) | [              ] | [        ] | [        ] |
| 2.6 | Risk acceptance and exception process with defined authority | [              ] | Exception register with expiry dates and named approver | [              ] | [        ] | [        ] |
| 2.7 | Insurance or other risk transfer considered | [              ] | Cyber liability cover | [              ] | [        ] | [        ] |

---

## 5. Part 3 — Cyber Resilience Assessment

| # | Framework requirement | Rating | Evidence / basis | Remediation | Owner | Target |
|---|---|---|---|---|---|---|
| 3.1 | Periodic vulnerability assessment of internet-facing and connected systems | [              ] | Vulnerability Management Report (PSL-EV-05) | [              ] | [        ] | [        ] |
| 3.2 | Independent penetration testing by a qualified firm | [              ] | VAPT engagement record (PSL-EV-05 §5.4) | [              ] | [        ] | [        ] |
| 3.3 | Remediation of identified findings within defined service levels | [              ] | Remediation SLAs: Critical 72h, High 7d, Medium 30d | [              ] | [        ] | [        ] |
| 3.4 | Secure configuration baselines applied to systems | [              ] | Host hardening baseline and compliance scan | [              ] | [        ] | [        ] |
| 3.5 | Patch management with defined timelines | [              ] | Patch SLAs aligned to 3.3 | [              ] | [        ] | [        ] |
| 3.6 | Secure software development practices | [              ] | Pull-request-only merges; four-stage deploy gate; parameterised queries (PSL-EV-05 §6) | [              ] | [        ] | [        ] |
| 3.7 | Business continuity and disaster recovery testing | [              ] | BCP/DR testing schedule (PSL-EV-02 §17) | [              ] | [        ] | [        ] |

---

## 6. Part 4 — Cybersecurity Operational Resilience

| # | Framework requirement | Rating | Evidence / basis | Remediation | Owner | Target |
|---|---|---|---|---|---|---|
| 4.1 | Identity and access management with least privilege | [              ] | Five-role model with granular permissions, re-validated per request | [              ] | [        ] | [        ] |
| 4.2 | Multi-factor authentication for privileged and remote access | [              ] | Time-based one-time passwords; step-up re-authentication for secret access | [              ] | [        ] | [        ] |
| 4.3 | Privileged access management and monitoring | [              ] | Key-only host access; audit log with before/after state and source IP | [              ] | [        ] | [        ] |
| 4.4 | Joiners, movers and leavers process with defined revocation timeline | [              ] | 24-hour deprovisioning SLA; leaver checklist | [              ] | [        ] | [        ] |
| 4.5 | Periodic access recertification | [              ] | Quarterly recertification for Bank-connected systems | [              ] | [        ] | [        ] |
| 4.6 | Network segmentation and perimeter controls | [              ] | Two-tier topology; data stores bound to loopback (PSL-EV-01) | [              ] | [        ] | [        ] |
| 4.7 | Encryption of data at rest and in transit | [              ] | AES-256-GCM field encryption; TLS 1.2+; HSTS one year | [              ] | [        ] | [        ] |
| 4.8 | Cryptographic key management lifecycle | [              ] | Key inventory with owners and rotation schedule | [              ] | [        ] | [        ] |
| 4.9 | Endpoint protection and device management | [              ] | Device standard; full-disk encryption on production-access devices | [              ] | [        ] | [        ] |
| 4.10 | Secure email controls (anti-phishing, anti-malware, SPF/DKIM/DMARC) | [              ] | Mail gateway configuration; published mail authentication records | [              ] | [        ] | [        ] |
| 4.11 | Denial-of-service protection | [              ] | Edge DDoS absorption; three-tier application rate limiting | [              ] | [        ] | [        ] |
| 4.12 | Backup, with encryption, off-site storage and restore testing | [              ] | Backup standard (PSL-EV-02 §15) | [              ] | [        ] | [        ] |
| 4.13 | Incident response capability with defined playbooks | [              ] | Incident Response Policy with six playbooks (PSL-EV-02 Part A) | [              ] | [        ] | [        ] |
| 4.14 | Security awareness training for all personnel | [              ] | Annual mandatory training with pass criteria and completion record | [              ] | [        ] | [        ] |
| 4.15 | Personnel screening for sensitive roles | [              ] | Pre-employment screening standard | [              ] | [        ] | [        ] |

---

## 7. Part 5 — Cyber Threat Intelligence

| # | Framework requirement | Rating | Evidence / basis | Remediation | Owner | Target |
|---|---|---|---|---|---|---|
| 5.1 | Subscription to relevant threat intelligence sources | [              ] | CERT-NG advisories; NIBSS bulletins; CBN circulars; public advisory databases | [              ] | [        ] | [        ] |
| 5.2 | Participation in sector information-sharing arrangements | [              ] | Industry forum membership | [              ] | [        ] | [        ] |
| 5.3 | Threat intelligence integrated into detection and response | [              ] | Detection rules informed by intelligence | [              ] | [        ] | [        ] |
| 5.4 | Periodic threat landscape assessment reported to management | [              ] | Threat briefing in the board cyber item | [              ] | [        ] | [        ] |

---

## 8. Part 6 — Metrics, Monitoring and Reporting

| # | Framework requirement | Rating | Evidence / basis | Remediation | Owner | Target |
|---|---|---|---|---|---|---|
| 6.1 | Centralised logging of security-relevant events | [              ] | Structured application logging; audit log with full state capture; webhook delivery log | [              ] | [        ] | [        ] |
| 6.2 | Log retention meeting regulatory and contractual minimums | [              ] | 12-month minimum for application logs; 7 years for audit records | [              ] | [        ] | [        ] |
| 6.3 | Log integrity and tamper-evidence | [              ] | Write-once retention for shipped logs | [              ] | [        ] | [        ] |
| 6.4 | Continuous monitoring and alerting on security events | [              ] | Rail incident alerting; stuck-payment alerting; low-float alerting | [              ] | [        ] | [        ] |
| 6.5 | Defined and measured detection and response metrics | [              ] | MTTD/MTTR targets (PSL-EV-02 §8) — payment anomaly detection at 5 minutes is met today | [              ] | [        ] | [        ] |
| 6.6 | Regular cybersecurity reporting to the board | [              ] | Quarterly board report | [              ] | [        ] | [        ] |
| 6.7 | Ability to produce log extracts on regulatory or counterparty request | [              ] | 4-business-hour commitment; 1 hour during a live incident | [              ] | [        ] | [        ] |

---

## 9. Part 7 — Compliance with Statutory and Regulatory Requirements

| # | Framework requirement | Rating | Evidence / basis | Remediation | Owner | Target |
|---|---|---|---|---|---|---|
| 7.1 | Valid CBN licence maintained and conditions observed | [              ] | PSSP licence [                    ] | [              ] | [        ] | [        ] |
| 7.2 | Incident reporting to the CBN within prescribed timelines | [              ] | Notification matrix (PSL-EV-02 §6) | [              ] | [        ] | [        ] |
| 7.3 | AML/CFT programme and record-keeping | [              ] | Transaction surveillance rules; tiered KYC; 10-year retention | [              ] | [        ] | [        ] |
| 7.4 | NDPA 2023 compliance and NDPC registration | [              ] | Data Protection and NDPA Policy (PSL-EV-04) | [              ] | [        ] | [        ] |
| 7.5 | Annual Data Protection Compliance Audit filing | [              ] | DPCA filing reference | [              ] | [        ] | [        ] |
| 7.6 | PCI DSS compliance where card data is in scope | [              ] | Paylode stores no PAN, CVV or PIN; card processing is via licensed third parties. Correct instrument to be confirmed with a QSA. | [              ] | [        ] | [        ] |
| 7.7 | Compliance with CBN payment system data requirements | [              ] | Data residency position (PSL-EV-04 §9) | [              ] | [        ] | [        ] |
| 7.8 | Contractual security obligations flowed down to third parties | [              ] | Sub-processor flow-down clause | [              ] | [        ] | [        ] |

---

## 10. Prioritised remediation plan

Transcribe every item rated Partial, Planned or Not implemented, ordered by risk.

| Priority | Framework reference | Gap | Remediation action | Owner | Target date | Status |
|---|---|---|---|---|---|---|
| 1 | [              ] | [                              ] | [                              ] | [        ] | [        ] | [        ] |
| 2 | [              ] | [                              ] | [                              ] | [        ] | [        ] | [        ] |
| 3 | [              ] | [                              ] | [                              ] | [        ] | [        ] | [        ] |
| 4 | [              ] | [                              ] | [                              ] | [        ] | [        ] | [        ] |
| 5 | [              ] | [                              ] | [                              ] | [        ] | [        ] | [        ] |
| 6 | [              ] | [                              ] | [                              ] | [        ] | [        ] | [        ] |
| 7 | [              ] | [                              ] | [                              ] | [        ] | [        ] | [        ] |
| 8 | [              ] | [                              ] | [                              ] | [        ] | [        ] | [        ] |
| 9 | [              ] | [                              ] | [                              ] | [        ] | [        ] | [        ] |
| 10 | [              ] | [                              ] | [                              ] | [        ] | [        ] | [        ] |

---

## 11. Attestation

The assessment recorded above reflects Paylode Services Limited's cybersecurity
posture as at the assessment date, to the best of the assessor's knowledge. Items
rated Partial, Planned or Not implemented are carried into the remediation plan in
section 10 and are reported to the Board at each quarterly cycle until closed.

| Field | Value |
|---|---|
| Assessed by | [                                        ] |
| Title | [                                        ] |
| Signature | [                                        ] |
| Date | [                    ] |
| Reviewed by (Board) | [                                        ] |
| Date of board review | [                    ] |
| Next assessment due | [                    ] |
