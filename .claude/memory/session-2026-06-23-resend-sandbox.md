---
name: session-2026-06-23-resend-sandbox
description: Session 2026-06-23 — shipped SA resend-sandbox feature; caught & deleted a stale local checkout; documented deploy topology in-repo
metadata: 
  node_type: memory
  type: project
  originSessionId: 018c26fc-7a85-4657-9d96-209516c7b73e
---

# Session 2026-06-23 — Resend Sandbox + stale-checkout cleanup

Relates to [[project-paylode-dev-deploy]], [[project-paylode]]. Author env: Paylode gateway, repo `Gokeakinboro/Payment-Gateway`.

## What shipped (all live + verified)
1. **`POST /api/v1/merchants/:id/resend-sandbox`** (SA/admin/compliance) — re-mails sandbox credentials to an existing merchant: ensures active `sk_test`/`pk_test` keys (mints missing; `rotate:true` forces fresh), optional temp-password reset (default ON, `mustChangePassword`), emails sandbox access; only freshly-issued keys revealed (stored = hashes). Audit `MERCHANT_SANDBOX_RESENT`.
2. **Frontend** — "✉ Resend Sandbox" button on merchant detail modal (`api-wiring.js`, `resendSandbox()`); shows temp pw + new keys once. Cache-bust `api-wiring.js?v=82→v83` in `dashboard.html`.
3. **`docs/DEPLOYMENT.md`** — deploy topology + commands committed in-repo (no secrets).

## Commits (on `main`)
- `64d240e` feat(merchants): SA/admin resend sandbox credentials + button
- `58fb2b2` docs: deployment & server topology
(Both pushed via `git push origin feat/sa-resend-sandbox:main`; main fast-forwarded f23fdb1→58fb2b2.)

## Deploy done this session
- Backend → **176.57.188.45** via `tools/deploy.py` (36 files, syntax+git-clean gate, md5-verified, backup `/root/deploy-backup-20260623-094838`). Then `pm2 reload paylode-api` → online, health **200**, route present.
- Frontend → **45.141.122.223** (the LIVE web server) via `PAYLODE_HOST=45.141.122.223 … deploy.py --frontend` (5 files, md5-verified, backup `…095556`). Verified `resendSandbox` + `v83` on 45, site 200. Same root SSH pw on both boxes.

## KEY LESSON — stale checkout
`C:\Users\Goke\Desktop\Paylode\paylode-full` was a clone **~90 commits behind `origin/main`** (local `aaf10d7` vs prod `f23fdb1`). I first rebuilt a feature (sandbox-on-signup → auto-flip-to-live) that **already existed in prod** (`cd9aa33`/`fd79d20`/`9bde5d4`) before a rejected `git push` exposed the drift. Recovered by building the real feature against `origin/main` in a throwaway worktree. **Always `git fetch` + check `git log origin/main` before trusting a local Paylode tree.**

## Cleanup
- Removed the worktree (`git worktree prune` + PowerShell rm — bash had a cwd lock).
- **Deleted the stale `paylode-full` folder.** No local Paylode checkout remains — `git clone` fresh when needed.

## Open / not done
- Prod already had sandbox-on-signup + auto-flip-to-live — do NOT rebuild.
- No functional end-to-end test of resend-sandbox against a real merchant (deploy + presence verified only).
