# Parallex Bank Integration Notes

Two separate products under the same API gateway (`tptintegration.parallexbank.com`):

| Product | Path prefix | Auth password |
|---------|-------------|---------------|
| Virtual Account (VA) | `/VirtualAccountAPI/V2/VirtualAccount` | **base64-encoded** |
| Third Party Transfer (TPT) | `/ThirdPartyTransferAPI` | **plain text** |

Both share 2-layer auth: `Ocp-Apim-Subscription-Key` header (different key per product) + Bearer JWT from `/Login` (30-min TTL, auto-refreshed).

---

## Network / VPN

All traffic from server 176 routes through the DO droplet (`165.22.21.63`) via WireGuard, then through a strongSwan IPSec tunnel from DO to Parallex's FortiGate (`102.220.220.19`). `/etc/hosts` on 176 points `tptintegration.parallexbank.com` → `10.10.0.2` (DO WireGuard IP).

**The API is NOT reachable over public internet** — VPN must be up.

Watchdog: `/usr/local/bin/vpn-watchdog.sh` on DO runs every 5 min via cron. Detects `ESTABLISHED` state; restarts tunnel if missing. When the tunnel drops and the watchdog can't reconnect, the issue is always on Parallex's FortiGate — call Parallex operations.

Log: `grep vpn-watchdog /var/log/syslog`

---

## Virtual Account (VA) service

**VA type: TIMED (per-session).** Parallex does not have a permanent/label VA endpoint. Every VA is created for a specific `amount` and expires after `accountExpiryTimeInMinutes` (optional; omit for no explicit expiry).

Confirmed missing endpoint: `POST /GeneratePermanentVirtualAccount` → 404. Do not attempt it.

### Create a timed VA

```
POST /VirtualAccountAPI/V2/VirtualAccount/GenerateTimedBasedAccountNumber
Headers: Ocp-Apim-Subscription-Key, Authorization: Bearer <token>, MerchantId: PB_014
Body:
{
  "firstName": "Bucksnostar",
  "lastName": "Global",
  "amount": "500",          // naira string (NOT kobo)
  "referenceId": "PLBKSNSTR20260820-001",  // min 20 chars
  "accountExpiryTimeInMinutes": 60         // optional
}
Response: { accountNumber, accountName, expiryDateTime, totalAmount, fees, settlementAmount }
```

Because VAs are per-session, they are **not stored** in `merchant_virtual_accounts`. The checkout flow creates a new timed VA per order. The SA `POST /payouts/admin/provision-va/:merchantId` also creates a timed VA on demand (requires `amount_kobo` + `reference` in body).

### Requery a timed VA payment

```
POST /VirtualAccountAPI/V2/VirtualAccount/TemporaryVirtualAccountRequery
Body: { "referenceId": "...", "accountNumber": "..." }
Response: { responseCode, responseDescription, data: { status, amount, ... } }
```

### Inflow webhook

Parallex calls `POST https://paylodeservices.com/api/v1/webhooks/parallex/inflow` on payment received. Verified against `PARALLEX_VA_WEBHOOK_SECRET`. **Note:** webhook delivery was confirmed broken on Parallex's side as of 2026-08-12 — two live payment tests, zero deliveries. Raise with Parallex if collections rely on webhook (use requery as fallback).

---

## Third Party Transfer (TPT) — payouts

### Flow

1. `GET /ThirdPartyTransferAPI/api/ThirdPartyTransfer/NameEnquiry?accountNumber=&bankCode=`  
   → returns `requestId` (use as `nameEnquirySessionID` in step 2; min 30 chars)

2. `POST /ThirdPartyTransferAPI/api/ThirdPartyTransfer/InterbankTransfer`  
   Body includes `nameEnquirySessionID` from step 1. **Required** — Parallex rejects empty/short values.

### Response codes

| Code | Meaning |
|------|---------|
| `00` | Success |
| `09` | Pending (treat as pending, do NOT retry — possible double-spend) |
| `25` | Duplicate reference |
| `90` | Token expired — re-login and retry |
| any timeout | Treat as pending (45s AbortController in `parallexTransferService.js`) |

### Bank codes (NIP institution codes)

| Bank | Code |
|------|------|
| OPay | `100004` |
| GTBank | `000013` |
| First Bank | `000016` |
| Access Bank | `000014` |
| Zenith | `000015` |
| UBA | `000004` |
| Parallex (on-us) | `999015` (env: `PARALLEX_TRANSFER_BANK_CODE`) |

### Accounts

| Account | Number | Purpose |
|---------|--------|---------|
| Payout float (debit source) | `1000362849` | Funded by Paylode; used for all outgoing NIP transfers |
| VA settlement | `1000362856` | Where VA collections settle; NOT enrolled in TPT product |

---

## Environment variables (server 176 `/opt/paylode-api/backend/.env`)

```
# VA service
PARALLEX_VA_BASE_URL=https://tptintegration.parallexbank.com/VirtualAccountAPI/V2/VirtualAccount
PARALLEX_VA_USERNAME=Paylode
PARALLEX_VA_PASSWORD=<see reference-parallex-portal-creds.md>
PARALLEX_VA_SUBKEY=<see reference-parallex-portal-creds.md>
PARALLEX_VA_MERCHANT_ID=PB_014
PARALLEX_VA_SETTLEMENT_ACCOUNT=1000362856
PARALLEX_VA_WEBHOOK_SECRET=<see reference-parallex-portal-creds.md>

# TPT service
PARALLEX_TRANSFER_BASE_URL=https://tptintegration.parallexbank.com/ThirdPartyTransferAPI
PARALLEX_TRANSFER_USERNAME=Paylode
PARALLEX_TRANSFER_PASSWORD=<see reference-parallex-portal-creds.md>
PARALLEX_TRANSFER_SUBKEY=<see reference-parallex-portal-creds.md>
PARALLEX_TRANSFER_DEBIT_ACCOUNT=1000362849
PARALLEX_TRANSFER_BANK_CODE=999015
```

---

## Key files

| File | Purpose |
|------|---------|
| `backend/src/modules/gateway-core/services/parallexService.js` | VA client (login, timed VA, requery, webhook verify) |
| `backend/src/modules/gateway-core/services/parallexTransferService.js` | TPT payout client (name enquiry, interbank transfer) |
| `backend/src/modules/gateway-core/routes/parallex-webhook.js` | Inflow webhook handler |
| `backend/test/parallex-health-check.js` | Connectivity smoke test |
| `backend/test/parallex-nip-test.js` | NIP name enquiry test |
