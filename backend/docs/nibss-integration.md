# NIBSS integration notes — NPS (payments) + FAS (identity)

Two SEPARATE NIBSS products, each with its own agreement, documentation and
credentials:

- **NPS** — the **ISO 20022** replacement for NIP (NIP spoke SOAP). Carries
  **payouts** and **virtual accounts**.
- **FAS** (Financial Authentication Service) — **identity verification**,
  confirmed by NIBSS to cover **BVN and NIN**.

They are kept as separate self-contained clients with separate env prefixes
(`NIBSS_NPS_*` / `NIBSS_FAS_*`) and no cross-imports — the same structure the
Parallex products use in production (`parallexService` vs
`parallexTransferService`). FAS settings fall back to their NPS equivalents, so a
single credential set works if NIBSS issues one.

Status: **client, rail adapter and callbacks built and DORMANT.** Nothing calls out
until `NIBSS_NPS_CLIENT_ID` and `NIBSS_NPS_PRIVATE_KEY` are set, and the rail row is
registered `CONFIG_ONLY` so routing cannot select it.

---

## 1. Outstanding with NIBSS (blockers — none are code)

| # | Item | Notes |
|---|------|-------|
| 1 | Team email addresses | For NIBSS's support Teams group |
| 2 | **IP Form** | Submitted. Requests **165.22.21.63** (DO droplet — IPSec peer + egress) and **176.57.188.45** (app server behind the tunnel). VPN-peer IP = 165.22.21.63 |
| 3 | **FAS agreement** | Separate commercial agreement to execute before FAS integration |
| 4 | Sandbox credentials | client id/secret, our 6-digit **institution code**, payout **float NUBAN**; confirm whether FAS creds are separate |
| 5 | Key exchange | Send our RSA public key; receive NIBSS's for callback verification |
| 6 | Pricing | Per payout / VA / identity check — nothing seeded into `rail_costs` until agreed |
| 7 | Certification | Sandbox testing + schema validation + sample scenarios before go-live |
| 8 | **Confirm RC/TIN home** | NIBSS confirmed FAS covers BVN + NIN; whether RC and TIN sit under FAS or NPS is unconfirmed |

### Connectivity (mirrors the live Parallex model)
Traffic reaches NIBSS over a site-to-site **IPSec IKEv2** tunnel terminating on the
DigitalOcean node **165.22.21.63**; the app server **176.57.188.45** sits behind it
and reaches NIBSS through the tunnel. Paylode already runs a production tunnel from
that same node to Parallex, so the NIBSS tunnel is a **separate Phase-2 selector on
the same peer** — a distinct local selector (proposed `10.254.254.2/32`) is required
to avoid colliding with the live Parallex selector `10.254.254.1/32`.

> ⚠️ Both NIBSS portals — NPS docs (`nps-documentation.nibss-plc.com.ng`) and the
> FAS API docs (`devportal.nibss-plc.com.ng/api-docs/...`) — are
> **IP-allowlisted** and were unreachable while this was built. Endpoint paths and
> field names are derived from the ISO 20022 message definitions NPS is specified
> against. **Every path is env-overridable and response parsing accepts both the
> nested ISO shape and a flattened REST shape**, so the first sandbox run can
> correct the contract without a code change. Reading the portal and confirming
> the paths is the first job once the IP Form clears.

---

## 2. Message map

| Flow | ISO 20022 | Default path (env-overridable) |
|------|-----------|-------------------------------|
| Name enquiry | `acmt.023` → `acmt.024` | `NIBSS_NPS_NAME_ENQUIRY_PATH` |
| Payout | `pacs.008` | `NIBSS_NPS_TRANSFER_PATH` |
| Payout status | `pacs.028` → `pacs.002` | `NIBSS_NPS_STATUS_PATH` |
| Recall | `camt.056` → `camt.029` | `NIBSS_NPS_RECALL_PATH` |
| Balance (our float) | `camt.052` | `NIBSS_NPS_BALANCE_PATH` |
| VA credit callback | `camt.054` | inbound |
| Identity (FAS — separate product) | REST | `NIBSS_FAS_{BVN,NIN,RC,TIN}_PATH` |

**Auth:** OAuth2 client-credentials → Bearer (token cached; a 401 refreshes and
replays once) **plus** a detached **RSA-SHA256** signature over the exact request
bytes in the `Signature` header, with `X-Request-Id` / `X-Institution-Code` /
`X-Channel-Code`.

---

## 3. Callbacks

Mounted at `/api/v1/webhooks/nibss` (disable with `MODULE_NIBSS_WEBHOOK_ENABLED=off`):

| Path | Message | Behaviour |
|------|---------|-----------|
| `POST /payout` | `pacs.002` | Maps `TxSts` → our `orderStatus`, hands off to the shared `applyPayoutResult` |
| `POST /va-credit` | `camt.054` | Finalizes a PENDING checkout txn tagged `nps_va_no` |
| `POST /recall` | `camt.029` | Logged only — no money moves here |
| `POST /` (+ catch-all) | any | Routes on message type; never 404s |

Each is signature-verified against `NIBSS_NPS_PUBLIC_KEY`. Until that key is
issued, callbacks are accepted with a loud warning (scaffold mode) — the same
stance `palmpay-webhook.js` takes, so sandbox testing isn't blocked on key exchange.

Replies use ISO status words: `{"status":"ACSC"}` on success, `{"status":"RJCT"}`
on rejection. **Confirm the expected ACK format during certification** — NIBSS may
require a specific acknowledgement body.

### Raw body — important
`req.rawBody` is captured by a **path-scoped** `express.json({ verify })` in
`appFactory.js`, **not** in the router. The global `express.json()` runs first and
sets `req._body`, so a second parser inside the router silently no-ops and
`rawBody` would stay null — breaking signature verification on every callback.
NIBSS signs the bytes it sent; re-serialising a parsed body can reorder keys.

---

## 4. Money-safety rules encoded here

- **Amounts.** ISO 20022 carries **decimal NGN** (`"50000.00"`); Paylode is **kobo**
  internally. Convert at the client boundary only.
- **Unknown `TxSts` ⇒ IN-FLIGHT, never failed.** `ACSC`/`ACCC` → success;
  `RJCT`/`CANC`/`RVSD`/`EXPI` → failed; everything else → in flight. Refunding a
  transfer that may have settled at NIBSS is the one unrecoverable mistake — the
  stuck-'sent' poller resolves the ambiguity instead.
- **A transport/HTTP failure is not a rejection.** `sendPayout` returns
  `orderStatus: null` so the leg stays in flight rather than being refunded.
- **`EndToEndId` = our `rail_order_id`**, echoed back by `pacs.002`. It must stay
  stable for the leg's lifetime or reconciliation breaks.
- **A VA credit with no parseable amount is NOT credited** — passing `null` would
  disable the exact-amount check and credit an underpayment in full.

---

## 5. Not wired yet (deliberate)

- **FAS is not on the live KYC path.** `documents.js` / `kyc.js` / `kycOrchestrator`
  still use `youverifyService`. Switching is a commercial decision (per-check price)
  **and** is gated on the FAS agreement being executed. `nibssFasService` returns the
  identical `normalise()` shape and aliases `verifyCac`, so the swap is a one-line
  require change. FAS does **not** cover facial liveness, PEP, sanctions or adverse
  media — those stay with the incumbent provider regardless.
- **Static per-merchant VA collections.** That path deducts a merchant-funded fee
  and books a collection; the fee math currently lives inline in
  `palmpay-webhook.js`. Lifting it into a shared service is a money-path refactor
  that needs its own change and sign-off — until then an unmatched NPS credit is
  logged for manual handling rather than half-credited. Dynamic checkout VAs are
  handled.
- **`pacs.004` return/reversal leg.** A VA amount mismatch is flagged for manual
  treasury action instead of auto-reversed.
- **Rail costs / go-live.** Rail stays `CONFIG_ONLY` with `payout_enabled=false`
  and no `rail_costs` rows until NIBSS advises pricing and money sign-off is given.

---

## 6. Files

| File | Purpose |
|------|---------|
| `src/modules/gateway-core/services/nibssNpsService.js` | Client + ISO 20022 builders + rail adapter |
| `src/services/nibssFasService.js` | FAS identity — BVN / NIN (+ RC/TIN, unconfirmed); self-contained, shared `normalise()` shape |
| `src/modules/gateway-core/routes/nibss-webhook.js` | Callbacks |
| `src/modules/gateway-core/services/payoutRailAdapter.js` | Rail registration |
| `src/appFactory.js` | Path-scoped raw-body capture |
| `prisma/manual_sql/20260915_nibss_nps_rail.sql` | Registers the rail `CONFIG_ONLY` |
| `test/nibss-nps.unit.test.js` | 57 tests — no DB, no network |

Run the tests: `node test/nibss-nps.unit.test.js`

---

## 7. Environment

```
NIBSS_NPS_CLIENT_ID=            # required — gates everything
NIBSS_NPS_PRIVATE_KEY=          # required — our RSA key (PEM or bare base64)
NIBSS_NPS_CLIENT_SECRET=
NIBSS_NPS_PUBLIC_KEY=           # NIBSS's key — verifies inbound callbacks
NIBSS_NPS_BASE_URL=https://nps-sandbox.nibss-plc.com.ng
NIBSS_NPS_AUTH_URL=             # defaults to BASE_URL
NIBSS_NPS_INSTITUTION_CODE=     # our 6-digit code, via sponsor bank
NIBSS_NPS_DEBIT_ACCOUNT=        # payout float NUBAN
NIBSS_NPS_DEBIT_NAME=Paylode Services
NIBSS_NPS_CHANNEL_CODE=1
NIBSS_NPS_NOTIFY_URL=           # our webhook base
NIBSS_NPS_TIMEOUT_MS=30000
```

FAS (each falls back to its `NIBSS_NPS_*` equivalent when unset):
```
NIBSS_FAS_CLIENT_ID=
NIBSS_FAS_CLIENT_SECRET=
NIBSS_FAS_PRIVATE_KEY=
NIBSS_FAS_BASE_URL=
NIBSS_FAS_AUTH_URL=
NIBSS_FAS_ORGANISATION_CODE=
NIBSS_FAS_TIMEOUT_MS=30000
```

Path overrides (use these to correct the contract after reading the portals):
`NIBSS_NPS_TOKEN_PATH`, `_NAME_ENQUIRY_PATH`, `_TRANSFER_PATH`, `_STATUS_PATH`,
`_RECALL_PATH`, `_BALANCE_PATH`, `_BANKS_PATH`, `_VA_CREATE_PATH`,
`_VA_QUERY_PATH`; and for FAS `NIBSS_FAS_TOKEN_PATH`, `_BVN_PATH`, `_NIN_PATH`,
`_RC_PATH`, `_TIN_PATH`.

---

## 8. Go-live sequence

1. IP Form cleared → **read BOTH portals (NPS docs + FAS api-docs), correct any
   path/field via env**. Execute the FAS agreement in parallel.
2. Sandbox creds + key exchange → set env on 176, `pm2 reload paylode-api`.
3. Apply `20260915_nibss_nps_rail.sql` on 176 (safe any time — changes no routing).
4. Name enquiry first (read-only), then a ₦100 payout to a known test account.
5. Confirm the `pacs.002` callback lands and settles the leg; confirm the ACK format.
6. Certification scenarios with NIBSS.
7. Seed `rail_costs` once pricing is agreed → **money sign-off** → flip the rail to
   `TESTING`, then `LIVE`, and set the payout route in the Rail Routing Matrix.
