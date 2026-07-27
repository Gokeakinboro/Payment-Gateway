---
name: session-2026-07-01-paymula-day
description: "Session 2026-07-01 — big build day — UI polish, single login, QR fix+merger, portal assistant, Paymula member app (full), member lifecycle, multi-line invoices; all merged to main; 176 backend git drift flagged"
metadata: 
  node_type: memory
  type: project
  originSessionId: 610c646d-1fbf-4f5b-bc7b-05e1192617b6
---

# Session 2026-07-01 — summary

Everything below is **DEPLOYED (45 web + 176 backend) and MERGED to main** (PRs #25–#36; main == repo of record; 0 open PRs at end). Prod healthy (6 paylode-api workers, endpoints 200).

## Shipped
- **Bolder box borders** across all portal pages (2px #cbd5e1) — PR #25.
- **Single login** — removed the cosmetic role-picker on index.html + login.html; generic Paylode header; role resolved from credentials — PR #26.
- **QR 500 fix** — `::uuid` cast on inv_qr_codes + inv_invoices INSERTs (P2010/42804) — PR #27. See [[reference-raw-sql-uuid-cast-bug]].
- **Payment Links & QR merged** into one tabbed dashboard page; QR create/show/share (Email via **SMTP** not mailto, WhatsApp via wa.me)/download/delete; removed QR tab from invoicing.html — PRs #28, #33-ish.
- **Portal Assistant** — role-aware in-dashboard help bot + public login/onboarding helper; `/api/v1/assistant/chat` + `/public-chat`; cached KB — PR #29. See [[project-paylode-portal-assistant]].
- **Demo/test account** test@test.com / test1234 — login-only, transactions blocked. See [[reference-demo-test-account]].
- **PAYMULA (member app)** — see [[project-paymula-member-app]]: rebrand Wallet→Paymula (+install prompt PR #30), copy sweep + merchant public-member opt-in (PR #34-adjacent), public club directory (#31), self-registration + KYC verify (#32/#33), member lifecycle suspend/deactivate/delete (#34), **multi-club membership + in-app switcher (#36)**. Smoke-tested E2E (2 clubs, X-Member-Id switch).
- **Multi-line-item invoices** (sub-amounts totalled) — PR #35.

## ⚠️ 176 backend git DRIFT (reconcile later, carefully)
`/opt/paylode-api` git HEAD = `c0ce9d1`, **222 commits behind origin/main**; the entire invoicing + wallet modules exist only as **uncommitted working-tree changes** (historical — deployed by scp, never committed on the box). **The RUNNING code is current** (I scp'd main's versions for everything touched). Frontend `/var/www/paylode` on 45+176 is scp-managed and current. **Risk:** a `git pull`/git-based deploy on the box could clobber.

⛔ **RECONCILE ATTEMPTED 2026-07-01 — ABORTED (do NOT reset box→main):** backed up (`/root/paylode-api-backup-20260701-162134.tar.gz`, 8.2M, source+.env), then `git stash -u` + `git reset --hard origin/main` — **verified BEFORE reload** and caught `Cannot find module './interswitchService'`. **main is NOT a superset** — prod-only files (e.g. `backend/src/services/interswitchService.js`, and likely others) exist ONLY on the box, never committed. Restored via `git reset --hard c0ce9d1 && git stash pop` — interswitchService back, modules load, 6 workers online, endpoints 200. **Prod never reloaded → zero downtime.** LESSON: reconcile direction must be **repo ← production** (commit the box's prod-only files UP into git so main becomes complete — like the past `94ee2c4 reconcile repo with production`), NOT reset box→main. Until then leave the box's git as-is (running code is correct); just never run a git-based pull/deploy on it. Always verify `node -e require(server.js)` before any pm2 reload.

## Open KIV / follow-ups
- [[kiv-guidde-portal-videos]] — Guidde how-to videos (research API next).
- [[kiv-portal-assistant-kb-gaps]] — ⟨CONFIRM⟩ facts (fees, settlement cycle, limits…).
- Paymula: **encrypt NIN/BVN at rest** (stored raw); **PIN is per-membership** → prompt PIN setup on newly joined clubs; **member "join another club"** authed flow (self-reg blocks existing email); register **happy-path controlled test** with a real NIN/BVN (user said set up later).
- [[project-parallex-integration]] — still blocked (portal activation); new pw Olatomide@1234@ retried, still no session.
- app.js nav "Member Wallet" label → rename to Paymula (now safe post-reconcile).
