'use strict';
// Invoices — create (single / checked / list / all), list, detail, send/resend, cancel.
const router = require('express').Router();
const { prisma, tenantAuth, computeVat, randToken, isValidEmail } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');
const { nextInvoiceNumber } = require('../services/invoiceNumber');
const { sendInvoice } = require('../services/invoiceSend');

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
      `SELECT ${LIST_COLS}, access_token, reminder_interval_days, reminder_count, reminders_sent
         FROM inv_invoices i WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.params.id, mid);
    if (!rows.length) return notFound(res, 'Invoice');
    const inv = rows[0];
    if (req.invTenant.isDeptUser && req.invTenant.departmentId && inv.department_id !== req.invTenant.departmentId)
      return notFound(res, 'Invoice');
    const pays = await prisma.$queryRawUnsafe(
      `SELECT amount_paid::text AS amount_paid, payment_reference, channel, paid_at
         FROM inv_invoice_payments WHERE invoice_id=$1::uuid ORDER BY paid_at`, req.params.id);
    return ok(res, { ...shape(inv), payments: pays.map((p) => ({ ...p, amount_paid: num(p.amount_paid) })) });
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

    const amount = parseInt(b.amount, 10);
    if (!Number.isInteger(amount) || amount < 100) return fail(res, 'amount must be a whole number in kobo (≥ 100)');
    const currency = b.currency === 'USD' ? 'USD' : 'NGN';
    const description = b.description ? String(b.description).slice(0, 500) : null;

    // VAT default from the merchant's format unless explicitly set on this invoice.
    let chargeVat = b.charge_vat;
    if (chargeVat === undefined) {
      const fr = await prisma.$queryRawUnsafe(`SELECT charge_vat_default, allow_part_payment_default FROM inv_formats WHERE merchant_id=$1::uuid`, mid);
      chargeVat = fr.length ? fr[0].charge_vat_default : false;
      if (b.allow_part_payment === undefined && fr.length) b.allow_part_payment = fr[0].allow_part_payment_default;
    }
    chargeVat = !!chargeVat;
    const vat = computeVat(amount, chargeVat);
    const total = BigInt(amount) + vat;
    const allowPart = !!b.allow_part_payment;

    const scheduledAt = b.scheduled_at ? new Date(b.scheduled_at) : null;
    if (scheduledAt && isNaN(scheduledAt.getTime())) return fail(res, 'scheduled_at is not a valid date');
    const dueAt = b.due_at ? new Date(b.due_at) : null;
    if (dueAt && isNaN(dueAt.getTime())) return fail(res, 'due_at is not a valid date');
    const isScheduled = scheduledAt && scheduledAt.getTime() > Date.now();

    const remInterval = b.reminder_interval_days ? Math.max(1, parseInt(b.reminder_interval_days, 10)) : null;
    const remCount = b.reminder_count ? Math.max(0, parseInt(b.reminder_count, 10)) : 0;

    // Department: dept users are forced to their own; owners may choose one (validated).
    let departmentId = t.isDeptUser ? t.departmentId : (b.department_id || null);
    if (departmentId && !t.isDeptUser) {
      const d = await prisma.$queryRawUnsafe(`SELECT 1 FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid`, departmentId, mid);
      if (!d.length) return fail(res, 'Invalid department');
    }

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
           status, scheduled_at, due_at, reminder_interval_days, reminder_count, access_token)
         VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING id::text`,
        number, mid, departmentId, r.contact_id || null, r.name || null, r.email || null, r.phone || null,
        description, BigInt(amount), chargeVat, vat, total, currency, allowPart,
        isScheduled ? 'scheduled' : 'draft', scheduledAt, dueAt, remInterval, remCount, token);
      const id = rows[0].id;
      createdInvoices.push({ id, invoice_number: number, recipient_email: r.email });
      if (!isScheduled) { try { await sendInvoice(id); } catch (e) { /* best-effort email */ } }
    }

    return created(res, {
      count: createdInvoices.length,
      scheduled: !!isScheduled,
      invoices: createdInvoices,
    }, isScheduled ? `Scheduled ${createdInvoices.length} invoice(s)` : `Created & sent ${createdInvoices.length} invoice(s)`);
  } catch (e) { next(e); }
});

// ── Manual (re)send ───────────────────────────────────────────────────────────
router.post('/:id/send', async (req, res, next) => {
  try {
    const own = await prisma.$queryRawUnsafe(`SELECT id::text FROM inv_invoices WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.params.id, req.invTenant.merchantId);
    if (!own.length) return notFound(res, 'Invoice');
    const emailed = await sendInvoice(req.params.id);
    return ok(res, { id: req.params.id, emailed }, emailed ? 'Invoice sent' : 'Invoice has no email recipient');
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
