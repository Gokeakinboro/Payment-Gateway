# POL-04 — Incident Response Plan
> **[DRAFT POLICY — NOT YET APPROVED]**
> Prepared for Paylode Services Limited in support of Alpha Morgan Bank
> assessment AMB-ISO-VRQ-019. This document has **no force and is not evidence**
> until it is reviewed, amended to reflect Paylode's actual practice, versioned,
> dated and signed by a director. Do not attach it to the questionnaire in draft.

| | |
|---|---|
| **Document ID** | PSL-POL-04 |
| **Version** | 0.1 (draft) |
| **Owner** | Chief Technology Officer |
| **Approver** | Board of Directors, Paylode Services Limited |
| **Approved on** | ______ |
| **Next review** | Annually, or on material change |
| **Classification** | Internal |

---

## 1. Scope

Any event that compromises, or credibly threatens, the confidentiality, integrity
or availability of Paylode systems or data — including data belonging to a bank or
merchant.

## 2. Severity

| Level | Definition | Response |
|---|---|---|
| **P1 Critical** | Confirmed breach of customer or Bank data; funds at risk or lost; production down; ransomware; credential compromise with evidence of use | Immediate. Response team assembled within **30 minutes**, 24/7 |
| **P2 High** | Suspected breach; partial outage of a money-movement path; credential exposure with no evidence of use; a rail compromised | Within **2 hours** |
| **P3 Medium** | Isolated failed control; single-account compromise contained; degraded non-critical service | Within **1 business day** |
| **P4 Low** | Policy violation with no data impact; unsuccessful attack observed | Within **5 business days** |

## 3. Response team

| Role | Responsibility |
|---|---|
| **Incident Commander** (security officer / CTO) | Owns the incident; declares severity; authorises containment; single decision-maker |
| Technical lead | Investigation, containment, eradication, recovery |
| Compliance / DPO | Regulatory notification (CBN, NDPC), record-keeping |
| Communications | Bank, merchant and customer notification |
| Executive sponsor | Director-level decisions: service suspension, external counsel, law enforcement |

Contact details: **Annex H §H.5** — populate and keep current.

## 4. Lifecycle

1. **Detect** — automated alert, staff report, partner or merchant report, or
   external disclosure to `security@paylodeservices.com`.
2. **Triage** — Incident Commander assigns severity within the §2 window and opens
   the incident record with a timeline that is maintained throughout.
3. **Contain** — isolate affected systems; revoke or rotate compromised
   credentials; suspend affected merchant accounts, rails or API keys. **Preserve
   evidence before remediating** — capture logs, database state and system images
   first; premature cleanup destroys the forensic record.
4. **Eradicate** — remove the cause; patch; rebuild from known-good state.
5. **Recover** — restore service; verify integrity; monitor at heightened
   sensitivity for a defined period.
6. **Notify** — §5.
7. **Review** — post-incident review within **10 business days** (Appendix C).

## 5. Notification obligations

| Recipient | Trigger | Deadline |
|---|---|---|
| **Alpha Morgan Bank** | Confirmed impact to Bank data or the Bank-connected service | **24 hours from confirmation**, then every 24 hours until closure |
| NDPC | Personal data breach | 72 hours from awareness |
| CBN | Per licence conditions and the cybersecurity framework | Per the applicable circular |
| Affected data subjects | High risk to rights and freedoms | Without undue delay |
| Affected merchants | Their data or funds affected | 24 hours from confirmation |

**Every Bank notification contains:** incident summary and status; affected data
classes and estimated record volume; discovery and confirmation times; containment
and eradication steps taken and planned; named Paylode points of contact.

## 6. Playbooks

**A — Credential exposure** (immediately relevant: see GAP-05)
1. Identify every credential exposed and its blast radius.
2. **Rotate all of them** — do not assess likelihood of use first; rotate, then assess.
3. Review access logs for the exposure window for any use by an unrecognised source.
4. Purge from the exposure vector (git history, log, message, document).
5. If evidence of use exists → escalate to P1 and treat as a breach.
6. Add the detective control that would have caught it (secret scanning, push protection).

**B — Data breach**
1. Contain: revoke access, isolate the system, preserve evidence.
2. Scope: what data, whose, how many records, over what window.
3. Notify per §5 — the Bank clock starts at confirmation, not at conclusion of the investigation.
4. Support affected parties; remediate the root cause.

**C — Ransomware**
1. Isolate affected hosts from the network immediately.
2. **Do not pay.** Engage the executive sponsor and external counsel.
3. Restore from verified clean off-site backup (POL-08).
4. Rebuild rather than clean; rotate every credential the host could reach.
5. Report to CBN and law enforcement.

**D — Insider threat**
1. Preserve the audit trail before acting — `audit_logs` hold actor, before/after
   state and source IP for every privileged action.
2. Suspend access without notice to the subject.
3. Engage HR, the executive sponsor and legal counsel before any confrontation.
4. Assess data exfiltration; notify per §5 if confirmed.

**E — Payment rail or bank integration compromise**
1. Disable the affected rail (`payout_enabled = false`) — routing automatically
   excludes it and traffic continues on other rails.
2. Reconcile every in-flight instruction before resuming; **never re-send an
   instruction whose outcome is unknown** — re-query it.
3. Notify the rail or bank partner and agree a joint reconciliation.
4. Resume only after end-to-end reconciliation balances.

**F — Production outage**
1. Confirm via `/health` and `/health/modules`.
2. Identify the failing component; a failed module degrades rather than kills the platform.
3. Roll back from the timestamped deploy backup if a deployment is implicated.
4. Invoke POL-08 if recovery exceeds the RTO.

## 7. Testing

A tabletop exercise is run **at least annually** against at least one playbook,
with a written after-action report identifying what worked, what did not, and
dated remedial actions. The first exercise should use Playbook A.

## 8. Appendix C — Post-incident review template

Incident ID · severity · detection time · containment time · resolution time ·
timeline of events · root cause (five whys) · data and funds impacted · parties
notified and when · what worked · what did not · remedial actions with owners and
dates · lessons recorded in the risk register.

---

**Approval**

| | Name | Title | Signature | Date |
|---|---|---|---|---|
| Prepared by | | | | |
| Approved by | | Director | | |
