---
name: session-2026-07-05-invoicing-wip-committed
description: "2026-07-05 — committed the deployed-but-uncommitted invoicing change (itemized email/public render + accurate send reporting) to git as PR #60, closing that server↔repo drift"
metadata:
  node_type: memory
  type: project
---

✅ 2026-07-05 — Resumed Paylode invoicing. Found the 2026-07-04 itemized change sitting
**uncommitted in the `main` working tree** (6 files): it had been surgically deployed to prod
(176 + 45) but never committed — the recurring server↔repo drift (see
[[kiv-server-repo-reconciliation]], [[kiv-invoice-collect-paymentlinks]] #7).

User chose **"Commit/PR the WIP"** (no behavior change vs. prod). Done:
- Branch `fix-invoicing-itemized-render-send-reporting` off `main`, commit `bc1cf55`, **PR #60**
  (MERGEABLE, money-staged — flagged for sign-off per [[feedback-paylode-money-signoff]],
  NOT auto-merged).
- Staged the 6 tracked files only; deliberately **excluded untracked `backend/package-lock.json`**
  (repo convention tracks no lock file).
- `node --check` passed on all 4 backend files.

The change (all in the invoicing module): `invoiceSend.js` `parseLineItems()` → itemized email
(name/qty×unit/amount, Subtotal, VAT-exempt service-charge line via
`inv_departments.service_charge_label`, VAT, Total; legacy fallback = single "Amount" line);
`sendInvoice()` now returns `{found,sent,recipient,email,error}` and only flips status→`sent` on a
genuine send; `invoices.js` + `invoicingWorker.js` surface the real send outcome; `public.js`
`/invoice/:token` returns `service_charge_amount`+`service_charge_label`; `invoice.html` renders the
breakdown; `invoicing.html` catalogue picker rebuilt as a tick-box browse list (15-cap), dashboard
shows green only on a true send.

**gotcha:** `gh pr create` aborted with "must first push… or use --head" because the untracked
`package-lock.json` tripped an "uncommitted change" warning even after pushing → re-ran with
`--head fix-invoicing-itemized-render-send-reporting`.

**✅ MERGED 2026-07-05 (merge commit `1b9804d`, branch auto-deleted).** Before merging, **proved prod == branch**
via live md5 (CRLF-normalized) over SSH to 176 (4 backend files) + 45 (2 frontend files) — all 6 matched
`bc1cf55` exactly, confirming the "deployed 2026-07-04" claim with zero drift. So now **`main` == 45 == 176**
for the invoicing change; drift closed, no redeploy needed.

**NEXT:** (done — merged). Still open
P5 polish: item pickers on the QR/payment-link **builders** (backend ready) + add `invoicing.html`
to `deploy.py` + GH Action so it auto-deploys (currently manual to 45). See
[[kiv-invoice-collect-paymentlinks]].
