# Paylode — CBN-licensed payment gateway (PSSP)

Nigerian payment gateway (Paylode Services). Products: payment
gateway/checkout, virtual accounts, invoicing, payouts, and **Billspay** — the
closed-loop member wallet (domain **billspay.net**; bills-payment to layer on
later). Repo: `Payment-Gateway`.

## Architecture
- **Backend**: Express monolith, single PrismaClient, Postgres. Self-contained
  modules under `backend/src/modules/{invoicing,wallet,assistant}` (own
  routes/services/`_shared`, own `inv_*`/`mw_*` tables). Checkout / virtual-
  accounts / core = loose routes. Entry `backend/src/server.js`.
- **Frontend**: static HTML/JS at repo root, served from `/var/www/paylode`.

## Where it runs / deploy
- **Backend → server 176** (176.57.188.45): `/opt/paylode-api/backend`, pm2 app
  `paylode-api` (cluster). Deploy = scp + `pm2 reload paylode-api`. Always
  `node -c` before reload.
- **Frontend → 45 (45.141.122.223) AND 176**: `/var/www/paylode`. Domains
  paylodeservices.com + billspay.net (Cloudflare in front).
- ⚠️ **A GitHub Action auto-deploys 8 frontend files to 45 on push to main**
  (app.js, api-wiring.js, dashboard.html, login/index/onboarding/checkout/
  sandbox.html) and **clobbers manual scp deploys to 45** — keep cache `?v=`
  values IN the repo's dashboard.html, and verify the live host after merging.

## Conventions / gotchas
- Branch off main → PR → merge (direct push to main is blocked by the classifier).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`;
  PR body ends: 🤖 Generated with [Claude Code](https://claude.com/claude-code).
- Prisma `$queryRawUnsafe` on uuid columns needs `::uuid` cast (else 42804/P2010).
- Compare box↔repo files LF-normalised (`tr -d '\r'`) — Windows scp adds CRLF.
- SSH to 176/45 is key-based (BatchMode works).

## File output — where Claude's deliverables go
**HARD RULE (Goke, 2026-09-15): every file Claude produces for Goke to download goes
inside a `CLAUDE` folder — NEVER loose on the Desktop.**
- **Local sessions** (Goke's machine, Windows, user `Goke`): write deliverables to
  `C:\Users\Goke\Desktop\CLAUDE\` — create the folder if it doesn't exist.
  Never write a deliverable straight to `C:\Users\Goke\Desktop\`.
- **Remote / web sessions**: there is no desktop in the container. Write deliverables
  to a `CLAUDE/` subfolder of the session scratchpad before handing them over, so the
  folder convention and filename carry across.
- **Applies to** anything handed to Goke rather than committed: generated PDFs, XLSX,
  DOCX, PNGs, reports, filled forms, exports, screenshots. Files that belong to the
  repo still go in their proper repo paths — this rule is about deliverables only.
- **Limit to state, don't work around:** the browser/desktop-app *download* location
  is a machine-side setting Claude cannot change from a remote session. If a file
  lands on the Desktop because of that setting, say so and point at the setting —
  don't silently save somewhere else instead.

## Shared project memory
Detailed context lives in `.claude/memory/` (checked into this repo).
Start at `.claude/memory/MEMORY.md` — it indexes every memory file.
Resume point: `kiv-backlog-index`.

Four credential-reference files are NOT in git (blocked by `.claude/memory/.gitignore`).
New collaborators must obtain these separately from the project owner:
- `reference-parallex-portal-creds.md`
- `reference-meta-facebook-app-creds.md`
- `reference-demo-test-account.md`
- `reference-gokeakinboro-account.md`
