# Invoice & Collect — module

In-repo, API-first billing module for the Paylode Payment-Gateway backend. Lets a
merchant (or any platform onboarded as a merchant/aggregator — e.g. a golf club)
issue **invoices**, generate **scan-to-pay QR codes**, manage **contacts/lists/
products**, brand the **invoice format**, run **departments** with scoped
sub-users, and pull **collection reports**. Extractable into its own service later.

Mounted once in `src/server.js`:

```js
app.use('/api/v1/invoicing', require('./modules/invoicing'));
```

## Tenancy & auth (`_shared.tenantAuth`)

Every authenticated subroute resolves a **merchant tenant** via one of three paths,
all funnelling into `req.invTenant`:

| Caller                       | Credential                        | `req.invTenant`                                  |
|------------------------------|-----------------------------------|--------------------------------------------------|
| Dashboard owner / staff      | JWT (`Authorization: Bearer …`)   | `{ merchantId, isApiKey:false }`                 |
| External platform (golf)     | API key `sk_live_`/`sk_test_`     | `{ merchantId, isApiKey:true }`                  |
| Departmental sub-user        | JWT mapped in `inv_department_users` | `{ merchantId, departmentId, isDeptUser:true }` |

Departmental users are **scoped to their department** — invoice/QR/report queries
filter on `department_id` for them automatically.

Public recipient/QR pay endpoints live under `/public` and take **no auth** (a
random `access_token` in the URL is the bearer).

## Layout

```
modules/invoicing/
  _shared.js              VAT (7.5% on face), tokens, tenantAuth middleware
  index.js                aggregates the subrouters
  routes/
    contacts.js  lists.js  formats.js  products.js
    invoices.js  qr.js     departments.js  reports.js
    public.js             recipient view + pay, QR landing + pay (no auth)
  services/
    invoiceNumber.js      atomic per-merchant counter → <CODE>-INV-000123
    invoiceSend.js        email + status flip
    qrService.js          PNG/SVG render → qr.html?c=<token>
    invoicingPay.js       record invoice/QR payment from a SUCCESS txn (idempotent)
```

## Data model (`inv_*` tables)

All created idempotently by `prisma/migrations/20260628_invoicing.sql` (raw SQL,
team convention — **not** Prisma models, to avoid prisma-migrate drift on the live
PCI DB). FKs reference `merchants(id)` / `users(id)`.

`inv_departments`, `inv_department_users`, `inv_contacts`, `inv_lists`,
`inv_list_members`, `inv_formats`, `inv_products`, `inv_series`,
`inv_invoice_counters`, `inv_invoices`, `inv_invoice_payments`, `inv_qr_codes`,
`inv_qr_payments`.

Amounts are stored in **kobo as BigInt**. VAT is 7.5% of the invoice face when
`charge_vat` is true; `total_amount = amount + vat_amount`.

## Payment flow

1. Recipient opens `invoice.html?t=<access_token>` (or scans → `qr.html?c=<token>`).
2. The page calls `POST /public/invoice/:token/pay` (or `/public/qr/:token/pay`),
   which screens compliance + KYC limit, mints a **PENDING** `transaction` tagged
   `metadata: { source:'invoice'|'qr', invoice_id|qr_id }`, and returns a
   `checkout.html?ref=` redirect.
3. On settlement, `services/payinFinalize.js` — after claiming SUCCESS — calls
   `invoicingPay.recordForTransaction` for bank-transfer (instant). Card pays are
   swept by the worker's `reconcileInvoicingPayments()` (the finalize hook may run
   before the card txn is visible). Recording is **idempotent** on the txn ref.

## Worker

`src/workers/invoicingWorker.js` — standalone 60s poll loop (not BullMQ; a poll
loop is simpler for these cron-style sweeps). Each tick: send due **scheduled**
invoices, send **overdue reminders** (merchant-set interval × count), reconcile
payments. Run under pm2 as `paylode-invoicing-worker`.

## Endpoints (authenticated — all under `/api/v1/invoicing`)

| Resource    | Routes |
|-------------|--------|
| invoices    | `GET /invoices`, `GET /invoices/:id`, `POST /invoices`, `POST /invoices/:id/send`, `POST /invoices/:id/cancel` |
| qr          | `GET /qr`, `POST /qr`, `GET /qr/:id/image`, `PATCH /qr/:id`, `DELETE /qr/:id` |
| contacts    | `GET /contacts`, `POST /contacts`, `POST /contacts/import`, `PATCH /contacts/:id`, `DELETE /contacts/:id` |
| lists       | `GET /lists`, `GET /lists/:id/members`, `POST /lists`, `PATCH /lists/:id`, `DELETE /lists/:id` |
| products    | `GET /products`, `POST /products`, `DELETE /products/:id` |
| formats     | `GET /formats`, `PUT /formats` |
| departments | `GET /departments`, `POST /departments`, `DELETE /departments/:id`, `GET /departments/:id/users`, `POST /departments/:id/users`, `DELETE /departments/:id/users/:userMapId` |
| reports     | `GET /reports/summary`, `GET /reports/transactions` (`?format=csv`) |

Public (no auth): `GET|POST /public/invoice/:token[/pay]`, `GET /public/recipient/:token`,
`GET|POST /public/qr/:token[/pay]`.

See [`docs/INVOICING.md`](../../../../docs/INVOICING.md) for request/response
shapes and SDK usage.
