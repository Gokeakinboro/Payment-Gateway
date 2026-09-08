# GAP REGISTER
### Paylode Services Limited · Alpha Morgan Bank AMB-ISO-VRQ-019 · CONFIDENTIAL

Every control Alpha Morgan Bank asks for that Paylode **cannot evidence today**,
with a remediation action, an owner and a target date.

**Why this document exists.** Banks onboard vendors with open gaps every week.
They do not forgive a false attestation — and Section G of the questionnaire makes
each signatory personally attest that the responses are "accurate, complete, and
not misleading". A disclosed gap with a funded plan is a negotiating position; a
discovered overclaim is the end of the relationship and, for a CBN-licensed PSSP,
a regulatory problem as well.

**Owners and dates below are placeholders.** Paylode must set real ones before
this pack is sent.

---

## Priority 1 — close **before** returning the questionnaire

| ID | Gap | Item | Action | Effort | Owner | Target |
|---|---|---|---|---|---|---|
| **GAP-05** | Live credentials committed to git: `.claude/memory/project-paylode.md` (tracked) contains a production root SSH password, a live YouVerify API key and a webhook signing secret | 5.6 | 1. Rotate all three. 2. Disable password SSH; keys only. 3. Purge from git history (`git filter-repo`). 4. Extend `.claude/memory/.gitignore`. 5. Add `gitleaks` pre-commit + GitHub push protection. 6. Attach the clean scan as evidence. | 1 day | CTO | **Immediate** |
| **GAP-25** | No automated, encrypted, off-site, restore-tested database backup | 12.7 | Nightly `pg_dump`, encrypted (age or GPG), shipped off-site, 90-day rolling retention. **Perform and document one full restore test.** | 1 day | CTO | **Immediate** |
| **GAP-09** | 2FA is implemented but not enforced for privileged accounts | 2.1 | Require TOTP enrolment for every `SUPER_ADMIN`, `ADMIN` and `COMPLIANCE_OFFICER`; block access until enrolled | 1 day | CTO | Before submission |
| **GAP-22** | No Software Composition Analysis | 5.4 | Enable GitHub Dependabot alerts + security updates; add `npm audit --production` to the deploy gate | 1 hour | CTO | Before submission |
| **GAP-28** | No SAST or DAST | 5.2, 5.3 | Enable GitHub CodeQL; add `semgrep --config=p/owasp-top-ten` as a PR check; schedule an OWASP ZAP baseline scan | 4 hours | CTO | Before submission |
| **GAP-24** | No IR tabletop exercise in the last 12 months | 11.4 | Run a half-day tabletop against the POL-04 credential-exposure playbook (GAP-05 makes it a live scenario); write the after-action report | 0.5 day | CTO | Before submission |
| **GAP-03** | Cloudflare WAF status unverified | 3.2 | Confirm the plan tier and that the managed ruleset is in **Block**, not Log, mode; screenshot as evidence | 1 hour | CTO | Before submission |
| **GAP-30** | Policies drafted but not approved or signed | 1.1, 1.2, Section D, 11.1, 12.1 | Review, amend, date, version and have a director sign the eight drafts in `policy/` | 2 days | Directors | Before submission |

Every Priority 1 item is either free or under two days of work, and each one
converts a HIGH-priority questionnaire answer. Clearing this block before
submission is the difference between a response that reads as a functioning
security programme and one that reads as a wish list.

---

## Priority 2 — disclose with a firm date; needed for go-live

| ID | Gap | Item | Action | Effort | Owner | Target |
|---|---|---|---|---|---|---|
| **GAP-12** | No independent VAPT by a CREST-certified or CBN-recognised firm | 8.3, 8.4, 6.9, 11.5 | Commission a full-scope VAPT (external infrastructure + web application + **API**). Remediate Critical/High findings, attach the report and the remediation evidence. | 3–4 weeks | CTO | Highest-value external spend in this pack — four HIGH items depend on it |
| **GAP-20** | No live sanctions/PEP screening in the payout path; the provider entry is a placeholder | 16.6 | Integrate a licensed screening provider (Dojah, Youverify, or a dedicated AML vendor) into beneficiary validation before dispatch | 2 weeks | CTO + Compliance | Before go-live |
| **GAP-19** | No two-person maker-checker on merchant-initiated payouts | 16.4 | Per-merchant value threshold above which a batch requires approval by a second user holding an approver role, recorded in `audit_logs` | 1 week | CTO | Before go-live |
| **GAP-08** | Data localisation — hosting is on Contabo, which has no Nigerian region | 7.2, 13.4 | Confirm the current host region. Plan and execute migration of the application and PostgreSQL to Nigerian-resident infrastructure. Interim: SCCs with Contabo plus the existing application-layer field encryption. | 4–8 weeks | CTO | **The most likely single blocker to onboarding — address it head-on** |
| **GAP-06** | No DR site, no PostgreSQL replication | 12.2, 12.3, 12.4 | Standby host in a second region; streaming replication over an encrypted tunnel; documented failover runbook; tested failover | 2 weeks | CTO | Before go-live |
| **GAP-11** | No SIEM; log retention and immutability not guaranteed | 6.8, 10.2, 10.3 | Ship `pino` and PostgreSQL audit output to a SIEM (Wazuh self-hosted, or Better Stack/Grafana Loki) with ≥12-month WORM retention and alert rules | 1–2 weeks | CTO | Before go-live |
| **GAP-13** | TOTP secrets and KYC verification payloads stored unencrypted | 9.1, 13.3 | Apply the existing AES-256-GCM helper to `users.totp_secret` and the `kyc_submissions` `*_data` columns | 3 days | CTO | Before go-live |
| **GAP-21** | No sub-processor risk assessments and no DPAs on file | 15.3, 15.4, 15.5 | Work the pre-populated register in POL-06 Appendix A: collect certificates, execute DPAs with the flow-down clause | 2 weeks | Compliance | Before go-live |

---

## Priority 3 — roadmap; disclose with an honest "No" and a plan

| ID | Gap | Item | Action | Target |
|---|---|---|---|---|
| **GAP-01** | Production and sandbox share one host and one database (logical separation only) | 3.1 | Separate staging host and database | Q+1 |
| **GAP-02** | Traffic between hosts 45 and 176 crosses the provider network unencrypted | 3.5 | WireGuard tunnel or provider private networking between the hosts | Q+1 |
| **GAP-04** | No IDS/IPS, no file integrity monitoring, no DNS filtering | 3.3, 3.7, 9.7 | Deploy Wazuh or CrowdSec on both hosts (agent covers IDS + FIM) | Q+1 |
| **GAP-07** | No mTLS on the merchant API | 6.3 | Offer mTLS on the Bank integration if the Bank issues certificates; assess for merchants | On Bank request |
| **GAP-10** | No published OpenAPI specification | 6.7 | Generate and publish OpenAPI 3.1 for all `/api/v1` routes | Q+1 |
| **GAP-14** | Full-disk / volume encryption on the VPS hosts unconfirmed | 9.1 | Verify; enable on rebuild or as part of the GAP-08 migration | With GAP-08 |
| **GAP-15** | No rotation schedule for `ENCRYPTION_KEY` and `JWT_SECRET` | 9.5, 5.7 | Annual rotation with a key-version column to support re-encryption | Q+1 |
| **GAP-16** | No HSM or FIPS-validated KMS; keys held as environment configuration | 9.3 | Migrate secrets to a managed store with envelope encryption and audited access | Q+2 |
| **GAP-17** | No maximum age enforced on merchant API keys | 6.4 | Add an expiry field, warning notices and forced rotation at 90 days | Q+1 |
| **GAP-18** | No certificate inventory or independent expiry alerting | 9.8 | Inventory in POL-07 Appendix A; external expiry monitoring alerting at 21 days | Q+1 |
| **GAP-23** | No SOC and no threat intelligence subscriptions | 10.1, 10.4 | Evaluate a managed SOC once the SIEM exists; subscribe to CERT-NG, NIBSS and CBN advisories in the interim | Q+2 |
| **GAP-26** | No BCP/DR test | 12.4 | Documented failover test after GAP-06 lands | With GAP-06 |
| **GAP-27** | No documented capacity planning or load testing | 12.6 | Load-test the payout and collection paths; document headroom and scaling triggers | Q+1 |
| **GAP-29** | No CIS baseline; host provisioning is manual, not IaC | 4.5, 7.6 | Ansible playbook for host build and hardening; evidence with a Lynis or CIS-CAT scan | Q+2 |
| **GAP-31** | No EDR, no MDM, no PAM, no CSPM | 4.1, 4.2, 2.2, 7.1 | See "endpoint reality check" below | Q+2 |
| **GAP-32** | No documented background screening of personnel | 14.1 | Pre-employment screening for anyone with production access; POL-02 §8 | Q+1 |
| **GAP-33** | No formal security awareness training programme | 14.2, Section D | Annual mandatory training with a pass threshold and a completion record | Q+1 |
| **GAP-34** | Certifications not held: ISO 27001, PCI DSS, SOC 2, NIST CSF documentation, ISO 22301 | Section C | See below |

---

## The endpoint and enterprise-tooling reality check (GAP-31)

Domain 4 (EDR, MDM, BYOD, removable media, CIS baselines), 2.2 (PAM with session
recording) and 7.1 (CSPM) assume an enterprise IT estate: managed laptops, an
identity provider, a cloud tenancy with a posture-management tool. Paylode is a
small engineering organisation running two VPS hosts.

**The correct approach is not to claim these controls, and not to leave them
blank.** For each, state what Paylode actually does and what compensates:

| Bank expectation | Paylode's honest position |
|---|---|
| EDR on all endpoints (4.1) | No commercial EDR. Achievable now: enable the built-in endpoint protection on all staff devices, and deploy Wazuh agents to both servers (GAP-04) for server-side detection. |
| MDM with full-disk encryption (4.2) | No MDM. **Enable and verify full-disk encryption (FileVault/BitLocker) on every device with production access, and record it** — that is the substance of the control and it costs nothing. |
| BYOD (4.3) | Answer truthfully. If staff use personal devices for production access, say so and describe the controls; POL-02 §7 sets the standard. |
| Removable media / DLP (4.4) | No DLP. Compensating: production access is via SSH key to two hosts; there is no bulk export path outside the application's own audited report endpoints. |
| PAM with session recording (2.2) | No PAM product. Compensating: key-only SSH to a small, named set of administrators; `audit_logs` capture every privileged **application** action with actor, before/after state and IP — which is the layer where the money actually moves. |
| CSPM (7.1) | **N/A with an explanation** — Paylode does not run on a hyperscale cloud tenancy, so there is no cloud posture surface for a CSPM to assess. Host hardening (GAP-29) is the equivalent control. |
| SSO with an IdP (2.5) | No IdP. Compensating: single application, centralised RBAC with granular permissions, database-side role re-validation on every request, and TOTP available (enforced once GAP-09 lands). |

An assessor reading that table sees an organisation that understands its own risk
profile. An assessor reading nine ticked boxes from a two-server shop sees an
organisation that ticked boxes.

---

## Certifications (GAP-34) — Section C

| Framework | Status | Position to take |
|---|---|---|
| **CBN PSSP Licence** | **Held** | Attach the licence. Enter the number and dates in Section A and C. |
| **NDPC registration (NDPA 2023)** | Confirm | Mandatory for a Nigerian data controller of this kind. If not registered, register **now** — it is inexpensive, fast, and the Bank treats its absence as disqualifying. |
| **DPCA (Data Protection Compliance Audit)** | Confirm | Required annually for controllers of major importance. Engage a licensed DPCO if not filed. |
| **ISO/IEC 27001:2022** | Not held | Answer "No — in scope, targeted". The eight approved policies plus the gap remediation in this register constitute the foundation of an ISMS; a realistic path is a gap assessment now and certification in 9–12 months. |
| **PCI DSS v4.0** | Confirm scope | Paylode does not store PAN/CVV/PIN, and card processing runs through Interswitch and Parallex/MPGS. The likely correct instrument is **SAQ-D for Service Providers or SAQ-A**, depending on how checkout handles card entry. Establish the correct SAQ with a QSA — do not guess, and do not claim a ROC. |
| **SOC 2 Type II / SOC 1 Type II** | Not held | The questionnaire marks these "where applicable". For a Nigerian PSSP with ISO 27001 targeted, answer "N/A — ISO 27001 pursued as the primary framework". |
| **CBN Risk-Based Cybersecurity Framework** | Partial | Self-assessment against the framework is achievable now and is expected of a licensee. Complete it, document it, attach it. |
| **NIST CSF 2.0 or equivalent** | Partial | POL-01 maps Paylode's controls to the six CSF 2.0 functions. Once approved, that is a defensible "Partial → Yes, documented framework". |
| **ISO 22301 (BCM)** | Not held | Answer "No". POL-08 is the documented BCM capability; certification is not realistic near-term and the Bank rarely insists on it for a vendor of this size. |
| **VAPT within 6 months** | Not held | GAP-12. |
| **SWIFT CSP** | **N/A** | Paylode does not connect to SWIFT. State it plainly. |

---

## Summary

| Band | Count | Character |
|---|---|---|
| Priority 1 — before submission | 8 | Free or ≤2 days each; all convert HIGH-priority answers |
| Priority 2 — before go-live | 8 | Real investment; GAP-12 (VAPT) and GAP-08 (localisation) dominate |
| Priority 3 — roadmap | 15+ | Disclose honestly with dates |

**The three that will decide this onboarding:** GAP-08 (data localisation),
GAP-12 (independent VAPT), GAP-25 (backups). Everything else is negotiable with a
credible plan.
