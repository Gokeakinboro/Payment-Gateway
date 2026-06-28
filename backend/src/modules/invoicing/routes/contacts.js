'use strict';
// Address book / contacts. Merchant-scoped; usable via JWT or API key.
const router = require('express').Router();
const { prisma, tenantAuth, isValidEmail } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');

router.use(tenantAuth);

const COLS = `id::text, name, email, phone, custom_fields, tags, created_at`;
const shape = (r) => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone,
  custom_fields: r.custom_fields || {}, tags: r.tags || [], created_at: r.created_at,
});

// List contacts (optional ?q= search, ?tag= filter).
router.get('/', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const q = String(req.query.q || '').trim().toLowerCase();
    const tag = String(req.query.tag || '').trim();
    let sql = `SELECT ${COLS} FROM inv_contacts WHERE merchant_id = $1::uuid`;
    const vals = [mid]; let i = 2;
    if (q) { sql += ` AND (lower(name) LIKE $${i} OR lower(email) LIKE $${i} OR phone LIKE $${i})`; vals.push(`%${q}%`); i++; }
    if (tag) { sql += ` AND $${i} = ANY(tags)`; vals.push(tag); i++; }
    sql += ` ORDER BY created_at DESC LIMIT 2000`;
    const rows = await prisma.$queryRawUnsafe(sql, ...vals);
    return ok(res, rows.map(shape));
  } catch (e) { next(e); }
});

// Create one contact.
router.post('/', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase() || null;
    const phone = String(req.body.phone || '').trim() || null;
    if (!name) return fail(res, 'Contact name is required');
    if (!email && !phone) return fail(res, 'An email or phone number is required');
    if (email && !isValidEmail(email)) return fail(res, 'Invalid email address');
    const tags = Array.isArray(req.body.tags) ? req.body.tags.map(String).slice(0, 20) : [];
    const custom = req.body.custom_fields && typeof req.body.custom_fields === 'object' ? req.body.custom_fields : {};
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO inv_contacts (merchant_id, name, email, phone, custom_fields, tags)
       VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6) RETURNING ${COLS}`,
      mid, name, email, phone, JSON.stringify(custom), tags
    );
    return created(res, shape(rows[0]), 'Contact added');
  } catch (e) { next(e); }
});

// Bulk import (rows already parsed from CSV/Excel client-side or via SDK).
// body: { rows: [{name,email,phone,tags?,custom_fields?}], on_duplicate?: 'skip'|'overwrite' }
router.post('/import', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return fail(res, 'No rows to import');
    if (rows.length > 10000) return fail(res, 'Too many rows in one import (max 10000)');
    const onDup = req.body.on_duplicate === 'overwrite' ? 'overwrite' : 'skip';

    // Existing email/phone for dupe detection.
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id::text, lower(email) AS email, phone FROM inv_contacts WHERE merchant_id = $1::uuid`, mid);
    const byEmail = new Map(); const byPhone = new Map();
    existing.forEach((e) => { if (e.email) byEmail.set(e.email, e.id); if (e.phone) byPhone.set(e.phone, e.id); });

    let inserted = 0, updated = 0, skipped = 0; const errors = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx] || {};
      const name = String(r.name || '').trim();
      const email = String(r.email || '').trim().toLowerCase() || null;
      const phone = String(r.phone || '').trim() || null;
      if (!name || (!email && !phone)) { errors.push({ row: idx + 1, error: 'Missing name and contact channel' }); continue; }
      if (email && !isValidEmail(email)) { errors.push({ row: idx + 1, error: 'Invalid email' }); continue; }
      const dupId = (email && byEmail.get(email)) || (phone && byPhone.get(phone));
      const tags = Array.isArray(r.tags) ? r.tags.map(String).slice(0, 20) : [];
      const custom = r.custom_fields && typeof r.custom_fields === 'object' ? r.custom_fields : {};
      try {
        if (dupId) {
          if (onDup === 'skip') { skipped++; continue; }
          await prisma.$executeRawUnsafe(
            `UPDATE inv_contacts SET name=$2, email=$3, phone=$4, custom_fields=$5::jsonb, tags=$6, updated_at=now() WHERE id=$1::uuid`,
            dupId, name, email, phone, JSON.stringify(custom), tags);
          updated++;
        } else {
          await prisma.$executeRawUnsafe(
            `INSERT INTO inv_contacts (merchant_id, name, email, phone, custom_fields, tags)
             VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6)`,
            mid, name, email, phone, JSON.stringify(custom), tags);
          if (email) byEmail.set(email, 'new'); if (phone) byPhone.set(phone, 'new');
          inserted++;
        }
      } catch (e) { errors.push({ row: idx + 1, error: 'DB error' }); }
    }
    return created(res, { inserted, updated, skipped, failed: errors.length, errors: errors.slice(0, 200) },
      `Imported ${inserted} new, ${updated} updated, ${skipped} skipped, ${errors.length} failed.`);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const sets = []; const vals = []; let i = 1;
    for (const [k, col] of [['name', 'name'], ['email', 'email'], ['phone', 'phone']]) {
      if (req.body[k] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(k === 'email' ? String(req.body[k] || '').toLowerCase() || null : (req.body[k] || null)); }
    }
    if (req.body.tags !== undefined) { sets.push(`tags=$${i++}`); vals.push(Array.isArray(req.body.tags) ? req.body.tags.map(String) : []); }
    if (req.body.custom_fields !== undefined) { sets.push(`custom_fields=$${i++}::jsonb`); vals.push(JSON.stringify(req.body.custom_fields || {})); }
    if (!sets.length) return fail(res, 'Nothing to update');
    sets.push('updated_at=now()');
    vals.push(req.params.id, mid);
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE inv_contacts SET ${sets.join(', ')} WHERE id=$${i++}::uuid AND merchant_id=$${i++}::uuid RETURNING ${COLS}`, ...vals);
    if (!rows.length) return notFound(res, 'Contact');
    return ok(res, shape(rows[0]), 'Contact updated');
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId;
    const rows = await prisma.$queryRawUnsafe(
      `DELETE FROM inv_contacts WHERE id=$1::uuid AND merchant_id=$2::uuid RETURNING id::text`, req.params.id, mid);
    if (!rows.length) return notFound(res, 'Contact');
    return ok(res, { id: rows[0].id }, 'Contact deleted');
  } catch (e) { next(e); }
});

module.exports = router;
