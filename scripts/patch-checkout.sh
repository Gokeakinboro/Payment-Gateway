#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Paylode — Checkout Module Patch
# Run this on your server to add the checkout page WITHOUT redeploying everything
# Usage: bash patch-checkout.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
APP_DIR="/var/www/paylode"
API_DIR="/opt/paylode-api"

echo -e "${GREEN}Paylode — Applying checkout module patch...${NC}\n"

# 1. Pull latest code (gets checkout.html and checkout.js route)
echo -e "${YELLOW}[1/4] Pulling latest code...${NC}"
cd $API_DIR && git pull origin main
echo "    ✓ Code updated"

# 2. Copy checkout page to frontend
echo -e "${YELLOW}[2/4] Deploying checkout.html to frontend...${NC}"
cp $API_DIR/checkout.html $APP_DIR/checkout.html
chown www-data:www-data $APP_DIR/checkout.html
echo "    ✓ checkout.html live at https://paylodeservices.com/checkout.html"

# 3. Reload API (zero downtime — PM2 cluster reloads one worker at a time)
echo -e "${YELLOW}[3/4] Reloading API (zero downtime)...${NC}"
pm2 reload paylode-api
echo "    ✓ API reloaded with checkout routes"

# 4. Reload nginx
echo -e "${YELLOW}[4/4] Reloading nginx...${NC}"
nginx -t && nginx -s reload
echo "    ✓ Nginx reloaded"

echo ""
echo -e "${GREEN}✅ Checkout module deployed!${NC}"
echo ""
echo "  Test sandbox checkout:"
echo "  https://paylodeservices.com/checkout.html?ref=TXN-TEST-001&amount=500000&merchant=Test+Shop&email=test%40example.com&sandbox=true"
echo ""
echo "  Test cards:"
echo "  ✓ Success:             4084 0840 8408 4081"
echo "  ✗ Insufficient funds:  4084 0800 0000 0409"
echo "  ✗ Card declined:       4000 0000 0000 0002"
echo "  ✗ Timeout:             4187 4274 1556 4246"
echo "  (Any expiry/CVV/PIN in sandbox)"
echo ""
