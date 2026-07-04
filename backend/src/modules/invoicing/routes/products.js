'use strict';
// Reusable per-department product/service catalogue for invoice/link/QR line items.
// Amounts in kobo. department_id NULL = merchant-wide (pickable by any department).
const router = require('express').Router();
const { prisma, tenantAuth } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');

router.use(tenantAuth);

const COLS = `id::text, name, default_amount::text AS default_amount, description, department_id::text AS department_id, created_at`;
const shape = (r) => ({ ...r, default_amount: r.default_amount === null ? null : Number(r.default_amount) });

// Validate a department belongs to this merchant; returns true/false.
async function deptOk(deptId, mid) {
  const d = await prisma.$queryRawUnsafe(`SELECT 1 FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid`, deptId, mid);
  return !!d.length;
}

// List / search. ?q= keyword (name+description ILIKE); ?department_id= scopes to that
// department's items + merchant-wide (NULL). Dept users are forced to their department.
router.get('/', async (req, res, next) => {
  try {
    const t = req.invTenant, mid = t.merchantId;
    const q = String(req.query.q || '').trim();
    const deptId = t.isDeptUser ? t.departmentId : (req.query.department_id ? String(req.query.department_id) : null);
    const clauses = ['merchant_id = $1::uuid'];
    const params = [mid];
    if (deptId) { params.push(deptId); clauses.push(`(department_id = $${params.length}::uuid OR department_id IS NULL)`); }
    if (q) { params.push(`%${q}%`); clauses.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`); }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${COLS} FROM inv_products WHERE ${clauses.join(' AND ')} ORDER BY name ASC LIMIT 500`, ...params);
    return ok(res, rows.map(shape));
  } catch (e) { next(e); }
});

function parseAmount(v) {
  if (v === undefined || v === null || String(v) === '') return { amount: null };
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0) return { error: 'default_amount must be a whole number in kobo' };
  return { amount: n };
}

router.post('/', async (req, res, next) => {
  try {
    const t = req.invTenant, mid = t.merchantId;
    const name = String(req.body.name || '').trim();
    if (!name) return fail(res, 'Product/service name is required');
    const a = parseAmount(req.body.default_amount);
    if (a.error) return fail(res, a.error);
    let deptId = t.isDeptUser ? t.departmentId : (req.body.department_id || null);
    if (deptId && !t.isDeptUser && !(await deptOk(deptId, mid))) return fail(res, 'Invalid department');
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO inv_products (merchant_id, name, default_amount, description, department_id)
       VALUES ($1::uuid,$2,$3,$4,$5::uuid) RETURNING ${COLS}`,
      mid, name, a.amount === null ? null : BigInt(a.amount),
      req.body.description ? String(req.body.description).slice(0, 500) : null, deptId);
    return created(res, shape(rows[0]), 'Product saved');
  } catch (e) { next(e); }
});

// Edit an item (the "editable listing").
router.put('/:id', async (req, res, next) => {
  try {
    const t = req.invTenant, mid = t.merchantId;
    const name = String(req.body.name || '').trim();
    if (!name) return fail(res, 'Product/service name is required');
    const a = parseAmount(req.body.default_amount);
    if (a.error) return fail(res, a.error);
    let deptId = t.isDeptUser ? t.departmentId : (req.body.department_id || null);
    if (deptId && !t.isDeptUser && !(await deptOk(deptId, mid))) return fail(res, 'Invalid department');
    // Dept users may only edit their own department's (or merchant-wide) items.
    const scope = t.isDeptUser ? ` AND (department_id = $7::uuid OR department_id IS NULL)` : '';
    const params = [name, a.amount === null ? null : BigInt(a.amount),
      req.body.description ? String(req.body.description).slice(0, 500) : null, deptId, req.params.id, mid];
    if (t.isDeptUser) params.push(t.departmentId);
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE inv_products SET name=$1, default_amount=$2, description=$3, department_id=$4::uuid, updated_at=now()
       WHERE id=$5::uuid AND merchant_id=$6::uuid${scope} RETURNING ${COLS}`, ...params);
    if (!rows.length) return notFound(res, 'Product');
    return ok(res, shape(rows[0]), 'Product updated');
  } catch (e) { next(e); }
});

// Bulk import (the "Import CSV" button). Body: { department_id?, items:[{name, default_amount(kobo), description?}] }.
// Skips blank names / bad amounts; dedupes by name within the batch. Max 1000.
router.post('/import', async (req, res, next) => {
  try {
    const t = req.invTenant, mid = t.merchantId, b = req.body || {};
    const deptId = t.isDeptUser ? t.departmentId : (b.department_id || null);
    if (deptId && !t.isDeptUser && !(await deptOk(deptId, mid))) return fail(res, 'Invalid department');
    const raw = Array.isArray(b.items) ? b.items : [];
    if (!raw.length) return fail(res, 'No items to import');
    if (raw.length > 1000) return fail(res, 'Too many items (max 1000 per import)');
    const seen = new Set(); const items = [];
    for (const it of raw) {
      const name = String((it && it.name) || '').trim().slice(0, 200); if (!name) continue;
      const key = name.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
      let amt = null;
      if (it.default_amount != null && String(it.default_amount) !== '') {
        const n = parseInt(it.default_amount, 10); if (Number.isInteger(n) && n >= 0) amt = n;
      }
      items.push({ name, amt, desc: it.description ? String(it.description).slice(0, 500) : null });
    }
    if (!items.length) return fail(res, 'No valid items to import');
    const vals = []; const params = []; let i = 1;
    for (const r of items) {
      vals.push(`($${i++}::uuid,$${i++},$${i++},$${i++},$${i++}::uuid)`);
      params.push(mid, r.name, r.amt === null ? null : BigInt(r.amt), r.desc, deptId);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO inv_products (merchant_id, name, default_amount, description, department_id) VALUES ${vals.join(',')}`, ...params);
    return created(res, { created: items.length }, `Imported ${items.length} item(s)`);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `DELETE FROM inv_products WHERE id=$1::uuid AND merchant_id=$2::uuid RETURNING id::text`, req.params.id, req.invTenant.merchantId);
    if (!rows.length) return notFound(res, 'Product');
    return ok(res, { id: rows[0].id }, 'Product deleted');
  } catch (e) { next(e); }
});

module.exports = router;
