# ANNEX A — Architecture and Data Flow Diagram
### Paylode Services Limited · Alpha Morgan Bank AMB-ISO-VRQ-019 · CONFIDENTIAL

**Answers:** Section B ("Attach an Architecture / Data Flow Diagram"), item 13.9
("Is a current Data Flow Diagram available showing all Bank data exchanges?")

**Status:** [VERIFIED] — derived from the production codebase.
**Source of truth:** `backend/src/appFactory.js`, `backend/src/modules/`,
`docs/DEPLOYMENT.md`, `nginx/`, `.github/workflows/deploy.yml`.

---

## A.1 System context

Paylode is a CBN-licensed Payment Solution Service Provider operating a payment
gateway, virtual-account collections, invoicing, payouts and a closed-loop member
wallet. Alpha Morgan Bank is proposed as a **provider of two services to Paylode**:
virtual accounts for collections, and a payout rail for disbursements.

```mermaid
flowchart LR
  subgraph Payers["Payers / end customers"]
    P1["Merchant's customer<br/>(bank transfer to a VA)"]
    P2["Merchant's customer<br/>(card / checkout)"]
  end

  subgraph Paylode["Paylode Services Limited — PSSP platform"]
    direction TB
    FE["Web frontend<br/>checkout · merchant dashboard"]
    API["Paylode API<br/>Express / Node 18 · PostgreSQL"]
    LED["Ledger, settlement<br/>and reconciliation engine"]
  end

  subgraph Banks["Bank & rail partners"]
    AMB["ALPHA MORGAN BANK<br/>VA issuance + payout rail<br/>(proposed)"]
    PP["PalmPay<br/>VA + payouts (live)"]
    PX["Parallex Bank<br/>VA + payouts + cards (live)"]
    ISW["Interswitch<br/>card switch (live)"]
  end

  subgraph Merchants["Paylode merchants"]
    M1["Merchant settlement<br/>bank account"]
    B1["Payout beneficiaries"]
  end

  P1 -->|"NIP credit to VA"| AMB
  P2 --> FE --> API
  AMB -->|"collection webhook"| API
  PP  -->|"collection webhook"| API
  PX  -->|"collection webhook"| API
  ISW -->|"card auth result"| API
  API --> LED
  LED -->|"settlement instruction"| M1
  API -->|"payout instruction (API)"| AMB
  AMB -->|"NIP transfer"| B1
  API -->|"payout instruction (API)"| PP
  API -->|"payout instruction (API)"| PX

  classDef bank fill:#0b3d5c,stroke:#062a40,color:#fff
  class AMB bank
```

**Bank data exchanged with Alpha Morgan Bank — two directions only:**

| Direction | Channel | Payload |
|---|---|---|
| Paylode → Bank | HTTPS REST, outbound from a fixed IP | VA creation request (customer name, reference, identity type/number where the Bank requires it); payout instruction (beneficiary bank code, account number, account name, amount, narration, unique reference); name-enquiry request; balance / statement query |
| Bank → Paylode | HTTPS webhook to a published Paylode endpoint, signature-verified | Collection notification (VA number credited, amount, payer name/bank, session ID, timestamp); payout status callback (reference, status, session ID, failure reason) |

No direct database connection, no file transfer, and no SFTP drop is requested or
required. The integration type answered in Section A is **API only**.

---

## A.2 Deployment architecture (as built)

```mermaid
flowchart TB
  U["Merchants · payers · admin users"]

  subgraph CF["Cloudflare — CDN, TLS termination at edge, DDoS absorption"]
    CFE["paylodeservices.com<br/>billspay.net<br/>api.paylodeservices.com"]
  end

  subgraph S45["WEB TIER — 45.141.122.223 (internet-facing)"]
    NG45["nginx<br/>:443 TLS (Let's Encrypt)<br/>static /var/www/paylode"]
  end

  subgraph S176["APPLICATION + DATA TIER — 176.57.188.45"]
    NGR["nginx path router :3000"]
    CORE["pm2 paylode-core :3001<br/>(cluster x2)<br/>money core, payouts,<br/>settlement, KYC, admin"]
    INV["pm2 paylode-invoicing :3101"]
    WAL["pm2 paylode-wallet :3102"]
    AST["pm2 paylode-assistant :3103"]
    WKI["pm2 invoicing-worker"]
    WKW["pm2 webhook-worker"]
    PG[("PostgreSQL :5432<br/>localhost bind")]
    RD[("Redis :6379<br/>BullMQ queues")]
  end

  subgraph EXT["Sub-processors / partners (egress over TLS)"]
    RAILS["PalmPay · Parallex · Interswitch"]
    KYCP["YouVerify (KYC/AML)"]
    CLD["Cloudinary (document storage)"]
    MSG["Sendchamp (SMS/WhatsApp) · SMTP (email)"]
  end

  U --> CFE --> NG45
  NG45 -->|"/api/ reverse proxy<br/>server-to-server"| NGR
  NGR --> CORE
  NGR --> INV
  NGR --> WAL
  NGR --> AST
  CORE --> PG
  INV --> PG
  WAL --> PG
  AST --> PG
  CORE --> RD
  RD --> WKI
  RD --> WKW
  WKW -->|"signed merchant webhooks"| U
  CORE --> RAILS
  CORE --> KYCP
  CORE --> CLD
  CORE --> MSG
```

**Key properties (verified):**

- Two-tier split: the internet-facing box (45) serves **static assets only** and
  reverse-proxies `/api/` to the application box (176). No application code and
  no database runs on 45.
- PostgreSQL and Redis on 176 are **not published to the internet** — they are
  reached over loopback by the Node processes on the same host.
- A single nginx router on 176 listens on `:3000` and path-routes to four pm2
  services, so the public URL surface is identical whether the platform runs as
  the monolith or as split services (`nginx/paylode-176-router.conf`).
- Every process shares one middleware stack built by `backend/src/appFactory.js` —
  helmet, CORS allow-list, rate limiting and the error handler cannot drift
  between services.

---

## A.3 Bank data flow — Virtual Account collections (proposed Alpha Morgan flow)

```mermaid
sequenceDiagram
  autonumber
  participant C as Payer (merchant's customer)
  participant AMB as Alpha Morgan Bank
  participant API as Paylode API (176)
  participant DB as PostgreSQL (176)
  participant Q as Redis / BullMQ
  participant M as Merchant system

  Note over API,AMB: Provisioning (once per customer)
  API->>AMB: POST create virtual account<br/>{customer name, reference, identity data}
  AMB-->>API: {virtualAccountNo, accountName, status}
  API->>DB: persist VA ↔ merchant/customer mapping

  Note over C,AMB: Collection (per payment)
  C->>AMB: NIP transfer to the dedicated VA
  AMB->>API: POST webhook {VA no, amount, payer, sessionId, ref}
  API->>API: verify signature over raw body<br/>(timing-safe compare)
  API->>DB: idempotency check on provider reference
  API->>DB: write transaction + ledger entries (kobo, BigInt)
  API->>API: AML rule evaluation (amlService.js)
  API->>Q: enqueue merchant webhook
  Q->>M: signed webhook (HMAC-SHA512, X-Paylode-Signature)
  API->>DB: settlement scheduled per merchant cycle (default T+1)
```

**Controls on this path (verified):**

| Control | Implementation |
|---|---|
| Webhook authenticity | Raw body preserved for `/api/v1/webhooks/inbound` before JSON parsing (`appFactory.js`) so the signature is verified over exact bytes; comparison uses `crypto.timingSafeEqual` (`utils/helpers.js`). |
| Replay / duplicate credit | Provider reference is the idempotency key; a repeated notification does not create a second ledger entry. |
| Monetary precision | All amounts held in **kobo as integers** (`BigInt`), never floating point. |
| Money-laundering surveillance | `services/amlService.js` evaluates every transaction against tier limits, velocity and structuring rules, and raises rows in `aml_flags` for compliance disposition. |
| Merchant notification | Delivered asynchronously through Redis/BullMQ by a dedicated `webhook-worker` process, with retry — a slow merchant endpoint cannot block the Bank-facing path. |

---

## A.4 Bank data flow — Payouts / disbursements (proposed Alpha Morgan flow)

```mermaid
sequenceDiagram
  autonumber
  participant M as Merchant (dashboard or API key)
  participant API as Paylode API
  participant DB as PostgreSQL
  participant W as Wallet / rail float
  participant AMB as Alpha Morgan Bank
  participant B as Beneficiary

  M->>API: POST /payouts/batches {recipients[]}
  API->>API: authenticate (JWT or sk_live_ key)<br/>+ live-mode gate (merchant.liveEnabled)
  API->>DB: validate beneficiaries, resolve bank codes
  API->>W: check prepaid rail float AND daily value cap<br/>(inside one DB transaction)
  alt insufficient float or cap exceeded
    API-->>M: reject — DAILY_CAP / INSUFFICIENT_FUNDS
  else funded
    API->>DB: debit merchant wallet, create batch<br/>status = pending_review
    Note over API: recall / review window<br/>(per-merchant, seconds)
    API->>AMB: name enquiry per beneficiary
    AMB-->>API: resolved account name
    API->>AMB: transfer instruction (unique reference)
    AMB-->>API: accepted / rejected
    AMB->>API: status webhook (success / failure)
    API->>DB: mark item settled, or fail + auto-refund wallet
    AMB->>B: NIP credit
  end

  Note over API,DB: watchdogs
  API->>DB: stuck-payout monitor every 5 min
  API->>AMB: re-query true status of items processing > 15 min
```

**Controls on this path (verified):** see `ANNEX-F` for the full Domain 16
response. In summary: payouts are **prepaid** (a merchant can only disburse funds
already funded into a per-rail wallet), guarded by a per-rail **daily value cap**
and **TPS limit**, held in a **recall window** before dispatch, **name-enquiry
validated** before transfer, and reconciled by two independent watchdogs that
auto-refund the merchant wallet on confirmed failure.

---

## A.5 Where Bank data comes to rest

```mermaid
flowchart LR
  subgraph NG["Nigeria"]
    APP["Paylode application + PostgreSQL<br/>176.57.188.45 · Contabo VPS"]
  end
  subgraph OFF["Outside Nigeria — GAP, see GAP-REGISTER GAP-08"]
    CLD["Cloudinary<br/>KYC document images"]
    CFP["Cloudflare edge<br/>TLS termination, no payload storage"]
    ANT["Anthropic API<br/>support assistant text"]
  end
  APP --> CLD
  APP --> ANT
  APP --- CFP
```

The transactional record — VA mappings, transactions, ledger, settlements,
payouts, audit log — is held in a single PostgreSQL instance on the Nigerian
application host. **KYC document images are stored with Cloudinary and the
in-product assistant sends support text to the Anthropic API; both are outside
Nigeria.** This is disclosed honestly at items 7.2 and 13.4 and is tracked as a
remediation item, not claimed as compliant. See `ANNEX-G` and `GAP-REGISTER.md`.

---

## A.6 Trust boundaries

| # | Boundary | Crossing control |
|---|---|---|
| 1 | Internet → Cloudflare edge | TLS 1.2+; Cloudflare DDoS absorption and CDN |
| 2 | Cloudflare → nginx on 45 | HTTPS, Let's Encrypt certificate, HSTS `max-age=31536000; includeSubDomains` |
| 3 | nginx on 45 → nginx on 176 | Server-to-server proxy; **[GAP]** currently traverses the provider network in the clear between the two hosts — see GAP-02 (private networking / WireGuard) |
| 4 | nginx router → pm2 services | Loopback only |
| 5 | Application → PostgreSQL / Redis | Loopback only, not internet-exposed |
| 6 | Application → Bank / rails / sub-processors | Outbound HTTPS from a fixed IP; per-provider credentials in environment configuration |
| 7 | Application → merchant endpoints | Outbound signed webhooks (HMAC-SHA512) |
