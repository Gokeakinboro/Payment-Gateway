#!/bin/bash
# certbot --deploy-hook: fires once per renewed cert with $RENEWED_DOMAINS and $RENEWED_LINEAGE
# Reloads nginx and sends a "renewed" alert.
SERVER_ID="${CERT_MONITOR_SERVER:-$(hostname)}"
ALERT_URL="${CERT_ALERT_URL:-http://127.0.0.1:3000/api/internal/system/cert-alert}"
INTERNAL_KEY=""

for env_file in /opt/paylode-api/backend/.env /opt/paylode-api/.env; do
  if [ -f "$env_file" ]; then
    INTERNAL_KEY=$(grep '^GOLF_PLATFORM_INTERNAL_KEY=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '"'"'" | head -1)
    [ -n "$INTERNAL_KEY" ] && break
  fi
done

systemctl reload nginx 2>/dev/null || true

domain="${RENEWED_DOMAINS%% *}"
expiry=$(openssl x509 -in "$RENEWED_LINEAGE/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2)
expiry_epoch=$(date -d "$expiry" +%s 2>/dev/null || true)
days=$(( (expiry_epoch - $(date +%s)) / 86400 ))

[ -n "$INTERNAL_KEY" ] && curl -sf -X POST "$ALERT_URL" \
  -H "Content-Type: application/json" \
  -H "x-internal-key: $INTERNAL_KEY" \
  -d "{\"server\":\"$SERVER_ID\",\"domain\":\"$domain\",\"status\":\"renewed\",\"daysLeft\":$days,\"message\":\"Certificate successfully renewed. Nginx reloaded.\"}" \
  >/dev/null 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Renewed $domain (valid $days days) and reloaded nginx" >> /var/log/cert-monitor.log
