---
name: kiv-merchant-addressbook-invoice-subitems
description: KIV (2026-07-01) — two merchant features queued after Paymula — member suspend/deactivate/delete in address book + multi-line-item invoices
metadata: 
  node_type: memory
  type: project
  originSessionId: 610c646d-1fbf-4f5b-bc7b-05e1192617b6
---

✅ BOTH DONE + LIVE 2026-07-01 (PRs #34, #35). Details below.

Originally queued 2026-07-01 to pick up after Paymula:

1. **Merchant address book — member lifecycle actions.** Let a merchant **suspend, deactivate, or delete** a member from the address book / members list. (Members live in the Member/Paymula system — mw_members; the merchant-facing list is in wallet-admin.html "Members" + backend `modules/wallet/routes/members.js`. Add status transitions: active ↔ suspended/deactivated, and delete. Money-holding → deletion needs a guard (zero balance / soft-delete).)

2. **Multi-line-item invoices.** When creating an invoice the merchant specifies **multiple sub-items each with its own sub-amount**; the system **totals the sub-amounts** as the invoice total to collect. Today invoicing is single-amount (`inv_invoices.amount` + VAT). Needs: an invoice line-items table (or JSON column) `[{description, amount, qty?}]`, sum → total (+ VAT), UI in invoicing.html "Create invoice" to add/remove rows, and render line items on the invoice/checkout. See [[session-2026-06-28-invoice-collect-build]] / invoicing module.

Relates to [[project-paymula-member-app]] (members) and the invoicing module.
