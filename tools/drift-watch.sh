#!/usr/bin/env bash
# Paylode server drift watcher — runs ON the server via cron (hourly), independent
# of who/how a deploy happened. Treats the git repo as the source of truth:
#   1. git pull the repo (desired state).
#   2. Compare each deployed file to the repo (CRLF-normalized so line endings
#      never false-alarm; only real content differences count).
#   3. On drift: back up the divergent server copy, RESTORE the repo version
#      (auto-heal), log it, and email product@paylodeservices.com.
# Healthy run = completely silent (no email). Self-heals the "stale file pushed
# outside the pipeline" problem within the cron interval.
#
# Install: see the block at the bottom. Override behaviour with env vars.
set -uo pipefail

REPO="${DRIFT_REPO:-/opt/paylode-monitor/repo}"
BACKUPS="${DRIFT_BACKUPS:-/opt/paylode-monitor/drift-backups}"
LOG="${DRIFT_LOG:-/var/log/paylode-drift.log}"
BACKEND="${DRIFT_BACKEND:-/opt/paylode-api/backend}"
ALERT_TO="${DRIFT_ALERT_TO:-product@paylodeservices.com}"
HEAL="${DRIFT_HEAL:-1}"   # 1 = auto-heal (restore from repo); 0 = alert only

# repo-relative path | deployed absolute path  (keep in sync with tools/deploy.py)
MANIFEST="
app.js|/var/www/paylode/app.js
api-wiring.js|/var/www/paylode/api-wiring.js
dashboard.html|/var/www/paylode/dashboard.html
onboarding.html|/var/www/paylode/onboarding.html
backend/src/routes/onboarding.js|/opt/paylode-api/backend/src/routes/onboarding.js
backend/src/routes/deferrals.js|/opt/paylode-api/backend/src/routes/deferrals.js
backend/src/routes/documents.js|/opt/paylode-api/backend/src/routes/documents.js
backend/src/routes/users.js|/opt/paylode-api/backend/src/routes/users.js
backend/src/routes/aggregators.js|/opt/paylode-api/backend/src/routes/aggregators.js
backend/src/routes/auth.js|/opt/paylode-api/backend/src/routes/auth.js
backend/src/routes/transactions.js|/opt/paylode-api/backend/src/routes/transactions.js
backend/src/middleware/auth.js|/opt/paylode-api/backend/src/middleware/auth.js
backend/src/services/deferralExpiryService.js|/opt/paylode-api/backend/src/services/deferralExpiryService.js
backend/src/services/emailService.js|/opt/paylode-api/backend/src/services/emailService.js
backend/src/server.js|/opt/paylode-api/backend/src/server.js
backend/prisma/schema.prisma|/opt/paylode-api/backend/prisma/schema.prisma
"

ts(){ date '+%Y-%m-%d %H:%M:%S'; }
log(){ echo "[$(ts)] $*" >> "$LOG"; }
norm_md5(){ tr -d '\r' < "$1" | md5sum | cut -d' ' -f1; }

mkdir -p "$BACKUPS"
git -C "$REPO" pull --ff-only --quiet 2>>"$LOG" || log "WARN: git pull failed (using last-known repo state)"

drift=""
while IFS='|' read -r rel dep; do
  [ -z "${rel// /}" ] && continue
  src="$REPO/$rel"
  if [ ! -f "$src" ]; then log "WARN: repo missing $rel"; continue; fi
  if [ ! -f "$dep" ]; then
    drift="${drift}  MISSING  ${dep}"$'\n'
    if [ "$HEAL" = "1" ]; then mkdir -p "$(dirname "$dep")"; cp "$src" "$dep" && log "HEALED (created) $dep"; fi
    continue
  fi
  if [ "$(norm_md5 "$dep")" != "$(norm_md5 "$src")" ]; then
    drift="${drift}  DRIFT    ${dep}"$'\n'
    if [ "$HEAL" = "1" ]; then
      bdir="$BACKUPS/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$bdir"
      cp -p "$dep" "$bdir/$(basename "$dep").server-copy" 2>/dev/null
      cp "$src" "$dep" && log "HEALED (restored from repo) $dep  [pre-heal server copy: $bdir]"
    fi
  fi
done <<< "$MANIFEST"

if [ -n "$drift" ]; then
  mode=$([ "$HEAL" = "1" ] && echo "auto-healed" || echo "ALERT-ONLY")
  log "DRIFT DETECTED ($mode):"$'\n'"$drift"
  export DRIFT_MSG="Paylode server drift on $(hostname) at $(ts) [$mode]:"$'\n'"$drift"$'\n'"Files restored from git repo HEAD; pre-heal server copies saved under $BACKUPS. Investigate what deployed outside the pipeline."
  export DRIFT_TO="$ALERT_TO"
  ( cd "$BACKEND" && node -r dotenv/config -e '
      const { sendEmail } = require("./src/services/emailService");
      const esc = s => String(s||"").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
      sendEmail({ to: process.env.DRIFT_TO, subject: "[Paylode] Server drift detected", html: "<pre>"+esc(process.env.DRIFT_MSG)+"</pre>" })
        .then(()=>process.exit(0)).catch(()=>process.exit(0));
    ' 2>>"$LOG" ) || log "WARN: alert email failed"
fi
exit 0

# ── Install (run once on 176.57.188.45) ──────────────────────────────────────
#   mkdir -p /opt/paylode-monitor
#   git clone https://github.com/Gokeakinboro/Payment-Gateway.git /opt/paylode-monitor/repo
#   chmod +x /opt/paylode-monitor/repo/tools/drift-watch.sh
#   touch /var/log/paylode-drift.log
#   ( crontab -l 2>/dev/null; echo "0 * * * * /opt/paylode-monitor/repo/tools/drift-watch.sh >/dev/null 2>&1" ) | crontab -
# Alert-only instead of heal:  set DRIFT_HEAL=0 in the cron line.
