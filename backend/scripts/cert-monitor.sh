#!/bin/bash
# cert-monitor.sh — Check SSL cert expiry, renew via certbot, send alerts
# Install: /usr/local/bin/cert-monitor.sh (chmod 750, owned root)
# Cron:    0 7 * * * /usr/local/bin/cert-monitor.sh >> /var/log/cert-monitor.log 2>&1
set -euo pipefail

SERVER_ID="${CERT_MONITOR_SERVER:-$(hostname)}"
LOG=/var/log/cert-monitor.log
WARN_DAYS=14
ALERT_URL="${CERT_ALERT_URL:-http://127.0.0.1:3000/api/internal/system/cert-alert}"
INTERNAL_KEY=""

# Read internal key from backend .env if it exists
for env_file in /opt/paylode-api/backend/.env /opt/paylode-api/.env; do
  if [ -f "$env_file" ]; then
    INTERNAL_KEY=$(grep '^GOLF_PLATFORM_INTERNAL_KEY=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '"'"'" | head -1)
    [ -n "$INTERNAL_KEY" ] && break
  fi
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

send_alert() {
  local domain="$1" status="$2" days="$3" msg="$4"
  [ -z "$INTERNAL_KEY" ] && { log "WARN: No internal key — skipping alert for $domain"; return; }
  curl -sf -X POST "$ALERT_URL" \
    -H "Content-Type: application/json" \
    -H "x-internal-key: $INTERNAL_KEY" \
    -d "{\"server\":\"$SERVER_ID\",\"domain\":\"$domain\",\"status\":\"$status\",\"daysLeft\":$days,\"message\":\"$msg\"}" \
    >/dev/null 2>&1 && log "Alert sent for $domain ($status)" || log "WARN: Alert POST failed for $domain"
}

log "=== cert-monitor start ==="

# 1. Run certbot renew (handles all certbot-managed certs automatically)
log "Running certbot renew..."
certbot renew --quiet --deploy-hook '/usr/local/bin/cert-monitor-deploy.sh' 2>&1 || log "WARN: certbot renew exited non-zero"

# 2. Scan nginx configs for non-certbot certs (manual/migrated)
log "Scanning nginx for non-certbot certs..."
non_le=$(grep -rh 'ssl_certificate ' /etc/nginx/sites-enabled/ 2>/dev/null \
  | grep -v '/etc/letsencrypt/' | grep -v '^#' | awk '{print $2}' | tr -d ';' | sort -u)
if [ -n "$non_le" ]; then
  log "NON-CERTBOT CERTS FOUND — action required:"
  for cert_path in $non_le; do
    log "  $cert_path"
    expiry=$(openssl x509 -in "$cert_path" -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -n "$expiry" ]; then
      expiry_epoch=$(date -d "$expiry" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$expiry" +%s 2>/dev/null)
      days=$(( (expiry_epoch - $(date +%s)) / 86400 ))
      log "  Expires in $days days ($expiry)"
      if [ "$days" -lt "$WARN_DAYS" ]; then
        send_alert "$cert_path" "manual-cert-expiring" "$days" "Non-certbot cert found in nginx — issue a LE cert and update the vhost."
      fi
    fi
  done
fi

# 3. Check all certbot-managed certs for expiry (belt-and-braces)
log "Checking certbot cert expiry..."
certbot certificates 2>&1 | grep -E 'Domains:|Expiry Date:' | paste - - | while IFS= read -r line; do
  domain=$(echo "$line" | grep -oP 'Domains:\s*\K\S+')
  expiry_str=$(echo "$line" | grep -oP 'Expiry Date:\s*\K[^\(]+' | xargs)
  invalid=$(echo "$line" | grep -c 'INVALID' || true)
  if [ -n "$expiry_str" ]; then
    expiry_epoch=$(date -d "$expiry_str" +%s 2>/dev/null || true)
    [ -z "$expiry_epoch" ] && continue
    days=$(( (expiry_epoch - $(date +%s)) / 86400 ))
    if [ "$days" -lt "$WARN_DAYS" ] || [ "$invalid" -gt 0 ]; then
      log "ALERT: $domain cert expires in $days days"
      send_alert "$domain" "expiring-soon" "$days" "certbot renew was run but cert is still near expiry. Manual investigation needed."
    fi
  fi
done

log "=== cert-monitor done ==="
