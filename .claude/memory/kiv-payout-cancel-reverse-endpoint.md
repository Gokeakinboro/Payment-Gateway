---
name: kiv-payout-cancel-reverse-endpoint
description: KIV — build a proper cancel/reverse endpoint for payout batches (system has NONE; only refund path is inside the /route disburse-fail flow)
metadata:
  node_type: memory
  type: project
---

✅ **DONE + LIVE 2026-07-07 (PR #92).** Built `POST /api/v1/payouts/admin/batches/:id/cancel` (SA-only): for a `needs_routing` batch → reverses the full deduction (beneficiary+fee+VAT) to the merchant's pooled wallet (route-rail row else largest, mirroring the /route hard-fail refund), writes a **REVERSAL** `wallet_ledger` entry, marks batch + queued items `reversed`, `logAudit` `PAYOUT_BATCH_CANCELLED`, never contacts the rail (no float debited pre-dispatch). Frontend: **Cancel** button next to Release on the Merchant Wallet "Batches awaiting release" row (`cancelPayoutBatch`, api-wiring v117). Deployed backend to 176 (paylode-core) + frontend to 45. Only cancels un-dispatched batches (dispatched ones still go via the /route fail-refund path).

---
**Gap found 2026-07-07:** Paylode has **no cancel/reverse endpoint for a payout batch.** A batch in `needs_routing` (created + merchant wallet already debited `amount+fee+VAT`, but **not yet dispatched to any rail**) can only be resolved by `POST /api/v1/payouts/admin/batches/:id/route` (SA) — which DISPATCHES to the rail; the merchant wallet is refunded ONLY as a side-effect when a leg is *hard-rejected* by the rail (see `payouts.js` ~L1179–1197: refunds float + `merchant_wallets.balance += amount+item_fee+item_vat`, marks item/batch `failed`). There is no way to cancel a queued batch WITHOUT sending it to the rail, and even the refund path does **NOT write a `wallet_ledger` row** (just bumps balance).

**KIV — build `POST /api/v1/payouts/admin/batches/:id/cancel`** (SA-only): for a `needs_routing` (or otherwise un-dispatched) batch → refund the merchant's pooled wallet the full `total_deduction` (amount+fee+VAT), set batch+items status `reversed`/`cancelled`, **write a compensating `wallet_ledger` entry**, and `logAudit`. Must be pooled-safe (credit the route-rail wallet row if present else largest balance row, mirroring the existing refund). Never contacts the rail. Add a Cancel button next to Release on the Merchant Wallet batch row.

Context: surfaced while reversing Bucksnostar order `12026070714045700101766` (₦100 to invalid acct `0123456789`, PalmPay "Abnormal payee account status"). Goke chose to reverse it via the release→auto-fail-refund path for now. Links: [[project-merchant-routing]], [[kiv-backlog-index]], [[project-parallex-integration]].
