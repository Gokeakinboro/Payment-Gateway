# Alpha Morgan Bank — Critical Document Pack

**Paylode Services Limited** · Assessment reference **AMB-ISO-VRQ-019**
Classification: **CONFIDENTIAL** — Alpha Morgan Bank and Paylode Services Limited only

---

## Contents

| # | Document | File | Questionnaire coverage |
|---|---|---|---|
| 1 | Network Architecture Diagram | `01-Network-Architecture-Diagram.docx` | Section B, 3.1–3.6, 6.2, 9.2, 12.3 |
| 2 | Incident Response and Business Continuity Policy | `02-Incident-Response-and-BCP-Policy.docx` | 11.1–11.6, 12.1–12.7, 10.5, 10.6 |
| 3 | Virtual Account and Payout Security Controls | `03-VA-and-Payout-Security-Controls.docx` | Domain 16 in full, 6.5, 13.9 |
| 4 | Data Protection and NDPA Policy | `04-Data-Protection-and-NDPA-Policy.docx` | 13.1–13.10, Section B, Section F |
| 5 | Vulnerability Management Report | `05-Vulnerability-Management-Report.docx` | 8.1–8.6, 5.4, 4.6 |
| 6 | CBN Risk-Based Cybersecurity Framework Gap Assessment | `06-CBN-CSF-Gap-Assessment.docx` | Section C, 1.1–1.7, 10.1–10.7 |

Each document is supplied as **Word (.docx)** for submission and as **Markdown
(.md)** as the editable source. Diagrams are in `figures/` as both PNG (embedded in
the Word files) and SVG (vector, for re-editing or high-resolution print).

---

## Figures

| File | Appears in | Shows |
|---|---|---|
| `fig1-network.png` | Document 1 | Production network topology, two-tier split, loopback-bound data stores, single Bank egress address |
| `fig2-boundaries.png` | Document 1 | The seven trust boundaries and the control applied at each |
| `fig3-payout.png` | Document 3 | Every gate a disbursement passes, including the ambiguous-response path |
| `fig4-va.png` | Document 3 | Virtual account provisioning and collection flow with signature and idempotency controls |
| `fig5-ir.png` | Document 2 | Incident severity bands, lifecycle and notification clocks |

---

## Fields to complete before submission

Every `[          ]` in the documents is a field for Paylode to fill. The
substantive ones:

| Document | Fields |
|---|---|
| All | Prepared by, reviewed by, approved by, dates, signature |
| 1 | None beyond document control — the technical content is complete |
| 2 | Incident contact card (§4.1); current attainment against recovery objectives (§13); exercise and restore-test dates; uptime SLA and service credits (§19) |
| 3 | Volume and value projections (§7); attach the Bank mandate evidencing fund segregation (§3.4) |
| 4 | NDPC registration and DPCA references (§2); processing locations and transfer mechanisms (§9); sub-processor locations and safeguards (§10) |
| 5 | Reporting period, remediation target dates, commit reference, VAPT engagement record |
| 6 | Every rating cell, the summary counts (§2), and the prioritised remediation plan (§10) |

---

## Two points worth noting

**Document 5 contains real scan results, not a template.** The seven findings were
produced by an actual software composition analysis of the committed backend
dependency lockfile: 0 critical, 3 high, 4 moderate across 327 dependencies. The
contextual risk assessment in §3 reflects how each vulnerable package is actually
reached in the deployed platform. Re-run the scan before submission so the figures
match the commit you are shipping, and update the scan date.

**Document 6 is a self-assessment.** It is structured to the framework's seven
parts and is honest about that status — an assessment carries more weight with a
bank once an independent assessor has validated it. The part numbering should be
confirmed against the current CBN circular before the document is relied upon
externally.
