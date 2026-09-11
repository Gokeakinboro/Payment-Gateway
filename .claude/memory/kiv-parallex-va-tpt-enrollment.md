---
name: kiv-parallex-va-tpt-enrollment
description: Parallex VA settlement account 1000362856 not enrolled in TPT — cannot debit for payouts; need Parallex to enroll it
metadata:
  type: project
---

# KIV: Enroll Parallex VA Settlement Account in TPT Product

**Date deferred:** 2026-09-03

## The problem
VA settlement account `1000362856` receives all Parallex VA inflows but is NOT enrolled in the TPT product. Both `IntrabankTransfer` and `InterbankTransfer` reject it with:
> "Account Does not belong to you, Kindly use an account that belongs to you and try again" (code `09`)

`GetBalance` also fails: "Invalid Account Number, Please Try again"

Current payout debit account: `1000362849` (payout float) — only this one is enrolled in TPT.

**Why:** Code `09` from Parallex is ambiguous — our code maps it to PENDING_CODES but in this context it means "not authorized". Minor fix needed too.

## Impact
Every time merchants fund via VA (money lands in `1000362856`), Goke must manually transfer `1000362856` → `1000362849` via the Parallex internet banking portal before those funds can be used for outbound payouts.

## Action required
**Goke to call Parallex:** "Please enroll account `1000362856` in the TPT product so it can be used as a debit account for outbound transfers."

Once enrolled:
- Change `PARALLEX_TRANSFER_DEBIT_ACCOUNT=1000362856` in `.env` on 176
- The automatic VA→payout sweep (`sweep-va-to-float2.js`) will work
- Merchant-funded payouts will be fully automated

## Code fix also needed (minor)
In `parallexTransferService.js`, Parallex code `09` is in `PENDING_CODES` but in the "account not authorized" context it's actually a rejection. Consider checking responseDescription to distinguish.
