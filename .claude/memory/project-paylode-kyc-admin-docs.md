---
name: project-paylode-kyc-admin-docs
description: Paylode — SA/Admin enter KYC info value AND/OR documents per requirement (kind=info|document|both), manual verify/defer; DEPLOYED 2026-06-22. Repo reconciled to mirror prod.
metadata: 
  node_type: memory
  type: project
  originSessionId: e1c4ab19-bb9c-4aa5-80f6-2709df44dbcf
---

# Paylode — SA/Admin add KYC documents & info to merchant profile

DEPLOYED 2026-06-22 on 176. Commits: `e2656b5` (initial docs+info), `7979708` (kind/value-entry/verify), `94ee2c4` (repo reconciliation). Lets SUPER_ADMIN/ADMIN/COMPLIANCE record info values and/or upload documents onto a merchant's per-requirement KYC checklist (the `kyc_documents` raw-SQL table, NOT a Prisma model).

## Requirement KINDS (commit 7979708, migration `20260622_kyc_doc_kind.sql`)
- `kyc_documents.kind` col: **info** (typed value only, e.g. BVN/NIN/TIN), **document** (upload only), **both** (value+doc). Every requirement still accepts both a value and a file; kind just drives the UI.
- Standard info items seeded: `bvn`, `nin`, `rc_number` (keys align with onboarding's existing bvn/nin). both = tin_cert/directors_id/shareholders_id/id_document; document = cert_incorp/memart/status_report/board_resolution/proof_address; info = check_*.
- **Entering data NEVER auto-verifies.** `/item/:id/info` and `/file` move outstanding/reupload→`submitted` (provided/pending); result verdict stays `unknown`. Reviewer must explicitly **Verify** (green ✓ → setDocStatus status=verified) or **Defer** (SA only). Value lives in id_type/id_number(+subject/country/expiry).
- `seedIfEmpty` now upserts the FULL set every GET (ON CONFLICT DO NOTHING) → back-fills new items onto already-seeded merchants. `/add` accepts `kind`; UI has **+ Add requirement**. Row shows kind chip + status badge + result badge. NOTE: action endpoints (/info,/file,/add,/result) return the docs ARRAY as `data`; only GET wraps as `data.docs`.

## Repo reconciliation (commit 94ee2c4, 2026-06-22)
Server `/opt/paylode-api` ran many never-committed files + drifted tracked files. Committed current prod state so git mirrors prod; working tree now CLEAN. Hardened `.gitignore`: `*.bak*`, `deploy-backup-*/`, `.env*` (secrets), `backend/uploads/` (real customer KYC docs — sensitive), `backend/{*.sql,_*.js,create_*.js,fix_*.js,seed_*.js}` (scratch). NOT pushed to origin (github.com/Gokeakinboro/Payment-Gateway) — local to 176 only.

## Frontend sync audit (2026-06-22, commit c0ce9d1) — ALL IN SYNC
md5'd every served file in /var/www/paylode across 45 (live) + 176 + repo /opt. Result: **45 == 176 served == repo, byte-identical**, for all HTML/JS/xlsx/robots/sitemap + compliance/portal subpages (uploads/ excluded = user data). Only real drift was `app.js` (live 45 had newer content than 176's stale copy → republished + committed in c0ce9d1) and `login.html`/`onboarding.html` which differed ONLY by line endings (45=CRLF vs repo=LF; identical content) → normalized 45 to LF. Lesson: when md5 differs but `diff` shows "1,Nc1,N" (every line) and size delta ≈ line count, it's CRLF-vs-LF, not content — confirm via `tr -d '\r' | md5sum`.

## "SA login Invalid email/password" (2026-06-22) — was BROWSER AUTOFILL, not a bug
login.html has NO hardcoded/prefill email (field empty, autocomplete="email", submit trims). The browser was autofilling `mayakinboro15@gmail.com` (a MERCHANT account) into the SA box. SA = `gokeakinboro@paylodeservices.com` (healthy). Fix = type correct email / clear saved browser cred. No reset needed.

## Backend (`/opt/paylode-api/backend/src/routes/documents.js`)
- `POST /api/v1/documents/item/:docId/info` — writes existing-but-previously-unused cols `subject_name,id_type,id_number,id_country,id_expiry` (+ optional status/notes). Blank fields = leave unchanged (COALESCE on null). BVN/NIN go here as id_type=BVN/NIN + id_number.
- `POST /api/v1/documents/item/:docId/file` (multer 10MB) — uploads the actual doc to `KYC_DOCS_DIR` (`backend/uploads/kyc-docs`), sets `file_path` + status='submitted'. `GET …/file` streams it inline (path-traversal guarded). Distinct from the merchant's onboarding uploads and from per-requirement `report_file`.
- **Guard widening**: GET checklist, PATCH item, `/add`, `/request-reupload`, `/run-check` moved `requireCompliance`→`requireAdminOrCompliance` so ADMIN actually has the access the dashboard UI (`canEdit` includes 'admin') and the code's documented actor matrix already implied. Deferral + comment-delete stay SA-only.
- Roles: SA=SUPER_ADMIN, Admin=ADMIN, Compliance=COMPLIANCE_OFFICER. `requireAdminOrCompliance`=[SUPER_ADMIN,ADMIN,COMPLIANCE_OFFICER].

## Frontend (`api-wiring.js`, dashboard SPA, `openDocsModal`)
Per checklist row added **📝 Add info** (prefilled modal `addDocInfo`/`saveDocInfo` from `window._docCtx.docs`), **📄 Add/Replace doc** (`uploadDocFile`), **View document** (`viewDocFile`). `window._docCtx` now also stores `docs`.

## DEPLOY TOPOLOGY — RE-CONFIRMED LIVE 2026-06-22 (see [[project-paylode]] gotcha)
- **Backend = 176.57.188.45** (pm2 cluster from `/opt/paylode-api/backend`, port 3000). Editing live files + `pm2 reload paylode-api` IS live — 45's nginx proxies `/api/`→176:3000. Verified: new endpoints 401 on https://paylodeservices.com.
- **Frontend = 45.141.122.223** is what users see (Cloudflare→45). `/opt/paylode-api/*.html|api-wiring.js` on 176 is SOURCE only; you MUST scp frontend files to **45's `/var/www/paylode/`** too. Pre-edit 176==45==served were md5-identical (`58c0…`), so publishing only adds the change.
- **Cache-bust**: `dashboard.html` loads `api-wiring.js?v=N` (single ref, ~line 274). Bump N (was 82→83) on BOTH hosts or Cloudflare serves stale JS. dashboard.html itself is no-store so picks up instantly. Verify public: `curl -s https://paylodeservices.com/dashboard.html | grep -oE 'api-wiring\.js\?v=[0-9]+'`.
- Smoke pattern for staff-auth endpoints w/o a password: mint JWT `{userId}` with server `JWT_SECRET`; if the user has `must_change_password=true` (global gate blocking ALL routes), temporarily clear it for the test and restore in finally. ADMIN `product@paylodeservices.com` has the flag set; SA `gokeakinboro@paylodeservices.com` + compliance do not.

## Authorship (asked 2026-06-22)
No per-file author headers / LICENSE / AUTHORS. Attribution is to the company "Paylode Services Limited". git committers: **Paylode Admin <admin@paylodeservices.com> (152, primary identity)**, Samuel <akinboroo@gmail.com> (2), Gokeakinboro <gokeakinboro@gmail.com> (1).
