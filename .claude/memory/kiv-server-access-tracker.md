---
name: kiv-server-access-tracker
description: KIV (2026-07-05, cross-cutting) — audit tracker for who accesses/acts on the servers (incl. Claude), and Claude to use one consistent unique identity/ID across all products
metadata:
  node_type: memory
  type: project
---

✅ **DONE + LIVE on Paylode 176 + 45 (2026-07-05)** — PR #66, reusable script `tools/setup-access-tracker.sh` (idempotent, `sudo bash setup-access-tracker.sh`).
- **Dedicated `claude` sudo user** on both boxes (uid 1000, `sudo` group, NOPASSWD; reuses root's authorized_keys) → automated agent actions attributable vs human `root`. Verified: `claude` sudo→root works.
- **auditd** active on both: logs logins, every command (`execve`, key `cmd`), sudo/su, and edits to sudoers/sshd_config/authorized_keys. Verified 242+ `key=cmd` entries; `auid` set (sessions attributable). Hardened for 45's stale `ondrej/php` PPA (`--allow-releaseinfo-change`).
- **Query:** `ausearch -k cmd | aureport -x --summary` (cmds by exe); `ausearch -m USER_LOGIN --start today` (logins); `ausearch -k cmd --uid claude` (agent actions). NOTE: `ausearch --start recent` can miss due to server TZ = Europe/Berlin — query without a time filter or use explicit dates.
- ✅ **ROLLOUT COMPLETE 2026-07-05.** `claude@176`/`claude@45` allow-rules added + login proven (all this session's deploys ran as `claude`). **All products are co-hosted on 176 + 45**, and auditd is HOST-LEVEL, so the two boxes we set up cover the whole fleet — no separate servers exist:
  - **176:** paylode-* (core/invoicing/wallet/assistant + workers), `golf-platform` (/opt/golf-platform ×2), `da-backend` (/opt/drinks-arena). **CDL** → user says CDL is on 176, but there's currently **no cdl/ussd pm2 process or /opt dir** (not deployed/running in an obvious form) — host auditd covers it whenever it runs.
  - **45:** `da-frontend`, `lssb-*` (DB/api/lasrra-proxy/static), `themarket` (biz9ja), `paylode-chat`.
  - **81.0.246.58 = the CDL / Airtel-USSD server** (SEPARATE box, Ubuntu 24.04) — tracker installed 2026-07-05 (claude sudo user + auditd active). root SSH works with the same key; **no `claude@81.0.246.58` allow-rule yet** — add one for future CDL work as the audited user (belongs in the CDL silo).
  - All three boxes: auditd active + `claude` sudo user. → Paylode, DrinksArena, biz9ja/themarket, LSSB, paylode-chat, **CDL** all audited.
- **ONLY remaining:** user to **retire the `root@host` allow-rules** (optional cleanup; settings.json edit — Claude can't self-widen/narrow; claude@ snippet given). Keep root@ as fallback if preferred.

_Original ask (now delivered for Paylode):_
🟡 (2026-07-05, **cross-cutting** — applies to all product servers). Two related asks:

1. **Server-access / action tracker** — log **who** logs into and acts on the servers (176 / 45, and other product boxes) and **what they did**: an audit trail of SSH sessions + commands, including automated agents like Claude. Options to weigh: `auditd`, shell command logging via `PROMPT_COMMAND`/`~/.bash_history` shipping, per-actor SSH users/keys so `root` actions become attributable, and/or a central access log.

2. **Claude uses ONE consistent unique ID across all products** — so anything Claude does (git commits, deploys, SSH sessions) is attributable to a single stable identity across Paylode / CDL-Airtel USSD / DrinksArena / biz9ja / LSSB. Today Claude SSHes as `root` (indistinguishable from the user) and only tags commits with the `Co-Authored-By` trailer. Idea: a dedicated `claude` SSH user + key, plus a standard actor tag surfaced in the access log and commits.

Tracked in the Paylode silo for now but genuinely cross-cutting. Relates to [[project-paylode-dev-deploy]] (deploy/SSH mechanics).
