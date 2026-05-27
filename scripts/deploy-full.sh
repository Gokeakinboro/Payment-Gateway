#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Paylode Services Limited — Full Stack Production Deploy
# Contabo Ubuntu VPS + Cloudflare
# Run as root: bash deploy-full.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'

REPO="https://github.com/Gokeakinboro/Payment-Gateway.git"
APP_DIR="/var/www/paylode"
API_DIR="/opt/paylode-api"
DB_NAME="paylode_db"
DB_USER="paylode"
DB_PASS="${DB_PASS:-$(openssl rand -hex 16)}"
NODE_PORT=3000

log() { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

echo -e "${GREEN}"
echo "  ██████╗  █████╗ ██╗   ██╗██╗      ██████╗ ██████╗ ███████╗"
echo "  ██╔══██╗██╔══██╗╚██╗ ██╔╝██║     ██╔═══██╗██╔══██╗██╔════╝"
echo "  ██████╔╝███████║ ╚████╔╝ ██║     ██║   ██║██║  ██║█████╗  "
echo "  ██╔═══╝ ██╔══██║  ╚██╔╝  ██║     ██║   ██║██║  ██║██╔══╝  "
echo "  ██║     ██║  ██║   ██║   ███████╗╚██████╔╝██████╔╝███████╗"
echo "  ╚═╝     ╚═╝  ╚═╝   ╚═╝   ╚══════╝ ╚═════╝ ╚═════╝ ╚══════╝"
echo "  Full Stack Production Deploy — $(date '+%Y-%m-%d')"
echo -e "${NC}"

SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
log "Server IP: $SERVER_IP"

# ── [1] System packages ───────────────────────────────────────────────────────
step "1/9 — System packages"
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  nginx git curl wget ufw fail2ban \
  postgresql postgresql-contrib redis-server \
  build-essential ca-certificates gnupg lsb-release \
  unzip htop

# Node.js 20 LTS
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs
fi
log "Node $(node -v) | npm $(npm -v)"

# PM2 process manager
npm install -g pm2 --quiet
log "PM2 installed"

# ── [2] Firewall ─────────────────────────────────────────────────────────────
step "2/9 — Firewall"
ufw default deny incoming  > /dev/null 2>&1 || true
ufw default allow outgoing > /dev/null 2>&1 || true
ufw allow 22/tcp           > /dev/null 2>&1 || true
ufw allow 80/tcp           > /dev/null 2>&1 || true
ufw allow 443/tcp          > /dev/null 2>&1 || true
ufw --force enable         > /dev/null 2>&1 || true
systemctl enable fail2ban && systemctl start fail2ban
log "Firewall: 22/80/443 open. fail2ban active."

# ── [3] PostgreSQL ─────────────────────────────────────────────────────────────
step "3/9 — PostgreSQL"
systemctl enable postgresql && systemctl start postgresql

# Create DB and user
sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};" 2>/dev/null || true
sudo -u postgres psql -d ${DB_NAME} -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";" 2>/dev/null || true
log "PostgreSQL: database '${DB_NAME}' ready"

# ── [4] Redis ─────────────────────────────────────────────────────────────────
step "4/9 — Redis"
systemctl enable redis-server && systemctl start redis-server
log "Redis running on 127.0.0.1:6379"

# ── [5] Clone / update repo ───────────────────────────────────────────────────
step "5/9 — Application code"
if [ -d "$API_DIR/.git" ]; then
  cd $API_DIR && git pull origin main
  log "Repo updated"
else
  git clone $REPO $API_DIR
  log "Repo cloned to $API_DIR"
fi

# Frontend
mkdir -p $APP_DIR
cp $API_DIR/index.html $APP_DIR/
cp $API_DIR/app.js $APP_DIR/ 2>/dev/null || true
chown -R www-data:www-data $APP_DIR
log "Frontend deployed to $APP_DIR"

# ── [6] Backend setup ─────────────────────────────────────────────────────────
step "6/9 — Backend API"
cd $API_DIR/backend 2>/dev/null || cd $API_DIR

# Generate secrets
JWT_SECRET=$(openssl rand -hex 32)
REFRESH_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

cat > .env << ENVEOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
PORT=${NODE_PORT}
NODE_ENV=production
APP_URL=https://paylodeservices.com
API_URL=https://api.paylodeservices.com

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=24h
REFRESH_TOKEN_SECRET=${REFRESH_SECRET}
REFRESH_TOKEN_EXPIRES_IN=30d

REDIS_URL=redis://127.0.0.1:6379

SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=CONFIGURE_ME
EMAIL_FROM=noreply@paylodeservices.com
EMAIL_SUPPORT=support@paylodeservices.com

ENCRYPTION_KEY=${ENCRYPTION_KEY}

RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

CBN_LICENSE_NO=CBN/PAY/2024/001847
COMPLIANCE_EMAIL=compliance@paylodeservices.com
ENVEOF

chmod 600 .env
log ".env file created with generated secrets"

npm install --production --quiet
npx prisma generate --silent
npx prisma migrate deploy
node prisma/seed.js
log "Database migrated and seeded"

# ── [7] PM2 process manager ────────────────────────────────────────────────────
step "7/9 — PM2"
cat > ecosystem.config.js << PMEOF
module.exports = {
  apps: [{
    name:        'paylode-api',
    script:      'src/server.js',
    instances:   'max',
    exec_mode:   'cluster',
    env:         { NODE_ENV: 'production' },
    max_memory_restart: '512M',
    error_file:  '/var/log/paylode/api-error.log',
    out_file:    '/var/log/paylode/api-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 3000,
    max_restarts: 10,
  }]
};
PMEOF
mkdir -p /var/log/paylode
pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true
log "PM2 running in cluster mode"

# ── [8] Nginx ─────────────────────────────────────────────────────────────────
step "8/9 — Nginx"
cp $API_DIR/nginx/paylode.conf /etc/nginx/sites-available/paylode
ln -sf /etc/nginx/sites-available/paylode /etc/nginx/sites-enabled/paylode
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx && systemctl restart nginx
log "Nginx configured and restarted"

# ── [9] HTTPS ─────────────────────────────────────────────────────────────────
step "9/9 — SSL / HTTPS"
apt-get install -y -qq certbot python3-certbot-nginx
echo ""
warn "Cloudflare manages SSL for the main domain."
warn "Set Cloudflare SSL/TLS → Full mode (not Flexible)"
warn "To get an origin cert for api.paylodeservices.com:"
warn "  certbot --nginx -d api.paylodeservices.com"

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✅  Paylode Full Stack Deployed!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  🌐  Frontend:   https://paylodeservices.com"
echo "  🔌  API:        https://api.paylodeservices.com"
echo "  ❤️   Health:     https://api.paylodeservices.com/health"
echo ""
echo "  📦  Database:"
echo -e "      DB_USER:  ${CYAN}${DB_USER}${NC}"
echo -e "      DB_PASS:  ${CYAN}${DB_PASS}${NC}  ← SAVE THIS"
echo -e "      DB_NAME:  ${CYAN}${DB_NAME}${NC}"
echo ""
echo "  🔑  Default logins (change immediately):"
echo "      Super Admin:   admin@paylodeservices.com / Admin@Paylode2025!"
echo "      Compliance:    compliance@paylodeservices.com / Comply@Paylode2025!"
echo ""
echo "  📋  Useful commands:"
echo "      pm2 status           — see API process"
echo "      pm2 logs paylode-api — live logs"
echo "      pm2 restart all      — restart"
echo "      tail -f /var/log/nginx/paylode_api_access.log"
echo ""
echo "  ⚙️   Next steps:"
echo "      1. Point api.paylodeservices.com DNS to this IP ($SERVER_IP)"
echo "      2. Set Cloudflare SSL → Full mode"
echo "      3. Configure SMTP (add to .env → pm2 restart all)"
echo "      4. Configure S3/R2 for KYC document storage"
echo "      5. Change all default passwords"
echo ""
