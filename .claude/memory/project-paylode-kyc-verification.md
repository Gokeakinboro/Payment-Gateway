---
name: project-paylode-kyc-verification
description: "Paylode KYC per-requirement verification model — PASS/FAIL/UNKNOWN + comments, API-or-manual checks with field matching. Spec'd 2026-06-16."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5042ea10-d387-4f4d-ace7-9c60ba872118
---

# Paylode KYC Verification (per-requirement)

## ✅ DEPLOYED 2026-06-16 — manual per-requirement verification + form fixes
- Per-requirement **PASS/FAIL/UNKNOWN + Comments** (≤200 chars, viewable, SA-removable) LIVE: documents.js→176, api-wiring.js→45 (v53), DB on 176. Verified (docs endpoint returns result+comments). Manual review path works end-to-end (compliance/admin/SA set result + comment; SA removes comments).
- Onboarding form (→45): MCC + Expected Value/Count now INTL/MPGS-only (hidden for local + aggregators); Payment Options = Local Cards · International Cards · Virtual Accounts (Pay-in) · Payouts; Webhook+Callback URLs REMOVED (belong in dashboard Developer settings). TIN = number-only (no upload; captured on Business Details). Cert reg number + date of incorporation already captured on Business Details. CAC Status Report optional + "Status Report not available" checkbox reveals Form CO2 (shareholders) + CO7 (directors) uploads (validation: status report OR both CO forms). Gated preview: /onboarding?preview=gk-review-9X4kQ2.
- Doc VIEWER (view+download uploaded onboarding files) live (earlier).

## ✅ INTERSWITCH chosen as KYC provider (user, 2026-06-17) — replaces YouVerify
User sorting agreement/keys separately; said "start the work to use them for our kyc". Docs: developer.interswitchgroup.com + docs.interswitchgroup.com/v1.1/docs/kyc-and-identity-verification-overview. Interswitch data-service offers BVN (full + boolean), NIN (full), business/CAC, account, physical-address verification.
- **Auth:** OAuth2 client-credentials → POST `{passport}/passport/oauth/token`, `Authorization: Basic base64(clientId:secret)`, `grant_type=client_credentials`, x-www-form-urlencoded → access_token (Bearer). Sandbox passport=`https://sandbox.interswitchng.com`, prod=`https://passport.interswitchng.com`.
- **Identity (BVN/NIN):** POST `https://api-gateway.interswitchng.com/isw-data-service/api/v1/request/verification`, Bearer, body `{validationType:'BVN'|'NIN', validationId, firstname, lastname, birthDate(yyyy-MM-dd), gender, phone}` → `{responseCode:'00', data:{status:'VERIFIED', identityNumber, firstName, lastName, birthDate, reference}}`. NOTE: Interswitch ACCEPTS+matches name/DOB server-side (opposite of YouVerify which rejected them).
- **BUILT (scaffold, commit 3addfcc):** `backend/src/services/interswitchKycService.js` — SEPARATE from existing `interswitchService.js` (that one = Interswitch CARD-PAYMENT client: purchases/OTP/verifyTransaction). KYC service: getAccessToken (cached) + verifyBvn/verifyNin + verifyCac/verifyAddress (paths TODO-confirm) + normalise() returning the SAME shape as youverifyService → drops into per-requirement PASS/FAIL framework. Env: ISW_KYC_CLIENT_ID/SECRET (fall back to ISW_CLIENT_ID/SECRET), ISW_KYC_AUTH_URL, ISW_KYC_BASE_URL, ISW_KYC_ENV. DORMANT until keys set (build-ahead-of-keys, like PalmPay).
- **PENDING from user:** subscribe the data-service KYC products in the Interswitch Developer Console + provide sandbox CLIENT_ID/SECRET → then test BVN/NIN live + CONFIRM exact CAC + address endpoint paths/payloads (currently best-guess `/business-verification` `/address-verification`). Then wire into documents.js verification flow + matchAgainstForm.

## 🛑 YOUVERIFY ABANDONED (user, 2026-06-17) — "not worthwhile". Do NOT pursue subscribing/fixing it. KYC verification waits for the REPLACEMENT provider (TBD). The integration code stays (harmless; the firstname/lastname fix is committed) but is dormant. When the replacement is chosen, plug it into the per-requirement PASS/FAIL framework + match-on-our-side pattern.

## Verification SPEC (user, 2026-06-16) — each requirement checked via API OR manual
- **ID details (API):** match `id_number` + `expiry` + **NAME EXACTLY** (last/first/middle) vs what was provided on the form; any mismatch → **flag exception** (don't silently pass).
- **Address:** MANUAL (upload a verification report against the merchant's utility bill) OR **API** (utility bill is API-verifiable).
- **CAC:** Incorporation Certificate **API** → MATCH/FAIL on registration number + company name provided. MEMART, Status Report, Form CO2 & CO7 (if no status report) → **MANUAL** pass/fail/comments.
- BVN/NIN: API name(+DOB) match (YouVerify already integrated).
- User: "free to enhance — but ALWAYS keep merchant/aggregator EXPERIENCE in mind."

## Design (proposed)
- Per requirement add: `method` (api|manual), `exception`(bool)+`exception_reason`, `report_file` (manual report upload, e.g. address), reuse `provider/provider_ref/verified_at/result_raw`.
- Reusable **matchAgainstForm()** engine: compares provider/manual data to FORM data → pass/fail + exception code (NAME_MISMATCH, ID_NUMBER_MISMATCH, EXPIRED, RC_MISMATCH, COMPANY_NAME_MISMATCH). Reviewer can override + comment.
- API path wired now for what we HAVE = YouVerify (BVN, NIN, CAC-cert RC#+name). ID-document / address / utility-bill providers = PLUGGABLE (provider TBD — Dojah/Interswitch per [[project-paylode]]); framework ready, specific provider plugs in when chosen (clean boundary = user's provider decision, not an open task).
- Manual path fully works now (pass/fail/comments + report upload).

## UX guardrails (user emphasis)
- Don't block the merchant/aggregator: verification runs async after submit; surface friendly status ("under review" / "please re-upload X"), never raw provider errors. Sandbox keys already work pre-KYC.

## Deploy note (post server-migration)
Backend (documents.js, youverify, etc) → 176 via deploy.py. Frontend (api-wiring.js, onboarding.html, dashboard.html) → **45** via scp + cache bump. See [[project-server-migration]].
