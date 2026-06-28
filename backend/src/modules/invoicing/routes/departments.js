'use strict';
/**
 * Departments & departmental users.
 * MERCHANT -> CREATE DEPARTMENT -> CREATE USERS. Each department has its own QR
 * codes / payment links and its users see only that department's collections.
 * Only the merchant owner (not departmental sub-users) manages this.
 */
const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma, tenantAuth, isValidEmail, CHECKOUT_BASE } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');
const { sendEmail } = require('../../../services/emailService');

router.use(tenantAuth);
// Department administration is owner-only.
router.use((req, res, next) => {
  if (req.invTenant.isDeptUser) return fail(res, 'Only the merchant owner can manage departments', 'FORBIDDEN', 403);
  next();
});

const LOGIN_URL = (process.env.APP_URL || CHECKOUT_BASE).replace(/\/$/, '') + '/login.html';

// ── Departments ───────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT d.id::text, d.name, d.created_at,
              (SELECT COUNT(*) FROM inv_department_users u WHERE u.department_id = d.id)::int AS user_count
         FROM inv_departments d WHERE d.merchant_id = $1::uuid ORDER BY d.created_at`, req.invTenant.merchantId);
    return ok(res, rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return fail(res, 'Department name is required');
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO inv_departments (merchant_id, name) VALUES ($1::uuid,$2)
       ON CONFLICT (merchant_id, name) DO NOTHING RETURNING id::text, name, created_at`,
      req.invTenant.merchantId, name);
    if (!rows.length) return fail(res, 'A department with that name already exists', 'DUPLICATE', 409);
    return created(res, rows[0], 'Department created');
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `DELETE FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid RETURNING id::text`, req.params.id, req.invTenant.merchantId);
    if (!rows.length) return notFound(res, 'Department');
    return ok(res, { id: rows[0].id }, 'Department deleted');
  } catch (e) { next(e); }
});

// ── Departmental users ─────────────────────────────────────────────────────────
router.get('/:id/users', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT du.id::text, du.name, du.email, du.phone, du.onboarding_status, u.is_active, du.created_at
         FROM inv_department_users du JOIN users u ON u.id = du.user_id
         JOIN inv_departments d ON d.id = du.department_id
        WHERE du.department_id = $1::uuid AND d.merchant_id = $2::uuid ORDER BY du.created_at`,
      req.params.id, req.invTenant.merchantId);
    return ok(res, rows);
  } catch (e) { next(e); }
});

// Create a departmental user (temp password emailed; they set their own on first login).
router.post('/:id/users', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const dept = await prisma.$queryRawUnsafe(
      `SELECT id::text, name FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.params.id, mid);
    if (!dept.length) return notFound(res, 'Department');

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim() || null;
    if (!name) return fail(res, 'User name is required');
    if (!isValidEmail(email)) return fail(res, 'A valid email is required');

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return fail(res, 'A user with that email already exists', 'DUPLICATE', 409);

    const [firstName, ...rest] = name.split(' ');
    const tempPassword = crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) + 'A1!';
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const user = await prisma.user.create({
      data: {
        email, passwordHash, firstName: firstName || name, lastName: rest.join(' ') || '-',
        role: 'MERCHANT', permissions: [], mustChangePassword: true,
      },
      select: { id: true },
    });

    const du = await prisma.$queryRawUnsafe(
      `INSERT INTO inv_department_users (merchant_id, department_id, user_id, name, email, phone)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6) RETURNING id::text`,
      mid, req.params.id, user.id, name, email, phone);

    // Email the temp password (best-effort).
    sendEmail({
      to: email,
      subject: `Your ${dept[0].name} account on Paylode`,
      html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;color:#222">
        <p>An account has been created for you for the <strong>${dept[0].name}</strong> department.</p>
        <p>Sign in at <a href="${LOGIN_URL}">${LOGIN_URL}</a> with:</p>
        <p>Email: <strong>${email}</strong><br>Temporary password: <strong>${tempPassword}</strong></p>
        <p>You will be asked to set your own password on first sign-in.</p></div>`,
      text: `Account created for ${dept[0].name}. Sign in at ${LOGIN_URL}\nEmail: ${email}\nTemporary password: ${tempPassword}\nYou must change it on first sign-in.`,
    }).catch(() => {});

    return created(res, { id: du[0].id, email, temp_password: tempPassword }, 'Departmental user created and emailed a temporary password');
  } catch (e) { next(e); }
});

// Remove a departmental user (deactivates the login + unlinks).
router.delete('/:id/users/:userMapId', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `DELETE FROM inv_department_users du USING inv_departments d
        WHERE du.id=$1::uuid AND du.department_id=d.id AND d.merchant_id=$2::uuid
        RETURNING du.user_id::text AS user_id`, req.params.userMapId, req.invTenant.merchantId);
    if (!rows.length) return notFound(res, 'Departmental user');
    await prisma.user.update({ where: { id: rows[0].user_id }, data: { isActive: false } }).catch(() => {});
    return ok(res, { id: req.params.userMapId }, 'Departmental user removed');
  } catch (e) { next(e); }
});

module.exports = router;
