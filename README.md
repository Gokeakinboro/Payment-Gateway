# Paylode Services Limited — Full Stack Payment Gateway

CBN Licensed PSSP · paylodeservices.com

## Architecture

```
Cloudflare (CDN + DDoS + SSL)
        │
        ├── paylodeservices.com        → Nginx → /var/www/paylode (frontend)
        └── api.paylodeservices.com    → Nginx → Node.js :3000 (API)
                                                      │
                                              PostgreSQL :5432
                                              Redis :6379
```

## Quick Start (Local Development)

```bash
git clone https://github.com/Gokeakinboro/Payment-Gateway.git
cd Payment-Gateway

# Start all services with Docker
docker compose up -d

# Run DB migrations + seed
docker exec paylode_api npx prisma migrate dev
docker exec paylode_api node prisma/seed.js

# API is live at:
# http://localhost:3000/health
# DB Admin: http://localhost:8080
# Email UI: http://localhost:8025
```

## Production Deploy (Contabo VPS)

```bash
ssh root@YOUR_CONTABO_IP
curl -s https://raw.githubusercontent.com/Gokeakinboro/Payment-Gateway/main/scripts/deploy-full.sh | bash
```

## Default Credentials (change immediately)

| Role               | Email                               | Password             |
|--------------------|-------------------------------------|----------------------|
| Super Admin        | admin@paylodeservices.com           | Admin@Paylode2025!   |
| Compliance Officer | compliance@paylodeservices.com      | Comply@Paylode2025!  |
| Aggregator         | agg@finconnect.ng                   | Agg@Connect2025!     |
| Merchant (Bolt)    | payments@boltnigeria.com            | Bolt@Merchant2025!   |

## API Reference

### Authentication
All API calls require a Bearer token (JWT for dashboard users) or API key (SDK calls).

```
POST /api/v1/auth/login
GET  /api/v1/auth/me
POST /api/v1/auth/change-password
```

### Transactions (SDK — use Secret Key)
```
POST /api/v1/transactions/initialize
GET  /api/v1/transactions/verify/:reference
GET  /api/v1/transactions
POST /api/v1/transactions/:ref/refund
```

### KYC
```
POST /api/v1/kyc/submit           — merchant submits application
GET  /api/v1/kyc/status           — merchant checks status
GET  /api/v1/kyc/queue            — compliance: review queue
POST /api/v1/kyc/:id/approve      — compliance: approve + activate
POST /api/v1/kyc/:id/reject       — compliance: reject with reason
```

### Reports
```
GET /api/v1/reports/daily-summary
GET /api/v1/reports/revenue?from=2025-05-01&to=2025-05-31&groupBy=month
GET /api/v1/reports/aggregator-revenue?month=2025-05
GET /api/v1/reports/rail-cost-analysis
GET /api/v1/reports/kyc-pipeline
GET /api/v1/reports/failure-analysis
GET /api/v1/reports/merchant-statement?from=2025-05-01&to=2025-05-31
GET /api/v1/reports/settlement-reconciliation?date=2025-05-25
GET /api/v1/reports/aml-flags
GET /api/v1/reports/cbn-monthly?month=2025-05
```

### Rails (Super Admin)
```
GET  /api/v1/rails
POST /api/v1/rails
PUT  /api/v1/rails/:id/costs    — update rate for a channel
PUT  /api/v1/rails/:id/status   — CONFIG_ONLY | TESTING | LIVE
```

### Merchants
```
GET /api/v1/merchants
PUT /api/v1/merchants/:id/rate
PUT /api/v1/merchants/:id/suspend
PUT /api/v1/merchants/:id/activate
GET /api/v1/merchants/:id/api-keys
POST /api/v1/merchants/:id/api-keys/rotate
```

### Aggregators
```
GET /api/v1/aggregators
PUT /api/v1/aggregators/:id/split
GET /api/v1/aggregators/my/merchants
GET /api/v1/aggregators/my/revenue
```

### Settlements
```
GET  /api/v1/settlements
POST /api/v1/settlements/process    — run daily batch (compliance)
```

### Admin
```
GET /api/v1/admin/dashboard
GET /api/v1/admin/audit-log
```

## Transaction Initialize Example

```bash
curl -X POST https://api.paylodeservices.com/api/v1/transactions/initialize \
  -H "Authorization: Bearer sk_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "customer@example.com",
    "amount": 500000,
    "currency": "NGN",
    "channels": ["card", "bank_transfer"],
    "metadata": { "order_id": "ORD-9812" }
  }'
```

Response:
```json
{
  "status": true,
  "message": "Transaction initialized",
  "data": {
    "authorization_url": "https://checkout.paylodeservices.com/pay/TXN-ABC123",
    "access_code": "TXN-ABC123",
    "reference": "TXN-ABC123",
    "amount": 500000,
    "currency": "NGN"
  }
}
```

## KYC Tier Limits

| Tier | Per Transaction | Daily     | Monthly   | Channels              |
|------|-----------------|-----------|-----------|------------------------|
| 1    | ₦50,000         | ₦300,000  | ₦1M       | Card, USSD            |
| 2    | ₦1,000,000      | ₦10M      | ₦50M      | Card, Transfer, USSD  |
| 3    | ₦5,000,000      | ₦100M     | Custom    | All + Direct Debit    |

## Revenue Formula

```
merchant_fee    = txn_amount × merchant.processing_rate
rail_cost       = txn_amount × rail_costs[channel].rate
net_revenue     = merchant_fee − rail_cost
agg_share       = net_revenue × aggregator.revenue_split_pct
paylode_margin  = net_revenue − agg_share
```

All computed atomically on each successful transaction.

## Database

PostgreSQL 16 — 12 tables:
`users` `merchants` `aggregators` `api_keys` `payment_rails` `rail_costs`
`transactions` `settlements` `agg_payouts` `kyc_submissions` `aml_flags`
`audit_log` `webhook_deliveries`

## Useful Commands

```bash
# PM2
pm2 status
pm2 logs paylode-api
pm2 restart all
pm2 reload all           # zero-downtime reload

# Database
sudo -u postgres psql paylode_db
npx prisma studio        # visual DB browser

# Logs
tail -f /var/log/paylode/api-out.log
tail -f /var/log/nginx/paylode_api_access.log

# Test API
curl https://api.paylodeservices.com/health
```

---
Paylode Services Limited · CBN/PAY/2024/001847
test 
test auto deploy 
test auto deploy 
test auto deploy 
