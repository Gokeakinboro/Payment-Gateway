# Alpha Morgan Bank — Vendor Questionnaire AMB-ISO-VRQ-019
## Paylode Services Limited — Evidence Pack

**Bank reference:** AMB-ISO-VRQ-019
**Bank assessor:** Adeniran Oluwatobi, Alpha Morgan Bank — Information Security Division
**Vendor:** Paylode Services Limited (CBN-licensed PSSP)
**Scope of engagement:** (A) Virtual Account collection services; (B) Payout / disbursement channel
**Classification:** CONFIDENTIAL — Alpha Morgan Bank and Paylode Services Limited only

---

## ⚠️ Read this before sending anything to the Bank

This pack was assembled from the Paylode production codebase and deployment
documentation. It is split into three kinds of material, and **they must not be
treated the same way**:

| Marker | Meaning | Safe to send as-is? |
|---|---|---|
| **[VERIFIED]** | Stated behaviour is implemented in the production codebase and the file/line is cited. | Yes — but re-read it and confirm the production deployment matches the repo. |
| **[DRAFT POLICY]** | A policy document written for Paylode to review, amend, approve and sign. It is **not yet an approved policy** until a director signs it. | Only after internal approval and signature. |
| **[GAP]** | The control does not exist today, or cannot be evidenced. | Do **not** claim it. Answer "No" or "Partial" and attach the remediation plan. |

**Nothing in this pack fabricates a certificate, an audit report, a penetration
test, or a third-party attestation.** Where the questionnaire asks for one and
Paylode does not have it, that is recorded in `GAP-REGISTER.md` with a
remediation owner and target date instead. Filling a bank security questionnaire
with unsupported "Yes" answers is a contractual misrepresentation — the Bank's
own attestation clause (Section G) makes that explicit.

---

## Contents

### Response drafting
| File | Purpose |
|---|---|
| `RESPONSE-MATRIX.md` | Draft answer for **every** question in Sections A–G, with the evidence reference and an honest Yes / Partial / No / N-A recommendation. Start here. |
| `GAP-REGISTER.md` | Every control the Bank asks for that Paylode cannot evidence today, with severity, remediation action, owner and target date. This is the document that turns a weak response into a credible one. |

### Technical annexes — [VERIFIED] against the codebase
| File | Answers questionnaire items |
|---|---|
| `annex/ANNEX-A-architecture-and-data-flow.md` | Section B (architecture/data-flow diagram), 13.9 |
| `annex/ANNEX-B-network-architecture.md` | 3.1–3.9, 3.6 (fixed IP range for whitelisting), 12.3 |
| `annex/ANNEX-C-api-security-and-inventory.md` | 6.1–6.9 |
| `annex/ANNEX-D-data-classification-and-inventory.md` | 13.3, 13.4, 13.6, Section B data types |
| `annex/ANNEX-E-cryptography-and-key-management.md` | 9.1–9.8, 5.6, 5.7 |
| `annex/ANNEX-F-virtual-account-and-payout-controls.md` | 16.1–16.10 (the domain the Bank cares most about) |
| `annex/ANNEX-G-subprocessor-inventory.md` | 15.1–15.7, 13.10 |
| `annex/ANNEX-H-logging-monitoring-and-incident-response.md` | 10.1–10.7, 11.1–11.6 |
| `annex/ANNEX-I-business-continuity-and-dr.md` | 12.1–12.7 |
| `annex/ANNEX-J-secure-sdlc-and-change-management.md` | 5.1–5.8, 7.6 |

### Policy drafts — [DRAFT POLICY], require board/director approval before use
| File | Answers questionnaire items |
|---|---|
| `policy/POL-01-information-security-policy.md` | 1.1, 1.2, Section D |
| `policy/POL-02-access-control-and-jml.md` | 2.1–2.9, 14.4 |
| `policy/POL-03-data-protection-retention-and-disposal.md` | 13.1–13.10, Section F |
| `policy/POL-04-incident-response-plan.md` | 11.1–11.6 |
| `policy/POL-05-change-management.md` | 5.5, 5.8 |
| `policy/POL-06-third-party-risk-management.md` | 1.6, 15.1–15.7 |
| `policy/POL-07-key-management-policy.md` | 9.3–9.5, 6.4 |
| `policy/POL-08-business-continuity-and-disaster-recovery.md` | 12.1–12.7 |

---

## How to use this pack

1. **Read `GAP-REGISTER.md` first.** It tells you what you cannot claim. Decide,
   as a business, which gaps you will close before responding and which you will
   disclose with a remediation date. Banks routinely onboard vendors with open
   gaps and a credible plan; they do not forgive a discovered false attestation.
2. **Work through `RESPONSE-MATRIX.md`** and fill the corporate fields Paylode
   holds and this repository does not (CAC number, CBN licence number, employee
   count, named CISO, HQ address, insurance).
3. **Adopt the policy drafts.** Each has a signature block. A policy is only
   evidence once it is dated, versioned, approved and signed.
4. **Attach the annexes** as Annex A onward, matching the names the questionnaire
   uses ("Attached as Annex A").
5. **Re-verify against production.** The annexes describe the repository at the
   commit they were written from. Before submission, confirm the live hosts
   (176.57.188.45, 45.141.122.223) match — the repo is not automatically the
   production truth for backend code.

---

## Immediate security finding raised while preparing this pack

**Credentials are committed to this git repository.** `.claude/memory/project-paylode.md`
is tracked in git and contains a production server root SSH password, a live
YouVerify API key and a webhook signing secret. `.claude/memory/.gitignore`
excludes five `reference-*-creds.md` files but does not cover this one.

This directly contradicts questionnaire item **5.6** ("secrets stored only in an
approved secrets manager and never transmitted in plaintext or hardcoded in
source"). It must be remediated — rotate the exposed credentials, purge them from
git history, extend the ignore rules — **before** 5.6 is answered "Yes".
Tracked as **GAP-05** in `GAP-REGISTER.md`.
