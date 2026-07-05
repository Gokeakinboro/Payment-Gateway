'use strict';
// Invoices — create (single / checked / list / all), list, detail, send/resend, cancel.
const router = require('express').Router();
const { prisma, tenantAuth, computeVat, computeInvoiceMoney, randToken, isValidEmail, CHECKOUT_BASE } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');
const { nextInvoiceNumber } = require('../services/invoiceNumber');
const { sendInvoice } = require('../services/invoiceSend');
const { renderQrForUrl } = require('../services/qrService');

router.use(tenantAuth);

const LIST_COLS = `id::text, invoice_number, recipient_name, recipient_email, description,
  amount::text AS amount, vat_amount::text AS vat_amount, total_amount::text AS total_amount,
  amount_paid::text AS amount_paid, currency, status, is_overdue, charge_vat, allow_part_payment,
  department_id::text AS department_id, scheduled_at, due_at, sent_at, paid_at, created_at`;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const shape = (r) => ({ ...r, amount: num(r.amount), vat_amount: num(r.vat_amount), total_amount: num(r.total_amount), amount_paid: num(r.amount_paid) });

// Resolve a department filter for departmental sub-users (they see only their dept).
function deptFilter(req, alias = 'i') {
  if (req.invTenant.isDeptUser && req.invTenant.departmentId)
    return { clause: ` AND ${alias}.department_id = $DEPT::uuid`, dept: req.invTenant.departmentId };
  return { clause: '', dept: null };
}

// ── List ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const status = String(req.query.status || '').trim();
    const df = deptFilter(req);
    let sql = `SELECT ${LIST_COLS} FROM inv_invoices i WHERE merchant_id = $1::uuid`;
    const vals = [mid]; let i = 2;
    if (status) { sql += ` AND status = $${i++}`; vals.push(status); }
    if (df.clause) { sql += df.clause.replace('$DEPT', `$${i}`); vals.push(df.dept); i++; }
    sql += ` ORDER BY created_at DESC LIMIT 1000`;
    const rows = await prisma.$queryRawUnsafe(sql, ...vals);
    return ok(res, rows.map(shape));
  } catch (e) { next(e); }
});

// ── Detail (+ payment events) ─────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${LIST_COLS}, access_token, reminder_interval_days, reminder_count, reminders_sent,
              line_items, apply_service_charge, service_charge_amount::text AS service_charge_amount
         FROM inv_invoices i WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.params.id, mid);
    if (!rows.length) return notFound(res, 'Invoice');
    const inv = rows[0];
    if (req.invTenant.isDeptUser && req.invTenant.departmentId && inv.department_id !== req.invTenant.departmentId)
      return notFound(res, 'Invoice');
    const pays = await prisma.$queryRawUnsafe(
      `SELECT amount_paid::text AS amount_paid, payment_reference, channel, paid_at
         FROM inv_invoice_payments WHERE invoice_id=$1::uuid ORDER BY paid_at`, req.params.id);
    return ok(res, { ...shape(inv), service_charge_amount: num(inv.service_charge_amount),
      payments: pays.map((p) => ({ ...p, amount_paid: num(p.amount_paid) })) });
  } catch (e) { next(e); }
});

// ── Create ────────────────────────────────────────────────────────────────────
// body: { amount(kobo), description?, currency?, charge_vat?, allow_part_payment?,
//         scheduled_at?, due_at?, reminder_interval_days?, reminder_count?,
//         department_id?, recipients: { email?,name?,phone?, contact_id?,
//         contact_ids?:[], list_ids?:[], all_contacts?:bool } }
router.post('/', async (req, res, next) => {
  try {
    const t = req.invTenant;
    const mid = t.merchantId;
    const b = req.body || {};

    // Department (dept users forced to theirs; owners may choose) + its service charge %.
    let departmentId = t.isDeptUser ? t.departmentId : (b.department_id || null);
    let deptPct = 0;
    if (departmentId) {
      const d = await prisma.$queryRawUnsafe(
        `SELECT service_charge_pct::float AS pct FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid`, departmentId, mid);
      if (!d.length) return fail(res, 'Invalid department');
      deptPct = Number(d[0].pct) || 0;
    }

    // VAT default from the merchant's format unless explicitly set on this invoice.
    let chargeVat = b.charge_vat;
    if (chargeVat === undefined) {
      const fr = await prisma.$queryRawUnsafe(`SELECT charge_vat_default, allow_part_payment_default FROM inv_formats WHERE merchant_id=$1::uuid`, mid);
      chargeVat = fr.length ? fr[0].charge_vat_default : false;
      if (b.allow_part_payment === undefined && fr.length) b.allow_part_payment = fr[0].allow_part_payment_default;
    }
    chargeVat = !!chargeVat;

    // Service charge is OPTIONAL per document (only meaningful if the dept has a % set).
    const applyServiceCharge = !!b.apply_service_charge && deptPct > 0;

    // Money math: itemized (items[]) or a single amount (legacy). VAT excludes the service charge.
    const rawItems = (Array.isArray(b.items) && b.items.length)
      ? b.items
      : [{ name: b.description || 'Payment', unit_amount: parseInt(b.amount, 10), quantity: 1 }];
    const money = computeInvoiceMoney({ items: rawItems, serviceChargePct: deptPct, applyServiceCharge, chargeVat, maxItems: 15 });
    if (money.error) return fail(res, money.error);
    if (money.amount < 100) return fail(res, 'Invoice total must be at least 100 kobo');

    const currency = b.currency === 'USD' ? 'USD' : 'NGN';
    const description = b.description ? String(b.description).slice(0, 500) : null;
    const allowPart = !!b.allow_part_payment;
    const lineItemsJson = JSON.stringify(money.lineItems);

    const scheduledAt = b.scheduled_at ? new Date(b.scheduled_at) : null;
    if (scheduledAt && isNaN(scheduledAt.getTime())) return fail(res, 'scheduled_at is not a valid date');
    const dueAt = b.due_at ? new Date(b.due_at) : null;
    if (dueAt && isNaN(dueAt.getTime())) return fail(res, 'due_at is not a valid date');
    const isScheduled = scheduledAt && scheduledAt.getTime() > Date.now();

    const remInterval = b.reminder_interval_days ? Math.max(1, parseInt(b.reminder_interval_days, 10)) : null;
    const remCount = b.reminder_count ? Math.max(0, parseInt(b.reminder_count, 10)) : 0;

    // Resolve recipients.
    const recipients = await resolveRecipients(mid, b.recipients || {});
    if (!recipients.length) return fail(res, 'At least one valid recipient is required');
    if (recipients.length > 5000) return fail(res, 'Too many recipients in one send (max 5000)');

    const mcode = await merchantCode(mid);
    const createdInvoices = [];
    for (const r of recipients) {
      const number = await nextInvoiceNumber(mid, mcode);
      const token = randToken(18);
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO inv_invoices
          (invoice_number, merchant_id, department_id, contact_id, recipient_name, recipient_email, recipient_phone,
           description, amount, charge_vat, vat_amount, total_amount, currency, allow_part_payment,
           status, scheduled_at, due_at, reminder_interval_days, reminder_count, access_token, line_items,
           apply_service_charge, service_charge_amount)
         VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23)
         RETURNING id::text`,
        number, mid, departmentId, r.contact_id || null, r.name || null, r.email || null, r.phone || null,
        description, BigInt(money.amount), chargeVat, BigInt(money.vatAmount), BigInt(money.total), currency, allowPart,
        isScheduled ? 'scheduled' : 'draft', scheduledAt, dueAt, remInterval, remCount, token, lineItemsJson,
        applyServiceCharge, BigInt(money.serviceCharge));
      const id = rows[0].id;
      let outcome = { sent: false, error: null };
      if (!isScheduled) {
        try { outcome = await sendInvoice(id); }
        catch (e) { outcome = { sent: false, error: (e && e.message) || 'Send failed' }; }
      }
      createdInvoices.push({ id, invoice_number: number, recipient_email: r.email,
        sent: !!outcome.sent, send_error: outcome.error || null });
    }

    // Build an accurate summary so the UI can show what actually happened.
    const sentCount = createdInvoices.filter((i) => i.sent).length;
    const failed = createdInvoices.filter((i) => !i.sent);
    let message;
    if (isScheduled) {
      message = `Scheduled ${createdInvoices.length} invoice(s)`;
    } else if (createdInvoices.length === 1) {
      const only = createdInvoices[0];
      message = only.sent
        ? `Invoice created & sent to ${only.recipient_email}`
        : `Invoice created, but not sent: ${only.send_error || 'unknown error'}`;
    } else {
      message = failed.length === 0
        ? `Created & sent ${sentCount} invoice(s)`
        : `Created ${createdInvoices.length} invoice(s) — sent ${sentCount}, ${failed.length} could not be sent`;
    }

    return created(res, {
      count: createdInvoices.length,
      scheduled: !!isScheduled,
      sent_count: sentCount,
      failed_count: failed.length,
      invoices: createdInvoices,
    }, message);
  } catch (e) { next(e); }
});

// ── Share: the invoice's public link + a QR of it (share as link / QR) ──────────
// GET /:id/share        -> { link_url, qr_png (data URL) }
// GET /:id/share?format=png|svg -> downloadable QR image of the invoice link
router.get('/:id/share', async (req, res, next) => {
  try {
    const t = req.invTenant;
    const scope = (t.isDeptUser && t.departmentId) ? ' AND department_id = $3::uuid' : '';
    const p = [req.params.id, t.merchantId]; if (scope) p.push(t.departmentId);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT access_token, invoice_number FROM inv_invoices WHERE id=$1::uuid AND merchant_id=$2::uuid${scope}`, ...p);
    if (!rows.length) return notFound(res, 'Invoice');
    const url = `${CHECKOUT_BASE}/invoice.html?t=${rows[0].access_token}`;
    const fmt = req.query.format;
    if (fmt === 'png' || fmt === 'svg') {
      const img = await renderQrForUrl(url);
      if (fmt === 'svg') { res.type('image/svg+xml').set('Content-Disposition', `attachment; filename="invoice-${rows[0].invoice_number}-qr.svg"`); return res.send(img.svg); }
      res.type('image/png').set('Content-Disposition', `attachment; filename="invoice-${rows[0].invoice_number}-qr.png"`);
      return res.send(Buffer.from(img.pngDataUrl.split(',')[1], 'base64'));
    }
    const img = await renderQrForUrl(url);
    return ok(res, { link_url: url, qr_png: img.pngDataUrl });
  } catch (e) { next(e); }
});

// ── Edit an unpaid invoice (fix a mistake instead of re-issuing) ────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const t = req.invTenant, mid = t.merchantId, b = req.body || {};
    const scope = t.isDeptUser ? ' AND department_id = $3::uuid' : '';
    const sel = [req.params.id, mid]; if (t.isDeptUser) sel.push(t.departmentId);
    const cur = await prisma.$queryRawUnsafe(
      `SELECT id::text, department_id::text AS department_id, status, amount_paid::text AS amount_paid,
              charge_vat, apply_service_charge, allow_part_payment,
              recipient_name, recipient_email, recipient_phone, description
         FROM inv_invoices WHERE id=$1::uuid AND merchant_id=$2::uuid${scope}`, ...sel);
    if (!cur.length) return notFound(res, 'Invoice');
    const inv = cur[0];
    if (!['draft', 'scheduled', 'sent', 'viewed'].includes(inv.status) || BigInt(inv.amount_paid) !== 0n)
      return fail(res, 'Only unpaid invoices (before any payment) can be edited', 'NOT_EDITABLE', 409);
    if (!Array.isArray(b.items) || !b.items.length) return fail(res, 'items[] is required to edit the invoice');

    // Department (owner may change; dept user stays on theirs) + its service charge %.
    let departmentId = t.isDeptUser ? t.departmentId : (b.department_id !== undefined ? (b.department_id || null) : inv.department_id);
    let deptPct = 0;
    if (departmentId) {
      const d = await prisma.$queryRawUnsafe(`SELECT service_charge_pct::float AS pct FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid`, departmentId, mid);
      if (!d.length) return fail(res, 'Invalid department');
      deptPct = Number(d[0].pct) || 0;
    }
    const chargeVat = b.charge_vat !== undefined ? !!b.charge_vat : !!inv.charge_vat;
    const applyServiceCharge = (b.apply_service_charge !== undefined ? !!b.apply_service_charge : !!inv.apply_service_charge) && deptPct > 0;
    const money = computeInvoiceMoney({ items: b.items, serviceChargePct: deptPct, applyServiceCharge, chargeVat, maxItems: 15 });
    if (money.error) return fail(res, money.error);
    if (money.amount < 100) return fail(res, 'Invoice total must be at least 100 kobo');

    const description = b.description !== undefined ? (b.description ? String(b.description).slice(0, 500) : null) : inv.description;
    const rName  = b.recipient_name  !== undefined ? (b.recipient_name || null) : inv.recipient_name;
    const rEmail = b.recipient_email !== undefined ? (String(b.recipient_email || '').trim().toLowerCase() || null) : inv.recipient_email;
    const rPhone = b.recipient_phone !== undefined ? (b.recipient_phone || null) : inv.recipient_phone;
    const allowPart = b.allow_part_payment !== undefined ? !!b.allow_part_payment : !!inv.allow_part_payment;

    await prisma.$queryRawUnsafe(
      `UPDATE inv_invoices SET department_id=$1::uuid, amount=$2, charge_vat=$3, vat_amount=$4, total_amount=$5,
          apply_service_charge=$6, service_charge_amount=$7, line_items=$8::jsonb,
          description=$9, allow_part_payment=$10, recipient_name=$11, recipient_email=$12, recipient_phone=$13, updated_at=now()
        WHERE id=$14::uuid AND merchant_id=$15::uuid`,
      departmentId, BigInt(money.amount), chargeVat, BigInt(money.vatAmount), BigInt(money.total),
      applyServiceCharge, BigInt(money.serviceCharge), JSON.stringify(money.lineItems),
      description, allowPart, rName, rEmail, rPhone, req.params.id, mid);

    // If the invoice was already shared, re-send so the correction reaches the recipient.
    let resent = false, resendError = null;
    if (inv.status === 'sent' || inv.status === 'viewed') {
      let rr; try { rr = await sendInvoice(req.params.id); } catch (e) { rr = { sent: false, error: (e && e.message) || 'Send failed' }; }
      resent = !!rr.sent; resendError = rr.sent ? null : (rr.error || 'unknown error');
    }
    const msg = resent ? 'Invoice updated & re-sent'
      : (resendError ? `Invoice updated, but re-send failed: ${resendError}` : 'Invoice updated');
    return ok(res, { id: req.params.id, total_amount: money.total, resent, resend_error: resendError }, msg);
  } catch (e) { next(e); }
});

// ── Manual (re)send ───────────────────────────────────────────────────────────
router.post('/:id/send', async (req, res, next) => {
  try {
    const own = await prisma.$queryRawUnsafe(`SELECT id::text FROM inv_invoices WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.params.id, req.invTenant.merchantId);
    if (!own.length) return notFound(res, 'Invoice');
    const rr = await sendInvoice(req.params.id);
    const msg = rr.sent ? `Invoice sent to ${rr.email}`
      : (!rr.recipient ? (rr.error || 'Invoice has no email recipient')
                       : `Could not send invoice: ${rr.error}`);
    return ok(res, { id: req.params.id, sent: !!rr.sent, recipient: !!rr.recipient, email: rr.email || null, error: rr.error || null }, msg);
  } catch (e) { next(e); }
});

// ── Cancel ────────────────────────────────────────────────────────────────────
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE inv_invoices SET status='cancelled', updated_at=now()
        WHERE id=$1::uuid AND merchant_id=$2::uuid AND status NOT IN ('paid') RETURNING id::text`,
      req.params.id, req.invTenant.merchantId);
    if (!rows.length) return fail(res, 'Invoice not found or already paid', 'NOT_CANCELLABLE', 404);
    return ok(res, { id: rows[0].id }, 'Invoice cancelled');
  } catch (e) { next(e); }
});

// ── helpers ───────────────────────────────────────────────────────────────────
async function merchantCode(mid) {
  const r = await prisma.merchant.findUnique({ where: { id: mid }, select: { merchantCode: true } });
  return (r && r.merchantCode) || 'PYL';
}

// Build a de-duplicated recipient list from the targeting options.
async function resolveRecipients(mid, sel) {
  const out = new Map(); // key by email|phone|contactId
  const add = (rec) => {
    const key = (rec.email || rec.phone || rec.contact_id || '').toLowerCase();
    if (!key) return;
    if (!out.has(key)) out.set(key, rec);
  };

  // explicit single recipient
  if (sel.email || sel.phone || sel.name) {
    const email = sel.email ? String(sel.email).trim().toLowerCase() : null;
    if (email && !isValidEmail(email)) { /* skip invalid */ } else add({ email, phone: sel.phone || null, name: sel.name || null });
  }

  const contactIds = new Set((Array.isArray(sel.contact_ids) ? sel.contact_ids : []).map(String));
  if (sel.contact_id) contactIds.add(String(sel.contact_id));

  // lists → member contact ids
  if (Array.isArray(sel.list_ids) && sel.list_ids.length) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT m.contact_id::text AS id FROM inv_list_members m
         JOIN inv_lists l ON l.id = m.list_id
        WHERE l.merchant_id = $1::uuid AND m.list_id = ANY($2::uuid[])`, mid, sel.list_ids.map(String));
    rows.forEach((r) => contactIds.add(r.id));
  }

  // all contacts
  let contactRows = [];
  if (sel.all_contacts) {
    contactRows = await prisma.$queryRawUnsafe(
      `SELECT id::text, name, email, phone FROM inv_contacts WHERE merchant_id=$1::uuid`, mid);
  } else if (contactIds.size) {
    contactRows = await prisma.$queryRawUnsafe(
      `SELECT id::text, name, email, phone FROM inv_contacts WHERE merchant_id=$1::uuid AND id = ANY($2::uuid[])`,
      mid, [...contactIds]);
  }
  contactRows.forEach((c) => add({ contact_id: c.id, email: c.email ? c.email.toLowerCase() : null, name: c.name, phone: c.phone }));

  return [...out.values()];
}

module.exports = router;
