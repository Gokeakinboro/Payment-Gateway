# Paylode — Deployment & Server Topology

> Operational reference for shipping the gateway. **No secrets live in this file.**
> The deploy SSH password is supplied at runtime via the `PAYLODE_SSH_PASS`
> environment variable and is never committed.

## Server topology

| Server | IP | Role | Serves |
| --- | --- | --- | --- |
| **Backend / DB / processing** | `176.57.188.45` | Not internet-facing for web; hosts the API | `paylode-api` (PM2, port 3000) → `api.paylodeservices.com`; PostgreSQL; Redis; webhook worker. Backend code at `/opt/paylode-api/backend`. |
| **Web (live frontend)** | `45.141.122.223` | Internet-facing nginx | Static site `/var/www/paylode` → `paylodeservices.com`, with `/api` reverse-proxied to `176:3000`. |

**Consequence for deploys:**

- A **backend change** ships to **176** (then reload PM2).
- A **frontend change** (`app.js`, `api-wiring.js`, `dashboard.html`, `onboarding.html`,
  `sandbox.html`, `index.html`, `login.html`, `checkout.html`) **must ship to 45** —
  that is the box users actually load. Deploying frontend only to 176 does **not**
  reach users.

## Deploy tool: `tools/deploy.py`

Binary SFTP deploy (paramiko) with safety rails:

1. **Syntax gate** — runs `tools/check-syntax.mjs`; aborts the whole deploy on any parse error.
2. **Git-clean gate** — refuses to ship files with uncommitted changes (so the repo is a
   faithful record of prod). Override with `--allow-dirty` only when you know why.
3. **Backup** — copies every remote file it is about to overwrite into
   `/root/deploy-backup-<timestamp>/` (rollback path).
4. **md5 verify** — confirms `md5(local) == md5(remote)` after each upload.

The local→remote file list is the `MANIFEST` in `tools/deploy.py`. **Keep it in sync with
what actually ships** — a new backend route file or frontend asset must be added there.

### Backend deploy (target = 176, the default)

```bash
PAYLODE_SSH_PASS='…' python tools/deploy.py
```

`deploy.py` does **not** restart the API. After a backend change, reload PM2 and health-check:

```bash
# over SSH on 176:
pm2 reload paylode-api --update-env
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health   # expect 200
```

Run `npx prisma generate` (and a migration) on 176 **only** if `schema.prisma` changed.

### Frontend deploy (target = 45, the live web server)

```bash
PAYLODE_HOST='45.141.122.223' PAYLODE_SSH_PASS='…' python tools/deploy.py --frontend
```

`--frontend` filters the manifest to `/var/www/*` targets. No restart needed (nginx serves
static files). **Bump the cache-bust query** (`?v=NN` on `app.js` / `api-wiring.js` in
`dashboard.html`) for any frontend JS change so browsers and the Cloudflare edge pick it up.

> **A push to `main` auto-deploys the frontend to users.** The GitHub Action
> (`.github/workflows/deploy.yml`) deploys **frontend only** to **both** boxes:
> - **45 (live web)** — files are `scp`'d straight from the runner to `/var/www/paylode`
>   (45 has no git checkout), then nginx is reloaded. This is what users hit.
> - **176 (fallback origin)** — `git checkout`s the static files from `origin/main` to its
>   web root (runs even if the 45 step fails, so the failover never goes stale).
>
> It does **not** pull backend source — backend always goes through `deploy.py`.
> Secrets used: `WEB_HOST` (45), `SERVER_HOST` (176), `SERVER_USER`, `SERVER_SSH_KEY`
> (a dedicated `github-actions-deploy-paylode` ed25519 key trusted on both boxes),
> `DEPLOY_PATH`. So the manual `--frontend` deploy above is now only a fallback —
> a normal push reaches the live site on its own.

## Rollback

Each deploy leaves a timestamped backup on the target server at
`/root/deploy-backup-<timestamp>/` containing the previous version of every file it
overwrote. To roll back, copy those files back to their manifest paths and (for backend)
`pm2 reload paylode-api`.

## Prerequisites (local)

- Python 3 + `paramiko` (`pip install paramiko`).
- Node (for the syntax gate).
- `PAYLODE_SSH_PASS` set in the environment for the run (never commit it).

---

## Split-services topology (P3 modularity re-arch)

The backend can run either as the **monolith** (`src/server.js` = `paylode-api`, all
modules in one process — still fully supported, the safe fallback) or as **split
services** from the same codebase:

| PM2 app | Entry | Port | Mounts |
| --- | --- | --- | --- |
| `paylode-core` | `src/entrypoints/core.js` | 3001 | money core + all non-product routes; runs the rail-float + payout-recon jobs |
| `paylode-invoicing` | `src/entrypoints/invoicing.js` | 3101 | `/api/v1/invoicing` only |
| `paylode-wallet` | `src/entrypoints/wallet.js` | 3102 | `/api/v1/wallet` only |
| `paylode-assistant` | `src/entrypoints/assistant.js` | 3103 | `/api/v1/assistant` only |

An **nginx router on 176** (`nginx/paylode-176-router.conf`, listens `:3000`)
path-routes each product to its service and everything else to core. Because it keeps
`:3000` and every public path identical, **45 and the frontend/SDKs need no changes**.

### Why: independent deploys
Upgrade one product without touching the gateway:
```bash
# on 176, after deploy.py has shipped the new code:
pm2 reload paylode-invoicing        # core + wallet + assistant keep running
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3101/health   # expect 200
```

### One-time cutover on 176 (staged, user-run)
```bash
cd /opt/paylode-api/backend
npx prisma generate                         # if schema changed
pm2 start ecosystem.config.js               # starts core + 3 product svcs + workers
cp /opt/paylode-api/nginx/paylode-176-router.conf /etc/nginx/conf.d/paylode-router.conf
nginx -t && systemctl reload nginx          # router now owns :3000
pm2 delete paylode-api                       # stop the old monolith on :3000
pm2 save
# verify: /health on 3001/3101/3102/3103 all 200, and the public domain still works
```

### Rollback to monolith (instant)
```bash
rm /etc/nginx/conf.d/paylode-router.conf && systemctl reload nginx
pm2 delete paylode-core paylode-invoicing paylode-wallet paylode-assistant
pm2 start src/server.js --name paylode-api -i max   # monolith back on :3000
pm2 save
```

### Independence guarantee
Stopping a product service returns 503 **only** for that product's paths; the money
core (checkout / VA / payouts / settlement) keeps serving. Verified locally by
`tools/p3-split-check.js` (clean module partition) and enforced at runtime by the
guarded registry (`tools/guard-selftest.js`).

> **deploy.py note:** the backend manifest is now **walked** (`backend/src/**/*.js`
> + prisma + `ecosystem.config.js`), not an explicit list — a moved/added file can
> never be silently dropped. It also `mkdir -p`s new remote dirs. Run
> `npm run verify:arch` before every deploy of this re-arch.
