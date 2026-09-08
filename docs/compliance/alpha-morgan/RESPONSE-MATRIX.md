# RESPONSE MATRIX — Draft answers, Sections A to G
### Paylode Services Limited · Alpha Morgan Bank AMB-ISO-VRQ-019 · CONFIDENTIAL

Recommended answer for every question, the evidence to attach, and — where the
honest answer is not "Yes" — the gap reference.

**Legend:** ✅ Yes · 🟡 Partial · ❌ No · ⬜ Paylode to complete (corporate
information this repository does not hold)

---

## Section A — Vendor and corporate profile ⬜

All fields are corporate records. Complete from Paylode's company file.

| Field | Value |
|---|---|
| Legal name | Paylode Services Limited *(pre-filled by the Bank)* |
| CAC registration number | ⬜ |
| Year founded | ⬜ |
| Headquarters address | ⬜ |
| Primary operating address | ⬜ |
| Ultimate parent company | ⬜ (state "None" if independent) |
| Website | `https://paylodeservices.com` (also `https://billspay.net` — the closed-loop member wallet product) |
| Number of employees | ⬜ |
| IT / Cybersecurity contact | ⬜ — see `ANNEX-H` §H.5 |
| Technical integration contact | ⬜ |
| Nature of business | CBN-licensed Payment Solution Service Provider: payment gateway and hosted checkout, virtual-account collections, invoicing, payouts/disbursements, and a closed-loop member wallet |
| Proposed service to the Bank | Consumption of the Bank's virtual-account issuance and payout rail — see `ANNEX-A` §A.1 |
| **Integration type** | **☑ API** (only). Not Direct DB, not File Transfer, not SDK/Widget — `ANNEX-A` §A.1 |
| CBN licence type and number | ⬜ PSSP — number and dates from the licence |
| NIBSS membership | ⬜ Yes / No / Pending |

---

## Section B — Service and data overview

| Question | Answer | Evidence |
|---|---|---|
| Describe the service and expected transaction flows | Provided | **`ANNEX-A`** §A.1, A.3, A.4 |
| List each Bank data type handled | Provided | **`ANNEX-D`** §D.2 |
| Describe all processing operations | Storage, matching, enrichment, aggregation, transmission, surveillance, reconciliation, deletion. **No profiling, resale, secondary analytics or model training.** | `ANNEX-D` §D.2 |
| Architecture / Data Flow Diagram | **☑ Attached as Annex A** | **`ANNEX-A`** |
| Bank data in non-production? | **☐ No** | `ANNEX-D` §D.5 — separated by credential (`sk_test_`/`sk_live_`), by `is_sandbox` on every row, and by the `merchant.liveEnabled` gate |
| De-identification method | N/A — Bank data is not used in lower environments | `ANNEX-D` §D.5 |

---

## Section C — Regulatory compliance and certifications

| Framework | Answer | Note |
|---|---|---|
| CBN PSSP Licence | ✅ | Attach the licence |
| ISO/IEC 27001:2022 | ❌ | Targeted — GAP-34 |
| PCI DSS v4.0 | ⬜ | Establish the correct SAQ with a QSA; Paylode stores no PAN/CVV/PIN — GAP-34 |
| SOC 2 Type II | ❌ N/A | ISO 27001 pursued as the primary framework |
| SOC 1 Type II | ❌ N/A | |
| NDPC registration | ⬜ | **Register immediately if not held** — GAP-34 |
| DPCA report | ⬜ | Engage a licensed DPCO if not filed |
| CBN Risk-Based Cybersecurity Framework | 🟡 | Complete the self-assessment and attach it |
| NIST CSF 2.0 or equivalent | 🟡 | `policy/POL-01` maps controls to CSF 2.0 |
| ISO 22301 | ❌ | `policy/POL-08` is the documented BCM capability |
| VAPT (CREST, within 6 months) | ❌ | **GAP-12 — the highest-value item to procure** |
| SWIFT CSP | ❌ **N/A** | Paylode does not connect to SWIFT |

### Sanctions and breach disclosure (1–4) ⬜

Answer from corporate records — see `ANNEX-H` §H.6. The Bank verifies these
independently with the CBN and NDPC.

---

## Section D — Governance, policy and training

| Question | Answer | Evidence |
|---|---|---|
| Primary Information Security Policy (name/ID, owner, review date) | 🟡 | `policy/POL-01` — **draft, requires director approval** (GAP-30) |
| Approved by senior management, reviewed annually | 🟡 | Confirm once signed |
| Documented Privacy Policy | ✅ | Published at `privacy.html`; `policy/POL-03` is the internal instrument |
| Security and privacy training | ❌ | GAP-33 — no formal programme today |
| Individual accountable for information and cyber security | ⬜ | Name the CTO or equivalent. `ANNEX-H` §H.5 |
| Written cybersecurity programme led by a qualified CISO | 🟡 | The eight policies plus `GAP-REGISTER.md` are the programme; the accountable individual must be named |
| Acknowledge the Bank's right to review and assess | **☑ Acknowledged** | Accept without qualification — this costs nothing and refusing it reads badly |

---

## Section E — Cybersecurity assessment

### Domain 1 — Governance
| # | A | Evidence / note |
|---|---|---|
| 1.1 | 🟡 | POL-01, pending approval — GAP-30 |
| 1.2 | 🟡 | POL-01 §2 maps to NIST CSF 2.0 and the CBN framework |
| 1.3 | ⬜ | Name the accountable individual |
| 1.4 | 🟡 | Establish a quarterly security item on the board agenda; minute it |
| 1.5 | 🟡 | `GAP-REGISTER.md` **is** a live cyber risk register — cite it |
| 1.6 | 🟡 | POL-06, pending approval |
| 1.7 | 🟡 | POL-01 Appendix A carries the RACI |

### Domain 2 — Identity and access
| # | A | Evidence / note |
|---|---|---|
| 2.1 | 🟡→✅ | TOTP implemented (`ANNEX-C` §C.3); **enforce it for privileged roles — GAP-09 — then answer ✅** |
| 2.2 | ❌ | No PAM. Compensating: key-only SSH, named administrators, `audit_logs` on every privileged application action — GAP-31 |
| 2.3 | ✅ | RBAC with five roles **plus** granular permissions, enforced server-side and re-read from the database on every request — `ANNEX-C` §C.1, `config/permissions.js` |
| 2.4 | 🟡 | POL-02 §4 sets a **24-hour** deprovisioning SLA; revocation is immediate in-platform (`isActive=false`) |
| 2.5 | ❌ | No IdP/SSO — GAP-31; compensating controls in the same row |
| 2.6 | 🟡 | POL-02 §5 sets a quarterly recertification cadence; first cycle to be run |
| 2.7 | 🟡 | Login rate limit: **10 attempts / 15 minutes** (`ANNEX-B` §B.5). Add an account-level lockout per POL-02 §3 |
| 2.8 | ✅ | Every account is an individual named user; API keys are per-merchant and attributable |
| 2.9 | 🟡 | POL-02 §6 defines break-glass; `audit_logs` provide the trail |

### Domain 3 — Network and infrastructure — **`ANNEX-B`**
| # | A | # | A |
|---|---|---|---|
| 3.1 | 🟡 GAP-01 | 3.6 | ✅ `176.57.188.45/32` — §B.2 |
| 3.2 | 🟡 GAP-03 | 3.7 | 🟡 enable DNSSEC → ✅ |
| 3.3 | ❌ GAP-04 | 3.8 | 🟡 |
| 3.4 | 🟡 Cloudflare | 3.9 | 🟡 POL-01 §7 |
| 3.5 | 🟡 **offer the VPN/tunnel** | | |

### Domain 4 — Endpoint — `GAP-REGISTER` "endpoint reality check"
| # | A | # | A |
|---|---|---|---|
| 4.1 | ❌ GAP-31 | 4.4 | ❌ GAP-31 |
| 4.2 | 🟡 **verify and record full-disk encryption on every device — free** | 4.5 | ❌ GAP-29 |
| 4.3 | ⬜ answer truthfully | 4.6 | 🟡 POL-05 §6: Critical 72h · High 7d · Medium 30d |

### Domain 5 — Secure SDLC — **`ANNEX-J`**
| # | A | # | A |
|---|---|---|---|
| 5.1 | 🟡 POL-05 | 5.5 | ✅ **PR review enforced** — verify the GitHub branch-protection rule first (§J.1) |
| 5.2 | ❌→✅ CodeQL, GAP-28 | 5.6 | ❌ **GAP-05 — rotate and purge first** |
| 5.3 | ❌ GAP-28 | 5.7 | 🟡 `ANNEX-E` §E.2 |
| 5.4 | ❌→✅ Dependabot, GAP-22 | 5.8 | 🟡 §J.2 — do not overclaim segregation |

### Domain 6 — API security — **`ANNEX-C`**
| # | A | # | A |
|---|---|---|---|
| 6.1 | ❌ — API keys + JWT, not OAuth; strong compensating controls; **will adopt the Bank's scheme** | 6.6 | 🟡 confirm the JWT expiry value |
| 6.2 | ✅ three-tier rate limiting — §B.5 | 6.7 | 🟡 §C.6; publish OpenAPI — GAP-10 |
| 6.3 | 🟡 **offer mTLS on the Bank integration** | 6.8 | 🟡 GAP-11 |
| 6.4 | 🟡 GAP-17 | 6.9 | ❌ GAP-12 |
| 6.5 | ✅ §C.5 — rail health, failover, TPS caps, bounded re-query, idempotent references | | |

### Domain 7 — Cloud
| # | A | Note |
|---|---|---|
| 7.1 | ❌ **N/A with explanation** — VPS, not a hyperscale tenancy; host hardening is the equivalent control |
| 7.2 | ❌ | **GAP-08 — data localisation. The most likely blocker; address it head-on** |
| 7.3 | 🟡 | Cloudflare ISO 27001 + SOC 2 attachable; obtain Contabo's ISO 27001 |
| 7.4 | 🟡 | Small named administrator set; no standing cloud IAM surface |
| 7.5 | 🟡 | `audit_logs` capture before/after state; not WORM — GAP-11 |
| 7.6 | 🟡 | Application topology is IaC and peer-reviewed; host build is manual — GAP-29 |
| 7.7 | 🟡 | POL-06 §3 |
| 7.8 | 🟡 | POL-01 §7 sets an annual review |
| 7.9 | ✅ | **Multi-tenancy isolation:** every query is scoped by `merchant_id`; API keys resolve to exactly one merchant; roles and permissions are re-validated server-side per request; aggregator scoping is explicit. `ANNEX-C` §C.1 |

### Domain 8 — Vulnerability management
| # | A | Note |
|---|---|---|
| 8.1 | ❌ | No monthly scanning — GAP-12/GAP-28 |
| 8.2 | 🟡 | POL-05 §6 sets Critical ≤72h · High ≤7d · Medium ≤30d; Node dependencies are lock-pinned |
| 8.3 | ❌ | **GAP-12** |
| 8.4 | ❌ | No findings to remediate because no test has been run — say exactly that |
| 8.5 | 🟡 | POL-01 §9 defines risk acceptance |
| 8.6 | ❌ | GAP-04 |

### Domain 9 — Cryptography — **`ANNEX-E`**
| # | A | # | A |
|---|---|---|---|
| 9.1 | 🟡 AES-256-GCM at the field layer; confirm disk encryption — GAP-14 | 9.5 | 🟡 POL-07 |
| 9.2 | ✅ TLS 1.2 min / 1.3 preferred, HSTS 1 year | 9.6 | ✅ **no PAN/CVV/PIN stored** |
| 9.3 | ❌ no HSM/FIPS KMS — GAP-16, **do not overclaim** | 9.7 | 🟡 HMAC-SHA512 + md5 deploy verification; no host FIM |
| 9.4 | ✅ Paylode owns its keys; the Bank owns Bank-issued credentials | 9.8 | 🟡 Certbot auto-renewal; no inventory — GAP-18 |

### Domain 10 — Security operations — **`ANNEX-H`**
| # | A | # | A |
|---|---|---|---|
| 10.1 | ❌ GAP-23 | 10.5 | 🟡 **5-minute payment-anomaly detection is real and met** |
| 10.2 | ❌ GAP-11 | 10.6 | ✅ **4 business hours committed; 1 hour during an incident** |
| 10.3 | 🟡 GAP-11 | 10.7 | 🟡 §H.1 |
| 10.4 | ❌ GAP-23 | | |

### Domain 11 — Incident response — **`ANNEX-H`**
| # | A | # | A |
|---|---|---|---|
| 11.1 | 🟡 POL-04 pending approval | 11.4 | ❌→✅ **run the tabletop — GAP-24** |
| 11.2 | ✅ once §H.5 is populated | 11.5 | ❌ commit to annual — GAP-12 |
| 11.3 | ✅ **24 hours** — §H.4 | 11.6 | 🟡 template in POL-04 Appendix C |

### Domain 12 — BCP/DR — **`ANNEX-I`**
| # | A | # | A |
|---|---|---|---|
| 12.1 | 🟡 POL-08 | 12.5 | ⬜ **99.5% recommended — not 99.9%**, §I.5 |
| 12.2 | 🟡 §I.4 — state current vs target | 12.6 | 🟡 rail pre-funding forecast is real; load testing is not — GAP-27 |
| 12.3 | 🟡 no DR site — GAP-06 | 12.7 | ❌ **GAP-25 — close this before submitting** |
| 12.4 | ❌ GAP-26 | | |

### Domain 13 — Data protection — **`ANNEX-D`**
| # | A | # | A |
|---|---|---|---|
| 13.1 | ⬜ register if not held | 13.6 | ✅ §D.4 — statutory floors stated |
| 13.2 | ⬜ | 13.7 | 🟡 POL-03 §7 — NIST SP 800-88 |
| 13.3 | ✅ §D.1, D.6 — tiered KYC, no card data | 13.8 | 🟡 POL-03 §6 — 30-day NDPA window |
| 13.4 | ❌ **GAP-08** | 13.9 | ✅ **`ANNEX-A`** |
| 13.5 | ✅ Paylode will execute the Bank's DPA | 13.10 | 🟡 **`ANNEX-G`** §G.1 — twelve sub-processors disclosed |

### Domain 14 — Personnel and physical
| # | A | # | A |
|---|---|---|---|
| 14.1 | ❌ GAP-32 | 14.5 | ⬜ answer truthfully; POL-02 §7 |
| 14.2 | ❌ GAP-33 | 14.6 | 🟡 **N/A in part** — no owned data centre; obtain Contabo's physical security attestation |
| 14.3 | 🟡 `audit_logs` with before/after state and IP are a genuine insider-threat control | 14.7 | 🟡 POL-01 §10 |
| 14.4 | 🟡 POL-02 §9 — role separation exists in the platform; headcount limits it operationally | | |

### Domain 15 — Supply chain — **`ANNEX-G`**
| # | A | # | A |
|---|---|---|---|
| 15.1 | ✅ §G.1 — twelve entries | 15.5 | 🟡 POL-06 §5 — annual, quarterly for high risk |
| 15.2 | ✅ §G.1 | 15.6 | ✅ **commit to 30 days' notice** |
| 15.3 | 🟡 GAP-21 | 15.7 | 🟡 §G.3 — obtained from trust portals, never vendor assertion |
| 15.4 | 🟡 POL-06 Appendix B carries the sample flow-down clause | | |

### Domain 16 — VA and payout controls — **`ANNEX-F`** *(Paylode's strongest domain)*
| # | A | # | A |
|---|---|---|---|
| 16.1 | ✅ unique VA per customer, no reuse | 16.6 | 🟡 **GAP-20 — sanctions/PEP screening; close before go-live** |
| 16.2 | ✅ segregated — attach the Bank mandate | 16.7 | ✅ four reconciliation layers; 1-day raise, 3-day resolution SLA |
| 16.3 | ✅ **T+1 default**, T+0 available | 16.8 | ✅ auto-refund on failure; **never re-sends on an ambiguous response** |
| 16.4 | 🟡 **GAP-19 — maker-checker**; prepaid model + recall window + full audit compensate | 16.9 | ✅ signed webhooks both directions |
| 16.5 | ✅ rail daily caps, TPS limits, prepaid ceiling, tiered limits | 16.10 | ⬜ commercial projections |

---

## Section F — Termination and data disposal

| Question | Answer |
|---|---|
| Return or deletion of Bank data at contract end | `policy/POL-03` §7. Bank data exported in an agreed machine-readable format, then deleted from primary systems, backups purged on the next rolling cycle, and a **certificate of destruction** issued to the Bank. |
| Secure-erase method and certification standard | **NIST SP 800-88 Rev. 1** — cryptographic erase for encrypted volumes, `Clear`/`Purge` as applicable. Written confirmation to the Bank. POL-03 §7. |
| Protection on insolvency | Bank data is held as a bailee, is not a Paylode asset, and is not available to creditors. Contractual provisions: an escrow or step-in right, a standing instruction for return or destruction, and immediate notification of any insolvency event. **Legal counsel should draft this clause.** |
| Deletion from backups and sub-processors on termination or DSAR | **Yes.** Primary systems within **30 days**; backups within **90 days** as the rolling cycle overwrites; sub-processors instructed within 5 business days and confirmation collected. Proof: certificate of destruction plus the sub-processor confirmations. **Subject to the CBN 10-year AML retention floor in `ANNEX-D` §D.4** — state that carve-out explicitly. |
| Contractual timeframe for deletion/return after termination notice | **30 days** for return or deletion from primary systems; **90 days** for full backup expiry. |

---

## Section G — Attestation ⬜

Sign only after the response is true. The signatory personally attests that
everything is "accurate, complete, and not misleading" — which is precisely why
`GAP-REGISTER.md` exists and why the ❌ and 🟡 answers above should stay as they
are unless the underlying control is actually built.

| Full name | Title | Date | Signature |
|---|---|---|---|
| ⬜ | ⬜ | ⬜ | ⬜ |

---

## Scorecard

| Band | Approximate count |
|---|---|
| ✅ defensible today | ~25 |
| 🟡 partial — real controls, documented gaps | ~45 |
| ❌ honest no, with a remediation plan | ~25 |
| ⬜ Paylode to complete | ~20 |

**After the eight Priority-1 gaps are closed, roughly ten answers move from ❌ or
🟡 to ✅ — including four HIGH-priority items.** That is the highest-return work
available before this questionnaire is returned.
