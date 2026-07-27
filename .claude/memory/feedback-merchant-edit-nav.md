---
name: feedback-merchant-edit-nav
description: "SA portal UX rule — all merchant updates must go through the merchant detail modal, not inline or elsewhere"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b4bbb649-ae1b-46aa-b472-17efdd58cfcb
---

All merchant profile/detail edits must go through the SA portal modal flow:
**Users → Merchants → (click merchant row) → Edit button inside the modal**

No merchant updates should be done inline in list rows or via separate pages.

**Why:** User explicitly stated this is the canonical UX path (2026-07-21). Consolidating all edits through the modal keeps the workflow consistent and auditable from one place.

**How to apply:** Any future feature that lets SA/admin update a merchant's details (profile, settlement, rates, KYC status, etc.) should either be a button/section inside the existing `viewMerchant` modal or a tab added to it — not a new page or inline row action.
