'use strict';
// Public (UNAUTHENTICATED) Paymula endpoints for member self-registration.
// Lists clubs/merchants that opted into public members (mw_config.allow_public_members)
// AND are enabled. Read-only, no funds/PII — safe to expose. Rate-limited by the
// global /api/ limiter in server.js.
const router = require('express').Router();
const { prisma } = require('../_shared');
const { ok } = require('../../../utils/helpers');

// GET /api/v1/wallet/public/clubs?q=<search>
router.get('/clubs', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    let sql = `SELECT m.id::text AS id,
                      COALESCE(NULLIF(c.brand_name, ''), m.business_name) AS name,
                      c.brand_logo_url, c.brand_color, m.category, m.state
                 FROM mw_config c
                 JOIN merchants m ON m.id = c.merchant_id
                WHERE c.allow_public_members = true AND c.enabled = true`;
    const vals = [];
    if (q) { sql += ` AND lower(COALESCE(NULLIF(c.brand_name, ''), m.business_name)) LIKE $1`; vals.push('%' + q + '%'); }
    sql += ` ORDER BY name ASC LIMIT 100`;
    const rows = await prisma.$queryRawUnsafe(sql, ...vals);
    return ok(res, rows);
  } catch (e) { next(e); }
});

module.exports = router;
