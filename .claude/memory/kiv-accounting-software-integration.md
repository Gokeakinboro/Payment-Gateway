---
name: kiv-accounting-software-integration
description: KIV — hook the Paylode gateway into accounting software (QuickBooks/Xero/Zoho/Sage). Blocked on USER picking a provider + OAuth creds. Discussed 2026-06-20.
metadata: 
  node_type: memory
  type: project
  originSessionId: af42272b-46fa-4a50-9f39-fc833ed70fc6
---

# KIV — Accounting-software integration (Paylode)

User asked 2026-06-20 "can we hook the gateway into an accounting software?" — answer: YES, very doable. Logged as KIV pending the user's **provider choice + OAuth credentials**.

**Data is already there** (no new model needed): `transactions`, `settlements`, `wallet_ledger`, VAT (`vat_output`/`vat_input`/net, + the /reports/vat report), payouts (`payout_batches`/`payout_items`/`rail_disbursements`). Mapping → ledger: revenue = our fee EX-VAT; output VAT (on our fee) & input VAT (rail) → net VAT liability; merchant settlement = liability/payout; rail cost = expense; aggregator share = expense/payable.

**Approach options (cheapest → richest):**
1. **Report import** (fastest, zero code) — we already email CSV/XLSX reports; QuickBooks/Xero/Zoho/Sage all import these.
2. **Webhook-driven sync** (real-time) — on `payment.success` / settlement / payout, push a journal entry / sales receipt to the accounting API.
3. **Scheduled connector** (cleanest books) — nightly job posts the day's activity as journal entries via the provider REST API. **Recommended starting point**, one provider first.

**Providers (all OAuth2 REST):** QuickBooks Online, Xero, Zoho Books, Sage.

**TO START (needs USER):** (1) pick the accounting package; (2) provide OAuth app credentials / connect the account. THEN: build a connector module (OAuth connect + entity mapping + scheduled push), one provider first, expand later. See [[project-paylode]].
