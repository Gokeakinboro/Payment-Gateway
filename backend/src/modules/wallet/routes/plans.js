'use strict';
// Social Club subscription plan management.
// POST/GET /plans, GET/PATCH/DELETE /plans/:id
// GET/POST /plans/:id/members, DELETE /plans/:id/members/:memberId
// POST /plans/:id/generate-invoices, GET /plans/:id/report
const crypto = require('crypto');
const router = require('express').Router();
const { prisma, tenantAuth, requireWalletEnabled } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');
const { nextInvoiceNumber } = require('../../invoicing/services/invoiceNumber');

router.use(tenantAuth, requireWalletEnabled);

const num = (v) => (v == null ? null : Number(v));

// Guard: only social_club merchants may use plan endpoints.
async function assertSocialClub(req, res) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT merchant_type FROM merchants WHERE id=$1::uuid`, req.walletTenant.merchantId);
  if (!rows.length || rows[0].merchant_type !== 'social_club') {
    fail(res, 'This endpoint is only available for Social Club merchants', 'NOT_SOCIAL_CLUB', 403);
    return false;
  }
  return true;
}

// ── Plan CRUD ────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    if (!await assertSocialClub(req, res)) return;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, name, description, amount::text AS amount, charge_vat,
              vat_rate::text AS vat_rate, sub_items, frequency, reminder_days,
              grace_period_days, next_run_at, status, created_at
         FROM club_subscription_plans WHERE merchant_id=$1::uuid AND status <> 'archived'
         ORDER BY created_at DESC`, req.walletTenant.merchantId);
    return ok(res, rows.map(r => ({ ...r, amount: num(r.amount) })));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    if (!await assertSocialClub(req, res)) return;
    const mid = req.walletTenant.merchantId;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const amount = parseInt(b.amount, 10);
    if (!name) return fail(res, 'Plan name is required');
    if (!amount || amount <= 0) return fail(res, 'amount is required and must be a positive integer (kobo)');

    const frequency = ['one_time', 'weekly', 'monthly', 'quarterly', 'annually'].includes(b.frequency)
      ? b.frequency : 'monthly';
    const sub_items = Array.isArray(b.sub_items) ? b.sub_items : [];
    if (sub_items.length) {
      const total = sub_items.reduce((s, i) => s + (parseInt(i.amount_kobo, 10) || 0), 0);
      if (total !== amount)
        return fail(res, `sub_items total (${total} kobo) must equal plan amount (${amount} kobo)`);
    }
    const charge_vat = !!b.charge_vat;
    const vat_rate = b.vat_rate != null ? parseFloat(b.vat_rate) : 7.50;
    const reminder_days = Array.isArray(b.reminder_days)
      ? b.reminder_days.map(Number).filter(n => !isNaN(n) && n >= 0) : [7, 3, 1, 0];
    const grace_period_days = parseInt(b.grace_period_days, 10) || 7;
    const next_run_at = b.next_run_at ? new Date(b.next_run_at) : null;
    const description = String(b.description || '').trim() || null;

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO club_subscription_plans
         (merchant_id,name,description,amount,charge_vat,vat_rate,sub_items,
          frequency,reminder_days,grace_period_days,next_run_at,status)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::integer[],$10,$11,'active')
       RETURNING id::text`,
      mid, name, description, amount, charge_vat, vat_rate,
      JSON.stringify(sub_items), frequency,
      '{' + reminder_days.join(',') + '}', grace_period_days, next_run_at);
    return created(res, { id: rows[0].id, name }, 'Plan created');
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!await assertSocialClub(req, res)) return;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, name, description, amount::text AS amount, charge_vat,
              vat_rate::text AS vat_rate, sub_items, frequency, reminder_days,
              grace_period_days, next_run_at, status, created_at, updated_at
         FROM club_subscription_plans WHERE id=$1::uuid AND merchant_id=$2::uuid`,
      req.params.id, req.walletTenant.merchantId);
    if (!rows.length) return notFound(res, 'Plan');
    return ok(res, { ...rows[0], amount: num(rows[0].amount) });
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    if (!await assertSocialClub(req, res)) return;
    const mid = req.walletTenant.merchantId;
    const b = req.body || {};
    const sets = []; const vals = []; let p = 1;

    if (b.name !== undefined) { sets.push(`name=$${p++}`); vals.push(String(b.name).trim()); }
    if (b.description !== undefined) { sets.push(`description=$${p++}`); vals.push(String(b.description).trim() || null); }
    if (b.amount !== undefined) {
      const amt = parseInt(b.amount, 10);
      if (!amt || amt <= 0) return fail(res, 'amount must be a positive integer');
      sets.push(`amount=$${p++}`); vals.push(amt);
    }
    if (b.charge_vat !== undefined) { sets.push(`charge_vat=$${p++}`); vals.push(!!b.charge_vat); }
    if (b.vat_rate !== undefined) { sets.push(`vat_rate=$${p++}`); vals.push(parseFloat(b.vat_rate)); }
    if (b.sub_items !== undefined) {
      sets.push(`sub_items=$${p++}::jsonb`);
      vals.push(JSON.stringify(Array.isArray(b.sub_items) ? b.sub_items : []));
    }
    if (b.frequency !== undefined && ['one_time', 'weekly', 'monthly', 'quarterly', 'annually'].includes(b.frequency))
      { sets.push(`frequency=$${p++}`); vals.push(b.frequency); }
    if (b.reminder_days !== undefined) {
      const rd = Array.isArray(b.reminder_days) ? b.reminder_days.map(Number).filter(n => !isNaN(n)) : [];
      sets.push(`reminder_days=$${p++}::integer[]`); vals.push('{' + rd.join(',') + '}');
    }
    if (b.grace_period_days !== undefined) { sets.push(`grace_period_days=$${p++}`); vals.push(parseInt(b.grace_period_days, 10) || 7); }
    if (b.next_run_at !== undefined) { sets.push(`next_run_at=$${p++}`); vals.push(b.next_run_at ? new Date(b.next_run_at) : null); }
    if (b.status !== undefined && ['active', 'paused', 'archived'].includes(b.status))
      { sets.push(`status=$${p++}`); vals.push(b.status); }

    if (!sets.length) return fail(res, 'Nothing to update');
    sets.push(`updated_at=now()`); vals.push(req.params.id, mid);
    const r = await prisma.$queryRawUnsafe(
      `UPDATE club_subscription_plans SET ${sets.join(',')} WHERE id=$${p++}::uuid AND merchant_id=$${p}::uuid RETURNING id::text`,
      ...vals);
    if (!r.length) return notFound(res, 'Plan');
    return ok(res, { id: req.params.id }, 'Plan updated');
  } catch (e) { next(e); }
});

// Archive — preserves enrolled members and existing invoices.
router.delete('/:id', async (req, res, next) => {
  try {
    if (!await assertSocialClub(req, res)) return;
    const r = await prisma.$queryRawUnsafe(
      `UPDATE club_subscription_plans SET status='archived', updated_at=now()
         WHERE id=$1::uuid AND merchant_id=$2::uuid RETURNING id::text`,
      req.params.id, req.walletTenant.merchantId);
    if (!r.length) return notFound(res, 'Plan');
    return ok(res, { id: req.params.id }, 'Plan archived');
  } catch (e) { next(e); }
});

// ── Enrollment ──────────────────────────────────────────────────────────────

router.get('/:id/members', async (req, res, next) => {
  try {
    if (!await assertSocialClub(req, res)) return;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT cpm.id::text AS enrollment_id, cpm.member_id::text, cpm.status AS enrollment_status,
              cpm.enrolled_at, m.name, m.email, m.phone, m.status AS member_status
         FROM club_plan_members cpm JOIN mw_members m ON m.id=cpm.member_id
        WHERE cpm.plan_id=$1::uuid AND cpm.merchant_id=$2::uuid
        ORDER BY m.name`,
      req.params.id, req.walletTenant.merchantId);
    return ok(res, rows);
  } catch (e) { next(e); }
});

// Body: { member_ids: ['uuid', ...] }  or { member_id: 'uuid' }
router.post('/:id/members', async (req, res, next) => {
  try {
    if (!await assertSocialClub(req, res)) return;
    const mid = req.walletTenant.merchantId;
    const planId = req.params.id;
    const plan = await prisma.$queryRawUnsafe(
      `SELECT id::text FROM club_subscription_plans WHERE id=$1::uuid AND merchant_id=$2::uuid AND status='active'`,
      planId, mid);
    if (!plan.length) return notFound(res, 'Active plan');

    const ids = Array.isArray(req.body.member_ids) ? req.body.member_ids
      : (req.body.member_id ? [req.body.member_id] : []);
    if (!ids.length) return fail(res, 'Provide member_ids (array) or member_id');

    const enrolled = []; const skipped = [];
    for (const memberId of ids) {
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO club_plan_members (merchant_id,plan_id,member_id)
             VALUES ($1::uuid,$2::uuid,$3::uuid)
           ON CONFLICT (plan_id,member_id) DO UPDATE SET status='active'`,
          mid, planId, memberId);
        enrolled.push(memberId);
      } catch (e) { skipped.push({ member_id: memberId, reason: e.message }); }
    }
    return ok(res, { enrolled_count: enrolled.length, enrolled, skipped });
  } catch (e) { next(e); }
});

router.delete('/:id/members/:memberId', async (req, res, next) => {
  try {
    if (!await assertSocialClub(req, res)) return;
    const r = await prisma.$queryRawUnsafe(
      `DELETE FROM club_plan_members WHERE plan_id=$1::uuid AND member_id=$2::uuid AND merchant_id=$3::uuid RETURNING id::text`,
      req.params.id, req.params.memberId, req.walletTenant.merchantId);
    if (!r.length) return notFound(res, 'Enrollment');
    return ok(res, { removed: true });
  } catch (e) { next(e); }
});

// ── Generate invoices ────────────────────────────────────────────────────────
// POST /:id/generate-invoices
// Idempotent: skips members who already have an open (unpaid/sent/part_paid) invoice
// for this plan. Body (optional): { due_at: ISO8601 }

router.post('/:id/generate-invoices', async (req, res, next) => {
  try {
    if (!await assertSocialClub(req, res)) return;
    const mid = req.walletTenant.merchantId;
    const planId = req.params.id;

    const plans = await prisma.$queryRawUnsafe(
      `SELECT p.id::text, p.name, p.amount::text AS amount, p.charge_vat,
              p.vat_rate::text AS vat_rate, p.sub_items,
              m.merchant_code, m.business_name
         FROM club_subscription_plans p JOIN merchants m ON m.id=p.merchant_id
        WHERE p.id=$1::uuid AND p.merchant_id=$2::uuid AND p.status='active'`, planId, mid);
    if (!plans.length) return notFound(res, 'Active plan');
    const plan = plans[0];

    const amount = BigInt(plan.amount);
    const vatRateFrac = plan.charge_vat ? parseFloat(plan.vat_rate || '7.5') / 100 : 0;
    const vatAmount = vatRateFrac > 0 ? amount * BigInt(Math.round(vatRateFrac * 1_000_000)) / 1_000_000n : 0n;
    const totalAmount = amount + vatAmount;
    const dueAt = req.body && req.body.due_at ? new Date(req.body.due_at) : null;
    const subItemsJson = JSON.stringify(plan.sub_items || []);

    const members = await prisma.$queryRawUnsafe(
      `SELECT cpm.member_id::text AS member_id, m.name, m.email, m.phone
         FROM club_plan_members cpm JOIN mw_members m ON m.id=cpm.member_id
        WHERE cpm.plan_id=$1::uuid AND cpm.merchant_id=$2::uuid
          AND cpm.status='active' AND m.status='active'`, planId, mid);
    if (!members.length) return ok(res, { generated: 0, skipped: 0 }, 'No active members enrolled');

    const existing = await prisma.$queryRawUnsafe(
      `SELECT club_member_id::text AS member_id FROM inv_invoices
        WHERE club_plan_id=$1::uuid AND status IN ('unpaid','sent','part_paid') AND deleted_at IS NULL`, planId);
    const already = new Set(existing.map(r => r.member_id));

    let generated = 0, skipped = 0;
    for (const m of members) {
      if (already.has(m.member_id)) { skipped++; continue; }
      const invNumber = await nextInvoiceNumber(mid, plan.merchant_code);
      const token = crypto.randomBytes(20).toString('hex');
      await prisma.$executeRawUnsafe(
        `INSERT INTO inv_invoices
           (merchant_id,invoice_number,recipient_name,recipient_email,recipient_phone,
            description,amount,charge_vat,vat_amount,total_amount,amount_paid,currency,
            status,access_token,due_at,line_items,club_plan_id,club_member_id)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,'NGN','unpaid',$11,$12,$13::jsonb,$14::uuid,$15::uuid)`,
        mid, invNumber, m.name, m.email, m.phone || null,
        plan.name, amount, plan.charge_vat, vatAmount, totalAmount,
        token, dueAt, subItemsJson, planId, m.member_id);
      generated++;
    }
    const skippedNote = skipped ? `, ${skipped} skipped (already has open invoice)` : '';
    return ok(res, { generated, skipped }, `${generated} invoice(s) generated${skippedNote}`);
  } catch (e) { next(e); }
});

// ── Payment report ───────────────────────────────────────────────────────────
// GET /:id/report — per-member: enrollment status + latest invoice.

router.get('/:id/report', async (req, res, next) => {
  try {
    if (!await assertSocialClub(req, res)) return;
    const mid = req.walletTenant.merchantId;
    const planId = req.params.id;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT cpm.member_id::text, m.name, m.email, m.phone,
              m.status AS member_status, cpm.status AS enrollment_status, cpm.enrolled_at,
              inv.id::text AS invoice_id, inv.invoice_number, inv.status AS invoice_status,
              inv.total_amount::text AS total_amount, inv.amount_paid::text AS amount_paid,
              inv.due_at, inv.paid_at, inv.created_at AS invoice_created_at
         FROM club_plan_members cpm
         JOIN mw_members m ON m.id=cpm.member_id
         LEFT JOIN LATERAL (
           SELECT id, invoice_number, status, total_amount, amount_paid, due_at, paid_at, created_at
             FROM inv_invoices
            WHERE club_plan_id=$1::uuid AND club_member_id=cpm.member_id AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 1
         ) inv ON true
        WHERE cpm.plan_id=$1::uuid AND cpm.merchant_id=$2::uuid
        ORDER BY m.name`,
      planId, mid);
    return ok(res, rows.map(r => ({
      member_id: r.member_id, name: r.name, email: r.email, phone: r.phone,
      member_status: r.member_status, enrollment_status: r.enrollment_status,
      enrolled_at: r.enrolled_at,
      invoice: r.invoice_id ? {
        id: r.invoice_id, invoice_number: r.invoice_number, status: r.invoice_status,
        total_amount: num(r.total_amount), amount_paid: num(r.amount_paid),
        due_at: r.due_at, paid_at: r.paid_at,
      } : null,
    })));
  } catch (e) { next(e); }
});

module.exports = router;
