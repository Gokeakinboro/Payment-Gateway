---
name: project-payment-link-recipients
description: "Paylode payment links → per-recipient links (single/bulk XLS) + auto-email + email validation. DEPLOYED to prod 2026-06-20 (commits ad263ef + f23fdb1). Sample XLS = header only, no example recipients."
metadata: 
  node_type: memory
  type: project
  originSessionId: bdb94e91-c54a-43e0-9f0e-2652b8622a2d
---

# Payment links — per-recipient + auto-email (2026-06-20)

User decisions (locked): **unique link per recipient**, **auto-email each recipient on
create**, **one amount for the whole batch** (XLS = just emails).

## Status: ✅ DEPLOYED to prod 2026-06-20 (commits `ad263ef` + `f23fdb1`, pushed; server==repo).
176 backend + migration (as app user) + pm2 6/6; frontend v82 on 45+176. Verified:
/health 200, `/payment-links/batch` 401 (routed+auth), both new columns present.
**Sample XLS = header `email` only, NO example recipients** (user: "no recipient should be
in the xlsx" — so nothing placeholder can be sent by mistake). **NOT yet functionally
tested with a real send** — do a 1-recipient test (your own email) from the dashboard to
confirm the email arrives + link opens checkout with email prefilled, before any bulk send.

## What it does
- `payment_links` gains `recipient_email` + `batch_id` (migration
  `20260620_payment_link_recipients.sql`, ADD COLUMN IF NOT EXISTS + batch_id index;
  payment_links is RAW SQL, no Prisma model).
- **NEW `POST /api/v1/payment-links/batch`** (paymentLinks.js): body `{title, description?,
  amount?, currency?, expires_at?, recipients:[email…]}`. Validates+dedupes emails
  (`isValidEmail` regex = the "checker"), creates a UNIQUE one-time link per valid email
  (is_reusable=false, shared batch_id), and **auto-emails** each via `emailService.sendEmail`
  (link carries `&email=` to prefill checkout). Returns `{created, emailed, email_failed,
  invalid_emails, links[]}`. The original `POST /` (plain shareable link) is unchanged.
- Frontend (api-wiring.js **v82**, dashboard.html): create modal has a **Recipients**
  textarea + **Upload XLS/CSV** (reuses the XLSX CDN lib already loaded) + **Sample file**
  download (`paylode_recipients_sample.xlsx`, header `email`) + live valid/invalid count.
  Submit branches to `/batch` when recipients present, shows a sent-summary; the links list
  shows `To: <recipient>`. Helpers: plParseEmails / plEmailOk / plRecipientPreview /
  plUploadRecipientsXls / plDownloadSampleXls.

## TO DEPLOY (when authorized)
1. 176: sftp `backend/src/routes/paymentLinks.js` + the migration; run migration as app
   user via DATABASE_URL (`psql -f …payment_link_recipients.sql`); `pm2 restart all
   --update-env`. No prisma generate needed (raw-SQL table).
2. 45+176 web roots: sftp `api-wiring.js` + `dashboard.html` (v82).
3. **TEST with ONE recipient first** (outward email) — e.g. create a 1-recipient batch to
   your own address, confirm the email arrives + the link opens checkout with email
   prefilled — BEFORE any bulk send.

## Possible follow-ups (not built)
- Per-recipient amount (XLS amount column) — user chose one batch amount for now.
- A batch/recipient status view (who paid) — currently inferred from per-link status
  (one-time link → disabled/paid_count after payment) + the `To:` column.

See [[project-paylode]], [[feedback-paylode-money-signoff]].
