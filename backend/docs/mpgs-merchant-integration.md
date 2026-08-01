# Paylode MPGS Card Payment Integration Guide

**Audience:** Merchants with an MPGS-enabled Paylode account  
**Protocol:** Mastercard Payment Gateway Services (MPGS) REST API  
**Paylode Gateway URL:** `https://api.paylodeservices.com/api/rest/version/77`

---

## Overview

Paylode operates as a licensed MPGS gateway. Your integration is identical to a direct MPGS integration — the same SDKs, the same request format, the same response format. The only difference is the gateway host: you point your MPGS configuration to Paylode's URL instead of your acquirer's URL.

Paylode handles compliance pre-screening, transaction reporting, and fee collection transparently. All card schemes supported by MPGS are supported: **Mastercard, Visa, Verve**, and affiliated networks, for both local (NGN) and international transactions.

---

## Your Connection Parameters

When Paylode activates MPGS on your account, you will receive:

| Parameter | Value |
|---|---|
| **Gateway URL** | `https://api.paylodeservices.com/api/rest/version/77` |
| **Merchant ID** | Your MPGS Merchant ID (e.g. `MERCH001`) |
| **API Password** | Issued by Paylode — shown once at activation |

These are the values you configure in your MPGS SDK, library, or HTTP client in place of your acquirer's connection parameters. Everything else in your MPGS integration remains unchanged.

> **The API Password is shown once** at account activation. Store it in your secrets manager immediately. Contact Paylode support if you need it rotated.

---

## Authentication

All requests use **HTTP Basic Authentication**, exactly as the MPGS standard:

```
Authorization: Basic base64(merchant.{merchantId}:{apiPassword})
```

**Example** (Merchant ID: `MERCH001`, password: `abc123xyz`):
```
Authorization: Basic bWVyY2hhbnQuTUVSQ0gwMDE6YWJjMTIzeHl6
```

Most MPGS SDKs handle this automatically when you supply the Merchant ID and API Password.

---

## API Endpoints

### Charge a Card (PAY)

Initiates an immediate card payment. MPGS handles 3D Secure automatically — frictionless transactions return `SUCCESS` in a single call; challenge flows return `PENDING_AUTHENTICATION` with a redirect URL.

```
PUT /api/rest/version/77/merchant/{merchantId}/order/{orderId}/transaction/{transactionId}
Authorization: Basic base64(merchant.{merchantId}:{apiPassword})
Content-Type: application/json
```

**URL parameters**

| Parameter | Description |
|---|---|
| `merchantId` | Your MPGS Merchant ID |
| `orderId` | Your unique order identifier (max 40 chars, alphanumeric + hyphens) |
| `transactionId` | Transaction sequence within the order — use `1` for a new payment |

**Request body**

```json
{
  "apiOperation": "PAY",
  "order": {
    "amount": "5000.00",
    "currency": "NGN",
    "description": "Subscription renewal — Pro plan"
  },
  "sourceOfFunds": {
    "type": "CARD",
    "provided": {
      "card": {
        "number": "5123450000000008",
        "expiry": {
          "month": "01",
          "year": "27"
        },
        "securityCode": "100",
        "nameOnCard": "Adebayo Okafor"
      }
    }
  },
  "transaction": {
    "reference": "ORDER-2026-0042"
  },
  "customer": {
    "email": "adebayo@example.com",
    "phone": "+2348012345678",
    "firstName": "Adebayo",
    "lastName": "Okafor",
    "ipAddress": "197.210.64.1"
  }
}
```

**Key request fields**

| Field | Required | Description |
|---|---|---|
| `apiOperation` | Yes | `PAY` for immediate capture; `AUTHORIZE` to hold funds only |
| `order.amount` | Yes | Naira amount with 2 decimal places (e.g. `"5000.00"`) |
| `order.currency` | Yes | ISO-4217 — `NGN` for naira, or international currency |
| `sourceOfFunds.provided.card.number` | Yes | 13–19 digit PAN |
| `sourceOfFunds.provided.card.expiry.month` | Yes | 2-digit month (`"01"`–`"12"`) |
| `sourceOfFunds.provided.card.expiry.year` | Yes | 2-digit year (e.g. `"27"` for 2027) |
| `sourceOfFunds.provided.card.securityCode` | Yes | 3 or 4 digit CVV/CVC |
| `sourceOfFunds.provided.card.nameOnCard` | No | Cardholder name |
| `transaction.reference` | No | Your internal reference stored on the transaction |
| `customer.email` | No | Customer email (used for compliance screening) |
| `customer.firstName` / `customer.lastName` | No | Used for AML/sanctions screening |
| `customer.ipAddress` | No | Customer IP address |

---

#### Response — Approved (`200 OK`)

Payment authorised. Frictionless 3DS2 completed silently.

```json
{
  "result": "SUCCESS",
  "response": {
    "gatewayCode": "APPROVED",
    "acquirerCode": "00"
  },
  "order": {
    "id": "ORDER-2026-0042",
    "amount": 5000.00,
    "currency": "NGN",
    "creationTime": "2026-07-20T14:25:03.412Z"
  },
  "transaction": {
    "id": "1",
    "type": "PAYMENT",
    "authorizationCode": "831452",
    "reference": "ORDER-2026-0042"
  },
  "sourceOfFunds": {
    "type": "CARD",
    "provided": {
      "card": {
        "scheme": "MASTERCARD",
        "number": "512345xxxxxx0008",
        "expiry": { "month": "01", "year": "27" }
      }
    }
  },
  "paylode.reference": "PX-ORDER-2026-0042-1"
}
```

> Store `paylode.reference` for support queries and reconciliation.

---

#### Response — 3DS Challenge Required (`202 Accepted`)

The card requires an interactive 3D Secure challenge. Redirect your customer's browser to `authentication.redirectUrl`.

```json
{
  "result": "PENDING_AUTHENTICATION",
  "authentication": {
    "redirectUrl": "https://mpgs.parallexbank.com/acs/redirect/...",
    "version": "3DS2"
  },
  "order": {
    "id": "ORDER-2026-0042",
    "amount": 5000.00,
    "currency": "NGN"
  },
  "transaction": { "id": "1" },
  "paylode.reference": "PX-ORDER-2026-0042-1"
}
```

After the cardholder completes the challenge on the MPGS-hosted page, Paylode receives the result and fires a webhook to your server. **Do not poll — wait for the webhook.**

---

#### Response — Declined (`400`)

```json
{
  "result": "FAILURE",
  "response": {
    "gatewayCode": "DECLINED",
    "acquirerCode": "05",
    "acquirerMessage": "Do not honour"
  },
  "order": { "id": "ORDER-2026-0042", "amount": 5000.00, "currency": "NGN" },
  "transaction": { "id": "1" }
}
```

---

#### Response — Error (`400`/`403`/`502`)

```json
{
  "result": "ERROR",
  "error": {
    "cause": "INVALID_REQUEST",
    "explanation": "sourceOfFunds.provided.card.number is required"
  }
}
```

**Error causes**

| `cause` | Meaning |
|---|---|
| `INVALID_REQUEST` | Malformed request — see `explanation` |
| `INVALID_CREDENTIALS` | Wrong Merchant ID or API Password |
| `TRANSACTION_DECLINED` | Blocked by compliance screening (sanctions, prohibited MCC) |
| `SYSTEM_ERROR` | Upstream issue — retry after a short delay |

---

### Retrieve Order

Check the current status of a previously submitted order.

```
GET /api/rest/version/77/merchant/{merchantId}/order/{orderId}
Authorization: Basic base64(merchant.{merchantId}:{apiPassword})
```

**Response**

```json
{
  "result": "SUCCESS",
  "order": {
    "id": "ORDER-2026-0042",
    "amount": "5000.00",
    "currency": "NGN",
    "status": "SUCCESS",
    "creationTime": "2026-07-20T14:25:03.412Z"
  },
  "transaction": {
    "id": "1",
    "type": "PAYMENT",
    "authorizationCode": "831452"
  },
  "sourceOfFunds": {
    "type": "CARD",
    "provided": {
      "card": { "scheme": "MASTERCARD", "number": "512345xxxxxx0008" }
    }
  },
  "paylode.reference": "PX-ORDER-2026-0042-1"
}
```

---

## 3D Secure

Paylode's MPGS gateway handles 3DS2 automatically. You do not configure or orchestrate 3DS — it runs transparently for every card transaction.

**Frictionless flow (most transactions):**
- MPGS authenticates the card server-side
- `PUT .../transaction/1` returns `result: SUCCESS` immediately
- No redirect needed

**Challenge flow (cards that require it):**
1. `PUT .../transaction/1` returns `202` with `result: PENDING_AUTHENTICATION` and `authentication.redirectUrl`
2. Redirect your customer's browser to that URL
3. Customer completes authentication on the MPGS-hosted page
4. Paylode receives the result and fires a `card.charge.success` or `card.charge.failed` webhook to your server
5. Fulfil your order based on the webhook

> **You must have your webhook URL configured** to receive outcomes from challenge flows.

---

## Webhooks

Paylode sends an HTTP `POST` to your configured webhook URL for every terminal payment outcome. This is the authoritative signal for order fulfilment — especially important for 3DS challenge flows.

### Configuring your webhook

In the Paylode merchant portal → **Settings → Webhooks**, enter your server endpoint URL and save. Copy the **Webhook Secret** shown — it is used to verify incoming requests.

### Webhook request format

```
POST https://your-server.com/webhooks/paylode
Content-Type: application/json
X-Paylode-Signature: <hmac_sha512_hex>
X-Paylode-Event: card.charge.success
User-Agent: Paylode-Webhooks/1.0
```

**Body**

```json
{
  "event": "card.charge.success",
  "data": {
    "reference": "PX-ORDER-2026-0042-1",
    "mpgs_order_id": "ORDER-2026-0042",
    "mpgs_transaction_id": "1",
    "status": "SUCCESS",
    "amount": 500000,
    "currency": "NGN",
    "card": {
      "type": "MASTERCARD",
      "bin": "512345",
      "last4": "0008"
    },
    "authorization_code": "831452",
    "gateway_code": "APPROVED"
  },
  "timestamp": "2026-07-20T14:25:03.412Z"
}
```

> `amount` in the webhook is in **kobo** (smallest currency unit). Divide by 100 for naira.

### Webhook events

| Event | Trigger |
|---|---|
| `card.charge.success` | Payment approved (including after 3DS challenge) |
| `card.charge.failed` | Payment declined or failed |

### Verifying the signature

`X-Paylode-Signature` is **HMAC-SHA512** of the raw JSON body, signed with your Webhook Secret. Always verify before processing.

**Node.js**
```javascript
const crypto = require('crypto');

function verify(rawBody, signature, secret) {
  const expected = crypto.createHmac('sha512', secret)
    .update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// Express — parse as raw buffer
app.post('/webhooks/paylode', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-paylode-signature'];
  if (!verify(req.body, sig, process.env.PAYLODE_WEBHOOK_SECRET))
    return res.status(401).send('Invalid signature');

  const { event, data } = JSON.parse(req.body);
  if (event === 'card.charge.success') {
    // Fulfil order — use data.mpgs_order_id to match your order
  }
  res.sendStatus(200);
});
```

**PHP**
```php
$rawBody   = file_get_contents('php://input');
$signature = $_SERVER['HTTP_X_PAYLODE_SIGNATURE'] ?? '';
$expected  = hash_hmac('sha512', $rawBody, getenv('PAYLODE_WEBHOOK_SECRET'));

if (!hash_equals($expected, $signature)) { http_response_code(401); exit; }

$payload = json_decode($rawBody, true);
if ($payload['event'] === 'card.charge.success') {
    $orderId = $payload['data']['mpgs_order_id'];
    // fulfil order
}
http_response_code(200);
```

**Python**
```python
import hmac, hashlib, json
from flask import request, abort

@app.route('/webhooks/paylode', methods=['POST'])
def webhook():
    raw  = request.get_data()
    sig  = request.headers.get('X-Paylode-Signature', '')
    exp  = hmac.new(WEBHOOK_SECRET.encode(), raw, hashlib.sha512).hexdigest()
    if not hmac.compare_digest(exp, sig): abort(401)
    payload = json.loads(raw)
    if payload['event'] == 'card.charge.success':
        order_id = payload['data']['mpgs_order_id']
        # fulfil order
    return 'OK', 200
```

### Retry policy

| Attempt | Delay |
|---|---|
| 1st | Immediate |
| 2nd | 10 seconds |
| 3rd | 20 seconds |

Your endpoint must respond with HTTP `2xx` within **10 seconds**. Return the response immediately and process asynchronously.

---

## Sandbox Testing

Use your sandbox connection parameters (issued separately from your live parameters) to test without real charges.

### Test cards

| Card Number | Scheme | Result |
|---|---|---|
| `5123450000000008` | Mastercard | Approved |
| `4111111111111111` | Visa | Approved |
| `6280000000000005` | Verve | Approved |
| `4000000000000002` | Visa | Declined |
| `5105105105105100` | Mastercard | Declined |

Use any future expiry date and any 3–4 digit CVV in sandbox.

### Using an MPGS SDK in sandbox

Point your SDK's gateway URL to:
```
https://api.paylodeservices.com/api/rest/version/77
```
Supply your **sandbox** Merchant ID and API Password. The SDK will behave identically to a live integration — only the host and credentials differ.

---

## Using Standard MPGS SDKs and Libraries

Because Paylode's gateway mirrors the MPGS REST API exactly, any MPGS-compatible SDK works with no code changes — only the configuration changes:

| Setting | MPGS default | Paylode value |
|---|---|---|
| Gateway host | `https://{acquirer}.gateway.mastercard.com` | `https://api.paylodeservices.com` |
| API version | `77` (or as advised) | `77` |
| Merchant ID | Acquirer-issued | As issued by Paylode |
| API Password | Acquirer-issued | As issued by Paylode |

Refer to the official [Mastercard MPGS REST API documentation](https://ap-gateway.mastercard.com/api/documentation/apiDocumentation/rest-json/version/latest/api.html) for full field-level reference, SDK downloads, and integration guides — it applies directly to this integration.

---

## Security Checklist

- [ ] API Password stored in an environment variable or secrets manager — never in code
- [ ] All charge requests originate from your server (never the browser)
- [ ] Webhook signature verification implemented and enforced
- [ ] Card number and CVV never logged or stored on your server
- [ ] Only `card.scheme`, `card.number` (masked), `card.bin`, `card.last4` stored from responses
- [ ] Webhook endpoint responds within 10 seconds and returns HTTP 200
- [ ] Order fulfilment triggered by webhook event, not by API response alone (covers 3DS challenge flows)
- [ ] `orderId` is unique per payment attempt in your system

---

## Support

| Topic | Contact |
|---|---|
| Integration support | support@paylodeservices.com |
| MPGS account / credential issues | support@paylodeservices.com (do not contact Parallex Bank directly) |
| Developer chat | paylodeservices.com/developer-chat |
