# ANNEX D — Data Classification, Inventory and Retention
### Paylode Services Limited · Alpha Morgan Bank AMB-ISO-VRQ-019 · CONFIDENTIAL

**Answers:** Section B (data types handled, processing operations, non-production
use), items 13.3, 13.4, 13.6, 13.9
**Status:** [VERIFIED] against `backend/prisma/schema.prisma` (36 models).

---

## D.1 Classification scheme

| Class | Definition | Handling rule |
|---|---|---|
| **C4 — Restricted** | Data whose disclosure causes direct financial loss or regulatory breach: BVN, NIN, settlement account numbers, API keys, webhook secrets, password hashes, TOTP secrets, encryption keys | Encrypted or hashed at rest; never logged; never in non-production; access limited to named roles with audit |
| **C3 — Confidential** | Customer and merchant PII, transaction records, ledger entries, KYC documents, Bank data received under this engagement | Encrypted in transit; role-gated; audit-logged on change; retained per D.4 |
| **C2 — Internal** | Operational configuration, rail costs, platform settings, internal reports | Staff access only |
| **C1 — Public** | Marketing site, published API documentation, SDK packages | No restriction |

---

## D.2 Bank data types Paylode will handle under this engagement

Answering the Section B question "List each Bank data type that will be
collected, stored, transmitted, or otherwise handled":

| Data type | Class | Direction | Stored? | Purpose |
|---|---|---|---|---|
| Virtual account number issued by the Bank | C3 | Bank → Paylode | Yes | Map incoming credits to the correct merchant/customer |
| Virtual account name / reference | C3 | both | Yes | Provisioning and reconciliation |
| Payer name, payer bank, payer account (masked where supplied) | C3 | Bank → Paylode | Yes | Collection record, AML surveillance, dispute handling |
| Transaction amount, currency, timestamp, NIP session ID, Bank reference | C3 | both | Yes | Ledger, settlement, reconciliation |
| Beneficiary bank code, account number, resolved account name | C3 | Paylode → Bank | Yes | Payout instruction and its audit record |
| Payout narration / reference | C3 | Paylode → Bank | Yes | Reconciliation |
| Collection account balance and statement lines | C2/C3 | Bank → Paylode | Yes | Float management and daily reconciliation |
| Bank API credentials / certificates | **C4** | Bank → Paylode | Yes — environment configuration only, never in source | Authenticate to the Bank |
| BVN / NIN of Paylode's own merchants | **C4** | not from the Bank | Verification **result** and reference retained; see D.3 | CBN KYC obligations |
| **Cardholder data (PAN, CVV, PIN)** | — | — | **Never stored** | Paylode does not store card data in plaintext; card rails are Interswitch and Parallex/MPGS. Item 9.6 = "Yes". |
| Bank employee records | — | — | **No** | Not requested, not required. Answer "N/A". |

**Processing operations performed on Bank data** (the Section B question):
storage, matching (credit ↔ merchant ↔ settlement), enrichment (bank-code
resolution, fee and VAT computation), aggregation (settlement batching),
transmission (to the merchant by signed webhook; to the merchant's settlement
bank), surveillance (AML rule evaluation), reconciliation, and deletion per D.4.
**No profiling, no resale, no secondary analytics, no use for model training.**

---

## D.3 Where each class lives

| Store | Contents | Protection |
|---|---|---|
| PostgreSQL on 176 (`transactions`, `settlements`, `payout_batches`, `payout_items`, `merchant_wallets`, `wallet_ledger`, `rail_disbursements`, `bank_statement_lines`) | The transactional and ledger record | Loopback-bound; not internet-exposed; amounts as integer kobo |
| `merchants.settlement_account` | Merchant settlement account numbers | **AES-256-GCM encrypted at the application layer** (`utils/helpers.js`) |
| `api_keys.key_hash` | Merchant API credentials | **SHA-256 hash only** — plaintext never persisted |
| `users.password_hash` | Staff and merchant passwords | **bcrypt** |
| `users.totp_secret` | Second-factor seeds | Stored; **[GAP]** should be encrypted at rest with the same AES-256-GCM helper — see GAP-13 |
| `merchants.webhook_secret` | Per-merchant HMAC signing secrets | Reveal/rotate requires step-up re-authentication |
| `kyc_submissions` (`bvn_data`, `nin_data`, `cac_data`, `documents`) | Identity verification results and document pointers | Role-gated to compliance; **[GAP]** verification payloads are held as JSON rather than encrypted columns — see GAP-13 |
| Cloudinary | KYC document images | Third-party, **outside Nigeria** — GAP-08 |
| `audit_logs` | Actor, action, entity, before/after state, IP | Append-only in practice; **[GAP]** not cryptographically tamper-evident — GAP-11 |

---

## D.4 Retention schedule (13.6)

Paylode's default retention is set by the CBN and NDPC obligations that bind a
PSSP, not by convenience.

| Data | Retention | Driver |
|---|---|---|
| Transaction and ledger records, settlement records, payout records | **10 years** from transaction date | CBN AML/CFT record-keeping |
| KYC records and verification reports | **10 years** after the business relationship ends | CBN AML/CFT |
| AML flags, compliance exceptions, suspicious-activity records | **10 years** | CBN AML/CFT |
| Audit logs (`audit_logs`) | **7 years** | Forensic and regulatory examination |
| API and application logs | **12 months minimum** | Bank requirement 6.8 / 10.3 — see GAP-11 |
| KYC document images | 10 years, then secure deletion | CBN AML/CFT |
| Marketing and support correspondence | 2 years | NDPA minimisation |
| Backups | Rolling 90 days, then overwritten | Operational |

**Answer to "Can the Bank request customised retention schedules?" — Yes**, for
any period **at or above** the statutory floors above. Paylode cannot delete
AML-relevant records earlier than the CBN retention period even on the Bank's
instruction, and the DPA should say so explicitly. Regulators treat that carve-out
as correct; a vendor who promises unconditional deletion of AML records is either
misunderstanding the rule or planning to break it.

---

## D.5 Bank data in non-production environments

**Answer: No.**

- Sandbox and live are separated by credential (`sk_test_` vs `sk_live_`) and every
  transaction row carries `is_sandbox`.
- A live API key is additionally inert unless an administrator has set
  `merchant.liveEnabled` — so real money movement cannot happen from a test
  integration even with a live key present.
- The sandbox is seeded with synthetic merchants and synthetic amounts.

**[GAP], disclose it:** production and sandbox currently share one database and
one host (network segregation gap, GAP-01), and there is **no automated
de-identification pipeline** — the control is "no copying", enforced by procedure
rather than by tooling. If the answer to Section B's non-production question is to
remain a clean "No", the prohibition on restoring production data into lower
environments must be written into `policy/POL-03` and enforced. It is, in the
draft — have it approved.

---

## D.6 Data minimisation (13.3)

- The Bank data list in D.2 is the **complete** set Paylode requests. Paylode does
  not ask the Bank for full payer account numbers where a masked value suffices,
  does not request Bank customer records outside the transaction flow, and does
  not require access to any Bank system beyond the two APIs.
- Within Paylode, KYC collection is **tiered**: Tier 1, 2 and 3 carry different
  transaction ceilings (₦5m / ₦100m / ₦500m single-transaction limits, enforced in
  `services/amlService.js`) and different evidence requirements, so a low-volume
  merchant is not asked for documents their tier does not warrant.
- Card PAN, CVV and PIN are never persisted (D.2).

---

## D.7 Data subject rights (13.8)

Public self-service endpoints exist today — `account-deletion.html` and
`data-deletion.html` are published on the Paylode site, and the platform supports
deletion requests. The DSR process, statutory response window (**30 days** under
the NDPA 2023) and the Bank-instruction path are specified in
`policy/POL-03` §6. Attach that policy, and attach a sample of the DSR request
log once the first requests have been processed.
