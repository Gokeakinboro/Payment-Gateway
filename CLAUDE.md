# Paylode — CBN-licensed payment gateway (PSSP)

Nigerian payment gateway (EagleCrest Premium Services Ltd). Products: payment
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

Detailed project memory lives in this repo's Claude namespace — start at
`MEMORY.md` (resume point: `kiv-backlog-index`).
