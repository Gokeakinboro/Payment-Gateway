# Invoice & Collect — API & SDK reference

Issue invoices, generate scan-to-pay QR codes, and collect payments
programmatically. Any platform holding a Paylode secret key (`sk_live_…` /
`sk_test_…`) can drive this — the key resolves to a merchant tenant.

- **Base URL:** `https://api.paylodeservices.com/v1`
- **Auth:** `Authorization: Bearer sk_live_…` (or the dashboard JWT)
- **Money:** all amounts are integers in **kobo** (₦1 = 100 kobo)
- **Envelope:** every response is `{ "status": true, "message": "…", "data": … }`

## Node SDK

```bash
npm install paylode-node
```

```js
const Paylode = require('paylode-node');
const paylode = new Paylode(process.env.PAYLODE_SECRET_KEY); // sk_live_ / sk_test_

// Create and email an invoice for ₦50,000 + 7.5% VAT to one recipient
const res = await paylode.invoicing.invoices.create({
  amount: 5_000_000,                 // ₦50,000 in kobo
  description: 'Annual golf membership',
  charge_vat: true,
  due_at: '2026-07-31',
  recipients: { email: 'member@example.com', name: 'Ada Member' },
});
console.log(res.data.invoices); // [{ id, invoice_number, recipient_email }]
```

`paylode.invoicing` namespaces: `invoices`, `qr`, `contacts`, `lists`,
`products`, `format`, `departments`, `reports`.

## Invoices

### Create — `POST /invoicing/invoices` · `invoicing.invoices.create(params)`

| field                    | type     | notes |
|--------------------------|----------|-------|
| `amount` *(required)*    | int kobo | invoice face, ≥ 100 |
| `recipients` *(required)*| object   | targeting — see below |
| `description`            | string   | ≤ 500 chars |
| `currency`               | string   | `NGN` (default) or `USD` |
| `charge_vat`             | bool     | default = merchant format's `charge_vat_default` |
| `allow_part_payment`     | bool     | allow recipient to pay in instalments |
| `scheduled_at`           | ISO date | future → invoice is `scheduled`, sent by the worker |
| `due_at`                 | ISO date | drives overdue flag + reminders |
| `reminder_interval_days` | int      | reminder cadence |
| `reminder_count`         | int      | max reminders to send |
| `department_id`          | uuid     | owners only; dept users are forced to their own |

**`recipients`** (one invoice is created per resolved, de-duplicated recipient):

```jsonc
{
  "email": "a@b.com", "name": "Ada", "phone": "+234…",  // single ad-hoc recipient
  "contact_id": "uuid",            // a saved contact
  "contact_ids": ["uuid", "uuid"], // many contacts
  "list_ids": ["uuid"],            // every contact in a list
  "all_contacts": true             // the merchant's entire contact book
}
```

Returns `{ count, scheduled, invoices: [{ id, invoice_number, recipient_email }] }`.
Non-scheduled invoices are emailed immediately (best-effort).

### Other invoice methods

| SDK | HTTP | |
|-----|------|-|
| `invoices.list({ status? })`  | `GET /invoicing/invoices`           | newest 1000; `status` = `draft\|scheduled\|sent\|part_paid\|paid\|cancelled` |
| `invoices.fetch(id)`          | `GET /invoicing/invoices/:id`       | includes `payments[]` and `access_token` |
| `invoices.send(id)`           | `POST /invoicing/invoices/:id/send` | (re)send the email |
| `invoices.cancel(id)`         | `POST /invoicing/invoices/:id/cancel` | blocked once `paid` |

## QR (scan-to-pay)

```js
await paylode.invoicing.qr.create({ type: 'fixed', amount: 250000, label: 'Range balls' });
await paylode.invoicing.qr.create({ type: 'open', label: 'Pro shop' }); // payer enters amount
```

| SDK | HTTP |
|-----|------|
| `qr.create({ type, amount?, label?, charge_vat?, department_id? })` | `POST /invoicing/qr` |
| `qr.list()`                       | `GET /invoicing/qr` |
| `qr.setActive(id, isActive)`      | `PATCH /invoicing/qr/:id` |
| `qr.remove(id)`                   | `DELETE /invoicing/qr/:id` |

Download the image directly: `GET /invoicing/qr/:id/image?format=png|svg`.

## Contacts, lists, products

```js
await paylode.invoicing.contacts.create({ name: 'Ada', email: 'ada@x.com', phone: '+234…' });
await paylode.invoicing.contacts.import(rows, 'skip'); // bulk; rows: [{name,email?,phone?,tags?}]
await paylode.invoicing.lists.create({ name: 'VIPs', contact_ids: ['uuid'] });
await paylode.invoicing.lists.update(listId, { add: ['uuid'], remove: ['uuid'] });
await paylode.invoicing.products.create({ name: 'Caddie fee', default_amount: 300000 });
```

| Resource | Methods |
|----------|---------|
| contacts | `create`, `list`, `import(rows, onDuplicate)`, `update(id, params)`, `remove(id)` |
| lists    | `create`, `list`, `members(id)`, `update(id, {add,remove})`, `remove(id)` |
| products | `create`, `list`, `remove(id)` |

## Format (branding — one per merchant)

```js
await paylode.invoicing.format.update({
  logo_url: 'https://…/logo.png', address: '…', business_email: 'billing@club.com',
  layout: 'modern',                 // classic | modern | minimal | receipt
  charge_vat_default: true, allow_part_payment_default: false,
});
```

`format.get()` / `format.update(params)` → `GET|PUT /invoicing/formats`. These
defaults pre-fill new invoices.

## Departments & departmental users

```js
const dep  = await paylode.invoicing.departments.create({ name: 'Pro Shop' });
const user = await paylode.invoicing.departments.addUser(dep.data.id, {
  name: 'Sade Staff', email: 'sade@club.com',
}); // onboards with a one-time temp password the user must change on first login
```

| SDK | HTTP |
|-----|------|
| `departments.create({ name })`         | `POST /invoicing/departments` |
| `departments.list()`                   | `GET /invoicing/departments` |
| `departments.remove(id)`               | `DELETE /invoicing/departments/:id` |
| `departments.users(id)`                | `GET /invoicing/departments/:id/users` |
| `departments.addUser(id, {name,email,phone?})` | `POST /invoicing/departments/:id/users` |
| `departments.removeUser(id, userMapId)`| `DELETE /invoicing/departments/:id/users/:userMapId` |

A departmental user only sees invoices/QRs/reports for their own department.

## Reports

```js
const sum = await paylode.invoicing.reports.summary();
// { by_status: { paid: { count, total }, … }, overdue, total_collected }

const csv = await paylode.invoicing.reports.transactions({ format: 'csv' });
```

| SDK | HTTP |
|-----|------|
| `reports.summary()`            | `GET /invoicing/reports/summary` |
| `reports.transactions({format?,from?,to?})` | `GET /invoicing/reports/transactions` |

## Recipient pay flow (public — no key)

Hosted pages, no API key needed by the payer:

1. Invoice email links to `invoice.html?t=<access_token>`; QR encodes
   `qr.html?c=<token>`.
2. The page POSTs to `/public/invoice/:token/pay` (or `/public/qr/:token/pay`).
   The server screens compliance + KYC limits, creates a **PENDING** transaction,
   and returns `{ reference, redirect_url }` → `checkout.html?ref=…`.
3. On settlement the payment is recorded against the invoice/QR (idempotent), and
   the invoice flips to `part_paid` / `paid`.

## Errors

Failures return `{ "status": false, "message": "…", "error_code": "…" }` with an
HTTP 4xx/5xx. The SDK throws `PaylodeError` with `.code`, `.statusCode`, `.raw`.
Notable codes: `ALREADY_PAID`, `CANCELLED`, `NO_BALANCE`, `KYC_LIMIT_EXCEEDED`,
`MERCHANT_INACTIVE`, `NOT_CANCELLABLE`, `BAD_TOKEN`, `QR_INACTIVE`.
