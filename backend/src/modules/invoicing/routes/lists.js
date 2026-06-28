'use strict';
// Named, reusable recipient lists.
const router = require('express').Router();
const { prisma, tenantAuth } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');

router.use(tenantAuth);

// List all lists with member counts.
router.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT l.id::text, l.name, l.created_at, COUNT(m.contact_id)::int AS member_count
         FROM inv_lists l LEFT JOIN inv_list_members m ON m.list_id = l.id
        WHERE l.merchant_id = $1::uuid GROUP BY l.id ORDER BY l.created_at DESC`,
      req.invTenant.merchantId);
    return ok(res, rows);
  } catch (e) { next(e); }
});

// Members of a list.
router.get('/:id/members', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT c.id::text, c.name, c.email, c.phone FROM inv_list_members m
         JOIN inv_contacts c ON c.id = m.contact_id
         JOIN inv_lists l ON l.id = m.list_id
        WHERE m.list_id = $1::uuid AND l.merchant_id = $2::uuid ORDER BY c.name`,
      req.params.id, req.invTenant.merchantId);
    return ok(res, rows);
  } catch (e) { next(e); }
});

// Create a list, optionally with initial contact_ids.
router.post('/', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const name = String(req.body.name || '').trim();
    if (!name) return fail(res, 'List name is required');
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO inv_lists (merchant_id, name) VALUES ($1::uuid,$2) RETURNING id::text, name, created_at`, mid, name);
    const list = rows[0];
    const ids = Array.isArray(req.body.contact_ids) ? req.body.contact_ids : [];
    if (ids.length) await addMembers(mid, list.id, ids);
    return created(res, list, 'List created');
  } catch (e) { next(e); }
});

// Add/remove members. body: { add:[ids], remove:[ids] }
router.patch('/:id', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const owns = await prisma.$queryRawUnsafe(`SELECT 1 FROM inv_lists WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.params.id, mid);
    if (!owns.length) return notFound(res, 'List');
    if (req.body.name) await prisma.$executeRawUnsafe(`UPDATE inv_lists SET name=$2, updated_at=now() WHERE id=$1::uuid`, req.params.id, String(req.body.name).trim());
    if (Array.isArray(req.body.add) && req.body.add.length) await addMembers(mid, req.params.id, req.body.add);
    if (Array.isArray(req.body.remove) && req.body.remove.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM inv_list_members WHERE list_id=$1::uuid AND contact_id = ANY($2::uuid[])`, req.params.id, req.body.remove);
    }
    return ok(res, { id: req.params.id }, 'List updated');
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `DELETE FROM inv_lists WHERE id=$1::uuid AND merchant_id=$2::uuid RETURNING id::text`, req.params.id, req.invTenant.merchantId);
    if (!rows.length) return notFound(res, 'List');
    return ok(res, { id: rows[0].id }, 'List deleted');
  } catch (e) { next(e); }
});

// Only add contacts that belong to this merchant (guards against cross-tenant ids).
async function addMembers(mid, listId, contactIds) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO inv_list_members (list_id, contact_id)
       SELECT $1::uuid, c.id FROM inv_contacts c
        WHERE c.merchant_id = $2::uuid AND c.id = ANY($3::uuid[])
     ON CONFLICT DO NOTHING`,
    listId, mid, contactIds);
}

module.exports = router;
