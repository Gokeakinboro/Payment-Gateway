# Data ownership & module DB boundaries (P2)

Makes data ownership explicit so a module's schema change can't silently ripple, and
so a product can be reasoned about (and eventually deployed) on its own. Enforced by
`backend/tools/db-boundary-check.js` (part of `npm run verify:arch`), driven by the
manifest `backend/src/modules/_domains.js`.

## Ownership

| Domain | Owns | Storage |
| --- | --- | --- |
| **gateway-core** (money + all non-product core routes) | the **25 Prisma models** in `prisma/schema.prisma` (`Merchant`, `Transaction`, `Settlement`, `PayoutBatch`, `MerchantWallet`=payout wallet, …) and their tables | Prisma |
| **invoicing** | `inv_*` tables | raw SQL (`prisma/migrations/*.sql`) |
| **wallet** (Paymula member wallet) | `mw_*` tables | raw SQL |
| **assistant** | nothing (stateless) | — |

> Note: `MerchantWallet`/`WalletLedger` in the Prisma schema are the **core payout
> per-rail wallets** (money), NOT the Paymula member wallet (`mw_*`). Different things.

## The rules the lint enforces

1. **A product may touch only its own prefixed tables** (`inv_*` / `mw_*`), plus:
   - **Shared-read identity** (read-only): `merchants`, `users`, `api_keys`
     (models `merchant`, `user`, `apiKey`) — for tenant auth.
   - **Shared-write**: the `user` model — sub-users and wallet members **are** core
     Users (single `users` table with roles; no separate sub-user table), so products
     create/update their own sub-user Users. `merchant`/`apiKey` stay read-only.
   - **Shared tables** (both products): `inv_departments`, `inv_department_users`
     (the departmental structure).
2. **Core must not raw-query product tables** (`inv_*` / `mw_*`). The only sanctioned
   core→product path is the `payinFinalize.js` require-hooks
   (`invoicingPay` / `walletFund`), keyed by `txn.metadata.source`.
3. Anything else = a violation and fails CI.

## Catalogued exceptions (pre-existing, reviewed — kept visible)

These pass the lint but are listed in `_domains.js` `KNOWN_EXCEPTIONS` so they stay
on the radar. **Follow-up (KIV, money-staged): route them through hooks** so the
boundary becomes clean.

- **Products create the gateway `transaction`** for a collection
  (`invoicing/routes/public.js`, `wallet/routes/{fund,me}.js`) → future: a
  gateway-core `createGatewayTransaction` hook (mirrors `payinFinalize`→product).
- **Products read `transaction`** to reconcile a completed payment
  (`invoicingPay.js`, `walletFund.js`) — read-only.
- **wallet ↔ invoicing "pay invoice from wallet"** (`wallet/services/walletInvoice.js`,
  `wallet/routes/me.js`) writes `inv_invoice*` / reads `inv_qr_codes` → future: an
  invoicing-provided pay/read hook so wallet stops writing `inv_*` directly.

## Adding a table

- Product table → name it with the module prefix (`inv_`/`mw_`), add an idempotent
  `CREATE TABLE IF NOT EXISTS` migration under `prisma/migrations/`.
- Core table/model → add to `prisma/schema.prisma` and list the model in
  `_domains.js` `CORE_MODELS` so the lint knows products may not touch it.
- New cross-domain need → prefer a hook over a direct query, and record it in
  `_domains.js` (`CORE_TO_PRODUCT_HOOKS` or `KNOWN_EXCEPTIONS`).
