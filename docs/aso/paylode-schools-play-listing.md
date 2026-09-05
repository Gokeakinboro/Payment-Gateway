# Paylode Schools — Google Play store listing (ASO)

Response to review item **1) App Store Optimization (ASO) Improvement**.

Copy below is **ready to paste into Play Console**. Everything in
[SQUARE BRACKETS] is a placeholder that must be replaced or deleted before
publishing. Read [Claims to verify](#claims-to-verify-before-publishing)
first — Play rejects listings that describe features the app does not have.

Character limits enforced by Play Console: **title 30**, **short description
80**, **full description 4000**. Counts shown below are exact
(`scripts/aso-charcount.sh` re-checks them).

---

## 1. App title (30 chars)

| # | Title | Chars | Notes |
|---|-------|-------|-------|
| **A (recommended)** | `Paylode Schools: Pay Fees` | 25 | Brand first, primary verb+noun second. Leaves room if the brand is ever extended. |
| B | `Paylode Schools – School Fees` | 29 | Maximises the exact-match phrase "school fees". |
| C | `Paylode Schools: Fee Payments` | 29 | Better if the app is sold to schools as much as to parents. |

Title carries the most ASO weight of any listing field. Keep the brand token
`Paylode` in it — branded search is the one query you are certain to win, and
it is how the sales team's referrals will find you.

Do **not** stuff the title (`Paylode Schools - Pay School Fees Online Fast
Cheap Nigeria`). Play's metadata policy treats keyword-stuffed titles as a
spam signal, and long titles are truncated to ~20 chars in search results.

## 2. Short description (80 chars)

The 80-char line shown above the fold, and the second-heaviest indexed field.

| # | Short description | Chars |
|---|-------------------|-------|
| **A (recommended)** | `Pay school fees in full or in flexible instalments. Fast, secure, licensed.` | 75 |
| B | `Pay school fees online, get instant receipts, and spread the cost per term.` | 75 |
| C | `School fees payments and financing for Nigerian parents, schools and wards.` | 75 |

Each opens with the head term ("Pay school fees" / "School fees payments")
rather than the brand — the brand is already in the title, and this field is
where the category term earns its indexing.

## 3. Full description (4000 chars)

Paste as-is. Play renders a **limited HTML subset** in this field (`<b>`,
`<i>`, `<u>`, `<br>`, `<p>`, `<ul>`, `<li>`); URLs and other tags are stripped.
The version below is plain text with capitalised headers, which renders
identically everywhere and is safe to paste without escaping.

```text
Paylode Schools is the simple way to pay school fees in Nigeria. Pay your
child's fees in full, or spread the cost across the term — from one app, on
your phone, in seconds.

Built by Paylode Services, a CBN-licensed payment service provider, so every
naira moves on regulated rails.

PAY SCHOOL FEES IN SECONDS
Find your child's school, select the term and the fee items you are paying
for, and pay by bank transfer or card. No queues at the bursary. No bank
branch. No printed teller to drop off at the school office.

SPREAD THE COST OF SCHOOL FEES
School fees rarely arrive when salaries do. Paylode Schools lets you split an
approved fee bill into smaller scheduled payments across the term, so your
child resumes on day one and you pay at a pace that matches your income.
[REPLACE WITH THE APP'S ACTUAL FINANCING TERMS — see the compliance note in
docs/aso/paylode-schools-play-listing.md before publishing this section.]

INSTANT RECEIPTS THE SCHOOL ACCEPTS
Every payment produces a receipt with a reference the school can verify
against its own records. Payments post to the school's Paylode account
automatically, so there is no "we have not seen your payment" at resumption.

ALL YOUR CHILDREN, ONE APP
Add every ward you pay for, in one or several schools. See what is due, what
is paid and what is outstanding per child, per term, on one screen.

PAY FOR MORE THAN TUITION
Tuition, development levy, exam and registration fees, uniforms, books,
excursions, boarding, PTA levies and bus fees — whatever the school bills
through Paylode, you can pay for in the app.

NEVER MISS A DEADLINE
Get a reminder before a fee deadline and an alert the moment a payment
clears, so nothing is missed while you are at work.

SECURE BY DESIGN
Paylode Services is licensed by the Central Bank of Nigeria as a Payment
Solution Service Provider. Card details are never stored on your phone, and
your account is protected with a PIN and biometric lock.

FOR SCHOOLS AND BURSARS
Schools on Paylode issue fee bills to parents, watch collections land in
real time, and reconcile a term's fees without chasing tellers or matching
bank statements by hand. Every payment is tied to a named student and a named
fee item. Contact [SALES EMAIL] to bring your school onboard.

WHO USES PAYLODE SCHOOLS
- Parents and guardians paying primary, secondary or tertiary fees
- Schools, bursars and finance officers collecting fees
- Sponsors and relatives paying fees on behalf of a student

GETTING STARTED
1. Download Paylode Schools and create an account with your phone number.
2. Add your child and select their school.
3. Pay the outstanding bill in full, or choose a payment plan.
4. Keep the receipt — it is stored in the app for good.

SUPPORT
Questions about a payment, a receipt or a plan: [SUPPORT EMAIL] or
[SUPPORT PHONE]. Our team answers [SUPPORT HOURS].

Paylode Schools is a product of Paylode Services Limited, a CBN-licensed
Payment Solution Service Provider. Privacy policy:
paylodeservices.com/privacy
```

Keyword placement in the above: "pay school fees" (title, short description,
opening line, H1-equivalent header), "school fees in Nigeria", "school fees
payment", "pay school fees online", "spread the cost", "fee bill", "tuition",
"development levy", "exam fees", "bursar", "receipts", "PTA levy", "bus fee",
"boarding". Head terms appear in the first 170 characters — the part shown
before the "Read more" fold.

---

## 4. Keyword set

Play does not expose a keyword field: **the title, short description and full
description are the keyword field.** These are ranked by relevance to the
product, not by measured volume — volume must be validated in Play Console's
**Store performance → Search terms** report (or AppTweak / Sensor Tower)
before any of it is treated as fact.

### Tier 1 — head terms (must appear in title or short description)
`school fees` · `pay school fees` · `school fees payment` · `school fee app`
· `pay fees online`

### Tier 2 — intent terms (work into the full description)
`pay school fees online` · `school fees Nigeria` · `school fees instalment` ·
`school fee financing` · `pay fees in instalments` · `tuition payment` ·
`school payment app` · `fees portal` · `school bill payment`

### Tier 3 — long-tail and item terms (cheap to rank for, high conversion)
`development levy` · `exam fees` · `PTA levy` · `boarding fees` ·
`school bus fee` · `registration fee` · `pay fees with transfer` ·
`school fees receipt` · `bursary payment` · `pay fees for my child`

### Tier 4 — brand and competitor context
`Paylode` · `Paylode Services` — plus, for *tracking only*, watch where the
listing ranks against **PaySkul**, **PixPay**, **SchoolPay Nigeria**,
**Pay4Me**, **Penney** and **Paystack for Schools**. Never name a competitor
in the listing text; Play's metadata policy prohibits it and it dilutes the
copy.

### Terms to avoid
`loan`, `borrow`, `credit`, `quick cash`, `instant loan` — these pull
loan-shopping traffic that converts badly against a fee-payment product, and
in Nigeria they place the listing squarely under Play's Personal Loans
policy. See the compliance note below.

---

## 5. The rest of the conversion surface

Keywords win the impression; these win the install. The review flagged only
the description, but the description is roughly a third of the job.

- **Screenshots (up to 8).** The first two are visible without scrolling and
  carry more conversion weight than any text field. Caption every one — an
  uncaptioned screenshot of a UI is wasted space. Suggested sequence:
  1. "Pay school fees in seconds" — the pay screen with a real fee bill
  2. "Spread the cost across the term" — the payment plan screen
  3. "One app, every child" — multi-ward dashboard
  4. "Receipts your school accepts" — receipt with reference
  5. "Reminders before every deadline"
  6. "Licensed by the CBN" — trust panel
  Portrait, 1080×1920 or larger, device frames optional.
- **Feature graphic (1024×500).** Shown above the screenshots and used in
  Play's promotional surfaces. Must read at thumbnail size: logo, one line of
  value proposition, nothing more.
- **App icon.** Legible at 48dp. No text in the icon.
- **Promo video.** Optional; skip until the screenshots are strong.
- **Category:** Finance. **Tags:** pick the closest available among Finance,
  Payments, Education-adjacent tags — tags feed Play's similar-app surfaces.
- **Store listing localisation:** publish an `en-NG` localisation, not only
  `en-US`. It lets you use "naira", "bursar", "development levy", "resumption"
  and "PTA" natively, which are exactly the long-tail terms Nigerian parents
  type.
- **Ratings and reviews.** Rating is a ranking input and the single biggest
  conversion lever on the page. Trigger Play's In-App Review API after a
  *successful* payment — the moment of maximum goodwill — never on app open.
  Reply to negative reviews; Play surfaces developer replies publicly.
- **Release notes.** Write them for parents, not for engineers. "You can now
  pay for more than one child in a single transfer" beats "bug fixes and
  performance improvements", and release notes are indexed.
- **Custom store listings.** Once install volume justifies it, run a separate
  listing for traffic from school-side campaigns, aimed at bursars rather
  than parents.

---

## 6. Compliance note — Play's Personal Loans policy (Nigeria)

**This gates the "financing" half of the listing.** Google Play applies a
country-specific Personal Loans policy to Nigeria: an app that offers or
facilitates personal loans to Nigerian users must submit the **Personal Loan
App Declaration** in Play Console and provide evidence that the lender is
approved by, or licensed with, the appropriate Nigerian authority — Play
checks this against the CBN's published list of approved digital lenders.

Which way this cuts depends on what "financing" actually means in the app,
and the answer changes both the copy and the Play Console paperwork:

- **If Paylode extends credit to the parent** (a loan, BNPL, or any deferred
  repayment with the parent as borrower) → the Personal Loans policy applies.
  The declaration must be filed and the licence evidence supplied *before*
  the financing copy goes live, and the listing must state the APR/fee range
  and repayment terms.
- **If the school is paid on its own schedule and the parent simply pays in
  instalments against an unpaid bill** (no credit extended, no third-party
  lender) → the policy generally does not apply, and the copy should avoid
  "loan", "credit" and "borrow" entirely so the listing is not
  mis-classified.
- **If a licensed third-party lender is the credit provider** → name them in
  the listing and confirm which party files the declaration.

CBN PSSP licensing covers payment processing; it is **not** a lending
licence and does not by itself satisfy this policy. Confirm the structure
with compliance before publishing the SPREAD THE COST section.

---

## 7. Measurement and update cadence

The review's "regular updates" point, made concrete. ASO is a loop, not a
launch task.

| When | Do |
|------|-----|
| Before publishing | Baseline: current installs, store listing conversion rate, and the search terms already delivering impressions (Play Console → Store performance). |
| Publish | Ship title + short + full description together, then leave them alone. |
| +14 days | Read Store performance → Search terms. Which Tier 1/2 terms now show impressions? Which convert? |
| +30 days | First iteration: rewrite the *short description* only, so the effect is attributable. Play's Store Listing Experiments (A/B) if install volume supports significance. |
| Quarterly | Full pass — refresh screenshots, re-check the keyword tiers against actual search-term data, re-read competitor listings. |
| Every release | Real release notes (see above). |
| Each new term | School resumption drives the seasonal demand spike. Have the listing and any seasonal screenshot captions in place *before* resumption, not during. |

Change one field at a time. Changing all three at once teaches you nothing
about which one moved the numbers.

---

## Claims to verify before publishing

Written from the product brief, not from the shipped app. Every line below
must be confirmed against the actual build — a listing that describes
features the app lacks is a Play policy violation (Deceptive Behaviour) and
a rejection, and this file was written without access to the Android source.

- [ ] Financing model — which of the three structures in §6 is it? Blocks the SPREAD THE COST section and the Play declaration.
- [ ] Payment methods actually live: bank transfer? card? USSD? virtual account?
- [ ] Multi-ward support ("all your children, one app") — shipped or roadmap?
- [ ] Fee item types the app really bills (tuition, levies, uniforms, bus, boarding)
- [ ] Deadline reminders and payment alerts — implemented?
- [ ] PIN and biometric lock — implemented?
- [ ] Receipt reference verifiable by the school
- [ ] School-side (bursar) features, and whether they belong in a parent-facing listing at all
- [ ] Exact CBN licence wording legal will sign off on
- [ ] Placeholders replaced: [SALES EMAIL], [SUPPORT EMAIL], [SUPPORT PHONE], [SUPPORT HOURS]
- [ ] Privacy policy URL live and matching the Play Data safety form
