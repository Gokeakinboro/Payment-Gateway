---
name: kiv-parallex-mpgs-card-rail
description: "🟡 KIV — Parallex MPGS card-payment middleware (local + international cards) — built 2026-07-20, NOT yet deployed"
metadata: 
  node_type: memory
  type: project
  originSessionId: 313bc510-85d5-4ee3-b9c7-d132bad21078
---

Paylode sits as middleware between MPGS-enabled merchants and Parallex's MPGS acquirer instance. Per-merchant MIDs issued by Parallex via Paylode. Paylode transforms merchant payload → MPGS format, pre-screens (AML/PEP/Mastercard compliance), forwards, logs.

**Why:** Parallex is a Mastercard acquirer; MPGS = Mastercard Payment Gateway Services. CBN-licensed PSSP role requires Paylode to be the crawler/interceptor between merchant and card network.

**How to apply:** All code built, NOT yet deployed to 176. Run BOTH migrations before `prisma generate`. No branch created yet — code sits on working tree.

---

## Architecture (FINAL — 2026-07-20)

**Key design decision:** URLs mimic MPGS exactly so merchants integrate using standard Mastercard MPGS SDK/docs. Only the host changes from Parallex's MPGS URL to Paylode's.

**Merchant connection parameters issued by Paylode:**
- Gateway URL: `https://api.paylodeservices.com/api/rest/version/77`
- Merchant ID: `{mpgs_mid}` (same MID Parallex issued)
- API Password: Paylode-generated (NOT the real MPGS password — that stays internal)

**Auth (identical to MPGS standard):**
- `Authorization: Basic base64(merchant.{merchantId}:{apiPassword})`
- `merchantId` in Basic Auth MUST match `:mid` in URL path (enforced)

**Two-password model (critical):**
1. `mpgs_api_password` — Parallex-issued real MPGS credential. Stored in DB, used when forwarding to MPGS. Never shared with merchant.
2. `gateway_api_password` — Paylode-issued credential. Generated on SA config creation. Stored as SHA-256 hash only. Shown ONCE to SA to share with merchant. Rotatable via `POST /api/v1/mpgs/admin/:merchantId/rotate-password`.

**3DS:** MPGS handles it.
- Frictionless: MPGS authenticates server-side → immediate `result: SUCCESS`
- Challenge: MPGS returns `result: PENDING_AUTHENTICATION` + `authentication.redirectUrl` → our gateway returns 202 with that URL → merchant redirects cardholder → MPGS fires webhook to Paylode → Paylode fires `card.charge.success/failed` webhook to merchant
- Post-challenge callback endpoint: still TBD (need MPGS webhook shape from Parallex)

**Amount format:** Merchants send naira strings (`"5000.00"`) per MPGS standard. We convert to kobo for DB storage. Response returns naira format.

**Sandbox/mock:** `req.isSandbox = !merchant.liveEnabled`. Test card `4000000000000002` → DECLINE; all others → APPROVED. `?inspect=true` query param shows transformed payload without calling MPGS (sandbox only).

---

## Files built (2026-07-20)

### New files
| File | Purpose |
|---|---|
| `prisma/migrations/20260720_merchant_mpgs_config.sql` | Creates `merchant_mpgs_configs` table |
| `prisma/migrations/20260720_mpgs_gateway_auth.sql` | Adds `gateway_api_password_hash`, `gateway_api_password_prefix` cols + UNIQUE index on `mpgs_mid` |
| `services/parallexMpgsService.js` | MPGS HTTP client: `charge()`, `getOrder()`, `toMpgsPayload()`, `fromMpgsResponse()`, `buildSandboxResponse()`, `cardTypeFromNumber()` |
| `routes/mpgs-gateway.js` | MPGS-mirrored merchant routes at `/api/rest` — `PUT .../transaction/:txnId` (PAY/AUTHORIZE) + `GET .../order/:orderId` |
| `test/mpgs-gateway-smoke.js` | Smoke test suite — SA setup, auth, validation, inspect, sandbox charges, order retrieval, live MPGS sandbox section |
| `docs/mpgs-merchant-integration.md` | Merchant integration guide (MPGS-native URLs, full webhook docs, test cards, SDK config table) |

### Modified files
| File | Change |
|---|---|
| `prisma/schema.prisma` | Added `MerchantMpgsConfig` model (with gateway auth fields) + `mpgsConfig` relation on `Merchant` |
| `routes/mpgs.js` | Rewritten to SA admin only — no `/charge` endpoint. Generates gateway password on `PUT /admin/:merchantId`. Adds `POST /admin/:merchantId/rotate-password`. `GET /status` for merchant check. |
| `modules/registry.js` | Added `mpgs` at `/api/v1/mpgs` (SA admin + status) AND `mpgs-gateway` at `/api/rest` (merchant charges) |

---

## Endpoints

### SA Admin (`/api/v1/mpgs/admin/*`, requireAdmin)
| Method | Path | Action |
|---|---|---|
| GET | `/api/v1/mpgs/admin` | List all MPGS-configured merchants |
| GET | `/api/v1/mpgs/admin/:merchantId` | Get config + connection parameters |
| PUT | `/api/v1/mpgs/admin/:merchantId` | Create/update config — **generates + returns gateway password ONCE** |
| POST | `/api/v1/mpgs/admin/:merchantId/rotate-password` | Rotate gateway password |
| DELETE | `/api/v1/mpgs/admin/:merchantId` | Deactivate |

### Merchant Status (`requireApiKey`)
| Method | Path | Action |
|---|---|---|
| GET | `/api/v1/mpgs/status` | Check if MPGS enabled, returns gateway URL + MID |

### Merchant Charges — MPGS-mirrored (`/api/rest/*`, Basic Auth)
| Method | Path | Action |
|---|---|---|
| PUT | `/api/rest/version/:v/merchant/:mid/order/:orderId/transaction/:txnId` | PAY or AUTHORIZE |
| GET | `/api/rest/version/:v/merchant/:mid/order/:orderId` | Retrieve order status |

---

## Webhook events fired to merchants
| Event | When |
|---|---|
| `card.charge.success` | Payment approved (incl. after 3DS challenge) |
| `card.charge.failed` | Declined or failed |

Webhook body: `{ event, data: { reference, mpgs_order_id, mpgs_transaction_id, status, amount(kobo), currency, card{type,bin,last4}, authorization_code, gateway_code }, timestamp }`
Signature: HMAC-SHA512 of raw body using merchant webhook secret → `X-Paylode-Signature` header.

---

## MPGS response format (returned to merchant — standard MPGS shape)
```json
{
  "result": "SUCCESS",
  "response": { "gatewayCode": "APPROVED", "acquirerCode": "00" },
  "order": { "id": "ORDER-ID", "amount": 5000.00, "currency": "NGN", "creationTime": "..." },
  "transaction": { "id": "1", "type": "PAYMENT", "authorizationCode": "831452", "reference": "..." },
  "sourceOfFunds": { "type": "CARD", "provided": { "card": { "scheme": "MASTERCARD", "number": "512345xxxxxx0008" } } },
  "paylode.reference": "PX-ORDER-ID-1"
}
```

---

## Test cards (standard Mastercard MPGS sandbox)
| Card | Scheme | Result |
|---|---|---|
| `5123450000000008` | Mastercard | APPROVED (frictionless) |
| `5111111111111118` | Mastercard | APPROVED (3DS2 frictionless) |
| `5200000000000007` | Mastercard | PENDING_AUTHENTICATION (3DS challenge) |
| `4111111111111111` | Visa | APPROVED |
| `4000000000000002` | Visa | DECLINED |
| `5105105105105100` | Mastercard | DECLINED |
| `371449635398431` | Amex | APPROVED |

All test cards: expiry `05/27`, CVV `100`.

To run smoke test:
```
SA_TEST_TOKEN=<sa_jwt> PAYLODE_MERCHANT_ID=<uuid> \
MPGS_TEST_BASE_URL=https://test-gateway.mastercard.com/api/rest/version/77 \
MPGS_TEST_MID=<mid> MPGS_TEST_API_PASSWORD=<password> \
node test/mpgs-gateway-smoke.js
```

---

## OPEN — Blocked on Parallex / decisions pending
1. **Parallex MPGS base URL** — needed for `mpgs_base_url` when SA enters MID. Format: `https://{host}/api/rest/version/{N}`. Ask Parallex.
2. **Rail cost %** — Parallex's MPGS processing rate → set `railCost` on transactions. Goke will advise.
3. **Post-3DS callback endpoint** — after 3DS challenge, MPGS redirects cardholder to a URL Paylode must host. Need Parallex to confirm the webhook/notification shape. Short build once known.
4. **MPGS docs** — `https://ap-gateway.mastercard.com/...` is a JS SPA, WebFetch can't read it. Share relevant pages as PDF or copy-paste if specific field details needed.

## GO-LIVE STEPS
1. SSH 176, run BOTH migrations in order:
   ```
   psql $DATABASE_URL < backend/prisma/migrations/20260720_merchant_mpgs_config.sql
   psql $DATABASE_URL < backend/prisma/migrations/20260720_mpgs_gateway_auth.sql
   ```
2. `cd /opt/paylode-api/backend && npx prisma generate`
3. SCP new/changed files to 176 + `pm2 reload paylode-core`
4. SA: `PUT /api/v1/mpgs/admin/:merchantId` with first merchant's Parallex credentials → copy gateway password
5. Run smoke test (sandbox mock first, then real MPGS sandbox with Parallex test credentials)
6. Check `?inspect=true` on a test charge to verify MPGS payload transformation
