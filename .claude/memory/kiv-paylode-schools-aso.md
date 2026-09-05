# 🟡 KIV — Paylode Schools (Android) ASO

_2026-09-05. From an external Android app review, item 1: "App Store
Optimization (ASO) Improvement" — description too thin, no keywords._

## Done
Store-listing copy + keyword strategy written to
`docs/aso/paylode-schools-play-listing.md`:
title (3 options, ≤30), short description (3 options, ≤80), full description
(3000/4000 chars, ready to paste), 4-tier keyword set, screenshot/feature-
graphic/reviews/localisation guidance, measurement cadence.
`scripts/aso-charcount.sh` verifies every field against Play's limits
(needs a UTF-8 locale or `wc -m` counts bytes and en dashes read +2).

## Open — blocks publishing
1. **The app itself is not in this repo.** Every feature claim in the listing
   was written from the product brief, not the build. The doc ends with a
   verification checklist — work it before pasting into Play Console, or the
   listing is a Deceptive Behaviour rejection.
2. **Financing structure undecided (or at least unknown here).** Google Play
   applies a Nigeria-specific Personal Loans policy: if Paylode extends
   credit to the parent, the Personal Loan App Declaration must be filed with
   evidence of CBN lender approval. PSSP licensing is **not** a lending
   licence. If it is only instalments against an unpaid bill with no credit
   extended, the policy likely does not apply — but the copy must then avoid
   "loan"/"credit"/"borrow" so Play does not mis-classify it. §6 of the doc.
3. Placeholders unfilled: sales email, support email/phone/hours.
4. No Play listing found for the app in public search (2026-09-05) — either
   unpublished or listed under another name. Confirm the package name and
   whether Play Console access exists.

## Rest of the review not yet actioned
The pasted review was **truncated mid-sentence at item 1**. Later items
(2, 3, …) were never received — ask the user for the full document.
