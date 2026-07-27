---
name: kiv-bank-reconciliation-module
description: "🔴 IMPORTANT KIV — bank reconciliation module for the Paylode gateway (match Paylode ledger vs merchant's real bank statement). Scoping locked 2026-07-01."
metadata: 
  node_type: memory
  type: project
  originSessionId: 610c646d-1fbf-4f5b-bc7b-05e1192617b6
---

# 🔴 KIV (IMPORTANT) — Auto Bank Reconciliation (merchant VALUE-ADD)

## ✅✅ MVP DONE + LIVE 2026-07-05 (PR #71)
Bank reconciliation module shipped + deployed to 176 (+ frontend 45/176). Reconciles Paylode settlements vs the merchant's bank statement.
- **DB:** `bank_statement_lines` (raw-SQL table, migration `20260705_bank_reconciliation.sql`).
- **Matching** `gateway-core/services/reconcile.js` `autoMatch(merchantId, {amountToleranceKobo=100, lagDays=3})` — batch-aware: a bank CREDIT ↔ a settlement's net when amounts agree (±₦1) AND the credit lands in [settlement day-1 .. +lagDays]; 1:1; exact=matched, near=partial.
- **API** `gateway-core/routes/reconciliation.js` (mounted `/api/v1/reconciliation`, registry `money`): `POST /upload` (CSV **or** XLS/XLSX via SheetJS `xlsx`; headers auto-mapped date/credit/debit/narration/balance + signed-amount fallback) → auto-match; `POST /auto-match`; `GET /results` (summary + lines + exceptions: unmatched bank credits, settlements-not-in-bank); `POST /match` (manual). Merchant→own scope; SA/staff via `merchant_id`.
- **Frontend:** SA "Reconciliation" nav (⇄, under Connections) → merchant picker + upload + summary cards + exceptions + statement lines. `loadReconciliation`/`recLoad`/`recUpload`/`recAutoMatch`. **PLUS merchant self-service** (PR #72): "Reconciliation" in the MERCHANT nav (Transactions) → `loadMerchReconciliation()` (no picker; scoped to own account). rec* fns role-aware (picker=SA→merchant_id; none=merchant→own). app.js v100 / api-wiring v106.
- **Added dep:** `xlsx@^0.18.5` (npm installed on 176).
- **HOW TO TEST:** SA → Reconciliation → pick merchant → upload their bank statement CSV/Excel (cols: date, credit/debit or a signed amount, narration, balance) → auto-matches against that merchant's settlements → matched/partial/unmatched + "settlements not in bank" exceptions.
- 🟡 **Phase 2 (still KIV):** open-banking auto-pull (Mono/Okra); auto-detect inbound receipts → auto-fire settlement (the user's future sub-KIV); export to accounting; richer column-mapping UI.


**Positioned as a merchant value-add** (user, 2026-07-02): auto-reconcile **what Paylode settles to the merchant** against **what actually lands in the merchant's settlement account with their bank** — a differentiator that saves merchants manual recon.

Match **Paylode's ledger** (settlements paid, collections gross/fee/VAT/net, payouts, refunds/chargebacks — we already hold these) against **what actually moved in the merchant's real bank/settlement account**. Merchant's bank data is the only missing input.

## Inputs needed FROM merchants
1. **Bank statement data** (the crux). Acquisition MVP→scale:
   - Manual upload CSV/OFX/MT940 (PDF = messy last resort) — MVP.
   - Open-banking aggregation (Mono / Okra / Stitch NG) auto-pull — needs account link + consent; scalable path (adds integration + per-pull cost).
2. Which account(s): settlement account (on file) + any operating accounts.
3. CSV column/format mapping (date, credit, debit, narration/ref, balance).
4. Reconciliation period + opening balance.
5. Matching tolerances: date window (T+1/T+2 lag), amount tolerance, how Paylode's narration appears on their statement (banks truncate refs).
6. Consent/creds only if open-banking.
(Already have, don't ask: settlement batches, per-txn gross/fee/VAT/net, payout status, refunds.)

## Outputs merchants expect
1. Per-item status: Matched / Partial / Unmatched / **In-transit** (expected, not yet on statement).
2. Summary: opening bal → expected credits vs bank credits → matched % → net discrepancy → adjusted closing bal.
3. **Exceptions report** (main value): settlements paid but not in bank (missing/delayed); bank credits with no Paylode match; amount mismatches/duplicates.
4. Fee & VAT reconciliation: gross → fees → VAT → net settled (proves the math).
5. **Batch drill-down**: 1 bank credit = 1 settlement batch of N txns → expand to underlying txns.
6. Aging of unmatched/in-transit + alerts ("settlement not received in X days", "unexpected debit").
7. Auto-match + manual match (notes) + exportable CSV/PDF → feeds [[kiv-accounting-software-integration]].

## Key challenges
- **Batch settlements**: N txns → 1 bank line → matching must be batch-aware (not 1:1). Hardest part.
- **Narration matching** is fuzzy → key on amount + date-window + partial-ref with tolerances.
- **Statement acquisition** is the gating decision: manual CSV (quick) vs open-banking (scalable, costs).
- **Timing**: T+1 settlement → bank credit lands later → "in-transit", not "missing".
- NG statement formats vary; prefer CSV/API over PDF parsing.

## Phasing
- **MVP**: manual CSV upload → batch-aware auto-match settlements↔bank credits → summary + exceptions + export.
- **Phase 2**: open-banking auto-pull (Mono/Okra), payout-funding-account recon, push exports into accounting software.

Data we build on: existing settlements + transactions + payouts ledgers ([[project-paylode]], [[project-payout-wallet-per-rail]], [[session-progress-payout-recon]]). Backlog: [[kiv-backlog-index]].
