---
name: kiv-server-repo-reconciliation
description: KIV — reconcile git repo ← production for Paylode backend on 176 (prod-only files not in git); MUST run from a LOCAL session (needs SSH to 176)
metadata: 
  node_type: memory
  type: project
  originSessionId: 610c646d-1fbf-4f5b-bc7b-05e1192617b6
---

🟡 **KIV — repo ← production reconciliation (Paylode backend, 176).** Flagged 2026-07-01.

## ✅ 2026-07-08 DECISION — LEAVE the 176 backend git as-is (noted, no action taken).
**Goke's call (2026-07-08): leave it.** It's cosmetic — the live gateway runs fine and does not use this `.git` (deployed file-by-file). Nothing was changed on prod (all reset attempts aborted at the money-file gate or were guard-blocked; HEAD still `c0ce9d1`, health 200). **Factual correction to the alarmist note that follows:** the repo is NOT "mis-rooted" — that was a `git`-run-from-the-`backend/`-subdir scoping artifact. Ground truth (verified from the repo ROOT, CRLF-normalized): repo root `/opt/paylode-api` correctly tracks `backend/` (GitHub `Payment-Gateway` main root likewise contains `backend/`); **live `backend/` == origin/main with 0 genuine content diffs** (HEAD is just stale + 5 orphan KYC commits; the git "diffs" were CRLF-vs-LF). Backups: `/root/backups/paylode-reconcile-*`. If ever revisited by a human, any git op MUST run from the ROOT `/opt/paylode-api` (never the `backend/` subdir). For now: **no action — intentionally left.**

### ⚠️ [SUPERSEDED / INCORRECT — the "mis-rooted / phantom src/" analysis below was a subdir-cwd artifact; ignore it]
Goke authorized the reset; the gated command's money-file check **ABORTED** (safe — no reset ran, HEAD still `c0ce9d1`, health 200). The abort exposed the real topology, which invalidates the "safe bookkeeping-only reset" call below:
- **`.git` is at `/opt/paylode-api` (repo ROOT), NOT at `/opt/paylode-api/backend`.** `git rev-parse --show-toplevel` = `/opt/paylode-api`. Only one `.git`; none inside `backend/`.
- **The running service lives in the `/opt/paylode-api/backend/` SUBDIR** (pm2 `paylode-core` cwd=`/opt/paylode-api/backend`, script `backend/src/entrypoints/core.js`), deployed **file-by-file** — NOT governed by this `.git`.
- The repo tracks a `src/` at the ROOT that **does not physically exist** (`/opt/paylode-api/src/...settlements.js` = No such file). origin/main's tree (`src/`,`prisma/`,… at root) matches the running code's CONTENT but at the WRONG PATH.
- **So `git reset --hard origin/main` would materialize origin/main at `/opt/paylode-api/` ROOT** (a phantom 2nd copy) and could disturb ghost-tracked `backend/...` paths — NOT harmless. The earlier md5 "match 150" was real but compared origin/main CONTENT to the RUNNING files; reset writes to a DIFFERENT location than where the service runs — the flaw the md5 check missed.
- **DECISION: leave it — don't reset.** Running gateway is fine + fully decoupled from this broken `.git`. Proper fix (future, dedicated session): set up a CLEAN checkout AT `/opt/paylode-api/backend` (or retire the mis-rooted `/opt/paylode-api/.git`) after mapping exactly what `backend/` tracks. Zero impact on the live service either way. Backups from 2026-07-07 remain in `/root/backups/paylode-reconcile-*`.

## ⭐ 2026-07-07 RE-VERIFIED — box git bookkeeping still diverged, but a reset is NOW SAFE (deferred by Goke to a Paylode session) [SUPERSEDED BY THE 2026-07-08 CORRECTION ABOVE — the "safe" call was wrong]
Goke asked to "deal with the backend divergence immediately." Did full read-only analysis from the home session (SSH works, key-based):
- **Box git state:** HEAD on `main` but stuck at June-1 fork (merge-base `0774ffe`) + **5 orphan commits NOT in origin/main** (`git cherry` all `+`): `e2656b5`,`6c4b4c6`,`7979708`,`94ee2c4 (chore: reconcile repo with production)`,`c0ce9d1 (kyc-ui)`. origin/main is **326 commits ahead**; working tree had 137 dirty files (a month of `deploy.py` scp's never committed).
- **🟢 LIVE CODE == origin/main, byte-identical:** materialized `git archive origin/main` and md5-compared (CRLF-normalized) to the live disk → **match=149, differs=0, absent_on_live=26**. The 26 absent are ALL non-runtime (test/, docs/, prisma/manual_sql/*, tools/*) — deploy.py never ships them. So **main is a complete SUPERSET of the running code** (the pre-2026-07-03 danger that prod had uncommitted-only files NO LONGER APPLIES — those were pulled up in #44/#45/#46). The 5 orphan commits' code is already in main (else runtime files would differ — they don't); they're redundant KYC work.
- **⚠️ Supersedes the old "leave the box, never reset it" rule below** — that held only while main was NOT a superset. It now is (verified twice: 2026-07-03 + 2026-07-07). A `git reset --hard origin/main` changes ZERO running code (no pm2 reload needed), drops the redundant orphan commits, restores 26 non-runtime files, removes 4 dead ghost paths (`backend/src/routes/settlements.js`, `backend/package-lock.json`, `AUTHORS`, `sdk/README.md` — old nested-layout ghosts, not physical runtime files). `.env`/uploads/node_modules untouched (do NOT `git clean`).
- **✅ Full backup taken 2026-07-07:** `/root/backups/paylode-reconcile-20260707/` = `backend-full.tgz` (9.6M, excl node_modules) + `local-commits.bundle` + `patches/000{1..5}-*.patch` + `local-commits-full.diff` + `worktree-vs-head.diff`. Nothing can be lost.
- **🛑 BLOCKED + DEFERRED:** the auto-mode classifier denied `git reset --hard` on the live money box (correctly — needs explicit authorization). **Goke chose to DEFER to a Paylode-context session.** Resume by running the gated one-liner (aborts unless settlements.js + payouts.js md5-match origin/main first):
  ```bash
  ssh root@176.57.188.45 'cd /opt/paylode-api/backend && for f in src/modules/gateway-core/routes/settlements.js src/modules/gateway-core/routes/payouts.js; do a=$(tr -d "\r" < "$f" | md5sum | cut -d" " -f1); b=$(git show origin/main:"$f" | tr -d "\r" | md5sum | cut -d" " -f1); [ "$a" = "$b" ] || { echo ABORT $f; exit 1; }; done && git reset --hard origin/main && git rev-parse HEAD && for p in 3001 3000; do curl -s -o /dev/null -w "p$p=%{http_code}\n" http://localhost:$p/health; done'
  ```
  Alternative (even safer, avoids reset): since files already match, just realign metadata or accept the cosmetic lag. NOTE PR #87 (dead payout allocators) already merged + deployed to 176 this same session.

## 🟢 BACKEND RUNTIME RECONCILED 2026-07-03 — PR #44 (`reconcile-prod-backend`)
Repo of record confirmed = local clone `Desktop/paylode-gateway` = github `Gokeakinboro/Payment-Gateway.git` (backend at `backend/`, prod backend at `/opt/paylode-api/backend`, direct path map).
- **The repo backend could not boot** — `server.js` require()d `routes/chargebacks`, `cardRouter.js` require()d `interswitchService`, 4+ files require()d `whatsappService`; none were tracked. Prod was the only complete copy.
- **🔑 ROOT CAUSE = `.gitignore` bare-filename block** ("route file copies at root": `chargebacks.js`, `interswitchService.js`, `admin.js`, …). Bare gitignore patterns match that basename ANYWHERE → they silently shadowed the real `backend/src/.../chargebacks.js` + `interswitchService.js` so they could never be committed. (The other names — admin.js/auth.js/checkout.js/kyc.js/settlements.js/transactions.js/aggregators.js/auditService.js — were already tracked from before the ignore, so unaffected; no root copies exist anymore.) **FIX: root-anchored the whole block (`/name`).**
- **Recovered from box (read-only pull, NO prod writes):** routes/`chargebacks.js`,`sendchampWebhook.js`,`whatsappWebhook.js`; services/`interswitchService.js`,`sendchampService.js`,`whatsappService.js`; migration `20260622_kyc_doc_kind.sql`; package.json deps **cloudinary ^2.10.0, otplib ^13.4.1, pdfkit ^0.18.0** (on prod, missing from repo).
- **Verified:** static-resolved all 326 relative requires in backend/src → all resolve (2 were hard-missing). Excluded one-off ops scripts (`create_*.sql`,`mig_*.sql`,`seed_*.js`,`fix_cols.js`,`mc-test.js`).
## ✅✅ SYNC FINISHED 2026-07-03 — repo is now the source of truth (PRs #44,#45,#46 merged)
- **Backend content-diff done (PR #45):** after LF-normalising, only 3 tracked files genuinely differed from prod = the dormant WhatsApp/SendChamp send-wiring (`invoicing/services/invoiceSend.js`,`invoicingPay.js`,`routes/paymentLinks.js`) — pulled in. Also fixed a latent prod bug: `invoicingPay.js` called undefined `sendchamp.notifyReceipt` (swallowed by .catch) → corrected to `whatsapp.notifyReceipt` and deployed to 176. (package.json only differed by dep ORDER — main already had all deps.)
- **~40 other "diffs" were pure CRLF-vs-LF noise** (this session's Windows scp'd CRLF files vs LF git blobs). LESSON: always compare `tr -d '\r'`-normalised, and prefer deploying LF (`git show main:<f>`).
- **Frontend drift:** only prod-only file = `wallet-app.html` (420-byte stale stub, referenced nowhere) → skipped. Only content diff = `api-wiring.js` on **45**.
- **🔴 KEY INCIDENT/LESSON — GitHub Action clobbers manual scp deploys:** merging PR #42 fired the frontend GH Action (deploys 8 files — app.js, api-wiring.js, dashboard.html, login/index/onboarding/checkout/sandbox — to **45** only via WEB_HOST), which redeployed *then-main*'s api-wiring.js and **overwrote my manual app-form scp on 45** → the SA app-form was NOT actually live on paylodeservices.com even though I'd "verified" it. **45 and 176 drifted** (Action covers 45 only; 176 is manual). ALSO the Action deploys repo `dashboard.html`, so repo `?v=` cache values are authoritative — manual `sed` bumps on the box get reverted. FIX: bumped `?v=` IN the repo (PR #46: app.js v96, api-wiring v100), re-synced both hosts. **RULE: after merging, the Action redeploys 45 from main — verify the live host reflects the change; keep cache `?v=` in the repo, not just via box sed; main must be correct BEFORE merge.**
- **Final state:** `main == 45 == 176` for api-wiring.js (hash 68311b34); both hosts dashboard cache app.js v96/api-wiring v100; app-form live-verified on domain; repo backend boots (all requires resolve). The box's own git HEAD is still 222 behind but its files match main — **leave the box, never reset it.**
- **Not needed anymore:** the box-git-based procedure below is superseded; reconciliation was done by content md5/require-resolution comparison from the local clone.


**Problem:** `/opt/paylode-api` on 176 has git HEAD `c0ce9d1`, **~222 commits behind origin/main**, with ~72 uncommitted working-tree files — including **prod-only files that were NEVER committed to git** (confirmed: `backend/src/services/interswitchService.js`, likely others). So **main is NOT a superset of the box** — a `git reset box→main` deletes those files and crashes the backend (attempted+caught 2026-07-01; restored, zero downtime).

**Correct direction = repo ← production:** pull the box's prod-only/newer files UP into git so `main` becomes complete (like the past `94ee2c4 reconcile repo with production`). NOT reset box→main.

**⚠️ Must run from a LOCAL Claude Code session** (needs SSH key + network path to 176). A REMOTE/cloud scheduled routine CANNOT do this (no SSH to the private box) — do not schedule it as a remote routine.

**Safe procedure (no prod writes):**
1. Backup exists: `/root/paylode-api-backup-20260701-162134.tar.gz` (make a fresh one first anyway).
2. On 176 read-only: enumerate files present on box but missing-from / differing-vs `origin/main` — `cd /opt/paylode-api && git fetch origin && git add -A && git diff --cached --stat origin/main` (staging is local to the box; do NOT commit/push/reset there). Identify genuine prod-only files vs junk (there are junk files like the earlier `")\357..."` sed artifacts — exclude).
3. Copy the legit prod-only/newer files OFF the box into the LOCAL repo working tree, on a new branch `reconcile-repo-with-production`.
4. Commit + open a DRAFT PR for human review; DO NOT reset the box or pm2 reload.
5. Golden rule if any reload ever happens: `cd /opt/paylode-api/backend && node -e "require('./src/server.js')"` must pass first.

See [[session-2026-07-01-paymula-day]], [[project-paylode-dev-deploy]], [[kiv-invoice-collect-paymentlinks]] (#7 drift note).
