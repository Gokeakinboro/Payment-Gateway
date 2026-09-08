# ANNEX G — Sub-processor and Supply Chain Inventory
### Paylode Services Limited · Alpha Morgan Bank AMB-ISO-VRQ-019 · CONFIDENTIAL

**Answers:** Domain 15 (15.1–15.7), items 13.10, 7.2, 7.3, 13.4
**Status:** [VERIFIED] from `backend/package.json`, `backend/src/config/serviceProviders.js`,
`backend/src/services/`, `docs/DEPLOYMENT.md`.

---

## G.1 Complete sub-processor inventory (15.1, 15.2)

| # | Sub-processor | Role | Bank data touched | Location | Certifications to verify |
|---|---|---|---|---|---|
| 1 | **Contabo GmbH** | VPS hosting — application host `176.57.188.45`, web host `45.141.122.223` | **All** transactional data at rest and in process | **[GAP] confirm region.** Contabo has no Nigerian region; the hosts are most likely in Germany or a US/Asian location. This must be established and disclosed — it is decisive for 7.2 and 13.4. | ISO 27001 (Contabo publishes certification for its data centres — obtain the certificate) |
| 2 | **Cloudflare, Inc.** | CDN, TLS termination at the edge, DDoS mitigation, DNS | Traffic in transit; **no payload at rest** | Global anycast | ISO 27001, SOC 2 Type II, PCI DSS Level 1 — all publicly available, download and attach |
| 3 | **PalmPay** | Payment rail — virtual accounts, collections, payouts | VA numbers, payer details, beneficiary details, amounts | Nigeria | CBN-licensed; request their ISO 27001 / PCI DSS status |
| 4 | **Parallex Bank** | Payment rail — VAs, payouts, card acquiring | Same as above | Nigeria | CBN-licensed deposit money bank; CBN cybersecurity framework compliance |
| 5 | **Interswitch** | Card switching | Card authorisation data (Paylode stores no PAN) | Nigeria | PCI DSS Level 1 — request the current AOC |
| 6 | **YouVerify** | KYC / identity verification — BVN, NIN, CAC, address | Merchant identity data (**not** Bank data) | Nigeria | NDPC-registered; request ISO 27001 status. *Being replaced on cost grounds — see G.3* |
| 7 | **Cloudinary** | KYC document image storage | Merchant KYC document images (**not** Bank data) | **Outside Nigeria** | ISO 27001, SOC 2 Type II — publicly available |
| 8 | **Sendchamp** | SMS / WhatsApp notification delivery | Recipient phone numbers, notification text | Nigeria | NDPC registration to confirm |
| 9 | **SMTP email provider** | Transactional email | Recipient email addresses, notification text | Confirm provider and region | Confirm |
| 10 | **Anthropic** | In-product support assistant (`@anthropic-ai/sdk`) | Support conversation text — **must not carry Bank data**; see G.4 | Outside Nigeria | SOC 2 Type II |
| 11 | **GitHub (Microsoft)** | Source control, CI/CD frontend deploy | Source code; **no** production Bank data | Outside Nigeria | ISO 27001, SOC 2 Type II |
| 12 | **Let's Encrypt (ISRG)** | TLS certificate issuance | None | Global | Public CA in all major root programmes |

**Fourth parties** to disclose at 13.10: each rail's own sponsor bank (PalmPay
operates via a sponsor bank), and NIBSS as the national switch for NIP transfers.
Paylode has no contractual relationship with NIBSS directly; the relationship runs
through the licensed rail.

---

## G.2 Sub-processors in scope for **Alpha Morgan Bank data** specifically

Narrow the disclosure to what actually matters, and say so:

| Sub-processor | Handles Bank data? |
|---|---|
| Contabo (hosting) | **Yes** — all of it |
| Cloudflare | **In transit only**, at the edge |
| Alpha Morgan Bank | The Bank itself, not a sub-processor |
| PalmPay / Parallex / Interswitch | **No** — these are *alternative* rails. Bank data from the Alpha Morgan VA and payout channels is not shared with a competing rail. |
| YouVerify / Cloudinary | **No** — merchant KYC only |
| Sendchamp / SMTP | **Only** where the merchant has configured a notification that includes a transaction reference and amount |
| Anthropic | **Should be: no** — see G.4 |

This is an important distinction and the Bank will appreciate it being drawn
explicitly: adding Alpha Morgan as a rail does not expose Bank data to Paylode's
other rails.

---

## G.3 Sub-processor governance (15.4, 15.5, 15.6)

**[DRAFT POLICY] — governed by `policy/POL-06-third-party-risk-management.md`,
which must be approved before these answers are given.** The commitments to make
to the Bank:

| Question | Commitment |
|---|---|
| 15.4 — Flow-down of the Bank's security and confidentiality obligations | Paylode will include the flow-down clause drafted in POL-06 Appendix B in every sub-processor agreement covering Bank data. Attach that clause as the sample the question requests. |
| 15.5 — Evaluation and monitoring cadence | Annual re-assessment for every sub-processor handling Bank data (certificate currency, breach disclosure, incident history, financial stability); quarterly for any rated *high inherent risk*. Evidence collected: current ISO 27001 / SOC 2 report, DPA, breach history attestation. |
| 15.6 — Notification before adding or changing a sub-processor | **30 days' written notice** to Alpha Morgan Bank before any new sub-processor gains access to Bank data, with a right to object. This belongs in the DPA and Paylode should offer it unprompted. |
| 15.7 — Independent verification of cloud provider certifications | Certificates and audit reports are obtained **from the provider's trust portal or auditor**, never accepted as a vendor assertion, and recorded with issue and expiry dates in the POL-06 register. |

**[GAP]** No sub-processor risk assessment has been performed to date and no DPAs
are on file with the sub-processors above. Tracked as GAP-21. The register in
POL-06 Appendix A is pre-populated with the twelve entries in G.1 so the first
assessment cycle can begin immediately.

---

## G.4 Two disclosures that must be made honestly

**1. Data localisation (7.2, 13.4) — the most likely question to derail this
assessment.**

The Bank asks whether all Bank customer data is hosted **within Nigeria**. The
honest position:

- The application and PostgreSQL database run on **Contabo VPS infrastructure,
  which has no Nigerian region**. Unless the hosts are confirmed to sit in a
  Nigerian facility — they almost certainly do not — **Bank data is processed and
  stored outside Nigeria**, and 7.2 must be answered **"No"**.
- The NDPA 2023 permits cross-border transfer where an adequate legal basis exists
  (adequacy, standard contractual clauses, or another lawful mechanism), so this is
  not automatically fatal. But CBN guidance on payment-system data localisation is
  stricter than the NDPA, and Alpha Morgan Bank will apply the CBN lens.
- **Recommended remediation before or shortly after onboarding: migrate the
  production database and application to a Nigerian-resident host** (Layer3 Cloud,
  Galaxy Backbone, MainOne/Equinix Lagos, or a Nigerian region of a major
  provider). Tracked as **GAP-08**, and it should carry a firm date.
- Interim mitigation to offer: execute SCCs with Contabo, encrypt sensitive fields
  at the application layer (already done for settlement accounts), and commit to
  the migration in the contract.

Do not answer 7.2 "Yes" on the basis that Cloudflare terminates in Lagos. It does
not change where the database sits, and the assessor will check.

**2. The support assistant and Bank data.**

`@anthropic-ai/sdk` powers the in-product assistant. Before submission, confirm
and then state in writing that the assistant is **scoped to product help and does
not receive transaction records, customer PII or Bank data** in its prompts. If it
currently can, restrict it. An LLM sub-processor receiving payment data is a
finding the Bank will raise, and it is easy to close by scoping the context.

---

## G.5 Software supply chain (5.4)

- Runtime: **Node.js 18+**, Express 4, Prisma 5, PostgreSQL, Redis/BullMQ.
- Dependencies are pinned in `backend/package-lock.json` and installed from the
  npm public registry.
- **[GAP]** No Software Composition Analysis tool is running. Remediation is
  free and immediate: enable **GitHub Dependabot alerts and security updates** on
  the repository, and add `npm audit --production` to the pre-deploy gate.
  Tracked as GAP-22. This converts 5.4 from "No" to "Yes" in an afternoon and is
  the best effort-to-credit ratio in the entire questionnaire.
