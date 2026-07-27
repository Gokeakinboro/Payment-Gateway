---
name: kiv-paymula-followups
description: "KIV — Paymula member-app follow-ups after the 2026-07-01 build (encrypt PII, per-club PIN, join-another-club, nav rename, happy-path KYC test)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 610c646d-1fbf-4f5b-bc7b-05e1192617b6
---

🟡 **KIV — Paymula/Billspay follow-ups** (core P0–P3 shipped 2026-07-01, see [[project-paymula-member-app]]). **RENAMED Paymula → Billspay 2026-07-03, DEPLOYED to prod (45+176).** Open items:

**✅ DONE 2026-07-03 — Rebrand Paymula → Billspay (LIVE):** replaced brand string across `wallet.html`/`wallet-admin.html`/`wallet-sa.html`, `manifest.webmanifest` (PWA name+short_name), `app.js` nav label (was "Member Wallet"→ now "Billspay", closes item 4 below), backend `wallet/routes/me.js` branding fallback ('Wallet'→'Billspay'), `assistant/portal-help-kb.md`. Deployed frontend→45+176 `/var/www/paylode` (app.js `?v=95→96`), backend→176 `/opt/paylode-api/backend` + `pm2 reload`. Backups `_bak/billspay-<ts>/` on each server. **Strategy: layer bills-payment onto Billspay later** (hence the name). Left internal `mw_*` tables + `wallet/` module folder as-is (not user-facing). NEW follow-ups: **Billspay logo + PWA icon set** (still Paylode marks).

**🟢 billspay.net DNS — IN PROGRESS 2026-07-03:** decisions — serve the **Billspay member app at root** (wallet.html); DNS via **user's Cloudflare API token**. Repo rebrand committed as **PR #42** (`billspay-rebrand`). **Origin READY on 45**: nginx vhost `/etc/nginx/sites-available/billspay` (symlinked enabled) — `server_name billspay.net www.billspay.net`, root `/var/www/paylode` → `try_files … /wallet.html`, proxies `/api/` → `176:3000`, reuses cert `/etc/ssl/migrated/paylode-*` (fine under Cloudflare "Full"). Verified via `--resolve` SNI: root=`<title>Billspay</title>`, /health=`billspay-ok-45`, /api proxied. Member app is token-auth same-origin (`var API='/api/v1'`) so no cross-domain cookie issue. **✅ LIVE 2026-07-03:** user set SSL mode = **Full** in dashboard; created (via CF API token) proxied A records `billspay.net`→`45.141.122.223` + `www.billspay.net`→same. Verified over HTTPS: `https://billspay.net/` serves `<title>Billspay</title>`, `/health`=`billspay-ok-45`, manifest name=Billspay, valid CF edge TLS. Members can go straight to **billspay.net**. (Token was single-use; user can delete it in Cloudflare.) **Remaining:** Billspay logo + PWA icon set (still Paylode marks); PR #42 (rebrand) still to merge.

1. **Encrypt NIN/BVN at rest** — `mw_members.nin/bvn` currently stored RAW (capture+verify done). Encrypt at app layer (like merchant settlement account) + avoid logging.
2. **PIN is per-membership** (`mw_members.pin_hash`) — with multi-club, prompt PIN setup when a member opens a newly joined club that has no PIN yet; and make unlock/spend use the ACTIVE membership's PIN. Currently only the first-active club's PIN is set on load.
3. **"Join another club" (authed)** — self-registration (`POST /wallet/public/register`) blocks an existing email (EMAIL_EXISTS). Need an authenticated flow for a logged-in member to join an additional opted-in club (adds an mw_members row for the same user — UNIQUE already dropped). Then the switcher shows it.
4. ✅ **DONE (2026-07-03)** — app.js merchant nav label → "Billspay" (deployed; see rebrand note above).
5. **Register happy-path controlled test** — exercise `POST /wallet/public/register` with a REAL NIN/BVN (creates account + a real YouVerify charge). User said "set up a controlled test later."
6. **brand_color on public /clubs + switcher** — surfaced but not yet themed in the picker/switcher UI (nice-to-have).

Related open KIVs: [[kiv-portal-assistant-kb-gaps]] (⟨CONFIRM⟩ facts), [[kiv-guidde-portal-videos]], [[kiv-server-repo-reconciliation]].
