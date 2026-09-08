# ANNEX E — Cryptography and Key Management
### Paylode Services Limited · Alpha Morgan Bank AMB-ISO-VRQ-019 · CONFIDENTIAL

**Answers:** Domain 9 (9.1–9.8), items 5.6, 5.7, 6.4
**Status:** [VERIFIED] against `backend/src/utils/helpers.js`, `middleware/auth.js`,
`appFactory.js`, `nginx/`.

---

## E.1 Cryptographic inventory

| Purpose | Algorithm | Parameters | Source |
|---|---|---|---|
| Application-layer field encryption (settlement account numbers) | **AES-256-GCM** | 256-bit key from `ENCRYPTION_KEY`; 96-bit random IV per operation; 128-bit authentication tag; stored as `iv:tag:ciphertext` hex | `utils/helpers.js` |
| API key storage | **SHA-256** | One-way; lookup by hash; plaintext never persisted | `utils/helpers.js`, `middleware/auth.js` |
| API key generation | **CSPRNG** | `crypto.randomBytes(24)` — 192 bits of entropy, prefixed `sk_live_` / `sk_test_` | `utils/helpers.js` |
| Password storage | **bcrypt** | Adaptive work factor | `routes/auth.js`, `services/reauth.js` |
| Webhook signing | **HMAC-SHA512** | Per-merchant secret; header `X-Paylode-Signature` | `utils/helpers.js` |
| Webhook verification | HMAC-SHA512 + **`crypto.timingSafeEqual`** | Constant-time comparison over the raw request body | `utils/helpers.js` |
| Second factor | **TOTP (RFC 6238)** | HMAC-SHA1, 6 digits, 30-second step, ±1 step window | `routes/auth.js`, `services/reauth.js` |
| Session tokens | **JWT HS256** | Secret from `JWT_SECRET`; role re-read from the database each request | `middleware/auth.js` |
| Transport | **TLS 1.2 minimum, TLS 1.3 preferred** | Let's Encrypt certificates, Certbot-managed renewal, `ssl_dhparam`; HSTS `max-age=31536000; includeSubDomains` | `nginx/paylode.conf`, `appFactory.js` |
| Reference generation | CSPRNG | `crypto.randomBytes` | `utils/helpers.js` |

**9.1 — Data at rest: answer "Partial", and be precise about why.** Sensitive
fields are AES-256-GCM encrypted at the application layer and credentials are
hashed, which is the strongest part of the posture. **Full-disk / volume
encryption on the Contabo VPS hosts and PostgreSQL transparent data encryption
are not confirmed.** Verify the host disk encryption status before responding; if
absent, that is GAP-14 and it is straightforward to remediate on rebuild.

**9.2 — Data in transit: answer "Yes."** TLS 1.2 minimum everywhere, TLS 1.3 at
the Cloudflare edge, HSTS with a one-year max-age including subdomains, and all
outbound partner calls over HTTPS. Attach a testssl.sh or SSLLabs report for
`api.paylodeservices.com` as evidence.

**9.6 — Card data: answer "Yes."** Paylode does not store PAN, CVV or PIN in
plaintext anywhere. Card acceptance runs through Interswitch and the Parallex/MPGS
rail; `utils/helpers.js` handles only **scheme detection from a BIN prefix**, and
the card number is not persisted. `detectCardScheme()` is the only card-number
handling in the codebase and it retains nothing.

---

## E.2 Key inventory and lifecycle (9.4, 9.5, 5.7)

| Key / secret | Owner | Storage today | Rotation | Blast radius |
|---|---|---|---|---|
| `ENCRYPTION_KEY` (AES-256 field encryption) | Paylode CTO | Environment variable on 176 | **[GAP] no rotation performed** — GAP-15 | Settlement account numbers |
| `JWT_SECRET` | Paylode CTO | Environment variable on 176 | **[GAP] no schedule** | All active sessions (rotation forces re-login — acceptable) |
| Merchant API keys (`sk_live_`, `sk_test_`) | Merchant | SHA-256 hash in database | Merchant-initiated; **[GAP]** no enforced maximum age — the Bank asks for ≤90 days at 6.4 | One merchant |
| Per-merchant webhook secrets | Merchant | Database | Merchant-initiated, requires step-up re-auth | One merchant |
| Rail/partner API credentials (PalmPay, Parallex, Interswitch, YouVerify, Cloudinary, Sendchamp) | Paylode CTO | Environment variables on 176 | Per partner policy | One partner integration |
| **Alpha Morgan Bank credentials / client certificate** | Paylode CTO | To be held in environment configuration, **or in the secrets manager once GAP-05 is closed** | Per the Bank's policy — Paylode will meet a ≤90-day rotation if the Bank requires it | The Bank integration |
| TLS server certificates | Certbot on 45 | `/etc/letsencrypt/` | **Automatic**, 90-day Let's Encrypt lifetime | Public web/API TLS |
| Deploy SSH key (`github-actions-deploy-paylode`, ed25519) | Paylode CTO | GitHub Actions secret | **[GAP] no schedule** | Frontend deploy path to both hosts |

**9.3 — FIPS 140-2/3 validated HSM or KMS: answer "No."** Paylode does not
operate an HSM and does not use a cloud KMS; keys are held as environment
configuration on the application host. Do not claim otherwise — this is trivially
falsifiable and it is the kind of overclaim that ends an onboarding. State the
compensating controls (AES-256-GCM with per-operation IVs and authentication
tags; hashed credentials; no key material in source control once GAP-05 is
closed) and attach the GAP-16 remediation: migrate to a managed secrets store
with envelope encryption and audited access.

**9.4 — Key ownership: Paylode owns and controls all keys protecting Paylode
systems.** Alpha Morgan Bank retains ownership of any credential or certificate
the Bank issues; Paylode will store it under the same controls and will surrender
or destroy it on termination per Section F.

---

## E.3 Secrets management (5.6, 5.7) — including an open finding

**Design intent, verified:** no secret is hardcoded in application source. All
credentials are read from environment variables (`process.env.*`); the repository
ships `backend/.env.example` with placeholder names only and `.env` is
git-ignored; `docs/DEPLOYMENT.md` explicitly states the deploy password is
supplied at runtime and never committed.

**Open finding — GAP-05, must be closed before 5.6 is answered "Yes":**
`.claude/memory/project-paylode.md` is **tracked in git** and contains a
production server root SSH password, a live YouVerify API key and a webhook
signing secret. The adjacent `.claude/memory/.gitignore` excludes five
`reference-*-creds.md` files but does not cover this one.

Required remediation, in order:
1. **Rotate** the exposed credentials — server root password (and disable password
   SSH entirely in favour of the existing key-based access), the YouVerify API
   key, and the webhook signing secret.
2. **Purge** them from git history (`git filter-repo`) and force-update the remote,
   or treat the exposed values as permanently burned.
3. **Extend** `.claude/memory/.gitignore` to exclude every file that can carry a
   credential, and add a pre-commit secret scanner (`gitleaks`) plus GitHub push
   protection so this cannot recur.
4. Only then answer 5.6 "Yes", and attach the gitleaks clean-scan output as the
   "secrets scanning evidence" the question asks for.

**6.4 — API key rotation ≤90 days: answer "Partial."** Rotation is supported and
self-service, and revocation is immediate, but no maximum key age is enforced.
Implementing an expiry field with merchant warning notices is a small change and
converts this HIGH item to "Yes" — GAP-17.

---

## E.4 Integrity verification (9.7)

| Control | Detail |
|---|---|
| Webhook payload integrity | HMAC-SHA512 over the exact raw bytes, constant-time verified |
| Deployment integrity | `tools/deploy.py` computes and compares **md5(local) vs md5(remote)** for every uploaded file and aborts on mismatch; it also refuses to ship files with uncommitted local changes, so production is a faithful copy of a committed revision |
| Syntax gate | `tools/check-syntax.mjs` parses every file before any upload; a parse error aborts the entire deploy |
| Ledger integrity | Double-entry `wallet_ledger` rows; monetary values are integer kobo (`BigInt`), never floats, so no rounding drift |
| Source integrity | All changes flow through pull requests on GitHub; direct push to `main` is blocked |

**[GAP]** File integrity monitoring on the production hosts (AIDE, Wazuh FIM) is
not deployed — GAP-04.

---

## E.5 Certificate lifecycle (9.8)

- Public TLS certificates are Let's Encrypt, issued and renewed automatically by
  Certbot on a 90-day cycle. Renewal failure surfaces through the Certbot systemd
  timer.
- **[GAP]** There is no consolidated certificate inventory and no independent
  expiry alerting outside Certbot's own mechanism. Remediation: maintain the
  inventory in `policy/POL-07` Appendix A and add external expiry monitoring
  (uptime check with a certificate-expiry alert at 21 days) — GAP-18.
- Any client certificate issued by Alpha Morgan Bank for mTLS will be entered in
  that inventory with its expiry, owner and renewal trigger.
