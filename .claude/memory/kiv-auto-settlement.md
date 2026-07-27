---
name: kiv-auto-settlement
description: KIV (2026-07-05) — auto-settlement driven from the Settlement page (daily/merchant views, execute via the payout product, per-channel net report for all users, compulsory merchant settlement bank at onboarding, SA margin/profitability columns on settlement + payout reports)
metadata:
  node_type: memory
  type: project
---

🟡 KIV — **Auto-settlement via the Settlement page** (parked 2026-07-05). Scope as the user described it:

- **Settlement page** shows settlements **per day and per merchant** (daily + merchant breakdown views).
- **Execute settlement through our Payout product** — operator **chooses which bank/rail** to pay out through (reuse the existing payout rails, e.g. PalmPay).
- **Full settlement report available to ALL users** (merchant-facing, not just admin).
- **Merchant settlement bank details = COMPULSORY at onboarding** — add a required settlement-bank field to merchant onboarding (today it's optional/absent); settlement can't run without it.
- **Report shows per-CHANNEL net**: net amount received **per channel — CARDS / TRANSFER / USSD** (channel column + net/channel).
- **SA (Super Admin) report** adds a **margin** column: our margin / settlement / merchant / day → profitability tracking.
- **Payout reports to SA** should ALSO show this margin, so profitability is trackable from both the settlement side and the payout side.
- **SA FIRES the actual payment** (2026-07-05): the Super Admin triggers the settlement payout by **picking the bank + a date/time to fire**. If **date/time is left blank → fire immediately**. (So settlement is SA-controlled: schedule it, or run it now.)

**Future sub-KIV (phase 2):** **auto-check actual bank receipts** — reconcile against the real inbound funds on our bank so that when money actually lands, we can **automatically pay merchants** (removes the manual SA fire step). Ties into [[kiv-bank-reconciliation-module]] (bank-statement matching) — receipt-detection is the trigger, reconciliation is the matching.

## 📐 DESIGN APPROVED 2026-07-05 — resume here
Full phased plan (user-approved) at **`C:\Users\Goke\.claude\plans\greedy-watching-kay.md`** — combines
this (item 1) + [[kiv-bank-reconciliation-module]] (item 3) as ONE settlement/profitability workstream.
**PROGRESS:** ✅ A1+A2 built → **PR #63** (`feat-settlement-a1-a2-bank-required-channel-report`, STAGED, not deployed) — A1 compulsory merchant settlement bank at onboarding (`onboarding.js /submit`, `form_type==='merchant'` requires `data.np_business.{bank_name,account_number,account_name}`); A2 `GET /settlements/:id/breakdown` per-channel gross/fee/net + SA-only margin. All 4 decisions RESOLVED (margin formula confirmed; recon=CSV **or XLS**; fire allowed for SUPER_ADMIN + SA-granted admin via NEW `settlement_fire` permission [add to `config/permissions.js` FUNCTIONALITIES, NOT in any role default; gate `/fire` on `requirePermission('edit_settlement_fire')` — SA bypasses via `hasPermission`]). ✅ **A3 BUILT → DRAFT PR #64** (`feat-settlement-a3-fire`, money, NOT deployed, awaiting review/sign-off). `services/settlementFire.js` (dedicated dispatch via `palmpay.initiatePayout` — NOT the wallet-debiting payouts.js path, since settlement remits collections not the merchant wallet; name→code via `nibssBanks.resolveBank` + `palmpay.nameEnquiry` confirm before send; atomic PENDING/FAILED→PROCESSING claim; poller `queryPayoutResult` finalizes since no rail_disbursement leg for the webhook); `POST /settlements/:id/fire {rail_id,scheduled_at?}`; NEW `settlement_fire` permission (not in role defaults → SA bypass + SA-granted admins via `edit_settlement_fire`); `jobs.js` worker-0 job; migration + Settlement schema fields. MVP = NGN + LIVE PalmPay rail. **Deploy needs `prisma generate`** (new fields) + migration as app user + `pm2 reload paylode-core`.
✅✅ **PHASE A DONE + LIVE 2026-07-05** (PRs #63 A1+A2, #64 A3, #65 A4+Fire-UI all merged + DEPLOYED to 176 + 45/176 frontend, live-verified). Settlement is now fully usable by SA:
- A1 compulsory settlement bank at onboarding; A2 `/settlements/:id/breakdown` per-channel + SA margin; A3 `POST /settlements/:id/fire {rail_id,scheduled_at?}` (dedicated PalmPay dispatch, name-enquiry, poller, `settlement_fire` perm, worker-0 job "Settlement firing/reconcile every 60s"); A4 margin+rail_cost on SA payout report `/payouts/admin/report`.
- **Fire UI LIVE** (`api-wiring.js?v=102`): SA Settlements page → **Fire** button on unpaid NGN settlements → modal (per-channel breakdown + margin, LIVE-PalmPay rail picker, optional datetime blank=now) → fire. Migration `20260705_settlement_fire.sql` applied; prisma generate ran; `settlements` has rail_id/scheduled_at/fired_by/fired_at/payout_order_id/payout_ref/failure_reason.
- **HOW TO TEST:** SA dashboard → Settlements → Fire on a PENDING NGN settlement (needs a LIVE PalmPay rail + merchant settlement bank resolvable via nibssBanks). Margin visible in the modal + on the payout report.
- ✅ **2026-07-05 follow-ups deployed:** (a) **Run Batch date-picker** (PR #67) — the Live/Sandbox buttons prompt for a date (were hardcoded to yesterday/today → 0 settlements on empty days, which is why "no Fire button" appeared; settlements table was empty). (b) **Daily auto-generation cron** (PR #68) — `services/settlementProcess.js` `generateSettlements` (IDEMPOTENT: skips a merchant/currency/day already settled) used by `/process` + a **worker-0 job that runs for the PRIOR day at 00:01 server-local (Europe/Berlin = 23:01 Lagos)** + boot catch-up. ⚠️ **TZ: fires 00:01 Berlin, NOT Lagos** — user asked "00:01"; confirm whether they want Lagos alignment (would need the schedule + dayWindow keyed to WAT). Settlements now populate on their own; no manual batch needed.
- **NOTE:** settlements table was EMPTY through 2026-07-05 (no batch had ever created rows for a day with txns). Live SUCCESS txns exist on 2026-07-05/07-02/06-30 (small ₦100-ish tests).

🔴 **STILL OPEN → Phase B (reconciliation), NOT built** — deferred to a focused session (deliberately, to avoid rushing money-adjacent code at the tail of a very long session). Scope per [[kiv-bank-reconciliation-module]]: `bank_statement_lines` table + `POST /reconciliation/upload` (**CSV or XLS**) → batch-aware match settlements↔bank credits (amount + date-window + partial-ref) → Matched/Partial/Unmatched/In-transit + exceptions report + export; then Phase-2 open-banking + auto-detect inbound receipts → auto-fire (the user's future sub-KIV).

_(historical NEXT was A3, now done):_ **A3** (the money-moving core): migration `settlements.{rail_id,scheduled_at,fired_by,fired_at,payout_ref,failure_reason}` + `POST /settlements/:id/fire {rail_id,scheduled_at?}` (blank=now) creating a `PayoutBatch` tagged `source=settlement` via `payouts.js`→`palmpay.payout` to the merchant `settlementAccount`; scheduled-fire worker in `gateway-core/jobs.js`; then A4 margin on payout report; then frontend Settlement page; then Phase B recon. Study `payouts.js` dispatch + `payoutSettle.js` before A3.

Phased (each = its own PR + money sign-off):
- **Phase A (settlement exec+reporting):** A1 make settlement bank compulsory at onboarding
  (`backend/src/routes/onboarding.js:588`, cols already exist); A2 per-channel settlement report for
  all users + **SA margin** (compute from `transactions` grouped by `channel`, reuse `reports.js`
  `/vat` raw-SQL pattern; guard margin behind SA role); A3 **SA fires** via
  `POST /settlements/:id/fire {rail_id, scheduled_at?}` (blank=now, else worker fires) → dispatch a
  settlement payout (lean: a `PayoutBatch` tagged `source=settlement`) through `payouts.js`→
  `palmpay.payout`; migration adds `settlements.{rail_id,scheduled_at,fired_by,fired_at,payout_ref,
  failure_reason}`; A4 margin on SA payout report too.
- **Phase B (reconciliation MVP):** `bank_statement_lines` + CSV upload → batch-aware match
  settlements↔bank credits (amount+date-window+partial-ref) → exceptions + export.

**Decisions:** #1 ✅ RESOLVED — settlement fires through **our payout channels, any rail SA chooses**
(Paylode-funded from collections, NOT the merchant payout wallet). **STILL OPEN (ask before A2/A3):**
#2 exact margin formula (proposed `Σ(merchant_fee−vat_output) − Σ(rail_cost−vat_input)`); #3 recon =
manual CSV first (assumed yes); #4 who may fire — SA only or also COMPLIANCE_OFFICER.
Current settlement code = `gateway-core/routes/settlements.js` (`/process` only CREATES PENDING rows,
never pays). Channel enum = CARD|BANK_TRANSFER|USSD|DIRECT_DEBIT.

Relates to: [[project-payout-wallet-per-rail]] (payout rails; collections are already pass-through and remitted to the merchant bank, never held), [[kiv-bank-reconciliation-module]] (reconcile settlements vs the merchant's bank), [[feedback-paylode-money-signoff]] (money-path → needs sign-off). This formalises the settlement UI + auto-execution + per-channel + profitability reporting on top of that pass-through design.
